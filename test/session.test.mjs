/**
 * v1.2.0 多会话隔离：`sessionKey` 与**状态分区**的离线单测（DESIGN §7.2）。
 *
 * ## 为什么这一组必须单独钉死
 *
 * v1.1 的状态全是「模块级单例」（`let current` / `Map processes` / `lastPackage`），
 * 一个 Host 进程里的多个会话**共享**同一台设备：A 启动的设备会被 B 的 screenshot/tap 直接操作，
 * A 的 `emulator_stop` 会停掉 B 正在用的设备。v1.2.0 把这些状态按 `sessionKey` 分区。
 *
 * 这类 bug 的特点是**不报错、只串味**：如果分区写错（比如 `setCurrent` 忘了带 key），
 * 单会话测试全绿，但两个会话一起用就会互相踩。所以这里直接对 state API 做 A/B 交叉断言，
 * 不经过任何工具、不连真机。
 *
 * 兼容性同样要钉：v1.1 的调用方（以及脚本直调）都是**无参**的 `getCurrent()`，
 * 不能因为加了分区就炸——无参必须等价于 `'shared-default'` 槽。
 *
 * @module test/session
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import * as state from '../lib/state.mjs';

/** 两个测试用会话 key。 */
const A = 'session-A';
const B = 'session-B';

/** 契约规定「没有 agent 上下文」时用的共享槽名。 */
const SHARED = 'shared-default';

/**
 * 取一个可能尚未导出的函数（impl 落盘过程中逐步补齐时，测试给出清晰失败而不是 import 崩溃）。
 *
 * @param {string} name 函数名。
 * @returns {Function} 函数。
 */
function fn(name) {
  const candidate = /** @type {Record<string, unknown>} */ (state)[name];
  assert.equal(typeof candidate, 'function', `lib/state.mjs 未导出 ${name}（v1.2.0 契约要求）`);
  return /** @type {Function} */ (candidate);
}

/**
 * 每个测试前重置全部分区，避免测试之间互相污染。
 *
 * @returns {void}
 */
function reset() {
  fn('resetState')();
}

/* ------------------------------------------------------------------ *
 * 1. sessionKeyOf
 * ------------------------------------------------------------------ */

test('sessionKeyOf：有 agent.id 时用 id；缺失/空/非法一律落到 shared-default', () => {
  const sessionKeyOf = fn('sessionKeyOf');
  // 正常形态
  assert.equal(sessionKeyOf({ agent: { id: 'abc' } }), 'abc');
  assert.equal(sessionKeyOf({ agent: { id: 'session-1234' } }), 'session-1234');
  // 没有 exec / 没有 agent / id 不是非空字符串 → 共享槽
  for (const exec of [
    undefined,
    null,
    {},
    { agent: null },
    { agent: undefined },
    { agent: {} },
    { agent: { id: '' } },
    { agent: { id: '   ' } },
    { agent: { id: 42 } },
    { agent: { id: null } },
    { agent: 'not-an-object' },
  ]) {
    assert.equal(
      sessionKeyOf(/** @type {object} */ (exec)),
      SHARED,
      `exec=${JSON.stringify(exec)} 应落到 ${SHARED}`,
    );
  }
});

test('sessionKeyOf：同一个 exec 多次调用结果稳定（不能含随机/时间成分）', () => {
  const sessionKeyOf = fn('sessionKeyOf');
  const exec = { agent: { id: 'stable-session' } };
  assert.equal(sessionKeyOf(exec), sessionKeyOf(exec));
});

/* ------------------------------------------------------------------ *
 * 2. 状态分区：当前设备
 * ------------------------------------------------------------------ */

test('状态分区：A 设了当前设备，B 读不到（核心隔离保证）', () => {
  reset();
  const setCurrent = fn('setCurrent');
  const getCurrent = fn('getCurrent');

  setCurrent(A, { serial: 'emulator-5554', avd: 'dsh_android--sessionA' });
  assert.equal(getCurrent(A)?.serial, 'emulator-5554', 'A 自己的设备要能读到');
  assert.equal(getCurrent(B), null, 'B 不能看到 A 的设备');
  assert.equal(getCurrent(), null, '共享槽也不能看到 A 的设备');

  setCurrent(B, { serial: 'emulator-5556', avd: 'dsh_android--sessionB' });
  assert.equal(getCurrent(A)?.serial, 'emulator-5554', 'B 写入后 A 的设备不变');
  assert.equal(getCurrent(B)?.serial, 'emulator-5556');
});

test('状态分区：clearCurrent(key) 只清自己的', () => {
  reset();
  const setCurrent = fn('setCurrent');
  const getCurrent = fn('getCurrent');
  const clearCurrent = fn('clearCurrent');

  setCurrent(A, { serial: 'emulator-5554' });
  setCurrent(B, { serial: 'emulator-5556' });
  clearCurrent(A);
  assert.equal(getCurrent(A), null, 'A 被清空');
  assert.equal(getCurrent(B)?.serial, 'emulator-5556', 'B 不受影响');
});

test('状态分区：setCurrent 是合并 patch（只更新给的字段）', () => {
  reset();
  const setCurrent = fn('setCurrent');
  const getCurrent = fn('getCurrent');

  setCurrent(A, { serial: 'emulator-5554', avd: 'avd-A', pid: 111 });
  setCurrent(A, { pid: 222 });
  const current = getCurrent(A);
  assert.equal(current?.serial, 'emulator-5554', '没给的字段要保留');
  assert.equal(current?.avd, 'avd-A');
  assert.equal(current?.pid, 222, '给了的字段要更新');
});

test('状态分区：getCurrent 返回副本（改外部对象不能污染内部状态）', () => {
  reset();
  const setCurrent = fn('setCurrent');
  const getCurrent = fn('getCurrent');

  setCurrent(A, { serial: 'emulator-5554' });
  const first = getCurrent(A);
  first.serial = 'tampered';
  assert.equal(getCurrent(A)?.serial, 'emulator-5554', 'getCurrent 必须返回副本');
  assert.notEqual(getCurrent(A), getCurrent(A), '每次返回新对象');
});

/* ------------------------------------------------------------------ *
 * 3. 状态分区：最近安装的包
 * ------------------------------------------------------------------ */

test('状态分区：A 记住的包 B 读不到（app_launch 不能默认启动别人的包）', () => {
  reset();
  const rememberPackage = fn('rememberPackage');
  const getLastPackage = fn('getLastPackage');

  rememberPackage(A, 'com.example.a');
  assert.equal(getLastPackage(A), 'com.example.a');
  assert.equal(getLastPackage(B), '', 'B 不能拿到 A 的包');

  rememberPackage(B, 'com.example.b');
  assert.equal(getLastPackage(A), 'com.example.a', 'B 写入不影响 A');
  assert.equal(getLastPackage(B), 'com.example.b');
});

/* ------------------------------------------------------------------ *
 * 4. 状态分区：进程表（按 serial 索引 + 带归属）
 * ------------------------------------------------------------------ */

test('进程表：listProcessesBySession 只返回本会话，listProcesses 返回全部', () => {
  reset();
  const setProcess = fn('setProcess');
  const listProcessesBySession = fn('listProcessesBySession');
  const listProcesses = fn('listProcesses');

  // 进程表按 serial 索引，sessionKey 写在记录里（DESIGN §7.2）
  setProcess('emulator-5554', { pid: 111, avd: 'avd-A', logFile: 'a.log', sessionKey: A });
  setProcess('emulator-5556', { pid: 222, avd: 'avd-B', logFile: 'b.log', sessionKey: B });

  const forA = listProcessesBySession(A);
  assert.equal(forA.length, 1);
  assert.equal(forA[0].serial, 'emulator-5554');
  assert.equal(forA[0].pid, 111);

  const forB = listProcessesBySession(B);
  assert.equal(forB.length, 1);
  assert.equal(forB[0].serial, 'emulator-5556');

  const all = listProcesses();
  assert.equal(all.length, 2, 'listProcesses 要返回全部（instances 展示用）');
  assert.deepEqual(all.map((entry) => entry.serial).sort(), ['emulator-5554', 'emulator-5556']);
});

test('进程表：每条记录都带 sessionKey（归属判定的依据）；未给时落共享槽', () => {
  reset();
  const setProcess = fn('setProcess');
  const listProcesses = fn('listProcesses');

  setProcess('emulator-5554', { pid: 111, sessionKey: A });
  setProcess('emulator-5556', { pid: 222, sessionKey: B });
  setProcess('emulator-5558', { pid: 333 });

  const bySerial = new Map(listProcesses().map((entry) => [entry.serial, entry]));
  assert.equal(bySerial.get('emulator-5554')?.sessionKey, A);
  assert.equal(bySerial.get('emulator-5556')?.sessionKey, B);
  assert.equal(bySerial.get('emulator-5558')?.sessionKey, SHARED, '没给 sessionKey 时落到共享槽');
});

test('进程表：processOwner(serial) 返回归属会话；未知 serial 返回空', () => {
  reset();
  const setProcess = fn('setProcess');
  const processOwner = fn('processOwner');

  setProcess('emulator-5554', { pid: 111, sessionKey: A });
  setProcess('emulator-5556', { pid: 222, sessionKey: B });

  assert.equal(processOwner('emulator-5554'), A);
  assert.equal(processOwner('emulator-5556'), B);
  assert.equal(processOwner('emulator-9998'), '');
  assert.equal(processOwner(''), '');
  assert.equal(processOwner(undefined), '');
});

test('进程表：deleteProcess 只删指定 serial，不影响别人的', () => {
  reset();
  const setProcess = fn('setProcess');
  const deleteProcess = fn('deleteProcess');
  const listProcesses = fn('listProcesses');

  setProcess('emulator-5554', { pid: 111, sessionKey: A });
  setProcess('emulator-5556', { pid: 222, sessionKey: B });
  deleteProcess('emulator-5554');
  assert.deepEqual(listProcesses().map((entry) => entry.serial), ['emulator-5556']);
});

/* ------------------------------------------------------------------ *
 * 5. AVD 命名纯函数（DESIGN §7.2：<prefix>--<sessionShort>）
 * ------------------------------------------------------------------ */

test('sessionShort：清洗成 [A-Za-z0-9_-]、取前 8 字符', () => {
  const sessionShort = fn('sessionShort');
  assert.equal(sessionShort('abcdefghijkl'), 'abcdefgh', '超过 8 字符要截断');
  assert.equal(sessionShort('abc'), 'abc', '短的保持原样');
  // 不合法的字符换成 _
  assert.equal(sessionShort('a/b c'), 'a_b_c');
  assert.equal(sessionShort('a.b:c'), 'a_b_c');
  // 中文逐字符变成下划线（"会话" 是 2 个字符 → 2 个下划线），ASCII 部分保留
  assert.equal(sessionShort('会话-ABC'), '__-ABC');
  // 全角字符同样要清洗
  const fullwidth = sessionShort('ａｂｃ');
  assert.match(fullwidth, /^[A-Za-z0-9_-]{1,8}$/u, `全角字符清洗结果必须合法：${fullwidth}`);
});

test('sessionShort：清洗后没有任何字母数字时用哈希兜底（不能是一串下划线）', () => {
  const sessionShort = fn('sessionShort');
  for (const key of ['', '   ', '中文', '🔥🔥', '---', '___']) {
    const short = sessionShort(key);
    assert.match(short, /^[A-Za-z0-9_-]{1,8}$/u, `"${key}" 的结果必须是合法 AVD 名片段：${short}`);
    assert.match(short, /[A-Za-z0-9]/u, `"${key}" 的结果不能全是下划线/横线：${short}`);
  }
  // 不同 key 的兜底要能区分（哈希），否则两个会话会抢同一个 AVD 名
  assert.notEqual(sessionShort('中文'), sessionShort('🔥🔥'));
});

test('sessionShort：长度上限 8（AVD 名有长度限制）', () => {
  const sessionShort = fn('sessionShort');
  for (const key of ['a'.repeat(100), 'x-y_z'.repeat(20), '8f3c1d9a-4b2e-4f6a-9c1d-2e3f4a5b6c7d']) {
    assert.ok(sessionShort(key).length <= 8, `"${key}" 的 short 超过 8 字符：${sessionShort(key)}`);
  }
});

test('sessionShort：真实 dsh SessionId（session-<uuid>）必须可辨识，不能所有会话都撞成 session-', () => {
  const sessionShort = fn('sessionShort');
  const sessionAvdName = fn('sessionAvdName');
  // dsh 生产环境的 SessionId 就是 `session-` + UUID —— 前 8 字符恰好是通用前缀。
  // 2026-10-26 真机回归抓到的 bug：旧实现直接截前 8 字符，于是**每个会话**都得到
  // `session-`，所有会话的专属 AVD 同名，「一个会话一台模拟器」退化成「所有会话抢同一台」。
  const first = 'session-9e1ca070-4acb-4bdf-9bab-786b32ce91e8';
  const second = 'session-4f9c366a-e72d-4589-bae1-147e9b8710f1';

  assert.equal(sessionShort(first), '9e1ca070', '应剥掉通用前缀 session-，取 UUID 第一段');
  assert.equal(sessionShort(second), '4f9c366a');

  // 红线：不同会话的专属 AVD 名必须不同，否则多会话隔离直接失效。
  assert.notEqual(
    sessionAvdName('dsh_android', first),
    sessionAvdName('dsh_android', second),
    '两个会话不能映射到同一个 AVD 名',
  );

  // 结果必须始终是合法的 AVD 名片段。
  for (const key of [first, second, 'session-', 'session', 'agent-0f3e9a1c-1111-2222-3333-444455556666']) {
    const short = sessionShort(key);
    assert.match(short, /^[A-Za-z0-9_-]{1,8}$/u, `"${key}" → ${short} 不是合法 AVD 名片段`);
    assert.match(short, /[A-Za-z0-9]/u, `"${key}" → ${short} 不能全是分隔符`);
  }

  // 没有身份信息的纯通用 key 必须落到哈希兜底（不同 key 不同结果）。
  assert.notEqual(sessionShort('session'), sessionShort('session-'));
});

test('sessionAvdName：<base>--<short>，base 为空时兜底 dsh_android', () => {
  const sessionAvdName = fn('sessionAvdName');
  const sessionShort = fn('sessionShort');
  assert.equal(sessionAvdName('dsh_android', A), `dsh_android--${sessionShort(A)}`);
  assert.equal(sessionAvdName('myprefix', 'abcdefghijkl'), 'myprefix--abcdefgh');
  assert.equal(sessionAvdName('', 'abc'), 'dsh_android--abc', '空 base 要兜底');
  assert.equal(sessionAvdName(undefined, 'abc'), 'dsh_android--abc');
  assert.equal(sessionAvdName('  dsh_x  ', 'abc'), 'dsh_x--abc', 'base 两侧空格要裁掉');
});

test('isSessionAvdName：只认 <base>--<非空> 形态', () => {
  const isSessionAvdName = fn('isSessionAvdName');
  assert.equal(isSessionAvdName('dsh_android--abc12345', 'dsh_android'), true);
  assert.equal(isSessionAvdName('dsh_android--x', 'dsh_android'), true);
  // 基础模板 AVD 本身不是会话专属
  assert.equal(isSessionAvdName('dsh_android', 'dsh_android'), false);
  // 前缀对但后面为空
  assert.equal(isSessionAvdName('dsh_android--', 'dsh_android'), false);
  // 其它前缀
  assert.equal(isSessionAvdName('other--abc', 'dsh_android'), false);
  assert.equal(isSessionAvdName('', 'dsh_android'), false);
  assert.equal(isSessionAvdName(undefined, 'dsh_android'), false);
});

test('shortSessionKey：短 key 原样（便于排查），长 key（UUID）截断加省略号', () => {
  const shortSessionKey = fn('shortSessionKey');
  assert.equal(shortSessionKey('sess-A'), 'sess-A');
  assert.equal(shortSessionKey('abcdefghijkl'), 'abcdefghijkl', '正好 12 字符原样');
  const long = shortSessionKey('8f3c1d9a-4b2e-4f6a-9c1d-2e3f4a5b6c7d');
  assert.match(long, /^8f3c1d9a/u, '长 key 保留前 8 字符');
  assert.match(long, /…$/u, '长 key 要有省略号表明被截断');
  assert.ok(long.length < '8f3c1d9a-4b2e-4f6a-9c1d-2e3f4a5b6c7d'.length);

  // 共享槽是「公开、可辨识」的值：必须原样显示，否则 instances[].sessionKey 里认不出它。
  // （这里曾经是 bug：`shared-default` 14 字符 > 12 的阈值被截断成 `shared-d…`；已报 Lead 并由 impl 修好。）
  assert.equal(shortSessionKey('shared-default'), 'shared-default', '共享槽必须原样显示，不能被截断');
});

test('sessionKeyOf：perSession=false 时所有会话统一落到共享槽（v1.1 行为）', () => {
  const sessionKeyOf = fn('sessionKeyOf');
  const exec = { agent: { id: 'session-A' } };
  assert.equal(sessionKeyOf(exec), 'session-A', '默认 perSession=true');
  assert.equal(sessionKeyOf(exec, true), 'session-A');
  assert.equal(sessionKeyOf(exec, false), SHARED, 'perSession=false → 全部共享');
  assert.equal(sessionKeyOf(undefined, false), SHARED);
  assert.equal(sessionKeyOf({ agent: { id: '   ' } }, false), SHARED);
});

/* ------------------------------------------------------------------ *
 * 6. resetState 与旧调用兼容
 * ------------------------------------------------------------------ */

test('resetState：清空所有会话分区（不是只清 shared-default）', () => {
  reset();
  const setCurrent = fn('setCurrent');
  const rememberPackage = fn('rememberPackage');
  const setProcess = fn('setProcess');
  const getCurrent = fn('getCurrent');
  const getLastPackage = fn('getLastPackage');
  const listProcesses = fn('listProcesses');

  setCurrent(A, { serial: 'emulator-5554' });
  setCurrent(B, { serial: 'emulator-5556' });
  rememberPackage(A, 'com.example.a');
  rememberPackage(B, 'com.example.b');
  setProcess('emulator-5554', { pid: 111, sessionKey: A });
  setProcess('emulator-5556', { pid: 222, sessionKey: B });

  fn('resetState')();

  for (const key of [A, B, SHARED]) {
    assert.equal(getCurrent(key), null, `${key} 的 current 应被清空`);
    assert.equal(getLastPackage(key), '', `${key} 的 lastPackage 应被清空`);
    assert.deepEqual(fn('listProcessesBySession')(key), [], `${key} 的进程记录应被清空`);
  }
  assert.deepEqual(listProcesses(), [], '全部进程记录应被清空');
});

test('旧调用兼容：无参 getCurrent() 等价于 getCurrent("shared-default")', () => {
  reset();
  const setCurrent = fn('setCurrent');
  const getCurrent = fn('getCurrent');

  // 无参写法（v1.1 的调用方式）仍然可用，且直接落在共享槽
  setCurrent({ serial: 'emulator-5554' });
  assert.equal(getCurrent()?.serial, 'emulator-5554', '无参 set/get 必须落在同一个槽');
  assert.equal(getCurrent(SHARED)?.serial, 'emulator-5554', '无参写的就是 shared-default 槽');
  assert.equal(getCurrent(A), null, '不能污染具名会话');
});

test('旧调用兼容：无参 rememberPackage / getLastPackage 落在 shared-default', () => {
  reset();
  const rememberPackage = fn('rememberPackage');
  const getLastPackage = fn('getLastPackage');

  rememberPackage('com.example.shared');
  assert.equal(getLastPackage(), 'com.example.shared');
  assert.equal(getLastPackage(SHARED), 'com.example.shared');
  assert.equal(getLastPackage(A), '', '不能污染具名会话');
});

test('旧调用兼容：无参 clearCurrent() 只清 shared-default，不清具名会话', () => {
  reset();
  const setCurrent = fn('setCurrent');
  const getCurrent = fn('getCurrent');
  const clearCurrent = fn('clearCurrent');

  setCurrent({ serial: 'emulator-5554' });
  setCurrent(A, { serial: 'emulator-5556' });
  clearCurrent();
  assert.equal(getCurrent(), null);
  assert.equal(getCurrent(A)?.serial, 'emulator-5556', '具名会话不该被无参调用清掉');
});

test('emptyDevice：默认空值形状不变（文档/渲染依赖它）', () => {
  const emptyDevice = fn('emptyDevice');
  const empty = emptyDevice();
  assert.equal(typeof empty, 'object');
  for (const field of ['serial', 'avd', 'logFile']) {
    assert.equal(typeof empty[field], 'string', `emptyDevice().${field} 必须是字符串`);
  }
  assert.equal(typeof empty.pid, 'number');
});
