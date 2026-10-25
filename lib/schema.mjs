/**
 * dsh-android-emulator — 严格 JSON Schema 子集构造器 + 统一结果/错误类型。
 *
 * ## 为什么必须有这个文件
 *
 * 非随附插件无法 import `@deepseek-ai/dsh-tools`（profile 里解析不到 `@deepseek-ai/*`），
 * 所以拿不到 `defineTool` 那层「作者方言 → 严格 JSON Schema」的编译器。
 * `ctx.tools.register()` 只接受编译后的形态，并且有两道校验，漏一道就是真实事故：
 *
 * 1. **注册时**：schema 必须落在受支持的子集里（`type` / `oneOf` / `properties` /
 *    `required` / `additionalProperties` / `items` / `enum` / `const`，外加注解
 *    `description` / `title` / `default` / `examples`）。写错一个键——最常见的是在
 *    属性上写 `required: true`——直接抛 `JsonSchemaError`，**整个插件不激活**
 *    （entry 报 "did not activate"，配置页里 `status: absent`）。
 * 2. **每次 execute 之后**：返回值必须满足自己声明的 `output.schema`。
 *    `additionalProperties: false` 下多一个没声明的键，调用方只看到
 *    `tool returned invalid output`；而 mock ctx 的 `register` 不校验返回值，
 *    单测全绿也发现不了。
 *
 * 对策是把这两件事变成**构造方式**而不是人肉纪律：
 *
 * - 所有 schema 都经 `objectSchema()` / `prop()` / `arrayOf()` 生成：
 *   `required` 永远是字符串数组、永远只出现在 object 节点上、属性上永远不写
 *   `required: true`、`type` 永远是单个字符串。
 * - 每个工具用一个 `buildResult(defaults)` 工厂：`defaults` 是**该工具全部返回
 *   字段的空值**（嵌套对象也补齐），`ok()` / `fail()` 在它上面覆盖。于是
 *   成功分支和每个失败分支返回的都是同一组键，schema 只写一遍、字段齐全由构造
 *   方式保证。
 *
 * ## 错误 → 结果码
 *
 * 工具内部用 `toolError(code, message)` 往上层抛带机器可读 `code` 的错误，
 * 工具入口统一 `catch` 成 `fail(code, message)`。`exec` 层永不抛异常，所以这里
 * 的异常只表达「业务结果」，不表达「程序坏了」。
 */

/** 该模块只支持的单值 `type`（不支持 type 数组）。 */
export const TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];

/**
 * 声明一个 schema 属性。
 *
 * @param {string} type 单个 JSON Schema 类型字符串。
 * @param {string} [description] 给人/模型看的中文说明。
 * @param {object} [extra] 其他允许的键（`items` / `enum` / `const` / `default` / …）。
 */
export function prop(type, description, extra = {}) {
  const node = { type };
  if (description !== undefined && description !== null) node.description = description;
  return Object.assign(node, extra);
}

/** 声明一个数组属性（`items` 是唯一合法子键）。 */
export function arrayOf(items, description) {
  return prop('array', description, { items });
}

/**
 * 构造严格 object schema。
 *
 * 调用方只传 properties；`required` 必须覆盖所有**总是存在**的键（本插件所有工具
 * 的返回值都走固定字段集，所以通常就是全部键）。这里还会做一次开发期自检：
 * 如果 required 里有名字不在 properties 中，说明接线写错了，直接抛出来比等到
 * Loader 里变成 "did not activate" 好定位。
 *
 * @param {object} properties 属性名 → schema 节点。
 * @param {string[]} [required] 必有字段名（字符串数组）。
 */
export function objectSchema(properties, required = []) {
  const names = Object.keys(properties);
  for (const name of required) {
    if (!names.includes(name)) {
      throw new Error(`schema 接线错误：required 里的 "${name}" 不在 properties 中（有：${names.join(', ')}）`);
    }
  }
  const node = { type: 'object', additionalProperties: false, properties };
  if (required.length > 0) node.required = required;
  return node;
}

/** 一个 text 内容块，`output.render` 的返回形态。 */
export function text(content) {
  return [{ type: 'text', text: String(content) }];
}

/** 截断长文本（渲染用，避免把一整屏 XML 塞给模型）。 */
export function truncate(value, max = 4000) {
  const string = typeof value === 'string' ? value : String(value ?? '');
  if (string.length <= max) return string;
  return `${string.slice(0, max)}\n…（已截断，共 ${string.length} 字符）`;
}

/** 把任意值渲染成缩进 JSON（调试/兜底渲染用）。 */
export function renderJson(value, max = 12000) {
  let body;
  try {
    body = JSON.stringify(value, null, 2);
  } catch {
    body = String(value);
  }
  return text(truncate(body ?? '', max));
}

/**
 * 统一结果构造器。
 *
 * @param {object|(() => object)} defaults 该工具所有返回字段的空值（函数形式避免共享引用）。
 * @returns {{ blank: () => object, ok: (message: string, extra?: object) => object, fail: (code: string, message: string, extra?: object) => object }}
 */
export function buildResult(defaults) {
  const blank = () => (typeof defaults === 'function' ? defaults() : structuredClone(defaults));
  return {
    blank,
    /** 成功分支：`code` 固定 "OK"，`ok` 固定 true。 */
    ok(message, extra = {}) {
      return { ...blank(), ...extra, ok: true, code: 'OK', message };
    },
    /** 失败分支：返回机器可读 code 与人话 message，且字段集与成功分支完全一致。 */
    fail(code, message, extra = {}) {
      return { ...blank(), ...extra, ok: false, code: String(code), message };
    },
  };
}

/** 带机器可读 `code` 的业务错误。 */
export class ToolError extends Error {
  /**
   * @param {string} code DESIGN §4 冻结枚举里的错误码。
   * @param {string} message 中文说明 + 可执行的下一步。
   */
  constructor(code, message) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

/** 构造一个 `ToolError`（工具层 `throw` 用）。 */
export function toolError(code, message) {
  return new ToolError(code, message);
}

/** 从任意异常里取错误码；未标记的按 INTERNAL 处理。 */
export function codeOf(error, fallback = 'INTERNAL') {
  if (error !== null && typeof error === 'object') {
    const code = typeof error.code === 'string' && error.code !== '' ? error.code : '';
    // Node 的 fs/prem 错误码（ENOENT/EPERM/EACCES）不是 DESIGN 的枚举，映射一次。
    if (/^E[A-Z]+$/.test(code)) {
      if (code === 'EPERM' || code === 'EACCES') return 'SPAWN_DENIED';
      if (code === 'ENOENT') return 'INTERNAL';
      return fallback;
    }
    if (code !== '') return code;
  }
  return fallback;
}

/** 从异常里取人话 message。 */
export function messageOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message;
  return String(error);
}

/** 把毫秒数格式化成人类可读（消息里用）。 */
export function ms(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return '0 ms';
  return number >= 1000 ? `${(number / 1000).toFixed(1)} s` : `${Math.round(number)} ms`;
}

/** 数值钳制。 */
export function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

/**
 * 归一成安全的 JSON 整数。
 *
 * 关键在 `-0`：`Math.round(-0.4)` 得到 `-0`，而 DSH 的 `isJsonNumber()` 明确排除
 * `-0`（`!Object.is(value, -0)`），返回 `-0` 会让工具输出被判成
 * `must be a finite JSON number`。所以这里把 `-0` 折回 `0`。
 */
export function toInt(value, fallback = 0) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return number === 0 ? 0 : number;
}

/** sleep（轮询用）。 */
export function sleep(durationMs) {
  return new Promise((resolve) => {
    // 注意：**不要 unref()**。`android_ui_wait` / 启动轮询期间，如果事件循环里只有
    // 一个 unref 的 timer，独立 Node 脚本会直接判定"没有 pending work"并退出
    // （实测：`Warning: Detected unsettled top-level await` + 进程结束）。在 Host 里
    // 有 server handle 保活看不出来，但 qa 的脚本和任何 `node e2e.mjs` 都会挂。
    // 宁可让进程多活几秒，也不要 unref。
    setTimeout(resolve, Math.max(0, Number(durationMs) || 0));
  });
}
