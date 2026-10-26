/**
 * 工具定义的 **schema 审计**：镜像 dsh 运行时的注册期校验。
 *
 * 为什么这一组测试能防止「插件完全不激活」：
 * `ctx.tools.register()` 在注册前会把 `parameters` 与 `output.schema` 过一遍
 * 「受支持的 JSON Schema 子集」校验（见 `E:\deepseek-harness\packages\core\tools\src\json-schema.ts`）。
 * 只要有一个关键字越界——最常见的是在属性上写 `required: true`、`type` 写成数组、
 * 或用了 `format`/`minimum`/`pattern` 这类不在子集里的关键字——整个插件会抛
 * `JsonSchemaError`、**不激活**、15 个工具全部消失。这道校验只在真实 Loader 里发生，
 * mock ctx 的单测不会报，所以必须在这里镜像一遍。
 *
 * 除了「合法」，本文件还钉住契约里的几条形状要求：
 * - 15 个工具一个不多一个不少，名字都是 `android_` 前缀的 snake_case；
 * - 每个工具的 `output.schema` 都是 **object 根 + `additionalProperties: false`**
 *   （多返回一个字段就是 `tool returned invalid output`）；
 * - `output.schema.properties` 与 `required` **完全相等**：本插件的返回值是固定字段集
 *   （`lib/schema.mjs` 的 `buildResult(defaults)` 保证），所以每个字段都必须 required；
 * - 每个工具都有 `execute` / `output.render` / `presentCall`，`description` 足够长（模型靠它选工具）。
 *
 * @module test/schema
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TOOL_NAMES,
  loadPlugins,
  loadToolDefinitions,
} from './helpers/plugin.mjs';
import {
  assertObjectJsonSchema,
  assertValidJsonSchema,
  collectSchemaViolations,
  validateValue,
} from './helpers/schema.mjs';

/* ------------------------------------------------------------------ *
 * 先证明校验器本身是准的（否则后面全绿也可能是假绿）
 * ------------------------------------------------------------------ */

test('镜像校验器自检：能抓出会让插件不激活的致命写法', () => {
  // 合法的两种基本形态
  assert.deepEqual(collectSchemaViolations({ type: 'string' }), []);
  assert.deepEqual(
    collectSchemaViolations({
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: 'string' } },
      required: ['a'],
    }),
    [],
  );
  // 属性级 required: true —— 最经典的不激活原因
  assert.ok(
    collectSchemaViolations({ type: 'object', properties: { a: { type: 'string', required: true } } }).length > 0,
    '属性上写 required: true 必须被判为非法',
  );
  // type 数组
  assert.ok(collectSchemaViolations({ type: ['string', 'null'] }).length > 0, 'type 数组必须被判为非法');
  // required 名字不在 properties 里 / required 不是数组
  assert.ok(collectSchemaViolations({ type: 'object', properties: {}, required: ['ghost'] }).length > 0);
  assert.ok(collectSchemaViolations({ type: 'object', properties: { a: { type: 'string' } }, required: 'a' }).length > 0);
  // oneOf 旁边不能有约束关键字；oneOf 至少要两个分支
  assert.ok(collectSchemaViolations({ oneOf: [{ type: 'string' }, { type: 'number' }], properties: {} }).length > 0);
  assert.ok(collectSchemaViolations({ oneOf: [{ type: 'string' }] }).length > 0, 'oneOf 只给一个分支必须非法');
  // 不支持的键（format/minimum/pattern/$ref 等）
  for (const keyword of ['format', 'minimum', 'maximum', 'pattern', '$ref', 'anyOf', 'allOf', 'not', 'nullable']) {
    assert.ok(
      collectSchemaViolations({ type: 'string', [keyword]: true }).length > 0,
      `${keyword} 不在子集里，必须被判为非法`,
    );
  }
  // 关键字放错 type
  assert.ok(collectSchemaViolations({ type: 'string', items: { type: 'string' } }).length > 0);
  assert.ok(collectSchemaViolations({ type: 'string', properties: {} }).length > 0);
  assert.ok(collectSchemaViolations({ type: 'array', properties: {} }).length > 0);
  // enum 必须是非空标量数组且类型匹配；const 必须在 enum 里
  assert.ok(collectSchemaViolations({ type: 'string', enum: [] }).length > 0);
  assert.ok(collectSchemaViolations({ type: 'object', enum: ['a'] }).length > 0);
  assert.ok(collectSchemaViolations({ type: 'string', enum: [1] }).length > 0);
  assert.ok(collectSchemaViolations({ type: 'string', enum: ['a', 'b'], const: 'c' }).length > 0);
  assert.deepEqual(collectSchemaViolations({ type: 'string', enum: ['a', 'b'], const: 'a' }), []);
  // 既有 type 又有 oneOf
  assert.ok(collectSchemaViolations({ type: 'object', oneOf: [{ type: 'object' }, { type: 'object' }] }).length > 0);
  // 注解必须是 lossless JSON，description/title 必须是字符串
  assert.ok(collectSchemaViolations({ type: 'string', description: 42 }).length > 0);
  assert.ok(collectSchemaViolations({ type: 'string', title: null }).length > 0);
  // additionalProperties 只允许 boolean（对象形式不支持）
  assert.ok(collectSchemaViolations({ type: 'object', additionalProperties: { type: 'string' } }).length > 0);
});

test('镜像校验器自检：能抓出返回值违规（缺 required / 多字段 / 类型错 / oneOf 零命中或多命中）', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { summary: { type: 'string' }, count: { type: 'number' } },
    required: ['summary', 'count'],
  };
  assert.deepEqual(validateValue(schema, { summary: 'ok', count: 1 }), []);
  assert.ok(validateValue(schema, { summary: 'ok' }).some((entry) => entry.includes('count')), '缺 required 必须报');
  assert.ok(
    validateValue(schema, { summary: 'ok', count: 1, extra: true }).some((entry) => entry.includes('extra')),
    'additionalProperties:false 必须真的拒绝多余键',
  );
  assert.ok(validateValue(schema, { summary: 1, count: 1 }).length > 0, '类型错必须报');
  assert.ok(validateValue(schema, { summary: 'ok', count: Number.NaN }).length > 0, 'NaN 不是合法 number');

  const oneOf = { oneOf: [{ type: 'string' }, { type: 'number' }] };
  assert.deepEqual(validateValue(oneOf, 'text'), []);
  assert.deepEqual(validateValue(oneOf, 42), []);
  assert.equal(validateValue(oneOf, true).length, 1, '两个分支都不命中必须报错');
});

/* ------------------------------------------------------------------ *
 * 15 个工具的定义
 * ------------------------------------------------------------------ */

test('插件通过 mock ctx 注册了且**仅**注册了契约规定的 15 个工具', async () => {
  const { definitions, list } = await loadPlugins({});
  assert.equal(list.length, 15, `期望 15 个工具，实际 ${list.length}：${list.map((d) => d.name).join(', ')}`);
  assert.deepEqual(
    [...definitions.keys()].sort(),
    [...TOOL_NAMES].sort(),
    '工具名集合与 DESIGN §3 不一致（少一个/多一个都会让 agent 的预期落空）',
  );
  for (const name of definitions.keys()) {
    assert.match(name, /^android_[a-z][a-z0-9_]*$/u, `${name} 必须是 android_ 前缀的 snake_case`);
  }
});

test('每个工具的 parameters 都落在 dsh 支持的 JSON Schema 子集里', async () => {
  const definitions = await loadToolDefinitions({});
  for (const [name, definition] of definitions) {
    assert.doesNotThrow(
      () => assertValidJsonSchema(definition.parameters, `${name}.parameters`),
      `${name}.parameters 会让插件不激活`,
    );
    assertObjectJsonSchema(definition.parameters, `${name}.parameters`);
    assert.equal(definition.parameters.additionalProperties, false, `${name}: parameters 必须 additionalProperties:false`);
    // required 里的每个名字都必须在 properties 里（校验器已查，这里再钉一次业务语义）
    for (const required of definition.parameters.required ?? []) {
      assert.ok(
        Object.hasOwn(definition.parameters.properties, required),
        `${name}: parameters.required 里的 "${required}" 不在 properties 里`,
      );
    }
  }
});

test('每个工具的 output.schema 都落在子集里、object 根、additionalProperties:false', async () => {
  const definitions = await loadToolDefinitions({});
  for (const [name, definition] of definitions) {
    const schema = definition.output?.schema;
    assert.notEqual(schema, undefined, `${name} 缺 output.schema`);
    assert.doesNotThrow(
      () => assertValidJsonSchema(schema, `${name}.output.schema`),
      `${name}.output.schema 会让插件不激活`,
    );
    assertObjectJsonSchema(schema, `${name}.output.schema`);
    assert.equal(schema.additionalProperties, false, `${name}: output.schema 必须 additionalProperties:false`);
    assert.notEqual(schema.properties, undefined, `${name}: output.schema 缺 properties`);
  }
});

test('每个工具的输出字段全部是 required（返回值是固定字段集，可选字段用空值表达）', async () => {
  const definitions = await loadToolDefinitions({});
  for (const [name, definition] of definitions) {
    const schema = definition.output.schema;
    const declared = Object.keys(schema.properties).sort();
    const required = [...(schema.required ?? [])].sort();
    assert.deepEqual(
      required,
      declared,
      `${name}: output.schema 的 required 必须覆盖全部 properties（多一个可选字段就会被 additionalProperties:false 之外的路径漏检）`,
    );
  }
});

test('每个工具的输出三件套（ok / code / message）齐全且类型正确', async () => {
  const definitions = await loadToolDefinitions({});
  for (const [name, definition] of definitions) {
    const properties = definition.output.schema.properties;
    for (const key of ['ok', 'code', 'message']) {
      assert.ok(Object.hasOwn(properties, key), `${name}: output.schema 缺 "${key}"`);
    }
    assert.equal(properties.ok.type, 'boolean', `${name}: ok 必须是 boolean`);
    assert.equal(properties.code.type, 'string', `${name}: code 必须是 string`);
    assert.equal(properties.message.type, 'string', `${name}: message 必须是 string`);
  }
});

test('每个工具都是完整定义：execute / output.render / presentCall 都是函数，description 足够长', async () => {
  const definitions = await loadToolDefinitions({});
  for (const [name, definition] of definitions) {
    assert.equal(typeof definition.execute, 'function', `${name}: 缺 execute`);
    assert.equal(typeof definition.output?.render, 'function', `${name}: 缺 output.render`);
    assert.equal(typeof definition.presentCall, 'function', `${name}: 缺 presentCall`);
    assert.equal(typeof definition.description, 'string', `${name}: 缺 description`);
    assert.ok(definition.description.length > 30, `${name}: description 太短，模型难以判断何时调用`);
    // 卡片标题：presentCall 必须返回 {card, title, kind}，且 title 非空
    const present = definition.presentCall({});
    assert.equal(present.card, 'generic', `${name}: presentCall.card 必须是 generic`);
    assert.equal(typeof present.title, 'string', `${name}: presentCall.title 必须是字符串`);
    assert.ok(present.title.length > 0, `${name}: presentCall.title 不能为空`);
    assert.ok(['read', 'execute'].includes(present.kind), `${name}: presentCall.kind 只能是 read/execute`);
  }
});

test('DESIGN §3 的关键参数与工具一一对应（防参数改名/漏参数）', async () => {
  const definitions = await loadToolDefinitions({});
  /**
   * 契约要求的参数（DESIGN §3 表格逐字）。
   *
   * 注意 `android_app_launch.settleMs` 是**实现的合理扩展**（DESIGN §3 尚未写入）：
   * WebView/Capacitor 冷启动要 3–5 秒才渲染首屏，`am start -W` 返回后立刻截图会得到白屏，
   * 所以实现加了「启动后默认等 1400 ms」的参数（0 = 不等）。已记入 README 的工具表，
   * 并已报 Lead 同步 DESIGN。这里把它算进期望集，**任何**参数漂移都会让测试红。
   */
  const expected = {
    android_status: [],
    android_avd_create: ['name', 'image', 'device', 'force'],
    android_emulator_start: ['avd', 'headless', 'cold', 'timeoutMs', 'port'],
    android_emulator_stop: ['serial', 'all', 'removeAvd'],
    android_apk_install: ['apk', 'serial', 'grantPermissions', 'reinstall'],
    android_app_launch: ['package', 'activity', 'serial', 'stopFirst', 'settleMs'],
    android_app_stop: ['package', 'serial'],
    android_ui_dump: ['serial', 'maxNodes', 'clickableOnly', 'filter'],
    android_ui_tap: ['x', 'y', 'text', 'resourceId', 'contentDesc', 'index', 'serial', 'waitMs'],
    android_ui_swipe: ['x1', 'y1', 'x2', 'y2', 'durationMs', 'serial'],
    android_ui_input: ['text', 'serial', 'clear'],
    android_ui_key: ['key', 'serial'],
    android_ui_wait: ['text', 'resourceId', 'contentDesc', 'timeoutMs', 'intervalMs', 'serial'],
    android_screenshot: ['serial', 'label'],
    android_logcat: ['serial', 'lines', 'level', 'tag', 'package'],
  };
  for (const [name, parameters] of Object.entries(expected)) {
    const definition = definitions.get(name);
    assert.notEqual(definition, undefined, `${name} 未注册`);
    const declared = Object.keys(definition.parameters.properties ?? {});
    assert.deepEqual(
      declared.sort(),
      [...parameters].sort(),
      `${name} 的参数集与 DESIGN §3 不一致`,
    );
  }
});

test('DESIGN §3 的必填参数在 parameters.required 里（apk / text / key / 坐标）', async () => {
  const definitions = await loadToolDefinitions({});
  /** 契约明确标"必填"的参数。 */
  const expected = {
    android_apk_install: ['apk'],
    android_ui_input: ['text'],
    android_ui_key: ['key'],
    android_ui_swipe: ['x1', 'y1', 'x2', 'y2'],
    android_app_stop: ['package'],
  };
  for (const [name, required] of Object.entries(expected)) {
    const definition = definitions.get(name);
    const declared = [...(definition.parameters.required ?? [])].sort();
    assert.deepEqual(declared, [...required].sort(), `${name} 的必填参数与契约不一致`);
  }
});

test('DESIGN §3 的关键返回字段都在 output.schema 里（防字段改名）', async () => {
  const definitions = await loadToolDefinitions({});
  /** 每个工具契约要求的关键字段（DESIGN §3）。 */
  const expected = {
    android_status: ['sdk', 'avds', 'images', 'device', 'translation', 'acceleration', 'suggestions'],
    android_avd_create: ['avd', 'image', 'created', 'command'],
    android_emulator_start: ['serial', 'avd', 'pid', 'bootedInMs', 'logFile', 'translation'],
    android_emulator_stop: ['serial', 'stopped'],
    android_apk_install: ['package', 'versionName', 'versionCode', 'abis', 'deviceAbis', 'matchedAbi', 'abiKind', 'translation', 'installedInMs', 'tips'],
    android_app_launch: ['package', 'activity', 'pid'],
    android_app_stop: ['package'],
    android_ui_dump: ['screen', 'nodeCount', 'package', 'nodes'],
    android_ui_tap: ['tapped', 'target'],
    android_ui_swipe: ['from', 'to', 'durationMs'],
    android_ui_input: ['sent', 'asciiOnly', 'note'],
    android_ui_key: ['key', 'keycode'],
    android_ui_wait: ['found', 'waitedMs', 'node'],
    android_screenshot: ['path', 'width', 'height', 'bytes'],
    android_logcat: ['lines', 'crashed', 'crashSummary'],
  };
  for (const [name, fields] of Object.entries(expected)) {
    const definition = definitions.get(name);
    const declared = Object.keys(definition.output.schema.properties ?? {});
    for (const field of fields) {
      assert.ok(declared.includes(field), `${name}: output.schema 缺契约字段 "${field}"（现有：${declared.join(', ')}）`);
    }
  }
});

test('输出里嵌套的节点/screen/bounds 形状与 DESIGN §3 一致', async () => {
  const definitions = await loadToolDefinitions({});
  const dump = definitions.get('android_ui_dump').output.schema.properties;
  const screen = dump.screen;
  assert.equal(screen.type, 'object');
  assert.deepEqual(Object.keys(screen.properties).sort(), ['height', 'rotation', 'width']);
  const node = dump.nodes.items;
  assert.equal(node.type, 'object');
  for (const field of ['text', 'resourceId', 'contentDesc', 'className', 'packageName', 'clickable', 'enabled', 'scrollable', 'bounds', 'center']) {
    assert.ok(Object.hasOwn(node.properties, field), `android_ui_dump 的节点缺字段 "${field}"`);
  }
  assert.deepEqual(Object.keys(node.properties.bounds.properties).sort(), ['x1', 'x2', 'y1', 'y2']);
  assert.deepEqual(Object.keys(node.properties.center.properties).sort(), ['x', 'y']);

  const tapTarget = definitions.get('android_ui_tap').output.schema.properties.target;
  for (const field of ['text', 'resourceId', 'className', 'bounds']) {
    assert.ok(Object.hasOwn(tapTarget.properties, field), `android_ui_tap 的 target 缺字段 "${field}"`);
  }
});

/* ------------------------------------------------------------------ *
 * v1.1.0：ARM 转译层（DESIGN §3 / §7.1）的 schema 漂移测试
 * ------------------------------------------------------------------ */

/** `translation` 契约规定的 8 个子字段（DESIGN §3 逐字）。 */
const TRANSLATION_SUB_FIELDS = ['bridge', 'version', 'enabled', 'kind', 'arm64', 'arm32', 'abilist64', 'abilist32'];

/** 声明 `translation` 的工具（DESIGN §3）。 */
const TRANSLATION_OWNERS = ['android_status', 'android_apk_install', 'android_emulator_start'];

test('v1.1.0 漂移：status / apk_install / emulator_start 的 output 都声明了 translation', async () => {
  const definitions = await loadToolDefinitions({});
  for (const name of TRANSLATION_OWNERS) {
    const schema = definitions.get(name)?.output?.schema;
    assert.notEqual(schema, undefined, `${name} 未注册`);
    assert.ok(
      Object.hasOwn(schema.properties, 'translation'),
      `${name}.output.schema 缺 translation（DESIGN §3 要求）`,
    );
  }
  // 其余工具不应凭空多出 translation（多字段 = additionalProperties:false 之外的契约噪音）
  for (const [name, definition] of definitions) {
    if (TRANSLATION_OWNERS.includes(name)) continue;
    assert.equal(
      Object.hasOwn(definition.output.schema.properties, 'translation'),
      false,
      `${name} 不该有 translation 字段（DESIGN §3 没有它）`,
    );
  }
});

test('v1.1.0 漂移：translation 是严格的 object（8 子字段全声明 + 全 required + additionalProperties:false）', async () => {
  const definitions = await loadToolDefinitions({});
  for (const name of TRANSLATION_OWNERS) {
    const translation = definitions.get(name).output.schema.properties.translation;
    assert.equal(translation.type, 'object', `${name}.translation 必须是 object`);
    assert.equal(
      translation.additionalProperties,
      false,
      `${name}.translation 必须 additionalProperties:false（多余子字段会被判非法）`,
    );
    assert.deepEqual(
      Object.keys(translation.properties).sort(),
      [...TRANSLATION_SUB_FIELDS].sort(),
      `${name}.translation 的子字段必须恰好是契约的 8 个`,
    );
    // 8 个子字段必须全部 required：运行时按 additionalProperties:false + required 校验，
    // 少一个 required 就等于允许 undefined 漏过去
    assert.deepEqual(
      [...(translation.required ?? [])].sort(),
      [...TRANSLATION_SUB_FIELDS].sort(),
      `${name}.translation 的 8 个子字段必须全部 required`,
    );
  }
});

test('v1.1.0 漂移：translation 子字段的类型与契约一致（string/bool/array<string>）', async () => {
  const definitions = await loadToolDefinitions({});
  const expected = {
    bridge: 'string',
    version: 'string',
    enabled: 'boolean',
    kind: 'string',
    arm64: 'boolean',
    arm32: 'boolean',
    abilist64: 'array',
    abilist32: 'array',
  };
  for (const name of TRANSLATION_OWNERS) {
    const properties = definitions.get(name).output.schema.properties.translation.properties;
    for (const [field, type] of Object.entries(expected)) {
      assert.equal(properties[field].type, type, `${name}.translation.${field} 类型应为 ${type}`);
    }
    // 两个 ABI 列表必须是 string 数组（不是 any 数组）
    for (const field of ['abilist64', 'abilist32']) {
      assert.equal(properties[field].items?.type, 'string', `${name}.translation.${field}.items 必须是 string`);
    }
    // kind 的 description 应列出契约的四个取值（模型据此判断）
    const kindDescription = properties.kind.description ?? '';
    for (const kind of ['ndk-translation', 'houdini', 'native', 'none']) {
      assert.ok(kindDescription.includes(kind), `${name}.translation.kind 的 description 应提到 "${kind}"`);
    }
  }
});

test('v1.1.0 漂移：apk_install 的 abiKind 是 string 且列出三个契约取值', async () => {
  const definitions = await loadToolDefinitions({});
  const schema = definitions.get('android_apk_install').output.schema;
  const abiKind = schema.properties.abiKind;
  assert.notEqual(abiKind, undefined, 'android_apk_install.output.schema 缺 abiKind');
  assert.equal(abiKind.type, 'string', 'abiKind 必须是 string');
  assert.ok(schema.required.includes('abiKind'), 'abiKind 必须在 required 里');
  const description = abiKind.description ?? '';
  for (const kind of ['native', 'translated', 'none']) {
    assert.ok(description.includes(kind), `abiKind 的 description 应解释 "${kind}"`);
  }
  // 其它工具不该有 abiKind
  for (const [name, definition] of definitions) {
    if (name === 'android_apk_install') continue;
    assert.equal(Object.hasOwn(definition.output.schema.properties, 'abiKind'), false, `${name} 不该有 abiKind`);
  }
});

test('契约守护：android_emulator_start **没有** nativeBridge 参数（转译层无法用命令行控制）', async () => {
  const definitions = await loadToolDefinitions({});
  const parameters = definitions.get('android_emulator_start').parameters;
  const declared = Object.keys(parameters.properties);
  // 2026-10-24 实测：emulator -prop 只支持 qemu.*，ro.dalvik.vm.native.bridge 无法覆盖。
  // 契约因此删掉了 nativeBridge；这条断言防止它被重新加回来（会误导用户以为能关转译）。
  assert.equal(
    Object.hasOwn(parameters.properties, 'nativeBridge'),
    false,
    'android_emulator_start 不应再有 nativeBridge 参数（-prop 无法覆盖 ro.* 属性）',
  );
  assert.deepEqual(
    declared.sort(),
    ['avd', 'cold', 'headless', 'port', 'timeoutMs'],
    'android_emulator_start 的参数应恰好是 DESIGN §3 的 5 个',
  );
  // 同理，任何工具都不该出现 nativeBridge
  for (const [name, definition] of definitions) {
    assert.equal(
      Object.hasOwn(definition.parameters.properties ?? {}, 'nativeBridge'),
      false,
      `${name} 不该有 nativeBridge 参数`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * v1.2.0：多会话隔离（DESIGN §3 / §7.2）的 schema 漂移测试
 * ------------------------------------------------------------------ */

/** `instances[]` 里每一项的子字段（DESIGN §3）。 */
const INSTANCE_SUB_FIELDS = ['sessionKey', 'serial', 'avd', 'pid', 'booted', 'lastPackage'];

test('v1.2.0 漂移：android_status 声明了 sessionKey / instances / instanceLimit / avdDisk', async () => {
  const definitions = await loadToolDefinitions({});
  const schema = definitions.get('android_status').output.schema;
  for (const field of ['sessionKey', 'instances', 'instanceLimit', 'avdDisk']) {
    assert.ok(
      Object.hasOwn(schema.properties, field),
      `android_status.output.schema 缺 "${field}"（v1.2.0 契约要求）`,
    );
    assert.ok(schema.required.includes(field), `android_status.${field} 必须在 required 里`);
  }
  assert.equal(schema.properties.sessionKey.type, 'string', 'sessionKey 必须是 string');
});

test('v1.2.0 漂移：instances[] 的子字段全 required、都声明、类型正确', async () => {
  const definitions = await loadToolDefinitions({});
  const instances = definitions.get('android_status').output.schema.properties.instances;
  assert.equal(instances.type, 'array', 'instances 必须是数组');
  const item = instances.items;
  assert.equal(item.type, 'object', 'instances[] 必须是 object');
  assert.equal(item.additionalProperties, false, 'instances[] 必须 additionalProperties:false');
  assert.deepEqual(
    Object.keys(item.properties).sort(),
    [...INSTANCE_SUB_FIELDS].sort(),
    'instances[] 的子字段必须恰好是契约那些',
  );
  assert.deepEqual(
    [...(item.required ?? [])].sort(),
    [...INSTANCE_SUB_FIELDS].sort(),
    'instances[] 的每个子字段都必须 required（少一个就会被 JSON 投影丢掉）',
  );
  const expected = {
    sessionKey: 'string',
    serial: 'string',
    avd: 'string',
    pid: 'number',
    booted: 'boolean',
    lastPackage: 'string',
  };
  for (const [field, type] of Object.entries(expected)) {
    assert.equal(item.properties[field].type, type, `instances[].${field} 类型应为 ${type}`);
  }
});

test('v1.2.0 漂移：instanceLimit 是 count/max 两个 number，avdDisk 是 3 个 number', async () => {
  const definitions = await loadToolDefinitions({});
  const schema = definitions.get('android_status').output.schema;

  const instanceLimit = schema.properties.instanceLimit;
  assert.equal(instanceLimit.type, 'object');
  assert.equal(instanceLimit.additionalProperties, false);
  assert.deepEqual(Object.keys(instanceLimit.properties).sort(), ['count', 'max']);
  assert.deepEqual([...(instanceLimit.required ?? [])].sort(), ['count', 'max']);
  for (const field of ['count', 'max']) {
    assert.equal(instanceLimit.properties[field].type, 'number', `instanceLimit.${field} 必须是 number`);
  }

  const avdDisk = schema.properties.avdDisk;
  assert.equal(avdDisk.type, 'object');
  assert.equal(avdDisk.additionalProperties, false);
  assert.deepEqual(
    Object.keys(avdDisk.properties).sort(),
    ['freeDiskGb', 'sessionAvdCount', 'totalGb'],
    'avdDisk 必须恰好有 3 个子字段',
  );
  assert.deepEqual(
    [...(avdDisk.required ?? [])].sort(),
    ['freeDiskGb', 'sessionAvdCount', 'totalGb'],
    'avdDisk 的 3 个子字段都必须 required',
  );
  for (const field of ['sessionAvdCount', 'totalGb', 'freeDiskGb']) {
    assert.equal(avdDisk.properties[field].type, 'number', `avdDisk.${field} 必须是 number`);
  }
});

test('v1.2.0 漂移：android_status 的 avds[] 带 kind（session-pinned / template）', async () => {
  const definitions = await loadToolDefinitions({});
  const avds = definitions.get('android_status').output.schema.properties.avds;
  const item = avds.items;
  assert.ok(Object.hasOwn(item.properties, 'kind'), 'avds[] 缺 kind（v1.2.0 用来区分会话专属/模板）');
  assert.equal(item.properties.kind.type, 'string', 'avds[].kind 必须是 string');
  const description = item.properties.kind.description ?? '';
  for (const kind of ['session-pinned', 'template']) {
    assert.ok(description.includes(kind), `avds[].kind 的 description 应提到 "${kind}"`);
  }
  assert.ok((item.required ?? []).includes('kind'), 'avds[].kind 必须在 required 里');
});

test('v1.2.0 漂移：android_emulator_start 返回 sessionKey / createdAvd，参数仍是 5 个', async () => {
  const definitions = await loadToolDefinitions({});
  const definition = definitions.get('android_emulator_start');
  const schema = definition.output.schema;

  for (const field of ['sessionKey', 'createdAvd']) {
    assert.ok(Object.hasOwn(schema.properties, field), `android_emulator_start.output 缺 "${field}"`);
    assert.ok(schema.required.includes(field), `android_emulator_start.${field} 必须在 required 里`);
  }
  assert.equal(schema.properties.sessionKey.type, 'string');
  assert.equal(schema.properties.createdAvd.type, 'boolean', 'createdAvd 必须是 boolean');

  // 转译层「关闭开关」已被实测推翻（v1.1.0），参数集必须保持着 5 个
  assert.deepEqual(
    Object.keys(definition.parameters.properties).sort(),
    ['avd', 'cold', 'headless', 'port', 'timeoutMs'],
    'android_emulator_start 的参数仍应是 5 个（nativeBridge 不得回归）',
  );
});

test('v1.2.0 漂移：android_emulator_stop 有 removeAvd 可选参数（不在 required 里）', async () => {
  const definitions = await loadToolDefinitions({});
  const parameters = definitions.get('android_emulator_stop').parameters;
  assert.ok(Object.hasOwn(parameters.properties, 'removeAvd'), 'android_emulator_stop 缺 removeAvd 参数');
  assert.equal(parameters.properties.removeAvd.type, 'boolean', 'removeAvd 必须是 boolean');
  assert.equal(
    (parameters.required ?? []).includes('removeAvd'),
    false,
    'removeAvd 是可选参数（默认 false），不能进 required',
  );
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['all', 'removeAvd', 'serial']);
});

test('v1.2.0 漂移：sessionKey 只在 status / emulator_start 的返回里（其它工具不该有）', async () => {
  const definitions = await loadToolDefinitions({});
  const owners = ['android_status', 'android_emulator_start'];
  for (const [name, definition] of definitions) {
    const has = Object.hasOwn(definition.output.schema.properties, 'sessionKey');
    if (owners.includes(name)) assert.equal(has, true, `${name} 应有 sessionKey`);
    else assert.equal(has, false, `${name} 不该有 sessionKey`);
  }
});
