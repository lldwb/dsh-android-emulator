/**
 * dsh-android-emulator — Android SDK 发现、AVD / 系统镜像 / 加速检查、APK 元数据、设备 ABI。
 *
 * ## 为什么要自己发现 SDK
 *
 * DESIGN §6 的实测事实：本机 `ANDROID_HOME` **没有设置**，SDK 躺在
 * `%LOCALAPPDATA%\Android\Sdk`。所以"依赖环境变量"的插件在真实机器上直接不可用。
 * 发现顺序按 DESIGN：`config.sdkPath` → `ANDROID_HOME` → `ANDROID_SDK_ROOT` →
 * `%LOCALAPPDATA%\Android\Sdk` → `%USERPROFILE%\AppData\Local\Android\Sdk` →
 * `C:\Android\Sdk`，取第一个含 `platform-tools\adb.exe` 的。
 *
 * ## 为什么 APK 的 ABI 要自己读 zip
 *
 * 安装前 ABI 预检是 DESIGN 的硬要求（本机目标 APK 只有 arm64，x86_64 模拟器装不了，
 * 不预检就会得到一条难读的 `INSTALL_FAILED_NO_MATCHING_ABIS`）。读 `lib/<abi>/`
 * 只需要 **zip 中央目录**（不需要解压、不需要 aapt/java/unzip），所以这里直接按
 * ZIP 规范读 EOCD + 中央目录，约 60 行，零依赖。
 *
 * 同一个模块顺带解析 `AndroidManifest.xml`（Android 的二进制 XML / AXML）拿包名
 * 和版本号：`pm list packages` 差集在"重装已存在应用"时拿不到包名，AXML 是唯一
 * 不依赖 aapt 的可靠来源。解析失败不致命（`apkInfo` 会把包名留空，让工具层走
 * `pm list packages` 差集兜底）。
 *
 * ## 为什么 `avdmanager` / `sdkmanager` 要特殊对待
 *
 * Windows 上它们只有 `.bat`，Node 不能直接 spawn 批处理文件；调用方必须用
 * `runScript()`（exec.mjs）走 `cmd.exe /c`，并且 `avdmanager` 需要一个可用的
 * JDK —— 本机 `JAVA_HOME` 也可能没设，所以 `discoverJavaHome()` 会从
 * `%USERPROFILE%\.jdks` 之类的常见位置补一个，作为子进程 env 注入（不改全局环境）。
 */

import { open, readdir, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { adbShell } from './adb.mjs';
import { run, runScript, which } from './exec.mjs';
import { toolError, truncate } from './schema.mjs';

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

/** 是否是存在的文件。 */
async function isFile(candidate) {
  try {
    const info = await stat(candidate);
    return info.isFile();
  } catch {
    return false;
  }
}

/** 是否是存在的目录。 */
async function isDirectory(candidate) {
  try {
    const info = await stat(candidate);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/** readdir 的安全版（不存在就返回空数组）。 */
async function readDirSafe(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 读一个小文本文件的安全版。 */
async function readTextSafe(filePath) {
  try {
    const handle = await open(filePath, 'r');
    try {
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

/** Windows 上可执行文件的后缀（其他地方没有）。 */
const EXE = process.platform === 'win32' ? '.exe' : '';

/** `avdmanager` / `sdkmanager` 的后缀：Windows 是 `.bat`，其他平台没有。 */
const BATCH = process.platform === 'win32' ? '.bat' : '';

/** 解析 `.ini`（`key=value` 行；`avd` 的 config.ini 就这个格式）。 */
function parseIni(text) {
  const values = Object.create(null);
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    values[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return values;
}

/** 当前主机能跑什么 ABI 的模拟器（x86_64 主机只能跑 x86_64 镜像）。 */
export function hostPreferredAbi() {
  const arch = process.arch;
  if (arch === 'x64') return 'x86_64';
  if (arch === 'ia32') return 'x86';
  if (arch === 'arm64') return 'arm64-v8a';
  return 'x86_64';
}

/* ------------------------------------------------------------------ *
 * SDK 发现
 * ------------------------------------------------------------------ */

/**
 * 发现 Android SDK。
 *
 * @param {{ sdkPath?: string, adbPath?: string, emulatorPath?: string }} [config] 归一化后的插件配置。
 * @returns {Promise<{ found: boolean, root: string, adb: string, emulator: string, avdmanager: string, sdkmanager: string, problems: string[] }>}
 */
export async function discoverSdk(config = {}) {
  const problems = [];

  // 候选根目录，按 DESIGN §6 的顺序。
  /** @type {Array<{ root: string, source: string }>} */
  const candidates = [];
  const push = (root, source) => {
    if (typeof root !== 'string' || root.trim() === '') return;
    const resolved = path.resolve(root.trim());
    if (candidates.some((entry) => entry.root.toLowerCase() === resolved.toLowerCase())) return;
    candidates.push({ root: resolved, source });
  };
  push(config?.sdkPath, 'config.sdkPath');
  push(process.env.ANDROID_HOME, 'ANDROID_HOME');
  push(process.env.ANDROID_SDK_ROOT, 'ANDROID_SDK_ROOT');
  if (typeof process.env.LOCALAPPDATA === 'string') push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'), '%LOCALAPPDATA%\\Android\\Sdk');
  // 勘误（Lead 2026-10-24 实测）：DESIGN §6 原来的候选链漏了这一条，而本机 SDK 真实
  // 位置就是 `%LOCALAPPDATA%\Android\Sdk`（ANDROID_HOME 未设）。少了它 discoverSdk 返回
  // found:false，android_status 默认报 NO_SDK，真机验收直接卡住。
  if (typeof process.env.USERPROFILE === 'string') push(path.join(process.env.USERPROFILE, 'Android', 'Sdk'), '%USERPROFILE%\\Android\\Sdk');
  if (typeof process.env.USERPROFILE === 'string') push(path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Android', 'Sdk'), '%USERPROFILE%\\AppData\\Local\\Android\\Sdk');
  if (process.platform === 'win32') push('C:\\Android\\Sdk', 'C:\\Android\\Sdk');
  else push('/usr/local/android-sdk', '/usr/local/android-sdk');

  let root = '';
  for (const candidate of candidates) {
    if (await isFile(path.join(candidate.root, 'platform-tools', `adb${EXE}`))) {
      root = candidate.root;
      break;
    }
  }
  if (root === '') {
    problems.push(
      candidates.length === 0
        ? '没有配置 sdkPath，环境变量 ANDROID_HOME / ANDROID_SDK_ROOT 也都为空。'
        : `以下位置都没有 platform-tools/adb${EXE}：${candidates.map((entry) => `${entry.root}（来自 ${entry.source}）`).join('、')}`,
    );
  }

  // adb：显式覆盖 > SDK 根 > PATH。
  let adb = '';
  if (typeof config?.adbPath === 'string' && config.adbPath.trim() !== '') {
    adb = (await isFile(config.adbPath.trim())) ? path.resolve(config.adbPath.trim()) : '';
    if (adb === '') problems.push(`config.adbPath 指向的文件不存在：${config.adbPath}`);
  }
  if (adb === '' && root !== '') {
    const candidate = path.join(root, 'platform-tools', `adb${EXE}`);
    if (await isFile(candidate)) adb = candidate;
  }
  if (adb === '') {
    const found = await which('adb', { extraDirs: root === '' ? [] : [path.join(root, 'platform-tools')] });
    if (found !== null) adb = found;
  }
  if (adb === '') problems.push('找不到 adb（既不在 SDK 的 platform-tools 里，也不在 PATH 里）。请安装 Android SDK Platform-Tools，或用 config.adbPath 指定。');

  // emulator。
  let emulator = '';
  if (typeof config?.emulatorPath === 'string' && config.emulatorPath.trim() !== '') {
    emulator = (await isFile(config.emulatorPath.trim())) ? path.resolve(config.emulatorPath.trim()) : '';
    if (emulator === '') problems.push(`config.emulatorPath 指向的文件不存在：${config.emulatorPath}`);
  }
  if (emulator === '' && root !== '') {
    const candidate = path.join(root, 'emulator', `emulator${EXE}`);
    if (await isFile(candidate)) emulator = candidate;
  }
  if (emulator === '') {
    const found = await which('emulator', { extraDirs: root === '' ? [] : [path.join(root, 'emulator')] });
    if (found !== null) emulator = found;
  }
  if (emulator === '') problems.push('找不到 emulator（SDK 的 emulator 目录里没有，PATH 里也没有）。请在 SDK Manager 里安装 Android Emulator。');

  // avdmanager / sdkmanager：cmdline-tools（新旧两种目录布局）与旧的 tools/bin。
  const cmdlineDirs = [];
  if (root !== '') {
    cmdlineDirs.push(
      path.join(root, 'cmdline-tools', 'latest', 'bin'),
      path.join(root, 'cmdline-tools', 'bin'),
      path.join(root, 'tools', 'bin'),
      path.join(root, 'cmdline-tools'),
    );
  }
  const findTool = async (name) => {
    for (const dir of cmdlineDirs) {
      const candidate = path.join(dir, `${name}${BATCH}`);
      if (await isFile(candidate)) return candidate;
      // 有些安装（如 bin 目录里放的是无后缀的 shell 脚本）也要能命中。
      if (await isFile(path.join(dir, name))) return path.join(dir, name);
    }
    return which(name, { extraDirs: cmdlineDirs });
  };
  const avdmanager = (await findTool('avdmanager')) ?? '';
  const sdkmanager = (await findTool('sdkmanager')) ?? '';
  if (avdmanager === '') {
    problems.push('找不到 avdmanager（SDK 的 cmdline-tools 未安装）。请在 SDK Manager 里安装 Android SDK Command-line Tools；没有它无法创建 AVD。');
  }

  return { found: root !== '' || adb !== '', root, adb, emulator, avdmanager, sdkmanager, problems };
}

/**
 * 找可用的 JDK（`avdmanager` / `sdkmanager` 需要）。
 *
 * 返回 JDK 根目录（含 `bin/java.exe`），找不到返回空串。不修改全局环境变量，
 * 只在调用子进程时通过 `env` 注入。
 *
 * @returns {Promise<string>}
 */
export async function discoverJavaHome() {
  const explicit = typeof process.env.JAVA_HOME === 'string' ? process.env.JAVA_HOME.trim() : '';
  if (explicit !== '' && (await isFile(path.join(explicit, 'bin', `java${EXE}`)))) return explicit;

  const java = await which('java');
  if (java !== null) return path.dirname(path.dirname(java));

  const roots = [];
  if (typeof process.env.USERPROFILE === 'string' && process.env.USERPROFILE !== '') roots.push(path.join(process.env.USERPROFILE, '.jdks'));
  if (process.env.LOCALAPPDATA !== undefined) roots.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Eclipse Adoptium'));
  roots.push('C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Java', 'C:\\Program Files\\Microsoft\\jdk', '/usr/lib/jvm');

  const score = (name) => {
    let value = 0;
    if (/\b(21|17|11)\b/.test(name)) value += 100;
    if (/jdks?/i.test(name)) value += 10;
    if (/temurin|zulu|corretto|adoptium|msopenjdk/i.test(name)) value += 5;
    return value;
  };

  for (const base of roots) {
    const entries = await readDirSafe(base);
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(base, entry.name))
      .sort((left, right) => score(path.basename(right)) - score(path.basename(left)));
    for (const directory of directories) {
      if (await isFile(path.join(directory, 'bin', `java${EXE}`))) return directory;
      // macOS 风格：<root>/Contents/Home
      if (await isFile(path.join(directory, 'Contents', 'Home', 'bin', 'java'))) return path.join(directory, 'Contents', 'Home');
    }
  }
  return '';
}

/** 给 avdmanager/sdkmanager 用的子进程环境（补 JAVA_HOME 与 PATH）。 */
export async function javaEnv() {
  const javaHome = await discoverJavaHome();
  if (javaHome === '') return undefined;
  const bin = path.join(javaHome, 'bin');
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  return { JAVA_HOME: javaHome, PATH: `${bin}${path.delimiter}${pathValue}` };
}

/* ------------------------------------------------------------------ *
 * AVD
 * ------------------------------------------------------------------ */

/** AVD 家目录（`ANDROID_AVD_HOME` 优先，其次 `~/.android/avd`）。 */
function avdHome() {
  if (typeof process.env.ANDROID_AVD_HOME === 'string' && process.env.ANDROID_AVD_HOME.trim() !== '') {
    return path.resolve(process.env.ANDROID_AVD_HOME.trim());
  }
  const profile = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (profile === '') return '';
  if (typeof process.env.ANDROID_USER_HOME === 'string' && process.env.ANDROID_USER_HOME.trim() !== '') {
    return path.join(path.resolve(process.env.ANDROID_USER_HOME.trim()), 'avd');
  }
  return path.join(profile, '.android', 'avd');
}

/** 用 `emulator -list-avds` 取 AVD 名；失败则扫 AVD 目录。 */
async function avdNames(sdk) {
  const names = [];
  const seen = new Set();
  const remember = (name) => {
    const trimmed = String(name ?? '').trim();
    if (trimmed === '' || seen.has(trimmed)) return;
    seen.add(trimmed);
    names.push(trimmed);
  };

  if (sdk.emulator !== '') {
    const result = await run(sdk.emulator, ['-list-avds'], { timeoutMs: 20000 });
    if (result.error === undefined && result.timedOut !== true) {
      for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
        if (line.trim() !== '') remember(line.trim());
      }
      // `emulator -list-avds` 也可能打印 INFO 行；只保留目录真实存在的名字。
    }
  }
  if (names.length === 0) {
    const base = avdHome();
    if (base !== '') {
      for (const entry of await readDirSafe(base)) {
        if (entry.isDirectory() && entry.name.endsWith('.avd')) remember(entry.name.slice(0, -'.avd'.length));
        else if (entry.isFile() && entry.name.endsWith('.ini')) remember(entry.name.slice(0, -'.ini'.length));
      }
    }
  }
  return names;
}

/**
 * 列出已创建的 AVD。
 *
 * @param {{ emulator?: string }} sdk
 * @returns {Promise<Array<{ name: string, path: string, target: string, abi: string, device: string }>>}
 */
export async function listAvds(sdk) {
  const base = avdHome();
  const results = [];
  for (const name of await avdNames(sdk)) {
    const directory = base === '' ? '' : path.join(base, `${name}.avd`);
    const configPath = directory === '' ? '' : path.join(directory, 'config.ini');
    const values = configPath === '' ? Object.create(null) : parseIni(await readTextSafe(configPath));
    // 有的安装把 AVD 直接放在 avd 目录下（无 .avd 后缀），此时目录就是名字本身。
    const resolvedPath = directory !== '' && (await isDirectory(directory)) ? directory : base;
    const sysdir = values['image.sysdir.1'] ?? '';
    const abiFromSysdir = /([^\\/]+)[\\/]?$/.exec(sysdir)?.[1] ?? '';
    results.push({
      name,
      path: resolvedPath,
      target: values.target ?? sysdir ?? '',
      abi: values['abi.type'] ?? abiFromSysdir,
      device: values['hw.device.name'] ?? values['devicename'] ?? '',
    });
  }
  return results;
}

/* ------------------------------------------------------------------ *
 * 系统镜像
 * ------------------------------------------------------------------ */

/** 目录名是否像一个 ABI（旧的 `system-images/android-35/x86_64` 布局没有 tag 层）。 */
const ABI_DIR_RE = /^(x86_64|x86|arm64-v8a|armeabi-v7a|armeabi|mips|mips64)$/;

/**
 * 列出已安装的系统镜像（扫 `<sdk>/system-images/<api>/<tag>/<abi>/`）。
 *
 * @param {{ root?: string }} sdk
 * @returns {Promise<Array<{ package: string, api: number, tag: string, abi: string, path: string }>>}
 */
export async function listSystemImages(sdk) {
  const root = typeof sdk?.root === 'string' ? sdk.root : '';
  if (root === '') return [];
  const bases = [path.join(root, 'system-images')];
  if (process.platform !== 'win32') bases.push(path.join(root, 'system-images'));

  const images = [];
  for (const base of bases) {
    for (const apiEntry of await readDirSafe(base)) {
      if (!apiEntry.isDirectory()) continue;
      const apiMatch = /^android-(\d+)$/i.exec(apiEntry.name);
      if (apiMatch === null) continue;
      const api = Number.parseInt(apiMatch[1], 10);
      const apiPath = path.join(base, apiEntry.name);
      for (const tagEntry of await readDirSafe(apiPath)) {
        if (!tagEntry.isDirectory()) continue;
        const tagPath = path.join(apiPath, tagEntry.name);
        if (ABI_DIR_RE.test(tagEntry.name)) {
          // 旧布局：android-35/x86_64 → tag 视为 default
          images.push({
            package: `system-images;android-${api};default;${tagEntry.name}`,
            api,
            tag: 'default',
            abi: tagEntry.name,
            path: tagPath,
          });
          continue;
        }
        for (const abiEntry of await readDirSafe(tagPath)) {
          if (!abiEntry.isDirectory() || !ABI_DIR_RE.test(abiEntry.name)) continue;
          images.push({
            package: `system-images;android-${api};${tagEntry.name};${abiEntry.name}`,
            api,
            tag: tagEntry.name,
            abi: abiEntry.name,
            path: path.join(tagPath, abiEntry.name),
          });
        }
      }
    }
  }
  return images.sort((left, right) => right.api - left.api || left.package.localeCompare(right.package));
}

/* ------------------------------------------------------------------ *
 * 硬件加速
 * ------------------------------------------------------------------ */

/** 从 `emulator -accel-check` 输出里识别加速后端。 */
function detectAccelKind(raw) {
  const lower = raw.toLowerCase();
  if (lower.includes('whpx')) return 'whpx';
  if (lower.includes('haxm')) return 'haxm';
  if (lower.includes('kvm')) return 'kvm';
  if (lower.includes('hvf')) return 'hvf';
  if (lower.includes('aae')) return 'aae';
  return '';
}

/**
 * 检查硬件加速是否可用（x86_64 镜像没有加速会极慢甚至启动失败）。
 *
 * @param {{ emulator?: string }} sdk
 * @returns {Promise<{ ok: boolean, kind: string, raw: string }>}
 */
export async function accelCheck(sdk) {
  const emulator = typeof sdk?.emulator === 'string' ? sdk.emulator : '';
  if (emulator === '') {
    return { ok: false, kind: '', raw: '找不到 emulator 可执行文件，无法检查硬件加速。' };
  }
  const result = await run(emulator, ['-accel-check'], { timeoutMs: 30000 });
  const raw = truncate(`${result.stdout}\n${result.stderr}`.trim(), 600);
  if (result.error !== undefined) {
    return { ok: false, kind: '', raw: `emulator -accel-check 启动失败（${result.error.code}）：${result.error.message}` };
  }
  const ok = /is installed and usable/i.test(raw) || /acceleration is (?:working|enabled|available)/i.test(raw);
  return { ok, kind: detectAccelKind(raw), raw };
}

/* ------------------------------------------------------------------ *
 * ZIP（APK）解析 —— 中央目录 + 单个 entry 解压
 * ------------------------------------------------------------------ */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** 抛一个带 DESIGN 错误码的 APK 错误。 */
function apkError(code, message) {
  return toolError(code, message);
}

/** 在文件尾部找 EOCD（End Of Central Directory）。 */
function findEndOfCentralDirectory(tail) {
  const minimum = Math.max(0, tail.length - 65557);
  for (let index = tail.length - 22; index >= minimum; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD_SIGNATURE) return index;
  }
  return -1;
}

/**
 * 读 zip 中央目录，返回全部 entry 元数据。
 *
 * @param {string} apkPath APK 的绝对路径。
 * @returns {Promise<Array<{ name: string, method: number, compressedSize: number, size: number, localOffset: number }>>}
 */
export async function readZipEntries(apkPath) {
  let handle;
  try {
    handle = await open(apkPath, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') throw apkError('APK_NOT_FOUND', `找不到 APK 文件：${apkPath}。请确认路径（建议传绝对路径）。`);
    throw apkError('APK_UNREADABLE', `打不开 APK 文件：${apkPath}（${error?.message ?? String(error)}）。`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 22) {
      throw apkError('APK_UNREADABLE', `${apkPath} 不是有效的 APK（文件太小，缺少 zip 结构）。`);
    }
    const tailLength = Math.min(info.size, 65557 + 22);
    const tail = Buffer.allocUnsafe(tailLength);
    await handle.read(tail, 0, tailLength, info.size - tailLength);
    const eocd = findEndOfCentralDirectory(tail);
    if (eocd === -1) {
      throw apkError('APK_UNREADABLE', `${apkPath} 不是有效的 zip/apk（找不到中央目录结尾记录）。它可能损坏，或只是一个改了后缀的文件。`);
    }
    const entryCount = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (centralOffset === 0xffffffff || entryCount === 0xffff) {
      throw apkError('APK_UNREADABLE', `${apkPath} 使用了 ZIP64 格式，本插件暂不支持（正常 APK 不会是 ZIP64；请检查文件是否被工具重打包过）。`);
    }
    const central = Buffer.allocUnsafe(centralSize);
    await handle.read(central, 0, centralSize, centralOffset);

    const entries = [];
    let cursor = 0;
    for (let index = 0; index < entryCount && cursor + 46 <= central.length; index += 1) {
      if (central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break;
      const method = central.readUInt16LE(cursor + 10);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const size = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const localOffset = central.readUInt32LE(cursor + 42);
      const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
      entries.push({ name, method, compressedSize, size, localOffset });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/**
 * 解压中央目录里的一个 entry。
 *
 * @param {string} apkPath APK 路径。
 * @param {{ method: number, compressedSize: number, localOffset: number }} entry 来自 `readZipEntries`。
 * @returns {Promise<Buffer>}
 */
export async function extractZipEntry(apkPath, entry) {
  const handle = await open(apkPath, 'r');
  try {
    const localHeader = Buffer.alloc(30);
    await handle.read(localHeader, 0, 30, entry.localOffset);
    if (localHeader.readUInt32LE(0) !== LOCAL_SIGNATURE) {
      throw apkError('APK_UNREADABLE', `APK 的 zip 结构损坏（条目 ${entry.name} 的本地头签名不对）。`);
    }
    const nameLength = localHeader.readUInt16LE(26);
    const extraLength = localHeader.readUInt16LE(28);
    const dataStart = entry.localOffset + 30 + nameLength + extraLength;
    const compressed = Buffer.allocUnsafe(entry.compressedSize);
    await handle.read(compressed, 0, entry.compressedSize, dataStart);
    if (entry.method === 0) return compressed;
    if (entry.method === 8) {
      try {
        return inflateRawSync(compressed);
      } catch (error) {
        throw apkError('APK_UNREADABLE', `解压 APK 里的 ${entry.name} 失败：${error?.message ?? String(error)}`);
      }
    }
    throw apkError('APK_UNREADABLE', `APK 里的 ${entry.name} 使用了不支持的压缩方式（method=${entry.method}）。`);
  } finally {
    await handle.close();
  }
}

/* ------------------------------------------------------------------ *
 * AndroidManifest.xml（AXML / 二进制 XML）解析
 * ------------------------------------------------------------------ */

const AXML_XML_TYPE = 0x0003;
const AXML_STRING_POOL_TYPE = 0x0001;
const AXML_RESOURCE_MAP_TYPE = 0x0180;
const AXML_START_ELEMENT_TYPE = 0x0102;

/** 读 string pool，返回字符串数组。 */
function parseStringPool(buffer, chunkStart) {
  const headerSize = buffer.readUInt16LE(chunkStart + 2);
  const chunkSize = buffer.readUInt32LE(chunkStart + 4);
  const stringCount = buffer.readUInt32LE(chunkStart + 8);
  const flags = buffer.readUInt32LE(chunkStart + 16);
  const stringsStart = buffer.readUInt32LE(chunkStart + 20);
  const isUtf8 = (flags & 0x100) !== 0;
  const limit = Math.min(chunkStart + chunkSize, buffer.length);
  const dataStart = chunkStart + stringsStart;
  const offsetsStart = chunkStart + headerSize;

  const strings = [];
  for (let index = 0; index < stringCount; index += 1) {
    const offsetPosition = offsetsStart + index * 4;
    if (offsetPosition + 4 > limit) break;
    const stringOffset = buffer.readUInt32LE(offsetPosition);
    strings.push(readPoolString(buffer, dataStart + stringOffset, isUtf8, limit));
  }
  return strings;
}

/** 读 string pool 里的一条字符串（UTF-8 或 UTF-16 两种编码）。 */
function readPoolString(buffer, position, isUtf8, limit) {
  let cursor = position;
  if (isUtf8) {
    let first = buffer[cursor];
    cursor += 1;
    if ((first & 0x80) !== 0) {
      first = ((first & 0x7f) << 8) | buffer[cursor];
      cursor += 1;
    }
    let bytes = buffer[cursor];
    cursor += 1;
    if ((bytes & 0x80) !== 0) {
      bytes = ((bytes & 0x7f) << 8) | buffer[cursor];
      cursor += 1;
    }
    return buffer.subarray(cursor, Math.min(cursor + bytes, limit)).toString('utf8');
  }
  let first = buffer.readUInt16LE(cursor);
  cursor += 2;
  let length = first;
  if ((first & 0x8000) !== 0) {
    length = ((first & 0x7fff) << 16) | buffer.readUInt16LE(cursor);
    cursor += 2;
  }
  const end = Math.min(cursor + length * 2, limit);
  return buffer.subarray(cursor, end).toString('utf16le');
}

/** 读资源映射（属性名字符串索引 → framework 资源 ID）。 */
function parseResourceMap(buffer, chunkStart, headerSize, chunkSize) {
  const count = Math.max(0, Math.floor((chunkSize - headerSize) / 4));
  const map = [];
  for (let index = 0; index < count; index += 1) {
    const position = chunkStart + headerSize + index * 4;
    map.push(position + 4 <= buffer.length ? buffer.readUInt32LE(position) : 0);
  }
  return map;
}

/** 解析一个 START_ELEMENT chunk。 */
function parseStartElement(buffer, chunkStart, headerSize, strings, resourceMap) {
  const bodyStart = chunkStart + headerSize;
  const elementNameIndex = buffer.readUInt32LE(bodyStart + 4);
  const attributeStart = buffer.readUInt16LE(bodyStart + 8);
  const attributeSize = buffer.readUInt16LE(bodyStart + 10);
  const attributeCount = buffer.readUInt16LE(bodyStart + 12);

  const attributes = [];
  for (let index = 0; index < attributeCount; index += 1) {
    const position = bodyStart + attributeStart + index * attributeSize;
    if (position + 20 > buffer.length) break;
    const nameIndex = buffer.readUInt32LE(position + 4);
    const rawIndex = buffer.readUInt32LE(position + 8);
    const dataType = buffer[position + 15];
    const data = buffer.readUInt32LE(position + 16);
    attributes.push({
      name: strings[nameIndex] ?? '',
      resourceId: resourceMap[nameIndex] ?? 0,
      rawIndex,
      dataType,
      data,
    });
  }
  return { name: strings[elementNameIndex] ?? '', attributes };
}

/**
 * 从 AXML 里取 `manifest` 元素（第一个 START_ELEMENT）。
 *
 * 属性值是 string pool 索引，所以同时把字符串池一起返回；没有它读不出包名。
 *
 * @param {Buffer} buffer AndroidManifest.xml 解压后的内容。
 * @returns {{ name: string, attributes: Array<object>, strings: string[] } | null}
 */
export function parseManifestElement(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
  if (buffer.readUInt16LE(0) !== AXML_XML_TYPE) return null;

  const declaredSize = buffer.readUInt32LE(4);
  const end = Math.min(declaredSize > 0 ? declaredSize : buffer.length, buffer.length);
  let offset = buffer.readUInt16LE(2);
  let strings = [];
  let resourceMap = [];

  while (offset + 8 <= end) {
    const type = buffer.readUInt16LE(offset);
    const headerSize = buffer.readUInt16LE(offset + 2);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkSize < 8 || offset + chunkSize > end) break;

    if (type === AXML_STRING_POOL_TYPE) {
      strings = parseStringPool(buffer, offset);
    } else if (type === AXML_RESOURCE_MAP_TYPE) {
      resourceMap = parseResourceMap(buffer, offset, headerSize, chunkSize);
    } else if (type === AXML_START_ELEMENT_TYPE) {
      const element = parseStartElement(buffer, offset, headerSize, strings, resourceMap);
      if (element.name === 'manifest') return { ...element, strings };
    }
    offset += chunkSize;
  }
  return null;
}

/** 从属性列表里按名字取字符串值（AXML 里字符串值既是 rawIndex 也可能是 data 索引）。 */
function attributeValue(attributes, name, strings) {
  const attribute = attributes.find((entry) => entry.name === name);
  if (attribute === undefined) return '';
  if (attribute.rawIndex !== 0xffffffff && attribute.rawIndex < strings.length) return strings[attribute.rawIndex];
  if (attribute.dataType === 0x03 && attribute.data < strings.length) return strings[attribute.data];
  return '';
}

/** 从属性列表里按名字取整数值（versionCode 是 INT_DEC = 0x10）。 */
function attributeInteger(attributes, name) {
  const attribute = attributes.find((entry) => entry.name === name);
  if (attribute === undefined) return 0;
  if (attribute.dataType === 0x10) return attribute.data | 0;
  if (attribute.dataType === 0x11) return attribute.data >>> 0;
  // 少数工具链会把数字写成字符串常量（0x03）；此时 data 是索引，读不出来就返回 0。
  return 0;
}

/**
 * 从 APK 里解出 AndroidManifest 的包名与版本。
 *
 * 这是给 `apkInfo()` 内部用的；失败时返回 null（包名留空，由工具层兜底）。
 *
 * @param {string} apkPath APK 路径。
 * @param {Array<object>} entries `readZipEntries` 的结果。
 */
async function readManifestInfo(apkPath, entries) {
  const entry = entries.find((candidate) => candidate.name === 'AndroidManifest.xml');
  if (entry === undefined) return null;
  try {
    const buffer = await extractZipEntry(apkPath, entry);
    const element = parseManifestElement(buffer);
    if (element === null) return null;
    return {
      packageName: attributeValue(element.attributes, 'package', element.strings),
      versionName: attributeValue(element.attributes, 'versionName', element.strings),
      versionCode: attributeInteger(element.attributes, 'versionCode'),
    };
  } catch {
    return null;
  }
}

/**
 * 读 APK 的 ABI 列表（zip 中央目录里 `lib/<abi>/…` 的去重结果）。
 *
 * 空数组表示这是一个不含 native 库的纯 Java APK（任何 ABI 都能装）。
 *
 * @param {string} apkPath APK 路径。
 * @returns {Promise<string[]>}
 */
export async function apkAbis(apkPath) {
  const entries = await readZipEntries(apkPath);
  const abis = [];
  const seen = new Set();
  for (const entry of entries) {
    const match = /^lib\/([^/]+)\//.exec(entry.name);
    if (match === null) continue;
    const abi = match[1];
    if (seen.has(abi)) continue;
    seen.add(abi);
    abis.push(abi);
  }
  return abis;
}

/**
 * 读 APK 的 ABI + 包名 + 版本（一次读 zip，供安装工具用）。
 *
 * ABI 来自 `lib/<abi>/`；包名/版本来自二进制 AndroidManifest。manifest 解析失败
 * 不抛异常：`packageName` 留空，工具层再用 `pm list packages` 差集兜底。
 *
 * @param {string} apkPath APK 路径。
 * @returns {Promise<{ abis: string[], package: string, versionName: string, versionCode: number }>}
 */
export async function apkInfo(apkPath) {
  const entries = await readZipEntries(apkPath);
  const abis = [];
  const seen = new Set();
  for (const entry of entries) {
    const match = /^lib\/([^/]+)\//.exec(entry.name);
    if (match === null) continue;
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    abis.push(match[1]);
  }
  const manifest = await readManifestInfo(apkPath, entries);
  return {
    abis,
    package: manifest?.packageName ?? '',
    versionName: manifest?.versionName ?? '',
    versionCode: manifest?.versionCode ?? 0,
  };
}

/* ------------------------------------------------------------------ *
 * 设备 ABI
 * ------------------------------------------------------------------ */

/**
 * 读设备支持的 ABI 列表（`ro.product.cpu.abilist`，退到 `ro.product.cpu.abi`）。
 *
 * @param {string} adb adb 路径。
 * @param {string} serial 设备序列号。
 * @returns {Promise<string[]>}
 */
export async function deviceAbis(adb, serial) {
  const listResult = await adbShell(adb, serial, ['getprop', 'ro.product.cpu.abilist'], { timeoutMs: 15000 });
  const rawList = String(listResult.stdout ?? '').trim();
  if (rawList !== '' && rawList !== '[]') {
    const list = rawList
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    if (list.length > 0) return list;
  }
  const singleResult = await adbShell(adb, serial, ['getprop', 'ro.product.cpu.abi'], { timeoutMs: 15000 });
  const single = String(singleResult.stdout ?? '').trim();
  if (single === '' || single === '[]') return [];
  return [single];
}

/** 把 SDK 发现过程中的问题拼成一句人话（工具层的 message 用）。 */
export function sdkProblemSummary(sdk) {
  const problems = Array.isArray(sdk?.problems) ? sdk.problems : [];
  return problems.length === 0 ? '' : problems.join(' ');
}

/* ------------------------------------------------------------------ *
 * ARM 转译层（v1.1.0）
 * ------------------------------------------------------------------ */

/** 解析 `a,b,c` 形式的 ABI 列表（getprop 的空值会返回空串或 `[]`）。 */
function parseAbiList(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && entry !== '[]');
}

/**
 * 解析 `getprop`（无参数）的全量输出，形如：
 *
 * ```
 * [ro.dalvik.vm.native.bridge]: [libndk_translation.so]
 * [ro.ndk_translation.version]: [0.2.3]
 * ```
 *
 * 为什么一次读全量而不是逐条 `getprop <name>`：7 条属性 = 7 次 adb 往返
 * （每次 50–100 ms），而全量一次就够；而且"探测失败"只剩一种失败面（一次调用）。
 * 属性名与值都是设备侧只读数据，不涉及任何用户输入拼接。
 *
 * @param {string} stdout `adb shell getprop` 的输出。
 * @returns {Record<string, string>}
 */
export function parseGetpropOutput(stdout) {
  const values = Object.create(null);
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const match = /^\[([^\]]+)\]:\s*\[(.*)\]\s*$/.exec(line);
    if (match === null) continue;
    values[match[1].trim()] = match[2];
  }
  return values;
}

/**
 * `translation` 的空值（探测失败 / 没有设备时用）。
 *
 * 工具层的 `buildResult(defaults)` 也用它——**所有失败分支都要带齐这 8 个字段**，
 * 否则 `additionalProperties:false` 的 output schema 会判 `missing required property`。
 */
export function emptyTranslation() {
  return {
    bridge: '',
    version: '',
    enabled: false,
    kind: 'none',
    arm64: false,
    arm32: false,
    abilist64: [],
    abilist32: [],
  };
}

/**
 * 从 `getprop` 全量属性表合成 `translation` 对象（DESIGN §7.1）。**纯函数**。
 *
 * 抽出来的原因：`deviceTranslation()` 唯一的数据入口是 `adbShell`，导致 kind 的四种
 * 形态（ndk-translation / houdini / native / none）与 arm64/arm32 的推导无法离线单测
 * （假 adb 路线在 Windows 上走不通：`.cmd` 会被 Node 拒绝、node.exe 又被 `-s` 参数挡住）。
 * 现在解析层（`parseGetpropOutput`）与合成层（本函数）都是纯函数，只有 I/O 留在
 * `deviceTranslation()` 里。
 *
 * ⚠️ 判定逻辑与 DESIGN §7.1 逐字对应，**不要顺手改**（qa 的用例钉的正是这些分支）：
 * - `kind`：bridge 含 `ndk_translation` → `ndk-translation`；含 `houdini` → `houdini`；
 *   bridge 为空但 abilist 含 arm* → `native`（ARM 真机）；其它 → `none`。
 * - `arm64` / `arm32`：`abilist64` / `abilist32` 或 `abilist` 含对应 ARM ABI。
 * - `enabled`：`ro.enable.native.bridge.exec` 为 `1`/`true`；属性缺失时退回"有 bridge 即启用"。
 *
 * @param {Record<string, string> | null | undefined} props `parseGetpropOutput()` 的结果。
 * @returns {{ bridge: string, version: string, enabled: boolean, kind: string, arm64: boolean, arm32: boolean, abilist64: string[], abilist32: string[] }}
 */
export function translationFromProps(props) {
  const bridge = String(props?.['ro.dalvik.vm.native.bridge'] ?? '').trim();
  const version = String(props?.['ro.ndk_translation.version'] ?? '').trim();
  const enabledRaw = String(props?.['ro.enable.native.bridge.exec'] ?? '').trim().toLowerCase();
  const abilist64 = parseAbiList(props?.['ro.product.cpu.abilist64']);
  const abilist32 = parseAbiList(props?.['ro.product.cpu.abilist32']);
  const abilist = parseAbiList(props?.['ro.product.cpu.abilist']);

  // 实测本机：abilist64=x86_64,arm64-v8a → arm64=true；abilist32 为空 → arm32=false。
  const arm64 = abilist64.includes('arm64-v8a') || abilist.includes('arm64-v8a');
  const arm32 =
    abilist32.some((entry) => entry === 'armeabi-v7a' || entry === 'armeabi') ||
    abilist.some((entry) => entry === 'armeabi-v7a' || entry === 'armeabi');

  let kind = 'none';
  if (bridge.includes('ndk_translation')) kind = 'ndk-translation';
  else if (bridge.includes('houdini')) kind = 'houdini';
  else if (bridge === '' && (arm64 || arm32)) kind = 'native';

  // 优先看 ro.enable.native.bridge.exec；镜像没导出该属性时退回"有 bridge 即启用"。
  const enabled = enabledRaw === '1' || enabledRaw === 'true' || (enabledRaw === '' && bridge !== '');

  return { bridge, version, enabled, kind, arm64, arm32, abilist64, abilist32 };
}

/**
 * 探测设备的 ARM 转译层能力（DESIGN §7.1）。
 *
 * 数据来源（一次 `getprop` 全量）：
 * - `ro.dalvik.vm.native.bridge`（`libndk_translation.so` = Google 的 ARM64 转译层）
 * - `ro.ndk_translation.version`（如 `0.2.3`）
 * - `ro.enable.native.bridge.exec`（`1` = 启用）
 * - `ro.product.cpu.abilist64` / `abilist32` / `abilist`（`arm64-v8a` / `armeabi-v7a` 是否在列）
 * - `ro.dalvik.vm.isa.arm64` / `isa.arm`（仅诊断，不参与 kind 判定）
 *
 * 本函数只负责 I/O；合成逻辑在纯函数 `translationFromProps()` 里（可离线单测）。
 *
 * **永不抛**：任何失败都返回 `kind:"none"` 的空对象——探测失败不能影响主流程。
 *
 * @param {string} adb adb 路径。
 * @param {string} serial 设备 serial。
 * @returns {Promise<{ bridge: string, version: string, enabled: boolean, kind: string, arm64: boolean, arm32: boolean, abilist64: string[], abilist32: string[] }>}
 */
export async function deviceTranslation(adb, serial) {
  const empty = emptyTranslation();
  if (typeof adb !== 'string' || adb === '' || typeof serial !== 'string' || serial === '') return empty;

  let props;
  try {
    const result = await adbShell(adb, serial, ['getprop'], { timeoutMs: 30000 });
    props = parseGetpropOutput(result.stdout);
  } catch {
    return empty;
  }

  return translationFromProps(props);
}

/* ------------------------------------------------------------------ *
 * v1.2.0：AVD 生命周期与磁盘预算（会话专属 AVD / 回收 / 磁盘压力）
 * ------------------------------------------------------------------ */

/** 字节 → GB（一位小数）。 */
function toGb(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round((value / 1024 ** 3) * 10) / 10;
}

/**
 * 递归统计目录字节数（AVD 目录里都是大文件，用 stat 即可，不读内容）。
 *
 * 为什么需要它：单台模拟器实测 6.52 GB（`userdata-qemu.img.qcow2` 3.93 GB +
 * 快照 `ram.img` 2.50 GB），删除会话 AVD 时要把"释放了多少"报给用户。
 */
export async function dirSizeBytes(directory) {
  const entries = await readDirSafe(directory);
  let total = 0;
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await dirSizeBytes(full);
    else if (entry.isFile()) {
      try {
        total += (await stat(full)).size;
      } catch {
        // 统计期间被删除的文件忽略。
      }
    }
  }
  return total;
}

/** AVD 目录占用（GB；拿不到返回 0）。 */
export async function avdDirSizeGb(avdPath) {
  if (typeof avdPath !== 'string' || avdPath === '') return 0;
  return toGb(await dirSizeBytes(avdPath));
}

/** 目录所在磁盘的可用空间（GB；拿不到返回 0）。 */
export async function freeDiskGb(directory) {
  const target = typeof directory === 'string' && directory !== '' ? directory : process.cwd();
  try {
    const info = await statfs(target);
    return toGb(info.bavail * info.bsize);
  } catch {
    return 0;
  }
}

/**
 * 用 avdmanager 创建一个 AVD（`android_avd_create` 与"每会话专属 AVD"共用）。
 *
 * 不抛异常：返回 avdmanager 的原始结果 + 实际命令，由调用方按 `code` 判定。
 *
 * @param {{ avdmanager: string }} sdk
 * @param {{ name: string, image: string, device?: string, force?: boolean, timeoutMs?: number }} options
 */
export async function createAvd(sdk, options = {}) {
  const name = typeof options.name === 'string' ? options.name.trim() : '';
  const image = typeof options.image === 'string' ? options.image.trim() : '';
  const avdmanager = typeof sdk?.avdmanager === 'string' ? sdk.avdmanager : '';
  if (name === '' || image === '' || avdmanager === '') {
    return {
      code: null,
      stdout: '',
      stderr: name === '' ? '缺少 AVD 名' : image === '' ? '缺少系统镜像包名' : '找不到 avdmanager',
      timedOut: false,
      command: [],
    };
  }
  const device = typeof options.device === 'string' ? options.device.trim() : '';
  const command = [avdmanager, 'create', 'avd', '-n', name, '-k', image];
  if (device !== '') command.push('--device', device);
  if (options.force === true) command.push('--force');
  const env = await javaEnv();
  const result = await runScript(command[0], command.slice(1), {
    timeoutMs: options.timeoutMs ?? 180000,
    // avdmanager 会问 "Do you wish to create a custom hardware profile? [no]"。
    input: 'no\n',
    ...(env === undefined ? {} : { env }),
  });
  return { ...result, command };
}

/** 用 avdmanager 删除一个 AVD（不抛，返回原始结果）。 */
export async function deleteAvd(sdk, name, options = {}) {
  const target = typeof name === 'string' ? name.trim() : '';
  const avdmanager = typeof sdk?.avdmanager === 'string' ? sdk.avdmanager : '';
  if (target === '' || avdmanager === '') {
    return {
      code: null,
      stdout: '',
      stderr: target === '' ? '缺少 AVD 名' : '找不到 avdmanager',
      timedOut: false,
      command: [],
    };
  }
  const command = [avdmanager, 'delete', 'avd', '-n', target];
  const env = await javaEnv();
  const result = await runScript(command[0], command.slice(1), {
    timeoutMs: options.timeoutMs ?? 60000,
    ...(env === undefined ? {} : { env }),
  });
  return { ...result, command };
}

/**
 * 从 AVD 的 `image.sysdir.1` 推导 sdkmanager 包名。
 *
 * `listAvds` 的 target 形如 `system-images\android-35\google_apis\x86_64\`，
 * 对应包名 `system-images;android-35;google_apis;x86_64`。
 */
export function imageFromAvdTarget(target) {
  const text = String(target ?? '').trim();
  if (text === '') return '';
  const parts = text.replace(/[\\/]+$/u, '').split(/[\\/]+/u).filter((entry) => entry !== '');
  if (parts.length < 4 || parts[0] !== 'system-images') return '';
  return `system-images;${parts[1]};${parts[2]};${parts[3]}`;
}

/**
 * 给会话 AVD 选系统镜像：优先照抄模板 AVD（`config.avdName`）的镜像，
 * 退到与主机 ABI 匹配的已安装镜像。
 *
 * @param {{ root: string, emulator: string }} sdk
 * @param {string} templateName 模板 AVD 名（`config.avdName`）。
 */
export async function resolveAvdImage(sdk, templateName) {
  const images = await listSystemImages(sdk);
  const avds = await listAvds(sdk);
  const template = avds.find((entry) => entry.name === templateName) ?? null;
  const fromTemplate = template === null ? '' : imageFromAvdTarget(template.target);
  if (fromTemplate !== '' && images.some((entry) => entry.package === fromTemplate)) {
    return { image: fromTemplate, templateAvd: template };
  }
  const hostAbi = hostPreferredAbi();
  const preferred = images.filter((entry) => entry.abi === hostAbi).sort((left, right) => right.api - left.api);
  if (preferred.length > 0) return { image: preferred[0].package, templateAvd: template };
  if (images.length > 0) return { image: images[0].package, templateAvd: template };
  return { image: '', templateAvd: template };
}
