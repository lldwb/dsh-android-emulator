/**
 * v1.2.0 多会话隔离的**工具级**验证（DESIGN §7.2）。
 *
 * `test/session.test.mjs` 验证的是 `lib/state.mjs` 的分区 API；这里验证**工具层**是否真的
 * 用上了那些分区，以及跨会话守卫是否生效：
 *
 * 1. **双会话 execute 级隔离**：同一个工具定义、两份 `exec`（不同 `agent.id`）调 `android_status`，
 *    各自看到自己的 `sessionKey`，`instances` 不串。
 * 2. **`DEVICE_BUSY` 跨会话守卫**：A 会话拥有 `emulator-5556`，B 显式传它调
 *    `android_screenshot` / `android_ui_dump` / `android_ui_tap` / `android_app_launch` /
 *    `android_emulator_stop` → 必须 `ok:false, code:"DEVICE_BUSY"` 且 message 说明归属。
 * 3. **`maxInstances` 钳制**：配置成 0 / 100 时，`instanceLimit.max` 必须落在 1..8。
 * 4. **`perSession: false`**：所有会话统一落到 `shared-default` 槽（v1.1 行为）。
 *
 * ## 为什么能离线测 `DEVICE_BUSY`（技巧说明）
 *
 * `resolveSerial()` 的归属守卫在 `adbDevices()` **之后**——它需要先拿到设备列表，才能判断
 * 「你给的这个 serial 确实在线、但它属于别人」。纯离线环境没有 adb，这条路径就测不到。
 *
 * 办法：把 `config.adbPath` 指向 **node 自己的可执行文件**，并在临时工作目录里放一个名为
 * `devices` 的脚本。于是 `run(node, ['devices'])` 会执行那个脚本、输出伪造的
 * `adb devices` 文本；守卫在拿到列表后立刻抛 `DEVICE_BUSY`，**不会**走到需要 `-s serial`
 * 的那些 adb 调用（那些才会因为 `-s` 不是 node 的合法选项而失败）。
 * 全程 `process.chdir` 到临时目录并在 finally 里切回，不碰真实设备、不污染仓库目录。
 *
 * @module test/session-tools
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { loadToolDefinitions, withNoSdkEnv } from './helpers/plugin.mjs';
import { validateToolOutput } from './helpers/schema.mjs';
import * as state from '../lib/state.mjs';

/** A 会话与 B 会话。 */
const A = 'session-A';
const B = 'session-B';
/** 契约规定的共享槽。 */
const SHARED = state.DEFAULT_SESSION_KEY;

/** 两个"在线设备"，A 拥有 5556，共享槽拥有 5554。 */
const FAKE_DEVICES = [
  'List of devices attached',
  'emulator-5554\tdevice',
  'emulator-5556\tdevice',
  '',
].join('\n');

/**
 * 在「假 adb devices」环境里跑一段测试。
 *
 * - `process.chdir` 到临时目录（`devices` 脚本要被 node 当模块解析）；
 * - `config.adbPath = process.execPath`，让 `run(adb, ['devices'])` 实际执行 `node devices`；
 * - `sdkPath` 指向不存在的路径，保持 SDK 其余发现路径干净；
 * - finally 里一定恢复 cwd 与 state。
 *
 * @param {string} directory 临时目录。
 * @param {(config: object) => Promise<void>} body 测试主体。
 * @returns {Promise<void>}
 */
async function withFakeAdbDevices(directory, body) {
  writeFileSync(path.join(directory, 'devices'), `process.stdout.write(${JSON.stringify(FAKE_DEVICES)});\n`, 'utf8');
  const config = {
    sdkPath: path.join(directory, '__no_sdk_here__'),
    adbPath: process.execPath,
    emulatorPath: path.join(directory, '__no_emulator_here__', 'emulator.exe'),
    outputDir: path.join(directory, 'output'),
    bootTimeoutMs: 50,
  };
  const original = process.cwd();
  process.chdir(directory);
  try {
    await withNoSdkEnv(async () => {
      await body(config);
    });
  } finally {
    process.chdir(original);
    state.resetState();
  }
}

/**
 * 断言一个工具在这个场景下返回结构化的 `DEVICE_BUSY`（且 message 说明归属、返回值过 schema）。
 *
 * @param {object} definition 工具定义。
 * @param {object} value 返回值。
 * @param {string} label 诊断标签。
 * @param {string} owner 期望在 message 里出现的归属会话
 * @returns {void}
 */
function assertDeviceBusy(definition, value, label, owner) {
  assert.equal(value.ok, false, `${label}: 跨会话操作必须 ok:false`);
  assert.equal(value.code, 'DEVICE_BUSY', `${label}: code 应为 DEVICE_BUSY，实际 ${value.code}`);
  assert.equal(typeof value.message, 'string');
  assert.ok(value.message.length > 0, `${label}: message 不能为空`);
  // 归属说明：message 里要能看出"这台设备属于别的会话"
  assert.match(value.message, /属于另一个会话|另外的会话|别的会话/u, `${label}: message 要说明归属：${value.message.slice(0, 160)}`);
  if (owner !== '') {
    assert.ok(
      value.message.includes(state.shortSessionKey(owner)),
      `${label}: message 里应出现归属会话标识（${state.shortSessionKey(owner)}）：${value.message.slice(0, 160)}`,
    );
  }
  const violations = validateToolOutput(definition.output.schema, value);
  assert.deepEqual(violations, [], `${label}: 返回值必须满足 output.schema：\n  ${violations.join('\n  ')}`);
}

/* ------------------------------------------------------------------ *
 * 1. 双会话 execute 级隔离
 * ------------------------------------------------------------------ */

test('双会话：同一个 status 工具、两份 exec，各自返回自己的 sessionKey', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-v12-iso-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withFakeAdbDevices(directory, async (config) => {
    const tools = await loadToolDefinitions(config);
    const status = tools.get('android_status');
    state.resetState();

    const forA = await status.execute({}, { agent: { id: A } });
    const forB = await status.execute({}, { agent: { id: B } });

    assert.equal(forA.sessionKey, A, `A 会话应看到自己的 sessionKey，实际 ${forA.sessionKey}`);
    assert.equal(forB.sessionKey, B, `B 会话应看到自己的 sessionKey，实际 ${forB.sessionKey}`);
    assert.notEqual(forA.sessionKey, forB.sessionKey);

    // 没有 agent 上下文 → 共享槽
    const forShared = await status.execute({}, {});
    assert.equal(forShared.sessionKey, SHARED);
  });
});

test('双会话：instances 展示的是**全部**会话的占用（不是只有自己的）', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-v12-instances-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withFakeAdbDevices(directory, async (config) => {
    const tools = await loadToolDefinitions(config);
    const status = tools.get('android_status');
    state.resetState();
    // 两个会话各登记一台设备
    state.setProcess('emulator-5554', { pid: 111, avd: 'dsh_android--aaaa', logFile: 'a.log', sessionKey: A });
    state.setProcess('emulator-5556', { pid: 222, avd: 'dsh_android--bbbb', logFile: 'b.log', sessionKey: B });

    const forA = await status.execute({}, { agent: { id: A } });
    assert.equal(forA.sessionKey, A);
    // instances 是跨会话视图：两个会话都该看到 2 条
    assert.equal(forA.instances.length, 2, `instances 应包含全部会话的实例，实际 ${forA.instances.length}`);
    const owners = new Set(forA.instances.map((entry) => entry.sessionKey));
    assert.ok(owners.has(state.shortSessionKey(A)), `instances 应含 A 的标识：${[...owners].join(',')}`);
    assert.ok(owners.has(state.shortSessionKey(B)), `instances 应含 B 的标识：${[...owners].join(',')}`);
    // 每个实例的 6 个字段都要在
    for (const entry of forA.instances) {
      assert.deepEqual(
        Object.keys(entry).sort(),
        ['avd', 'booted', 'lastPackage', 'pid', 'serial', 'sessionKey'],
        'instances[] 的字段必须是契约的 6 个',
      );
    }
  });
});

test('双会话：A 的 current 设备不会被 B 的 status 当成自己的', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-v12-current-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withFakeAdbDevices(directory, async (config) => {
    const tools = await loadToolDefinitions(config);
    const status = tools.get('android_status');
    state.resetState();
    state.setCurrent(A, { serial: 'emulator-5554', avd: 'dsh_android--aaaa' });

    const forB = await status.execute({}, { agent: { id: B } });
    // B 没有自己的 current，device 应该是空（不是 A 的 5554）
    assert.notEqual(forB.device.serial, 'emulator-5554', 'B 不该把 A 的 current 设备当自己的');
    assert.equal(forB.sessionKey, B);
  });
});

test('双会话：A 记住的包不会被 B 的 app_launch 当成默认 package', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-v12-pkg-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withFakeAdbDevices(directory, async (config) => {
    const tools = await loadToolDefinitions(config);
    const launch = tools.get('android_app_launch');
    state.resetState();
    state.rememberPackage(A, 'com.example.only-a');

    // B 省略 package → 应该报 BAD_ARGUMENT（因为 B 自己没有 lastPackage），而不是启动 A 的包
    const forB = await launch.execute({}, { agent: { id: B } });
    assert.equal(forB.ok, false, 'B 没有包可启动时不该成功');
    assert.equal(forB.code, 'BAD_ARGUMENT', `应报 BAD_ARGUMENT，实际 ${forB.code}`);
    assert.match(forB.message, /package/u);

    // A 省略 package → 用自己记住的包（会走到 adb 层，code 不是 BAD_ARGUMENT 即可）
    const forA = await launch.execute({}, { agent: { id: A } });
    assert.notEqual(forA.code, 'BAD_ARGUMENT', 'A 有自己的 lastPackage，不该报缺参数');
  });
});

/* ------------------------------------------------------------------ *
 * 2. DEVICE_BUSY 跨会话守卫（5 个工具）
 * ------------------------------------------------------------------ */

test('DEVICE_BUSY：B 显式传 A 的 serial → screenshot / ui_dump / ui_tap / app_launch 全部拒绝', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-v12-busy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withFakeAdbDevices(directory, async (config) => {
    const tools = await loadToolDefinitions(config);
    state.resetState();
    // A 拥有 emulator-5556（且在 adb devices 里在线）
    state.setProcess('emulator-5556', { pid: 222, avd: 'dsh_android--aaaa', logFile: 'a.log', sessionKey: A });
    const execB = { agent: { id: B } };

    /** 需要被守卫的工具 + 一份形状合法的参数。 */
    const cases = [
      ['android_screenshot', { serial: 'emulator-5556' }],
      ['android_ui_dump', { serial: 'emulator-5556' }],
      ['android_ui_tap', { serial: 'emulator-5556', text: '按钮' }],
      ['android_app_launch', { serial: 'emulator-5556', package: 'com.example.demo' }],
    ];
    for (const [name, args] of cases) {
      const definition = tools.get(name);
      const value = await definition.execute(args, execB);
      assertDeviceBusy(definition, value, `${name}（传 A 的 serial）`, A);
    }
  });
});

test('DEVICE_BUSY：emulator_stop 传别人的 serial 也拒绝（不静默停别人的设备）', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-v12-stopbusy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withFakeAdbDevices(directory, async (config) => {
    const tools = await loadToolDefinitions(config);
    state.resetState();
    state.setProcess('emulator-5556', { pid: 222, avd: 'dsh_android--aaaa', logFile: 'a.log', sessionKey: A });

    const definition = tools.get('android_emulator_stop');
    const value = await definition.execute({ serial: 'emulator-5556' }, { agent: { id: B } });
    assertDeviceBusy(definition, value, 'android_emulator_stop（传 A 的 serial）', A);
  });
});

test('DEVICE_BUSY 守卫不误伤：本会话传自己的 serial 不会被拦', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-v12-noFalsePositive-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withFakeAdbDevices(directory, async (config) => {
    const tools = await loadToolDefinitions(config);
    state.resetState();
    state.setProcess('emulator-5556', { pid: 222, avd: 'dsh_android--aaaa', logFile: 'a.log', sessionKey: A });

    // A 传自己的 serial → 不该是 DEVICE_BUSY（会继续往下走 adb，最终是 ADB_FAILED 之类）
    const value = await tools.get('android_screenshot').execute({ serial: 'emulator-5556' }, { agent: { id: A } });
    assert.notEqual(value.code, 'DEVICE_BUSY', '本会话操作自己的设备不能被拦');
  });
});

test('DEVICE_BUSY 守卫：未登记的 serial 走 DEVICE_NOT_RUNNING（不是静默接受）', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-v12-unknown-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withFakeAdbDevices(directory, async (config) => {
    const tools = await loadToolDefinitions(config);
    state.resetState();
    // adb devices 里没有 emulator-9998
    const value = await tools.get('android_screenshot').execute({ serial: 'emulator-9998' }, { agent: { id: B } });
    assert.equal(value.ok, false);
    assert.equal(value.code, 'DEVICE_NOT_RUNNING', `应为 DEVICE_NOT_RUNNING，实际 ${value.code}`);
  });
});

test('emulator_stop：对「从未存在过」的 serial 必须报 DEVICE_NOT_RUNNING，不能伪造「已停止 1 台」', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-v12-stopghost-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withFakeAdbDevices(directory, async (config) => {
    const tools = await loadToolDefinitions(config);
    state.resetState();
    const definition = tools.get('android_emulator_stop');

    // 回归用例（真机双会话 e2e 抓到）：A 会话启动超时后 state.deleteProcess 会清掉归属
    // 记录，此时 B 传 A 的已死 serial，旧实现既没被 DEVICE_BUSY 拦住、又打出
    // 「已停止本会话 1 台模拟器」——一个纯粹伪造的成功。现在必须明确 DEVICE_NOT_RUNNING。
    const value = await definition.execute({ serial: 'emulator-9998' }, { agent: { id: B } });
    assert.equal(value.ok, false, `不应报告成功：${JSON.stringify(value).slice(0, 300)}`);
    assert.equal(value.code, 'DEVICE_NOT_RUNNING', `应为 DEVICE_NOT_RUNNING，实际 ${value.code}`);
    assert.deepEqual(
      validateToolOutput(definition.output.schema, value),
      [],
      '失败分支的返回值也必须满足 output.schema',
    );
  });
});

/* ------------------------------------------------------------------ *
 * 3. maxInstances 钳制与 perSession
 * ------------------------------------------------------------------ */

test('maxInstances 钳制：配置 0 / 1 / 2 / 100 时 instanceLimit.max 都落在 1..8', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-v12-max-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withFakeAdbDevices(directory, async (baseConfig) => {
    for (const [configured, expected] of [
      [0, 1],
      [1, 1],
      [2, 2],
      [8, 8],
      [100, 8],
      [-5, 1],
      ['abc', 2],
      [undefined, 2],
    ]) {
      const config = { ...baseConfig, maxInstances: configured };
      const tools = await loadToolDefinitions(config);
      const value = await tools.get('android_status').execute({}, { agent: { id: A } });
      assert.equal(
        value.instanceLimit.max,
        expected,
        `maxInstances=${String(configured)} 应被钳制成 ${expected}，实际 ${value.instanceLimit.max}`,
      );
      assert.ok(value.instanceLimit.max >= 1 && value.instanceLimit.max <= 8);
    }
  });
});

test('perSession: false → 两个会话统一落到共享槽（v1.1 行为）', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-v12-shared-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withFakeAdbDevices(directory, async (baseConfig) => {
    const tools = await loadToolDefinitions({ ...baseConfig, perSession: false });
    const status = tools.get('android_status');
    state.resetState();

    const forA = await status.execute({}, { agent: { id: A } });
    const forB = await status.execute({}, { agent: { id: B } });
    assert.equal(forA.sessionKey, SHARED, 'perSession:false 时 A 应落到共享槽');
    assert.equal(forB.sessionKey, SHARED, 'perSession:false 时 B 也应落到共享槽');
    assert.equal(forA.sessionKey, forB.sessionKey);
  });
});

test('perSession 默认（true）：不同会话的 sessionKey 不同', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-v12-default-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withFakeAdbDevices(directory, async (baseConfig) => {
    const tools = await loadToolDefinitions(baseConfig);
    const status = tools.get('android_status');
    state.resetState();
    const forA = await status.execute({}, { agent: { id: A } });
    const forB = await status.execute({}, { agent: { id: B } });
    assert.notEqual(forA.sessionKey, forB.sessionKey, '默认必须隔离');
  });
});

test('AVD 命名在工具层生效：emulator_start 的失败/成功返回里 sessionKey 与 createdAvd 类型正确', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-v12-startfields-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await withFakeAdbDevices(directory, async (config) => {
    const tools = await loadToolDefinitions(config);
    const definition = tools.get('android_emulator_start');
    const value = await definition.execute({}, { agent: { id: A } });
    assert.equal(typeof value.sessionKey, 'string');
    assert.ok(value.sessionKey.length > 0);
    assert.equal(typeof value.createdAvd, 'boolean');
    const violations = validateToolOutput(definition.output.schema, value);
    assert.deepEqual(violations, [], `emulator_start 返回值不满足 schema：\n  ${violations.join('\n  ')}`);
  });
});
