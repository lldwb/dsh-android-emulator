# 变更日志

本项目的所有重要变更都记录在这里。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.2] - 2026-10-25

### 变更

- **开源（MIT）**：仓库改为 public，`license` 由 `UNLICENSED` 改为 `MIT`，新增 `LICENSE` 文件。
- **开源前脱敏**：移除本机绝对路径与用户名（改为 `%LOCALAPPDATA%` / `%USERPROFILE%` / `<插件目录>` 等占位）；
  将示例应用相关的包名与应用名替换为通用的 `com.example.demo` / 「示例应用」；去掉其它插件名引用。
  **测试 fixture 的 XML 结构完全不变**（节点数 / bounds / 中文 UTF-8 / 实体转义），135 个测试仍全绿。
- 无功能变化。

### 说明

- 公开仓库包含完整的 v1.1.1 功能代码。为彻底移除历史中的本机路径与真实邮箱，开源时把提交历史
  重建为单个初始提交；版本演进记录见本文件的各版本条目。
- README 中的真机实测数据（截图字节数、节点数、耗时）保留，它们是本机实测原始值。

## [1.1.1] - 2026-10-24

### 测试

- 补 4 条 `tool-output` 契约守护测试（186 行）：`translation` 在**每个工具的每个 code 分支**
  都必须是完整 8 字段（非 `{}`、非 `undefined`、`kind` ∈ `ndk-translation/houdini/native/none`）；
  成功分支是非空真实形态、失败分支是合法空值；`translation` 可无损 JSON 往返。
  防的是 `additionalProperties:false` 下最容易复发的坑——把嵌套字段写成可选、或失败分支忘了填，
  运行时才表现为 `tool returned invalid output`。
- 测试总数 131 → **135**。无行为变化。

## [1.1.0] - 2026-10-24

### 新增

- **ARM 转译层探测**：`android_status` 与 `android_emulator_start` 新增
  `translation{bridge, version, enabled, kind, arm64, arm32, abilist64[], abilist32[]}`。
  `kind` 区分 `ndk-translation`（Google `libndk_translation`）/ `houdini` / `native`（ARM 真机）/
  `none`；`arm64` / `arm32` 表示设备**能否运行**该位宽的 ARM 库（原生或转译）。
  探测失败不影响主流程（返回 `kind:"none"` 的空对象并在 `message` 里注明），
  具体原因（例如 adb 不可用）另见 `sdk.problems`。
- **`abiKind` 区分**：`android_apk_install` 新增 `abiKind`（`"native"` / `"translated"` / `"none"`）
  与 `translation`——一眼看出这次安装是原生执行、**通过 ARM 转译执行**，还是纯 Java 无关 ABI。
- **32 位 ARM 的明确诊断**：`armeabi-v7a`-only 的 APK 会在安装前返回 `ABI_MISMATCH`，`message`
  说明「官方 Android Emulator 已无 32 位 ARM 转译层/镜像（`abilist32` 为空），32 位 ARM APK 无法在
  官方模拟器运行」，并给出「改用含 `arm64-v8a` / `x86_64` 的包」等替代方案——
  不再笼统只说"重建 x86_64"。

### 说明

- **转译层不可由插件控制**：实测 `emulator -prop ro.dalvik.vm.native.bridge=0` 会被忽略
  （`unexpected '-prop' value (...), only 'qemu.*' properties are supported`），启动后属性与不传时
  完全一致。所以 `android_emulator_start` / `android_status` / `android_apk_install` 只**探测并报告**
  `translation`，不提供开关参数；要改变转译能力只能换系统镜像。

### 变更

- **修正 v1.0.0 的错误结论**：v1.0.0 断言「arm-only 的 APK 在 x86_64 模拟器上装不了」，实测是**错的**。
  Android 11+ 的 `google_apis` x86_64 镜像自带 Google `libndk_translation`（0.2.3），
  原始 82 MB arm-only APK 能装（2.6 s）、能启动、能截图。`ABI_MISMATCH` 的判定与措辞随之重做，
  分「含 arm64 但设备无 arm64 能力」/「只有 32 位 ARM」/「其它」三种情况给出针对性建议。
- 通过 ARM 转译安装时，`message` 与 `tips` 附带性能提醒：
  「功能可用，但性能低于原生；**不要用转译下的耗时判断真机性能**，大计算（如 ONNX 推理）可能明显变慢」。

### 文档

- README 新增 **「测试 ARM 的 APK」** 专节：结论先行表、本机实测数据（bridge/version/abilist/
  安装 2.6 s / `primaryCpuAbi=arm64-v8a` / 截图 613,952 B / logcat `nativeloader … lib/arm64-v8a`）、
  `translation` 与 `abiKind` 读法、转译性能警告、32 位 ARM 不支持的替代方案，
  以及「为什么不能关掉转译」的实测记录（`-prop ro.*` 不被支持）。
- README 工具表同步 `android_status.translation`、`android_emulator_start.translation`、
  `android_apk_install.abiKind` + `translation`。
- 移除「x86 主机上必须用 x86_64 的 APK」这一过时警告，改为按 ABI 能测/不能测的对照表。

## [1.0.0] - 2026-10-24

### 新增

- **15 个 `android_*` 工具**，让 agent 在安卓应用开发中自己完成「装包 → 操作 → 断言」闭环：
  - 环境与设备：`android_status`、`android_avd_create`、`android_emulator_start`、
    `android_emulator_stop`
  - 应用生命周期：`android_apk_install`、`android_app_launch`、`android_app_stop`
  - 界面交互：`android_ui_dump`、`android_ui_tap`、`android_ui_swipe`、`android_ui_input`、
    `android_ui_key`、`android_ui_wait`
  - 观测：`android_screenshot`、`android_logcat`
- **Android SDK 自动发现**：`config.sdkPath` → `ANDROID_HOME` → `ANDROID_SDK_ROOT` →
  `%LOCALAPPDATA%\Android\Sdk` → `%USERPROFILE%\AppData\Local\Android\Sdk` → `C:\Android\Sdk`，
  取第一个含 `platform-tools\adb.exe` 的目录。
- **统一结果契约**：每个工具的输出以 `ok` / `code` / `message` 三件套开头；失败返回
  `ok:false` + 机器可读 `code`（26 个枚举值）+ 人话 `message`，不抛异常，agent 可据此决定下一步。
- **安装前 ABI 预检**：设备 ABI 与 APK 内 `lib/<abi>/` 无交集时直接返回 `ABI_MISMATCH`，
  不浪费一次必然失败的 `adb install`；`message` 给出重建 APK 的下一步建议。
- **无 UI 树解析**：`uiautomator dump` 的 XML → 结构化节点（bounds、中心点、文本反转义），
  支持按 `text` / `resourceId` / `contentDesc` 定位后按元素中心点击。
- **截图落盘**：`exec-out screencap -p` 取 PNG Buffer，按 IHDR 解析宽高，写入绝对路径供
  `read_image` 直接消费；写盘后回读 PNG magic 再确认一次（防编码层污染）。
- **首屏等待**：`android_app_launch` 启动成功后默认等 1400 ms（`settleMs` 可调）再返回——
  WebView/Capacitor 冷启动要 3–5 秒才渲染首屏，立刻截图会得到白屏。
- **WebView 页面优雅降级**：真机实测 WebView 首页的 DOM 对 uiautomator 不可见（只能 dump 到
  7 个容器节点、`text` 全空）。`android_ui_dump` 会主动提示、`android_ui_tap` 的
  `ELEMENT_NOT_FOUND` 会给出「用 `android_screenshot` + 坐标点击」的降级路径，而不是让 agent
  反复试文本定位。
- **优雅降级**：没有 SDK / 没有可用设备时，所有工具返回结构化失败
  （`NO_SDK` / `NO_ADB` / `DEVICE_NOT_RUNNING` 等）而不是抛异常或挂死。
- **零运行时依赖**：不 import `@deepseek-ai/*`、不需要 `node_modules`，安装后立即可用，
  `install_bundle` 不会产生 pendingBuilds。

[1.1.2]: https://github.com/lldwb/dsh-android-emulator/releases/tag/v1.1.2
[1.1.1]: https://github.com/lldwb/dsh-android-emulator/releases/tag/v1.1.1
[1.1.0]: https://github.com/lldwb/dsh-android-emulator/releases/tag/v1.1.0
[1.0.0]: https://github.com/lldwb/dsh-android-emulator/releases/tag/v1.0.0
