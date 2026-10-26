/**
 * dsh-android-emulator — adb 封装。
 *
 * 这一层的职责只有一个：**把 adb 的"字符串输出协议"翻译成数据**，并把失败翻译成
 * DESIGN §4 的机器可读错误码。所有函数都在失败时 `throw toolError(code, …)`
 * （带中文可执行建议），由工具层统一 catch 成 `ok:false` 结果——工具层不需要
 * 再判断 `code !== 0` 这类细节。
 *
 * ## 几个真实的 adb 坑
 *
 * - **`adb devices` 含头行**：`List of devices attached` 必须先跳过，否则会解析出
 *   一个叫 "List" 的假设备。
 * - **`unauthorized` / `offline` 也是"设备存在"**：这时不能报 DEVICE_NOT_RUNNING，
 *   否则用户按提示去启动模拟器只会启动第二台；要报 DEVICE_BUSY 并让用户去主机上
 *   确认授权。
 * - **截图必须用 `exec-out`**：`adb shell screencap -p` 会经过设备端 pty，`\n` 被
 *   换成 `\r\n`，PNG 永久损坏；`exec-out` 是原始管道。而且必须按 **Buffer** 收，
 *   一次 utf8 解码就毁了。
 * - **`uiautomator dump` 会失败**：界面正在动画/弹窗时常报
 *   `ERROR: could not get idle state`，这是常态而不是异常，要给出"等界面稳定再试"
 *   的建议而不是让 agent 卡住。
 */

import * as state from './state.mjs';
import { run, runBuffer } from './exec.mjs';
import { toolError } from './schema.mjs';

/** 一般的 adb 命令超时。 */
const SHORT_TIMEOUT_MS = 20000;

/** 模拟器 / 安装这类慢命令超时。 */
const LONG_TIMEOUT_MS = 180000;

/** 把 `run`/`runBuffer` 的失败翻译成 DESIGN 错误（无失败返回 null）。 */
function failureOf(result, fallbackCode) {
  if (result === null || typeof result !== 'object') return toolError(fallbackCode, 'adb 没有返回结果。');
  if (result.error !== undefined) {
    const code = String(result.error.code ?? '');
    if (code === 'ENOENT') {
      return toolError('NO_ADB', '找不到 adb 可执行文件（ENOENT）。请安装 Android SDK Platform-Tools，或用 config.adbPath 指定 adb.exe 的绝对路径。');
    }
    if (code === 'EPERM' || code === 'EACCES') {
      return toolError('SPAWN_DENIED', `启动 adb 被拒绝（${code}）：当前会话权限不足。把会话切到 danger-full-access 后重试。`);
    }
    return toolError(fallbackCode, `adb 启动失败（${code}）：${result.error.message}`);
  }
  if (result.timedOut === true) {
    return toolError('TIMEOUT', 'adb 命令超时，已终止。设备可能卡住，稍后重试；装大 APK 时可以放宽超时。');
  }
  return null;
}

/** adb 的输出摘要（message 里用）。 */
function summarize(result, max = 400) {
  const merged = `${String(result?.stdout ?? '')}\n${String(result?.stderr ?? '')}`.trim();
  if (merged === '') return '';
  return merged.length <= max ? merged : `${merged.slice(0, max)}…`;
}

/**
 * `adb devices` → [{ serial, state }]。
 *
 * @param {string} adb adb 路径。
 * @returns {Promise<Array<{ serial: string, state: string }>>}
 */
export async function adbDevices(adb) {
  const result = await run(adb, ['devices'], { timeoutMs: SHORT_TIMEOUT_MS });
  const failure = failureOf(result, 'ADB_FAILED');
  if (failure !== null) throw failure;
  if (result.code !== 0) {
    throw toolError('ADB_FAILED', `adb devices 失败（退出码 ${String(result.code)}）：${summarize(result)}`);
  }
  const devices = [];
  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('List of devices') || trimmed.startsWith('*')) continue;
    const match = /^(\S+)\s+(\S+)/.exec(trimmed);
    if (match === null) continue;
    devices.push({ serial: match[1], state: match[2] });
  }
  return devices;
}

/** 列出可选设备的一句话描述（错误消息里用）。 */
function describeDevices(devices) {
  if (devices.length === 0) return '当前 adb 没有任何设备。';
  return `当前设备：${devices.map((device) => `${device.serial}(${device.state})`).join('、')}。`;
}

/**
 * 解析要操作哪一台设备（**按会话隔离**，v1.2.0）。
 *
 * 规则（DESIGN §7.2）：
 * - 显式 `wanted` 属于**别的会话** → 抛 `DEVICE_BUSY`，绝不静默操作别人的设备；
 * - 显式 `wanted` 存在但状态不是 `device` → `DEVICE_BUSY`（offline/unauthorized）；
 * - 省略 `wanted` 时**只用本会话自己的设备**（current → 本会话进程记录），
 *   `perSession:true` 下绝不自动挑别的会话/外部的设备；
 * - `perSession:false` 退回 v1.1 行为（共享槽 + 唯一可用设备）。
 *
 * @param {string} adb adb 路径。
 * @param {string} [wanted] 显式 serial。
 * @param {{ sessionKey?: string, perSession?: boolean }} [options] 会话上下文。
 * @returns {Promise<string>} 实际使用的 serial。
 */
export async function resolveSerial(adb, wanted, options = {}) {
  const sessionKey =
    typeof options?.sessionKey === 'string' && options.sessionKey.trim() !== ''
      ? options.sessionKey.trim()
      : state.DEFAULT_SESSION_KEY;
  const perSession = options?.perSession !== false;
  const devices = await adbDevices(adb);
  const usable = devices.filter((device) => device.state === 'device');
  const explicit = typeof wanted === 'string' ? wanted.trim() : '';

  if (explicit !== '') {
    const found = devices.find((device) => device.serial === explicit);
    // 归属守卫：显式 serial 已经登记在别的会话名下 → 明确拒绝（不静默操作）。
    const owner = state.processOwner(explicit);
    if (perSession && owner !== '' && owner !== sessionKey && found !== undefined) {
      throw toolError(
        'DEVICE_BUSY',
        `设备 ${explicit} 属于另一个会话（${state.shortSessionKey(owner)}），不能跨会话操作。下一步：不要传这个 serial——省略 serial 就会用本会话自己的设备；或用 android_status 查看各会话的 instances。`,
      );
    }
    if (found === undefined) {
      throw toolError(
        'DEVICE_NOT_RUNNING',
        `设备 ${explicit} 不在 adb devices 里。${describeDevices(devices)}先调用 android_status 看看，或用 android_emulator_start 启动一台。`,
      );
    }
    if (found.state !== 'device') {
      throw toolError(
        'DEVICE_BUSY',
        `设备 ${explicit} 当前状态是 ${found.state}（offline / unauthorized 需要先在主机上确认 USB 调试授权，或等它变成 device）。`,
      );
    }
    state.setCurrent(sessionKey, { ...(state.getCurrent(sessionKey) ?? state.emptyDevice()), serial: found.serial });
    return found.serial;
  }

  // —— 省略 serial：只看本会话自己的设备 ——
  const current = state.getCurrent(sessionKey);
  const currentSerial = typeof current?.serial === 'string' ? current.serial : '';
  if (currentSerial !== '') {
    const found = devices.find((device) => device.serial === currentSerial);
    if (found !== undefined && found.state === 'device') return found.serial;
    state.clearCurrent(sessionKey);
  }

  // 本会话名下、当前在线的设备（进程表是归属的权威来源）。
  const ownOnline = state
    .listProcessesBySession(sessionKey)
    .map((record) => record.serial)
    .filter((serial) => usable.some((device) => device.serial === serial));

  if (ownOnline.length === 1) {
    state.setCurrent(sessionKey, { ...(state.getCurrent(sessionKey) ?? state.emptyDevice()), serial: ownOnline[0] });
    return ownOnline[0];
  }
  if (ownOnline.length > 1) {
    throw toolError(
      'MULTIPLE_DEVICES',
      `本会话名下有 ${ownOnline.length} 台设备在线（${ownOnline.join('、')}）：请用 serial 参数指定一台。`,
    );
  }

  if (!perSession) {
    // v1.1 兼容：共享槽允许挑"唯一可用设备"。
    if (usable.length === 0) {
      throw toolError(
        'DEVICE_NOT_RUNNING',
        `${devices.length === 0 ? '还没有运行中的设备' : `没有可用设备（${devices.map((device) => `${device.serial}=${device.state}`).join('、')}）`}。请先调用 android_emulator_start 启动一台模拟器（或 android_status 查看 SDK/AVD 状态）。`,
      );
    }
    if (usable.length > 1) {
      throw toolError(
        'MULTIPLE_DEVICES',
        `同时有 ${usable.length} 台设备在运行（${usable.map((device) => device.serial).join('、')}），请用 serial 参数指定一台；或用 android_emulator_stop 的 all 参数先全部停掉。`,
      );
    }
    state.setCurrent(sessionKey, { ...(state.getCurrent(sessionKey) ?? state.emptyDevice()), serial: usable[0].serial });
    return usable[0].serial;
  }

  // perSession 且本会话没有设备：不碰别人的设备，直接告诉 agent 去启动自己的。
  const others = state.listProcesses().filter((record) => record.sessionKey !== sessionKey);
  const otherHint =
    others.length === 0
      ? ''
      : ` 注意：当前另有 ${others.length} 台设备属于其它会话（${others
          .map((record) => `${record.serial}@${state.shortSessionKey(record.sessionKey)}`)
          .join('、')}），本会话不会操作它们。`;
  throw toolError(
    'DEVICE_NOT_RUNNING',
    `本会话还没有自己的模拟器。下一步：调用 android_emulator_start 启动一台（会为当前会话创建专属 AVD）。${otherHint}`,
  );
}

/**
 * 执行 `adb -s <serial> shell <argv…>`。
 *
 * 注意 argv 会经设备端 `sh` 解析（这是 adb 的固有行为），所以调用方要保证参数
 * 里没有会被 sh 展开的字符——文本输入在工具层已做过滤。
 *
 * @param {string} adb adb 路径。
 * @param {string} serial 设备。
 * @param {string[]} argv 传给设备端 `sh` 的参数。
 * @param {{ timeoutMs?: number, input?: string }} [opts]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean, error?: object }>}
 */
export async function adbShell(adb, serial, argv, opts = {}) {
  const args = ['-s', serial, 'shell', ...argv.map((entry) => String(entry))];
  const result = await run(adb, args, {
    timeoutMs: opts.timeoutMs ?? SHORT_TIMEOUT_MS,
    ...(opts.input === undefined ? {} : { input: opts.input }),
  });
  const failure = failureOf(result, 'ADB_FAILED');
  if (failure !== null) throw failure;
  return result;
}

/** 读一个系统属性（设备侧 getprop）。 */
export async function getProp(adb, serial, name) {
  const result = await adbShell(adb, serial, ['getprop', name], { timeoutMs: SHORT_TIMEOUT_MS });
  return String(result.stdout ?? '').trim();
}

/** 设备是否已经启动完成（`sys.boot_completed` == 1）。 */
export async function isBooted(adb, serial) {
  try {
    return (await getProp(adb, serial, 'sys.boot_completed')) === '1';
  } catch {
    return false;
  }
}

/**
 * 轮询等待设备启动完成。
 *
 * @param {string} adb adb 路径。
 * @param {string} serial 设备。
 * @param {number} timeoutMs 最长等多久。
 * @param {{ intervalMs?: number }} [opts]
 * @returns {Promise<boolean>} 启动完成返回 true；超时返回 false（不抛）。
 */
export async function waitForBoot(adb, serial, timeoutMs, opts = {}) {
  const interval = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0 ? opts.intervalMs : 2000;
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    if (await isBooted(adb, serial)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    // 不 unref：冷启动要轮询几十秒，独立 Node 进程必须靠这个 timer 保活。
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(interval, remaining));
    });
  }
  return false;
}

/**
 * 安装 APK。
 *
 * `-r` 覆盖安装，`-g` 授予全部运行时权限（DEBUG 应用常用，避免首次启动弹权限框
 * 挡住界面操作）。
 *
 * @param {string} adb adb 路径。
 * @param {string} serial 设备。
 * @param {string} apkPath APK 绝对路径。
 * @param {{ grant?: boolean, reinstall?: boolean, timeoutMs?: number }} [options]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean, error?: object }>}
 */
export async function installApk(adb, serial, apkPath, options = {}) {
  const args = ['-s', serial, 'install'];
  if (options.reinstall !== false) args.push('-r');
  if (options.grant !== false) args.push('-g');
  args.push(apkPath);
  const result = await run(adb, args, { timeoutMs: options.timeoutMs ?? LONG_TIMEOUT_MS });
  const failure = failureOf(result, 'INSTALL_FAILED');
  if (failure !== null) throw failure;
  return result;
}

/** 解析 `cmd package resolve-activity --brief <pkg>` 的输出（最后一行的 `pkg/Activity`）。 */
function parseResolvedComponent(stdout) {
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('priority=') && !line.startsWith('No activity'));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].includes('/')) return lines[index];
  }
  return '';
}

/**
 * 把用户给的 activity 归一成 `包名/Activity` 形态（DESIGN 允许只给短类名）。
 *
 * @param {string} pkg 包名。
 * @param {string} activity 用户输入（可为空 / `.MainActivity` / `com.x.MainActivity` / `com.x/.Main`）。
 */
export function normalizeComponent(pkg, activity) {
  const trimmed = typeof activity === 'string' ? activity.trim() : '';
  if (trimmed === '') return '';
  if (trimmed.includes('/')) {
    const [left, right] = trimmed.split('/', 2);
    if (left.includes('.')) return `${left}/${right}`;
    return `${pkg}/${right.startsWith('.') ? right : `.${right}`}`;
  }
  if (trimmed.startsWith('.')) return `${pkg}/${trimmed}`;
  if (trimmed.includes('.')) return `${pkg}/${trimmed}`;
  return `${pkg}/.${trimmed}`;
}

/** 读进程 pid（`pidof`，退到 `ps -A`）。 */
async function processId(adb, serial, pkg) {
  try {
    const result = await adbShell(adb, serial, ['pidof', pkg], { timeoutMs: SHORT_TIMEOUT_MS });
    const trimmed = String(result.stdout ?? '').trim();
    if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  } catch {
    // pidof 在老系统上不存在，继续兜底。
  }
  try {
    const result = await adbShell(adb, serial, ['ps', '-A'], { timeoutMs: SHORT_TIMEOUT_MS });
    for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
      if (!line.includes(pkg)) continue;
      const match = /^\S+\s+(\d+)\s+/.exec(line.trim());
      if (match !== null) return Number.parseInt(match[1], 10);
    }
  } catch {
    // 忽略：拿不到 pid 不影响"已启动"的结论。
  }
  return 0;
}

/**
 * 启动应用（`am start -W`），返回 pid。
 *
 * 没给 activity 时先 `cmd package resolve-activity --brief` 解析默认 LAUNCHER 组件
 * （比 monkey 稳，也不会在有些 ROM 上弹 monkey 的反感提示）。
 *
 * @param {string} adb adb 路径。
 * @param {string} serial 设备。
 * @param {string} pkg 包名。
 * @param {string} [activity] 可选的 Activity。
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, component: string, pid: number, timedOut: boolean, error?: object }>}
 */
export async function launchApp(adb, serial, pkg, activity) {
  let component = normalizeComponent(pkg, activity);
  let resolveOutput = '';
  if (component === '') {
    const resolved = await adbShell(adb, serial, ['cmd', 'package', 'resolve-activity', '--brief', pkg], { timeoutMs: SHORT_TIMEOUT_MS });
    resolveOutput = String(resolved.stdout ?? '');
    const parsed = parseResolvedComponent(resolveOutput);
    component = parsed;
    if (component === '') {
      return { code: 1, stdout: resolveOutput, stderr: `无法解析 ${pkg} 的启动 Activity（应用可能没装，或没有 LAUNCHER intent）。`, component: '', pid: 0, timedOut: false };
    }
  }
  const result = await adbShell(adb, serial, ['am', 'start', '-W', '-n', component], { timeoutMs: 60000 });
  const failure = failureOf(result, 'LAUNCH_FAILED');
  if (failure !== null) throw failure;
  const output = `${result.stdout}\n${result.stderr}`;
  let pid = 0;
  if (/^\s*(Starting|Status: ok)/m.test(output) || !/Error/i.test(output)) {
    pid = await processId(adb, serial, pkg);
  }
  return { code: result.code, stdout: output, stderr: '', component, pid, timedOut: result.timedOut === true };
}

/** 强制停止应用（`am force-stop`）。 */
export async function forceStopApp(adb, serial, pkg) {
  const result = await adbShell(adb, serial, ['am', 'force-stop', pkg], { timeoutMs: SHORT_TIMEOUT_MS });
  return result;
}

/**
 * 截图，返回 PNG 的原始字节。
 *
 * 必须是 `exec-out`（原始管道）而且按 Buffer 收——见文件头注释。
 *
 * @param {string} adb adb 路径。
 * @param {string} serial 设备。
 * @returns {Promise<Buffer>}
 */
export async function screencap(adb, serial) {
  const result = await runBuffer(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], { timeoutMs: 60000 });
  const failure = failureOf(result, 'ADB_FAILED');
  if (failure !== null) throw failure;
  if (result.code !== 0 && result.stdout.length === 0) {
    throw toolError('ADB_FAILED', `截图失败（退出码 ${String(result.code)}）：${summarize(result)}`);
  }
  return result.stdout;
}

/**
 * dump 当前的 UI 树，返回 XML 文本。
 *
 * 两步：`shell uiautomator dump /sdcard/window_dump.xml` → `exec-out cat`。
 * 第二步用 `exec-out` 避免 CRLF 污染（文本无所谓，但保持一致更省心）。
 *
 * @param {string} adb adb 路径。
 * @param {string} serial 设备。
 * @returns {Promise<string>}
 */
export async function dumpUi(adb, serial) {
  const remotePath = '/sdcard/window_dump.xml';
  const dump = await adbShell(adb, serial, ['uiautomator', 'dump', remotePath], { timeoutMs: 45000 });
  const combined = `${dump.stdout}\n${dump.stderr}`;
  if (!/dumped to/i.test(combined)) {
    const detail = combined.trim() === '' ? '没有任何输出' : combined.trim().slice(0, 400);
    throw toolError(
      'UI_DUMP_FAILED',
      `uiautomator dump 失败：${detail}。常见原因是界面正在动画/弹窗（等界面稳定后重试），或当前界面不允许 dump；先用 android_screenshot 看看屏幕。`,
    );
  }
  const cat = await runBuffer(adb, ['-s', serial, 'exec-out', 'cat', remotePath], { timeoutMs: 30000 });
  const failure = failureOf(cat, 'UI_DUMP_FAILED');
  if (failure !== null) throw failure;
  const xml = cat.stdout.toString('utf8');
  if (xml.trim() === '') throw toolError('UI_DUMP_FAILED', `${remotePath} 是空的：dump 没有产出内容，等界面稳定后重试，或先用 android_screenshot 看看屏幕。`);
  return xml;
}

/**
 * 读 logcat 尾部（`logcat -d -t <n>`）。
 *
 * @param {string} adb adb 路径。
 * @param {string} serial 设备。
 * @param {number} [lines] 行数。
 * @param {{ tag?: string }} [opts] 给了 tag 时用 `-s <tag>` 让设备侧先过滤。
 * @returns {Promise<string[]>}
 */
export async function logcat(adb, serial, lines = 200, opts = {}) {
  const count = Math.max(1, Math.min(Number(lines) || 200, 20000));
  const args = ['-s', serial, 'logcat', '-d', '-t', String(count)];
  if (typeof opts.tag === 'string' && opts.tag.trim() !== '') args.push('-s', opts.tag.trim());
  const result = await run(adb, args, { timeoutMs: 45000 });
  const failure = failureOf(result, 'ADB_FAILED');
  if (failure !== null) throw failure;
  if (result.code !== 0 && String(result.stdout ?? '').trim() === '') {
    throw toolError('ADB_FAILED', `读取 logcat 失败（退出码 ${String(result.code)}）：${summarize(result)}`);
  }
  return String(result.stdout ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
}

/** 取设备当前的分辨率（`wm size`）；拿不到返回 null。 */
export async function screenSize(adb, serial) {
  try {
    const result = await adbShell(adb, serial, ['wm', 'size'], { timeoutMs: SHORT_TIMEOUT_MS });
    const source = `${result.stdout}\n${result.stderr}`;
    const matches = [...source.matchAll(/(\d+)\s*x\s*(\d+)/g)];
    if (matches.length === 0) return null;
    const last = matches[matches.length - 1];
    return { width: Number.parseInt(last[1], 10), height: Number.parseInt(last[2], 10) };
  } catch {
    return null;
  }
}

/** 读设备的 AVD 名（模拟器才有；真机返回空串）。 */
export async function deviceAvdName(adb, serial) {
  for (const name of ['ro.kernel.qemu.avd_name', 'ro.boot.qemu.avd_name']) {
    try {
      const value = await getProp(adb, serial, name);
      if (value !== '') return value;
    } catch {
      // 忽略，换下一个属性。
    }
  }
  return '';
}
