/**
 * `lib/adb.mjs` 里**纯函数**部分的测试。
 *
 * 只测不需要设备的东西：`adbDevices` / `screencap` / `dumpUi` 这些必须连真机（由
 * `test/e2e-real.mjs` 覆盖）。这里挑的是 `normalizeComponent` —— 它把用户/模型给的
 * activity 写法归一成 `包名/Activity`，分支多、且错了就表现为「应用启动不了」，
 * 是最值得离线钉住的一段。
 *
 * @module test/adb
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeComponent } from '../lib/adb.mjs';

test('normalizeComponent：省略 activity 时返回空串（由调用方去解析默认 LAUNCHER）', () => {
  assert.equal(normalizeComponent('com.example.app', ''), '');
  assert.equal(normalizeComponent('com.example.app'), '');
  assert.equal(normalizeComponent('com.example.app', '   '), '');
  assert.equal(normalizeComponent('com.example.app', undefined), '');
});

test('normalizeComponent：短类名 / 点开头类名补成 包名/.Activity', () => {
  assert.equal(normalizeComponent('com.example.app', 'MainActivity'), 'com.example.app/.MainActivity');
  assert.equal(normalizeComponent('com.example.app', '.MainActivity'), 'com.example.app/.MainActivity');
  // 已经带包内路径的类名（如 `.ui.Main`）保持原样拼在包名后
  assert.equal(normalizeComponent('com.example.app', '.ui.Main'), 'com.example.app/.ui.Main');
});

test('normalizeComponent：全限定类名按 包名/全限定类名 拼', () => {
  assert.equal(
    normalizeComponent('com.example.app', 'com.example.app.MainActivity'),
    'com.example.app/com.example.app.MainActivity',
  );
});

test('normalizeComponent：已经给出 `pkg/Activity` 形态时原样保留', () => {
  assert.equal(normalizeComponent('com.example.app', 'com.example.app/.MainActivity'), 'com.example.app/.MainActivity');
  assert.equal(normalizeComponent('com.example.app', 'com.example.app/MainActivity'), 'com.example.app/MainActivity');
  // 不同包名（如系统的 Settings）也要尊重用户给的
  assert.equal(normalizeComponent('com.example.app', 'com.android.settings/.Settings'), 'com.android.settings/.Settings');
});

test('normalizeComponent：奇数输入不抛异常，且总返回字符串', () => {
  for (const input of ['/', '//', '.', 'a/b', 'X/', null, 123, {}]) {
    const result = normalizeComponent('com.example.app', /** @type {string} */ (input));
    assert.equal(typeof result, 'string', `输入 ${String(input)} 应返回字符串`);
  }
});
