/**
 * dsh-android-emulator — 插件入口（只做接线）。
 *
 * 职责严格限定为三件事，业务细节都在 `lib/` 里：
 *
 * 1. **归一化配置**。DESIGN §6 明确不声明 schemastery `Config`（零依赖：不 import
 *    任何 `@deepseek-ai/*`），所以 `cordis.patch.yml` 里那一行 `config` 是裸对象，
 *    在 `apply()` 里手写合并默认值。
 * 2. **构建 15 个工具定义**（8 个设备/应用 + 7 个界面交互）。
 * 3. **逐个 `ctx.effect(() => ctx.tools.register(tool), label)`**。用 effect 是为了
 *    插件卸载时自动反注册——Host 插件不清理会泄漏工具。
 *
 * 导出的 `name` / `inject` / `apply` 是 Cordis 约定的形态；`inject: ['tools']`
 * 让插件在没有 tools 服务的 profile 里保持不激活，而不是直接抛错。
 */

import os from 'node:os';
import path from 'node:path';

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
 * @param {unknown} config `cordis.patch.yml` 里该行的 config。
 * @returns {{ sdkPath: string, avdName: string, outputDir: string, bootTimeoutMs: number, emulatorArgs: string[], adbPath: string, emulatorPath: string }}
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

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `android-emulator: tool ${tool.name}`);
  }

  ctx.logger?.info?.(
    `android-emulator: 已注册 ${tools.length} 个工具（sdkPath=${settings.sdkPath === '' ? '自动发现' : settings.sdkPath}，outputDir=${settings.outputDir}）`,
  );
}
