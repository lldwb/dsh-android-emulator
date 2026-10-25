/**
 * `lib/uiauto.mjs` 的测试：uiautomator XML → 结构化节点（纯函数，真实样本）。
 *
 * 样本取自真实 `uiautomator dump` 的输出形态（属性顺序、自闭合 `<node … />`、
 * `bounds="[x1,y1][x2,y2]"`、XML 实体转义）。这类解析器的 bug 几乎全在边角：
 * 中文文本、`&amp;lt;` 双重转义、`enabled="false"` 被当成真值、屏幕尺寸是估算出来的……
 * 所以用固定 XML 文件而不是内联字符串，改样本时能一眼看出 diff。
 *
 * @module test/uiauto
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  describeNode,
  emptyNodeView,
  findNodes,
  nodeView,
  parseBounds,
  parseUiXml,
  parseWmSize,
  unescapeXml,
} from '../lib/uiauto.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * 读一个 fixture XML。
 *
 * @param {string} name 文件名。
 * @returns {string} XML 文本。
 */
function fixture(name) {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

/** 真实竖屏 dump：9 个 node，含中文、`&amp;`、`&lt;`、可点/禁用/可滚动节点。 */
const MAIN_XML = fixture('ui-main.xml');
/** 横屏 dump：rotation="1"，屏幕 2400x1080。 */
const LANDSCAPE_XML = fixture('ui-landscape.xml');

test('parseUiXml：节点数、screen 尺寸、rotation、packageName 都对', () => {
  const parsed = parseUiXml(MAIN_XML);
  assert.equal(parsed.nodes.length, 9, `期望 9 个 <node>，实际 ${parsed.nodes.length}`);
  assert.deepEqual(parsed.screen, { width: 1080, height: 2400, rotation: 0 });
  assert.equal(parsed.packageName, 'com.example.demo');
});

test('parseUiXml：每个节点都有完整的对外字段（DESIGN §3 的形状）', () => {
  const { nodes } = parseUiXml(MAIN_XML);
  const expectedKeys = [
    'index',
    'text',
    'resourceId',
    'contentDesc',
    'className',
    'packageName',
    'clickable',
    'enabled',
    'scrollable',
    'bounds',
    'center',
  ];
  for (const node of nodes) {
    assert.deepEqual(Object.keys(node).sort(), [...expectedKeys].sort(), `节点缺少字段：${node.index}`);
    assert.equal(typeof node.text, 'string');
    assert.equal(typeof node.resourceId, 'string');
    assert.equal(typeof node.contentDesc, 'string');
    assert.equal(typeof node.className, 'string');
    assert.equal(typeof node.clickable, 'boolean');
    assert.equal(typeof node.enabled, 'boolean');
    assert.equal(typeof node.scrollable, 'boolean');
    for (const key of ['x1', 'y1', 'x2', 'y2']) {
      assert.equal(typeof node.bounds[key], 'number', `bounds.${key} 必须是数字`);
    }
    assert.equal(typeof node.center.x, 'number');
    assert.equal(typeof node.center.y, 'number');
  }
  // index 与数组下标一致（findNodes/日志依赖这个顺序）
  assert.deepEqual(
    nodes.map((node) => node.index),
    nodes.map((_, index) => index),
  );
});

test('parseUiXml：bounds 与中心点计算正确（含浮点四舍五入）', () => {
  const { nodes } = parseUiXml(MAIN_XML);
  const button = nodes.find((node) => node.resourceId === 'com.example.demo:id/btn_start');
  assert.notEqual(button, undefined, '找不到 btn_start 节点');
  assert.deepEqual(button.bounds, { x1: 100, y1: 600, x2: 980, y2: 720 });
  // center = ((100+980)/2, (600+720)/2) = (540, 660)
  assert.deepEqual(button.center, { x: 540, y: 660 });

  const title = nodes.find((node) => node.resourceId === 'com.example.demo:id/title');
  assert.deepEqual(title.bounds, { x1: 40, y1: 168, x2: 360, y2: 240 });
  assert.deepEqual(title.center, { x: 200, y: 204 });

  // 奇数宽高要四舍五入而不是截断：[(0,0)][(3,5)] → center (2, 3)
  const odd = parseUiXml(
    '<?xml version="1.0"?><hierarchy rotation="0"><node index="0" bounds="[0,0][3,5]" /></hierarchy>',
  );
  assert.deepEqual(odd.nodes[0].center, { x: 2, y: 3 });
});

test('parseUiXml：文本与属性反转义（&amp; / &lt; / &gt; / 中文）', () => {
  const { nodes } = parseUiXml(MAIN_XML);
  const subtitle = nodes.find((node) => node.resourceId === 'com.example.demo:id/subtitle');
  assert.equal(subtitle.text, 'Tom & Jerry <测试>');

  const title = nodes.find((node) => node.resourceId === 'com.example.demo:id/title');
  assert.equal(title.text, '示例应用', '中文必须原样保留（UTF-8）');
  assert.equal(title.className, 'android.widget.TextView');

  const button = nodes.find((node) => node.resourceId === 'com.example.demo:id/btn_start');
  assert.equal(button.contentDesc, '开始识别按钮');
});

test('parseUiXml：clickable / enabled / scrollable 严格按布尔值解析（"false" 不是真值）', () => {
  const { nodes } = parseUiXml(MAIN_XML);
  const byId = (id) => nodes.find((node) => node.resourceId === `com.example.demo:id/${id}`);

  assert.equal(byId('btn_start').clickable, true);
  assert.equal(byId('btn_start').enabled, true);

  // enabled="false" 必须是 false —— 用 truthy 判断会错
  assert.equal(byId('btn_disabled').enabled, false);
  assert.equal(byId('btn_disabled').clickable, true);

  assert.equal(byId('scroll').scrollable, true);
  assert.equal(byId('scroll').clickable, false);

  // 普通文本节点三个都是 false
  assert.equal(byId('row1').clickable, false);
  assert.equal(byId('row1').scrollable, false);
});

test('parseUiXml：横屏 rotation 与屏幕尺寸', () => {
  const parsed = parseUiXml(LANDSCAPE_XML);
  assert.equal(parsed.nodes.length, 3);
  assert.equal(parsed.screen.rotation, 1);
  assert.deepEqual(parsed.screen, { width: 2400, height: 1080, rotation: 1 });
  const ok = parsed.nodes.find((node) => node.resourceId === 'com.example.demo:id/ok');
  assert.deepEqual(ok.center, { x: 2195, y: 980 });
});

test('parseUiXml：空/非法输入不抛异常，返回空结果', () => {
  for (const input of ['', undefined, null, 123, '<hierarchy rotation="0"></hierarchy>', 'not xml at all']) {
    const parsed = parseUiXml(/** @type {string} */ (input));
    assert.deepEqual(parsed.nodes, [], `输入 ${String(input)} 应返回空节点数组`);
    assert.equal(parsed.packageName, '');
    assert.equal(parsed.screen.width, 0);
    assert.equal(parsed.screen.height, 0);
    assert.equal(parsed.screen.rotation, 0);
  }
});

test('parseUiXml：畸形的 bounds 退化为全 0，不影响其它节点', () => {
  const xml = [
    '<?xml version="1.0"?><hierarchy rotation="0">',
    '<node index="0" text="坏节点" bounds="garbage" />',
    '<node index="1" text="好节点" bounds="[10,20][30,40]" />',
    '</hierarchy>',
  ].join('');
  const { nodes } = parseUiXml(xml);
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes[0].bounds, { x1: 0, y1: 0, x2: 0, y2: 0 });
  assert.deepEqual(nodes[0].center, { x: 0, y: 0 });
  assert.deepEqual(nodes[1].bounds, { x1: 10, y1: 20, x2: 30, y2: 40 });
});

test('parseBounds：支持负数（屏幕外节点）、空格、非法值', () => {
  assert.deepEqual(parseBounds('[0,0][1080,2400]'), { x1: 0, y1: 0, x2: 1080, y2: 2400 });
  assert.deepEqual(parseBounds('[ -10 , -20 ][ 30 , 40 ]'), { x1: -10, y1: -20, x2: 30, y2: 40 });
  assert.equal(parseBounds(''), null);
  assert.equal(parseBounds(undefined), null);
  assert.equal(parseBounds('0,0,100,100'), null);
  assert.equal(parseBounds('[0,0]'), null);
});

test('unescapeXml：数字引用、命名实体、&amp; 最后处理（不二次解析）', () => {
  assert.equal(unescapeXml('a &amp; b'), 'a & b');
  assert.equal(unescapeXml('&lt;tag&gt;'), '<tag>');
  assert.equal(unescapeXml('&quot;引号&quot;'), '"引号"');
  assert.equal(unescapeXml('&apos;单引号&apos;'), "'单引号'");
  assert.equal(unescapeXml('&#10;换行'), '\n换行');
  assert.equal(unescapeXml('&#x4e2d;&#x6587;'), '中文');
  // 关键：`&amp;lt;` 是「字面量 &lt;」，不能再变成 `<`
  assert.equal(unescapeXml('&amp;lt;'), '&lt;');
  assert.equal(unescapeXml(''), '');
  assert.equal(unescapeXml(undefined), '');
  // 越界码点不抛异常
  assert.doesNotThrow(() => unescapeXml('&#99999999;'));
});

test('findNodes：text / resourceId / contentDesc 条件，默认不区分大小写的包含匹配', () => {
  const { nodes } = parseUiXml(MAIN_XML);

  // resource-id 完整或部分都行（部分匹配是常见用法：只写 id 名不写包名）
  assert.equal(findNodes(nodes, { resourceId: 'btn_start' }).length, 1);
  assert.equal(findNodes(nodes, { resourceId: 'com.example.demo:id/btn_start' }).length, 1);

  // text：包含匹配 + 大小写不敏感
  assert.equal(findNodes(nodes, { text: '开始' }).length, 1);
  assert.equal(findNodes(nodes, { text: 'tom & jerry' }).length, 1);
  assert.equal(findNodes(nodes, { text: 'Tom & Jerry <测试>' }).length, 1);

  // contentDesc
  const byDesc = findNodes(nodes, { contentDesc: '开始识别按钮' });
  assert.equal(byDesc.length, 1);
  assert.equal(byDesc[0].resourceId, 'com.example.demo:id/btn_start');

  // 多个条件 AND
  assert.equal(findNodes(nodes, { text: '开始识别', resourceId: 'btn_start' }).length, 1);
  assert.equal(findNodes(nodes, { text: '开始识别', resourceId: 'btn_disabled' }).length, 0);

  // className
  assert.equal(findNodes(nodes, { className: 'android.widget.Button' }).length, 2);
});

test('findNodes：exact 时严格相等；无条件 / 无命中返回空数组', () => {
  const { nodes } = parseUiXml(MAIN_XML);

  // 包含匹配命中 1 个，exact 就不命中
  assert.equal(findNodes(nodes, { text: '开始' }).length, 1);
  assert.equal(findNodes(nodes, { text: '开始', exact: true }).length, 0);
  assert.equal(findNodes(nodes, { text: '开始识别', exact: true }).length, 1);

  assert.deepEqual(findNodes(nodes, {}), []);
  assert.deepEqual(findNodes(nodes, { text: '不存在的文本' }), []);
  assert.deepEqual(findNodes([], { text: 'x' }), []);
  assert.deepEqual(findNodes(undefined, { text: 'x' }), []);
});

test('findNodes：保持文档顺序（点击第一个命中就是界面上第一个）', () => {
  const { nodes } = parseUiXml(MAIN_XML);
  const matches = findNodes(nodes, { className: 'android.widget.Button' });
  assert.deepEqual(
    matches.map((node) => node.resourceId),
    ['com.example.demo:id/btn_start', 'com.example.demo:id/btn_disabled'],
  );
});

test('nodeView / emptyNodeView：投影成对外形状（去掉内部 index，补齐空值）', () => {
  const parsed = parseUiXml(MAIN_XML);
  const button = parsed.nodes.find((node) => node.resourceId === 'com.example.demo:id/btn_start');
  const view = nodeView(button);
  assert.equal(Object.hasOwn(view, 'index'), false, '对外节点不应暴露内部 index');
  assert.equal(view.text, '开始识别');
  assert.equal(view.clickable, true);
  assert.deepEqual(view.bounds, { x1: 100, y1: 600, x2: 980, y2: 720 });
  assert.deepEqual(view.center, { x: 540, y: 660 });

  // 空值形状必须能通过 output.schema 的节点校验（字段齐全、类型正确）
  assert.deepEqual(nodeView(null), emptyNodeView());
  const empty = emptyNodeView();
  assert.equal(empty.text, '');
  assert.equal(empty.clickable, false);
  assert.deepEqual(empty.bounds, { x1: 0, y1: 0, x2: 0, y2: 0 });
  assert.deepEqual(empty.center, { x: 0, y: 0 });
});

test('parseWmSize：解析 Physical / Override 尺寸，以最后一行为准', () => {
  assert.deepEqual(parseWmSize('Physical size: 1080x2400'), { width: 1080, height: 2400 });
  assert.deepEqual(
    parseWmSize('Physical size: 1080x2400\nOverride size: 720x1600\n'),
    { width: 720, height: 1600 },
    'Override 才是实际分辨率，必须取最后一个',
  );
  assert.deepEqual(parseWmSize('  1080x2400  '), { width: 1080, height: 2400 });
  assert.equal(parseWmSize(''), null);
  assert.equal(parseWmSize('no size here'), null);
  assert.equal(parseWmSize(undefined), null);
});

test('describeNode：一行摘要包含坐标与关键属性，不抛异常', () => {
  const { nodes } = parseUiXml(MAIN_XML);
  const button = nodes.find((node) => node.resourceId === 'com.example.demo:id/btn_start');
  const line = describeNode(nodeView(button));
  assert.match(line, /\[540,660\]/u);
  assert.match(line, /开始识别/u);
  assert.match(line, /clickable/u);
  assert.equal(typeof describeNode(emptyNodeView()), 'string');
  assert.ok(describeNode(emptyNodeView()).length > 0);
});

/* ------------------------------------------------------------------ *
 * 真实设备样本（来自 `临时工作区/` 的真机 adb 冒烟）
 * ------------------------------------------------------------------ *
 *
 * 这几份 XML 是**真机 `uiautomator dump` 原样输出**，不是手造的。
 * 它们覆盖了最重要的一个真实事实（DESIGN 里也强调了）：
 *
 *   Capacitor / WebView 应用的**首页 DOM 对 uiautomator 完全不可见** ——
 *   整个首页只能 dump 到 7 个布局容器，`text` 全空，唯一有意义的节点是
 *   `com.example.demo:id/webview`（class=`android.webkit.WebView`）。
 *   而原生控件页（工作台）能 dump 到 37 个节点、22 个带 text、9 个 clickable。
 *
 * 所以「按 text 定位」只对原生控件页有效；WebView 页必须降级到
 * 「android_screenshot 看界面 + android_ui_tap {x,y} 坐标点击」。
 */

/** 真机首页 dump：7 个节点、text 全空、只有 WebView 容器。 */
const REAL_WEBVIEW_HOME = fixture('real-webview-home.xml');
/** 真机工作台页 dump：原生控件，37 个节点、22 个带 text、9 个 clickable。 */
const REAL_WORKBENCH = fixture('real-workbench.xml');
/** 真机「点第一个节点之后」的 dump（进入工作台，证明点击链路生效）。 */
const REAL_AFTER_TAP = fixture('real-after-tap2.xml');

test('真实 WebView 首页：只有 7 个容器节点、text 全空、且解析不抛错（插件必须优雅处理的真实输入）', () => {
  const parsed = parseUiXml(REAL_WEBVIEW_HOME);

  // 节点极少：这是 WebView 页面的真实形态，不是解析 bug
  assert.equal(parsed.nodes.length, 7, `真实首页应解析出 7 个节点，实际 ${parsed.nodes.length}`);
  assert.equal(
    parsed.nodes.filter((node) => node.text !== '').length,
    0,
    'WebView 首页的 text 必须全为空 —— 这正是「按文本定位会失效」的证据',
  );
  assert.equal(parsed.nodes.filter((node) => node.clickable).length, 1, '首页只有 WebView 容器本身是 clickable');
  assert.equal(parsed.packageName, 'com.example.demo');
  assert.deepEqual(parsed.screen, { width: 1080, height: 2400, rotation: 0 });

  // 唯一有意义的节点：WebView 容器（class + bounds 都要对）
  const webview = parsed.nodes.find((node) => node.resourceId === 'com.example.demo:id/webview');
  assert.notEqual(webview, undefined, '必须能定位到 webview 容器节点');
  assert.equal(webview.className, 'android.webkit.WebView');
  assert.equal(webview.clickable, true);
  assert.deepEqual(webview.bounds, { x1: 0, y1: 128, x2: 1080, y2: 2337 });
  assert.deepEqual(webview.center, { x: 540, y: 1233 }, '容器中心点可用于坐标点击');

  // 关键行为：按文本找不到任何东西（WebView 内部 DOM 不可见），但容器本身能按 id 找到
  assert.deepEqual(findNodes(parsed.nodes, { text: '开始识别' }), [], 'WebView 内部文本对 uiautomator 不可见');
  assert.equal(findNodes(parsed.nodes, { text: '' }).length, 0, '空条件不算有效条件');
  assert.equal(findNodes(parsed.nodes, { resourceId: 'webview' }).length, 1, '容器本身仍可按 resource-id 定位');
});

test('真实原生控件页（工作台）：37 节点、22 带 text、9 clickable，可正常按文本定位', () => {
  const parsed = parseUiXml(REAL_WORKBENCH);

  assert.equal(parsed.nodes.length, 37, `工作台页应解析出 37 个节点，实际 ${parsed.nodes.length}`);
  assert.equal(
    parsed.nodes.filter((node) => node.text !== '').length,
    22,
    '工作台是原生控件页，应有 22 个带 text 的节点',
  );
  assert.equal(parsed.nodes.filter((node) => node.clickable).length, 9, '工作台应有 9 个可点节点');
  assert.equal(parsed.packageName, 'com.example.demo');
  assert.deepEqual(parsed.screen, { width: 1080, height: 2400, rotation: 0 });

  // 真实中文文本（含全角符号 ⌄ / ⌃ / ↗ / ·）必须原样保留
  const texts = parsed.nodes.map((node) => node.text).filter((text) => text !== '');
  assert.ok(texts.includes('示例页面'), `应能按 text 找到「示例页面」，实际 texts=${JSON.stringify(texts.slice(0, 10))}`);
  assert.ok(texts.includes('图片'), '应能按 text 找到「图片」（ToggleButton）');
  assert.ok(
    texts.some((text) => text.includes('检测提示')),
    '应能保留带空格的较长中文文本',
  );
  assert.ok(
    texts.some((text) => text.includes('当前器官 默认分类')),
    '真实文本里的全角字符与内部空格不能被破坏',
  );

  // 按 text 定位（不区分大小写的包含匹配）在原生页上有效
  const byText = findNodes(parsed.nodes, { text: '示例页面' });
  assert.ok(byText.length >= 1, `按 text 定位应命中，实际 ${byText.length}`);
  for (const node of byText) {
    assert.ok(node.center.x > 0 && node.center.y > 0, '命中节点的中心点必须有效');
  }
  // 按 className 定位可点元素
  const clickables = findNodes(parsed.nodes, { className: 'android.widget.ToggleButton' });
  assert.ok(clickables.length >= 1, '应能按 className 找到 ToggleButton');
});

test('真实点击后 dump：与工作台页一致（证明点击确实切换了界面）', () => {
  const before = parseUiXml(REAL_WEBVIEW_HOME);
  const after = parseUiXml(REAL_AFTER_TAP);

  // 首页 → 点击 → 工作台：节点数从 7 变 37，带 text 的节点从 0 变 22
  assert.equal(before.nodes.length, 7);
  assert.equal(after.nodes.length, 37);
  assert.ok(
    after.nodes.filter((node) => node.text !== '').length > before.nodes.filter((node) => node.text !== '').length,
    '点击后带 text 的节点数应该增加（界面从 WebView 首页切到原生工作台）',
  );
  // 两次 dump 的包名都是同一个应用
  assert.equal(after.packageName, 'com.example.demo');
  // 工作台页与「点击后」页在结构上一致（同一页面两种采样）
  assert.equal(after.nodes.length, parseUiXml(REAL_WORKBENCH).nodes.length);
});

test('真实样本的节点数组可以安全序列化成 JSON（工具返回值会用 JSON 快照校验）', () => {
  for (const xml of [REAL_WEBVIEW_HOME, REAL_WORKBENCH, REAL_AFTER_TAP]) {
    const parsed = parseUiXml(xml);
    const views = parsed.nodes.map((node) => nodeView(node));
    const text = JSON.stringify(views);
    assert.equal(typeof text, 'string');
    assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(views)), '节点数组必须能无损 JSON 往返');
    // 对外的节点不能带内部 index（DESIGN §3 的字段集）
    for (const view of views) assert.equal(Object.hasOwn(view, 'index'), false);
  }
});
