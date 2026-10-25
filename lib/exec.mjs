/**
 * dsh-android-emulator — 子进程执行层。
 *
 * ## 铁律
 *
 * 1. **永不抛异常**。`spawn` 的失败在 Node 里分两种：参数类型错误是同步 `throw`，
 *    而 `ENOENT`（没这个程序）/ `EPERM`（被沙箱挡住）是**异步 `error` 事件**。
 *    后者如果不接住，就是未捕获的 EventEmitter error → 整个 Host 进程崩。
 *    所以这里统一归一成 `{ code, stdout, stderr, timedOut, error }`，调用方只看数据。
 * 2. **不经 shell**。一律 `spawn(file, argv)`，参数原样进 argv。这样路径带空格、
 *    参数带引号都不会被某层 shell 重新解析。唯一的例外是 Windows 的 `.bat` /
 *    `.cmd`（`avdmanager.bat` / `sdkmanager.bat`）：Node 在 Windows 上不能直接
 *    spawn 批处理文件，必须经 `cmd.exe /c`，见 `runScript()` —— 那里同样不做
 *    字符串拼接式 shell 调用，参数仍是 argv，由 `quoteForCmd()` 逐个引用。
 * 3. **超时必杀**。`timeoutMs` 到点就 `kill()` 并返回 `timedOut: true`，绝不
 *    留着子进程和挂起的 Promise（模拟器启动、APK 安装都可能卡很久）。
 *
 * `runBuffer()` 是给二进制输出（`exec-out screencap -p`）用的：stdout 收集为
 * Buffer，绝不按 utf8 解码——PNG 一旦过一遍 utf8 就永久损坏。
 */

import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

/** 默认超时：一般 adb 命令够用；慢命令（install / boot）由调用方覆盖。 */
export const DEFAULT_TIMEOUT_MS = 15000;

/** 把 Node 的 error 对象归一成结果里的 `error` 字段。 */
function normalizeError(error) {
  if (error === null || typeof error !== 'object') {
    return { code: 'UNKNOWN', message: String(error) };
  }
  return {
    code: typeof error.code === 'string' ? error.code : 'UNKNOWN',
    message: typeof error.message === 'string' ? error.message : String(error),
  };
}

/** 合并子进程环境变量：显式 env 覆盖当前进程环境。 */
function buildEnv(extraEnv) {
  if (extraEnv === null || typeof extraEnv !== 'object') return undefined;
  return { ...process.env, ...extraEnv };
}

/**
 * 运行一个程序，收集文本输出。
 *
 * @param {string} file 可执行文件（绝对路径最稳；相对名会走 PATH）。
 * @param {string[]} [args] argv（不经过任何 shell）。
 * @param {{ timeoutMs?: number, input?: string, env?: object, cwd?: string, windowsVerbatimArguments?: boolean }} [opts]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean, error?: { code: string, message: string } }>}
 */
export function run(file, args = [], opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, input, env, cwd } = opts ?? {};
  const argv = Array.isArray(args) ? args.map((entry) => String(entry)) : [];

  return new Promise((resolve) => {
    let settled = false;
    let timer;
    let child;
    const outChunks = [];
    const errChunks = [];

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        code: payload.code ?? null,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        timedOut: payload.timedOut === true,
        ...(payload.error === undefined ? {} : { error: payload.error }),
      });
    };

    try {
      child = spawn(file, argv, {
        cwd: cwd ?? undefined,
        env: buildEnv(env),
        windowsHide: true,
        windowsVerbatimArguments: opts.windowsVerbatimArguments === true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      // 同步抛：参数类型不对之类，仍然是"数据"而不是异常。
      finish({ code: null, timedOut: false, error: normalizeError(error) });
      return;
    }

    child.stdout?.on('data', (chunk) => outChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => errChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));

    // ENOENT / EACCES / EPERM 走这里。不监听 = 未捕获异常 = Host 进程崩。
    child.on('error', (error) => finish({ code: null, timedOut: false, error: normalizeError(error) }));
    child.on('close', (code) => finish({ code: typeof code === 'number' ? code : null, timedOut: false }));

    // 写 stdin 也可能 EPIPE（子进程提前退出），同样吞掉。
    if (child.stdin !== null && child.stdin !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input === undefined ? '' : String(input));
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 进程可能已经退出；忽略。
        }
        finish({ code: null, timedOut: true });
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
  });
}

/**
 * 运行一个程序，stdout 按二进制收集（截图专用）。
 *
 * @param {string} file 可执行文件。
 * @param {string[]} [args] argv。
 * @param {{ timeoutMs?: number, input?: string, env?: object, cwd?: string }} [opts]
 * @returns {Promise<{ code: number|null, stdout: Buffer, stderr: string, timedOut: boolean, error?: { code: string, message: string } }>}
 */
export function runBuffer(file, args = [], opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, input, env, cwd } = opts ?? {};
  const argv = Array.isArray(args) ? args.map((entry) => String(entry)) : [];

  return new Promise((resolve) => {
    let settled = false;
    let timer;
    let child;
    const outChunks = [];
    const errChunks = [];

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        code: payload.code ?? null,
        stdout: Buffer.concat(outChunks),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        timedOut: payload.timedOut === true,
        ...(payload.error === undefined ? {} : { error: payload.error }),
      });
    };

    try {
      child = spawn(file, argv, {
        cwd: cwd ?? undefined,
        env: buildEnv(env),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ code: null, timedOut: false, error: normalizeError(error) });
      return;
    }

    child.stdout?.on('data', (chunk) => outChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => errChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.on('error', (error) => finish({ code: null, timedOut: false, error: normalizeError(error) }));
    child.on('close', (code) => finish({ code: typeof code === 'number' ? code : null, timedOut: false }));

    if (child.stdin !== null && child.stdin !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input === undefined ? '' : String(input));
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 已退出。
        }
        finish({ code: null, timedOut: true });
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
  });
}

/** 判断一个路径是否是存在的文件。 */
async function isFile(candidate) {
  try {
    const info = await stat(candidate);
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * 在 PATH（和额外目录）里找一个程序。
 *
 * Windows 上给没有扩展名的名字补 `.exe` / `.bat` / `.cmd`——这很关键：
 * `avdmanager`、`sdkmanager` 在 Windows 上只有 `.bat`，不补扩展名永远找不到。
 *
 * @param {string} name 程序名或路径。
 * @param {{ extraDirs?: string[], exts?: string[], platform?: string }} [opts]
 * @returns {Promise<string|null>} 绝对路径，或 null。
 */
export async function which(name, opts = {}) {
  if (typeof name !== 'string' || name.trim() === '') return null;
  const trimmed = name.trim();
  const platform = typeof opts.platform === 'string' ? opts.platform : process.platform;
  const exts = Array.isArray(opts.exts) ? opts.exts : platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];

  // 显式路径：先按原样，再补扩展名。
  if (path.isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\')) {
    if (await isFile(trimmed)) return path.resolve(trimmed);
    for (const ext of exts) {
      if (ext !== '' && (await isFile(`${trimmed}${ext}`))) return path.resolve(`${trimmed}${ext}`);
    }
    return null;
  }

  const dirs = [];
  for (const dir of Array.isArray(opts.extraDirs) ? opts.extraDirs : []) {
    if (typeof dir === 'string' && dir.trim() !== '') dirs.push(dir.trim());
  }
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (typeof dir === 'string' && dir.trim() !== '') dirs.push(dir.trim());
  }

  const seen = new Set();
  for (const dir of dirs) {
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    for (const ext of exts) {
      const candidate = path.join(dir, `${trimmed}${ext}`);
      if (await isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** 判断一个路径是否可访问（`which` 的轻量版；不保证是文件）。 */
export async function exists(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') return false;
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** cmd.exe 参数引用：只处理空格与 cmd 元字符，够覆盖 SDK 路径/AVD 名里的字符。 */
function quoteForCmd(value) {
  const string = String(value);
  if (string === '') return '""';
  if (/^[A-Za-z0-9_\-.:\\/]+$/.test(string)) return string;
  // cmd.exe 里双引号内的 `"` 用 `""` 转义；`%` 与 `^` 由调用方保证不出现在参数里
  // （本插件的参数都是 SDK 路径 / 包名 / AVD 名 / device 名，不含这些字符）。
  return `"${string.replace(/"/g, '""')}"`;
}

/**
 * 运行 `.bat` / `.cmd` 脚本（Windows 专用路径；其他平台等价于 `run`）。
 *
 * Node 在 Windows 上**不能**直接 `spawn('foo.bat', [...])`（修复 CVE 之后返回
 * EINVAL / 抛错），而 `avdmanager` / `sdkmanager` 只有 `.bat`。所以这里走
 * `cmd.exe /d /s /c "…"` + `windowsVerbatimArguments`：整条命令作为**一个**
 * argv 元素传进去，由我们按 cmd 的引用规则拼好，不做未受控的字符串插值。
 *
 * @param {string} file `.bat` / `.cmd` 的绝对路径。
 * @param {string[]} [args] argv。
 * @param {object} [opts] 同 `run`。
 */
export function runScript(file, args = [], opts = {}) {
  if (process.platform !== 'win32' || !/\.(bat|cmd)$/i.test(String(file))) {
    return run(file, args, opts);
  }
  const argv = Array.isArray(args) ? args.map((entry) => String(entry)) : [];
  const commandLine = [file, ...argv].map(quoteForCmd).join(' ');
  return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
    ...opts,
    windowsVerbatimArguments: true,
  });
}

/** `run` 的结果是否代表"没找到可执行文件"。 */
export function isMissingProgram(result) {
  return result.error !== undefined && result.error.code === 'ENOENT';
}

/** `run` 的结果是否代表"被权限/沙箱挡住"。 */
export function isSpawnDenied(result) {
  const code = result.error?.code ?? '';
  return code === 'EPERM' || code === 'EACCES';
}

/** 把 `run`/`runBuffer` 的失败归一成 (code, message) 二元组（不抛）。 */
export function describeFailure(result, fallbackCode) {
  if (result === null || typeof result !== 'object') return { code: fallbackCode, message: '子进程没有返回结果。' };
  if (result.error !== undefined) {
    if (isMissingProgram(result)) {
      return { code: 'NO_ADB', message: `找不到可执行文件（ENOENT）：${result.error.message}` };
    }
    if (isSpawnDenied(result)) {
      return {
        code: 'SPAWN_DENIED',
        message: `启动子进程被拒绝（${result.error.code}）：当前会话权限不足以 spawn 进程。把会话切到 danger-full-access 后重试。`,
      };
    }
    return { code: fallbackCode, message: `子进程启动失败（${result.error.code}）：${result.error.message}` };
  }
  if (result.timedOut === true) {
    return { code: 'TIMEOUT', message: '子进程超时，已终止。可以加大超时参数或在设备空闲时重试。' };
  }
  return { code: fallbackCode, message: `子进程退出码 ${String(result.code)}${result.stderr.trim() === '' ? '' : `：${result.stderr.trim().slice(0, 500)}`}` };
}
