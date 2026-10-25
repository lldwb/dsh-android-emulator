/**
 * dsh-android-emulator — 界面交互类工具（7 个）。
 *
 *   android_ui_dump · android_ui_tap · android_ui_swipe
 *   android_ui_input · android_ui_key · android_ui_wait · android_screenshot
 *
 * ## 这一层真正难的地方
 *
 * 1. **`input text` 只支持 ASCII 可打印字符**。中文直接失败；空格要写成 `%s`；
 *    设备端那一层 `sh` 还会解释 `& | ; $ \` ` 之类的元字符。所以文本要
 *    先过滤、把被过滤的字符写进 `note`，纯非 ASCII 时直接返回 BAD_ARGUMENT
 *    并说明"没有这个能力"。DESIGN §9 明确不做中文输入，不要偷偷引入 ADBKeyboard。
 * 2. **截图必须是二进制**。`exec-out screencap -p` 收 Buffer，PNG 头里取宽高，
 *    按绝对路径写到 outputDir。文件名只用 ASCII 字符（DESIGN §7），中文 label
 *    会被清洗掉——否则 Windows 文件名编码会出各种问题。
 * 3. **`ui_wait` 超时不是错误**。DESIGN §3 明确：`ok:true, found:false`，message
 *    说明等不到什么。agent 需要靠这个分支做"断言界面没变化"。
 */

import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  adbShell,
  dumpUi,
  resolveSerial,
  screencap,
  screenSize,
} from '../adb.mjs';
import { discoverSdk, sdkProblemSummary } from '../sdk.mjs';
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
  toInt,
  toolError,
  truncate,
} from '../schema.mjs';
import { describeNode, emptyNodeView, findNodes, nodeView, parseUiXml, webViewHint } from '../uiauto.mjs';

/* ------------------------------------------------------------------ *
 * 工具骨架（与 device.mjs 同一个模式）
 * ------------------------------------------------------------------ */

/**
 * @param {{
 *   name: string, description: string, parameters: object, schema: object,
 *   defaults: (() => object) | object,
 *   render: (args: object, value: object) => Array<{ type: string, text: string }>,
 *   presentCall: (args: object) => object,
 *   execute: (args: object, R: ReturnType<typeof buildResult>, deps: object) => Promise<object>,
 * }} definition
 * @param {object} deps
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
    async execute(args) {
      const input = args !== null && typeof args === 'object' ? args : {};
      try {
        return await definition.execute(input, R, deps);
      } catch (error) {
        return R.fail(codeOf(error), messageOf(error));
      }
    },
    presentCall: (args) => definition.presentCall(args ?? {}),
  };
}

/** 发现 SDK 并要求 adb 可用。 */
async function loadSdk(config) {
  const sdk = await discoverSdk(config);
  if (sdk.found !== true) {
    throw toolError('NO_SDK', `找不到可用的 Android SDK：${sdkProblemSummary(sdk)} 下一步：安装 Android SDK 或设置 ANDROID_HOME，或在 cordis.patch.yml 里给 android-emulator 行配 sdkPath。`);
  }
  if (sdk.adb === '') {
    throw toolError('NO_ADB', '找到了 SDK，但没有 adb（platform-tools）。下一步：在 SDK Manager 里安装 Android SDK Platform-Tools，或用 config.adbPath 指定路径。');
  }
  return sdk;
}

/** 本机时间戳（只用 ASCII，避免 Windows 文件名编码问题）。 */
export function timestamp() {
  const now = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`;
}

/** PNG 文件签名。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 从 PNG 的 IHDR 里取宽高（字节 16..24，大端）。 */
export function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** 对外节点 schema（DESIGN §3 的字段 + bounds/center）。 */
function nodeSchema() {
  return objectSchema(
    {
      text: prop('string'),
      resourceId: prop('string'),
      contentDesc: prop('string'),
      className: prop('string'),
      packageName: prop('string'),
      clickable: prop('boolean'),
      enabled: prop('boolean'),
      scrollable: prop('boolean'),
      bounds: objectSchema(
        {
          x1: prop('number'),
          y1: prop('number'),
          x2: prop('number'),
          y2: prop('number'),
        },
        ['x1', 'y1', 'x2', 'y2'],
      ),
      center: objectSchema(
        {
          x: prop('number'),
          y: prop('number'),
        },
        ['x', 'y'],
      ),
    },
    ['text', 'resourceId', 'contentDesc', 'className', 'packageName', 'clickable', 'enabled', 'scrollable', 'bounds', 'center'],
  );
}

/** 屏幕信息 schema。 */
function screenSchema() {
  return objectSchema(
    {
      width: prop('number'),
      height: prop('number'),
      rotation: prop('number'),
    },
    ['width', 'height', 'rotation'],
  );
}

/* ------------------------------------------------------------------ *
 * 1. android_ui_dump
 * ------------------------------------------------------------------ */

const UI_DUMP_EXECUTE = async (args, R, deps) => {
  const { config } = deps;
  const sdk = await loadSdk(config);
  const serial = await resolveSerial(sdk.adb, args.serial);

  const maxNodes = clamp(args.maxNodes, 1, 2000, 80);
  const xml = await dumpUi(sdk.adb, serial);
  const parsed = parseUiXml(xml);

  // XML 里没有屏幕尺寸，只有节点 bounds；用 wm size 修正（拿不到就用 bounds 估算）。
  const size = await screenSize(sdk.adb, serial);
  const screen = {
    width: size?.width ?? parsed.screen.width,
    height: size?.height ?? parsed.screen.height,
    rotation: parsed.screen.rotation,
  };

  let nodes = parsed.nodes;
  const filteredOut = [];
  if (args.clickableOnly === true) {
    const before = nodes.length;
    nodes = nodes.filter((node) => node.clickable);
    if (nodes.length < before) filteredOut.push(`仅 clickable 过滤掉 ${before - nodes.length} 个`);
  }
  const filter = typeof args.filter === 'string' ? args.filter.trim() : '';
  if (filter !== '') {
    const needle = filter.toLowerCase();
    const before = nodes.length;
    nodes = nodes.filter((node) => [node.text, node.contentDesc, node.resourceId].some((value) => String(value).toLowerCase().includes(needle)));
    if (nodes.length < before) filteredOut.push(`filter "${filter}" 过滤掉 ${before - nodes.length} 个`);
  }

  const total = nodes.length;
  const limited = nodes.slice(0, maxNodes).map((node) => nodeView(node));

  const lines = [`屏幕 ${screen.width}x${screen.height}（rotation ${screen.rotation}） · 包名 ${parsed.packageName === '' ? '未知' : parsed.packageName}`];
  if (filteredOut.length > 0) lines.push(`过滤：${filteredOut.join('，')}`);
  lines.push(`节点：共 ${total} 个，返回 ${limited.length} 个${total > limited.length ? `（maxNodes=${maxNodes} 截断）` : ''}`);
  // 真机实测：WebView 首页只能 dump 到容器节点、text 全空。这**不是失败**，
  // 但必须主动告诉 agent 降级到"截图 + 坐标点击"，否则它会反复试 text 定位。
  const hint = webViewHint(parsed);
  if (hint !== '') lines.push('', `⚠️ ${hint}`);
  if (limited.length === 0) {
    lines.push('没有可返回的节点。下一步：放宽 filter/clickableOnly，或先用 android_screenshot 看看屏幕。');
  } else {
    lines.push('', '点击可用 android_ui_tap（按 text/resourceId/contentDesc 或直接用下面的坐标）。');
  }

  return R.ok(lines.join('\n'), {
    screen,
    nodeCount: limited.length,
    package: parsed.packageName,
    nodes: limited,
  });
};

/* ------------------------------------------------------------------ *
 * 2. android_ui_tap
 * ------------------------------------------------------------------ */

/** target 空值（坐标点击时用）。 */
function emptyTarget() {
  return { text: '', resourceId: '', className: '', bounds: { x1: 0, y1: 0, x2: 0, y2: 0 } };
}

const UI_TAP_EXECUTE = async (args, R, deps) => {
  const { config } = deps;
  const sdk = await loadSdk(config);
  const serial = await resolveSerial(sdk.adb, args.serial);

  const hasX = Number.isFinite(args.x);
  const hasY = Number.isFinite(args.y);
  if (hasX !== hasY) throw toolError('BAD_ARGUMENT', 'x 和 y 要一起给：要么都用坐标点击，要么用 text/resourceId/contentDesc 按元素点击。');

  const waitMs = clamp(args.waitMs, 0, 15000, 0);
  let x = 0;
  let y = 0;
  let target = emptyTarget();
  let how = '';

  if (hasX && hasY) {
    x = toInt(args.x);
    y = toInt(args.y);
    how = `坐标 (${x}, ${y})`;
  } else {
    const criteria = {
      text: typeof args.text === 'string' && args.text !== '' ? args.text : undefined,
      resourceId: typeof args.resourceId === 'string' && args.resourceId !== '' ? args.resourceId : undefined,
      contentDesc: typeof args.contentDesc === 'string' && args.contentDesc !== '' ? args.contentDesc : undefined,
    };
    if (criteria.text === undefined && criteria.resourceId === undefined && criteria.contentDesc === undefined) {
      throw toolError(
        'BAD_ARGUMENT',
        '点击目标不明确：给 x+y 坐标，或给 text / resourceId / contentDesc 之一。下一步：先 android_ui_dump 看看界面上有什么元素。',
      );
    }
    const xml = await dumpUi(sdk.adb, serial);
    const parsed = parseUiXml(xml);
    const matches = findNodes(parsed.nodes, criteria);
    if (matches.length === 0) {
      const described = [
        criteria.text === undefined ? '' : `text="${criteria.text}"`,
        criteria.resourceId === undefined ? '' : `resourceId="${criteria.resourceId}"`,
        criteria.contentDesc === undefined ? '' : `contentDesc="${criteria.contentDesc}"`,
      ]
        .filter((entry) => entry !== '')
        .join('、');
      throw toolError(
        'ELEMENT_NOT_FOUND',
        `界面上找不到 ${described} 的元素。下一步：调用 android_ui_dump 列出当前可点元素（或用 x/y 坐标点击）。如果 android_ui_dump 显示这是 WebView 页面（节点极少、text 全空），uiautomator 看不到内部 DOM：请用 android_screenshot 看界面后用 android_ui_tap {x,y} 坐标点击。注意文字要完全或部分匹配且界面可能已变化。`,
      );
    }
    const index = clamp(args.index, 0, matches.length - 1, 0);
    const node = matches[index];
    x = node.center.x;
    y = node.center.y;
    target = {
      text: node.text,
      resourceId: node.resourceId,
      className: node.className,
      bounds: node.bounds,
    };
    how = `元素 ${describeNode(node)}${matches.length > 1 ? `（第 ${index + 1}/${matches.length} 个匹配）` : ''}`;
  }

  const result = await adbShell(sdk.adb, serial, ['input', 'tap', String(x), String(y)]);
  if (result.code !== 0 && `${result.stdout}${result.stderr}`.trim() !== '') {
    return R.fail('ADB_FAILED', `点击 (${x}, ${y}) 失败：${truncate(`${result.stdout}\n${result.stderr}`.trim(), 500)}。下一步：确认设备还在（android_status），再重试。`, {
      tapped: { x, y },
      target,
    });
  }
  if (waitMs > 0) await sleep(waitMs);

  return R.ok(
    `已点击 ${how}${waitMs > 0 ? `，等待 ${ms(waitMs)}` : ''}。下一步：android_screenshot 确认界面变化，或 android_ui_dump 看新界面，或用 android_ui_wait 等目标元素出现。`,
    { tapped: { x, y }, target },
  );
};

/* ------------------------------------------------------------------ *
 * 3. android_ui_swipe
 * ------------------------------------------------------------------ */

const UI_SWIPE_EXECUTE = async (args, R, deps) => {
  const { config } = deps;
  const sdk = await loadSdk(config);
  const serial = await resolveSerial(sdk.adb, args.serial);

  const coordinates = [args.x1, args.y1, args.x2, args.y2];
  if (coordinates.some((value) => !Number.isFinite(value))) {
    throw toolError('BAD_ARGUMENT', 'x1/y1/x2/y2 四个坐标都要给数字。下一步：先 android_ui_dump 拿到元素 bounds，或用屏幕尺寸估算（例如从屏幕中间向上滑）。');
  }
  const x1 = toInt(args.x1);
  const y1 = toInt(args.y1);
  const x2 = toInt(args.x2);
  const y2 = toInt(args.y2);
  const durationMs = toInt(clamp(args.durationMs, 50, 10000, 300));

  const result = await adbShell(sdk.adb, serial, ['input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(durationMs)]);
  if (result.code !== 0 && `${result.stdout}${result.stderr}`.trim() !== '') {
    return R.fail('ADB_FAILED', `滑动失败：${truncate(`${result.stdout}\n${result.stderr}`.trim(), 500)}`, {
      from: { x: x1, y: y1 },
      to: { x: x2, y: y2 },
      durationMs,
    });
  }
  return R.ok(
    `已从 (${x1}, ${y1}) 滑到 (${x2}, ${y2})，耗时 ${durationMs} ms。下一步：android_screenshot 或 android_ui_wait 确认滑动结果（列表是否滚动了）。`,
    { from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, durationMs },
  );
};

/* ------------------------------------------------------------------ *
 * 4. android_ui_input
 * ------------------------------------------------------------------ */

/** 设备端 sh 会解释的元字符（DESIGN §7 的清单，含反斜杠）。 */
const SHELL_META = /['"`$\\&|;<>()*?~#!/]/g;

const UI_INPUT_EXECUTE = async (args, R, deps) => {
  const { config } = deps;
  const sdk = await loadSdk(config);
  const serial = await resolveSerial(sdk.adb, args.serial);

  const note = [];
  const original = typeof args.text === 'string' ? args.text : '';
  if (original === '') throw toolError('BAD_ARGUMENT', 'text 参数是必填的（要输入的内容，非空）。');

  // 1) 只保留 ASCII 可打印字符（0x20..0x7E）——Android input text 的硬限制。
  const kept = [];
  const dropped = new Set();
  for (const character of original) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) kept.push(character);
    else dropped.add(character);
  }
  if (kept.length === 0) {
    // DESIGN §9：不做中文输入。这里明确说"没有这个能力"，并给替代路径。
    return R.fail(
      'BAD_ARGUMENT',
      '这段文本里没有任何 ASCII 可打印字符，无法用 `input text` 输入。Android 的 `input text` 不支持中文/emoji（v1 也不引入第三方输入法）。替代办法：在界面里点输入框唤起系统输入法后由人输入，或先用 android_ui_tap 点击输入框、再用 adb 的其他方式注入文本。',
      { sent: '', asciiOnly: false, note: `被过滤字符：${[...dropped].slice(0, 20).join(' ')}` },
    );
  }
  if (dropped.size > 0) {
    note.push(`已过滤 ${dropped.size} 个非 ASCII 字符（${[...dropped].slice(0, 10).join(' ')}${dropped.size > 10 ? ' …' : ''}），input text 只支持 ASCII。`);
  }

  // 2) 过滤设备端 sh 元字符（防止命令被重新解析）。
  let payload = kept.join('');
  const metaFound = payload.match(SHELL_META) ?? [];
  if (metaFound.length > 0) {
    payload = payload.replace(SHELL_META, '');
    note.push(`已过滤 shell 元字符：${[...new Set(metaFound)].join(' ')}。`);
  }
  // 3) 空格必须写成 %s（input text 的约定）。
  payload = payload.replace(/ /g, '%s');
  if (payload === '') {
    return R.fail('BAD_ARGUMENT', '过滤之后没有剩下可输入的字符（都是 shell 元字符）。下一步：改写文本，避免 \' " ` $ \\ & | ; < > ( ) * ? ~ # ! 这些字符。', {
      sent: '',
      asciiOnly: true,
      note: note.join(' '),
    });
  }

  // 4) clear：MOVE_END 再连发 DEL。input keyevent 支持一次多个 keycode。
  if (args.clear === true) {
    await adbShell(sdk.adb, serial, ['input', 'keyevent', '123'], { timeoutMs: 15000 });
    await adbShell(sdk.adb, serial, ['input', 'keyevent', ...Array(50).fill('67')], { timeoutMs: 30000 });
    note.push('输入前已清空输入框（MOVE_END + 50 次 DEL）。');
  }

  const result = await adbShell(sdk.adb, serial, ['input', 'text', payload], { timeoutMs: 30000 });
  if (result.code !== 0 && `${result.stdout}${result.stderr}`.trim() !== '') {
    return R.fail('ADB_FAILED', `输入文本失败：${truncate(`${result.stdout}\n${result.stderr}`.trim(), 500)}。下一步：确认输入框已聚焦（先 android_ui_tap 点它），再重试。`, {
      sent: payload,
      asciiOnly: true,
      note: note.join(' '),
    });
  }

  return R.ok(
    `已输入 ${JSON.stringify(payload)}${note.length === 0 ? '' : `（${note.join(' ')}）`}。下一步：android_ui_dump 确认文本已进入输入框，或 android_ui_tap 提交。`,
    { sent: payload, asciiOnly: true, note: note.join(' ') },
  );
};

/* ------------------------------------------------------------------ *
 * 5. android_ui_key
 * ------------------------------------------------------------------ */

/** DESIGN §7 冻结的键位映射。 */
const KEYCODES = {
  back: 4,
  home: 3,
  enter: 66,
  menu: 82,
  tab: 61,
  delete: 67,
  escape: 111,
  power: 26,
  volume_up: 24,
  volume_down: 25,
  recent: 187,
};

const UI_KEY_EXECUTE = async (args, R, deps) => {
  const { config } = deps;
  const sdk = await loadSdk(config);
  const serial = await resolveSerial(sdk.adb, args.serial);

  const raw = typeof args.key === 'string' ? args.key.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
  const normalized = raw.startsWith('keycode_') ? raw.slice('keycode_'.length) : raw;
  const keycode = KEYCODES[normalized];
  if (keycode === undefined) {
    throw toolError(
      'BAD_ARGUMENT',
      `不支持的按键 "${args.key}"。可用的键：${Object.keys(KEYCODES).join('、')}（也可以写 KEYCODE_ 前缀，例如 KEYCODE_BACK）。`,
    );
  }

  const result = await adbShell(sdk.adb, serial, ['input', 'keyevent', String(keycode)]);
  if (result.code !== 0 && `${result.stdout}${result.stderr}`.trim() !== '') {
    return R.fail('ADB_FAILED', `发送按键 ${normalized} 失败：${truncate(`${result.stdout}\n${result.stderr}`.trim(), 500)}`, {
      key: normalized,
      keycode,
    });
  }
  return R.ok(`已发送按键 ${normalized}（keycode ${keycode}）。下一步：android_screenshot 或 android_ui_dump 确认界面变化。`, {
    key: normalized,
    keycode,
  });
};

/* ------------------------------------------------------------------ *
 * 6. android_ui_wait
 * ------------------------------------------------------------------ */

const UI_WAIT_EXECUTE = async (args, R, deps) => {
  const { config } = deps;
  const sdk = await loadSdk(config);

  // 先把设备解析出来：没有设备是失败（DEVICE_NOT_RUNNING），而"等不到元素"不是。
  const serial = await resolveSerial(sdk.adb, args.serial);
  const criteria = {
    text: typeof args.text === 'string' && args.text !== '' ? args.text : undefined,
    resourceId: typeof args.resourceId === 'string' && args.resourceId !== '' ? args.resourceId : undefined,
    contentDesc: typeof args.contentDesc === 'string' && args.contentDesc !== '' ? args.contentDesc : undefined,
  };
  if (criteria.text === undefined && criteria.resourceId === undefined && criteria.contentDesc === undefined) {
    throw toolError('BAD_ARGUMENT', '至少给 text / resourceId / contentDesc 之一，才知道要等什么。');
  }
  const timeoutMs = clamp(args.timeoutMs, 500, 120000, 10000);
  const intervalMs = clamp(args.intervalMs, 100, 5000, 500);

  const startedAt = Date.now();
  let found = null;
  let lastError = '';
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const xml = await dumpUi(sdk.adb, serial);
      const parsed = parseUiXml(xml);
      const matches = findNodes(parsed.nodes, criteria);
      if (matches.length > 0) {
        found = matches[0];
        break;
      }
    } catch (error) {
      // 界面正在切换/动画时 dump 会失败，这是常态：记下原因继续等。
      lastError = messageOf(error);
    }
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  const waitedMs = Date.now() - startedAt;

  if (found === null) {
    const wanted = [
      criteria.text === undefined ? '' : `text="${criteria.text}"`,
      criteria.resourceId === undefined ? '' : `resourceId="${criteria.resourceId}"`,
      criteria.contentDesc === undefined ? '' : `contentDesc="${criteria.contentDesc}"`,
    ]
      .filter((entry) => entry !== '')
      .join('、');
    return R.ok(
      `等了 ${ms(waitedMs)} 没有等到 ${wanted}（这不是错误，只是超时）。下一步：加大 timeoutMs、检查是否有弹窗/加载中，或先 android_ui_dump 看看当前界面。如果等的内容在 WebView 里，uiautomator 看不到内部 DOM，请改用 android_screenshot 看界面后用 android_ui_tap {x,y} 坐标操作。${lastError === '' ? '' : `（期间最后一次 dump 失败：${truncate(lastError, 200)}）`}`,
      { found: false, waitedMs, node: emptyNodeView() },
    );
  }

  return R.ok(`等了 ${ms(waitedMs)}，${describeNode(found)} 出现了。下一步：android_ui_tap 直接点它（用同样的 text/resourceId/contentDesc 定位）。`, {
    found: true,
    waitedMs,
    node: nodeView(found),
  });
};

/* ------------------------------------------------------------------ *
 * 7. android_screenshot
 * ------------------------------------------------------------------ */

const SCREENSHOT_EXECUTE = async (args, R, deps) => {
  const { config } = deps;
  const sdk = await loadSdk(config);
  const serial = await resolveSerial(sdk.adb, args.serial);

  const buffer = await screencap(sdk.adb, serial);
  if (buffer.length === 0) {
    return R.fail('ADB_FAILED', '截图返回了空内容。下一步：确认设备还在运行（android_status），或先 android_ui_dump 看界面是否可读。', {
      path: '',
      width: 0,
      height: 0,
      bytes: 0,
    });
  }
  const size = pngSize(buffer);
  if (size === null) {
    const preview = buffer.subarray(0, 200).toString('utf8').replace(/\s+/g, ' ').trim();
    return R.fail('ADB_FAILED', `截图返回的不是合法 PNG（magic 不是 89 50 4E 47，${buffer.length} 字节）：${truncate(preview, 200)}。常见原因：设备端 screencap 不支持 exec-out，或输出被某个编码层污染（PowerShell 的 > 重定向会写成 UTF-16，实测 magic 会变成 FF FE FD FF）。下一步：确认设备还在运行；本插件是用 exec-out + Buffer 直连的，不需要经过 shell 重定向。`, {
      path: '',
      width: 0,
      height: 0,
      bytes: buffer.length,
    });
  }

  const label = typeof args.label === 'string' ? args.label.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : '';
  const fileName = `shot-${timestamp()}${label === '' ? '' : `-${label}`}.png`;
  const filePath = path.resolve(config.outputDir, fileName);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, buffer);

  // 写盘后回读 magic：PNG 一旦被任何编码层碰过就永久损坏（UTF-16 重定向会得到
  // FF FE FD FF 开头的"PNG"），所以落盘结果必须自己验一次再报告成功。
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(8);
    await handle.read(header, 0, 8, 0);
    if (!header.equals(PNG_SIGNATURE)) {
      return R.fail('INTERNAL', `截图写盘后 PNG magic 校验失败（文件头变成 ${header.toString('hex')}，应为 89504e470d0a1a0a）：${filePath}。下一步：把 config.outputDir 换到本地磁盘后重试，并检查是否有同步/编码工具改写了该目录。`, {
        path: filePath,
        width: 0,
        height: 0,
        bytes: buffer.length,
      });
    }
  } finally {
    await handle.close();
  }

  return R.ok(
    `截图已保存：${filePath}（${size.width}x${size.height}，${buffer.length} 字节）。用 read_image 打开这个绝对路径就能看到界面；也可以和上一次截图对比确认操作生效。`,
    { path: filePath, width: size.width, height: size.height, bytes: buffer.length },
  );
};

/* ------------------------------------------------------------------ *
 * schema + 工具定义
 * ------------------------------------------------------------------ */

/** 三件套 schema。 */
function tripleSchema() {
  return {
    ok: prop('boolean', '是否成功。'),
    code: prop('string', '机器可读结果码；"OK" 表示成功。'),
    message: prop('string', '中文说明 + 可执行的下一步建议。'),
  };
}

const UI_DUMP_SCHEMA = (() => {
  const properties = {
    ...tripleSchema(),
    screen: screenSchema(),
    nodeCount: prop('number', '本次返回的节点数量（受 maxNodes 限制）。'),
    package: prop('string', '界面对应的包名。'),
    nodes: arrayOf(nodeSchema(), '界面节点（按 uiautomator dump 顺序）。'),
  };
  return objectSchema(properties, Object.keys(properties));
})();

const UI_TAP_SCHEMA = (() => {
  const properties = {
    ...tripleSchema(),
    tapped: objectSchema(
      {
        x: prop('number', '实际点击的 x 坐标。'),
        y: prop('number', '实际点击的 y 坐标。'),
      },
      ['x', 'y'],
    ),
    target: objectSchema(
      {
        text: prop('string'),
        resourceId: prop('string'),
        className: prop('string'),
        bounds: objectSchema(
          {
            x1: prop('number'),
            y1: prop('number'),
            x2: prop('number'),
            y2: prop('number'),
          },
          ['x1', 'y1', 'x2', 'y2'],
        ),
      },
      ['text', 'resourceId', 'className', 'bounds'],
    ),
  };
  return objectSchema(properties, Object.keys(properties));
})();

const UI_SWIPE_SCHEMA = (() => {
  const properties = {
    ...tripleSchema(),
    from: objectSchema(
      {
        x: prop('number'),
        y: prop('number'),
      },
      ['x', 'y'],
    ),
    to: objectSchema(
      {
        x: prop('number'),
        y: prop('number'),
      },
      ['x', 'y'],
    ),
    durationMs: prop('number'),
  };
  return objectSchema(properties, Object.keys(properties));
})();

const UI_INPUT_SCHEMA = (() => {
  const properties = {
    ...tripleSchema(),
    sent: prop('string', '实际发给设备的字符串（空格已替换为 %s）。'),
    asciiOnly: prop('boolean', '是否只输入了 ASCII 可打印字符（受 Android input text 限制，恒为 true；纯非 ASCII 会在 code 里失败）。'),
    note: prop('string', '过滤说明：被丢弃的非 ASCII 字符、shell 元字符、是否清空过输入框。没有发生过滤时为空串。'),
  };
  return objectSchema(properties, Object.keys(properties));
})();

const UI_KEY_SCHEMA = (() => {
  const properties = {
    ...tripleSchema(),
    key: prop('string', '归一化后的按键名（小写）。'),
    keycode: prop('number', 'Android keycode。'),
  };
  return objectSchema(properties, Object.keys(properties));
})();

const UI_WAIT_SCHEMA = (() => {
  const properties = {
    ...tripleSchema(),
    found: prop('boolean', '是否等到了目标元素。超时是 ok:true + found:false，不是错误。'),
    waitedMs: prop('number', '实际等待时长（毫秒）。'),
    node: nodeSchema(),
  };
  return objectSchema(properties, Object.keys(properties));
})();

const SCREENSHOT_SCHEMA = (() => {
  const properties = {
    ...tripleSchema(),
    path: prop('string', 'PNG 的绝对路径（可直接用于 read_image）；失败时为空串。'),
    width: prop('number'),
    height: prop('number'),
    bytes: prop('number', 'PNG 文件字节数。'),
  };
  return objectSchema(properties, Object.keys(properties));
})();

/**
 * 构造 7 个界面交互工具。
 *
 * @param {{ config: object }} deps
 * @returns {Array<object>}
 */
export function buildInteractTools(deps) {
  return [
    defineTool(
      {
        name: 'android_ui_dump',
        description:
          'dump 当前界面的 UI 树（uiautomator），返回屏幕尺寸、包名和节点列表（text / resourceId / contentDesc / className / bounds / center / clickable / enabled / scrollable）。这是"看界面"的主要手段：找到可点元素后可用 android_ui_tap 按 text/resourceId 点击，或直接用返回的 center 坐标。可用 clickableOnly 只看可点元素、filter 按文字过滤。',
        parameters: objectSchema({
          serial: prop('string', '目标设备 serial。省略则用当前设备。'),
          maxNodes: prop('number', '最多返回多少个节点（默认 80，最大 2000）。界面很大时先用 filter/clickableOnly 缩小。'),
          clickableOnly: prop('boolean', '只返回 clickable=true 的节点。'),
          filter: prop('string', '只返回 text/contentDesc/resourceId 里包含该子串的节点。'),
        }),
        schema: UI_DUMP_SCHEMA,
        defaults: () => ({
          screen: { width: 0, height: 0, rotation: 0 },
          nodeCount: 0,
          package: '',
          nodes: [],
        }),
        render: (args, value) => {
          if (value.nodes.length === 0) return text(value.message);
          const lines = [value.message, ''];
          value.nodes.forEach((node, index) => {
            lines.push(`#${index} ${describeNode(node)}`);
          });
          lines.push('', '提示：android_ui_tap 支持 { text } / { resourceId } / { contentDesc } / { x, y } 定位。');
          return text(lines.join('\n'));
        },
        presentCall: () => ({ card: 'generic', title: '查看界面元素', kind: 'read' }),
        execute: UI_DUMP_EXECUTE,
      },
      deps,
    ),
    defineTool(
      {
        name: 'android_ui_tap',
        description:
          '点击屏幕：给 x+y 就是坐标点击；否则用 text / resourceId / contentDesc 按元素点击（内部先 dump UI 树，取匹配元素的中心点）。元素定位不到返回 ELEMENT_NOT_FOUND。有多个匹配时可用 index 选第几个。点击后建议用 android_screenshot 确认界面变化。',
        parameters: objectSchema({
          x: prop('number', '屏幕 x 坐标（和 y 一起用）。'),
          y: prop('number', '屏幕 y 坐标（和 x 一起用）。'),
          text: prop('string', '按节点文字定位（不区分大小写的包含匹配）。'),
          resourceId: prop('string', '按 resource-id 定位，例如 "com.example.demo:id/login"。'),
          contentDesc: prop('string', '按 content-desc 定位。'),
          index: prop('number', '多个匹配时点第几个（从 0 开始，默认 0）。'),
          serial: prop('string', '目标设备 serial。省略则用当前设备。'),
          waitMs: prop('number', '点击后等待多少毫秒再返回（默认 0，最多 15000）。等界面过场时有用。'),
        }),
        schema: UI_TAP_SCHEMA,
        defaults: () => ({ tapped: { x: 0, y: 0 }, target: emptyTarget() }),
        render: (args, value) => text(value.message),
        presentCall: (args) => ({
          card: 'generic',
          title: typeof args.text === 'string' && args.text !== '' ? `点击「${args.text}」` : '点击屏幕',
          kind: 'execute',
        }),
        execute: UI_TAP_EXECUTE,
      },
      deps,
    ),
    defineTool(
      {
        name: 'android_ui_swipe',
        description:
          '滑动屏幕（input swipe）。用于滚动列表、翻页、下拉刷新：从 (x1,y1) 滑到 (x2,y2)，durationMs 越大越慢（慢滑更容易被识别成拖动而不是甩动）。',
        parameters: objectSchema(
          {
            x1: prop('number', '起点 x。'),
            y1: prop('number', '起点 y。'),
            x2: prop('number', '终点 x。'),
            y2: prop('number', '终点 y。'),
            durationMs: prop('number', '滑动时长（毫秒，默认 300，范围 50~10000）。'),
            serial: prop('string', '目标设备 serial。省略则用当前设备。'),
          },
          ['x1', 'y1', 'x2', 'y2'],
        ),
        schema: UI_SWIPE_SCHEMA,
        defaults: () => ({ from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, durationMs: 0 }),
        render: (args, value) => text(value.message),
        presentCall: () => ({ card: 'generic', title: '滑动屏幕', kind: 'execute' }),
        execute: UI_SWIPE_EXECUTE,
      },
      deps,
    ),
    defineTool(
      {
        name: 'android_ui_input',
        description:
          '向当前聚焦的输入框输入文本（input text）。只能在 ASCII 可打印字符范围内工作：非 ASCII（中文/emoji）会被过滤并在 note 里报告，纯非 ASCII 会返回 BAD_ARGUMENT（这是 Android 的限制，v1 不引入第三方输入法）。空格会自动转 %s；shell 元字符会被过滤并报告。clear:true 会先清空输入框（MOVE_END + 50 次 DEL）。输入前请先 android_ui_tap 点中输入框。',
        parameters: objectSchema(
          {
            text: prop('string', '要输入的文本（必填）。只支持 ASCII 可打印字符。'),
            serial: prop('string', '目标设备 serial。省略则用当前设备。'),
            clear: prop('boolean', '输入前是否先清空输入框（默认 false）。'),
          },
          ['text'],
        ),
        schema: UI_INPUT_SCHEMA,
        defaults: () => ({ sent: '', asciiOnly: true, note: '' }),
        render: (args, value) => text(value.message),
        presentCall: () => ({ card: 'generic', title: '输入文本', kind: 'execute' }),
        execute: UI_INPUT_EXECUTE,
      },
      deps,
    ),
    defineTool(
      {
        name: 'android_ui_key',
        description:
          '发送功能按键（input keyevent）。支持的键：back（返回）、home、enter（确认/提交）、menu、tab、delete（退格）、escape、power（锁/亮屏）、volume_up、volume_down、recent（最近任务）。按键名也可以用 KEYCODE_ 前缀。',
        parameters: objectSchema(
          {
            key: prop('string', '按键名：back / home / enter / menu / tab / delete / escape / power / volume_up / volume_down / recent（必填）。'),
            serial: prop('string', '目标设备 serial。省略则用当前设备。'),
          },
          ['key'],
        ),
        schema: UI_KEY_SCHEMA,
        defaults: () => ({ key: '', keycode: 0 }),
        render: (args, value) => text(value.message),
        presentCall: (args) => ({ card: 'generic', title: `按键 ${typeof args.key === 'string' ? args.key : ''}`.trim(), kind: 'execute' }),
        execute: UI_KEY_EXECUTE,
      },
      deps,
    ),
    defineTool(
      {
        name: 'android_ui_wait',
        description:
          '轮询等待界面出现某个元素（按 text / resourceId / contentDesc，至少给一个）。这是做断言的主力：等首屏、等加载完成、等弹窗。超时不报错：返回 ok:true + found:false，message 说明等不到什么；等到时 node 里带该元素的完整信息（可直接 android_ui_tap 点它）。',
        parameters: objectSchema({
          text: prop('string', '等这个文字出现（不区分大小写的包含匹配）。'),
          resourceId: prop('string', '等这个 resource-id 出现。'),
          contentDesc: prop('string', '等这个 content-desc 出现。'),
          timeoutMs: prop('number', '最长等多久（默认 10000，范围 500~120000）。'),
          intervalMs: prop('number', '轮询间隔（默认 500，范围 100~5000）。'),
          serial: prop('string', '目标设备 serial。省略则用当前设备。'),
        }),
        schema: UI_WAIT_SCHEMA,
        defaults: () => ({ found: false, waitedMs: 0, node: emptyNodeView() }),
        render: (args, value) =>
          text(value.found ? `${value.message}\n${describeNode(value.node)}` : value.message),
        presentCall: (args) => ({
          card: 'generic',
          title: typeof args.text === 'string' && args.text !== '' ? `等待「${args.text}」` : '等待界面元素',
          kind: 'read',
        }),
        execute: UI_WAIT_EXECUTE,
      },
      deps,
    ),
    defineTool(
      {
        name: 'android_screenshot',
        description:
          '截图当前屏幕（exec-out screencap -p），存成 PNG 并返回绝对路径、宽高、字节数。用 read_image 打开返回的 path 就能看到界面 —— 这是确认"操作到底有没有生效"最直接的证据。',
        parameters: objectSchema({
          serial: prop('string', '目标设备 serial。省略则用当前设备。'),
          label: prop('string', '可选标签，会加到文件名里（只保留 ASCII 字母/数字/_/-，用于区分多张截图）。'),
        }),
        schema: SCREENSHOT_SCHEMA,
        defaults: () => ({ path: '', width: 0, height: 0, bytes: 0 }),
        render: (args, value) => text(value.message),
        presentCall: (args) => ({ card: 'generic', title: `截屏${typeof args.label === 'string' && args.label !== '' ? `：${args.label}` : ''}`, kind: 'read' }),
        execute: SCREENSHOT_EXECUTE,
      },
      deps,
    ),
  ];
}
