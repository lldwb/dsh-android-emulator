/**
 * dsh-android-emulator — 插件入口（只做接线）。
 *
 * 职责严格限定为四件事，业务细节都在 `lib/` 里：
 *
 * 1. **归一化配置**。DESIGN §6 明确不声明 schemastery `Config`（零依赖：不 import
 *    任何 `@deepseek-ai/*`），所以 `cordis.patch.yml` 里那一行 `config` 是裸对象，
 *    在 `apply()` 里手写合并默认值。
 * 2. **构建 15 个工具定义**（8 个设备/应用 + 7 个界面交互）。
 * 3. **逐个 `ctx.effect(() => ctx.tools.register(tool, { when }), label)`**。用 effect 是为了
 *    插件卸载时自动反注册——Host 插件不清理会泄漏工具。
 * 3.5 **按需门控（1.3.0 起）**：15 个 `android_*` 工具默认**不进**模型工具表，加载本插件
 *    自带的 `android-emulator` skill 后从**下一步**才出现（`tools.register(def, { when })`）。
 *    理由：这 15 个工具的 schema 是整包里最大的一块，而安卓调试是"任务点名才用"的
 *    情境型能力，不该出现在每次请求里。没有 `skill` 工具的模式（minimal 等）fail-open，
 *    保持常驻；`onDemand: false` 可整体回到老行为。
 * 4. **注册一份随插件的 skill**（`ctx.skills.register`）：15 个工具摆在那里，模型并不知道
 *    何时该用哪一组、按什么顺序用、什么算做完——这些判断写在 skill 里，模型需要时才加载
 *    （不加载只占一行 description）。它同时是按需门控的触发开关。
 *
 * 导出的 `name` / `inject` / `apply` 是 Cordis 约定的形态；`inject: ['tools']`
 * 让插件在没有 tools 服务的 profile 里保持不激活，而不是直接抛错。
 */

import os from 'node:os';
import path from 'node:path';

import { SKILL_DEFINITION, SKILL_NAME } from './lib/skill.mjs';
import { buildDeviceTools } from './lib/tools/device.mjs';
import { buildInteractTools } from './lib/tools/interact.mjs';

/** Cordis 插件名（加载器诊断里显示这个名字）。 */
export const name = 'android-emulator';

/** 硬依赖 `tools` 服务：没有它这个插件没有存在意义。 */
export const inject = ['tools'];

/** 取配置里的字符串（去空白；非字符串视为未设置）。 */
function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 取配置里的数字并钳制到合理区间。 */
function asNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

/**
 * 归一化插件配置（DESIGN §6 的字段，全部可选）。
 *
 * v1.2.0 新增三个多会话相关字段：
 * - `perSession`（默认 true）：每会话独立模拟器；false = 退回 v1.1 的全局共享行为；
 * - `maxInstances`（默认 2，钳制 1..8）：同时运行的模拟器上限（DESIGN §7.3 磁盘预算）；
 * - `avdNamePrefix`（默认 ''）：会话专属 AVD 名前缀，空则用 `avdName`。
 *
 * v1.3.0 新增 `onDemand`（默认 true）：按需门控；false = 工具常驻（1.2.x 的老行为）。
 *
 * @param {unknown} config `cordis.patch.yml` 里该行的 config。
 * @returns {{ sdkPath: string, avdName: string, outputDir: string, bootTimeoutMs: number, emulatorArgs: string[], adbPath: string, emulatorPath: string, perSession: boolean, maxInstances: number, avdNamePrefix: string, onDemand: boolean }}
 */
export function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  const configuredOutput = asString(raw.outputDir);
  return {
    sdkPath: asString(raw.sdkPath),
    avdName: asString(raw.avdName) === '' ? 'dsh_android' : asString(raw.avdName),
    // 输出目录必须是绝对路径：截图路径直接交给 agent 的 read_image。
    outputDir: path.resolve(configuredOutput === '' ? path.join(os.tmpdir(), 'dsh-android-emulator') : configuredOutput),
    bootTimeoutMs: asNumber(raw.bootTimeoutMs, 10000, 900000, 240000),
    emulatorArgs: Array.isArray(raw.emulatorArgs)
      ? raw.emulatorArgs.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
      : [],
    adbPath: asString(raw.adbPath),
    emulatorPath: asString(raw.emulatorPath),
    perSession: raw.perSession !== false,
    maxInstances: Math.round(asNumber(raw.maxInstances, 1, 8, 2)),
    avdNamePrefix: asString(raw.avdNamePrefix),
    // 按需门控（1.3.0 起默认开）：15 个 android_* 工具默认不进模型工具表，模型加载本插件
    // 的 skill 后从下一步出现。设 false 回到「常驻」（工具永远可见），给不想要按需的人。
    onDemand: raw.onDemand !== false,
  };
}

/**
 * 构造「按需门控」判定：工具默认不进模型工具表，加载本插件自带 skill 后从下一步出现。
 *
 * 三个来源都算已激活：
 *  1. 模型用 `skill` 工具加载了 `SKILL_NAME`（观察 `tools/result`）；
 *  2. 用户 `/android-emulator` 斜杠调用（`session/event` 的 `skill-invocation`）；
 *  3. 会话历史里已经声明过本插件工具 —— resume / fork 后内存标记会丢，靠请求头兜底。
 *
 * **fail-open**：该 agent 看不到 `skill` 工具时（例如 minimal 模式）不门控 ——
 * 那些模式没有加载技能的入口，门控等于把工具永久藏起来。判据用
 * `ctx.tools.get('skill', agent)`（该 agent 自己 scope 的可见集），而不是
 * `ctx.get('skills')`（宿主平面看不到 preset 内注册的服务）。
 *
 * `when` 每步都会执行，所以这里只读状态：不注册、不做异步、不调工具。
 *
 * @param {object} ctx Cordis 上下文。
 * @param {string[]} toolNames 本插件的工具名（历史声明兜底用）。
 * @param {boolean} enabled 配置开关；false 时返回 undefined 表示常驻。
 * @returns {((context: { agent?: object }) => boolean) | undefined} `when` 判定。
 */
function createToolGate(ctx, toolNames, enabled) {
  if (!enabled) return undefined;

  /** 已加载过本插件 skill 的 agent。 */
  const marked = new WeakSet();

  ctx.on?.('tools/result', (exec, result) => {
    if (exec?.agent === undefined || exec.name !== 'skill' || result?.isError === true) return;
    const args = exec.arguments;
    if (args !== null && typeof args === 'object' && args.name === SKILL_NAME) marked.add(exec.agent);
  });

  ctx.on?.('session/event', (session, event) => {
    if (event?.type !== 'user/message') return;
    const source = event.data?.source;
    if (source?.kind !== 'skill-invocation' || source.name !== SKILL_NAME) return;
    const agent = ctx.get?.('agents')?.get?.(session?.id);
    if (agent?.session === session) marked.add(agent);
  });

  ctx.on?.('agent/disposed', ({ agent }) => marked.delete(agent));

  return ({ agent }) => {
    if (agent === undefined) return true;
    // 没有 skill 加载器的模式：不门控（保持常驻）。
    if (ctx.tools?.get?.('skill', agent) === undefined) return true;
    if (marked.has(agent)) return true;
    try {
      return agent.session?.requestHeader?.()?.tools?.some((tool) => toolNames.includes(tool.name)) === true;
    } catch {
      return false;
    }
  };
}

/**
 * 注册插件。
 *
 * @param {object} ctx Cordis 插件上下文（提供 `tools` 服务与 `effect`）。
 * @param {unknown} [config] 该行的 config（见 DESIGN §6）。
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config);
  const deps = { config: settings };
  const tools = [...buildDeviceTools(deps), ...buildInteractTools(deps)];

  // 按需门控：15 个工具默认不进模型工具表，加载本插件自带的 `android-emulator` skill 后
  // 从下一步出现。`onDemand: false` 或该模式没有 `skill` 工具时，判定恒真 = 老行为（常驻）。
  const gate = createToolGate(ctx, tools.map((tool) => tool.name), settings.onDemand);

  for (const tool of tools) {
    ctx.effect(
      () => ctx.tools.register(tool, gate === undefined ? {} : { when: gate }),
      `android-emulator: tool ${tool.name}`,
    );
  }

  // 随插件的 skill：让模型知道「何时用、按什么顺序、什么时候别用」。
  // skills 服务是可选的——没有它的 profile 里工具照常能用，只是少了这份说明书。
  ctx.inject(['skills'], (scoped) => {
    scoped.effect(() => scoped.skills.register(SKILL_DEFINITION), 'android-emulator: skill');
  });

  ctx.logger?.info?.(
    `android-emulator: 已注册 ${tools.length} 个工具 + 1 个 skill（${gate === undefined ? '常驻' : '按需：加载 skill 后出现'}；sdkPath=${settings.sdkPath === '' ? '自动发现' : settings.sdkPath}，outputDir=${settings.outputDir}）`,
  );
}
