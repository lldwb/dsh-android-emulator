#!/usr/bin/env node
/**
 * 真机端到端回归脚本（**不**纳入 `node --test` 的 glob）。
 *
 * 为什么单独放一个文件：它需要真实的 Android SDK + 一个能启动的 x86_64 AVD，跑一次要几分钟；
 * 而 `node --test` 必须离线全绿（README 里承诺「不因缺少模拟器/网络而失败」）。所以契约的
 * 端到端链路（DESIGN §8 第 3 条）作为这个可手动执行的脚本存在，交给 Lead 或人在真机上跑。
 *
 * 它同样用 mock ctx 装载插件（和单测同一套基础设施），因此顺带验证了 `index.js` 的接线：
 * 工具不是直接 import builder，而是走 `apply(ctx, config)` → `ctx.tools.register()`。
 *
 * 用法：
 *   node test/e2e-real.mjs --list                 # 只列工具与参数 schema 概要
 *   node test/e2e-real.mjs                        # 用已在运行的设备跑：status → dump → tap → screenshot
 *   node test/e2e-real.mjs --start --avd dsh_android
 *   node test/e2e-real.mjs --apk "E:\path\app-x86_64-debug.apk" --package com.example.demo
 *   node test/e2e-real.mjs --keep                 # 结束时不停模拟器（默认停下来省内存）
 *
 * 退出码：0 = 关键步骤全过；1 = 有步骤失败（每步的 code/message 都会打印）。
 */

import path from 'node:path';
import process from 'node:process';

import { TOOL_NAMES, loadPlugins } from './helpers/plugin.mjs';

/* ------------------------------------------------------------------ *
 * 参数解析（手写，零依赖）
 * ------------------------------------------------------------------ */

/**
 * 解析 `--key value` / `--flag` 形式的参数。
 *
 * @param {string[]} argv `process.argv.slice(2)`。
 * @returns {Record<string, string | boolean>} 参数表。
 */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));

/* ------------------------------------------------------------------ *
 * 输出小工具
 * ------------------------------------------------------------------ */

const RESET = '\u001b[0m';
const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';

/**
 * 把可能很长的值压成一行（打印用）。
 *
 * @param {unknown} value 任意值。
 * @param {number} [max] 最大长度。
 * @returns {string} 一行文本。
 */
function brief(value, max = 220) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  text = text.replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 一步的执行结果。 */
const results = [];

/**
 * 执行一个步骤并记录结果（失败不中断，继续跑后面的步骤）。
 *
 * @param {string} label 步骤名（通常是工具名）。
 * @param {() => Promise<object>} action 执行体，返回工具输出。
 * @param {{ critical?: boolean, skip?: string }} [options] `critical` 失败即停；`skip` 给出跳过原因。
 * @returns {Promise<object | undefined>} 工具输出。
 */
async function step(label, action, options = {}) {
  if (options.skip !== undefined) {
    results.push({ label, status: 'skip', detail: options.skip });
    console.log(`${YELLOW}○${RESET} ${label} ${DIM}跳过：${options.skip}${RESET}`);
    return undefined;
  }
  if (!TOOL_NAMES.includes(label.replace(/\s.*$/u, ''))) {
    // 非工具步骤（如「加载插件」）也允许。
  }
  const startedAt = Date.now();
  try {
    const value = await action();
    const elapsed = Date.now() - startedAt;
    const ok = value?.ok !== false;
    const status = ok ? 'pass' : 'fail';
    results.push({ label, status, code: value?.code, message: value?.message, elapsed, value });
    const colour = ok ? GREEN : RED;
    console.log(`${colour}${ok ? '✔' : '✘'}${RESET} ${label} ${DIM}(${elapsed}ms, code=${value?.code ?? 'n/a'})${RESET}`);
    if (value?.message) console.log(`   ${DIM}${brief(value.message, 300)}${RESET}`);
    // 除了三件套，把其余字段压一行打印（这就是「每步结果」）。
    const extras = Object.fromEntries(
      Object.entries(value ?? {}).filter(([key]) => !['ok', 'code', 'message'].includes(key)),
    );
    if (Object.keys(extras).length > 0) console.log(`   ${DIM}${brief(extras, 500)}${RESET}`);
    if (!ok && options.critical) {
      throw new Error(`关键步骤失败：${label} → ${value?.code}: ${value?.message}`);
    }
    return value;
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    results.push({ label, status: 'error', detail: error?.message ?? String(error), elapsed });
    console.log(`${RED}✘${RESET} ${label} ${DIM}(${elapsed}ms) 抛异常${RESET}`);
    console.log(`   ${RED}${brief(error?.stack ?? error?.message ?? error, 600)}${RESET}`);
    if (options.critical) throw error;
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/**
 * 打印 15 个工具的名字与参数概要。
 *
 * @param {Map<string, object>} definitions 工具表。
 * @returns {void}
 */
function listTools(definitions) {
  console.log(`工具数：${definitions.size}（契约要求 ${TOOL_NAMES.length}）`);
  for (const name of TOOL_NAMES) {
    const definition = definitions.get(name);
    if (definition === undefined) {
      console.log(`${RED}✘ ${name} 未注册${RESET}`);
      continue;
    }
    const properties = definition.parameters?.properties ?? {};
    const required = new Set(definition.parameters?.required ?? []);
    const params = Object.entries(properties)
      .map(([key, schema]) => `${key}${required.has(key) ? '' : '?'}:${schema?.type ?? 'any'}`)
      .join(', ');
    console.log(`${GREEN}✔${RESET} ${name} ${DIM}(${params})${RESET}`);
  }
  const extra = [...definitions.keys()].filter((name) => !TOOL_NAMES.includes(name));
  if (extra.length > 0) console.log(`${YELLOW}契约外工具：${extra.join(', ')}${RESET}`);
}

/**
 * 端到端主流程。
 *
 * @returns {Promise<number>} 退出码。
 */
async function main() {
  const config = {};
  if (typeof args.sdk === 'string') config.sdkPath = args.sdk;
  if (typeof args.avd === 'string') config.avdName = args.avd;
  if (typeof args['boot-timeout'] === 'string') config.bootTimeoutMs = Number(args['boot-timeout']);
  if (typeof args['output-dir'] === 'string') config.outputDir = path.resolve(args['output-dir']);

  console.log(`${DIM}装载插件（config=${brief(config)}）…${RESET}`);
  const { definitions, disposeAll } = await loadPlugins(config);
  console.log('');

  if (args.list) {
    listTools(definitions);
    disposeAll();
    return 0;
  }

  /**
   * 取工具并执行。
   *
   * @param {string} name 工具名。
   * @param {object} toolArgs 参数。
   * @returns {Promise<object>} 输出。
   */
  const call = async (name, toolArgs = {}) => {
    const definition = definitions.get(name);
    if (definition === undefined) throw new Error(`工具未注册：${name}`);
    return definition.execute(toolArgs, {});
  };

  /* 1) status：环境自检（SDK / AVD / 镜像 / 加速 / 设备） */
  const status = await step('android_status', () => call('android_status'), { critical: true });
  const sdkFound = status?.sdk?.found === true;
  const runningDevice = status?.device?.serial;

  if (!sdkFound) {
    console.log(`\n${RED}没有发现 Android SDK，跳过真机链路。${RESET}`);
    console.log(`${DIM}提示：用 --sdk <路径> 显式指定，或设置 ANDROID_HOME。${RESET}`);
    disposeAll();
    return 1;
  }

  /* 2) 启动模拟器（未运行且给了 --start 时） */
  let serial = runningDevice;
  if (serial === undefined || serial === '') {
    if (args.start) {
      const startArgs = { headless: args.headful !== true };
      if (typeof args.avd === 'string') startArgs.avd = args.avd;
      const started = await step('android_emulator_start', () => call('android_emulator_start', startArgs), {
        critical: true,
      });
      serial = started?.serial;
    } else {
      await step('android_emulator_start', async () => ({}), {
        skip: '没有在运行的设备；加 --start 让脚本自己起模拟器',
      });
    }
  } else {
    await step('android_emulator_start', async () => ({}), { skip: `设备已在运行：${serial}` });
  }

  /* 3) 安装 APK（可选） */
  if (typeof args.apk === 'string') {
    await step('android_apk_install', () =>
      call('android_apk_install', {
        apk: path.resolve(String(args.apk)),
        ...(serial === undefined ? {} : { serial }),
      }),
    );
  } else {
    await step('android_apk_install', async () => ({}), { skip: '未提供 --apk' });
  }

  /* 4) 启动应用（可选） */
  const packageName = typeof args.package === 'string' ? args.package : undefined;
  if (packageName !== undefined) {
    await step('android_app_launch', () =>
      call('android_app_launch', {
        package: packageName,
        ...(typeof args.activity === 'string' ? { activity: args.activity } : {}),
        stopFirst: true,
        ...(serial === undefined ? {} : { serial }),
      }),
    );
  } else {
    await step('android_app_launch', async () => ({}), { skip: '未提供 --package' });
  }

  /* 5) dump UI 树 */
  const dump = await step('android_ui_dump', () => call('android_ui_dump', { maxNodes: 40 }), { critical: true });
  const nodes = Array.isArray(dump?.nodes) ? dump.nodes : [];

  /* 6) 点击：优先显式指定，否则点第一个可点节点 */
  /** @type {object | undefined} */
  let tapArgs;
  if (typeof args['tap-id'] === 'string') tapArgs = { resourceId: String(args['tap-id']) };
  else if (typeof args['tap-text'] === 'string') tapArgs = { text: String(args['tap-text']) };
  else {
    const clickable = nodes.find((node) => node.clickable === true && node.enabled === true);
    if (clickable !== undefined) {
      const target = clickable.resourceId || clickable.text || clickable.contentDesc || clickable.className;
      tapArgs =
        clickable.resourceId
          ? { resourceId: clickable.resourceId }
          : clickable.text
            ? { text: clickable.text }
            : clickable.contentDesc
              ? { contentDesc: clickable.contentDesc }
              : { x: clickable.center.x, y: clickable.center.y };
      console.log(`${DIM}自动选择可点节点：${brief(target, 120)}${RESET}`);
    }
  }
  if (tapArgs !== undefined) {
    await step('android_ui_tap', () => call('android_ui_tap', { ...tapArgs, waitMs: 800 }));
  } else {
    await step('android_ui_tap', async () => ({}), { skip: '界面里没有可点节点（clickable=true）' });
  }

  /* 7) 点击后再 dump 一次，证明界面变化（证据：节点文本 / 数量） */
  await step('android_ui_dump（点击后）', () => call('android_ui_dump', { maxNodes: 40 }));

  /* 8) 截图 + 用 read_image 可读的绝对路径证明 */
  const shot = await step('android_screenshot', () => call('android_screenshot', { label: 'e2e' }), {
    critical: true,
  });
  if (shot?.path) console.log(`\n${GREEN}截图绝对路径（可交给 read_image）：${RESET}${shot.path}`);
  const again = await step('android_screenshot（第二次）', () =>
    call('android_screenshot', { label: 'e2e-2' }),
  );
  if (shot?.path && again?.path && shot.bytes > 0 && again?.bytes > 0) {
    console.log(`${GREEN}两次截图都非空：${shot.bytes} bytes / ${again.bytes} bytes${RESET}`);
  }

  /* 9) logcat（崩溃检测） */
  await step('android_logcat', () => call('android_logcat', { lines: 50 }));

  /* 10) 收尾：停模拟器（除非 --keep） */
  if (args.keep !== true && serial !== undefined) {
    await step('android_emulator_stop', () => call('android_emulator_stop', { serial }));
  } else {
    await step('android_emulator_stop', async () => ({}), { skip: '--keep：保留模拟器运行' });
  }

  disposeAll();

  /* 汇总 */
  const failed = results.filter((entry) => entry.status === 'fail' || entry.status === 'error');
  const passed = results.filter((entry) => entry.status === 'pass');
  const skipped = results.filter((entry) => entry.status === 'skip');
  console.log('\n================ 汇总 ================');
  console.log(`通过 ${passed.length} · 失败 ${failed.length} · 跳过 ${skipped.length}`);
  if (failed.length > 0) {
    for (const entry of failed) {
      console.log(`${RED}✘ ${entry.label}${RESET} ${entry.code ?? ''} ${brief(entry.message ?? entry.detail, 300)}`);
    }
    return 1;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`${RED}端到端脚本异常：${RESET}`, error);
    process.exitCode = 1;
  });
