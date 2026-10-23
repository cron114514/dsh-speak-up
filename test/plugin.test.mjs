import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-speak-test-'));
process.env.DSH_HOME = home;

const { apply, CONTEXT_NAME, NOTE_TOOL_NAME, SHOULD_TOOL_NAME } = await import('../lib/index.js');
const { assertRegistryReadyTool, fakeContext } = await import('./helpers.mjs');

test('apply 注册一条上下文和两个工具', () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { cooldownMinutes: 5 });

  assert.equal(registered.contexts.length, 1);
  assert.equal(registered.contexts[0].name, CONTEXT_NAME);
  assert.equal(registered.contexts[0].interpolate, false);

  const names = registered.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [NOTE_TOOL_NAME, SHOULD_TOOL_NAME].sort());
  for (const tool of registered.tools) assertRegistryReadyTool(tool, assert);
});

test('enabled=false 不注册', () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { enabled: false });
  assert.equal(registered.tools.length, 0);
});

test('should 工具给结论；note 工具推进冷却', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { cooldownMinutes: 5, threshold: 0.45 });
  const should = registered.tools.find((tool) => tool.name === SHOULD_TOOL_NAME);
  const note = registered.tools.find((tool) => tool.name === NOTE_TOOL_NAME);

  const quiet = await should.execute({ message: '今天好热' });
  assert.match(quiet, /结论：先安静/);

  const mentioned = await should.execute({ message: '在不在', mention: true });
  assert.match(mentioned, /结论：开口/);

  const noted = await note.execute({ topic: '天气' });
  assert.match(noted, /累计开口 1 次/);

  const cooling = await should.execute({ message: '这个问题怎么处理？结果报错了' });
  assert.match(cooling, /冷却还剩|冷却中/);
  assert.match(cooling, /结论：先安静/);

  const skip = await note.execute({ spoke: false });
  assert.match(skip, /状态不变/);
});

test('上下文文本反映冷却状态', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, {});
  const note = registered.tools.find((tool) => tool.name === NOTE_TOOL_NAME);
  await note.execute({ topic: '部署' });
  const text = registered.contexts[0].text();
  assert.match(text, /speak-up/);
  assert.match(text, /冷却/);
});

test('状态落盘并且损坏时不炸', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { statePath: path.join(home, 'speak.json') });
  const note = registered.tools.find((tool) => tool.name === NOTE_TOOL_NAME);
  await note.execute({ topic: 'x' });
  const raw = JSON.parse(fs.readFileSync(path.join(home, 'speak.json'), 'utf8'));
  assert.ok(raw.lastSpokeAt > 0);

  fs.writeFileSync(path.join(home, 'broken-speak.json'), 'nope', 'utf8');
  const broken = fakeContext();
  apply(broken.ctx, { statePath: path.join(home, 'broken-speak.json') });
  assert.equal(typeof broken.registered.contexts[0].text(), 'string');
  assert.match(await broken.registered.tools[0].execute({}), /结论：/);
});
