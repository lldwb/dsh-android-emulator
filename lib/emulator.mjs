/**
 * dsh-android-emulator — 模拟器进程管理（启动 / 停止 / 日志）。
 *
 * ## 为什么是 detached + 日志文件
 *
 * `emulator` 是长驻进程，启动后要活到 agent 后续几十次工具调用之后。所以：
 *
 * - `spawn(..., { detached: true })` + `unref()`：父进程（Host）退出/重启不会连带
 *   杀掉模拟器；反过来说，Host 进程不会因为模拟器没退出而被拖住。
 * - `stdio: ['ignore', fd, fd]`：stdout/stderr 直接写日志文件。**不能**用 pipe——
 *   没人读的 pipe 会在缓冲区满后阻塞模拟器。
 * - `windowsHide: true`：headless 时不要弹控制台窗口。
 *
 * ## 为什么停止要"优雅 + 兜底"
 *
 * `adb -s <serial> emu kill` 是最干净的（模拟器自己关机会 flush 状态），但它在
 * 设备还没连上 adb、或 adb server 卡住时无效。所以先 `emu kill` 轮询，再对照
 * 启动时记录的 pid 杀进程树（Windows 用 `taskkill /T /F`，否则
 * `qemu-system-*` 子进程会变孤儿继续吃 CPU）。
 *
 * ## 为什么 spawn 后要 `getError()`
 *
 * `spawn` 的 ENOENT/EPERM 是**异步 error 事件**；返回值里拿不到。这里把 error
 * 存进闭包，由调用方在轮询设备时顺便检查——否则会出现"进程明明没起来，却一直
 * 等到 boot 超时"的 4 分钟空等。
 */

import { spawn } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

import { run } from './exec.mjs';
import { toolError } from './schema.mjs';

/**
 * 构造 `emulator` 的 argv（DESIGN §7 的固定参数 + 可选项）。
 *
 * @param {{ avd: string, headless?: boolean, cold?: boolean, port?: number, extraArgs?: string[] }} options
 * @returns {string[]}
 */
export function emulatorArgs(options) {
  const args = ['-avd', String(options.avd)];
  // headless 默认 true；显式 false 才开窗口（用户手动调试时有用）。
  if (options.headless !== false) args.push('-no-window');
  args.push('-no-audio', '-no-boot-anim', '-gpu', 'swiftshader_indirect', '-no-snapshot-save');
  if (options.cold === true) args.push('-no-snapshot');
  if (Number.isInteger(options.port) && options.port > 0) args.push('-port', String(options.port));
  for (const extra of Array.isArray(options.extraArgs) ? options.extraArgs : []) {
    if (typeof extra === 'string' && extra !== '') args.push(extra);
  }
  return args;
}

/**
 * 启动模拟器进程（不等待启动完成——那是调用方轮询的事）。
 *
 * @param {{ emulator: string, avd: string, logFile: string, headless?: boolean, cold?: boolean, port?: number, extraArgs?: string[] }} options
 * @returns {Promise<{ pid: number, args: string[], logFile: string, getError: () => object|null }>}
 */
export async function startEmulator(options) {
  const emulator = typeof options.emulator === 'string' ? options.emulator : '';
  if (emulator === '') throw toolError('NO_EMULATOR', '没有 emulator 可执行文件，无法启动模拟器。');
  const logFile = typeof options.logFile === 'string' ? options.logFile : '';
  if (logFile === '') throw toolError('EMULATOR_START_FAILED', '内部错误：启动模拟器时没有给日志文件路径。');

  await mkdir(path.dirname(logFile), { recursive: true });
  const args = emulatorArgs(options);

  let handle;
  try {
    handle = await open(logFile, 'a');
  } catch (error) {
    throw toolError('EMULATOR_START_FAILED', `无法打开模拟器日志文件 ${logFile}（${error?.message ?? String(error)}）。检查 outputDir 是否可写。`);
  }

  /** @type {object|null} */
  let spawnError = null;
  try {
    const child = spawn(emulator, args, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', handle.fd, handle.fd],
    });
    // ENOENT / EPERM 走异步 error 事件；不接住会变成未捕获异常。
    child.on('error', (error) => {
      spawnError = { code: error?.code ?? 'UNKNOWN', message: error?.message ?? String(error) };
    });
    child.unref();
    if (typeof child.pid !== 'number' || child.pid <= 0) {
      throw toolError('EMULATOR_START_FAILED', `启动 emulator 失败（没有拿到 pid）：${spawnError === null ? '未知原因' : spawnError.message}`);
    }
    return { pid: child.pid, args, logFile, getError: () => spawnError };
  } finally {
    // 子进程已经 dup 了 fd，父进程的句柄可以关。
    await handle.close();
  }
}

/** 进程是否还活着（Windows 上 taskkill / POSIX 上 kill -0）。 */
export function isAlive(pid) {
  const number = Number(pid);
  if (!Number.isInteger(number) || number <= 0) return false;
  try {
    process.kill(number, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但没权限发信号（也算活着）；ESRCH = 不存在。
    return error?.code === 'EPERM';
  }
}

/** 杀整个进程树（Windows 需要 /T，否则 qemu 子进程会变孤儿）。 */
async function killTree(pid) {
  const number = Number(pid);
  if (!Number.isInteger(number) || number <= 0) return false;
  if (!isAlive(number)) return false;
  if (process.platform === 'win32') {
    await run('taskkill', ['/PID', String(number), '/T', '/F'], { timeoutMs: 20000 });
  } else {
    try {
      process.kill(number, 'SIGTERM');
    } catch {
      // 已退出。
    }
    // 给 3 秒优雅退出，再 SIGKILL。
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && isAlive(number)) {
      // 不 unref：这是"等进程退出"的循环，进程不退出时事件循环必须有人保活。
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
    }
    if (isAlive(number)) {
      try {
        process.kill(number, 'SIGKILL');
      } catch {
        // 已退出。
      }
    }
  }
  return !isAlive(number);
}

/** 轮询直到某台设备从 `adb devices` 里消失。 */
async function waitForDeviceGone(adb, serial, timeoutMs) {
  const interval = 1000;
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 0);
  // 惰性 import 避免和 adb.mjs 形成模块环（adb.mjs 不 import 本模块，但保持单向更稳）。
  const { adbDevices } = await import('./adb.mjs');
  while (Date.now() < deadline) {
    try {
      const devices = await adbDevices(adb);
      if (!devices.some((device) => device.serial === serial)) return true;
    } catch {
      // adb 暂时不可用（模拟器正在关机时常见），继续等。
    }
    // 不 unref：等待设备消失可能持续数十秒，事件循环必须靠这个 timer 保活。
    await new Promise((resolve) => {
      setTimeout(resolve, interval);
    });
  }
  try {
    const devices = await adbDevices(adb);
    return !devices.some((device) => device.serial === serial);
  } catch {
    return false;
  }
}

/**
 * 停止模拟器：先 `adb emu kill`，超时后再杀记录下来的进程树。
 *
 * @param {{ adb: string, serial?: string, pid?: number, timeoutMs?: number }} options
 * @returns {Promise<{ stopped: boolean, forced: boolean, detail: string }>}
 */
export async function stopEmulator(options) {
  const adb = typeof options?.adb === 'string' ? options.adb : '';
  const serial = typeof options?.serial === 'string' ? options.serial.trim() : '';
  const pid = Number(options?.pid) > 0 ? Number(options.pid) : 0;
  const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000;

  const notes = [];
  let forced = false;

  if (serial !== '' && adb !== '') {
    const kill = await run(adb, ['-s', serial, 'emu', 'kill'], { timeoutMs: 15000 });
    if (kill.error !== undefined) {
      notes.push(`adb emu kill 失败（${kill.error.code}）`);
    } else {
      notes.push(`已发送 adb emu kill（退出码 ${String(kill.code)}）`);
      if (await waitForDeviceGone(adb, serial, timeoutMs)) {
        return { stopped: true, forced: false, detail: `${notes.join('；')}，设备已从 adb devices 消失` };
      }
      notes.push('设备在等待期内没有消失');
    }
  }

  if (pid > 0) {
    const killed = await killTree(pid);
    forced = killed;
    notes.push(`已${killed ? '终止' : '尝试终止'}模拟器进程 ${pid}${killed ? '' : '（进程可能已经退出）'}`);
    if (serial !== '' && adb !== '' && (await waitForDeviceGone(adb, serial, Math.min(timeoutMs, 15000)))) {
      return { stopped: true, forced: true, detail: notes.join('；') };
    }
    if (serial === '') return { stopped: !isAlive(pid), forced, detail: notes.join('；') };
  }

  if (serial !== '' && adb !== '') {
    const gone = await waitForDeviceGone(adb, serial, 5000);
    return { stopped: gone, forced, detail: gone ? `${notes.join('；')}，设备已消失` : notes.join('；') };
  }

  return { stopped: true, forced, detail: notes.length === 0 ? '没有可停止的目标（既没有 serial 也没有 pid）' : notes.join('；') };
}

/**
 * 读模拟器日志尾部（启动失败/超时时把它塞进 message，省得用户自己去翻文件）。
 *
 * @param {string} logFile 日志路径。
 * @param {number} [maxBytes] 最多读多少（默认 4000）。
 * @returns {Promise<string>}
 */
export async function readLogTail(logFile, maxBytes = 4000) {
  if (typeof logFile !== 'string' || logFile === '') return '';
  try {
    const content = await readFile(logFile, 'utf8');
    if (content === '') return '';
    return content.length <= maxBytes ? content : content.slice(content.length - maxBytes);
  } catch {
    return '';
  }
}
