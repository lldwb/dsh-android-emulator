/**
 * dsh-android-emulator — 随插件注册的 runtime skill。
 *
 * ## 为什么要有它
 *
 * 15 个 `android_*` 工具摆在那里，模型并不知道**什么时候该用哪一组**：先 `android_status`
 * 探环境？`avd_create` 还是直接 `emulator_start`？`ui_dump` 定位不到文本时该截图还是继续试？
 * 转译的包耗时能不能当性能？这些判断写进每个工具的 description 会重复且太长，所以按 DSH
 * 的技能机制单独注册一份：不加载只占一行 description，加载后模型才看到完整说明书。
 *
 * 从 1.3.0 起它还是**按需门控的触发开关**：工具默认不进模型工具表，加载本技能后从下一个
 * 模型步出现（见 `index.js` 的 `createToolGate`）。所以这份 skill 必须有强触发的
 * `description` / `whenToUse` —— 模型靠它们决定要不要加载。
 *
 * 注册途径是 `ctx.skills.register(...)`（运行时 skill，随插件装卸自动生效），不需要往文件
 * 系统里塞目录，也不需要用户手动安装。
 *
 * ## 正文为什么放在单独的 .md 文件里
 *
 * 正文里大量使用 markdown 的行内代码反引号。若把它写成 JS 模板字符串，每个反引号都必须
 * 转义——`dsh-desktop-control` 实测被这个坑咬了三次（漏一个就把模板字符串提前终止、
 * 整个插件加载失败）。改成读文件：正文可以像普通文档一样写，代码侧零转义。
 */

import { readFileSync } from 'node:fs';

/** skill 名（必须是 kebab-case，DSH 的 SKILL_NAME 规则；也用于门控匹配）。 */
export const SKILL_NAME = 'android-emulator';

/**
 * 一行摘要：进技能目录，模型靠它决定要不要加载。
 *
 * 触发词要具体（"启安卓模拟器 / 装 APK / 点界面 / 看 logcat / 截图验证"）——
 * 这是按需门控下模型发现这批工具的唯一入口。
 */
export const SKILL_DESCRIPTION =
  '在本机 Android 模拟器上完成「装包 → 操作 → 断言」闭环：起/停模拟器（会话专属 AVD，磁盘与实例上限保护）、'
  + '装 APK（含 ABI 预检与 ARM 转译判断）、点击/滑动/输入/按键、dump UI 树、截图、读 logcat 定位崩溃。'
  + '需要启安卓模拟器、装 APK、点界面、看 logcat、截图验证时加载。';

/** 何时该加载（比 description 更具体的使用触发条件）。 */
export const SKILL_WHEN_TO_USE =
  '当任务涉及安卓应用/设备：要启动或管理 Android 模拟器、安装 APK、操作应用界面（点击/滑动/输入/按键）、'
  + '用 UI 树或截图断言界面、读 logcat 定位崩溃时。'
  + '不涉及安卓设备/模拟器时不要加载——纯网页、桌面、后端任务用别的工具；'
  + '只是写安卓代码但不需要真跑起来看效果时，也不需要加载。';

/**
 * skill 正文（markdown，模型加载后才看到）。
 *
 * 读不到文件时回落到一段最小说明——宁可少说，也不能让插件加载失败。
 */
function loadContent() {
  try {
    return readFileSync(new URL('./skill-content.md', import.meta.url), 'utf8');
  } catch (error) {
    return [
      '# Android 模拟器（本机）',
      '',
      '用 `android_*` 工具操作本机 Android 模拟器：`android_status` 探环境 → `android_emulator_start`',
      '→ `android_apk_install` → `android_app_launch` → `android_ui_dump` / `android_ui_tap` /',
      '`android_screenshot` / `android_logcat` → `android_emulator_stop`。',
      '',
      '工具是按需的：加载本技能后从下一步出现，这轮调不到不要当成没这个能力。',
      '',
      `（完整说明书读取失败：${error instanceof Error ? error.message : String(error)}）`,
    ].join('\n');
  }
}

export const SKILL_CONTENT = loadContent();

/** 交给 `ctx.skills.register()` 的定义（`source` 必须显式给，DSH 会校验它是字符串）。 */
export const SKILL_DEFINITION = {
  name: SKILL_NAME,
  description: SKILL_DESCRIPTION,
  whenToUse: SKILL_WHEN_TO_USE,
  content: SKILL_CONTENT,
  source: 'runtime',
  invocation: { modelInvocable: true, userInvocable: true },
};
