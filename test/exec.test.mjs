/**
 * `lib/exec.mjs` 的测试：真实子进程（node -e），不 mock。
 *
 * 为什么必须用真实子进程：这一层最容易出的错都不是「逻辑写错」，而是**平台行为**——
 * ENOENT 是异步 `error` 事件而不是异常、Windows 上 `.bat` 不能直接 spawn、超时后必须
 * 真的杀掉子进程而不是留个挂起的 Promise。mock 掉 `child_process` 就全都测不到了。
 *
 * 顺带这条测试也是「本机能不能 spawn 子进程」的探针：受限权限模式下这里会大面积
 * `spawn EPERM`——那是环境限制，不是插件 bug（README 里写明 `SPAWN_DENIED`）。
 *
 * @module test/exec
 */

import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';

import {
  DEFAULT_TIMEOUT_MS,
  describeFailure,
  exists,
  isMissingProgram,
  isSpawnDenied,
  run,
  runBuffer,
  runScript,
  which,
} from '../lib/exec.mjs';

/** 用当前正在跑测试的这个 node 可执行文件，避免依赖 PATH 里的 `node`。 */
const NODE = process.execPath;

/**
 * 一个肯定不存在的程序名（避免偶然命中）。
 *
 * @returns {string} 程序名。
 */
function missingProgramName() {
  return `definitely-not-a-cmd-xyz-${process.pid}-${Date.now()}`;
}

test('run：正常退出时收集 stdout 且 code=0', async () => {
  const result = await run(NODE, ['-e', 'process.stdout.write("hello-from-child")']);
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, 'hello-from-child');
  assert.equal(result.stderr, '');
});

test('run：stdout 与 stderr 分开收集，退出码原样保留', async () => {
  const result = await run(NODE, [
    '-e',
    'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3;',
  ]);
  assert.equal(result.code, 3);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.equal(result.timedOut, false);
});

test('run：非零退出不被当成异常，只体现在 code 上', async () => {
  const result = await run(NODE, ['-e', 'process.exit(42)']);
  assert.equal(result.code, 42);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, undefined, '非零退出不应该被归一成 error（那是 spawn 层的事）');
});

test('run：超时时真的杀掉子进程并返回 timedOut=true', async () => {
  const startedAt = Date.now();
  const result = await run(NODE, ['-e', 'setInterval(() => {}, 1000);'], { timeoutMs: 400 });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
  assert.equal(result.error, undefined);
  // 被杀掉才可能这么快返回；留 3s 余量给慢机器
  assert.ok(elapsed < 3000, `超时后应立即返回，实际耗时 ${elapsed}ms`);
});

test('run：把 input 写进子进程 stdin', async () => {
  const result = await run(
    NODE,
    ['-e', 'process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => process.stdout.write(`got:${d}`));'],
    { input: 'ping' },
  );
  assert.equal(result.code, 0);
  assert.match(result.stdout, /got:ping/);
});

test('run：env 覆盖被子进程看到，且不影响当前进程', async () => {
  const result = await run(NODE, ['-e', 'process.stdout.write(process.env.DSH_QA_PROBE ?? "unset")'], {
    env: { DSH_QA_PROBE: 'probe-value' },
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'probe-value');
  assert.equal(process.env.DSH_QA_PROBE, undefined, 'run 的 env 不能污染当前进程');
});

test('run：cwd 生效', async () => {
  const result = await run(NODE, ['-e', 'process.stdout.write(process.cwd())'], { cwd: process.env.TEMP ?? '.' });
  assert.equal(result.code, 0);
  assert.equal(
    result.stdout.toLowerCase().replace(/[\\/]+$/u, ''),
    String(process.env.TEMP ?? '.').toLowerCase().replace(/[\\/]+$/u, ''),
  );
});

test('run：不存在的程序归一成 error.code=ENOENT，而不是抛异常', async () => {
  const result = await run(missingProgramName(), []);
  assert.equal(result.code, null);
  assert.notEqual(result.error, undefined, 'ENOENT 必须出现在 error 字段里');
  assert.equal(result.error.code, 'ENOENT');
  assert.ok(result.error.message.length > 0);
  assert.equal(isMissingProgram(result), true);
  assert.equal(isSpawnDenied(result), false);
});

test('runBuffer：二进制 stdout 原样返回（不会被 utf8 解码破坏）', async () => {
  // 一段「不是合法 utf8」的字节序列：0xff 0xfe 0x00 0x89。
  const result = await runBuffer(NODE, [
    '-e',
    'process.stdout.write(Buffer.from([0xff, 0xfe, 0x00, 0x89, 0x50, 0x4e, 0x47]));',
  ]);
  assert.equal(result.code, 0);
  assert.ok(Buffer.isBuffer(result.stdout), 'stdout 必须是 Buffer');
  assert.deepEqual([...result.stdout], [0xff, 0xfe, 0x00, 0x89, 0x50, 0x4e, 0x47]);
});

test('runBuffer：超时同样返回 timedOut=true 且不抛', async () => {
  const result = await runBuffer(NODE, ['-e', 'setInterval(() => {}, 1000);'], { timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
  assert.ok(Buffer.isBuffer(result.stdout));
});

test('which：能找到当前 node（PATH 里必然存在的命令）', async () => {
  // 用 which 自己的显式路径分支验证一个确实存在的文件。
  const found = await which(NODE);
  assert.equal(typeof found, 'string');
  assert.ok(found.length > 0);
  assert.equal(await exists(found), true, `which 返回的路径必须真的存在：${found}`);

  // 再验证 PATH 查找分支：把 node 所在目录作为 extraDirs，用一个只存在于该目录的名字。
  const path = await import('node:path');
  const base = path.basename(NODE); // 例如 node.exe
  const stem = base.replace(/\.exe$/iu, '');
  const fromPath = await which(stem, { extraDirs: [path.dirname(NODE)] });
  assert.equal(typeof fromPath, 'string', `应该能在 extraDirs 里找到 ${stem}`);
});

test('which：不存在的命令返回 null（不是抛错，也不是空字符串）', async () => {
  assert.equal(await which(missingProgramName()), null);
  assert.equal(await which(''), null);
  assert.equal(await which('   '), null);
  assert.equal(await which('definitely-not-a-cmd-xyz'), null);
});

test('which：显式不存在的绝对路径返回 null', async () => {
  const path = await import('node:path');
  assert.equal(await which(path.join(process.env.TEMP ?? '.', '__no_such_binary__.exe')), null);
});

test('runScript：非批处理文件时等价于 run', async () => {
  const result = await runScript(NODE, ['-e', 'process.stdout.write("script-ok")']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'script-ok');
});

test('describeFailure：ENOENT / EPERM / 超时 / 非零退出都归一成 (code, message)', async () => {
  assert.equal(describeFailure({ code: null, error: { code: 'ENOENT', message: 'nope' } }, 'ADB_FAILED').code, 'NO_ADB');
  assert.equal(
    describeFailure({ code: null, error: { code: 'EPERM', message: 'denied' } }, 'ADB_FAILED').code,
    'SPAWN_DENIED',
  );
  assert.equal(
    describeFailure({ code: null, error: { code: 'EACCES', message: 'denied' } }, 'ADB_FAILED').code,
    'SPAWN_DENIED',
  );
  assert.equal(describeFailure({ code: null, timedOut: true }, 'ADB_FAILED').code, 'TIMEOUT');
  const nonzero = describeFailure({ code: 1, stderr: 'boom happened' }, 'ADB_FAILED');
  assert.equal(nonzero.code, 'ADB_FAILED');
  assert.match(nonzero.message, /boom happened/u);
  // message 永远非空
  for (const result of [
    { code: null, error: { code: 'ENOENT', message: 'x' } },
    { code: null, timedOut: true },
    { code: 2, stderr: '' },
    null,
  ]) {
    const described = describeFailure(result, 'ADB_FAILED');
    assert.equal(typeof described.message, 'string');
    assert.ok(described.message.length > 0);
  }
});

test('DEFAULT_TIMEOUT_MS：是一个有限正数（调用方依赖它兜底）', () => {
  assert.equal(typeof DEFAULT_TIMEOUT_MS, 'number');
  assert.ok(Number.isFinite(DEFAULT_TIMEOUT_MS));
  assert.ok(DEFAULT_TIMEOUT_MS > 0);
});
