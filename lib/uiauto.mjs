/**
 * dsh-android-emulator — uiautomator XML 解析与元素查找（纯函数，无 I/O）。
 *
 * ## 解析真实 uiautomator 输出的三个坑
 *
 * 1. **不是 XML 解析器，是正则**。`uiautomator dump` 输出的 `<node … />` 全部
 *    自闭合（层级靠 `bounds` 嵌套表达，不靠 DOM 父子），所以按出现顺序扫开始
 *    标签就够了；不需要树，不能假设有合法 XML 头。
 * 2. **属性值里有转义实体**。中文文本、引号、换行都可能是 `&#10;` / `&quot;`
 *    这类实体；`&amp;` 必须**最后**反转义，否则 `&amp;lt;` 会被二次解析成 `<`。
 * 3. **`screen` 尺寸只能估算**。dump 里没有屏幕尺寸，只有节点的 `bounds`。
 *    这里取所有 bounds 的最大 x2/y2 作为估算（工具层再用 `wm size` 修正）。
 *
 * 对外（DESIGN §3）的节点字段是 `text/resourceId/contentDesc/className/
 * packageName/clickable/enabled/scrollable/bounds/center`；`index` 是内部字段，
 * 供日志与调试用，`nodeView()` 负责投影成对外形状。
 */

/** 所有 `<node …>` 开始标签。 */
const NODE_TAG_RE = /<node\b([^>]*?)\/?>/gi;
/** 属性 `name="value"`。 */
const ATTR_RE = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
/** `[x1,y1][x2,y2]`。 */
const BOUNDS_RE = /\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]\s*\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/;
/** `<hierarchy rotation="0">`。 */
const HIERARCHY_ROTATION_RE = /<hierarchy\b[^>]*\brotation\s*=\s*"([^"]*)"/i;

/** 数字字符引用安全解码（越界码点返回空串，不让一个坏实体毁掉整个 dump）。 */
function fromCodePoint(value) {
  try {
    return String.fromCodePoint(value);
  } catch {
    return '';
  }
}

/**
 * 反转义 XML 实体。
 *
 * 顺序很关键：数字引用 → 命名实体，`&amp;` 放最后（否则 `&amp;lt;` 变 `<`）。
 */
export function unescapeXml(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, dec) => fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 解析一个标签里的全部属性。 */
function parseAttributes(source) {
  const attributes = Object.create(null);
  ATTR_RE.lastIndex = 0;
  let match;
  while ((match = ATTR_RE.exec(source)) !== null) {
    attributes[match[1]] = match[2];
  }
  return attributes;
}

/** 解析 `bounds`；不合法返回 null。 */
export function parseBounds(value) {
  const match = BOUNDS_RE.exec(String(value ?? ''));
  if (match === null) return null;
  return {
    x1: Number.parseInt(match[1], 10),
    y1: Number.parseInt(match[2], 10),
    x2: Number.parseInt(match[3], 10),
    y2: Number.parseInt(match[4], 10),
  };
}

/** 中心点（四舍五入到整数像素；`-0` 折回 0，DSH 的 JSON 校验不接受 -0）。 */
function centerOf(bounds) {
  const x = Math.round((bounds.x1 + bounds.x2) / 2);
  const y = Math.round((bounds.y1 + bounds.y2) / 2);
  return { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y };
}

/**
 * 解析 uiautomator dump 的 XML。
 *
 * @param {string} xml `adb exec-out cat /sdcard/window_dump.xml` 的文本。
 * @returns {{ screen: { width: number, height: number, rotation: number }, packageName: string, nodes: Array<object> }}
 */
export function parseUiXml(xml) {
  const source = typeof xml === 'string' ? xml : '';
  const rotationMatch = HIERARCHY_ROTATION_RE.exec(source);
  const rotation = rotationMatch === null ? 0 : Number.parseInt(rotationMatch[1], 10) || 0;

  /** @type {Array<object>} */
  const nodes = [];
  let width = 0;
  let height = 0;
  let packageName = '';

  NODE_TAG_RE.lastIndex = 0;
  let match;
  while ((match = NODE_TAG_RE.exec(source)) !== null) {
    const attributes = parseAttributes(match[1]);
    const bounds = parseBounds(attributes.bounds);
    if (bounds !== null) {
      width = Math.max(width, bounds.x2);
      height = Math.max(height, bounds.y2);
    }
    const nodePackage = unescapeXml(attributes.package ?? '');
    if (packageName === '' && nodePackage !== '') packageName = nodePackage;

    nodes.push({
      index: nodes.length,
      text: unescapeXml(attributes.text ?? ''),
      resourceId: unescapeXml(attributes['resource-id'] ?? ''),
      contentDesc: unescapeXml(attributes['content-desc'] ?? ''),
      className: unescapeXml(attributes.class ?? ''),
      packageName: nodePackage,
      clickable: attributes.clickable === 'true',
      enabled: attributes.enabled === 'true',
      scrollable: attributes.scrollable === 'true',
      bounds: bounds ?? { x1: 0, y1: 0, x2: 0, y2: 0 },
      center: bounds === null ? { x: 0, y: 0 } : centerOf(bounds),
    });
  }

  return { screen: { width, height, rotation }, packageName, nodes };
}

/** 单个字段的匹配：`exact` 时相等，否则不区分大小写的包含。 */
function fieldMatches(value, needle, exact) {
  const haystack = String(value ?? '');
  const wanted = String(needle);
  if (exact === true) return haystack === wanted;
  return haystack.toLowerCase().includes(wanted.toLowerCase());
}

/**
 * 按条件查找节点（所有给定条件 AND 组合；没给条件返回空数组）。
 *
 * 与 DESIGN §3 的语义一致：`text` / `resourceId` / `contentDesc` 至少给一个，
 * 同时给多个时要求同一个节点全部满足。
 *
 * @param {Array<object>} nodes `parseUiXml().nodes`。
 * @param {{ text?: string, resourceId?: string, contentDesc?: string, className?: string, exact?: boolean }} [criteria]
 * @returns {Array<object>} 命中的节点（保持文档顺序）。
 */
export function findNodes(nodes, criteria = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const filters = [];
  if (typeof criteria.text === 'string' && criteria.text !== '') {
    filters.push((node) => fieldMatches(node.text, criteria.text, criteria.exact));
  }
  if (typeof criteria.resourceId === 'string' && criteria.resourceId !== '') {
    filters.push((node) => fieldMatches(node.resourceId, criteria.resourceId, criteria.exact));
  }
  if (typeof criteria.contentDesc === 'string' && criteria.contentDesc !== '') {
    filters.push((node) => fieldMatches(node.contentDesc, criteria.contentDesc, criteria.exact));
  }
  if (typeof criteria.className === 'string' && criteria.className !== '') {
    filters.push((node) => fieldMatches(node.className, criteria.className, criteria.exact));
  }
  if (filters.length === 0) return [];
  return list.filter((node) => filters.every((filter) => filter(node)));
}

/** 对外节点形状（DESIGN §3）：去掉内部 `index`。 */
export function nodeView(node) {
  return {
    text: String(node?.text ?? ''),
    resourceId: String(node?.resourceId ?? ''),
    contentDesc: String(node?.contentDesc ?? ''),
    className: String(node?.className ?? ''),
    packageName: String(node?.packageName ?? ''),
    clickable: node?.clickable === true,
    enabled: node?.enabled === true,
    scrollable: node?.scrollable === true,
    bounds: {
      x1: Number(node?.bounds?.x1 ?? 0),
      y1: Number(node?.bounds?.y1 ?? 0),
      x2: Number(node?.bounds?.x2 ?? 0),
      y2: Number(node?.bounds?.y2 ?? 0),
    },
    center: {
      x: Number(node?.center?.x ?? 0),
      y: Number(node?.center?.y ?? 0),
    },
  };
}

/** 对外节点的空值（结果构造器用）。 */
export function emptyNodeView() {
  return nodeView(null);
}

/**
 * WebView 降级提示。
 *
 * 2026-10-24 真机实测（Lead）：目标 APK 首页是 WebView，`uiautomator dump` 只能看到
 * 一个 `android.webkit.WebView` 容器节点、`text` 全为空。这时按 text 找元素是**不可
 * 能**成功的（不是插件 bug，是 uiautomator 看不到 WebView 内部 DOM），必须降级成
 * "截图 + 坐标点击"。所以 dump 成功时也要把这条提示写进 message —— 否则 agent 会
 * 反复试 text 定位。
 *
 * 返回空串表示不需要提示。判定保持保守：**有可点击文本就不提示**，避免把正常原生
 * 页面误判成 WebView。
 *
 * @param {{ nodes?: Array<object> }} parsed `parseUiXml()` 的结果。
 * @returns {string}
 */
export function webViewHint(parsed) {
  const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
  if (nodes.length === 0) return '';
  const hasClickableText = nodes.some((node) => node.clickable === true && (node.text !== '' || node.contentDesc !== ''));
  if (hasClickableText) return '';
  const hasWebView = nodes.some((node) => /webview|chromium/i.test(String(node.className ?? '')));
  if (hasWebView) {
    return '该页面是 WebView，uiautomator 看不到内部 DOM；请用 android_screenshot 看界面后用 android_ui_tap {x,y} 坐标点击。';
  }
  if (nodes.length <= 2) {
    return `界面上只 dump 到 ${nodes.length} 个节点，内容可能在 WebView 或自绘 View 里；请用 android_screenshot 看界面后用 android_ui_tap {x,y} 坐标点击。`;
  }
  return '';
}

/** 一行的简短描述（render / message 用）。 */
export function describeNode(node) {
  const parts = [`[${node.center.x},${node.center.y}]`];
  if (node.text !== '') parts.push(`text="${node.text.replace(/\s+/g, ' ').slice(0, 60)}"`);
  if (node.resourceId !== '') parts.push(`id=${node.resourceId}`);
  if (node.contentDesc !== '') parts.push(`desc="${node.contentDesc.replace(/\s+/g, ' ').slice(0, 40)}"`);
  if (node.className !== '') parts.push(node.className.split('.').pop() ?? '');
  if (node.clickable) parts.push('clickable');
  if (!node.enabled) parts.push('disabled');
  if (node.scrollable) parts.push('scrollable');
  return parts.join(' ');
}

/**
 * 解析 `wm size` 的输出。
 *
 * @param {string} stdout 形如 `Physical size: 1080x2400`（可能还有 `Override size: …`）。
 * @returns {{ width: number, height: number } | null}
 */
export function parseWmSize(stdout) {
  const source = typeof stdout === 'string' ? stdout : '';
  const matches = [...source.matchAll(/(\d+)\s*x\s*(\d+)/g)];
  if (matches.length === 0) return null;
  // 有多行时以最后一行的 Override 尺寸为准（那才是实际分辨率）。
  const last = matches[matches.length - 1];
  return { width: Number.parseInt(last[1], 10), height: Number.parseInt(last[2], 10) };
}
