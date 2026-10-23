import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  describe,
  evaluate,
  formatDecision,
  hashTopic,
  inQuietHours,
  looksLikeQuestion,
  matchKeywords,
  normalizeConfig,
  recordSpeak,
  spokenWithin,
} from '../lib/policy.mjs';

const config = normalizeConfig({ keywords: ['结果', '报错'] });
const state = { lastSpokeAt: 0, lastTopicHash: null };
const NOON = new Date(2026, 0, 1, 12, 0, 0).getTime();
const MINUTE = 60_000;

test('闲聊并且很久没说话，也应该先安静', () => {
  const decision = evaluate({ message: '今天好热' }, state, config, NOON);
  assert.equal(decision.speak, false);
  assert.ok(decision.score < config.threshold);
});

test('被点名一定开口，哪怕在冷却期', () => {
  const recent = { lastSpokeAt: NOON - MINUTE, lastTopicHash: null };
  const decision = evaluate({ message: '在吗', mention: true }, recent, config, NOON);
  assert.equal(decision.speak, true);
  assert.equal(decision.forced, true);
  assert.ok(decision.cooldownRemainingMs > 0);
});

test('直接提问会加分', () => {
  const plain = evaluate({ message: '这个跑得还行' }, state, config, NOON);
  const asked = evaluate({ message: '这个跑得怎么样？' }, state, config, NOON);
  assert.ok(asked.score > plain.score);
  assert.equal(asked.question, true);
  assert.equal(looksLikeQuestion('有人吗'), true);
  assert.equal(looksLikeQuestion('今天好热'), false);
});

test('关键词按命中数量加分，最多 0.45', () => {
  assert.deepEqual(matchKeywords('结果报错了', config.keywords), ['结果', '报错']);
  const many = normalizeConfig({ keywords: ['a', 'b', 'c', 'd', 'e'] });
  const decision = evaluate({ message: 'a b c d e' }, state, many, NOON);
  const keywordReason = decision.reasons.find((reason) => reason.label.startsWith('关键词'));
  assert.equal(keywordReason.delta, 0.45);
});

test('冷却期内分数被压下去', () => {
  const hot = { message: '这个问题怎么办？结果报错了', mention: false };
  const free = evaluate(hot, { lastSpokeAt: 0, lastTopicHash: null }, config, NOON);
  const cooling = evaluate(hot, { lastSpokeAt: NOON - MINUTE, lastTopicHash: null }, config, NOON);
  assert.equal(free.speak, true);
  assert.equal(cooling.speak, false);
  assert.ok(cooling.reasons.some((reason) => reason.label.includes('冷却')));
});

test('同一个话题追着说会减分', () => {
  const message = '那个部署脚本又挂了？';
  const hash = hashTopic(message);
  const fresh = evaluate({ message }, { lastSpokeAt: 0, lastTopicHash: null }, config, NOON);
  const repeat = evaluate({ message }, { lastSpokeAt: 0, lastTopicHash: hash }, config, NOON);
  assert.ok(repeat.score < fresh.score);
});

test('安静时段跨午夜也能判断', () => {
  const night = new Date(2026, 0, 1, 23, 30, 0).getTime();
  const early = new Date(2026, 0, 1, 3, 0, 0).getTime();
  const quiet = normalizeConfig({ quietHours: [[23, 7]] });
  assert.equal(inQuietHours(night, quiet.quietHours), true);
  assert.equal(inQuietHours(early, quiet.quietHours), true);
  assert.equal(inQuietHours(NOON, quiet.quietHours), false);
  const decision = evaluate({ message: '随便说说' }, state, quiet, early);
  assert.ok(decision.reasons.some((reason) => reason.label === '安静时段'));
});

test('冷却/安静时段的配置写坏也不会崩', () => {
  const weird = normalizeConfig({ threshold: 'x', cooldownMinutes: -2, quietHours: [[1]], keywords: 'no' });
  assert.equal(weird.threshold, DEFAULT_CONFIG.threshold);
  assert.equal(weird.cooldownMinutes, 0);
  assert.deepEqual(weird.quietHours, []);
  assert.deepEqual(weird.keywords, []);
});

test('recordSpeak 记时间、记话题、裁剪历史', () => {
  const small = normalizeConfig({ historyLimit: 2 });
  let next = recordSpeak({ lastSpokeAt: 0, lastTopicHash: null, history: [] }, NOON, small, { topic: '部署' });
  next = recordSpeak(next, NOON + MINUTE, small, { topic: '部署' });
  next = recordSpeak(next, NOON + 2 * MINUTE, small, { topic: '日志' });
  assert.equal(next.lastSpokeAt, NOON + 2 * MINUTE);
  assert.equal(next.history.length, 2);
  assert.equal(spokenWithin(next, NOON + 2 * MINUTE, 10), 2);
  assert.equal(spokenWithin(next, NOON + 60 * MINUTE, 10), 0);
});

test('提示词文本带准则与当前状态，且不超长', () => {
  const spoke = { lastSpokeAt: NOON - 12 * MINUTE, lastTopicHash: null, history: [NOON - 12 * MINUTE] };
  const text = describe(spoke, NOON, config);
  assert.match(text, /speak-up/);
  assert.match(text, /12 分钟前/);
  assert.match(text, /最近一小时开口 1 次/);
  const tiny = normalizeConfig({ promptMaxChars: 160, quietHours: [[0, 7]] });
  assert.ok(describe(spoke, NOON, tiny).length <= 160);
});

test('formatDecision 有结论、阈值、理由', () => {
  const decision = evaluate({ message: '结果呢？' }, state, config, NOON);
  const text = formatDecision(decision, config);
  assert.match(text, /结论：/);
  assert.match(text, /阈值/);
  assert.match(text, /理由：/);
});
