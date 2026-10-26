/**
 * dsh-android-emulator — 设备/应用类工具（8 个）。
 *
 *   android_status · android_avd_create · android_emulator_start · android_emulator_stop
 *   android_apk_install · android_app_launch · android_app_stop · android_logcat
 *
 * ## 这一层的三条纪律
 *
 * 1. **每个工具一个 `buildResult(defaults)` 工厂**。`defaults` 列出该工具**全部**
 *    返回字段（嵌套对象也补齐），成功和每个失败分支都返回同一组键。这样
 *    `output.schema` 的 `properties` / `required` 与返回值天然一一对应，
 *    `additionalProperties: false` 下永远不会多键或少键。
 * 2. **失败是数据，不是异常**。业务错误用 `toolError(code, …)` 抛，本文件的
 *    `defineTool` 统一 catch 成 `R.fail(code, message)`；真正的程序 bug 也会被
 *    兜成 `INTERNAL`，不会让工具调用挂掉。
 * 3. **message 面向下一步**。每个失败消息都要能直接指导 agent 行动
 *    （"先调用 android_emulator_start" / "用 -PabiList 重建含 x86_64"），
 *    而不是只复述错误。
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';

import {
  accelCheck,
  apkInfo,
  avdDirSizeGb,
  createAvd,
  deleteAvd,
  deviceAbis,
  deviceTranslation,
  discoverSdk,
  emptyTranslation,
  freeDiskGb,
  hostPreferredAbi,
  javaEnv,
  listAvds,
  listSystemImages,
  resolveAvdImage,
  sdkProblemSummary,
} from '../sdk.mjs';
import {
  adbDevices,
  deviceAvdName,
  forceStopApp,
  installApk,
  isBooted,
  launchApp,
  logcat as adbLogcat,
  resolveSerial,
  waitForBoot,
} from '../adb.mjs';
import { isAlive, readLogTail, startEmulator, stopEmulator } from '../emulator.mjs';
import { runScript } from '../exec.mjs';
import * as state from '../state.mjs';
import {
  arrayOf,
  buildResult,
  clamp,
  codeOf,
  messageOf,
  ms,
  objectSchema,
  prop,
  sleep,
  text,
  toolError,
  truncate,
} from '../schema.mjs';

/* ------------------------------------------------------------------ *
 * 工具骨架
 * ------------------------------------------------------------------ */

/**
 * 定义 / 注册一个工具。
 *
 * @param {{
 *   name: string,
 *   description: string,
 *   parameters: object,
 *   schema: object,
 *   defaults: (() => object) | object,
 *   render: (args: object, value: object) => Array<{ type: string, text: string }>,
 *   presentCall: (args: object) => object,
 *   execute: (args: object, R: ReturnType<typeof buildResult>, deps: object) => Promise<object>,
 * }} definition
 * @param {object} deps 插件级依赖（config）。
 * @returns {object} `ctx.tools.register` 接受的定义。
 */
function defineTool(definition, deps) {
  const R = buildResult(definition.defaults);
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: {
      schema: definition.schema,
      render: (args, value) => definition.render(args ?? {}, value ?? {}),
    },
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {};
      const session = sessionFor(deps, exec);
      try {
        const value = await definition.execute(input, R, deps, session);
        return fillSessionFields(value, session, deps?.config);
      } catch (error) {
        return fillSessionFields(R.fail(codeOf(error), messageOf(error)), session, deps?.config);
      }
    },
    presentCall: (args) => definition.presentCall(args ?? {}),
  };
}

/**
 * 统一补齐「会话相关」字段（v1.2.0）。
 *
 * 每个工具的成功/失败分支都可能忘记显式传这些字段，而 `defaults` 里只能给静态空值
 * （它不知道当前会话与配置）。这里在**结果出口**统一补：只补空值/非法值，不覆盖实现里
 * 已经算好的值。这样「每个 code 分支都带完整字段」由构造方式保证。
 *
 * - `sessionKey`：空串/undefined → 当前会话 key；
 * - `instanceLimit.max`：DESIGN §7.2 要求它总是 `config.maxInstances`（钳制 1..8）。
 *   fail-open 时走 `defaults` 会退化成 `0`，agent 会把它读成「本会话上限 0 台」，
 *   所以出口这里按配置兜一次——这是唯一一个不能靠「分支自己填」的字段（它不是
 *   本次调用的结果，而是配置的镜像）。
 *
 * @param {object} value 工具返回值。
 * @param {{ sessionKey: string, perSession: boolean }} session 会话上下文。
 * @param {object} [config] 插件配置（归一化后，`maxInstances` 已钳制 1..8）。
 */
function fillSessionFields(value, session, config) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.hasOwn(value, 'sessionKey') && (value.sessionKey === '' || value.sessionKey === undefined)) {
    value.sessionKey = session.sessionKey;
  }
  const limit = value.instanceLimit;
  if (limit !== null && typeof limit === 'object') {
    const max = limit.max;
    if (!(Number.isInteger(max) && max >= 1 && max <= 8)) {
      const configured = Number.isInteger(config?.maxInstances) ? config.maxInstances : 2;
      limit.max = Math.min(Math.max(configured, 1), 8);
    }
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * 公共辅助
 * ------------------------------------------------------------------ */

/**
 * 由执行上下文构建「会话上下文」，注入给每个工具实现（v1.2.0）。
 *
 * `key` 来自 `exec.agent.id`（dsh 的 SessionId）；`perSession:false` 时统一映射到
 * `shared-default`，退回 v1.1 的共享行为。工具内部所有 `state.*` 与 `resolveSerial`
 * 都带上它，从而做到"一个会话一台模拟器、绝不静默跨会话操作"。
 *
 * @param {{ config?: object }} deps 插件依赖。
 * @param {{ agent?: { id?: string } } | null | undefined} exec 工具执行上下文。
 * @returns {{ key: string, perSession: boolean }}
 */
function sessionFor(deps, exec) {
  const perSession = deps?.config?.perSession !== false;
  return { sessionKey: state.sessionKeyOf(exec, perSession), perSession };
}

/** SDK 的三件套空值（status 与各工具的默认值共用）。 */
function emptySdk() {
  return { found: false, root: '', adb: '', emulator: '', avdmanager: '', sdkmanager: '' };
}

/** 设备信息的空值。 */
function emptyDeviceInfo() {
  return { serial: '', state: '', booted: false, avd: '', abis: [] };
}

/** 系统的"没有 SDK"提示（带可执行下一步）。 */
function noSdkMessage(sdk) {
  return `找不到可用的 Android SDK：${sdkProblemSummary(sdk)} 下一步：安装 Android SDK（或设置环境变量 ANDROID_HOME），或在 cordis.patch.yml 里给 android-emulator 行配置 sdkPath（例如 sdkPath: 'C:\\Users\\<你>\\Android\\Sdk'）。`;
}

/** 发现 SDK，并要求它可用（否则抛 NO_SDK）。 */
async function loadSdk(config) {
  const sdk = await discoverSdk(config);
  if (sdk.found !== true) throw toolError('NO_SDK', noSdkMessage(sdk));
  return sdk;
}

/** 要求 SDK 带 adb。 */
function requireAdb(sdk) {
  if (sdk.adb === '') {
    throw toolError('NO_ADB', '找到了 SDK，但里面没有 adb（platform-tools）。下一步：在 SDK Manager 里安装 Android SDK Platform-Tools，或用 config.adbPath 指定 adb 的绝对路径。');
  }
}

/** 要求 SDK 带 emulator。 */
function requireEmulator(sdk) {
  if (sdk.emulator === '') {
    throw toolError('NO_EMULATOR', '找不到 emulator 可执行文件。下一步：在 SDK Manager 里安装 Android Emulator（SDK 的 emulator/ 目录下应出现 emulator.exe），或用 config.emulatorPath 指定。');
  }
}

/** 文件名里只保留 ASCII 安全字符（DESIGN：时间戳/文件名只用 ASCII）。 */
export function safeName(value) {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 60);
}

/* ------------------------------------------------------------------ *
 * 1. android_status
 * ------------------------------------------------------------------ */

const STATUS_EXECUTE = async (args, R, deps, session) => {
  const { config } = deps;
  const sdk = await discoverSdk(config);
  /** 投影成 schema 声明的 6 个键（discoverSdk 还带 problems，不能直接返回）。 */
  const sdkView = {
    found: sdk.found,
    root: sdk.root,
    adb: sdk.adb,
    emulator: sdk.emulator,
    avdmanager: sdk.avdmanager,
    sdkmanager: sdk.sdkmanager,
  };
  if (sdk.found !== true) {
    return R.fail('NO_SDK', noSdkMessage(sdk), { sdk: sdkView });
  }
  const sdkState = sdkView;
  const avds = await listAvds(sdk);
  const images = sdk.root === '' ? [] : await listSystemImages(sdk);
  const acceleration = sdk.emulator === '' ? { ok: false, kind: '', raw: '没有 emulator 可执行文件，无法检查硬件加速。' } : await accelCheck(sdk);

  let device = emptyDeviceInfo();
  // v1.1.0：ARM 转译能力。没有设备时保持空值（kind:"none"），探测失败同样不抛。
  let translation = emptyTranslation();
  const adbProblems = [];
  /** 所有**本插件管理**的实例（进程表是全量视图，sessionKey 用于归属展示）。 */
  let instances = [];
  let onlineSerials = new Set();
  const sessionAvdBase = config.avdNamePrefix !== '' ? config.avdNamePrefix : config.avdName;

  if (sdk.adb === '') {
    adbProblems.push('没有 adb，无法查看设备。');
  } else {
    try {
      const devices = await adbDevices(sdk.adb);
      onlineSerials = new Set(devices.filter((entry) => entry.state === 'device').map((entry) => entry.serial));
      // 本会话的设备：current → 本会话进程记录里的在线设备（**绝不把别人的设备当自己的**）。
      const current = state.getCurrent(session.sessionKey);
      const ownSerial =
        typeof current?.serial === 'string' && onlineSerials.has(current.serial)
          ? current.serial
          : (state.listProcessesBySession(session.sessionKey).find((record) => onlineSerials.has(record.serial))?.serial ?? '');
      if (ownSerial !== '') {
        const booted = await isBooted(sdk.adb, ownSerial);
        const avd = await deviceAvdName(sdk.adb, ownSerial);
        const abis = await deviceAbis(sdk.adb, ownSerial).catch(() => []);
        device = { serial: ownSerial, state: 'device', booted, avd, abis };
        if (booted) state.setCurrent(session.sessionKey, { serial: ownSerial, avd });
        translation = await deviceTranslation(sdk.adb, ownSerial);
      }
      // 实例列表：只列插件自己启动并记录过的设备（sessionKey 展示为短形式，避免泄露完整 id）。
      for (const record of state.listProcesses()) {
        const online = onlineSerials.has(record.serial);
        instances.push({
          sessionKey: state.shortSessionKey(record.sessionKey),
          serial: record.serial,
          avd: typeof record.avd === 'string' ? record.avd : '',
          pid: typeof record.pid === 'number' ? record.pid : 0,
          booted: online ? await isBooted(sdk.adb, record.serial).catch(() => false) : false,
          lastPackage: state.getLastPackage(record.sessionKey) ?? '',
        });
      }
      const other = devices.filter((entry) => entry.state !== 'device');
      if (other.length > 0) {
        adbProblems.push(`有设备但状态不可用：${other.map((entry) => `${entry.serial}=${entry.state}`).join('、')}。`);
      }
    } catch (error) {
      adbProblems.push(`adb devices 失败：${messageOf(error)}`);
    }
  }

  // v1.2.0 磁盘预算（DESIGN §7.3）：单台会话 AVD 实测 4–6.5 GB。
  const sessionAvds = avds.filter((entry) => state.isSessionAvdName(entry.name, sessionAvdBase));
  let sessionAvdTotalGb = 0;
  for (const entry of sessionAvds) {
    sessionAvdTotalGb += await avdDirSizeGb(entry.path).catch(() => 0);
  }
  const avdDisk = {
    sessionAvdCount: sessionAvds.length,
    totalGb: Math.round(sessionAvdTotalGb * 10) / 10,
    freeDiskGb: await freeDiskGb(config.outputDir),
  };
  const instanceLimit = {
    count: instances.filter((entry) => onlineSerials.has(entry.serial)).length,
    max: config.maxInstances,
  };

  const suggestions = [];
  if (sdk.adb === '') suggestions.push('安装 Android SDK Platform-Tools（adb），或用 config.adbPath 指定 adb 路径。');
  if (sdk.avdmanager === '') suggestions.push('安装 Android SDK Command-line Tools（avdmanager），否则无法创建 AVD。');
  if (sdk.emulator === '') suggestions.push('安装 Android Emulator，否则无法启动模拟器。');
  if (avds.length === 0) {
    suggestions.push('还没有 AVD：调用 android_avd_create 创建一台（会自动挑与主机匹配的 x86_64 系统镜像）。');
  } else if (device.serial === '') {
    suggestions.push(`已创建 AVD（${avds.map((entry) => entry.name).join('、')}）但没有运行中的模拟器：调用 android_emulator_start 启动。`);
  }
  if (device.serial !== '') {
    suggestions.push(device.booted ? `设备 ${device.serial} 已就绪：可以 android_apk_install 装包 → android_app_launch 启动 → android_screenshot / android_ui_dump 看界面。` : `设备 ${device.serial} 还在启动中：稍等后再次 android_status，或直接用 android_screenshot 试。`);
  }
  if (images.length === 0 && sdk.root !== '') {
    suggestions.push(`没有已安装的系统镜像：先用 sdkmanager 安装 system-images;android-35;google_apis;${hostPreferredAbi()}。`);
  } else if (images.length > 0 && !images.some((entry) => entry.abi === hostPreferredAbi())) {
    suggestions.push(`已安装的镜像没有 ${hostPreferredAbi()}（主机 ${process.arch}）：x86_64 主机上 arm64 镜像跑不起来，请安装 x86_64 镜像。`);
  }
  if (!acceleration.ok && sdk.emulator !== '') {
    suggestions.push('硬件加速不可用（WHPX/HAXM）：x86_64 模拟器会极慢或启动失败，先检查 Hyper-V/WHPX 是否启用。');
  }
  // v1.2.0 磁盘压力（DESIGN §7.3）：freeDiskGb < 8 必须给一条清理建议。
  if (avdDisk.freeDiskGb > 0 && avdDisk.freeDiskGb < 8) {
    suggestions.push(
      `磁盘剩余 ${avdDisk.freeDiskGb} GB，每个会话 AVD 约 4–6 GB；建议 android_emulator_stop { removeAvd: true } 回收本会话 AVD，或调小 maxInstances（当前 ${config.maxInstances}）。`,
    );
  }
  if (session.perSession && device.serial === '') {
    suggestions.push('本会话还没有模拟器：调用 android_emulator_start（会为本会话创建并启动专属 AVD，首次约 1 分钟）。');
  }
  if (adbProblems.length > 0) suggestions.push(...adbProblems);

  const lines = [
    `Android SDK：${sdk.root === '' ? `未找到 SDK 根目录（adb=${sdk.adb === '' ? '无' : sdk.adb}）` : sdk.root}`,
    `AVD：${avds.length === 0 ? '（无）' : avds.map((entry) => `${entry.name}[${entry.abi || entry.target || '?'}]`).join('、')}`,
    `系统镜像：${images.length === 0 ? '（无）' : `${images.length} 个，含 ${[...new Set(images.map((entry) => entry.abi))].join('/')}`}`,
    `会话：${state.shortSessionKey(session.sessionKey)}（perSession ${session.perSession ? '开启' : '关闭'}，本会话上限 ${config.maxInstances} 台）`,
    `设备：${device.serial === '' ? '本会话无运行中设备' : `${device.serial} · ${device.booted ? '已启动' : '启动中'}${device.avd === '' ? '' : ` · AVD ${device.avd}`}${device.abis.length === 0 ? '' : ` · ABI ${device.abis.join('/')}`}`}`,
    translationMessageLine(translation, device.serial !== ''),
    `实例：${instanceLimit.count}/${instanceLimit.max} 台在线${instances.length === 0 ? '' : `（${instances.map((entry) => `${entry.serial}@${entry.sessionKey}`).join('、')}）`}`,
    avdDisk.freeDiskGb > 0
      ? `磁盘：插件管理的会话 AVD ${avdDisk.sessionAvdCount} 个（跨会话，不只本会话）· ${avdDisk.totalGb} GB；剩余 ${avdDisk.freeDiskGb} GB`
      : `磁盘：插件管理的会话 AVD ${avdDisk.sessionAvdCount} 个（跨会话，不只本会话）· ${avdDisk.totalGb} GB；剩余空间未知（statfs 不可用）`,
    `硬件加速：${acceleration.ok ? acceleration.kind === '' ? '可用' : `可用（${acceleration.kind}）` : '不可用'}`,
  ];
  // 有设备且转译层可用时，补一句"能装什么包"，直接指导 agent 的下一步决策。
  if (device.serial !== '' && hasTranslationLayer(translation)) {
    const arm = [translation.arm64 ? 'arm64-v8a' : '', translation.arm32 ? 'armeabi-v7a' : ''].filter((entry) => entry !== '');
    lines.push(`可安装的 APK ABI：${[...device.abis].join('/') || '?'}${arm.length === 0 ? '' : `；ARM 包走转译（${arm.join('/')}，功能可用但性能低于原生）`}`);
  }
  if (suggestions.length > 0) lines.push('', '下一步建议：', ...suggestions.map((entry) => `- ${entry}`));

  return R.ok(lines.join('\n'), {
    sdk: sdkState,
    avds: avds.map((entry) => ({
      name: entry.name,
      target: entry.target,
      abi: entry.abi,
      path: entry.path,
      kind: state.isSessionAvdName(entry.name, sessionAvdBase)
        ? 'session-pinned'
        : entry.name === config.avdName
          ? 'template'
          : 'other',
    })),
    images: images.map((entry) => ({ package: entry.package, api: entry.api, tag: entry.tag, abi: entry.abi })),
    device,
    translation,
    acceleration,
    sessionKey: session.sessionKey,
    instances,
    instanceLimit,
    avdDisk,
    suggestions,
  });
};

/* ------------------------------------------------------------------ *
 * 2. android_avd_create
 * ------------------------------------------------------------------ */

const AVD_CREATE_EXECUTE = async (args, R, deps, session) => {
  const { config } = deps;
  const sdk = await loadSdk(config);
  if (sdk.avdmanager === '') {
    throw toolError('NO_AVD_MANAGER', '找不到 avdmanager，无法创建 AVD。下一步：在 SDK Manager 里安装 Android SDK Command-line Tools；或用 sdkmanager 手动安装后重试。');
  }

  const name = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : config.avdName;
  const existingAvds = await listAvds(sdk);
  const existing = existingAvds.find((entry) => entry.name === name);
  if (existing !== undefined && args.force !== true) {
    return R.fail(
      'AVD_CREATE_FAILED',
      `AVD ${name} 已经存在（${existing.path}）。下一步：直接 android_emulator_start 启动它；如果要按新镜像重建，加 force: true。`,
      { avd: name, image: existing.target, created: false, command: [] },
    );
  }

  let image = typeof args.image === 'string' ? args.image.trim() : '';
  if (image === '') {
    const images = await listSystemImages(sdk);
    const hostAbi = hostPreferredAbi();
    const preferred = images.filter((entry) => entry.abi === hostAbi);
    if (preferred.length === 0) {
      const installed = images.map((entry) => entry.package);
      return R.fail(
        'NO_IMAGE',
        images.length === 0
          ? `没有已安装的系统镜像。下一步：用 sdkmanager 安装与主机匹配的镜像 —— sdkmanager "system-images;android-35;google_apis;${hostAbi}"（主机 ${process.arch} 只能跑 ${hostAbi}）。`
          : `已安装的 ${images.length} 个镜像里没有 ${hostAbi}（主机 ${process.arch} 只能跑 ${hostAbi} 镜像；arm64 镜像在 x86_64 主机上跑不了）。现有：${installed.slice(0, 8).join('、')}${installed.length > 8 ? ' …' : ''}。下一步：sdkmanager "system-images;android-35;google_apis;${hostAbi}"。`,
        { avd: name, image: '', created: false, command: [] },
      );
    }
    image = preferred.sort((left, right) => right.api - left.api || left.package.localeCompare(right.package))[0].package;
  }

  const device = typeof args.device === 'string' && args.device.trim() !== '' ? args.device.trim() : '';
  const command = [sdk.avdmanager, 'create', 'avd', '-n', name, '-k', image];
  if (device !== '') command.push('--device', device);
  if (args.force === true) command.push('--force');

  const env = await javaEnv();
  const result = await runScript(command[0], command.slice(1), {
    timeoutMs: 180000,
    // avdmanager 会问 "Do you wish to create a custom hardware profile? [no]"，
    // 预先回答 no 才能非交互完成。
    input: 'no\n',
    ...(env === undefined ? {} : { env }),
  });

  if (result.error !== undefined) {
    const code = String(result.error.code ?? '');
    if (code === 'ENOENT') {
      throw toolError('NO_AVD_MANAGER', `找不到 avdmanager（${sdk.avdmanager}）或它依赖的 cmd.exe。下一步：安装 Android SDK Command-line Tools，或用 config.avdmanagerPath 指定。`);
    }
    if (code === 'EPERM' || code === 'EACCES') {
      throw toolError('SPAWN_DENIED', `启动 avdmanager 被拒绝（${code}）：当前会话权限不足。把会话切到 danger-full-access 后重试。`);
    }
    return R.fail('AVD_CREATE_FAILED', `avdmanager 启动失败（${code}）：${result.error.message}`, { avd: name, image, created: false, command });
  }
  if (result.timedOut === true) {
    return R.fail('TIMEOUT', 'avdmanager 超时（180 s）。它可能卡在下载镜像或等待输入；检查网络后重试。', { avd: name, image, created: false, command });
  }
  if (result.code !== 0) {
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const javaHint = /java|JAVA_HOME|JAVA EXCEPTION|Unable to locate/i.test(output)
      ? '（avdmanager 需要 JDK：设置 JAVA_HOME 指向 JDK 21 后重试，或把 JDK 的 bin 加进 PATH）'
      : '';
    return R.fail('AVD_CREATE_FAILED', `avdmanager 创建 AVD 失败（退出码 ${String(result.code)}）${javaHint}：${truncate(output === '' ? '没有任何输出' : output, 900)}`, {
      avd: name,
      image,
      created: false,
      command,
    });
  }

  const after = await listAvds(sdk);
  if (!after.some((entry) => entry.name === name)) {
    return R.fail(
      'AVD_CREATE_FAILED',
      `avdmanager 退出码是 0，但没有找到 AVD ${name}。下一步：检查 ANDROID_AVD_HOME / ~/.android/avd 是否可写，并确认 avdmanager 用的镜像 ${image} 已安装。`,
      { avd: name, image, created: false, command },
    );
  }

  return R.ok(`已创建 AVD ${name}（镜像 ${image}）。下一步：android_emulator_start（默认 headless 启动，首启可能需要一两分钟）。`, {
    avd: name,
    image,
    created: true,
    command,
  });
};

/* ------------------------------------------------------------------ *
 * 3. android_emulator_start
 * ------------------------------------------------------------------ */

const EMULATOR_START_EXECUTE = async (args, R, deps, session) => {
  const { config } = deps;
  const sdk = await loadSdk(config);
  requireAdb(sdk);
  requireEmulator(sdk);

  const timeoutMs = clamp(args.timeoutMs, 10000, 900000, config.bootTimeoutMs);
  const requestedAvd = typeof args.avd === 'string' ? args.avd.trim() : '';
  const headless = args.headless !== false;
  const cold = args.cold === true;
  const explicitPort = Number.isInteger(args.port) && args.port >= 5554 && args.port <= 5682 ? args.port : 0;

  // ⚠️ v1.1.0 实测结论（DESIGN §7.1）：**转译层无法通过命令行控制**。
  // `emulator -prop ro.dalvik.vm.native.bridge=…` 会被忽略（emulator 只接受 `qemu.*`
  // 属性，会告警 "only 'qemu.*' properties are supported"），启动后 getprop 仍是镜像
  // 默认值。所以这里**不提供任何"设置转译层"的参数**——只探测、不控制。
  // 留一个假开关比没有更糟：agent 会照着文档做对照实验，然后得到错误的因果结论。

  const before = await adbDevices(sdk.adb);
  const onlineBefore = before.filter((entry) => entry.state === 'device');
  let avds = await listAvds(sdk);
  const sessionBase = config.avdNamePrefix !== '' ? config.avdNamePrefix : config.avdName;

  // 1) 本会话 current 设备仍在线 → 复用（v1.2.0：**只复用本会话自己的**设备，绝不抢别人的）
  if (session.perSession) {
    const currentRecord = state.getCurrent(session.sessionKey);
    const currentSerial = typeof currentRecord?.serial === 'string' ? currentRecord.serial : '';
    if (currentSerial !== '') {
      if (onlineBefore.some((entry) => entry.serial === currentSerial)) {
        const serial = currentSerial;
        const booted = await waitForBoot(sdk.adb, serial, Math.min(timeoutMs, 120000));
        const avd = await deviceAvdName(sdk.adb, serial);
        state.setCurrent(session.sessionKey, { ...(currentRecord ?? state.emptyDevice()), serial, ...(avd === '' ? {} : { avd }) });
        const translation = await deviceTranslation(sdk.adb, serial);
        return R.ok(
          `本会话已有运行中的设备 ${serial}${avd === '' ? '' : `（AVD ${avd}）`}，直接复用、没有再启动新的。${booted ? '可以 android_apk_install 或 android_screenshot。' : '它仍在启动中，稍后再试。'} ${translationMessageLine(translation, true)}`,
          {
            serial,
            avd: avd === '' ? (currentRecord?.avd ?? '') : avd,
            pid: currentRecord?.pid ?? 0,
            bootedInMs: 0,
            logFile: currentRecord?.logFile ?? '',
            translation,
            sessionKey: session.sessionKey,
            createdAvd: false,
          },
        );
      }
      state.clearCurrent(session.sessionKey);
    }
  }

  // 2) 实例上限（DESIGN §7.2 第 4 条）：只统计**本插件管理**的在线实例，不误判用户手工启动的设备。
  if (session.perSession) {
    const onlineRecords = state
      .listProcesses()
      .filter((record) => onlineBefore.some((entry) => entry.serial === record.serial));
    if (onlineRecords.length >= config.maxInstances) {
      const occupants = onlineRecords
        .map((record) => `${record.serial}@${state.shortSessionKey(record.sessionKey)}`)
        .join('、');
      return R.fail(
        'DEVICE_BUSY',
        `同时运行的模拟器已达上限 ${config.maxInstances} 台（${occupants}）。下一步：让其它会话调用 android_emulator_stop 释放（本工具只能停本会话的设备），或把 config.maxInstances 调大——注意每个会话 AVD 约占 4–6.5 GB 磁盘，当前剩余 ${await freeDiskGb(config.outputDir)} GB。`,
        { sessionKey: session.sessionKey },
      );
    }
  }

  // 3) 解析 AVD：perSession 时用「本会话专属 AVD」（不存在则从模板镜像创建）
  let avd = requestedAvd;
  let createdAvd = false;
  if (avd === '') avd = sessionBase;
  const isSessionAvd = session.perSession && avd === sessionBase;
  if (isSessionAvd) {
    avd = state.sessionAvdName(sessionBase, session.sessionKey);
    if (!avds.some((entry) => entry.name === avd)) {
      if (sdk.avdmanager === '') {
        throw toolError('NO_AVD_MANAGER', '找不到 avdmanager，无法为当前会话创建专属 AVD。下一步：在 SDK Manager 里安装 Android SDK Command-line Tools。');
      }
      const resolved = await resolveAvdImage(sdk, config.avdName);
      if (resolved.image === '') {
        throw toolError('NO_IMAGE', `没有可用的系统镜像，无法创建会话专属 AVD。下一步：sdkmanager "system-images;android-35;google_apis;${hostPreferredAbi()}"。`);
      }
      const created = await createAvd(sdk, {
        name: avd,
        image: resolved.image,
        device: resolved.templateAvd?.device ?? '',
      });
      if (created.error !== undefined || created.timedOut === true || created.code !== 0) {
        const output = `${created.stdout ?? ''}\n${created.stderr ?? ''}`.trim();
        return R.fail(
          'AVD_CREATE_FAILED',
          `为当前会话创建专属 AVD ${avd} 失败（${created.error?.code ?? `退出码 ${String(created.code)}`}）：${truncate(output === '' ? '没有任何输出' : output, 700)}。下一步：确认 avdmanager 可用（JAVA_HOME）与镜像 ${resolved.image} 已安装；也可用 android_avd_create 手动创建后指定 avd 参数。`,
          { sessionKey: session.sessionKey, avd, createdAvd: false },
        );
      }
      createdAvd = true;
      avds = await listAvds(sdk);
    }
  } else if (!avds.some((entry) => entry.name === avd)) {
    throw toolError(
      'NO_AVD',
      `AVD ${avd} 不存在${avds.length === 0 ? '' : `（现有：${avds.map((entry) => entry.name).join('、')}）`}。下一步：android_avd_create 创建，或把 config.avdName 改成已有名字。`,
    );
  }

  // 4) 端口：perSession 时从 5554 起按 slot 找第一个空闲（5554 + 2*slot），显式 port 优先。
  let port = explicitPort;
  if (port === 0 && session.perSession) {
    const taken = new Set([
      ...onlineBefore.map((entry) => entry.serial),
      ...state.listProcesses().map((record) => record.serial),
    ]);
    for (let slot = 0; slot < 16; slot += 1) {
      const candidate = 5554 + 2 * slot;
      if (!taken.has(`emulator-${candidate}`)) {
        port = candidate;
        break;
      }
    }
  }

  const logFile = path.join(config.outputDir, `emulator-${safeName(avd)}.log`);
  const startedAt = Date.now();
  // DESIGN §7.3：会话 AVD 一律加 `-no-snapshot`（在 `-no-snapshot-save` 之外）——
  // 不需要快照加速（冷启动 40–75 s 可接受），而快照的 ram.img 每台约 2.5 GB。
  const handle = await startEmulator({
    emulator: sdk.emulator,
    avd,
    logFile,
    headless,
    cold: cold || isSessionAvd,
    port,
    extraArgs: config.emulatorArgs,
  });

  // 等新设备出现在 adb devices 里（用启动前后的差集，支持 -port 多开）。
  let serial = '';
  const knownSerials = new Set(before.map((entry) => entry.serial));
  const deadline = startedAt + timeoutMs;
  while (Date.now() < deadline) {
    const spawnError = handle.getError();
    if (spawnError !== null) {
      const denied = spawnError.code === 'EPERM' || spawnError.code === 'EACCES';
      return R.fail(
        denied ? 'SPAWN_DENIED' : 'EMULATOR_START_FAILED',
        denied
          ? `启动 emulator 被拒绝（${spawnError.code}）：当前会话权限不足。把会话切到 danger-full-access 后重试。`
          : `启动 emulator 失败（${spawnError.code}）：${spawnError.message}`,
        { serial: '', avd, pid: handle.pid, bootedInMs: 0, logFile },
      );
    }
    const now = await adbDevices(sdk.adb).catch(() => []);
    const candidate = now.find((entry) => entry.serial.startsWith('emulator-') && !knownSerials.has(entry.serial));
    if (candidate !== undefined) {
      serial = candidate.serial;
      break;
    }
    if (!isAlive(handle.pid)) {
      const tail = await readLogTail(logFile);
      return R.fail(
        'EMULATOR_START_FAILED',
        `模拟器进程 ${handle.pid} 启动后立刻退出了。下一步：看日志 ${logFile} 的尾部（常见原因：AVD 损坏、硬件加速不可用、镜像与主机 ABI 不匹配）。${tail === '' ? '' : `日志尾部：${truncate(tail, 1200)}`}`,
        { serial: '', avd, pid: handle.pid, bootedInMs: 0, logFile },
      );
    }
    await sleep(2000);
  }

  if (serial === '') {
    await stopEmulator({ adb: sdk.adb, pid: handle.pid, timeoutMs: 15000 });
    const tail = await readLogTail(logFile);
    return R.fail(
      'BOOT_TIMEOUT',
      `等了 ${ms(timeoutMs)}，adb devices 里始终没有出现新的模拟器（进程 ${handle.pid} 已终止）。下一步：加大 timeoutMs 重试；若反复失败，检查硬件加速（android_status 的 acceleration）以及日志 ${logFile}。${tail === '' ? '' : `日志尾部：${truncate(tail, 1200)}`}`,
      { serial: '', avd, pid: handle.pid, bootedInMs: 0, logFile },
    );
  }

  state.setProcess(serial, { pid: handle.pid, avd, logFile, startedAt, sessionKey: session.sessionKey });

  // 设备出现 ≠ 启动完成：还要等 sys.boot_completed == 1。
  const booted = await waitForBoot(sdk.adb, serial, Math.max(deadline - Date.now(), 15000));
  const bootedInMs = Date.now() - startedAt;
  if (!booted) {
    await stopEmulator({ adb: sdk.adb, serial, pid: handle.pid, timeoutMs: 20000 });
    state.deleteProcess(serial);
    const tail = await readLogTail(logFile);
    return R.fail(
      'BOOT_TIMEOUT',
      `模拟器 ${serial} 已经出现，但 ${ms(timeoutMs)} 内没有完成启动（sys.boot_completed 没到 1），已终止。下一步：加大 timeoutMs 重试（冷启动首次可能很慢），并确认硬件加速可用。日志 ${logFile}${tail === '' ? '' : ` 尾部：${truncate(tail, 1000)}`}`,
      { serial, avd, pid: handle.pid, bootedInMs, logFile },
    );
  }

  state.setCurrent(session.sessionKey, { serial, avd, pid: handle.pid, logFile, startedAt });

  // v1.1.0：启动完成后探测**实际生效**的转译层。注意这只是"报告镜像能力"，
  // 插件没有任何办法改变它（见上面 -prop 的实测结论），所以文案里明确「由镜像决定」。
  const translation = await deviceTranslation(sdk.adb, serial);
  const bridgeValue =
    translation.bridge === ''
      ? '未启用'
      : `${translation.bridge}${translation.version === '' ? '' : ` ${translation.version}`}`;
  const bridgeReport =
    translation.kind === 'ndk-translation'
      ? ` ARM 转译：${bridgeValue}（arm64 ${translation.arm64 ? '可用' : '不可用'} / arm32 ${translation.arm32 ? '可用' : '不可用'}，由镜像决定；插件只能探测、无法通过参数开启或关闭）。`
      : translation.kind === 'houdini'
        ? ` ARM 转译：houdini（由镜像决定；插件只能探测、无法通过参数开启或关闭）。`
        : '';
  const perfNote = hasTranslationLayer(translation) ? ' 提示：该模拟器可跑 ARM 包（走转译，性能低于原生，不要用其耗时判断真机性能）。' : '';

  // DESIGN §7.3：磁盘余量 < 8 GB 时**不失败**，只在 message 尾部警示（让用户自己决定）。
  const freeGb = await freeDiskGb(config.outputDir);
  const diskWarning =
    freeGb > 0 && freeGb < 8
      ? ` ⚠️ 磁盘剩余仅 ${freeGb} GB：每个会话 AVD 约占 4–6.5 GB，建议用 android_emulator_stop { removeAvd: true } 回收本会话 AVD。`
      : '';

  return R.ok(
    `模拟器已启动：${serial}（AVD ${avd}${createdAvd ? '，本次新建' : ''}，pid ${handle.pid}，耗时 ${ms(bootedInMs)}），日志：${logFile}。${translationMessageLine(translation, true)}${bridgeReport}${perfNote}${diskWarning} 下一步：android_apk_install 安装 APK（ARM 包会走转译），然后 android_app_launch。`,
    { serial, avd, pid: handle.pid, bootedInMs, logFile, translation, sessionKey: session.sessionKey, createdAvd },
  );
};

/* ------------------------------------------------------------------ *
 * 4. android_emulator_stop
 * ------------------------------------------------------------------ */

/**
 * 删除本会话专属 AVD（DESIGN §7.3：释放 4–6.5 GB）。
 *
 * 抽成函数是因为它有**两个**入口：正常停止后删除，以及「设备本来就没在跑、
 * 但用户要求回收磁盘」时删除（2026-10-26 真机回归发现的缺口：以前只有前者，
 * 于是 `stop` 之后再 `stop { removeAvd: true }` 永远是 no-op，磁盘回收不了）。
 *
 * @param {object} sdk discoverSdk 的结果。
 * @param {string} avdName 本会话专属 AVD 名。
 * @returns {Promise<{ removedAvd: string, freedGb: number, failure: string }>} 结果；失败时 failure 为可展示的原因。
 */
async function removeOwnSessionAvd(sdk, avdName) {
  const avds = await listAvds(sdk).catch(() => []);
  const target = avds.find((entry) => entry.name === avdName);
  if (target === undefined) return { removedAvd: '', freedGb: 0, failure: '' };
  const freedGb = await avdDirSizeGb(target.path).catch(() => 0);
  const deleted = await deleteAvd(sdk, avdName);
  if (deleted.error !== undefined || deleted.timedOut === true || deleted.code !== 0) {
    const output = `${deleted.stdout ?? ''}\n${deleted.stderr ?? ''}`.trim();
    return {
      removedAvd: '',
      freedGb: 0,
      failure: `删除会话 AVD ${avdName} 失败（${deleted.error?.code ?? `退出码 ${String(deleted.code)}`}）：${truncate(output === '' ? '没有任何输出' : output, 500)}。下一步：手工删除 ~/.android/avd/${avdName}.avd，或确认 avdmanager 可用。`,
    };
  }
  return { removedAvd: avdName, freedGb, failure: '' };
}

const EMULATOR_STOP_EXECUTE = async (args, R, deps, session) => {
  const { config } = deps;
  const sdk = await discoverSdk(config);
  if (sdk.found !== true) throw toolError('NO_SDK', noSdkMessage(sdk));

  const devices = sdk.adb === '' ? [] : await adbDevices(sdk.adb).catch(() => []);
  const all = args.all === true;
  const removeAvd = args.removeAvd === true;
  const sessionBase = config.avdNamePrefix !== '' ? config.avdNamePrefix : config.avdName;
  const ownSessionAvd = state.sessionAvdName(sessionBase, session.sessionKey);
  const ownRecords = state.listProcessesBySession(session.sessionKey);

  /** @type {Array<{ serial: string, pid: number }>} */
  const targets = [];
  if (all) {
    // DESIGN §7.2 第 5 条：`all:true` 只停**本会话**的全部，不碰别的会话。
    for (const record of ownRecords) targets.push({ serial: record.serial, pid: record.pid });
  } else {
    const wanted = typeof args.serial === 'string' ? args.serial.trim() : '';
    let serial = wanted;
    if (serial === '') {
      const current = state.getCurrent(session.sessionKey);
      serial = typeof current?.serial === 'string' ? current.serial : '';
    }
    if (serial === '' && ownRecords.length === 1) serial = ownRecords[0].serial;
    if (serial === '') {
      // 没有运行中的设备时 removeAvd 仍然要能回收本会话专属 AVD（v1.2.0 真机回归发现的
      // 缺口：早退分支以前直接 return，导致「先 stop、再 stop{removeAvd:true}」第二步
      // 永远删不掉 AVD，磁盘只增不减）。
      let removedAvd = '';
      let freedGb = 0;
      if (removeAvd) {
        const removal = await removeOwnSessionAvd(sdk, ownSessionAvd);
        if (removal.failure !== '') {
          return R.fail('INTERNAL', `没有运行中的模拟器，但${removal.failure}`, { serial: '', stopped: true, removedAvd: '' });
        }
        removedAvd = removal.removedAvd;
        freedGb = removal.freedGb;
      }
      const avdNote = removedAvd === '' ? '' : ` 已删除本会话专属 AVD ${removedAvd}，释放约 ${freedGb} GB。`;
      return R.ok(
        `本会话（${state.shortSessionKey(session.sessionKey)}）没有运行中的模拟器，不需要停止。${avdNote}`,
        { serial: '', stopped: true, removedAvd },
      );
    }
    // 归属守卫：显式/记录里的 serial 属于别的会话 → DEVICE_BUSY（绝不静默停）。
    const owner = state.processOwner(serial);
    if (session.perSession && owner !== '' && owner !== session.sessionKey) {
      return R.fail(
        'DEVICE_BUSY',
        `设备 ${serial} 属于另一个会话（${state.shortSessionKey(owner)}），不能跨会话停止。本会话可停的设备：${ownRecords.length === 0 ? '（无）' : ownRecords.map((record) => record.serial).join('、')}。`,
        { serial, stopped: false, removedAvd: '' },
      );
    }
    const record = state.getProcess(serial);
    const deviceKnown = devices.some((entry) => entry.serial === serial);
    if (!deviceKnown && record === null) {
      // 设备本就不在运行：幂等成功（但仍可在 removeAvd 请求下清理残留 AVD）。
      targets.push({ serial, pid: 0 });
    } else {
      targets.push({ serial, pid: record?.pid ?? 0 });
    }
  }

  const outcomes = [];
  let stopped = true;
  for (const target of targets) {
    const pid = target.pid > 0 ? target.pid : state.getProcess(target.serial)?.pid ?? 0;
    const result = await stopEmulator({ adb: sdk.adb, serial: target.serial, pid, timeoutMs: 30000 });
    state.deleteProcess(target.serial);
    const current = state.getCurrent(session.sessionKey);
    if (current !== null && current.serial === target.serial) state.clearCurrent(session.sessionKey);
    if (!result.stopped) stopped = false;
    outcomes.push(`${target.serial}：${result.detail}`);
  }

  // DESIGN §7.3：removeAvd → 停稳后删除本会话专属 AVD（释放 4–6.5 GB）。
  let removedAvd = '';
  let freedGb = 0;
  if (removeAvd && stopped) {
    const removal = await removeOwnSessionAvd(sdk, ownSessionAvd);
    if (removal.failure !== '') {
      return R.fail('INTERNAL', `设备已停止，但${removal.failure}`, {
        serial: targets.map((entry) => entry.serial).join(','),
        stopped,
        removedAvd: '',
      });
    }
    removedAvd = removal.removedAvd;
    freedGb = removal.freedGb;
  }

  const serialField = targets.map((entry) => entry.serial).join(',');
  const avdNote = removedAvd === '' ? '' : ` 已删除本会话专属 AVD ${removedAvd}，释放约 ${freedGb} GB。`;
  const message = stopped
    ? `已停止本会话 ${targets.length} 台模拟器（${outcomes.join('；')}）。${avdNote}${targets.length === 0 ? '' : ''}`
    : `停止请求已发出，但仍有设备没有消失（${outcomes.join('；')}）。下一步：稍后再 android_status 确认，或重试 android_emulator_stop。`;
  return stopped
    ? R.ok(message, { serial: serialField, stopped, removedAvd })
    : R.fail('TIMEOUT', message, { serial: serialField, stopped, removedAvd });
};

/* ------------------------------------------------------------------ *
 * 5. android_apk_install
 * ------------------------------------------------------------------ */

/**
 * 选"实际会被系统使用"的 ABI。
 *
 * **必须按设备的 abilist 顺序遍历**：那是 Android 的 ABI 偏好顺序，系统选
 * `primaryCpuAbi` 也按它。真机实测（Lead 2026-10-24）：设备
 * `["x86_64","arm64-v8a"]`、APK `["arm64-v8a","armeabi-v7a","x86_64"]`
 * → 必须返回 `x86_64`；按 APK 顺序遍历会错选 `arm64-v8a`，误导 agent。
 *
 * @param {string[]} deviceAbiList 设备支持的 ABI（`ro.product.cpu.abilist` 顺序）。
 * @param {string[]} apkAbiList APK 里的 ABI（zip 中 `lib/<abi>/` 顺序）。
 * @returns {string} 匹配到的 ABI；纯 Java APK 返回 "no-native"；不匹配返回空串。
 */
export function pickMatchedAbi(deviceAbiList, apkAbiList) {
  const device = Array.isArray(deviceAbiList) ? deviceAbiList : [];
  const apk = Array.isArray(apkAbiList) ? apkAbiList : [];
  if (apk.length === 0) return 'no-native';
  return device.find((entry) => apk.includes(entry)) ?? '';
}

/* ------------------------------------------------------------------ *
 * v1.1.0：ARM 转译层（DESIGN §7.1）
 * ------------------------------------------------------------------ */

/** 设备的原生 ABI（x86 语义）。 */
const NATIVE_ABIS = ['x86_64', 'x86'];

/** ARM ABI（能否运行取决于"原生 ARM 真机"或"转译层"）。 */
const ARM_ABIS = ['arm64-v8a', 'armeabi-v7a', 'armeabi'];

/**
 * 判定 `android_apk_install.abiKind`（DESIGN §7 / §7.1）。
 *
 * - `matchedAbi` 是 x86_64 / x86 → `"native"`；
 * - `matchedAbi` 是 ARM ABI 且设备有转译层（kind 为 `ndk-translation` / `houdini`）→ `"translated"`；
 *   ARM 真机（kind=`native`）上 ARM 库是原生的 → 仍为 `"native"`；
 * - 纯 Java APK（`no-native`）或没有匹配 → `"none"`。
 *
 * 实测（Lead 2026-10-24）：x86_64 镜像 abilist=`x86_64,arm64-v8a`、kind=`ndk-translation`，
 * 装原始 arm-only APK → matchedAbi=`arm64-v8a`、abiKind=`translated`。
 *
 * @param {string} matchedAbi 选中的 ABI（`pickMatchedAbi` 的结果）。
 * @param {object} translation `deviceTranslation()` 的结果。
 * @returns {'native'|'translated'|'none'}
 */
export function classifyAbiKind(matchedAbi, translation) {
  if (typeof matchedAbi !== 'string' || matchedAbi === '' || matchedAbi === 'no-native') return 'none';
  if (NATIVE_ABIS.includes(matchedAbi)) return 'native';
  if (ARM_ABIS.includes(matchedAbi)) {
    const kind = typeof translation?.kind === 'string' ? translation.kind : 'none';
    return kind === 'ndk-translation' || kind === 'houdini' ? 'translated' : 'native';
  }
  return 'native';
}

/**
 * `ABI_MISMATCH` 的针对性 message（DESIGN §7.1：三种情况不能笼统只说"重建 x86_64"）。
 *
 * @param {{ apkAbis: string[], deviceAbis: string[], translation: object, serial: string }} input
 * @returns {string}
 */
export function abiMismatchMessage(input) {
  const apk = Array.isArray(input?.apkAbis) ? input.apkAbis : [];
  const device = Array.isArray(input?.deviceAbis) ? input.deviceAbis : [];
  const translation = input?.translation ?? {};
  const serial = typeof input?.serial === 'string' ? input.serial : '';
  const arm64InApk = apk.includes('arm64-v8a');
  const arm32Only = !arm64InApk && apk.some((entry) => entry === 'armeabi-v7a' || entry === 'armeabi');
  const head = `ABI 不匹配，已跳过安装：APK 只含 [${apk.join(', ')}]，设备 ${serial} 只支持 [${device.join(', ')}]（转译能力：kind=${translation.kind ?? 'none'}，arm64=${translation.arm64 === true}，arm32=${translation.arm32 === true}）。`;

  if (arm32Only && translation.arm32 !== true) {
    return `${head} 原因是**32 位 ARM（armeabi-v7a）**：官方 Android Emulator 已无 32 位 ARM 转译层/镜像（ro.product.cpu.abilist32 为空），32 位 ARM APK 无法在官方模拟器运行。下一步：改用含 arm64-v8a 或 x86_64 的包（在 build.gradle 的 defaultConfig.ndk.abiFilters 里加对应 ABI 重建），不要继续尝试安装这个包。`;
  }
  if (arm64InApk) {
    return `${head} 原因是 APK 含 64 位 ARM（arm64-v8a），但当前设备既不原生支持、也没有可用的 ARM64 转译层。下一步：① 用 Gradle 重建含 x86_64 的 APK（abiFilters 加 "x86_64"）；或 ② 换一个自带 libndk_translation 的 x86_64 系统镜像（google_apis 系列通常自带）后重试。`;
  }
  return `${head} 下一步：用 Gradle 重建含 x86_64（或 arm64-v8a）的 APK（defaultConfig.ndk.abiFilters 加对应 ABI），再重新调用本工具。`;
}

/**
 * `android_status` message 里的「ARM 转译」一行（人类可读）。
 *
 * @param {object} translation `deviceTranslation()` 的结果。
 * @param {boolean} hasDevice 是否有运行中的设备可探测。
 * @returns {string}
 */
export function translationMessageLine(translation, hasDevice) {
  if (hasDevice !== true) return 'ARM 转译：未检测（没有运行中的设备）';
  const t = translation ?? {};
  const bridge = typeof t.bridge === 'string' ? t.bridge : '';
  const kind = typeof t.kind === 'string' ? t.kind : 'none';
  const arm64 = t.arm64 === true;
  const arm32 = t.arm32 === true;
  if (kind === 'none' && bridge === '' && !arm64 && !arm32) {
    return 'ARM 转译：未启用（只能跑 x86_64）';
  }
  const name = bridge !== '' ? bridge.replace(/\.so$/u, '') : kind === 'native' ? '原生 ARM' : kind;
  const version = typeof t.version === 'string' && t.version !== '' ? ` ${t.version}` : '';
  const state = kind === 'none' ? '未启用' : t.enabled === false ? '未启用' : '';
  return `ARM 转译：${name}${version}${state === '' ? '' : `（${state}）`}（${arm64 ? 'arm64 可用' : 'arm64 不可用'} / ${arm32 ? 'arm32 可用' : 'arm32 不可用'}）`;
}

/**
 * 走转译时的性能提醒（DESIGN §7.1 要求出现在 `tips` 与 `message`）。
 *
 * @param {object} translation `deviceTranslation()` 的结果。
 * @returns {string}
 */
export function translationPerformanceTip(translation) {
  const t = translation ?? {};
  const name = typeof t.bridge === 'string' && t.bridge !== '' ? t.bridge : 'libndk_translation';
  const version = typeof t.version === 'string' && t.version !== '' ? t.version : '';
  return `该 APK 通过 ARM 转译（${name}${version === '' ? '' : ` ${version}`}）运行：功能可用，但性能低于原生；**不要用转译下的耗时判断真机性能**，大计算（如 ONNX 推理）可能明显变慢。`;
}

/** 是否有可用的转译层（ndk-translation / houdini）——用于决定是否附性能提醒。 */
export function hasTranslationLayer(translation) {
  const kind = typeof translation?.kind === 'string' ? translation.kind : 'none';
  return kind === 'ndk-translation' || kind === 'houdini';
}

/** 读设备的包名集合（安装前后差集兜底用）。 */
async function listPackages(adb, serial) {
  const { adbShell } = await import('../adb.mjs');
  const result = await adbShell(adb, serial, ['pm', 'list', 'packages'], { timeoutMs: 30000 });
  const packages = new Set();
  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('package:')) packages.add(trimmed.slice('package:'.length).trim());
  }
  return packages;
}

/** 用 dumpsys 读已安装包的版本（manifest 解析失败时兜底）。 */
async function installedVersion(adb, serial, packageName) {
  const { adbShell } = await import('../adb.mjs');
  const result = await adbShell(adb, serial, ['dumpsys', 'package', packageName], { timeoutMs: 30000 });
  const source = String(result.stdout ?? '');
  const versionName = /versionName=(\S+)/.exec(source)?.[1] ?? '';
  const versionCode = Number.parseInt(/versionCode=(\d+)/.exec(source)?.[1] ?? '0', 10) || 0;
  return { versionName, versionCode };
}

const APK_INSTALL_EXECUTE = async (args, R, deps, session) => {
  const { config } = deps;
  const rawPath = typeof args.apk === 'string' ? args.apk.trim() : '';
  if (rawPath === '') throw toolError('BAD_ARGUMENT', 'apk 参数是必填的：请给 APK 的绝对路径（例如 E:\\项目\\build\\app-debug.apk）。');
  const apkPath = path.resolve(rawPath);

  let info;
  try {
    info = await stat(apkPath);
  } catch {
    info = null;
  }
  if (info === null) {
    return R.fail(
      'APK_NOT_FOUND',
      `找不到 APK：${apkPath}。下一步：确认路径（建议传绝对路径）；在 Windows 上中文路径没问题，但要用完整路径而不是相对路径。`,
      { package: '', versionName: '', versionCode: 0, abis: [], deviceAbis: [], matchedAbi: '', installedInMs: 0, tips: [] },
    );
  }
  if (!info.isFile()) {
    return R.fail('APK_UNREADABLE', `${apkPath} 不是文件。下一步：给 APK 文件本身的路径，而不是目录。`, {
      package: '',
      versionName: '',
      versionCode: 0,
      abis: [],
      deviceAbis: [],
      matchedAbi: '',
      installedInMs: 0,
      tips: [],
    });
  }

  const sdk = await loadSdk(config);
  requireAdb(sdk);

  let apk;
  try {
    apk = await apkInfo(apkPath);
  } catch (error) {
    return R.fail(codeOf(error, 'APK_UNREADABLE'), `${messageOf(error)} 下一步：确认这是一个有效的 APK（用 Android Studio 或 gradle 打出来的包），而不是占位/损坏文件。`, {
      package: '',
      versionName: '',
      versionCode: 0,
      abis: [],
      deviceAbis: [],
      matchedAbi: '',
      installedInMs: 0,
      tips: [],
    });
  }

  const serial = await resolveSerial(sdk.adb, args.serial, session);
  // v1.1.0：探测 ARM 转译层（决定 abiKind，以及 ABI_MISMATCH 时该给哪一种针对性建议）。
  const translation = await deviceTranslation(sdk.adb, serial);
  const deviceAbiList = await deviceAbis(sdk.adb, serial).catch(() => []);
  const tips = [];

  // 安装前 ABI 预检（DESIGN §7 的硬要求）：不匹配就别浪费时间 install。
  let matchedAbi = '';
  let abiKind = 'none';
  if (apk.abis.length === 0) {
    matchedAbi = 'no-native';
    abiKind = 'none';
    tips.push('这个 APK 不含 native 库（纯 Java/Kotlin），因此没有 ABI 限制。');
  } else {
    // 按设备 abilist 的偏好顺序选（见 pickMatchedAbi 的注释：不能按 APK 顺序）。
    matchedAbi = pickMatchedAbi(deviceAbiList, apk.abis);
    if (matchedAbi === '') {
      return R.fail(
        'ABI_MISMATCH',
        abiMismatchMessage({ apkAbis: apk.abis, deviceAbis: deviceAbiList, translation, serial }),
        {
          package: apk.package,
          versionName: apk.versionName,
          versionCode: apk.versionCode,
          abis: apk.abis,
          deviceAbis: deviceAbiList,
          matchedAbi: '',
          abiKind: 'none',
          translation,
          installedInMs: 0,
          tips,
        },
      );
    }
    abiKind = classifyAbiKind(matchedAbi, translation);
    const kindText = abiKind === 'translated' ? 'ARM 转译' : abiKind === 'native' ? '原生' : '未知';
    tips.push(`ABI 匹配：设备 ${deviceAbiList.join('/')} ∩ APK ${apk.abis.join('/')} → ${matchedAbi}（${kindText}）。`);
    if (abiKind === 'translated') {
      // DESIGN §7.1：translated 时 tips 必须有性能提醒。
      tips.push(translationPerformanceTip(translation));
    }
  }

  // manifest 解析不到包名时，用安装前后的 pm list packages 差集兜底。
  let beforePackages = null;
  if (apk.package === '') {
    beforePackages = await listPackages(sdk.adb, serial).catch(() => null);
    tips.push('APK 的 AndroidManifest 里没解析出包名，安装后会用 pm list packages 差集推断。');
  }

  const installStartedAt = Date.now();
  const result = await installApk(sdk.adb, serial, apkPath, {
    grant: args.grantPermissions !== false,
    reinstall: args.reinstall !== false,
  });
  const installedInMs = Date.now() - installStartedAt;
  const output = `${result.stdout}\n${result.stderr}`.trim();

  if (result.error !== undefined) {
    const code = String(result.error.code ?? '');
    if (code === 'EPERM' || code === 'EACCES') throw toolError('SPAWN_DENIED', `启动 adb 被拒绝（${code}）：当前会话权限不足。把会话切到 danger-full-access 后重试。`);
    return R.fail('INSTALL_FAILED', `adb install 启动失败（${code}）：${result.error.message}`, {
      package: apk.package,
      versionName: apk.versionName,
      versionCode: apk.versionCode,
      abis: apk.abis,
      deviceAbis: deviceAbiList,
      matchedAbi,
      abiKind,
      translation,
      installedInMs,
      tips,
    });
  }
  if (result.timedOut === true) {
    return R.fail('TIMEOUT', `adb install 超时（180 s）。下一步：APK 可能太大或设备卡住，先 android_status 确认设备还在，再重试。`, {
      package: apk.package,
      versionName: apk.versionName,
      versionCode: apk.versionCode,
      abis: apk.abis,
      deviceAbis: deviceAbiList,
      matchedAbi,
      abiKind,
      translation,
      installedInMs,
      tips,
    });
  }
  if (result.code !== 0 || /Failure|Error/i.test(output) || !/Success/i.test(output)) {
    const hint =
      /INSUFFICIENT_STORAGE/i.test(output)
        ? '设备存储不足：先卸载不用的应用或扩容 AVD 的 data 分区。'
        : /INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(output)
          ? '设备上已有同包名但签名不同的应用：加 reinstall（默认已加 -r）不够时，先在设备上卸载旧包，或用 grantPermissions: false 重试。'
          : /INSTALL_FAILED_NO_MATCHING_ABIS/i.test(output)
            ? '设备 ABI 不匹配：重建含 x86_64 的 APK。'
            : /INSTALL_FAILED_VERSION_DOWNGRADE/i.test(output)
              ? '版本降级被拒：加 -d 参数需要改插件；更简单的是先卸载已装的更高版本。'
              : '下一步：android_logcat 看设备端有没有更具体的原因，或先用 adb uninstall 卸载旧包再装。';
    return R.fail('INSTALL_FAILED', `安装失败（退出码 ${String(result.code)}）：${truncate(output === '' ? '没有任何输出' : output, 900)} ${hint}`, {
      package: apk.package,
      versionName: apk.versionName,
      versionCode: apk.versionCode,
      abis: apk.abis,
      deviceAbis: deviceAbiList,
      matchedAbi,
      abiKind,
      translation,
      installedInMs,
      tips,
    });
  }

  // 包名兜底：安装前后差集。
  let packageName = apk.package;
  if (packageName === '' && beforePackages !== null) {
    const afterPackages = await listPackages(sdk.adb, serial).catch(() => null);
    if (afterPackages !== null) {
      const added = [...afterPackages].filter((entry) => !beforePackages.has(entry));
      if (added.length > 0) packageName = added[0];
    }
  }

  // 版本兜底：dumpsys package。
  let versionName = apk.versionName;
  let versionCode = apk.versionCode;
  if (packageName !== '' && (versionName === '' || versionCode === 0)) {
    const installed = await installedVersion(sdk.adb, serial, packageName).catch(() => ({ versionName: '', versionCode: 0 }));
    if (versionName === '') versionName = installed.versionName;
    if (versionCode === 0) versionCode = installed.versionCode;
  }

  if (packageName !== '') state.rememberPackage(session.sessionKey, packageName);
  else tips.push('没推断出包名：后续工具请显式传 package 参数。');
  tips.push('首次启动应用可能较慢，android_app_launch 之后建议 android_ui_wait 等首屏。');

  // DESIGN §7.1：`abiKind:"translated"` 时 message 也必须有性能提醒（tips 里已加一份）。
  const translatedNote = abiKind === 'translated' ? ` ${translationPerformanceTip(translation)}` : '';
  const kindText =
    abiKind === 'translated'
      ? `（ARM 包走镜像内置转译层：${matchedAbi}）`
      : abiKind === 'native'
        ? `（原生 ABI：${matchedAbi}）`
        : '（纯 Java APK，无 native 库）';
  const versionText = versionName === '' ? '' : ` ${versionName}（versionCode ${versionCode}）`;
  return R.ok(
    `已安装 ${packageName === '' ? 'APK' : packageName}${versionText} 到 ${serial}，耗时 ${ms(installedInMs)}${kindText}。${translatedNote} 下一步：android_app_launch${packageName === '' ? '（记得传 package）' : ''}。`,
    {
      package: packageName,
      versionName,
      versionCode,
      abis: apk.abis,
      deviceAbis: deviceAbiList,
      matchedAbi,
      abiKind,
      translation,
      installedInMs,
      tips,
    },
  );
};

/* ------------------------------------------------------------------ *
 * 6. android_app_launch
 * ------------------------------------------------------------------ */

const APP_LAUNCH_EXECUTE = async (args, R, deps, session) => {
  const { config } = deps;
  const sdk = await loadSdk(config);
  requireAdb(sdk);

  const requested = typeof args.package === 'string' ? args.package.trim() : '';
  const packageName = requested !== '' ? requested : state.getLastPackage(session.sessionKey);
  if (packageName === '') {
    throw toolError('BAD_ARGUMENT', 'package 参数是必填的（或者先 android_apk_install 装一次包，它会记住包名）。下一步：android_apk_install { apk: "…" }。');
  }
  const serial = await resolveSerial(sdk.adb, args.serial, session);
  const activity = typeof args.activity === 'string' ? args.activity.trim() : '';
  // 应用"启动成功"不等于"首屏渲染完成"：真机实测 Capacitor/WebView 冷启动要 3–5 s，
  // 立刻截图会得到一张白屏 PNG（有效但全白），agent 会误判成 app 坏了。
  // 默认等 1.4 s 再返回，让首屏开始渲染；可用 settleMs 覆盖（0 = 不等）。
  const settleMs = clamp(args.settleMs, 0, 15000, 1400);

  if (args.stopFirst === true) {
    await forceStopApp(sdk.adb, serial, packageName);
    await sleep(300);
  }

  const result = await launchApp(sdk.adb, serial, packageName, activity);
  const output = `${result.stdout}\n${result.stderr}`.trim();
  // 失败判定不能只看英文关键字：`launchApp` 在解析 LAUNCHER 组件失败时返回的是
  // 中文 stderr + code:1（"无法解析 …"）。所以只要退出码非 0 就必须判失败，
  // 否则"应用没装"会被误报成 ok:true（自检里真实抓到过）。
  const failed =
    result.code !== 0 ||
    (/Error|Exception|does not exist|Unable to find|无法解析/i.test(output) && !/Status: ok|Starting:/i.test(output));

  if (failed) {
    const notFound = /does not exist|Unable to find|not found|Unknown package|No activity|无法解析/i.test(output);
    return R.fail(
      notFound ? 'APP_NOT_FOUND' : 'LAUNCH_FAILED',
      notFound
        ? `设备 ${serial} 上没有可以启动的 ${packageName}${activity === '' ? '' : `（${activity}）`}：${truncate(output, 600)}。下一步：先 android_apk_install 安装 APK，或 android_ui_dump 确认设备当前界面。`
        : `启动 ${packageName} 失败：${truncate(output, 600)}。下一步：确认包名正确、应用已安装（android_apk_install），或用 android_logcat 看崩溃原因。`,
      { package: packageName, activity: result.component, pid: 0 },
    );
  }

  if (settleMs > 0) await sleep(settleMs);
  state.rememberPackage(session.sessionKey, packageName);
  return R.ok(
    [
      `已启动 ${packageName}${result.component === '' ? '' : `（${result.component}）`}${result.pid > 0 ? `，pid ${result.pid}` : ''}，并等待 ${ms(settleMs)} 让首屏开始渲染。`,
      '⚠️ 若 android_screenshot 仍是白屏，等 2–3 秒后再调一次 android_screenshot（WebView/Capacitor 冷启动需要 3–5 秒，不是应用坏了）。',
      '下一步：android_ui_wait 等首屏元素出现，或 android_ui_dump 列出可点元素。',
    ].join('\n'),
    { package: packageName, activity: result.component, pid: result.pid },
  );
};

/* ------------------------------------------------------------------ *
 * 7. android_app_stop
 * ------------------------------------------------------------------ */

const APP_STOP_EXECUTE = async (args, R, deps, session) => {
  const { config } = deps;
  const sdk = await loadSdk(config);
  requireAdb(sdk);
  const packageName = typeof args.package === 'string' ? args.package.trim() : '';
  if (packageName === '') throw toolError('BAD_ARGUMENT', 'package 参数是必填的：要停止哪个应用。');
  const serial = await resolveSerial(sdk.adb, args.serial, session);

  const result = await forceStopApp(sdk.adb, serial, packageName);
  if (result.code !== 0 && (String(result.stderr ?? '').trim() !== '' || String(result.stdout ?? '').trim() !== '')) {
    return R.fail('ADB_FAILED', `am force-stop ${packageName} 失败：${truncate(`${result.stdout}\n${result.stderr}`.trim(), 500)}`, { package: packageName });
  }
  return R.ok(`已停止 ${packageName}（force-stop）。下一步：可以 android_app_launch 重新启动，或 android_ui_dump 看当前界面。`, { package: packageName });
};

/* ------------------------------------------------------------------ *
 * 8. android_logcat
 * ------------------------------------------------------------------ */

/** 从一行日志里取级别字母（兼容 brief / threadtime / time 格式）。 */
function severityOf(line) {
  const trimmed = String(line ?? '').trimStart();
  const brief = /^([VDIWEFA])\//.exec(trimmed);
  if (brief !== null) return brief[1];
  const threadtime = /\s([VDIWEFA])\s+[^:]*:/.exec(trimmed);
  if (threadtime !== null) return threadtime[1];
  const time = /\s([VDIWEFA])\//.exec(trimmed);
  if (time !== null) return time[1];
  return '';
}

const SEVERITY_ORDER = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, A: 6 };

/**
 * 是否是崩溃/ANR 行（DESIGN §7，2026-10-24 修订版）。
 *
 * **只认这 5 个信号**：
 *   1. `FATAL EXCEPTION`
 *   2. `Fatal signal`
 *   3. `ANR in `
 *   4. `has died`
 *   5. `E AndroidRuntime` **且同行含 `Exception`**
 *
 * **绝不能把 `AndroidRuntime` 单独当信号**：真机实测 `D AndroidRuntime: Shutting down VM`
 * 是 VM 启停时的 debug 级日志（`D` 级别），把它判成崩溃会让 agent 误判"应用崩了"，
 * 于是放弃测试、去改无关代码 —— 这类**误报比漏报更糟**。
 *
 * 导出是为了让 qa 与自检能直接对判定函数做单测（不用起设备）。
 */
export function isCrashLine(line) {
  const text = String(line ?? '');
  if (text.includes('FATAL EXCEPTION')) return true;
  if (text.includes('Fatal signal')) return true;
  if (text.includes('ANR in ')) return true;
  if (text.includes('has died')) return true;
  // threadtime: `… E AndroidRuntime: java.lang.RuntimeException: …`
  // brief:     `E/AndroidRuntime( 123): …`
  if (/\bE[/ ]AndroidRuntime\b/.test(text) && text.includes('Exception')) return true;
  return false;
}

const LOGCAT_EXECUTE = async (args, R, deps, session) => {
  const { config } = deps;
  const sdk = await loadSdk(config);
  requireAdb(sdk);
  const serial = await resolveSerial(sdk.adb, args.serial, session);

  const wanted = clamp(args.lines, 1, 5000, 200);
  const levelRaw = typeof args.level === 'string' ? args.level.trim().toUpperCase() : '';
  if (levelRaw !== '' && SEVERITY_ORDER[levelRaw] === undefined) {
    throw toolError('BAD_ARGUMENT', `level 只能是 V/D/I/W/E/F（或 A）之一，收到 "${args.level}"。V=verbose、D=debug、I=info、W=warn、E=error、F=fatal。`);
  }
  const tag = typeof args.tag === 'string' ? args.tag.trim() : '';
  const packageFilter = typeof args.package === 'string' ? args.package.trim() : '';

  // 有过滤条件时多抓一些，过滤完再取尾部，避免"过滤后不够 N 行"。
  const needsFilter = levelRaw !== '' || packageFilter !== '';
  const grab = needsFilter ? Math.min(Math.max(wanted * 10, 2000), 20000) : wanted;
  const rawLines = await adbLogcat(sdk.adb, serial, grab, tag === '' ? {} : { tag });

  let lines = rawLines;
  if (levelRaw !== '') {
    const minimum = SEVERITY_ORDER[levelRaw];
    lines = lines.filter((line) => {
      const severity = severityOf(line);
      return severity !== '' && SEVERITY_ORDER[severity] >= minimum;
    });
  }
  if (packageFilter !== '') lines = lines.filter((line) => line.includes(packageFilter));
  lines = lines.slice(-wanted);

  const crashLines = lines.filter((line) => isCrashLine(line));
  const crashed = crashLines.length > 0;
  // 只摘录**命中的那些行**（≤20 行）。不要把整段 logcat 塞进 crashSummary ——
  // 那样真正的堆栈会被淹没（真机验收时实测被淹过）。
  const crashSummary = crashed ? truncate(crashLines.slice(0, 20).join('\n'), 2500) : '';

  const filters = [
    levelRaw === '' ? '' : `level>=${levelRaw}`,
    tag === '' ? '' : `tag=${tag}`,
    packageFilter === '' ? '' : `package~${packageFilter}`,
  ].filter((entry) => entry !== '');
  const message = [
    `logcat 最近 ${lines.length} 行${filters.length === 0 ? '' : `（过滤：${filters.join('、')}）`}${lines.length === 0 ? '：没有匹配的日志' : ''}。`,
    crashed
      ? `⚠️ 发现崩溃/ANR 信号（${crashLines.length} 行，见 crashSummary）。下一步：定位 crashSummary 里的第一处堆栈。`
      : '没有发现崩溃信号（FATAL EXCEPTION / Fatal signal / ANR in / has died / E AndroidRuntime+Exception）。注意 `D AndroidRuntime: Shutting down VM` 是正常 debug 日志，不算崩溃。',
  ].join(' ');

  return R.ok(message, { lines, crashed, crashSummary });
};

/* ------------------------------------------------------------------ *
 * schema + 工具定义
 * ------------------------------------------------------------------ */

/** 三件套（每个工具都一样）。 */
function tripleSchema() {
  return {
    ok: prop('boolean', '是否成功。成功表示这次操作本身完成了；业务上的"没有结果"（如 ui_wait 超时）也算成功。'),
    code: prop('string', '机器可读结果码。成功固定为 "OK"；失败是 DESIGN 冻结的错误码（NO_SDK / DEVICE_NOT_RUNNING / ABI_MISMATCH / …）。'),
    message: prop('string', '中文说明 + 可执行的下一步建议，直接照着做即可。'),
  };
}

/** 三件套 + 其余字段的 required 列表。 */
function requiredOf(properties) {
  return Object.keys(properties);
}

/**
 * ARM 转译层能力对象（DESIGN §7.1）。
 *
 * **8 个子字段必须全部声明**：`additionalProperties:false` 下多一个键就是
 * `tool returned invalid output`，少一个键就是 `missing required property`；
 * 而 `buildResult(defaults)` 里用的是 `emptyTranslation()`（同样 8 个键），
 * 所以成功与每个失败分支天然对齐。
 *
 * 探测能力由镜像决定（`emulator -prop ro.*` 无效，见 §7.1 实测警告），插件只报告。
 */
function translationSchema() {
  return objectSchema(
    {
      bridge: prop('string', 'ro.dalvik.vm.native.bridge 的值，例如 libndk_translation.so；未启用时为空串。'),
      version: prop('string', 'ro.ndk_translation.version，例如 0.2.3；未知时为空串。'),
      enabled: prop('boolean', '转译层是否启用（ro.enable.native.bridge.exec 为 1）。'),
      kind: prop('string', 'ndk-translation / houdini / native（ARM 真机）/ none。'),
      arm64: prop('boolean', '设备能否运行 arm64-v8a 的库（原生或转译）。'),
      arm32: prop('boolean', '设备能否运行 armeabi-v7a 的库；官方 x86_64 镜像通常为 false。'),
      abilist64: arrayOf(prop('string'), 'ro.product.cpu.abilist64 的原始列表。'),
      abilist32: arrayOf(prop('string'), 'ro.product.cpu.abilist32 的原始列表（官方 x86_64 镜像为空）。'),
    },
    ['bridge', 'version', 'enabled', 'kind', 'arm64', 'arm32', 'abilist64', 'abilist32'],
  );
}

const STATUS_SCHEMA = (() => {
  const properties = {
    ...tripleSchema(),
    sdk: objectSchema(
      {
        found: prop('boolean', '是否找到可用的 SDK。'),
        root: prop('string', 'SDK 根目录；找不到时为空串。'),
        adb: prop('string', 'adb 可执行文件绝对路径；没有时为空串。'),
        emulator: prop('string'),
        avdmanager: prop('string'),
        sdkmanager: prop('string'),
      },
      ['found', 'root', 'adb', 'emulator', 'avdmanager', 'sdkmanager'],
    ),
    avds: arrayOf(
      objectSchema(
        {
          name: prop('string'),
          target: prop('string'),
          abi: prop('string'),
          path: prop('string'),
          kind: prop('string', 'session-pinned（本插件的会话专属 AVD）/ template（config.avdName 模板）/ other。'),
        },
        ['name', 'target', 'abi', 'path', 'kind'],
      ),
      '已经创建的 AVD 列表。',
    ),
    images: arrayOf(
      objectSchema(
        {
          package: prop('string', 'sdkmanager 包名，例如 system-images;android-35;google_apis;x86_64。'),
          api: prop('number', 'API level。'),
          tag: prop('string'),
          abi: prop('string'),
        },
        ['package', 'api', 'tag', 'abi'],
      ),
      '已安装的系统镜像。',
    ),
    device: objectSchema(
      {
        serial: prop('string', '当前设备 serial；没有设备时为空串。'),
        state: prop('string'),
        booted: prop('boolean'),
        avd: prop('string', '模拟器对应的 AVD 名；真机为空串。'),
        abis: arrayOf(prop('string'), '设备支持的 ABI（ro.product.cpu.abilist）。'),
      },
      ['serial', 'state', 'booted', 'avd', 'abis'],
    ),
    translation: translationSchema(),
    acceleration: objectSchema(
      {
        ok: prop('boolean', '硬件加速是否可用。'),
        kind: prop('string', 'whpx / haxm / kvm / hvf / aae，或空串。'),
        raw: prop('string', 'emulator -accel-check 的原始输出（截断）。'),
      },
      ['ok', 'kind', 'raw'],
    ),
    sessionKey: prop('string', '当前会话 key（完整值，给本会话自己用；instances 里的展示值是短形式）。'),
    instances: arrayOf(
      objectSchema(
        {
          sessionKey: prop('string', '归属会话的展示值（长 key 只保留前 8 字符 + …）。'),
          serial: prop('string'),
          avd: prop('string'),
          pid: prop('number'),
          booted: prop('boolean'),
          lastPackage: prop('string', '该会话最近安装的包名；未知为空串。'),
        },
        ['sessionKey', 'serial', 'avd', 'pid', 'booted', 'lastPackage'],
      ),
      '本插件管理并记录过的模拟器实例（跨会话，用于判断资源占用）。',
    ),
    instanceLimit: objectSchema(
      {
        count: prop('number', '当前在线实例数（只统计本插件管理的）。'),
        max: prop('number', '配置的 maxInstances 上限。'),
      },
      ['count', 'max'],
    ),
    avdDisk: objectSchema(
      {
        sessionAvdCount: prop('number', '本插件前缀的会话 AVD 数量。'),
        totalGb: prop('number', '这些会话 AVD 的磁盘占用（GB，一位小数）。'),
        freeDiskGb: prop('number', '磁盘剩余空间（GB）；拿不到为 0。'),
      },
      ['sessionAvdCount', 'totalGb', 'freeDiskGb'],
    ),
    suggestions: arrayOf(prop('string'), '按当前状态给出的下一步建议。'),
  };
  return objectSchema(properties, requiredOf(properties));
})();

const AVD_CREATE_SCHEMA = (() => {
  const properties = {
    ...tripleSchema(),
    avd: prop('string', 'AVD 名。'),
    image: prop('string', '使用的系统镜像包名。'),
    created: prop('boolean', '是否新建成功。'),
    command: arrayOf(prop('string'), '实际执行的 avdmanager 命令（含可执行文件路径），便于排查。'),
  };
  return objectSchema(properties, requiredOf(properties));
})();

const EMULATOR_START_SCHEMA = (() => {
  const properties = {
    ...tripleSchema(),
    serial: prop('string', '启动后的设备 serial，例如 emulator-5554；失败时为空串。'),
    avd: prop('string', '启动的 AVD 名。'),
    pid: prop('number', 'emulator 进程 pid；0 表示没有记录。'),
    bootedInMs: prop('number', '从 spawn 到 sys.boot_completed=1 的耗时（毫秒）。'),
    logFile: prop('string', '模拟器日志文件的绝对路径。'),
    translation: translationSchema(),
    sessionKey: prop('string', '当前会话 key（完整值）。'),
    createdAvd: prop('boolean', '是否为本会话新建了专属 AVD（首次启动通常为 true）。'),
  };
  return objectSchema(properties, requiredOf(properties));
})();

const EMULATOR_STOP_SCHEMA = (() => {
  const properties = {
    ...tripleSchema(),
    serial: prop('string', '被停止的设备 serial；all:true 时是逗号分隔的列表，没有目标时为空串。'),
    stopped: prop('boolean', '是否已经确认设备不再运行。'),
    removedAvd: prop('string', '被删除的会话专属 AVD 名；未删除（或没请求 removeAvd）时为空串。'),
  };
  return objectSchema(properties, requiredOf(properties));
})();

const APK_INSTALL_SCHEMA = (() => {
  const properties = {
    ...tripleSchema(),
    package: prop('string', 'APK 的包名；解析/推断失败时为空串。'),
    versionName: prop('string'),
    versionCode: prop('number'),
    abis: arrayOf(prop('string'), 'APK 包含的 ABI（来自 zip 里的 lib/<abi>/）。'),
    deviceAbis: arrayOf(prop('string'), '设备支持的 ABI。'),
    matchedAbi: prop('string', '双方匹配上的 ABI；纯 Java APK 为 "no-native"；不匹配时为空串。'),
    abiKind: prop('string', '"native"（原生 ABI 直接匹配）/ "translated"（ARM 包走镜像内置转译层）/ "none"（纯 Java 或未匹配）。'),
    translation: translationSchema(),
    installedInMs: prop('number', 'adb install 耗时（毫秒）。'),
    tips: arrayOf(prop('string'), '本次安装的补充说明（ABI 匹配情况、转译性能提醒、版本推断方式等）。'),
  };
  return objectSchema(properties, requiredOf(properties));
})();

const APP_LAUNCH_SCHEMA = (() => {
  const properties = {
    ...tripleSchema(),
    package: prop('string', '启动的包名。'),
    activity: prop('string', '实际启动的组件（包名/Activity）；解析失败时为空串。'),
    pid: prop('number', '进程 pid；拿不到时为 0。'),
  };
  return objectSchema(properties, requiredOf(properties));
})();

const APP_STOP_SCHEMA = (() => {
  const properties = {
    ...tripleSchema(),
    package: prop('string', '被停止的包名。'),
  };
  return objectSchema(properties, requiredOf(properties));
})();

const LOGCAT_SCHEMA = (() => {
  const properties = {
    ...tripleSchema(),
    lines: arrayOf(prop('string'), '过滤后的日志行（按时间顺序，最多 lines 条）。'),
    crashed: prop('boolean', '是否出现真正的崩溃信号：FATAL EXCEPTION / Fatal signal / ANR in / has died / E AndroidRuntime+Exception（D 级 AndroidRuntime 不算）。'),
    crashSummary: prop('string', '命中的崩溃行（最多 20 行）；没有崩溃时为空串。'),
  };
  return objectSchema(properties, requiredOf(properties));
})();

/**
 * 构造 8 个设备/应用类工具。
 *
 * @param {{ config: object }} deps
 * @returns {Array<object>}
 */
export function buildDeviceTools(deps) {
  return [
    defineTool(
      {
        name: 'android_status',
        description:
          '检查 Android 环境并给出下一步建议：SDK 位置、adb/emulator/avdmanager 是否可用、已创建的 AVD（含 session-pinned/template 标记）、已安装的系统镜像、**本会话**运行中的设备、ARM 转译层能力、硬件加速、跨会话实例与实例上限（instanceLimit）、会话 AVD 磁盘占用与剩余空间（avdDisk）。失败时也会尽量填满这些信息（例如 code=NO_ADB 时仍会报告 SDK 与 AVD）。做任何安卓操作前先调它。',
        parameters: objectSchema({}),
        schema: STATUS_SCHEMA,
        defaults: () => ({
          sdk: emptySdk(),
          avds: [],
          images: [],
          device: emptyDeviceInfo(),
          translation: emptyTranslation(),
          acceleration: { ok: false, kind: '', raw: '' },
          sessionKey: '',
          instances: [],
          instanceLimit: { count: 0, max: 0 },
          avdDisk: { sessionAvdCount: 0, totalGb: 0, freeDiskGb: 0 },
          suggestions: [],
        }),
        render: (args, value) => text(value.message),
        presentCall: () => ({ card: 'generic', title: '检查 Android 环境', kind: 'read' }),
        execute: STATUS_EXECUTE,
      },
      deps,
    ),
    defineTool(
      {
        name: 'android_avd_create',
        description:
          '创建一个 Android 虚拟设备（AVD）。不传 image 时会自动挑一个与主机 CPU 匹配的已安装系统镜像（x86_64 主机 → x86_64 镜像；arm64 镜像在 x86_64 主机上无法运行）。已存在同名 AVD 时会失败，除非 force:true。创建成功后用 android_emulator_start 启动。',
        parameters: objectSchema({
          name: prop('string', 'AVD 名。省略则用插件配置的 avdName（默认 dsh_android）。'),
          image: prop('string', '系统镜像包名，例如 "system-images;android-35;google_apis;x86_64"。省略则自动选择与主机匹配的镜像。'),
          device: prop('string', '硬件配置模板名（avdmanager 的 --device，例如 "pixel_6"）。省略用 avdmanager 默认。'),
          force: prop('boolean', '同名 AVD 已存在时是否删除重建（--force）。默认 false。'),
        }),
        schema: AVD_CREATE_SCHEMA,
        defaults: () => ({ avd: '', image: '', created: false, command: [] }),
        render: (args, value) => text(value.message),
        presentCall: (args) => ({ card: 'generic', title: `创建 AVD${typeof args.name === 'string' && args.name !== '' ? `：${args.name}` : ''}`, kind: 'execute' }),
        execute: AVD_CREATE_EXECUTE,
      },
      deps,
    ),
    defineTool(
      {
        name: 'android_emulator_start',
        description:
          '启动 Android 模拟器并等它启动完成（默认 headless：无窗口，适合 agent）。**每个会话默认一台独立模拟器**（perSession）：优先复用本会话已有的设备；否则为本会话创建专属 AVD（<avdNamePrefix|avdName>--<sessionShort>）并从 5554 起分配空闲端口启动，首次约 1 分钟。同时运行的实例受 config.maxInstances 限制（默认 2），达到上限返回 DEVICE_BUSY。启动后会探测并返回 ARM 转译层能力（translation），并报告本会话实例与磁盘压力。启动后可用 android_apk_install 装包、android_screenshot 看界面。',
        parameters: objectSchema({
          avd: prop('string', '要启动的 AVD 名。省略则用本会话专属 AVD（自动创建）。'),
          headless: prop('boolean', '是否无窗口启动（默认 true）。只在需要人工看窗口时传 false。'),
          cold: prop('boolean', '是否冷启动（加 -no-snapshot，忽略快照）。会话 AVD 默认就加。-no-snapshot。'),
          timeoutMs: prop('number', '等待启动完成的超时（毫秒）。省略用插件配置的 bootTimeoutMs（默认 240000）。'),
          port: prop('number', '指定模拟器端口（5554~5682 的偶数）。省略则自动分配空闲端口。'),
        }),
        schema: EMULATOR_START_SCHEMA,
        defaults: () => ({
          serial: '',
          avd: '',
          pid: 0,
          bootedInMs: 0,
          logFile: '',
          translation: emptyTranslation(),
          sessionKey: '',
          createdAvd: false,
        }),
        render: (args, value) => text(value.message),
        presentCall: (args) => ({ card: 'generic', title: `启动模拟器${typeof args.avd === 'string' && args.avd !== '' ? `：${args.avd}` : ''}`, kind: 'execute' }),
        execute: EMULATOR_START_EXECUTE,
      },
      deps,
    ),
    defineTool(
      {
        name: 'android_emulator_stop',
        description:
          '停止模拟器：先 adb emu kill，等设备从 adb devices 消失；若无效则兜底终止启动时记录的进程树。**只停本会话**的设备：省略 serial 时停本会话当前设备；serial 属于别的会话 → DEVICE_BUSY（绝不静默停别人的设备）；all:true 只停本会话全部。设备本来就不在运行也算成功（stopped:true）。removeAvd:true 会在停稳后删除本会话专属 AVD（释放 4–6.5 GB，见返回的 removedAvd）。',
        parameters: objectSchema({
          serial: prop('string', '要停止的设备 serial。省略则停本会话的当前设备。'),
          all: prop('boolean', '是否停止本会话的全部模拟器（默认 false）。'),
          removeAvd: prop('boolean', '停止后是否删除本会话专属 AVD（默认 false；释放约 4–6.5 GB 磁盘）。'),
        }),
        schema: EMULATOR_STOP_SCHEMA,
        defaults: () => ({ serial: '', stopped: false, removedAvd: '' }),
        render: (args, value) => text(value.message),
        presentCall: (args) => ({ card: 'generic', title: args.all === true ? '停止全部模拟器' : '停止模拟器', kind: 'execute' }),
        execute: EMULATOR_STOP_EXECUTE,
      },
      deps,
    ),
    defineTool(
      {
        name: 'android_apk_install',
        description:
          '把 APK 安装到当前设备（adb install -r -g）。安装前会做 ABI 预检：从 APK 的 zip 中央目录读出 ABI、从设备读 ro.product.cpu.abilist 并探测 ARM 转译层，没有交集就直接返回 ABI_MISMATCH 并给出针对性建议（不会浪费一次 install）。返回 abiKind：native（原生 ABI）/ translated（ARM 包走镜像内置 libndk_translation 转译）/ none（纯 Java）。translated 时会附性能提醒——不要用转译下的耗时判断真机性能。包名与版本号从 APK 的 AndroidManifest 里解析，解析不到时用 pm list packages 差集兜底。安装成功后包名会被记住，android_app_launch 可以省略 package。',
        parameters: objectSchema({
          apk: prop('string', 'APK 文件路径（建议绝对路径）。必填。'),
          serial: prop('string', '目标设备 serial。省略则用当前设备。'),
          grantPermissions: prop('boolean', '是否安装时授予全部运行时权限（adb install -g，默认 true），避免首次启动被权限弹窗挡住。'),
          reinstall: prop('boolean', '是否覆盖安装（adb install -r，默认 true）。'),
        }, ['apk']),
        schema: APK_INSTALL_SCHEMA,
        defaults: () => ({
          package: '',
          versionName: '',
          versionCode: 0,
          abis: [],
          deviceAbis: [],
          matchedAbi: '',
          abiKind: 'none',
          translation: emptyTranslation(),
          installedInMs: 0,
          tips: [],
        }),
        render: (args, value) => text([value.message, ...(value.tips.length === 0 ? [] : ['', ...value.tips.map((tip) => `- ${tip}`)])].join('\n')),
        presentCall: (args) => ({ card: 'generic', title: `安装 APK${typeof args.apk === 'string' ? `：${path.basename(args.apk)}` : ''}`, kind: 'execute' }),
        execute: APK_INSTALL_EXECUTE,
      },
      deps,
    ),
    defineTool(
      {
        name: 'android_app_launch',
        description:
          '启动一个已安装的应用（am start -W）。省略 package 时用最近安装的包名；省略 activity 时自动解析默认 LAUNCHER 组件。返回 pid。启动成功后会默认等 settleMs（1400 ms）再返回，因为 WebView/Capacitor 冷启动要 3–5 秒才渲染首屏，立刻截图会是白屏。如果稍后截图仍是白屏，等 2–3 秒再截一次，或 android_ui_wait 等首屏元素。',
        parameters: objectSchema({
          package: prop('string', '包名。省略则用最近一次 android_apk_install 的包。'),
          activity: prop('string', '可选 Activity（".MainActivity" / "com.x.MainActivity" / "com.x/.Main" 都可以）。省略则解析 LAUNCHER。'),
          serial: prop('string', '目标设备 serial。省略则用当前设备。'),
          stopFirst: prop('boolean', '启动前先 force-stop（冷启动，默认 false）。'),
          settleMs: prop('number', '启动成功后等待多少毫秒再返回（默认 1400，范围 0~15000）。0 表示立刻返回。WebView 应用建议保留默认值。'),
        }),
        schema: APP_LAUNCH_SCHEMA,
        defaults: () => ({ package: '', activity: '', pid: 0 }),
        render: (args, value) => text(value.message),
        presentCall: (args) => ({ card: 'generic', title: `启动应用${typeof args.package === 'string' && args.package !== '' ? `：${args.package}` : ''}`, kind: 'execute' }),
        execute: APP_LAUNCH_EXECUTE,
      },
      deps,
    ),
    defineTool(
      {
        name: 'android_app_stop',
        description:
          '强制停止一个应用（am force-stop）。用于制造冷启动场景，或清理挡住界面的残留进程。',
        parameters: objectSchema(
          {
            package: prop('string', '要停止的包名。必填。'),
            serial: prop('string', '目标设备 serial。省略则用当前设备。'),
          },
          ['package'],
        ),
        schema: APP_STOP_SCHEMA,
        defaults: () => ({ package: '' }),
        render: (args, value) => text(value.message),
        presentCall: (args) => ({ card: 'generic', title: `停止应用${typeof args.package === 'string' && args.package !== '' ? `：${args.package}` : ''}`, kind: 'execute' }),
        execute: APP_STOP_EXECUTE,
      },
      deps,
    ),
    defineTool(
      {
        name: 'android_logcat',
        description:
          '读取设备最近的 logcat（logcat -d -t N），可按级别/标签/包名过滤，并自动识别崩溃（FATAL EXCEPTION / AndroidRuntime / ANR in）并给出 crashSummary。用于定位应用启动崩溃、权限异常、网络错误。',
        parameters: objectSchema({
          serial: prop('string', '目标设备 serial。省略则用当前设备。'),
          lines: prop('number', '返回多少行（默认 200，最大 5000）。'),
          level: prop('string', '最低日志级别：V/D/I/W/E/F。省略则不过滤。'),
          tag: prop('string', '只保留包含该标签的日志（设备侧 logcat -s）。'),
          package: prop('string', '只保留包含该包名/进程名的日志（客户端过滤）。'),
        }),
        schema: LOGCAT_SCHEMA,
        defaults: () => ({ lines: [], crashed: false, crashSummary: '' }),
        render: (args, value) =>
          text(
            [
              value.message,
              '',
              value.crashed ? `## crashSummary\n${value.crashSummary}` : '',
              '',
              value.lines.length === 0 ? '（没有日志行）' : value.lines.slice(-120).join('\n'),
            ]
              .filter((entry, index, array) => entry !== '' || array[index - 1] !== '')
              .join('\n'),
          ),
        presentCall: (args) => ({ card: 'generic', title: '读取 logcat', kind: 'read' }),
        execute: LOGCAT_EXECUTE,
      },
      deps,
    ),
  ];
}
