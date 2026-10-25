/**
 * 工具**返回值**校验：DESIGN §5 末说的「最阴的坑」。
 *
 * 为什么必须单独一组测试：
 * 每个工具都声明了 `output.schema`（`additionalProperties: false` + 全部字段 required）。
 * dsh 在**每次 execute 之后**都会拿返回值按这个 schema 校验一次；只要某个失败分支
 * 返回的对象少了/multi 了一个键、或把 `null` 当空值、或数字位置放了字符串，调用方
 * 看到的就是一句 `tool returned invalid output`——没有堆栈、没有字段名，极难定位。
 * 而 mock ctx 的 `register` **不校验返回值**，所以「单测全绿」完全不代表没这个问题。
 *
 * 本文件做四件事：
 * 1. **真实执行**能离线到达的分支（无 SDK 时 15 个工具都走 NO_SDK；apk_install 还有
 *    4 个在 SDK 检查之前的前置分支），逐个 `validateToolOutput`；
 * 2. 从真实失败的返回值**反推每个工具的 defaults 字段形状**（`buildResult(defaults)` 保证
 *    所有分支字段集相同），再对「实现里该工具会返回的每一个 code」构造返回值校验；
 * 3. 构造每个工具的**成功分支**（含非空嵌套值：节点、bounds、ABI 数组、tips）校验；
 * 4. **静态扫描** `lib/tools/*.mjs`：所有 `R.fail('CODE')` / `toolError('CODE')` 的 code
 *    必须落在 DESIGN §4 的 26 个枚举里，且扫描到的 code 集合与第 2 步的构造表一致
 *    （防止实现新增了一个 code 但测试没覆盖）。
 *
 * @module test/tool-output
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ERROR_CODES,
  PLUGIN_ROOT,
  loadToolDefinitions,
  offlineConfig,
  withNoSdkEnv,
} from './helpers/plugin.mjs';
import { validateToolOutput } from './helpers/schema.mjs';
import { makeStoredZip } from './helpers/zip.mjs';

/* ------------------------------------------------------------------ *
 * 契约：每个工具可能返回的 code（从实现逐分支核对，见各 execute）
 * ------------------------------------------------------------------ */

/**
 * 每个工具**实现里真实存在**的结果码分支。
 *
 * 这份表是手写契约：DESIGN §4 是「全局可用枚举」，这里收窄到「这个工具实际会返回哪些」。
 * 第 4 部分会用源码扫描交叉验证，两边对不上就红——这样实现了新分支却没同步测试时会暴露。
 */
const TOOL_CODES = Object.freeze({
  android_status: ['OK', 'NO_SDK'],
  android_avd_create: ['OK', 'NO_SDK', 'NO_AVD_MANAGER', 'NO_IMAGE', 'AVD_CREATE_FAILED', 'TIMEOUT', 'SPAWN_DENIED'],
  android_emulator_start: [
    'OK',
    'NO_SDK',
    'NO_ADB',
    'NO_EMULATOR',
    'NO_AVD',
    'EMULATOR_START_FAILED',
    'BOOT_TIMEOUT',
    'SPAWN_DENIED',
  ],
  android_emulator_stop: ['OK', 'NO_SDK', 'MULTIPLE_DEVICES', 'TIMEOUT'],
  android_apk_install: [
    'OK',
    'BAD_ARGUMENT',
    'APK_NOT_FOUND',
    'APK_UNREADABLE',
    'NO_SDK',
    'NO_ADB',
    'ABI_MISMATCH',
    'INSTALL_FAILED',
    'TIMEOUT',
    'SPAWN_DENIED',
  ],
  android_app_launch: ['OK', 'NO_SDK', 'NO_ADB', 'BAD_ARGUMENT', 'APP_NOT_FOUND', 'LAUNCH_FAILED'],
  android_app_stop: ['OK', 'NO_SDK', 'NO_ADB', 'BAD_ARGUMENT', 'ADB_FAILED'],
  android_logcat: ['OK', 'NO_SDK', 'NO_ADB', 'DEVICE_NOT_RUNNING', 'MULTIPLE_DEVICES', 'BAD_ARGUMENT', 'ADB_FAILED', 'TIMEOUT'],
  android_ui_dump: ['OK', 'NO_SDK', 'NO_ADB', 'DEVICE_NOT_RUNNING', 'MULTIPLE_DEVICES', 'UI_DUMP_FAILED', 'ADB_FAILED', 'TIMEOUT'],
  android_ui_tap: [
    'OK',
    'NO_SDK',
    'NO_ADB',
    'DEVICE_NOT_RUNNING',
    'MULTIPLE_DEVICES',
    'BAD_ARGUMENT',
    'ELEMENT_NOT_FOUND',
    'UI_DUMP_FAILED',
    'ADB_FAILED',
  ],
  android_ui_swipe: ['OK', 'NO_SDK', 'NO_ADB', 'DEVICE_NOT_RUNNING', 'MULTIPLE_DEVICES', 'BAD_ARGUMENT', 'ADB_FAILED'],
  android_ui_input: ['OK', 'NO_SDK', 'NO_ADB', 'DEVICE_NOT_RUNNING', 'MULTIPLE_DEVICES', 'BAD_ARGUMENT', 'ADB_FAILED'],
  android_ui_key: ['OK', 'NO_SDK', 'NO_ADB', 'DEVICE_NOT_RUNNING', 'MULTIPLE_DEVICES', 'BAD_ARGUMENT', 'ADB_FAILED'],
  android_ui_wait: ['OK', 'NO_SDK', 'NO_ADB', 'DEVICE_NOT_RUNNING', 'MULTIPLE_DEVICES', 'BAD_ARGUMENT', 'UI_DUMP_FAILED'],
  android_screenshot: ['OK', 'NO_SDK', 'NO_ADB', 'DEVICE_NOT_RUNNING', 'MULTIPLE_DEVICES', 'ADB_FAILED', 'INTERNAL'],
});

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/**
 * 断言一个返回值严格满足该工具的 output.schema（失败时带上全部违规点与返回值快照）。
 *
 * @param {object} definition 工具定义。
 * @param {unknown} value 返回值。
 * @param {string} label 诊断标签。
 * @param {string} [code] 断言的 code（给了就一并检查）。
 * @returns {void}
 */
function assertOutput(definition, value, label, code) {
  const violations = validateToolOutput(definition.output.schema, value);
  assert.deepEqual(
    violations,
    [],
    `${label} 的返回值不满足 output.schema（真实运行时会报 "tool returned invalid output"）：\n` +
      `  ${violations.join('\n  ')}\n返回值：${JSON.stringify(value)?.slice(0, 800)}`,
  );
  if (code !== undefined) assert.equal(value.code, code, `${label} 的 code 应为 ${code}`);
  assert.equal(typeof value.message, 'string', `${label}: message 必须是非空字符串`);
  assert.ok(value.message.length > 0, `${label}: message 不能为空（agent 靠它决定下一步）`);
}

/** 三件套字段名（构造 defaults 时排除）。 */
const TRIPLE = ['ok', 'code', 'message'];

/**
 * v1.1.0：本机真实镜像的 `translation`（`libndk_translation` 0.2.3）。
 *
 * 用它做成功分支的「非空嵌套值」样本——空对象 `{}` 是测不出「8 个子字段是否齐全」的。
 */
const NDK_TRANSLATION = Object.freeze({
  bridge: 'libndk_translation.so',
  version: '0.2.3',
  enabled: true,
  kind: 'ndk-translation',
  arm64: true,
  arm32: false,
  abilist64: ['x86_64', 'arm64-v8a'],
  abilist32: [],
});

/** `translation` 契约的 8 个子字段（DESIGN §3）。 */
const TRANSLATION_SUB_FIELDS = ['bridge', 'version', 'enabled', 'kind', 'arm64', 'arm32', 'abilist64', 'abilist32'];

/**
 * 把一次真实失败的返回值转成「该工具的默认空值」（去掉三件套）。
 *
 * @param {object} value `R.fail()` 的返回值。
 * @returns {object} defaults。
 */
function defaultsOf(value) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !TRIPLE.includes(key)));
}

/**
 * 为该工具的历史合法调用参数（尽量让参数校验通过，走到 SDK / 设备检查）。
 *
 * @param {string} name 工具名。
 * @returns {object} 参数。
 */
function offlineArgs(name) {
  return {
    android_status: {},
    android_avd_create: {},
    android_emulator_start: {},
    android_emulator_stop: {},
    // apk 指向一个不存在的路径 → 走 APK_NOT_FOUND（在 SDK 检查之前）
    android_apk_install: { apk: path.join(os.tmpdir(), '__dsh_no_such__.apk') },
    android_app_launch: {},
    android_app_stop: { package: 'com.example.app' },
    android_ui_dump: {},
    android_ui_tap: {},
    android_ui_swipe: {},
    android_ui_input: { text: 'hello' },
    android_ui_key: { key: 'back' },
    android_ui_wait: { text: 'x' },
    android_screenshot: {},
    android_logcat: {},
  }[name] ?? {};
}

/* ------------------------------------------------------------------ *
 * 1. 真实执行离线可达的分支
 * ------------------------------------------------------------------ */

test('无 SDK 时 15 个工具都返回满足 output.schema 的结构化失败（NO_SDK）', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-tooloff-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withNoSdkEnv(async () => {
    const tools = await loadToolDefinitions(offlineConfig(directory));
    assert.equal(tools.size, 15);

    for (const [name, definition] of tools) {
      const value = await definition.execute(offlineArgs(name), {});
      // apk_install 的空/不存在 apk 分支在 SDK 检查之前，见下一条测试
      const expected = name === 'android_apk_install' ? 'APK_NOT_FOUND' : 'NO_SDK';
      assertOutput(definition, value, `${name}（无 SDK）`, expected);
      assert.equal(value.ok, false, `${name}: 无 SDK 必须是 ok:false`);
    }
  });
});

test('apk_install 的四个前置失败分支（在 SDK 检查之前）都满足 schema', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-apkbad-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const apkDirectory = path.join(directory, 'not-a-file.apk');
  mkdirSync(apkDirectory, { recursive: true });
  const brokenZip = path.join(directory, 'broken.apk');
  writeFileSync(brokenZip, Buffer.alloc(512, 0x41));

  await withNoSdkEnv(async () => {
    const tools = await loadToolDefinitions(offlineConfig(directory));
    const definition = tools.get('android_apk_install');

    // 参数缺失 → BAD_ARGUMENT（在 stat 之前）
    for (const args of [{}, { apk: '' }, { apk: '   ' }]) {
      assertOutput(definition, await definition.execute(args, {}), 'android_apk_install（缺 apk）', 'BAD_ARGUMENT');
    }
    // 路径不存在 → APK_NOT_FOUND
    assertOutput(
      definition,
      await definition.execute({ apk: path.join(directory, 'nope.apk') }, {}),
      'android_apk_install（路径不存在）',
      'APK_NOT_FOUND',
    );
    // 给了目录 → APK_UNREADABLE
    assertOutput(
      definition,
      await definition.execute({ apk: apkDirectory }, {}),
      'android_apk_install（给的是目录）',
      'APK_UNREADABLE',
    );
    // 不是合法 zip（但 SDK 缺失 → 先报 NO_SDK；这里有 SDK 才能测到 APK_UNREADABLE 的 zip 分支，
    // 所以只断言「返回结构合法、code 属于该工具的分支集合」）
    const brokenValue = await definition.execute({ apk: brokenZip }, {});
    assertOutput(definition, brokenValue, 'android_apk_install（损坏 zip）');
    assert.ok(
      ['NO_SDK', 'APK_UNREADABLE'].includes(brokenValue.code),
      `损坏 zip 应报 NO_SDK（本机无 SDK）或 APK_UNREADABLE，实际 ${brokenValue.code}`,
    );
  });
});

test('真实执行得到的失败返回，字段集与成功返回完全相同（defaults 派生一致）', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-defaults-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withNoSdkEnv(async () => {
    const tools = await loadToolDefinitions(offlineConfig(directory));
    for (const [name, definition] of tools) {
      const value = await definition.execute(offlineArgs(name), {});
      const declared = Object.keys(definition.output.schema.properties).sort();
      const actual = Object.keys(value).sort();
      assert.deepEqual(actual, declared, `${name}: 返回值的键必须与 output.schema.properties 完全一致`);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2. 每个工具的**每一个** code 分支都用构造值校验
 * ------------------------------------------------------------------ */

test('每个工具的每一个 code 分支都满足 output.schema（DESIGN 最阴的坑）', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-branches-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withNoSdkEnv(async () => {
    const tools = await loadToolDefinitions(offlineConfig(directory));

    for (const [name, definition] of tools) {
      const branches = TOOL_CODES[name];
      assert.notEqual(branches, undefined, `${name} 缺少分支表`);

      // 从真实执行的失败返回里学 defaults（失败分支用 R.fail 填充 defaults）
      const sample = await definition.execute(offlineArgs(name), {});
      const defaults = defaultsOf(sample);

      for (const code of branches) {
        if (code === 'OK') continue; // 成功分支单独测，见第 3 部分
        assert.ok(ERROR_CODES.includes(code), `${name}: code "${code}" 不在 DESIGN §4 枚举里`);
        // 构造：失败分支 = defaults + 三件套（与 lib/schema.mjs 的 R.fail 语义完全一致）
        const value = { ...defaults, ok: false, code, message: `${name} 在 ${code} 下的说明` };
        assertOutput(definition, value, `${name}（code=${code}）`, code);
      }
    }
  });
});

test('失败分支的每个字段都必须是「合法空值」而不是 null/undefined（构造函数保证）', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-empties-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withNoSdkEnv(async () => {
    const tools = await loadToolDefinitions(offlineConfig(directory));
    for (const [name, definition] of tools) {
      const value = await definition.execute(offlineArgs(name), {});
      // lossless JSON：不能有 undefined、NaN、-0（validateToolOutput 已查，这里给更直观的断言）
      const text = JSON.stringify(value);
      assert.equal(typeof text, 'string', `${name}: 返回值必须可以 JSON.stringify`);
      assert.doesNotThrow(() => JSON.parse(text), `${name}: 返回值必须能无损往返 JSON`);
      for (const [key, entry] of Object.entries(value)) {
        assert.notEqual(entry, null, `${name}.${key} 不要用 null 表示空值（应与 schema 的 type 一致）`);
        assert.notEqual(entry, undefined, `${name}.${key} 不能是 undefined（JSON 会丢键）`);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. 成功分支：用非空嵌套值校验（这才是真实运行时的形状）
 * ------------------------------------------------------------------ */

test('每个工具的成功分支（含非空嵌套值）都满足 output.schema', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-success-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withNoSdkEnv(async () => {
    const tools = await loadToolDefinitions(offlineConfig(directory));

    /** 每个工具成功返回时的「非空」额外字段（形状取自真实返回值）。 */
    const successExtras = {
      android_status: {
        sdk: { found: true, root: 'C:\\Sdk', adb: 'C:\\Sdk\\platform-tools\\adb.exe', emulator: 'C:\\Sdk\\emulator\\emulator.exe', avdmanager: 'C:\\Sdk\\cmdline-tools\\latest\\bin\\avdmanager.bat', sdkmanager: 'C:\\Sdk\\cmdline-tools\\latest\\bin\\sdkmanager.bat' },
        avds: [{ name: 'dsh_android', target: 'android-35', abi: 'x86_64', path: 'C:\\Users\\x\\.android\\avd\\dsh_android.avd' }],
        images: [{ package: 'system-images;android-35;google_apis;x86_64', api: 35, tag: 'google_apis', abi: 'x86_64' }],
        device: { serial: 'emulator-5554', state: 'device', booted: true, avd: 'dsh_android', abis: ['x86_64', 'arm64-v8a'] },
        // v1.1.0：本机真实形态（libndk_translation 0.2.3，arm64 可用 / arm32 不可用）
        translation: NDK_TRANSLATION,
        acceleration: { ok: true, kind: 'whpx', raw: 'WHPX is installed and usable.' },
        suggestions: ['可以 android_apk_install 装包。'],
      },
      android_avd_create: { avd: 'dsh_android', image: 'system-images;android-35;google_apis;x86_64', created: true, command: ['C:\\Sdk\\cmdline-tools\\latest\\bin\\avdmanager.bat', 'create', 'avd', '-n', 'dsh_android', '-k', 'system-images;android-35;google_apis;x86_64'] },
      android_emulator_start: { serial: 'emulator-5554', avd: 'dsh_android', pid: 12345, bootedInMs: 45000, logFile: 'C:\\tmp\\dsh-android-emulator\\emulator-dsh_android.log', translation: NDK_TRANSLATION },
      android_emulator_stop: { serial: 'emulator-5554', stopped: true },
      android_apk_install: {
        package: 'com.example.demo', versionName: '1.0', versionCode: 1,
        abis: ['arm64-v8a', 'armeabi-v7a'], deviceAbis: ['x86_64', 'arm64-v8a'],
        matchedAbi: 'arm64-v8a',   // v1.1.0：原始 arm-only APK 走转译
        abiKind: 'translated',
        translation: NDK_TRANSLATION,
        installedInMs: 2600,
        tips: ['ABI 匹配：设备 x86_64/arm64-v8a ∩ APK arm64-v8a/armeabi-v7a → arm64-v8a。', '该 APK 通过 ARM 转译运行。'],
      },
      android_app_launch: { package: 'com.example.demo', activity: 'com.example.demo/.MainActivity', pid: 999 },
      android_app_stop: { package: 'com.example.demo' },
      android_ui_dump: {
        screen: { width: 1080, height: 2400, rotation: 0 },
        nodeCount: 2,
        package: 'com.example.demo',
        nodes: [
          {
            text: '开始识别', resourceId: 'com.example.demo:id/btn_start', contentDesc: '', className: 'android.widget.Button',
            packageName: 'com.example.demo', clickable: true, enabled: true, scrollable: false,
            bounds: { x1: 100, y1: 600, x2: 980, y2: 720 }, center: { x: 540, y: 660 },
          },
          {
            text: '', resourceId: 'com.example.demo:id/webview', contentDesc: '', className: 'android.webkit.WebView',
            packageName: 'com.example.demo', clickable: true, enabled: true, scrollable: false,
            bounds: { x1: 0, y1: 128, x2: 1080, y2: 2337 }, center: { x: 540, y: 1232 },
          },
        ],
      },
      android_ui_tap: {
        tapped: { x: 540, y: 660 },
        target: { text: '开始识别', resourceId: 'com.example.demo:id/btn_start', className: 'android.widget.Button', bounds: { x1: 100, y1: 600, x2: 980, y2: 720 } },
      },
      android_ui_swipe: { from: { x: 540, y: 1800 }, to: { x: 540, y: 400 }, durationMs: 300 },
      android_ui_input: { sent: 'hello%sworld', asciiOnly: true, note: '输入前已清空输入框（MOVE_END + 50 次 DEL）。' },
      android_ui_key: { key: 'back', keycode: 4 },
      android_ui_wait: {
        found: true, waitedMs: 1200,
        node: {
          text: '开始识别', resourceId: 'com.example.demo:id/btn_start', contentDesc: '', className: 'android.widget.Button',
          packageName: 'com.example.demo', clickable: true, enabled: true, scrollable: false,
          bounds: { x1: 100, y1: 600, x2: 980, y2: 720 }, center: { x: 540, y: 660 },
        },
      },
      android_screenshot: { path: 'C:\\tmp\\dsh-android-emulator\\shot-20261024-193000-000.png', width: 1080, height: 2400, bytes: 551994 },
      android_logcat: { lines: ['10-24 19:30:00.000 I/ActivityManager( 123): Start proc', '10-24 19:30:01.000 E/AndroidRuntime( 999): FATAL EXCEPTION: main'], crashed: true, crashSummary: 'E/AndroidRuntime( 999): FATAL EXCEPTION: main' },
    };

    for (const [name, definition] of tools) {
      const extras = successExtras[name];
      assert.notEqual(extras, undefined, `${name}: 缺少成功分支样本`);
      const value = { ...defaultsOf(await definition.execute(offlineArgs(name), {})), ...extras, ok: true, code: 'OK', message: `${name} 成功` };
      assertOutput(definition, value, `${name}（成功分支）`, 'OK');
    }
  });
});

test('ui_wait 的「超时但成功」分支（ok:true, found:false）满足 schema', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-wait-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withNoSdkEnv(async () => {
    const tools = await loadToolDefinitions(offlineConfig(directory));
    const definition = tools.get('android_ui_wait');
    const sample = await definition.execute({ text: '什么也没有' }, {});
    const value = {
      ...defaultsOf(sample),
      ok: true,
      code: 'OK',
      found: false,
      waitedMs: 10000,
      node: {
        text: '', resourceId: '', contentDesc: '', className: '', packageName: '',
        clickable: false, enabled: false, scrollable: false,
        bounds: { x1: 0, y1: 0, x2: 0, y2: 0 }, center: { x: 0, y: 0 },
      },
      message: '等了 10 s 没有等到 text="什么也没有"（这不是错误，只是超时）。',
    };
    assertOutput(definition, value, 'android_ui_wait（超时但 ok:true）', 'OK');
  });
});

test('android_ui_tap 的 ELEMENT_NOT_FOUND 分支：message 必须给出降级建议（WebView 用截图+坐标）', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-element-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withNoSdkEnv(async () => {
    const tools = await loadToolDefinitions(offlineConfig(directory));
    const definition = tools.get('android_ui_tap');
    const defaults = defaultsOf(await definition.execute({ text: 'x' }, {}));
    // 真实实现的 ELEMENT_NOT_FOUND 返回：defaults + 三件套（toolError 路径，无 extra）
    const value = {
      ...defaults,
      ok: false,
      code: 'ELEMENT_NOT_FOUND',
      message:
        '界面上找不到 text="登录" 的元素。下一步：调用 android_ui_dump 列出当前可点元素（或用 x/y 坐标点击）。' +
        '如果 android_ui_dump 显示这是 WebView 页面（节点极少、text 全空），uiautomator 看不到内部 DOM：' +
        '请用 android_screenshot 看界面后用 android_ui_tap {x,y} 坐标点击。',
    };
    assertOutput(definition, value, 'android_ui_tap（ELEMENT_NOT_FOUND）', 'ELEMENT_NOT_FOUND');
    // 可执行的降级建议（Lead 要求的实测结论：WebView 页面只能截图 + 坐标点击）
    assert.match(value.message, /android_ui_dump/u, 'message 应指向 ui_dump 看真实节点');
    assert.match(value.message, /android_screenshot/u, 'message 应给出截图降级建议');
    assert.match(value.message, /WebView/u, 'message 应解释 WebView DOM 不可见');
    assert.match(value.message, /x,y|坐标点击/u, 'message 应说明改用坐标点击');
  });
});

/* ------------------------------------------------------------------ *
 * 4. 静态扫描：实现里的 code 必须落在枚举里，且与分支表一致
 * ------------------------------------------------------------------ */

test('实现里所有 R.fail/toolError 的 code 都在 DESIGN §4 枚举里（静态扫描）', () => {
  /** @type {Map<string, Set<string>>} */
  const codesByFile = new Map();
  for (const file of ['lib/tools/device.mjs', 'lib/tools/interact.mjs', 'lib/adb.mjs', 'lib/sdk.mjs', 'lib/emulator.mjs']) {
    const source = readFileSync(path.join(PLUGIN_ROOT, file), 'utf8');
    // `\s` 在 JS 正则里包含换行 → 能匹配跨行的 R.fail(\n 'CODE',
    const codes = new Set();
    for (const match of source.matchAll(/(?:R\.fail|toolError)\(\s*'([A-Z_]+)'/gu)) codes.add(match[1]);
    // 动态 code（codeOf(error) 等）不参与枚举扫描。
    codesByFile.set(file, codes);
    for (const code of codes) {
      assert.ok(ERROR_CODES.includes(code), `${file} 里出现了 DESIGN §4 枚举之外的 code "${code}"`);
    }
  }
  // 至少应该扫到一批（防止正则写错导致空扫描假绿）
  const total = [...codesByFile.values()].reduce((sum, set) => sum + set.size, 0);
  assert.ok(total > 15, `静态扫描只找到 ${total} 个 code，正则可能写错了`);
});

test('分支表 TOOL_CODES 覆盖了实现里每个工具实际会返回的 code（防漏测）', () => {
  const device = readFileSync(path.join(PLUGIN_ROOT, 'lib/tools/device.mjs'), 'utf8');
  const interact = readFileSync(path.join(PLUGIN_ROOT, 'lib/tools/interact.mjs'), 'utf8');

  /**
   * 从某个工具的实现段里扫 code。
   *
   * 工具实现是 `const XXX_EXECUTE = async (...) => { ... }` 到下一个 `/* ---` 分隔符或 schema 段；
   * 这里用「工具名 → 该文件里这个 execute 的文本区间」的约定粗略切分，够做交叉验证。
   *
   * @param {string} source 文件全文。
   * @param {string} executeName 例如 `APK_INSTALL_EXECUTE`。
   * @returns {Set<string>} 该段里出现的 code。
   */
  function codesInExecute(source, executeName) {
    const start = source.indexOf(`const ${executeName} = `);
    if (start === -1) return new Set();
    const rest = source.slice(start + 1);
    // 到下一个顶层 const/函数定义或分隔块为止
    const endMatch = /\n\/\* -{10,}|^const [A-Z_]+ = |^function |^export function /m.exec(rest);
    const block = endMatch === null ? rest : rest.slice(0, endMatch.index);
    const codes = new Set();
    for (const match of block.matchAll(/(?:R\.fail|toolError)\(\s*'([A-Z_]+)'/gu)) codes.add(match[1]);
    return codes;
  }

  /** 工具名 → 它所在文件 + execute 常量名。 */
  const locations = {
    android_status: [device, 'STATUS_EXECUTE'],
    android_avd_create: [device, 'AVD_CREATE_EXECUTE'],
    android_emulator_start: [device, 'EMULATOR_START_EXECUTE'],
    android_emulator_stop: [device, 'EMULATOR_STOP_EXECUTE'],
    android_apk_install: [device, 'APK_INSTALL_EXECUTE'],
    android_app_launch: [device, 'APP_LAUNCH_EXECUTE'],
    android_app_stop: [device, 'APP_STOP_EXECUTE'],
    android_logcat: [device, 'LOGCAT_EXECUTE'],
    android_ui_dump: [interact, 'UI_DUMP_EXECUTE'],
    android_ui_tap: [interact, 'UI_TAP_EXECUTE'],
    android_ui_swipe: [interact, 'UI_SWIPE_EXECUTE'],
    android_ui_input: [interact, 'UI_INPUT_EXECUTE'],
    android_ui_key: [interact, 'UI_KEY_EXECUTE'],
    android_ui_wait: [interact, 'UI_WAIT_EXECUTE'],
    android_screenshot: [interact, 'SCREENSHOT_EXECUTE'],
  };

  for (const [name, branches] of Object.entries(TOOL_CODES)) {
    const [source, executeName] = locations[name];
    const scanned = codesInExecute(source, executeName);
    // 允许分支表是扫描结果的超集吗？不——要求「扫描到的每个 code 都在表里」，
    // 反过来「表里有但实现没扫到」允许（有些 code 来自被调用函数，如 NO_SDK 来自 loadSdk）。
    for (const code of scanned) {
      assert.ok(
        branches.includes(code),
        `${name}: 实现里返回了 code "${code}"，但测试的分支表 TOOL_CODES 没覆盖它（补上并构造该分支的返回值校验）`,
      );
    }
  }
});

test('构造的 defaults 与真实 buildResult 语义一致：空值都能通过 schema', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-blank-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withNoSdkEnv(async () => {
    const tools = await loadToolDefinitions(offlineConfig(directory));
    for (const [name, definition] of tools) {
      const value = await definition.execute(offlineArgs(name), {});
      // defaults（去掉三件套）+ ok:true 也必须合法——证明「默认空值」本身就是 schema 的合法实例
      const blankSuccess = { ...defaultsOf(value), ok: true, code: 'OK', message: '空值成功' };
      const violations = validateToolOutput(definition.output.schema, blankSuccess);
      assert.deepEqual(violations, [], `${name}: defaults 空值不满足 schema：\n  ${violations.join('\n  ')}`);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5. v1.1.0 扩展：translation / abiKind 必须在**所有分支**完整出现
 * ------------------------------------------------------------------ */

/**
 * 断言一个 translation 对象是**完整的 8 字段**且类型正确。
 *
 * 为什么这么严：`translation` 在 output.schema 里是 `additionalProperties:false` 的嵌套 object，
 * 8 个子字段**全部 required**。少一个 → 运行时 `missing required property`；
 * 多一个 → `is not a declared property`。而 `undefined` 会被 JSON 投影直接丢掉，
 * 表现同样是「缺字段」，但错误信息更难读。所以任何分支都不允许 `{}` / `undefined` / 缺字段。
 *
 * @param {unknown} translation 待检查的 translation。
 * @param {string} label 诊断标签。
 * @returns {void}
 */
function assertCompleteTranslation(translation, label) {
  assert.equal(typeof translation, 'object', `${label}: translation 必须是对象`);
  assert.notEqual(translation, null, `${label}: translation 不能是 null`);
  assert.equal(Array.isArray(translation), false, `${label}: translation 不能是数组`);
  assert.notDeepEqual(translation, {}, `${label}: translation 不能是空对象（8 个字段必须都在）`);
  assert.deepEqual(
    Object.keys(translation).sort(),
    [...TRANSLATION_SUB_FIELDS].sort(),
    `${label}: translation 的键必须恰好是契约的 8 个`,
  );
  const types = {
    bridge: 'string',
    version: 'string',
    enabled: 'boolean',
    kind: 'string',
    arm64: 'boolean',
    arm32: 'boolean',
    abilist64: 'object',
    abilist32: 'object',
  };
  for (const [field, type] of Object.entries(types)) {
    assert.equal(typeof translation[field], type, `${label}.translation.${field} 类型应为 ${type}`);
    assert.notEqual(translation[field], undefined, `${label}.translation.${field} 不能是 undefined`);
  }
  for (const field of ['abilist64', 'abilist32']) {
    assert.ok(Array.isArray(translation[field]), `${label}.translation.${field} 必须是数组`);
    for (const entry of translation[field]) assert.equal(typeof entry, 'string');
  }
  assert.ok(
    ['ndk-translation', 'houdini', 'native', 'none'].includes(translation.kind),
    `${label}.translation.kind 非法：${translation.kind}`,
  );
}

test('v1.1.0：所有工具的**每一个** code 分支里，translation（若有）都是完整 8 字段', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-trans-branches-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withNoSdkEnv(async () => {
    const tools = await loadToolDefinitions(offlineConfig(directory));
    let checked = 0;
    for (const [name, definition] of tools) {
      const declaresTranslation = Object.hasOwn(definition.output.schema.properties, 'translation');
      const defaults = defaultsOf(await definition.execute(offlineArgs(name), {}));

      for (const code of TOOL_CODES[name]) {
        const value =
          code === 'OK'
            ? { ...defaults, ok: true, code: 'OK', message: 'x' }
            : { ...defaults, ok: false, code, message: 'x' };
        assertOutput(definition, value, `${name}（${code}）`, code);
        if (declaresTranslation) {
          assertCompleteTranslation(value.translation, `${name}（${code}）`);
          checked += 1;
        } else {
          assert.equal(Object.hasOwn(value, 'translation'), false, `${name} 不该有 translation`);
        }
      }
    }
    // 3 个工具 × 各自的分支数，确保真的覆盖到了
    assert.ok(checked >= 20, `translation 分支检查数太少（${checked}），分支表可能漏了工具`);
  });
});

test('v1.1.0：成功分支里的 translation 是**非空**真实形态（不是空值糊弄过去）', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-trans-success-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withNoSdkEnv(async () => {
    const tools = await loadToolDefinitions(offlineConfig(directory));
    const build = async (name, extras) => {
      const definition = tools.get(name);
      const defaults = defaultsOf(await definition.execute(offlineArgs(name), {}));
      return { definition, value: { ...defaults, ...extras, ok: true, code: 'OK', message: 'x' } };
    };

    // status：本机真实 ndk 形态
    const status = await build('android_status', { translation: NDK_TRANSLATION });
    assertOutput(status.definition, status.value, 'android_status 成功');
    assertCompleteTranslation(status.value.translation, 'android_status');
    assert.equal(status.value.translation.kind, 'ndk-translation');
    assert.equal(status.value.translation.arm64, true);
    assert.equal(status.value.translation.arm32, false);

    // apk_install：原始 arm-only APK 走转译（DESIGN §8 第 3 条的 v1.1.0 追加要求）
    const install = await build('android_apk_install', {
      package: 'com.example.demo',
      abis: ['arm64-v8a', 'armeabi-v7a'],
      deviceAbis: ['x86_64', 'arm64-v8a'],
      matchedAbi: 'arm64-v8a',
      abiKind: 'translated',
      translation: NDK_TRANSLATION,
      tips: ['该 APK 通过 ARM 转译（libndk_translation 0.2.3）运行：功能可用，但性能低于原生。'],
    });
    assertOutput(install.definition, install.value, 'android_apk_install 成功（translated）');
    assert.equal(install.value.abiKind, 'translated');
    assert.equal(install.value.matchedAbi, 'arm64-v8a');
    assertCompleteTranslation(install.value.translation, 'android_apk_install');

    // apk_install 的另外两种 abiKind 也是合法返回值
    for (const [abiKind, matchedAbi, abis] of [
      ['native', 'x86_64', ['x86_64']],
      ['none', 'no-native', []],
    ]) {
      const variant = await build('android_apk_install', {
        abis,
        deviceAbis: ['x86_64', 'arm64-v8a'],
        matchedAbi,
        abiKind,
        translation: NDK_TRANSLATION,
      });
      assertOutput(variant.definition, variant.value, `android_apk_install（abiKind=${abiKind}）`);
      assert.equal(variant.value.abiKind, abiKind);
    }

    // emulator_start：启动后探测到的转译能力
    const start = await build('android_emulator_start', {
      serial: 'emulator-5554',
      avd: 'dsh_android',
      pid: 12345,
      bootedInMs: 45000,
      logFile: 'C:\\tmp\\emulator.log',
      translation: NDK_TRANSLATION,
    });
    assertOutput(start.definition, start.value, 'android_emulator_start 成功');
    assertCompleteTranslation(start.value.translation, 'android_emulator_start');
  });
});

test('v1.1.0：失败分支的 translation / abiKind 是**合法空值**而不是 undefined 或 {}', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-trans-fail-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withNoSdkEnv(async () => {
    const tools = await loadToolDefinitions(offlineConfig(directory));
    for (const name of ['android_status', 'android_apk_install', 'android_emulator_start']) {
      const definition = tools.get(name);
      const value = await definition.execute(offlineArgs(name), {});
      // 失败的 translation 必须是 8 字段空值（kind=none），不能是 {} 也不能缺
      assertCompleteTranslation(value.translation, `${name}（失败）`);
      assert.equal(value.translation.kind, 'none', `${name}: 探测失败/无设备时 kind 应为 none`);
      assert.deepEqual(value.translation.abilist64, []);
      assert.deepEqual(value.translation.abilist32, []);
      // abiKind（只有 apk_install 有）在失败时是合法字面量
      if (Object.hasOwn(definition.output.schema.properties, 'abiKind')) {
        assert.ok(
          ['native', 'translated', 'none'].includes(value.abiKind),
          `${name}: 失败分支的 abiKind 非法：${value.abiKind}`,
        );
        assert.notEqual(value.abiKind, undefined);
        assert.notEqual(value.abiKind, '');
      }
    }
  });
});

test('v1.1.0：translation 是可无损 JSON 往返的纯数据（含数组）', () => {
  const value = { ...NDK_TRANSLATION, abilist64: [...NDK_TRANSLATION.abilist64], abilist32: [] };
  const text = JSON.stringify(value);
  assert.deepEqual(JSON.parse(text), value);
  // 校验器确实会拒绝「字段值为 undefined」（证明这套断言不是摆设）
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { enabled: { type: 'boolean' } },
    required: ['enabled'],
  };
  assert.ok(validateToolOutput(schema, { enabled: undefined }).length > 0);
});
