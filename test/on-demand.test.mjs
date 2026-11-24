/**
 * 按需门控的离线测试（1.3.0）。
 *
 * 覆盖九件事（施工规范 §2 第 4 项）：
 *  1. `onDemand` 默认开 → 15 个工具注册都带 `when`；
 *  2. skill 定义被注册、`name` 是 kebab-case、能被 `skill({ name })` 按名加载；
 *  3. 未加载 skill 时工具不可见；模型用 `skill` 工具加载后该 agent 放行；
 *  4. 加载别的 skill 不放行；失败的 skill 调用不放行；
 *  5. 用户 `/android-emulator` 斜杠调用（`session/event` 的 `skill-invocation`）同样放行；
 *  6. resume / fork 兜底：请求头里已声明过本插件工具 → 放行；
 *  7. fail-open（该模式看不到 `skill` 工具）与 `onDemand: false`（常驻）都不门控；
 *  8. `normalizeConfig` 的 `onDemand` 默认 true、只有显式 false 才关；
 *  9. 兜底边界：`agent` 缺失时放行、`requestHeader()` 抛错时按未激活处理、dispose 后清标记。
 *
 * 全离线：只走 `apply()` 的接线（构建工具定义 + 注册），**绝不启动模拟器、不调 adb**。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, normalizeConfig } from '../index.js';
import { SKILL_DEFINITION, SKILL_NAME } from '../lib/skill.mjs';
import { TOOL_NAMES } from './helpers/plugin.mjs';

/**
 * 造一个够 `apply()` 用的 mock ctx。
 *
 * @param {{
 *   config?: object,
 *   skillVisible?: boolean,
 * }} [options]
 *   `skillVisible=false` 模拟 minimal 这类没有 `skill` 工具的模式（fail-open）。
 * @returns {{
 *   registrations: Array<{ tool: object, options: object }>,
 *   skills: object[],
 *   emit: (event: string, ...args: unknown[]) => void,
 *   base: object,
 *   when: ((context: { agent?: object }) => boolean) | undefined,
 * }} mock 与收集器。
 */
function mount(options = {}) {
  const registrations = [];
  const handlers = new Map();
  const skills = [];
  const skillVisible = options.skillVisible !== false;

  /** scoped（inject 回调里那个）与本体共享 effect/logger/tools。 */
  const base = {
    logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
    tools: {
      /**
       * 注册工具定义（镜像真实注册表的签名：第二个参数是注册选项）。
       *
       * @param {object} tool 工具定义。
       * @param {object} [registrationOptions] `{ when }`。
       * @returns {() => void} disposer。
       */
      register(tool, registrationOptions = {}) {
        registrations.push({ tool, options: registrationOptions });
        return () => {
          const index = registrations.findIndex((entry) => entry.tool === tool);
          if (index >= 0) registrations.splice(index, 1);
        };
      },
      /**
       * 该 agent 自己 scope 的可见工具查询——fail-open 的判据就看这里。
       *
       * @param {string} toolName 工具名。
       * @returns {object | undefined} `skill` 可见时返回占位对象。
       */
      get(toolName) {
        if (toolName !== 'skill') return undefined;
        return skillVisible ? { name: 'skill' } : undefined;
      },
    },
    effect(callback, label) {
      const cleanup = callback();
      return () => {
        if (typeof cleanup === 'function') cleanup();
      };
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    /** `skills` 给 inject 用；`agents` 给斜杠调用那条路用。 */
    get(serviceName) {
      if (serviceName === 'skills') return { register: () => () => {} };
      if (serviceName === 'agents') return { get: (id) => base.__agents?.get(id) };
      return undefined;
    },
    inject(_serviceNames, callback) {
      const scoped = {
        ...base,
        skills: {
          register(definition) {
            skills.push(definition);
            return () => {};
          },
        },
      };
      callback(scoped);
    },
    __agents: new Map(),
  };

  apply(base, options.config ?? {});

  /** 触发某个事件的全部监听器。 */
  const emit = (event, ...args) => {
    for (const handler of handlers.get(event) ?? []) handler(...args);
  };

  return { registrations, skills, emit, base, when: registrations[0]?.options.when };
}

/** 一个够用的假 agent（带可配置的 requestHeader）。 */
function createAgent(headerTools = []) {
  return {
    session: {
      id: 'session-test',
      requestHeader: () => ({ tools: headerTools }),
    },
  };
}

test('1.3.0：默认 onDemand 开，15 个 android_* 工具全部带 when', () => {
  const { registrations } = mount();
  assert.equal(registrations.length, TOOL_NAMES.length, `应注册 ${TOOL_NAMES.length} 个工具`);
  assert.deepEqual(
    registrations.map((entry) => entry.tool.name).sort(),
    [...TOOL_NAMES].sort(),
    '注册的工具名必须与契约工具表完全一致',
  );
  for (const entry of registrations) {
    assert.equal(typeof entry.options.when, 'function', `${entry.tool.name} 应带 when`);
  }
});

test('1.3.0：skill 已注册 —— name 是 kebab-case、能被 skill({ name }) 按名加载', () => {
  const { skills } = mount();
  assert.equal(skills.length, 1, '应注册 1 个 skill');
  const definition = skills[0];
  assert.equal(definition.name, SKILL_NAME);
  assert.equal(SKILL_NAME, 'android-emulator');
  assert.match(definition.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'skill 名必须是 kebab-case');
  assert.equal(definition.source, 'runtime', '运行时 skill 的 source 必须是 runtime');
  assert.equal(definition.invocation?.modelInvocable, true, '模型必须能加载它');
  assert.equal(definition.invocation?.userInvocable, true, '用户斜杠调用也要支持');
  // 触发词（按需门控下，模型靠 description / whenToUse 决定要不要加载）。
  for (const keyword of ['安卓模拟器', 'APK', 'logcat', '截图']) {
    assert.ok(
      definition.description.includes(keyword) || definition.whenToUse.includes(keyword),
      `skill 触发词应包含「${keyword}」`,
    );
  }
  assert.ok(definition.whenToUse.includes('不涉及安卓'), 'whenToUse 要写清什么情况下不要加载');
  // 正文必须讲清「工具是按需的」以及主线（status → 启动 → 装包 → 操作 → 截图/logcat）。
  assert.ok(definition.content.includes('工具是按需加载的'), '正文必须说明工具按需出现');
  assert.ok(definition.content.includes('下一个模型步'), '正文必须说明从下一步出现');
  for (const toolName of ['android_status', 'android_emulator_start', 'android_apk_install',
    'android_ui_dump', 'android_screenshot', 'android_logcat']) {
    assert.ok(definition.content.includes(toolName), `正文应提到 ${toolName}`);
  }
  assert.ok(definition.content.includes('maxInstances'), '正文应提到 maxInstances 磁盘保护');
  assert.ok(definition.content.includes('--<sessionShort>') || definition.content.includes('sessionShort'),
    '正文应说明会话专属 AVD 命名');
  assert.ok(definition.content.includes('translated'), '正文应说明 translated 不要用耗时判性能');
  // 防止正文超长被工具结果修剪器截断（头 4096 + 尾 1024）。
  assert.ok(definition.content.length < 8192, `skill 正文 ${definition.content.length} 字符，超过 8192 会被截断`);
  assert.equal(definition, SKILL_DEFINITION, '注册的必须是同一份定义对象');
});

test('1.3.0：未加载 skill 时工具不可见；加载后该 agent 放行', () => {
  const { when, emit } = mount();
  const agent = createAgent();
  assert.equal(when({ agent }), false, '刚开的会话不该看见工具');

  // 模拟模型调用 skill 工具成功（tools/result 的载荷形态）。
  emit('tools/result', { name: 'skill', agent, arguments: { name: SKILL_NAME } }, { isError: false });
  assert.equal(when({ agent }), true, '加载 skill 后应放行');

  // 另一个 agent 不受影响（标记是按 agent 的，不是全局开关）。
  assert.equal(when({ agent: createAgent() }), false, '别的 agent 不该跟着放行');
});

test('1.3.0：加载别的 skill 不放行；失败的 skill 调用不放行', () => {
  const { when, emit } = mount();
  const other = createAgent();
  emit('tools/result', { name: 'skill', agent: other, arguments: { name: 'some-other-skill' } }, { isError: false });
  assert.equal(when({ agent: other }), false, '别的 skill 不该放行');

  const failed = createAgent();
  emit('tools/result', { name: 'skill', agent: failed, arguments: { name: SKILL_NAME } }, { isError: true });
  assert.equal(when({ agent: failed }), false, '失败的 skill 调用不该放行');
});

test('1.3.0：用户 /android-emulator 斜杠调用也放行（session/event 路径）', () => {
  const { when, emit, base } = mount();
  const session = { id: 'session-slash' };
  const agent = { ...createAgent(), session };
  base.__agents.set(session.id, agent);

  emit('session/event', session, {
    type: 'user/message',
    data: { source: { kind: 'skill-invocation', name: SKILL_NAME } },
  });
  assert.equal(when({ agent }), true, '斜杠调用后应放行');
});

test('1.3.0：resume/fork 兜底 —— 请求头里已声明本插件工具则放行', () => {
  const { when } = mount();
  const resumed = createAgent([{ name: 'android_status', description: '', parameters: {} }]);
  assert.equal(when({ agent: resumed }), true, '历史请求头已有声明时应放行');

  const unrelated = createAgent([{ name: 'read', description: '', parameters: {} }]);
  assert.equal(when({ agent: unrelated }), false, '请求头只有别人的工具时不该放行');
});

test('1.3.0：fail-open —— 该模式没有 skill 工具时不门控', () => {
  const { when } = mount({ skillVisible: false });
  assert.equal(when({ agent: createAgent() }), true, '没有 skill 工具的模式应保持常驻');
});

test('1.3.0：onDemand:false 时注册不带 when（老行为，工具常驻）', () => {
  const { registrations } = mount({ config: { onDemand: false } });
  assert.equal(registrations.length, TOOL_NAMES.length);
  for (const entry of registrations) {
    assert.equal(entry.options.when, undefined, `${entry.tool.name} 不该带 when`);
  }
});

test('1.3.0：normalizeConfig 的 onDemand 默认 true、显式 false 才关', () => {
  assert.equal(normalizeConfig({}).onDemand, true);
  assert.equal(normalizeConfig({ onDemand: false }).onDemand, false);
  assert.equal(normalizeConfig({ onDemand: true }).onDemand, true);
  // 非布尔的垃圾值不生效，仍按默认开。
  assert.equal(normalizeConfig({ onDemand: 'no' }).onDemand, true);
  assert.equal(normalizeConfig(null).onDemand, true);
  // 不因为加了 onDemand 而破坏既有字段的默认值。
  const defaults = normalizeConfig({});
  assert.equal(defaults.perSession, true);
  assert.equal(defaults.maxInstances, 2);
  assert.equal(defaults.avdName, 'dsh_android');
});

test('1.3.0：兜底边界 —— agent 缺失放行、requestHeader 抛错按未激活、dispose 后清标记', () => {
  const { when, emit } = mount();
  assert.equal(when({}), true, '没有 agent 上下文（非会话调用）时放行');

  // requestHeader 抛错（会话已 dispose）：按「未激活」处理，不向上抛。
  const broken = {
    session: {
      id: 'session-broken',
      requestHeader() {
        throw new Error('session disposed');
      },
    },
  };
  assert.equal(when({ agent: broken }), false, 'requestHeader 抛错时按未激活处理');

  // agent 被 dispose 后，之前的内存标记必须清掉（否则对象被复用时会误放行）。
  const agent = createAgent();
  emit('tools/result', { name: 'skill', agent, arguments: { name: SKILL_NAME } }, { isError: false });
  assert.equal(when({ agent }), true, '标记后放行');
  emit('agent/disposed', { agent });
  assert.equal(when({ agent }), false, 'dispose 后标记应清除');
});
