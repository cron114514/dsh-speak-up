// 测试用的假 DSH 环境：不启动 Cordis，只把插件碰的那三个面接住。

const ALLOWED_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
]);

const ALLOWED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object']);

/**
 * 按 DSH 0.2.x 的注册期要求检查一个 ToolDefinition。
 * 这里复刻 dsh-tools 的断言（名称、output.render、支持的 JSON Schema 子集），
 * 让插件在真正加载前就能发现自己写了不支持的 keyword。
 */
export function assertRegistryReadyTool(definition, assert) {
  assert.equal(typeof definition.name, 'string');
  assert.ok(definition.name.length > 0);
  assert.notEqual(definition.name, 'run_code');
  assert.equal(typeof definition.description, 'string');
  assert.equal(typeof definition.execute, 'function');
  assert.equal(typeof definition.output, 'object');
  assert.equal(typeof definition.output.render, 'function');
  assert.ok(Array.isArray(definition.output.render({}, 'x')));
  walk(definition.parameters, 'parameters', assert);
  walk(definition.output.schema, 'output.schema', assert);
}

function walk(schema, path, assert) {
  assert.equal(typeof schema, 'object', `${path} must be an object`);
  for (const [key, value] of Object.entries(schema)) {
    assert.ok(ALLOWED_KEYWORDS.has(key), `${path}.${key} is not in the supported subset`);
    if (key === 'properties') {
      for (const [name, child] of Object.entries(value)) walk(child, `${path}.properties.${name}`, assert);
    } else if (key === 'items') {
      walk(value, `${path}.items`, assert);
    } else if (key === 'oneOf') {
      value.forEach((child, index) => walk(child, `${path}.oneOf[${index}]`, assert));
    } else if (key === 'type') {
      assert.ok(ALLOWED_TYPES.has(value), `${path}.type ${value} is not supported`);
    }
  }
}

/** 假的 Cordis 上下文：记录注册，effect 立即执行并记下标签。 */
export function fakeContext() {
  const registered = { contexts: [], sections: [], tools: [], effects: [] };
  const ctx = {
    effect(fn, label) {
      registered.effects.push(label);
      return fn();
    },
    systemPrompt: {
      context(entry) {
        registered.contexts.push(entry);
        return () => {};
      },
      section(entry) {
        registered.sections.push(entry);
        return () => {};
      },
    },
    tools: {
      register(definition) {
        registered.tools.push(definition);
        return () => {};
      },
    },
  };
  return { ctx, registered };
}
