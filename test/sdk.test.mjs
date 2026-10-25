/**
 * `lib/sdk.mjs` 的测试：假 SDK 目录结构 + 自造 zip，全程不碰真机。
 *
 * 这一层的关键不是「能找到 SDK」（本机明明装了），而是：
 *   1. **按组件报告缺失**——有 adb 没 emulator 时应该是 `NO_EMULATOR`，不是笼统的 `NO_SDK`；
 *   2. **ABI 预检的数据来源**——`apkAbis` 必须从 zip 中央目录读出 `lib/<abi>/`，
 *      因为它是 `ABI_MISMATCH` 的唯一依据；读错了就会出现「明明能装却报不匹配」；
 *   3. **畸形 APK 不能炸**——不存在/损坏/非 zip 都要归一成 `APK_NOT_FOUND` / `APK_UNREADABLE`。
 *
 * 假 SDK 用临时目录搭：结构对了，代码路径就都能走。zip 用 `test/helpers/zip.mjs` 手写
 * （STORED 条目 + 正确 CRC），这样连 `readZipEntries` 的字节偏移也一并验证。
 *
 * @module test/sdk
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  accelCheck,
  apkAbis,
  apkInfo,
  discoverSdk,
  extractZipEntry,
  hostPreferredAbi,
  listAvds,
  listSystemImages,
  readZipEntries,
  sdkProblemSummary,
} from '../lib/sdk.mjs';
import { makeFakeApkZip, makeStoredZip } from './helpers/zip.mjs';

/** 当前平台的 SDK 可执行文件后缀（实现里 `EXE` / `BATCH` 也是这么算的）。 */
const EXE = process.platform === 'win32' ? '.exe' : '';
const BATCH = process.platform === 'win32' ? '.bat' : '';

/**
 * 在临时目录下建一个文件（父目录自动创建）。
 *
 * @param {string} filePath 绝对路径。
 * @param {string | Buffer} [content] 内容。
 * @returns {string} 该路径。
 */
function touch(filePath, content = '') {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

/**
 * 建一个「完整」的假 SDK 目录树。
 *
 * @param {string} root 假 SDK 根。
 * @returns {string} root。
 */
function buildFakeSdk(root) {
  touch(path.join(root, 'platform-tools', `adb${EXE}`), 'fake adb');
  touch(path.join(root, 'emulator', `emulator${EXE}`), 'fake emulator');
  touch(path.join(root, 'cmdline-tools', 'latest', 'bin', `avdmanager${BATCH}`), '@echo off');
  touch(path.join(root, 'cmdline-tools', 'latest', 'bin', `sdkmanager${BATCH}`), '@echo off');
  // 新布局：system-images/<api>/<tag>/<abi>/
  mkdirSync(path.join(root, 'system-images', 'android-35', 'google_apis', 'x86_64'), { recursive: true });
  // 旧布局：system-images/<api>/<abi>/（没有 tag 层，tag 视为 default）
  mkdirSync(path.join(root, 'system-images', 'android-33', 'x86_64'), { recursive: true });
  return root;
}

/**
 * 在隔离的环境变量下执行（SDK 自动发现依赖 env，测试必须能控制它）。
 *
 * 为什么要连 `PATH` 一起清空：实现的最后兜底是 `which('adb')` —— 如果跑测试的机器上
 * PATH 里恰好有 adb，「无 SDK」用例就会莫名其妙变成 found:true。清空后测的是插件逻辑，
 * 而不是这台机器的安装状态。
 *
 * @param {Record<string, string | undefined>} overrides 要设置的环境变量（`undefined` = 删除）。
 * @param {() => Promise<unknown>} body 执行体。
 * @returns {Promise<unknown>} body 的返回值。
 */
async function withEnv(overrides, body) {
  const keys = ['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_AVD_HOME', 'ANDROID_USER_HOME', 'LOCALAPPDATA', 'USERPROFILE', 'PATH', 'Path', ...Object.keys(overrides)];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/* ------------------------------------------------------------------ *
 * discoverSdk
 * ------------------------------------------------------------------ */

test('discoverSdk：从 config.sdkPath 找到完整 SDK，各组件路径都对', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-sdk-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = buildFakeSdk(path.join(directory, 'Sdk'));

  const sdk = await withEnv({ sdkPath: undefined, ANDROID_HOME: undefined, ANDROID_SDK_ROOT: undefined }, () =>
    discoverSdk({ sdkPath: root }),
  );

  assert.equal(sdk.found, true);
  assert.equal(sdk.root, root);
  assert.equal(sdk.adb, path.join(root, 'platform-tools', `adb${EXE}`));
  assert.equal(sdk.emulator, path.join(root, 'emulator', `emulator${EXE}`));
  assert.equal(sdk.avdmanager, path.join(root, 'cmdline-tools', 'latest', 'bin', `avdmanager${BATCH}`));
  assert.equal(sdk.sdkmanager, path.join(root, 'cmdline-tools', 'latest', 'bin', `sdkmanager${BATCH}`));
  assert.deepEqual(sdk.problems, [], `完整 SDK 不应报问题：${sdk.problems.join(' | ')}`);
});

test('discoverSdk：ANDROID_HOME 也会被采纳（config 未给时）', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-sdk-env-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = buildFakeSdk(path.join(directory, 'SdkFromEnv'));

  const sdk = await withEnv(
    { ANDROID_HOME: root, ANDROID_SDK_ROOT: undefined, PATH: '', Path: '', LOCALAPPDATA: undefined, USERPROFILE: undefined },
    () => discoverSdk(),
  );
  assert.equal(sdk.found, true);
  assert.equal(sdk.root, root);
});

test('discoverSdk：找不到时 found=false、root 为空、problems 非空且说明找过哪些位置', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-sdk-none-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const missing = path.join(directory, '__no_sdk_here__');

  const sdk = await withEnv(
    {
      ANDROID_HOME: undefined,
      ANDROID_SDK_ROOT: undefined,
      LOCALAPPDATA: undefined,
      USERPROFILE: undefined,
      PATH: '',
      Path: '',
    },
    () => discoverSdk({ sdkPath: missing }),
  );

  assert.equal(sdk.found, false);
  assert.equal(sdk.root, '');
  assert.equal(sdk.adb, '');
  assert.equal(sdk.emulator, '');
  assert.ok(sdk.problems.length > 0, 'problems 必须解释为什么找不到');
  const joined = sdk.problems.join(' ');
  assert.match(joined, /adb/u, 'problems 要提到 adb');
  assert.match(joined, /emulator/u, 'problems 要提到 emulator');
  assert.match(joined, /avdmanager/u, 'problems 要提到 avdmanager');
});

test('discoverSdk：只有 adb 没有 emulator 时按组件报告缺失（不是笼统 NO_SDK）', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-sdk-partial-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'PartialSdk');
  touch(path.join(root, 'platform-tools', `adb${EXE}`), 'fake adb');

  const sdk = await withEnv(
    { ANDROID_HOME: undefined, ANDROID_SDK_ROOT: undefined, PATH: '', Path: '', LOCALAPPDATA: undefined, USERPROFILE: undefined },
    () => discoverSdk({ sdkPath: root }),
  );

  assert.equal(sdk.found, true, '有 adb 就算 found');
  assert.equal(sdk.root, root);
  assert.equal(sdk.emulator, '');
  assert.equal(sdk.avdmanager, '');
  const joined = sdk.problems.join(' ');
  assert.match(joined, /emulator/u, '要明确说「找不到 emulator」');
  assert.match(joined, /avdmanager/u, '要明确说「找不到 avdmanager」');
});

test('discoverSdk：config.adbPath / emulatorPath 显式覆盖生效，指向不存在的文件时报告问题', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-sdk-override-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = buildFakeSdk(path.join(directory, 'Sdk'));
  const customAdb = touch(path.join(directory, 'custom', `adb${EXE}`), 'custom adb');

  const overridden = await withEnv(
    { ANDROID_HOME: undefined, ANDROID_SDK_ROOT: undefined, PATH: '', Path: '', LOCALAPPDATA: undefined, USERPROFILE: undefined },
    () => discoverSdk({ sdkPath: root, adbPath: customAdb }),
  );
  assert.equal(overridden.adb, customAdb, 'config.adbPath 必须优先于 SDK 里的 adb');

  const bogus = await withEnv(
    { ANDROID_HOME: undefined, ANDROID_SDK_ROOT: undefined, PATH: '', Path: '', LOCALAPPDATA: undefined, USERPROFILE: undefined },
    () =>
      discoverSdk({
        sdkPath: root,
        adbPath: path.join(directory, 'nope', 'adb.exe'),
        emulatorPath: path.join(directory, 'nope', 'emulator.exe'),
      }),
  );
  const joined = bogus.problems.join(' ');
  assert.match(joined, /config\.adbPath/u);
  assert.match(joined, /config\.emulatorPath/u);
});

/* ------------------------------------------------------------------ *
 * listSystemImages
 * ------------------------------------------------------------------ */

test('listSystemImages：解析 api/tag/abi，兼容旧布局与排序', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-images-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = buildFakeSdk(path.join(directory, 'Sdk'));

  const images = await listSystemImages({ root });
  assert.equal(images.length, 2, `期望 2 个镜像，实际 ${JSON.stringify(images)}`);

  const modern = images.find((image) => image.api === 35);
  assert.notEqual(modern, undefined);
  assert.equal(modern.package, 'system-images;android-35;google_apis;x86_64');
  assert.equal(modern.api, 35);
  assert.equal(modern.tag, 'google_apis');
  assert.equal(modern.abi, 'x86_64');
  assert.ok(modern.path.startsWith(root), 'path 必须落在 SDK 根下');

  const legacy = images.find((image) => image.api === 33);
  assert.notEqual(legacy, undefined);
  assert.equal(legacy.package, 'system-images;android-33;default;x86_64');
  assert.equal(legacy.tag, 'default', '旧布局没有 tag 层，tag 应为 default');
  assert.equal(legacy.abi, 'x86_64');

  // 新 API 排前面（工具层选镜像时优先用新的）
  assert.deepEqual(images.map((image) => image.api), [35, 33]);
});

test('listSystemImages：root 为空 / 没有 system-images 时返回空数组', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-images-empty-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  assert.deepEqual(await listSystemImages({ root: '' }), []);
  assert.deepEqual(await listSystemImages({}), []);
  assert.deepEqual(await listSystemImages({ root: path.join(directory, 'Sdk') }), []);
});

/* ------------------------------------------------------------------ *
 * apkAbis / readZipEntries / apkInfo
 * ------------------------------------------------------------------ */

test('apkAbis：从 zip 中央目录读出 lib/<abi>/ 并去重、保持条目顺序', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-apk-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const apk = path.join(directory, 'app.apk');
  writeFileSync(apk, makeFakeApkZip(['arm64-v8a', 'x86_64']));

  assert.deepEqual(await apkAbis(apk), ['arm64-v8a', 'x86_64']);

  // 同一个 ABI 出现多次（多个 .so）只算一次
  const duplicated = path.join(directory, 'dup.apk');
  writeFileSync(
    duplicated,
    makeStoredZip([
      { name: 'lib/arm64-v8a/liba.so', data: 'a' },
      { name: 'lib/arm64-v8a/libb.so', data: 'b' },
      { name: 'lib/x86_64/liba.so', data: 'c' },
      { name: 'lib/x86_64/libb.so', data: 'd' },
    ]),
  );
  assert.deepEqual(await apkAbis(duplicated), ['arm64-v8a', 'x86_64']);
});

test('apkAbis：没有 lib/ 的纯 Java APK 返回空数组（任何 ABI 都能装）', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-apk-java-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const javaOnly = path.join(directory, 'java-only.apk');
  writeFileSync(javaOnly, makeStoredZip([{ name: 'classes.dex', data: 'dex\n035\0' }]));
  assert.deepEqual(await apkAbis(javaOnly), []);

  // 空 zip（只有 EOCD）也不应崩
  const empty = path.join(directory, 'empty.apk');
  writeFileSync(empty, makeStoredZip([]));
  assert.deepEqual(await apkAbis(empty), []);
});

test('apkAbis：不存在的文件抛 APK_NOT_FOUND，损坏/非 zip 抛 APK_UNREADABLE', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-apk-bad-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await assert.rejects(
    () => apkAbis(path.join(directory, 'does-not-exist.apk')),
    (error) => error?.code === 'APK_NOT_FOUND',
  );

  // 太小的文件
  const tiny = path.join(directory, 'tiny.apk');
  writeFileSync(tiny, Buffer.from('not a zip'));
  await assert.rejects(
    () => apkAbis(tiny),
    (error) => error?.code === 'APK_UNREADABLE',
  );

  // 够大但找不到 EOCD：改后缀的假文件
  const faker = path.join(directory, 'fake.apk');
  writeFileSync(faker, Buffer.alloc(256, 0x41));
  await assert.rejects(
    () => apkAbis(faker),
    (error) => error?.code === 'APK_UNREADABLE',
  );
});

test('readZipEntries / extractZipEntry：能读回 STORED 条目的原始内容', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-zip-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const apk = path.join(directory, 'app.apk');
  writeFileSync(
    apk,
    makeStoredZip([
      { name: 'AndroidManifest.xml', data: 'manifest-bytes' },
      { name: 'resources.arsc', data: 'arsc-bytes' },
    ]),
  );

  const entries = await readZipEntries(apk);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['AndroidManifest.xml', 'resources.arsc'],
  );
  for (const entry of entries) {
    assert.equal(entry.method, 0, '测试用的 zip 都是 STORED');
    assert.ok(entry.localOffset >= 0, `localOffset 必须有效：${entry.name}`);
    assert.ok(entry.localOffset < 1024, `localOffset 应指向文件内偏移：${entry.name}`);
  }

  const manifest = entries.find((entry) => entry.name === 'AndroidManifest.xml');
  const content = await extractZipEntry(apk, manifest);
  assert.equal(content.toString('utf8'), 'manifest-bytes');
});

test('apkInfo：manifest 解析失败不致命（包名留空，交给工具层兜底）', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-apkinfo-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const apk = path.join(directory, 'app.apk');
  // makeFakeApkZip 里的 AndroidManifest.xml 是 4 字节假数据 → 不是合法 AXML
  writeFileSync(apk, makeFakeApkZip(['x86_64']));

  const info = await apkInfo(apk);
  assert.deepEqual(info.abis, ['x86_64']);
  assert.equal(info.package, '');
  assert.equal(info.versionName, '');
  assert.equal(info.versionCode, 0);
});

/* ------------------------------------------------------------------ *
 * listAvds
 * ------------------------------------------------------------------ */

test('listAvds：从 ANDROID_AVD_HOME 的 <name>.avd/config.ini 解析 target/abi/device', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-avd-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const avdHome = path.join(directory, 'avd-home');
  touch(
    path.join(avdHome, 'dsh_android.avd', 'config.ini'),
    [
      'target=android-35',
      'abi.type=x86_64',
      'image.sysdir.1=system-images/android-35/google_apis/x86_64/',
      'hw.device.name=pixel_6',
      '',
    ].join('\n'),
  );

  const avds = await withEnv({ ANDROID_AVD_HOME: avdHome, ANDROID_USER_HOME: undefined }, () =>
    listAvds({ emulator: '' }),
  );
  assert.equal(avds.length, 1, `期望 1 个 AVD，实际 ${JSON.stringify(avds)}`);
  assert.equal(avds[0].name, 'dsh_android');
  assert.equal(avds[0].abi, 'x86_64');
  assert.equal(avds[0].target, 'android-35');
  assert.equal(avds[0].device, 'pixel_6');
  assert.ok(avds[0].path.endsWith('dsh_android.avd'), `path 应指向 .avd 目录：${avds[0].path}`);
});

test('listAvds：没有任何 AVD 时返回空数组', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-avd-empty-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const avdHome = path.join(directory, 'empty-avd-home');
  mkdirSync(avdHome, { recursive: true });

  const avds = await withEnv({ ANDROID_AVD_HOME: avdHome, ANDROID_USER_HOME: undefined }, () =>
    listAvds({ emulator: '' }),
  );
  assert.deepEqual(avds, []);
});

/* ------------------------------------------------------------------ *
 * 其它
 * ------------------------------------------------------------------ */

test('accelCheck：没有 emulator 时明确返回 ok:false 与原因，不抛', async () => {
  const result = await accelCheck({});
  assert.equal(result.ok, false);
  assert.equal(result.kind, '');
  assert.equal(typeof result.raw, 'string');
  assert.ok(result.raw.length > 0);
});

test('hostPreferredAbi：与主机架构一致（x86_64 主机 → x86_64）', () => {
  const abi = hostPreferredAbi();
  if (process.arch === 'x64') assert.equal(abi, 'x86_64');
  else if (process.arch === 'ia32') assert.equal(abi, 'x86');
  else if (process.arch === 'arm64') assert.equal(abi, 'arm64-v8a');
  assert.equal(typeof abi, 'string');
});

test('sdkProblemSummary：把 problems 拼成一句人话；没有问题返回空串', () => {
  assert.equal(sdkProblemSummary({ problems: [] }), '');
  assert.equal(sdkProblemSummary({}), '');
  assert.equal(sdkProblemSummary(null), '');
  assert.equal(sdkProblemSummary({ problems: ['找不到 adb。', '找不到 emulator。'] }), '找不到 adb。 找不到 emulator。');
});
