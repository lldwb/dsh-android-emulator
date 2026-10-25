/**
 * v1.1.0 ARM 转译层（DESIGN §7.1）的离线单测。
 *
 * ## 为什么这一组测试值得存在
 *
 * 「能不能跑 ARM 的 APK」是这次版本的核心判断，而它完全建立在**设备属性字符串**上：
 * 一个 `libndk_translation.so`、一个 `abilist32` 是否为空，就决定了
 * - `translation.kind`（决定要不要给性能提醒）
 * - `translation.arm64` / `arm32`（决定 `ABI_MISMATCH` 该给哪一种建议）
 * - `abiKind`（决定 agent 以为这次安装是原生还是转译）
 *
 * 这些判断错了的后果不是报错，而是**误导**：比如把 32 位 ARM 的失败笼统说成"重建 x86_64"，
 * 会让 agent 反复重建一个根本不可能跑起来的包。
 *
 * ## 覆盖范围
 *
 * 1. `parseGetpropOutput`：`adb shell getprop` 全量输出的解析（含真实形态、空值、畸形行）
 * 2. `emptyTranslation`：8 个字段的空值形状
 * 3. `deviceTranslation`：探测失败路径（空 adb / 空 serial / 不可执行）**永不抛**
 * 4. `classifyAbiKind`：`native` / `translated` / `none` 的判定矩阵
 * 5. `pickMatchedAbi`：设备优先序（必须给原生 ABI 而不是 APK 里排在前面的 ARM ABI）
 * 6. `abiMismatchMessage`：三种情况的针对性措辞（尤其「32 位 ARM 官方不支持」）
 * 7. `translationMessageLine` / `translationPerformanceTip` / `hasTranslationLayer`
 *
 * 注：`props → translation` 的 8 字段映射与 `deviceTranslation` 的其余形态，取决于实现是否
 * 导出对应的纯函数（见 `deviceTranslation` 那一节的说明）。
 *
 * @module test/translation
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { deviceTranslation, emptyTranslation, parseGetpropOutput, translationFromProps } from '../lib/sdk.mjs';
import {
  abiMismatchMessage,
  classifyAbiKind,
  hasTranslationLayer,
  pickMatchedAbi,
  translationMessageLine,
  translationPerformanceTip,
} from '../lib/tools/device.mjs';

/* ------------------------------------------------------------------ *
 * 契约常量
 * ------------------------------------------------------------------ */

/** `translation` 必须有的 8 个字段（DESIGN §3 / §7.1）。 */
const TRANSLATION_FIELDS = ['bridge', 'version', 'enabled', 'kind', 'arm64', 'arm32', 'abilist64', 'abilist32'];

/** 真实镜像的 props 文本（2026-10-24 本机 `adb shell getprop` 实录片段）。 */
const REAL_NDK_PROPS = [
  '[ro.dalvik.vm.native.bridge]: [libndk_translation.so]',
  '[ro.ndk_translation.version]: [0.2.3]',
  '[ro.enable.native.bridge.exec]: [1]',
  '[ro.dalvik.vm.isa.arm64]: [x86_64]',
  '[ro.product.cpu.abilist]: [x86_64,arm64-v8a]',
  '[ro.product.cpu.abilist64]: [x86_64,arm64-v8a]',
  '[ro.product.cpu.abilist32]: []',
  '',
].join('\r\n');

/* ------------------------------------------------------------------ *
 * 1. parseGetpropOutput
 * ------------------------------------------------------------------ */

test('parseGetpropOutput：解析真实 getprop 全量输出（含空值 [] 与 \\r\\n 换行）', () => {
  const props = parseGetpropOutput(REAL_NDK_PROPS);
  assert.equal(props['ro.dalvik.vm.native.bridge'], 'libndk_translation.so');
  assert.equal(props['ro.ndk_translation.version'], '0.2.3');
  assert.equal(props['ro.enable.native.bridge.exec'], '1');
  assert.equal(props['ro.product.cpu.abilist'], 'x86_64,arm64-v8a');
  // 空值 `[]` 解析成空串（不是 undefined，也不是字面量 "[]"）
  assert.equal(props['ro.product.cpu.abilist32'], '');
  assert.equal(Object.prototype.hasOwnProperty.call(props, 'ro.product.cpu.abilist32'), true);
});

test('parseGetpropOutput：空输入 / 畸形行 / 非字符串都不抛，只返回空对象', () => {
  for (const input of ['', undefined, null, 42, {}, [], 'garbage', 'no brackets here', '[unclosed]: [x']) {
    const props = parseGetpropOutput(/** @type {string} */ (input));
    assert.equal(typeof props, 'object');
    assert.notEqual(props, null);
    assert.equal(Object.keys(props).length, 0, `输入 ${String(input)} 应解析出空对象`);
  }
});

test('parseGetpropOutput：值里含 ] 与 ]: [ 不破坏解析；属性名两侧空格被裁掉', () => {
  const props = parseGetpropOutput(
    [
      '[weird.value]: [a]b]: [c]',
      '[  padded.name  ]: [  spaced value  ]',
      '[empty]: []',
    ].join('\n'),
  );
  // 贪婪匹配到行尾最后一个 ] 之前 → 值里允许出现 ]
  assert.equal(props['weird.value'], 'a]b]: [c');
  assert.equal(props['padded.name'], '  spaced value  ');
  assert.equal(props['empty'], '');
});

test('parseGetpropOutput：ignore 不含冒号的行与注释式行', () => {
  const props = parseGetpropOutput(
    [
      'some noise line',
      '[ok]: [1]',
      '   ',
      'not a property',
      '[ok2]: [2]',
    ].join('\n'),
  );
  assert.deepEqual(Object.keys(props).sort(), ['ok', 'ok2']);
});

/* ------------------------------------------------------------------ *
 * 2. emptyTranslation
 * ------------------------------------------------------------------ */

test('emptyTranslation：恰好 8 个字段、类型正确、kind=none', () => {
  const empty = emptyTranslation();
  assert.deepEqual(Object.keys(empty).sort(), [...TRANSLATION_FIELDS].sort());
  assert.equal(empty.bridge, '');
  assert.equal(empty.version, '');
  assert.equal(empty.enabled, false);
  assert.equal(empty.kind, 'none');
  assert.equal(empty.arm64, false);
  assert.equal(empty.arm32, false);
  assert.deepEqual(empty.abilist64, []);
  assert.deepEqual(empty.abilist32, []);
  // 必须能无损 JSON 往返（工具返回值会过 JSON 快照）
  assert.deepEqual(JSON.parse(JSON.stringify(empty)), empty);
});

test('emptyTranslation：每次返回新对象（不能被下游意外共享/改写）', () => {
  const first = emptyTranslation();
  const second = emptyTranslation();
  assert.notEqual(first, second, '每次必须是新对象');
  assert.notEqual(first.abilist64, second.abilist64, '数组也要新实例');
  assert.notEqual(first.abilist32, second.abilist32, '数组也要新实例');
  first.abilist64.push('mutated');
  assert.deepEqual(second.abilist64, [], '改一个不能影响另一个');
});

/* ------------------------------------------------------------------ *
 * 2.5 translationFromProps —— DESIGN §7.1 的五种设备形态
 * ------------------------------------------------------------------ *
 *
 * 这是整个 v1.1.0 的核心判定：给定设备属性，回答「这台机器能不能跑 ARM 的库」。
 * 五种形态来自 DESIGN §7.1 + 真机实测（2026-10-24，Lead 与 impl 各自验证）：
 *
 * | 形态 | bridge | abilist | kind | arm64 | arm32 |
 * |---|---|---|---|---|---|
 * | ndk-translation（本机真实） | libndk_translation.so | x86_64,arm64-v8a（abilist32 空） | ndk-translation | true | false |
 * | houdini | libhoudini.so | x86_64,x86,armeabi-v7a,armeabi | houdini | false | true |
 * | native（ARM 真机） | （空） | abilist64=arm64-v8a / abilist32=armeabi-v7a,armeabi | native | true | true |
 * | none | （空） | x86_64,x86 | none | false | false |
 * | 未知 bridge（libnb.so） | libnb.so | 任意 | none（按契约不猜） | 由 abilist 决定 | 由 abilist 决定 |
 *
 * 后两种最容易写错：**未知 bridge 不能猜成 houdini**，`arm64/arm32` 也**不能因为 bridge 为空
 * 就判 false**——ARM 真机上 bridge 本来就是空的。
 */

/** 造 props 对象（键就是 getprop 的属性名）。 */
function propsOf(entries) {
  return Object.fromEntries(entries);
}

test('translationFromProps 形态 1（本机真实 ndk-translation）：arm64 可用、arm32 不可用', () => {
  const translation = translationFromProps(
    propsOf([
      ['ro.dalvik.vm.native.bridge', 'libndk_translation.so'],
      ['ro.ndk_translation.version', '0.2.3'],
      ['ro.enable.native.bridge.exec', '1'],
      ['ro.dalvik.vm.isa.arm64', 'x86_64'],
      ['ro.product.cpu.abilist', 'x86_64,arm64-v8a'],
      ['ro.product.cpu.abilist64', 'x86_64,arm64-v8a'],
      ['ro.product.cpu.abilist32', ''],
    ]),
  );
  assert.equal(translation.bridge, 'libndk_translation.so');
  assert.equal(translation.version, '0.2.3');
  assert.equal(translation.enabled, true);
  assert.equal(translation.kind, 'ndk-translation');
  assert.equal(translation.arm64, true, 'abilist64 含 arm64-v8a → 能跑 arm64');
  assert.equal(translation.arm32, false, 'abilist32 为空 → 不能跑 32 位 ARM');
  assert.deepEqual(translation.abilist64, ['x86_64', 'arm64-v8a']);
  assert.deepEqual(translation.abilist32, []);
  assert.deepEqual(Object.keys(translation).sort(), [...TRANSLATION_FIELDS].sort());
});

test('translationFromProps 形态 2（houdini）：kind=houdini，32 位 ARM 可用', () => {
  const translation = translationFromProps(
    propsOf([
      ['ro.dalvik.vm.native.bridge', 'libhoudini.so'],
      ['ro.enable.native.bridge.exec', '1'],
      ['ro.product.cpu.abilist', 'x86_64,x86,armeabi-v7a,armeabi'],
    ]),
  );
  assert.equal(translation.kind, 'houdini');
  assert.equal(translation.bridge, 'libhoudini.so');
  assert.equal(translation.arm32, true, 'abilist 含 armeabi-v7a → 32 位 ARM 可用');
  assert.equal(translation.arm64, false, 'abilist 不含 arm64-v8a → arm64 不可用');
  assert.equal(translation.enabled, true);
});

test('translationFromProps 形态 3（ARM 真机）：bridge 为空但 kind=native，arm64/arm32 都可', () => {
  const translation = translationFromProps(
    propsOf([
      ['ro.product.cpu.abilist64', 'arm64-v8a'],
      ['ro.product.cpu.abilist32', 'armeabi-v7a,armeabi'],
    ]),
  );
  assert.equal(translation.bridge, '');
  assert.equal(translation.kind, 'native', '没有转译层但 abilist 含 arm → 原生 ARM 设备');
  assert.equal(translation.arm64, true);
  assert.equal(translation.arm32, true);
  assert.equal(translation.enabled, false, '没有 bridge 就谈不上"启用"');
});

test('translationFromProps 形态 4（纯 x86_64 无转译）：kind=none，两种 ARM 都不可用', () => {
  const translation = translationFromProps(
    propsOf([
      ['ro.product.cpu.abilist', 'x86_64,x86'],
      ['ro.product.cpu.abilist64', 'x86_64'],
    ]),
  );
  assert.equal(translation.kind, 'none');
  assert.equal(translation.bridge, '');
  assert.equal(translation.arm64, false);
  assert.equal(translation.arm32, false);
  assert.equal(translation.enabled, false);
});

test('translationFromProps 形态 5（未知 bridge 如 libnb.so）：按契约落 none，不猜成 houdini', () => {
  const translation = translationFromProps(
    propsOf([
      ['ro.dalvik.vm.native.bridge', 'libnb.so'],
      ['ro.product.cpu.abilist', 'x86_64,arm64-v8a'],
    ]),
  );
  assert.equal(translation.kind, 'none', '未知 bridge 不能猜成 houdini，契约要求落 none');
  assert.equal(translation.bridge, 'libnb.so', 'bridge 字段要照实返回（诊断需要）');
  assert.equal(translation.arm64, true, 'arm64 仍由 abilist 推导，不因 bridge 未知而变 false');
  assert.deepEqual(translation.abilist64, [], '没给 abilist64 就是空数组');
});

test('translationFromProps：探测失败（undefined / null / 空对象）与 emptyTranslation() 完全等价', () => {
  const empty = emptyTranslation();
  for (const input of [undefined, null, {}, { 'some.other.prop': 'x' }]) {
    const result = translationFromProps(/** @type {object} */ (input));
    assert.deepEqual(result, empty, `${String(input)} 应等价于 emptyTranslation()`);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(JSON.stringify(empty)));
  }
});

test('translationFromProps：enabled 的三个边界（exec=1/true、exec=0、exec 缺失但有 bridge）', () => {
  /** 只有 bridge 与 exec 两组属性的最小 props。 */
  const withExec = (exec) =>
    translationFromProps(
      propsOf([
        ['ro.dalvik.vm.native.bridge', 'libndk_translation.so'],
        ...(exec === undefined ? [] : [['ro.enable.native.bridge.exec', exec]]),
      ]),
    );

  assert.equal(withExec('1').enabled, true, 'exec=1 → 启用');
  assert.equal(withExec('true').enabled, true, 'exec=true → 启用');
  assert.equal(withExec('0').enabled, false, 'exec=0 → 即使有 bridge 也算未启用');
  assert.equal(withExec('false').enabled, false);
  assert.equal(withExec(undefined).enabled, true, 'exec 属性缺失但有 bridge → 兜底视为启用');
  // `enabled` 的字面语义就是 `ro.enable.native.bridge.exec` 的值，不额外要求 bridge 非空
  // （镜像可能保留 exec 开关但没配 bridge；此时 kind 会是 none，读的人看 kind 就知道没有转译层）。
  const execOnly = translationFromProps(propsOf([['ro.enable.native.bridge.exec', '1']]));
  assert.equal(execOnly.enabled, true, 'exec=1 就是 enabled=true，与 bridge 是否为空无关');
  assert.equal(execOnly.kind, 'none', '但没有 bridge → kind=none，语义上仍是没有转译层');
});

test('translationFromProps：abilist32 / abilist64 的解析（多值、空格、空值、畸形）', () => {
  const translation = translationFromProps(
    propsOf([
      ['ro.dalvik.vm.native.bridge', 'libndk_translation.so'],
      ['ro.product.cpu.abilist64', ' x86_64 , arm64-v8a , '],
      ['ro.product.cpu.abilist32', 'armeabi-v7a'],
    ]),
  );
  assert.deepEqual(translation.abilist64, ['x86_64', 'arm64-v8a'], '两侧空格要裁掉、空项要过滤');
  assert.deepEqual(translation.abilist32, ['armeabi-v7a']);
  assert.equal(translation.arm32, true);
  // getprop 的空值 `[]` 也应视为空列表
  assert.deepEqual(
    translationFromProps(propsOf([['ro.product.cpu.abilist64', '[]']])).abilist64,
    [],
  );
});

test('translationFromProps 与 parseGetpropOutput 串联：真实 getprop 文本端到端得到 ndk 形态', () => {
  const translation = translationFromProps(parseGetpropOutput(REAL_NDK_PROPS));
  assert.equal(translation.kind, 'ndk-translation');
  assert.equal(translation.bridge, 'libndk_translation.so');
  assert.equal(translation.version, '0.2.3');
  assert.equal(translation.arm64, true);
  assert.equal(translation.arm32, false, '真实镜像的 abilist32 是空值 [] → 空列表 → arm32=false');
});

test('translationFromProps 的输出永远只有 8 个字段（不会把 props 里的其它属性带出来）', () => {
  const translation = translationFromProps(
    propsOf([
      ['ro.dalvik.vm.native.bridge', 'libndk_translation.so'],
      ['ro.build.version.sdk', '35'],
      ['ro.product.model', 'sdk_gphone64_x86_64'],
      ['some.unrelated.prop', 'whatever'],
    ]),
  );
  assert.deepEqual(Object.keys(translation).sort(), [...TRANSLATION_FIELDS].sort());
});

/* ------------------------------------------------------------------ *
 * 3. deviceTranslation 的失败路径（形态 e：探测失败不得影响主流程）
 * ------------------------------------------------------------------ */

test('deviceTranslation：adb 为空 / serial 为空 / 参数缺失时直接返回空对象，不抛', async () => {
  const cases = [
    ['', 'emulator-5554'],
    [process.execPath, ''],
    [undefined, 'emulator-5554'],
    ['', ''],
    [null, null],
  ];
  for (const [adb, serial] of cases) {
    const result = await deviceTranslation(adb, serial);
    assert.deepEqual(result, emptyTranslation(), `adb=${String(adb)} serial=${String(serial)} 应返回空 translation`);
  }
});

test('deviceTranslation：adb 不可执行（不存在/是目录）时返回空对象，不抛', async () => {
  const missing = path.join(process.env.TEMP ?? '.', `__no_adb_${process.pid}__.exe`);
  const results = [
    await deviceTranslation(missing, 'emulator-5554'),
    await deviceTranslation(process.env.TEMP ?? '.', 'emulator-5554'),
    await deviceTranslation(process.execPath, 'emulator-5554'),
  ];
  for (const result of results) {
    assert.deepEqual(result, emptyTranslation());
  }
});

test('deviceTranslation：任何失败都返回 8 字段齐全的对象（不会 undefined / 不会缺字段）', async () => {
  const result = await deviceTranslation('', '');
  assert.deepEqual(Object.keys(result).sort(), [...TRANSLATION_FIELDS].sort());
  for (const field of TRANSLATION_FIELDS) {
    assert.notEqual(result[field], undefined, `translation.${field} 不能是 undefined`);
  }
});

/* ------------------------------------------------------------------ *
 * 4. classifyAbiKind
 * ------------------------------------------------------------------ */

/** 造一个转译层 translation。 */
function ndkTranslation(overrides = {}) {
  return {
    ...emptyTranslation(),
    bridge: 'libndk_translation.so',
    version: '0.2.3',
    enabled: true,
    kind: 'ndk-translation',
    arm64: true,
    arm32: false,
    abilist64: ['x86_64', 'arm64-v8a'],
    ...overrides,
  };
}

test('classifyAbiKind：x86_64 / x86 是 native（与有没有转译层无关）', () => {
  assert.equal(classifyAbiKind('x86_64', ndkTranslation()), 'native');
  assert.equal(classifyAbiKind('x86', ndkTranslation()), 'native');
  assert.equal(classifyAbiKind('x86_64', emptyTranslation()), 'native');
  assert.equal(classifyAbiKind('x86', emptyTranslation()), 'native');
});

test('classifyAbiKind：ARM ABI + 转译层 → translated（ndk-translation 与 houdini 都算）', () => {
  assert.equal(classifyAbiKind('arm64-v8a', ndkTranslation()), 'translated');
  assert.equal(classifyAbiKind('armeabi-v7a', ndkTranslation()), 'translated');
  assert.equal(classifyAbiKind('armeabi', ndkTranslation()), 'translated');
  assert.equal(classifyAbiKind('arm64-v8a', ndkTranslation({ kind: 'houdini', bridge: 'libhoudini.so' })), 'translated');
});

test('classifyAbiKind：ARM ABI 但没有转译层 → native（ARM 真机上 ARM 库是原生的）', () => {
  assert.equal(classifyAbiKind('arm64-v8a', emptyTranslation()), 'native');
  assert.equal(classifyAbiKind('arm64-v8a', { ...emptyTranslation(), kind: 'native', arm64: true }), 'native');
  assert.equal(classifyAbiKind('arm64-v8a', { ...emptyTranslation(), kind: 'none' }), 'native');
  assert.equal(classifyAbiKind('arm64-v8a', undefined), 'native');
  assert.equal(classifyAbiKind('arm64-v8a', null), 'native');
});

test('classifyAbiKind：纯 Java / 空匹配 / 非字符串 → none', () => {
  assert.equal(classifyAbiKind('no-native', ndkTranslation()), 'none', '纯 Java APK 是 none');
  assert.equal(classifyAbiKind('', ndkTranslation()), 'none');
  assert.equal(classifyAbiKind(undefined, ndkTranslation()), 'none');
  assert.equal(classifyAbiKind(null, ndkTranslation()), 'none');
  assert.equal(classifyAbiKind(42, ndkTranslation()), 'none');
});

test('classifyAbiKind 的返回值只能是契约里的三个字面量之一', () => {
  const abis = ['x86_64', 'x86', 'arm64-v8a', 'armeabi-v7a', 'armeabi', 'no-native', '', 'mips', undefined, 7];
  const translations = [emptyTranslation(), ndkTranslation(), { kind: 'houdini' }, { kind: 'native', arm64: true }, null];
  for (const abi of abis) {
    for (const translation of translations) {
      const kind = classifyAbiKind(abi, translation);
      assert.ok(['native', 'translated', 'none'].includes(kind), `ABI=${String(abi)} 得到非法 abiKind: ${kind}`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * 5. pickMatchedAbi
 * ------------------------------------------------------------------ */

test('pickMatchedAbi：按设备顺序优先，不能因为 APK 里 arm64 排前面就选 arm64', () => {
  // 关键回归：设备 abilist 是 x86_64,arm64-v8a；APK 里 arm64-v8a 排第一。
  // 必须选 x86_64（原生、性能最好），否则会误导 agent 以为在走转译。
  assert.equal(pickMatchedAbi(['x86_64', 'arm64-v8a'], ['arm64-v8a', 'x86_64']), 'x86_64');
  assert.equal(pickMatchedAbi(['x86_64', 'arm64-v8a'], ['arm64-v8a', 'armeabi-v7a']), 'arm64-v8a');
  assert.equal(pickMatchedAbi(['arm64-v8a', 'x86_64'], ['x86_64']), 'x86_64');
});

test('pickMatchedAbi：纯 Java APK → no-native；不匹配 → 空串；畸形输入不抛', () => {
  assert.equal(pickMatchedAbi(['x86_64'], []), 'no-native', '无 native 库应返回 no-native 让上层判 none');
  assert.equal(pickMatchedAbi(['x86_64'], ['arm64-v8a']), '');
  assert.equal(pickMatchedAbi([], ['arm64-v8a']), '');
  assert.equal(pickMatchedAbi(undefined, ['arm64-v8a']), '');
  assert.equal(pickMatchedAbi(['x86_64'], undefined), 'no-native');
  // 非数组一律当空列表处理（= 没有 native 库 → no-native），不抛
  assert.equal(pickMatchedAbi('x86_64', 'arm64-v8a'), 'no-native');
  assert.equal(pickMatchedAbi(null, null), 'no-native');
});

/* ------------------------------------------------------------------ *
 * 6. abiMismatchMessage —— DESIGN §7.1 的三分支措辞
 * ------------------------------------------------------------------ */

test('abiMismatchMessage：头部必须写明设备 ABI、APK ABI 与转译能力（诊断三要素）', () => {
  const message = abiMismatchMessage({
    apkAbis: ['arm64-v8a'],
    deviceAbis: ['x86_64'],
    translation: emptyTranslation(),
    serial: 'emulator-5554',
  });
  assert.match(message, /ABI 不匹配/u);
  assert.match(message, /arm64-v8a/u, '必须列出 APK 的 ABI');
  assert.match(message, /x86_64/u, '必须列出设备的 ABI');
  assert.match(message, /emulator-5554/u, '必须写明是哪台设备');
  assert.match(message, /kind=none/u, '必须报告转译能力 kind');
  assert.match(message, /arm64=false/u);
  assert.match(message, /arm32=false/u);
});

test('abiMismatchMessage 分支 a：APK 含 arm64 但设备无 arm64 能力 → 提示重建 x86_64 或换带转译层的镜像', () => {
  const message = abiMismatchMessage({
    apkAbis: ['arm64-v8a', 'armeabi-v7a'],
    deviceAbis: ['x86_64'],
    translation: emptyTranslation(),
    serial: 'emulator-5554',
  });
  assert.match(message, /64 位 ARM/u);
  assert.match(message, /x86_64/u, '要给重建 x86_64 的建议');
  assert.match(message, /重建|abiFilters/u);
  assert.match(message, /libndk_translation|转译层/u, '要提示换带转译层的镜像这条路');
  // 不应该误判成 32 位 ARM 那一支
  assert.doesNotMatch(message, /32 位 ARM（armeabi-v7a）\*\*：官方 Android Emulator 已无/u);
});

test('abiMismatchMessage 分支 b（32 位 ARM）：必须解释「官方模拟器已无 32 位 ARM 转译层/镜像」', () => {
  const message = abiMismatchMessage({
    apkAbis: ['armeabi-v7a'],
    deviceAbis: ['x86_64'],
    translation: ndkTranslation({ arm32: false }),
    serial: 'emulator-5554',
  });
  // DESIGN §7.1 要求的核心事实，一个都不能少
  assert.match(message, /32 位 ARM/u, '必须点名 32 位 ARM');
  assert.match(message, /armeabi-v7a/u);
  assert.match(message, /官方 Android Emulator/u, '必须说明是官方模拟器的能力边界');
  assert.match(message, /abilist32/u, '必须给出 abilist32 为空这个证据');
  assert.match(message, /无法在官方模拟器运行/u, '必须明确结论：跑不了');
  // 必须给替代方案（含 arm64-v8a 或 x86_64 的包），且不能只说"重建 x86_64"
  assert.match(message, /arm64-v8a/u, '要给出「改用含 arm64-v8a 的包」这条路');
  assert.match(message, /不要继续尝试安装/u, '要明确劝阻继续尝试');
});

test('abiMismatchMessage 分支 b 只在 arm32 确实不可用时触发（arm32 可用则落到其它分支）', () => {
  const message = abiMismatchMessage({
    apkAbis: ['armeabi-v7a'],
    deviceAbis: ['x86_64'],
    // 假设某设备 arm32 可用（例如 ARM 真机的某种组合），不应再报「官方无 32 位支持」
    translation: ndkTranslation({ arm32: true }),
    serial: 'emulator-5554',
  });
  assert.doesNotMatch(message, /官方 Android Emulator 已无 32 位 ARM 转译层\/镜像/u);
  assert.match(message, /ABI 不匹配/u, '仍然要有通用头信息');
});

test('abiMismatchMessage 分支 c（其它）：给通用建议，且不谎称是 32 位或 arm64 问题', () => {
  const message = abiMismatchMessage({
    apkAbis: ['x86'],
    deviceAbis: ['arm64-v8a'],
    translation: { ...emptyTranslation(), kind: 'native', arm64: true },
    serial: 'emulator-5554',
  });
  assert.match(message, /ABI 不匹配/u);
  assert.match(message, /重建|abiFilters/u);
  assert.doesNotMatch(message, /32 位 ARM/u);
  assert.doesNotMatch(message, /官方 Android Emulator 已无/u);
});

test('abiMismatchMessage：畸形输入不抛，且仍返回非空可读消息', () => {
  for (const input of [undefined, null, {}, { apkAbis: null, deviceAbis: null }, { apkAbis: [] }, { translation: null }]) {
    const message = abiMismatchMessage(/** @type {object} */ (input));
    assert.equal(typeof message, 'string');
    assert.ok(message.length > 0);
    assert.match(message, /ABI 不匹配|下一步/u);
  }
});

/* ------------------------------------------------------------------ *
 * 7. 展示层纯函数
 * ------------------------------------------------------------------ */

test('translationMessageLine：没有设备时明确说「未检测」，不假装成功', () => {
  assert.match(translationMessageLine(emptyTranslation(), false), /未检测|没有运行中的设备/u);
  assert.match(translationMessageLine(ndkTranslation(), false), /未检测|没有运行中的设备/u);
});

test('translationMessageLine：ndk 形态报告 bridge 与 arm64/arm32 能力', () => {
  const line = translationMessageLine(ndkTranslation(), true);
  assert.match(line, /libndk_translation/u, '应报告 bridge 名（去掉 .so 后缀）');
  assert.match(line, /0\.2\.3/u, '应报告版本');
  assert.match(line, /arm64 可用/u);
  assert.match(line, /arm32 不可用/u);
});

test('translationMessageLine：无转译层时说「只能跑 x86_64」，ARM 真机说「原生 ARM」', () => {
  const none = translationMessageLine(emptyTranslation(), true);
  assert.match(none, /未启用|只能跑 x86_64/u);
  const native = translationMessageLine({ ...emptyTranslation(), kind: 'native', arm64: true }, true);
  assert.match(native, /原生 ARM|arm64 可用/u);
  // 畸形输入不抛
  for (const input of [undefined, null, {}, { kind: 42 }, { bridge: 42 }]) {
    assert.equal(typeof translationMessageLine(/** @type {object} */ (input), true), 'string');
  }
});

test('translationPerformanceTip：必须含「不要用转译下的耗时判断真机性能」（DESIGN §7.1 原文要求）', () => {
  const tip = translationPerformanceTip(ndkTranslation());
  assert.match(tip, /ARM 转译/u);
  assert.match(tip, /libndk_translation/u);
  assert.match(tip, /0\.2\.3/u);
  assert.match(tip, /不要用转译下的耗时判断真机性能/u);
  assert.match(tip, /ONNX/u, '要点名大计算场景');
  // 没有版本时也不能出现 "undefined"
  const noVersion = translationPerformanceTip({ ...ndkTranslation(), version: '' });
  assert.doesNotMatch(noVersion, /undefined/u);
  // 畸形输入不抛
  for (const input of [undefined, null, {}, { bridge: 42 }]) {
    assert.equal(typeof translationPerformanceTip(/** @type {object} */ (input)), 'string');
  }
});

test('hasTranslationLayer：只有 ndk-translation / houdini 算有转译层', () => {
  assert.equal(hasTranslationLayer(ndkTranslation()), true);
  assert.equal(hasTranslationLayer({ kind: 'houdini' }), true);
  assert.equal(hasTranslationLayer(emptyTranslation()), false);
  assert.equal(hasTranslationLayer({ kind: 'native' }), false);
  assert.equal(hasTranslationLayer({ kind: 'none' }), false);
  assert.equal(hasTranslationLayer(undefined), false);
  assert.equal(hasTranslationLayer(null), false);
  assert.equal(hasTranslationLayer({ kind: 42 }), false);
});
