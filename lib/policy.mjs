// 插话策略：纯函数、零依赖。
//
// 目标不是「让 agent 多说话」，而是给它一个**可以说不**的依据：
// 被点名、被提问、撞上关键词、冷场太久 → 加分；
// 冷却期内、安静时段、同一个话题追着说 → 减分。
// 权重是手调的启发式，故意写在一处、写得直白，方便按群风格改。

/** 配置默认值。 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  threshold: 0.45,
  cooldownMinutes: 6,
  quietAfterMinutes: 30,
  keywords: [],
  quietHours: [],
  promptOrder: 9060,
  promptMaxChars: 700,
  historyLimit: 24,
  statePath: null,
});

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round = (value) => Math.round(value * 1000) / 1000;
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** 中文/英文的提问迹象。 */
const QUESTION_HINTS = ['吗', '呢', '怎么', '为什么', '为啥', '如何', '能不能', '可以吗', '是不是', '要不要', '有人吗'];

/** 把 config 归一；写错的字段退回默认值。 */
export function normalizeConfig(raw = {}) {
  const config = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
  const keywords = Array.isArray(config.keywords)
    ? config.keywords.filter((word) => typeof word === 'string' && word.trim()).map((word) => word.trim().toLowerCase())
    : [];
  const quietHours = Array.isArray(config.quietHours)
    ? config.quietHours
        .filter((pair) => Array.isArray(pair) && pair.length === 2)
        .map(([start, end]) => [clamp(Math.trunc(Number(start)), 0, 24), clamp(Math.trunc(Number(end)), 0, 24)])
        .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && start !== end)
    : [];
  return {
    enabled: config.enabled !== false,
    threshold: isNumber(config.threshold) ? clamp(config.threshold, 0, 1) : DEFAULT_CONFIG.threshold,
    cooldownMinutes: Math.max(0, Number(config.cooldownMinutes) || 0),
    quietAfterMinutes: Math.max(1, Number(config.quietAfterMinutes) || DEFAULT_CONFIG.quietAfterMinutes),
    keywords,
    quietHours,
    promptOrder: isNumber(config.promptOrder) ? config.promptOrder : DEFAULT_CONFIG.promptOrder,
    promptMaxChars: Math.max(160, Number(config.promptMaxChars) || DEFAULT_CONFIG.promptMaxChars),
    historyLimit: Math.max(0, Number(config.historyLimit) || DEFAULT_CONFIG.historyLimit),
    statePath: typeof config.statePath === 'string' && config.statePath ? config.statePath : null,
  };
}

/** 新状态：从来没开过口。 */
export function createInitialState() {
  return { version: 1, lastSpokeAt: 0, lastTopicHash: null, history: [], lastDecision: null };
}

/** 洗落盘数据。 */
export function coerceState(raw) {
  if (!raw || typeof raw !== 'object') return createInitialState();
  return {
    version: 1,
    lastSpokeAt: isNumber(raw.lastSpokeAt) ? raw.lastSpokeAt : 0,
    lastTopicHash: typeof raw.lastTopicHash === 'string' ? raw.lastTopicHash : null,
    history: Array.isArray(raw.history) ? raw.history.filter(isNumber).slice(-DEFAULT_CONFIG.historyLimit) : [],
    lastDecision: raw.lastDecision && typeof raw.lastDecision === 'object' ? raw.lastDecision : null,
  };
}

/** 判断一条文本像不像在提问。 */
export function looksLikeQuestion(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  if (/[?？]\s*$/.test(value)) return true;
  return QUESTION_HINTS.some((hint) => value.includes(hint));
}

/** 命中哪些关键词（去重、保留原词大小写不重要）。 */
export function matchKeywords(text, keywords) {
  const value = String(text ?? '').toLowerCase();
  const hits = [];
  for (const keyword of keywords) {
    if (keyword && value.includes(keyword) && !hits.includes(keyword)) hits.push(keyword);
  }
  return hits;
}

/** 32 位 FNV-1a：只用来判「是不是同一个话题」，不需要抗碰撞。 */
export function hashTopic(text) {
  const value = String(text ?? '').trim().slice(0, 120);
  if (!value) return null;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 当前小时是否落在某个安静时段里。 */
export function inQuietHours(now, quietHours) {
  const hour = new Date(now).getHours();
  return quietHours.some(([start, end]) => {
    if (start < end) return hour >= start && hour < end;
    // 跨午夜，例如 [23, 7]
    return hour >= start || hour < end;
  });
}

/**
 * 算一次「要不要开口」。
 * @param {{ message?: string, mention?: boolean, question?: boolean, silenceMinutes?: number }} input
 * @param {{ lastSpokeAt?: number, lastTopicHash?: string|null }} state
 * @param {ReturnType<typeof normalizeConfig>} config
 * @param {number} now
 */
export function evaluate(input, state, config, now = Date.now()) {
  const text = typeof input?.message === 'string' ? input.message.slice(0, 4000) : '';
  const reasons = [];
  let score = 0;
  const add = (label, delta) => {
    score += delta;
    reasons.push({ label, delta: round(delta) });
  };

  const forced = Boolean(input?.mention);
  if (forced) add('被点名', 0.55);

  const question = input?.question === true || looksLikeQuestion(text);
  if (question) add('直接提问', 0.25);

  const hits = matchKeywords(text, config.keywords);
  if (hits.length > 0) add(`关键词（${hits.join('、')}）`, Math.min(0.45, 0.15 * hits.length));

  if (text.length >= 12) add('消息有实质内容', 0.05);

  const lastSpokeAt = isNumber(state?.lastSpokeAt) ? state.lastSpokeAt : 0;
  const silenceMinutes = isNumber(input?.silenceMinutes)
    ? Math.max(0, input.silenceMinutes)
    : lastSpokeAt > 0
      ? (now - lastSpokeAt) / 60_000
      : Number.POSITIVE_INFINITY;
  if (silenceMinutes >= 120) add('冷场超过 2 小时', 0.3);
  else if (silenceMinutes >= config.quietAfterMinutes) add(`冷场超过 ${config.quietAfterMinutes} 分钟`, 0.2);

  const cooldownMs = config.cooldownMinutes * 60_000;
  const cooldownRemaining = lastSpokeAt > 0 ? Math.max(0, cooldownMs - (now - lastSpokeAt)) : 0;
  if (cooldownRemaining > 0) {
    add(`冷却中（还剩 ${Math.ceil(cooldownRemaining / 60_000)} 分钟）`, -0.45);
  }

  const quiet = inQuietHours(now, config.quietHours);
  if (quiet) add('安静时段', -0.3);

  const topicHash = hashTopic(text);
  if (topicHash && topicHash === state?.lastTopicHash) add('和上次同一个话题', -0.15);

  const finalScore = round(clamp(score, 0, 1));
  const speak = forced || finalScore >= config.threshold;
  return {
    speak,
    score: finalScore,
    reasons,
    forced,
    question,
    quiet,
    cooldownRemainingMs: cooldownRemaining,
    silenceMinutes: Number.isFinite(silenceMinutes) ? Math.round(silenceMinutes) : null,
  };
}

/** 记一次开口。 */
export function recordSpeak(state, now, config, { topic } = {}) {
  const history = Math.max(0, config.historyLimit) === 0 ? [] : [...(state.history ?? []), now].slice(-config.historyLimit);
  return {
    ...state,
    lastSpokeAt: now,
    lastTopicHash: hashTopic(topic) ?? state.lastTopicHash ?? null,
    history,
  };
}

/** 近 N 分钟开了几次口。 */
export function spokenWithin(state, now, minutes) {
  const since = now - minutes * 60_000;
  return (state.history ?? []).filter((stamp) => stamp >= since).length;
}

/** 进系统提示词的文本。 */
export function describe(state, now, config) {
  const lastSpokeAt = state?.lastSpokeAt ?? 0;
  const sinceMinutes = lastSpokeAt > 0 ? Math.max(0, Math.round((now - lastSpokeAt) / 60_000)) : null;
  const cooldownRemaining = lastSpokeAt > 0 ? Math.max(0, config.cooldownMinutes * 60_000 - (now - lastSpokeAt)) : 0;
  const recent = spokenWithin(state, now, 60);
  const status =
    sinceMinutes === null
      ? '这个会话里你还没开过口'
      : `上次开口在 ${sinceMinutes < 1 ? '刚刚' : `${sinceMinutes} 分钟前`}；冷却${cooldownRemaining > 0 ? `还剩 ${Math.ceil(cooldownRemaining / 60_000)} 分钟` : '已结束'}；最近一小时开口 ${recent} 次`;
  const text = [
    '[speak-up] 这是一道「要不要接话」的判断题，沉默是合法答案。',
    '- 被点名、被直接提问：开口。',
    '- 普通闲聊：只有能补充实质信息、纠正错误、或者正好撞上你在行的事才开口；否则安静。',
    `- 同一话题别追着说；冷却期（${config.cooldownMinutes} 分钟）内不该再开口。`,
    config.quietHours.length > 0 ? '- 安静时段默认少说话。' : null,
    `当前：${status}。`,
    '不要解释这套规则，也不要为了「有存在感」硬接话。',
  ]
    .filter((line) => line !== null)
    .join('\n');
  return text.length > config.promptMaxChars ? `${text.slice(0, config.promptMaxChars - 1)}…` : text;
}

/** 工具输出：结论 + 理由 + 冷却。 */
export function formatDecision(decision, config) {
  const verdict = decision.speak ? '开口' : '先安静';
  const head = `结论：${verdict}（score ${decision.score.toFixed(2)}，阈值 ${config.threshold}）`;
  const reasonText = decision.reasons.length
    ? decision.reasons.map((reason) => `${reason.label} ${reason.delta >= 0 ? '+' : ''}${reason.delta}`).join('、')
    : '没有命中任何信号';
  const cooldown =
    decision.cooldownRemainingMs > 0 ? `冷却还剩 ${Math.ceil(decision.cooldownRemainingMs / 60_000)} 分钟` : '不在冷却期';
  return [head, `理由：${reasonText}`, `状态：${cooldown}${decision.quiet ? ' · 安静时段' : ''}${decision.forced ? ' · 被点名，强制开口' : ''}`].join('\n');
}
