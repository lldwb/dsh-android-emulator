/**
 * dsh-android-emulator — 模块级运行状态，**按会话分区**（v1.2.0）。
 *
 * ## 为什么需要分区
 *
 * DSH 的一个 Host 进程里可以同时开多个会话，而插件模块是**单实例**：v1.1 的
 * `let current` / `Map processes` / `lastPackage` 是全局的，于是两个会话会互相干扰
 * —— A 启动的设备会被 B 的 screenshot/tap 直接操作、A 装的包会被 B 的 `app_launch`
 * 默认启动、A 调 `emulator_stop` 会停掉 B 正在用的设备。
 *
 * 会话标识来自工具 `execute(args, exec)` 的 `exec.agent?.id`（dsh 的 `Agent` 接口即
 * `{ readonly id: SessionId }`）。没有 agent 上下文时（脚本直调、qa 单测）落到
 * `shared-default` 槽 —— 这也是 `perSession: false` 时全员共用的槽。
 *
 * ## 兼容性约束
 *
 * qa 的旧测试与 v1.1 的调用形式是 `getCurrent()` / `setCurrent(patch)` /
 * `rememberPackage(pkg)`（单参）。所以这里的所有读写函数都做了**重载兼容**：
 * 少传 key 时退回 `shared-default` 槽，`setCurrent(对象)` 仍被当作 patch 处理。
 *
 * 进程表仍按 serial 索引（一台设备的 pid/日志是唯一的），但每条记录带 `sessionKey`
 * 用于归属判定：这是"显式传别人 serial → DEVICE_BUSY"守卫与 `instances` 展示的数据源。
 */

/** 无会话上下文 / `perSession:false` 时使用的共享槽。 */
export const DEFAULT_SESSION_KEY = 'shared-default';

/** @type {Map<string, { current: object|null, lastPackage: string }>} */
const sessions = new Map();

/** @type {Map<string, { serial: string, pid: number, avd: string, logFile: string, startedAt: number, sessionKey: string }>} */
const processes = new Map();

/** 归一化会话 key（空/非字符串 → 共享槽）。 */
function normalizeKey(key) {
  if (typeof key === 'string' && key.trim() !== '') return key.trim();
  return DEFAULT_SESSION_KEY;
}

/** 取（必要时创建）一个会话的状态桶。 */
function bucket(key) {
  const normalized = normalizeKey(key);
  let entry = sessions.get(normalized);
  if (entry === undefined) {
    entry = { current: null, lastPackage: '' };
    sessions.set(normalized, entry);
  }
  return entry;
}

/**
 * 从工具执行上下文取会话 key。
 *
 * @param {{ agent?: { id?: string } } | null | undefined} exec 工具 `execute(args, exec)` 的第二参。
 * @param {boolean} [perSession] `false` 时所有会话统一映射到共享槽（v1.1 行为）。
 * @returns {string}
 */
export function sessionKeyOf(exec, perSession = true) {
  if (perSession === false) return DEFAULT_SESSION_KEY;
  const id = exec?.agent?.id;
  const value = typeof id === 'string' ? id.trim() : '';
  return value === '' ? DEFAULT_SESSION_KEY : value;
}

/** 8 位十六进制哈希（sessionShort 全为下划线时的兜底）。 */
function hash8(value) {
  let hash = 5381;
  const text = String(value ?? '');
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 会话 id 里不携带身份信息的通用词（剥掉它们才能拿到可辨识段）。 */
const GENERIC_SEGMENTS = new Set([
  'session',
  'sess',
  'agent',
  'chat',
  'conv',
  'conversation',
  'default',
  'shared',
  'dsh',
  'main',
  'root',
]);

/**
 * 从一个会话 key 里取「可辨识段」（≤8 字符、只含 `[A-Za-z0-9]`）。
 *
 * 真实 dsh 的 SessionId 形如 `session-9e1ca070-4acb-4bdf-9bab-786b32ce91e8`：
 * 直接截前 8 字符只会得到通用前缀 `session-`，**所有会话都撞成同一个值**，
 * 会话专属 AVD 名不再唯一（多会话隔离失效）。所以先按分隔符切段、剥掉通用词，
 * 取第一个有内容的段。
 *
 * @param {string} key 会话 key。
 * @returns {string} 可辨识段；没有可用段时返回空串（交给哈希兜底）。
 */
function informativeSegment(key) {
  const segments = String(key ?? '')
    .split(/[^A-Za-z0-9]+/u)
    .filter((segment) => segment !== '');
  const meaningful = segments.filter((segment) => !GENERIC_SEGMENTS.has(segment.toLowerCase()));
  if (meaningful.length === 0) return '';
  for (const segment of meaningful) {
    const candidate = segment.slice(0, 8);
    if (/[A-Za-z0-9]/.test(candidate)) return candidate;
  }
  return '';
}

/**
 * 会话 key → AVD 名后缀（8 字符，只用 `[A-Za-z0-9_-]`）。
 *
 * 清洗后必须**非空且含字母/数字**（否则 AVD 名会变成一串下划线，或与别人的撞车），
 * 兜底用 8 位哈希。这样 `<prefix>--<short>` 永远是合法的 AVD 名片段。
 *
 * 2026-10-26 修：截断点正好落在分隔符上时（`session-<uuid>` 的前 8 字符就是
 * `session-`），改用可辨识段。否则所有 dsh 会话会得到同一个 AVD 名，
 * 「一个会话一台模拟器」反而变成「所有会话抢同一台」。
 *
 * @param {string} key 会话 key。
 * @returns {string}
 */
export function sessionShort(key) {
  const text = String(key ?? '');
  const cleanedFull = text.replace(/[^A-Za-z0-9_-]/g, '_');
  const cleaned = cleanedFull.slice(0, 8);
  // 只有「被截断、且截断点落在分隔符上」才说明 short 里没有身份信息；
  // 短 key（≤8）或截断在字母数字上时，旧行为本身可辨识，保持原样。
  const cutOnSeparator = cleanedFull.length > 8 && /[-_]$/.test(cleaned);
  if (cutOnSeparator) {
    const informative = informativeSegment(text);
    if (informative !== '') return informative;
  } else if (/[A-Za-z0-9]/.test(cleaned)) {
    return cleaned;
  }
  return hash8(key);
}

/**
 * 会话专属 AVD 名：`<基础名>--<sessionShort>`。
 *
 * @param {string} base AVD 基础名（`avdNamePrefix || avdName`）。
 * @param {string} key 会话 key。
 */
export function sessionAvdName(base, key) {
  return `${String(base ?? '').trim() || 'dsh_android'}--${sessionShort(key)}`;
}

/** 判断一个 AVD 名是否是本插件会话专属（`<base>--*`）。 */
export function isSessionAvdName(name, base) {
  const prefix = `${String(base ?? '').trim() || 'dsh_android'}--`;
  return typeof name === 'string' && name.startsWith(prefix) && name.length > prefix.length;
}

/**
 * 会话 key 的展示形式：短 key 原样，长 key（生产环境是 UUID）截前 8 字符 + `…`。
 *
 * DESIGN §7.2 要求 `instances[].sessionKey` **不要泄露完整 sessionKey**；但
 * `shared-default` 与脚本/测试用的短 id（如 `sess-A`）本身就是公开/可辨识的，
 * 直接显示反而更好排查，所以 ≤12 字符时原样返回。
 *
 * @param {string} key 会话 key。
 * @param {number} [max] 长 key 保留的字符数（默认 8）。
 */
export function shortSessionKey(key, max = 8) {
  const text = String(key ?? '');
  // 共享槽是公开哨兵值（不是敏感 id），必须原样返回，否则用户在 instances 里认不出它。
  if (text === DEFAULT_SESSION_KEY) return text;
  if (text.length <= 12) return text;
  return `${text.slice(0, max)}…`;
}

/* ------------------------------------------------------------------ *
 * 当前设备（按会话）
 * ------------------------------------------------------------------ */

/** 当前设备记录的完整空值形状（结果构造器也用它）。 */
export function emptyDevice() {
  return { serial: '', avd: '', pid: 0, logFile: '', startedAt: 0 };
}

/**
 * 读某会话的当前设备（无则 null）。
 *
 * @param {string} [key] 会话 key；省略 = 共享槽（v1.1 兼容）。
 */
export function getCurrent(key) {
  const current = bucket(key).current;
  return current === null ? null : { ...current };
}

/** 把 patch 合并进某会话的 current。 */
function applyCurrent(key, patch) {
  const entry = bucket(key);
  if (patch === null || patch === undefined) {
    entry.current = null;
    return;
  }
  entry.current = { ...(entry.current ?? emptyDevice()), ...patch };
}

/**
 * 设置某会话的当前设备；会合并已有字段（只更新 serial 时保留 pid/logFile）。
 *
 * 兼容两种调用：`setCurrent(patch)`（v1.1，落到共享槽）与 `setCurrent(key, patch)`。
 */
export function setCurrent(keyOrPatch, patch) {
  if (patch === undefined) {
    applyCurrent(DEFAULT_SESSION_KEY, keyOrPatch);
    return;
  }
  applyCurrent(keyOrPatch, patch);
}

/** 清空某会话的当前设备（设备消失 / 被停止时调用）。 */
export function clearCurrent(key) {
  bucket(key).current = null;
}

/* ------------------------------------------------------------------ *
 * 最近安装的包（按会话）
 * ------------------------------------------------------------------ */

/**
 * 记录某会话最近安装的包名。
 *
 * 兼容两种调用：`rememberPackage(pkg)`（v1.1）与 `rememberPackage(key, pkg)`。
 */
export function rememberPackage(keyOrPackage, packageName) {
  if (packageName === undefined) {
    bucket(DEFAULT_SESSION_KEY).lastPackage = typeof keyOrPackage === 'string' ? keyOrPackage : '';
    return;
  }
  bucket(keyOrPackage).lastPackage = typeof packageName === 'string' ? packageName : '';
}

/** 某会话最近安装的包名（空串表示未知）。 */
export function getLastPackage(key) {
  return bucket(key).lastPackage;
}

/* ------------------------------------------------------------------ *
 * 模拟器进程表（按 serial，带 sessionKey 归属）
 * ------------------------------------------------------------------ */

/** 某个 serial 对应的模拟器进程记录。 */
export function getProcess(serial) {
  const record = processes.get(String(serial));
  return record === undefined ? null : { ...record };
}

/** 记录一次模拟器启动（serial → pid/avd/日志/sessionKey）。 */
export function setProcess(serial, info) {
  if (typeof serial !== 'string' || serial === '') return;
  processes.set(serial, { sessionKey: DEFAULT_SESSION_KEY, ...info, serial });
}

/** 删除某台设备的进程记录（停止后调用）。 */
export function deleteProcess(serial) {
  processes.delete(String(serial));
}

/** 当前记录的所有模拟器进程（全部会话）。 */
export function listProcesses() {
  return [...processes.values()].map((record) => ({ ...record }));
}

/** 某会话名下的模拟器进程。 */
export function listProcessesBySession(key) {
  const normalized = normalizeKey(key);
  return [...processes.values()]
    .filter((record) => record.sessionKey === normalized)
    .map((record) => ({ ...record }));
}

/**
 * 某个 serial 的归属会话 key（无记录返回空串）。
 *
 * 这是"显式传别人 serial → DEVICE_BUSY"守卫的唯一数据源。
 */
export function processOwner(serial) {
  const record = processes.get(String(serial));
  if (record === undefined) return '';
  return typeof record.sessionKey === 'string' ? record.sessionKey : '';
}

/** 重置全部状态（测试用；生产代码不应调用）。 */
export function resetState() {
  sessions.clear();
  processes.clear();
}
