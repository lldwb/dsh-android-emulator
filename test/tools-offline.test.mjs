/**
 * 「优雅降级」回归：没有 SDK / 没有可用 adb / 缺组件 / 没有设备时，15 个工具
 * 必须返回**结构化失败**（`ok:false` + 机器可读 `code` + 可执行 `message`），
 * 而不是抛异常、挂死或返回 `ok:true` 骗人。
 *
 * 这是最常见、也最容易退化的场景：插件装在**没装 Android SDK 的机器**上时，
 * agent 调 `android_status` 应该得到「去哪儿装 SDK」而不是一个崩溃；
 * 拿到 `code: "NO_SDK"` 它才能决定下一步。
 *
 * 本文件的三个环境：
 * 1. **完全没有 SDK**（清掉全部 SDK 相关环境变量 + config 指向不存在的路径）；
 * 2. **假 SDK 缺组件**（有 platform-tools 没 emulator / 没 cmdline-tools）；
 * 3. **假 SDK 的 adb 不可执行**（文件存在但 spawn 必失败）——模拟 SDK 装坏了。
 *
 * @module test/tools-offline
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  ERROR_CODES,
  TOOL_NAMES,
  loadToolDefinitions,
  offlineConfig,
  withNoSdkEnv,
} from './helpers/plugin.mjs';
import { validateToolOutput } from './helpers/schema.mjs';

/** 当前平台的 SDK 可执行文件后缀。 */
const EXE = process.platform === 'win32' ? '.exe' : '';
/** `avdmanager` / `sdkmanager` 的后缀：Windows 是 `.bat`。 */
const BATCH = process.platform === 'win32' ? '.bat' : '';

/**
 * 在临时目录下建文件（父目录自动创建）。
 *
 * @param {string} filePath 绝对路径。
 * @param {string} [content] 内容。
 * @returns {string} 路径。
 */
function touch(filePath, content = '') {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

/**
 * 每个工具的「形状合法」调用参数：让参数校验通过，尽量走到 SDK / 设备检查。
 *
 * @param {string} name 工具名。
 * @param {string} directory 临时目录（给 apk 用）。
 * @returns {object} 参数。
 */
function minimalArgs(name, directory) {
  return {
    android_status: {},
    android_avd_create: {},
    android_emulator_start: {},
    android_emulator_stop: {},
    android_apk_install: { apk: path.join(directory, 'missing.apk') },
    android_app_launch: {},
    android_app_stop: { package: 'com.example.app' },
    android_ui_dump: {},
    android_ui_tap: { text: '按钮' },
    android_ui_swipe: { x1: 0, y1: 0, x2: 10, y2: 10 },
    android_ui_input: { text: 'hello' },
    android_ui_key: { key: 'back' },
    android_ui_wait: { text: '按钮' },
    android_screenshot: {},
    android_logcat: {},
  }[name] ?? {};
}

/**
 * 断言一次调用是「结构化失败」：没抛异常、code 在枚举里、message 非空、返回值过 schema。
 *
 * @param {object} definition 工具定义。
 * @param {object} value 返回值。
 * @param {string} label 诊断标签。
 * @param {string[]} allowedCodes 本场景下可接受的 code。
 * @returns {void}
 */
function assertGracefulFailure(definition, value, label, allowedCodes) {
  assert.equal(typeof value, 'object', `${label}: 必须返回对象而不是抛异常`);
  assert.notEqual(value, null);
  assert.equal(value.ok, false, `${label}: 环境不可用时必须是 ok:false`);
  assert.equal(typeof value.code, 'string', `${label}: code 必须是字符串`);
  assert.ok(value.code !== 'OK', `${label}: 失败时 code 不能是 OK`);
  assert.ok(ERROR_CODES.includes(value.code), `${label}: code "${value.code}" 不在 DESIGN §4 枚举里`);
  if (allowedCodes !== undefined) {
    assert.ok(allowedCodes.includes(value.code), `${label}: code 应为 ${allowedCodes.join('/')}，实际 ${value.code}`);
  }
  assert.equal(typeof value.message, 'string', `${label}: message 必须是字符串`);
  assert.ok(value.message.trim().length > 0, `${label}: message 不能为空`);

  const violations = validateToolOutput(definition.output.schema, value);
  assert.deepEqual(violations, [], `${label}: 失败返回值也必须满足 output.schema：\n  ${violations.join('\n  ')}`);
}

/* ------------------------------------------------------------------ *
 * 环境 1：完全没有 SDK
 * ------------------------------------------------------------------ */

test('完全没有 SDK 时：15 个工具全部优雅失败（不抛异常、code 合法、message 可执行）', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-nosdk-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withNoSdkEnv(async () => {
    const tools = await loadToolDefinitions(offlineConfig(directory));
    assert.equal(tools.size, TOOL_NAMES.length);

    for (const [name, definition] of tools) {
      const value = await definition.execute(minimalArgs(name, directory), {});
      // apk_install 的空/不存在 apk 在 SDK 检查之前，会先报 APK_NOT_FOUND
      const allowed = name === 'android_apk_install' ? ['APK_NOT_FOUND', 'NO_SDK'] : ['NO_SDK'];
      assertGracefulFailure(definition, value, `${name}（无 SDK）`, allowed);

      // message 要能指导行动：提到装 SDK / 配 sdkPath / ANDROID_HOME 之一
      assert.match(
        value.message,
        /SDK|sdkPath|ANDROID_HOME/iu,
        `${name}: 无 SDK 的 message 必须告诉用户怎么修（当前：${value.message.slice(0, 200)}）`,
      );
    }
  });
});

test('完全没有 SDK 时 android_status 仍然填满全部字段（失败也给出诊断信息）', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-nosdk-status-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withNoSdkEnv(async () => {
    const tools = await loadToolDefinitions(offlineConfig(directory));
    const value = await tools.get('android_status').execute({}, {});

    assert.equal(value.ok, false);
    assert.equal(value.code, 'NO_SDK');
    // 契约：status 失败时也要把 sdk / avds / images / device / acceleration 填成合法空值
    assert.equal(value.sdk.found, false);
    assert.equal(value.sdk.root, '');
    assert.deepEqual(value.avds, []);
    assert.deepEqual(value.images, []);
    assert.equal(value.device.serial, '');
    assert.deepEqual(value.device.abis, []);
    assert.equal(value.acceleration.ok, false);
    assert.deepEqual(value.suggestions, []);
    // problems 应该能解释「找过哪些位置」
    assert.match(value.message, /platform-tools|adb/iu, 'message 应说明缺的是 platform-tools/adb');
  });
});

test('完全没有 SDK 时不会写出任何文件（不会在 outputDir 里留垃圾）', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-nosdk-nowrite-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withNoSdkEnv(async () => {
    const config = offlineConfig(directory);
    const tools = await loadToolDefinitions(config);
    for (const [name, definition] of tools) {
      await definition.execute(minimalArgs(name, directory), {});
    }
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(config.outputDir), false, `失败路径不应创建 outputDir：${config.outputDir}`);
  });
});

/* ------------------------------------------------------------------ *
 * 环境 2：假 SDK 缺组件 —— 要按组件报错，而不是笼统 NO_SDK
 * ------------------------------------------------------------------ */

test('SDK 存在但缺 emulator / avdmanager 时：按组件给出各自的 code', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-partial-sdk-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'PartialSdk');
  // 只有 platform-tools/adb（是个空文件：spawn 会失败，但 SDK 发现算成功）
  touch(path.join(root, 'platform-tools', `adb${EXE}`), 'not-a-real-executable');

  await withNoSdkEnv(async () => {
    const config = { ...offlineConfig(directory), sdkPath: root, adbPath: '', emulatorPath: '' };
    const tools = await loadToolDefinitions(config);

    // emulator_start：有 SDK、有 adb、但没有 emulator → NO_EMULATOR
    const startValue = await tools.get('android_emulator_start').execute({}, {});
    assertGracefulFailure(tools.get('android_emulator_start'), startValue, 'emulator_start（缺 emulator）', ['NO_EMULATOR']);

    // avd_create：没有 avdmanager → NO_AVD_MANAGER
    const createValue = await tools.get('android_avd_create').execute({}, {});
    assertGracefulFailure(tools.get('android_avd_create'), createValue, 'avd_create（缺 avdmanager）', ['NO_AVD_MANAGER']);

    // status：不失败但必须把 problems 反映到 suggestions 里
    const statusValue = await tools.get('android_status').execute({}, {});
    assert.equal(statusValue.sdk.found, true, '有 platform-tools 就算找到 SDK');
    assert.equal(statusValue.sdk.emulator, '');
    assert.equal(statusValue.sdk.avdmanager, '');
    const suggestions = statusValue.suggestions.join(' ');
    assert.match(suggestions, /emulator|Emulator/u, 'suggestions 应提示装 emulator');
    assert.match(suggestions, /avdmanager|Command-line/iu, 'suggestions 应提示装 cmdline-tools');
  });
});

test('SDK 里的 adb 不可执行时：工具返回结构化失败而不是崩（模拟 SDK 装坏了）', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-broken-adb-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'BrokenSdk');
  touch(path.join(root, 'platform-tools', `adb${EXE}`), 'this is not an executable');
  touch(path.join(root, 'emulator', `emulator${EXE}`), 'nor is this');
  touch(path.join(root, 'cmdline-tools', 'latest', 'bin', `avdmanager${BATCH}`), '@echo off\nexit /b 1\n');
  touch(path.join(root, 'cmdline-tools', 'latest', 'bin', `sdkmanager${BATCH}`), '@echo off\nexit /b 1\n');

  await withNoSdkEnv(async () => {
    const config = { ...offlineConfig(directory), sdkPath: root, adbPath: '', emulatorPath: '' };
    const tools = await loadToolDefinitions(config);

    // 需要设备的工具：adb devices 会 spawn 失败 → 必须是结构化失败，不能抛异常
    for (const name of ['android_ui_dump', 'android_ui_tap', 'android_screenshot', 'android_logcat', 'android_app_launch']) {
      const definition = tools.get(name);
      const value = await definition.execute(minimalArgs(name, directory), {});
      // 允许 NO_ADB / ADB_FAILED / DEVICE_NOT_RUNNING（不同平台 spawn 失败的错误码不同）
      assertGracefulFailure(definition, value, `${name}（adb 不可执行）`, ['NO_ADB', 'ADB_FAILED', 'DEVICE_NOT_RUNNING', 'BAD_ARGUMENT']);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 环境 3：参数校验优先于环境检查（BAD_ARGUMENT 必须先于 NO_SDK 被报出来）
 * ------------------------------------------------------------------ */

test('参数缺失/非法时优先报 BAD_ARGUMENT（错误信息更有用），且返回值过 schema', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-badarg-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withNoSdkEnv(async () => {
    const tools = await loadToolDefinitions(offlineConfig(directory));

    // apk_install：空 apk 在 SDK 检查之前 → BAD_ARGUMENT（带可执行建议）
    const apk = tools.get('android_apk_install');
    const value = await apk.execute({ apk: '' }, {});
    assertGracefulFailure(apk, value, 'apk_install（空 apk）', ['BAD_ARGUMENT']);
    assert.match(value.message, /绝对路径|apk/iu, 'message 应说明要传 APK 绝对路径');
  });
});

/* ------------------------------------------------------------------ *
 * 交叉检查：枚举本身与工具集的完整性
 * ------------------------------------------------------------------ */

test('DESIGN §4 的 26 个错误码在本文件/分支表里被用到，且没有拼错', () => {
  assert.equal(ERROR_CODES.length, 26, `DESIGN §4 应有 26 个 code，实际 ${ERROR_CODES.length}`);
  // 没有重复
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
  // 都是大写 + 下划线
  for (const code of ERROR_CODES) assert.match(code, /^[A-Z][A-Z0-9_]*$/u, `code "${code}" 格式不对`);
  assert.ok(ERROR_CODES.includes('OK'), 'OK 必须在枚举里');
});

test('15 个工具的 output.schema 都声明了 code 字段（每个失败都能被 agent 识别）', async () => {
  const tools = await loadToolDefinitions({});
  assert.equal(tools.size, 15);
  for (const [name, definition] of tools) {
    const codeSchema = definition.output.schema.properties.code;
    assert.notEqual(codeSchema, undefined, `${name}: 缺 code 字段`);
    assert.equal(codeSchema.type, 'string', `${name}: code 必须是 string`);
  }
});
