/**
 * 测试基础设施：用 mock ctx 装载插件、拿到全部工具定义。
 *
 * 为什么不直接 `import { buildTools } from '../lib/tools.mjs'`：
 *   插件的对外形态是 **Cordis Host 插件**——`index.js` 导出 `apply(ctx, config)`，里面用
 *   `ctx.effect(...)` 包住 `ctx.tools.register(def)`。用 mock ctx 走 `apply` 能同时覆盖
 *   「接线层是否正确注册了工具」这件事；只测 lib 里的 builder 会漏掉 index.js 的接线错误
 *   （那正是真实 Loader 里最容易「插件不激活 / 工具没出现」的地方）。
 *
 * mock ctx 只实现插件真正用到的那几个 Cordis API（`tools.register` / `effect` /
 * `logger` / `inject`），比整台 Cordis 运行时轻得多，也让测试零依赖。
 *
 * @module test/helpers/plugin
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 插件根目录（`test/helpers/` 上两级）。 */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `index.js` 的绝对路径。 */
export const INDEX_PATH = path.join(PLUGIN_ROOT, 'index.js');

/**
 * 契约（DESIGN §3）规定的 15 个工具名，按文档顺序。
 *
 * 这个列表是**契约的镜像**，不来自实现：如果实现少注册一个／多注册一个，测试就会红。
 */
export const TOOL_NAMES = Object.freeze([
  'android_status',
  'android_avd_create',
  'android_emulator_start',
  'android_emulator_stop',
  'android_apk_install',
  'android_app_launch',
  'android_app_stop',
  'android_ui_dump',
  'android_ui_tap',
  'android_ui_swipe',
  'android_ui_input',
  'android_ui_key',
  'android_ui_wait',
  'android_screenshot',
  'android_logcat',
]);

/** 契约（DESIGN §4）冻结的 `code` 枚举。 */
export const ERROR_CODES = Object.freeze([
  'OK',
  'NO_SDK',
  'NO_ADB',
  'NO_EMULATOR',
  'NO_AVD_MANAGER',
  'NO_AVD',
  'NO_IMAGE',
  'AVD_CREATE_FAILED',
  'DEVICE_NOT_RUNNING',
  'DEVICE_BUSY',
  'MULTIPLE_DEVICES',
  'BOOT_TIMEOUT',
  'EMULATOR_START_FAILED',
  'INSTALL_FAILED',
  'ABI_MISMATCH',
  'APK_NOT_FOUND',
  'APK_UNREADABLE',
  'APP_NOT_FOUND',
  'LAUNCH_FAILED',
  'ELEMENT_NOT_FOUND',
  'BAD_ARGUMENT',
  'SPAWN_DENIED',
  'TIMEOUT',
  'ADB_FAILED',
  'UI_DUMP_FAILED',
  'INTERNAL',
]);

/**
 * 建一个只实现插件所需 API 的 mock Cordis ctx。
 *
 * `tools.register` 会像真实注册表一样拒绝**重复工具名**（真实运行时重复注册会直接报错），
 * 并把工具收进 `definitions`；`effect(fn)` 会**立即执行** `fn`（真实 `ctx.effect` 在插件
 * 激活时也是立即执行的）并收集它返回的 disposer。
 *
 * @param {{ logger?: object }} [options] 覆盖项。
 * @returns {{
 *   ctx: object,
 *   definitions: Map<string, object>,
 *   effects: Array<{ label: string, dispose: unknown }>,
 *   disposeAll: () => void,
 *   logger: object,
 * }} mock ctx 与收集器。
 */
export function createMockCtx(options = {}) {
  /** @type {Map<string, object>} */
  const definitions = new Map();
  /** @type {Array<{ label: string, dispose: unknown }>} */
  const effects = [];
  /** 记录所有 logger 调用，方便断言「加载日志」之类的行为。 */
  const logs = [];
  const logger = options.logger ?? {
    debug: (...args) => logs.push(['debug', ...args]),
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
  };

  const ctx = {
    logger,
    logs,
    tools: {
      /**
       * 注册一个工具定义（镜像真实注册表的返回值：disposer）。
       *
       * @param {object} definition 工具定义。
       * @returns {() => void} disposer。
       */
      register(definition) {
        if (definition === null || typeof definition !== 'object') {
          throw new TypeError('ctx.tools.register(def): def 必须是对象');
        }
        const name = definition.name;
        if (typeof name !== 'string' || name === '') {
          throw new TypeError('ctx.tools.register(def): def.name 必须是非空字符串');
        }
        if (definitions.has(name)) {
          throw new Error(`工具名重复注册: ${name}`);
        }
        definitions.set(name, definition);
        return () => {
          definitions.delete(name);
        };
      },
    },
    /**
     * 同步执行 effect body 并收集 disposer（镜像 Cordis 的生命周期语义）。
     *
     * @param {() => unknown} body effect 主体。
     * @param {string} [label] 诊断标签。
     * @returns {() => void} disposer。
     */
    effect(body, label = 'effect') {
      if (typeof body !== 'function') throw new TypeError('ctx.effect(body): body 必须是函数');
      const dispose = body();
      const entry = { label, dispose };
      effects.push(entry);
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
    /**
     * 可选服务注入：android-emulator 是零依赖 Host 插件，只用 `tools`，不声明其它服务。
     * 这里保留一个空实现，保证 `apply` 里的 `ctx.inject?.(...)` 不会炸。
     *
     * @param {string[]} _services 服务名。
     * @param {Function} _callback 回调。
     * @returns {() => void} disposer。
     */
    inject(_services, _callback) {
      return () => {};
    },
    /**
     * 服务查询：mock 里没有其它服务。
     *
     * @returns {undefined} 永远 undefined。
     */
    get() {
      return undefined;
    },
  };

  return {
    ctx,
    definitions,
    effects,
    logger,
    /** 逆序执行所有收集到的 disposer（模拟插件卸载）。 */
    disposeAll() {
      for (const entry of [...effects].reverse()) {
        if (typeof entry.dispose === 'function') entry.dispose();
      }
    },
  };
}

/**
 * 装载插件模块并取出 `apply`。
 *
 * @returns {Promise<Function>} `apply(ctx, config)`。
 */
async function loadApply() {
  const module = await import(pathToFileURL(INDEX_PATH).href);
  const candidate =
    typeof module.apply === 'function'
      ? module.apply
      : typeof module.default === 'function'
        ? module.default
        : module.default?.apply;
  if (typeof candidate !== 'function') {
    throw new Error(
      `${INDEX_PATH} 没有导出 apply(ctx, config)（Host 插件契约）。实际导出：${Object.keys(module).join(', ')}`,
    );
  }
  return candidate;
}

/**
 * 用 mock ctx 装载插件，返回注册到的全部工具定义。
 *
 * @param {object} [config] patch 行 config（省略即全默认）。
 * @returns {Promise<{
 *   definitions: Map<string, object>,
 *   list: object[],
 *   ctx: object,
 *   effects: Array<{ label: string, dispose: unknown }>,
 *   disposeAll: () => void,
 *   logs: unknown[],
 * }>} 装载结果。
 */
export async function loadPlugins(config = {}) {
  const apply = await loadApply();
  const mock = createMockCtx();
  apply(mock.ctx, config);
  return {
    definitions: mock.definitions,
    list: [...mock.definitions.values()],
    ctx: mock.ctx,
    effects: mock.effects,
    disposeAll: mock.disposeAll,
    logs: mock.ctx.logs,
  };
}

/**
 * 装载插件并按名字索引工具定义（测试里最常用的入口）。
 *
 * @param {object} [config] patch 行 config。
 * @returns {Promise<Map<string, object>>} 工具名 → 定义。
 */
export async function loadToolDefinitions(config = {}) {
  const loaded = await loadPlugins(config);
  return loaded.definitions;
}

/**
 * 造一个「一定找不到 SDK」的配置：显式指向临时目录下一个不存在的路径。
 *
 * 注意本机确实装了 Android SDK（`%LOCALAPPDATA%\Android\Sdk`），所以离线用例**不能**依赖
 * 「自动发现失败」——必须主动把路径钉死到不存在的位置，否则测试在这台机器上会走成功分支。
 *
 * @param {string} directory 一个真实存在但里面没有 SDK 的目录（通常是临时目录）。
 * @returns {object} config。
 */
export function offlineConfig(directory) {
  return {
    sdkPath: path.join(directory, '__no_sdk_here__'),
    adbPath: path.join(directory, '__no_adb_here__', 'adb.exe'),
    emulatorPath: path.join(directory, '__no_emulator_here__', 'emulator.exe'),
    outputDir: path.join(directory, 'output'),
    bootTimeoutMs: 50,
  };
}

/** SDK 自动发现会读的全部环境变量（含 Windows 的 `Path` 大小写变体）。 */
const SDK_ENV_KEYS = [
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'ANDROID_AVD_HOME',
  'ANDROID_USER_HOME',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOME',
  'PATH',
  'Path',
];

/**
 * 在「一个 SDK 都不存在」的环境里执行一段测试代码。
 *
 * 为什么光有 `offlineConfig()` 不够：`discoverSdk()` 的候选链里有
 * `%LOCALAPPDATA%\Android\Sdk`、`%USERPROFILE%\Android\Sdk`，以及最后兜底的
 * `which('adb')`（查 PATH）。本机真的装了 SDK、PATH 里也可能有 adb，所以只把
 * `config.sdkPath` 指向不存在的位置，**仍然会找到真实 SDK**——测试就会依赖
 * 「这台机器有没有装 SDK / 有没有真机在跑」，在别的机器上立刻红。
 *
 * 做法是连同环境变量一起清掉，只留 config 里那几个指向不存在路径的覆盖项。
 * 用完在 `finally` 里原样恢复，不污染同一进程里的其它测试。
 *
 * @template T
 * @param {() => Promise<T>} body 测试主体。
 * @returns {Promise<T>} body 的返回值。
 */
export async function withNoSdkEnv(body) {
  const saved = new Map(SDK_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of SDK_ENV_KEYS) delete process.env[key];
    return await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
