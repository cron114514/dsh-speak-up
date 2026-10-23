// dsh-speak-up 的装配层：一条动态提示词上下文 + 两个工具。
//
// 提示词只给「判断准则」，具体打分交给 speak_up_should：
// 模型可以拿着一条真实消息去问分数，而不是自己在心里瞎估。

import path from 'node:path';
import { createStateStore, dshHome } from './state-store.mjs';
import {
  DEFAULT_CONFIG,
  coerceState,
  createInitialState,
  describe,
  evaluate,
  formatDecision,
  normalizeConfig,
  recordSpeak,
  spokenWithin,
} from './policy.mjs';

export const name = 'dsh-speak-up';
export const inject = ['systemPrompt', 'tools'];

/** 提示词上下文名。 */
export const CONTEXT_NAME = 'plugin:speak-up';
/** 「要不要开口」工具名。 */
export const SHOULD_TOOL_NAME = 'speak_up_should';
/** 「我开过口了」工具名。 */
export const NOTE_TOOL_NAME = 'speak_up_note';

/**
 * 状态文件默认路径。
 * @param {ReturnType<typeof normalizeConfig>} config
 */
export function resolveStatePath(config) {
  return config.statePath ?? path.join(dshHome(), 'plugin-data', 'dsh-speak-up', 'state.json');
}

/**
 * 创建插话服务。
 * @param {ReturnType<typeof normalizeConfig>} config
 * @param {() => number} now
 */
export function createSpeakUpService(config, now = () => Date.now()) {
  const store = createStateStore({
    file: resolveStatePath(config),
    coerce: coerceState,
    initial: createInitialState,
  });

  return {
    file: store.file,
    config,
    now,
    current: () => store.load(),
    /** 算一次分数，并把这次判断记进状态（便于事后回看「为什么当时接了话」）。 */
    should(input = {}) {
      const at = now();
      const state = store.load();
      const decision = evaluate(input, state, config, at);
      store.save({ ...state, lastDecision: { at, ...decision } });
      return decision;
    },
    /** 记一次开口；spoke=false 时状态不变。 */
    note({ spoke = true, topic } = {}) {
      const at = now();
      const state = store.load();
      if (spoke === false) return state;
      const next = recordSpeak(state, at, config, { topic });
      store.save(next);
      return next;
    },
    /** 提示词文本；抛异常会毁掉组装，所以自己兜住。 */
    text() {
      try {
        return describe(store.load(), now(), config);
      } catch {
        return '';
      }
    },
    stats() {
      const at = now();
      const state = store.load();
      return { state, at, recentHour: spokenWithin(state, at, 60) };
    },
  };
}

/**
 * 「要不要开口」：拿一条真实消息去打分。
 * @param {ReturnType<typeof createSpeakUpService>} service
 */
export function createShouldTool(service) {
  return {
    name: SHOULD_TOOL_NAME,
    description:
      '判断现在该不该接话（插话策略）。给定一条刚收到的消息，返回开口/安静的结论、分数与理由。被点名会强制开口；冷却期内默认闭嘴。想接话之前先问它一次，尤其在没有被点名的时候。',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '刚收到的消息原文（越完整越准）' },
        mention: { type: 'boolean', description: '这条消息是否 @ 了你 / 明确点了你的名字' },
        question: { type: 'boolean', description: '是否在提问（不传则按文本自动判断）' },
        silenceMinutes: { type: 'number', description: '距离上次有人说话多少分钟（不传则按自己上次开口推算）' },
      },
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args = {}) {
      const decision = service.should({
        message: typeof args.message === 'string' ? args.message : '',
        mention: args.mention === true,
        question: typeof args.question === 'boolean' ? args.question : undefined,
        silenceMinutes: typeof args.silenceMinutes === 'number' ? args.silenceMinutes : undefined,
      });
      return formatDecision(decision, service.config);
    },
  };
}

/**
 * 「我开过口了」：推进冷却。
 * @param {ReturnType<typeof createSpeakUpService>} service
 */
export function createNoteTool(service) {
  return {
    name: NOTE_TOOL_NAME,
    description:
      '记下「刚刚真的开口了」，从现在开始进入冷却期。只有在已经发出消息之后才调用；只是想了想没说话就不要调。',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '这次开口的话题（一句话），用来识别是不是在追着同一个话题说' },
        spoke: { type: 'boolean', description: '传 false 表示没开口（状态不变）' },
      },
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args = {}) {
      if (args.spoke === false) return '这次没开口，状态不变。';
      const at = service.now();
      const state = service.note({ topic: typeof args.topic === 'string' ? args.topic : undefined });
      const nextCooldown = Math.max(0, service.config.cooldownMinutes * 60_000);
      const remaining = nextCooldown > 0 ? `冷却 ${service.config.cooldownMinutes} 分钟从现在开始` : '没有冷却';
      const count = (state.history ?? []).filter((stamp) => stamp <= at).length;
      return `记下了：累计开口 ${count} 次，${remaining}。`;
    },
  };
}

/**
 * Cordis 装配钩子。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) return;

  const service = createSpeakUpService(config);

  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        name: CONTEXT_NAME,
        order: config.promptOrder,
        // 话题文本可能来自用户，关掉插值。
        interpolate: false,
        text: () => service.text(),
      }),
    'speak-up.context()',
  );

  ctx.effect(() => ctx.tools.register(createShouldTool(service)), 'speak-up.should()');
  ctx.effect(() => ctx.tools.register(createNoteTool(service)), 'speak-up.note()');
}

export { DEFAULT_CONFIG };
