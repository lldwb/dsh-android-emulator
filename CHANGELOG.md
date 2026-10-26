# 变更日志

本项目的所有重要变更都记录在这里。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.2.1] - 2026-10-26

### 修复（多会话并发场景下的四个真实缺陷，均由双会话真机回归暴露）

- **`emulator_start` 并发时会认领别人的设备**：等设备出现用的是「启动后新出现的 `emulator-*`」，
  两个会话同时启动时，B 的设备可能先出现，A 会把它当成自己的。端口是自己分配的，
  所以改成**用已知 port 反推 serial**（`emulator-<port>`），彻底消除互认可能。
- **端口选择会撞车**：`taken` 集合只统计 `state === 'device'` 的设备，漏掉 **offline /
  unauthorized** 的——它们一样占着端口。实测两个会话两次都选中 `5554`。
  现在按 `adb devices` 的**全量**列表 + 进程表排重。
- **启动器退出被误报成启动失败**：Windows 上 `emulator.exe` 会拉起
  `qemu-system-*-headless.exe` 后自己先退出，旧判据只看启动器 pid，于是设备明明还在
  offline 启动中却报 `EMULATOR_START_FAILED`，agent 重试 → 撞端口 → 雪崩。
  现在加 45 s 宽限期：宽限期过了、启动器仍不在、设备也没出现，才判失败。
- **`emulator_stop` 对「从未存在过」的 serial 伪造成功**：以前对任意不存在的 serial 都走幂等
  分支，报「已停止本会话 1 台模拟器」，而实际什么都没停（该过程还绕过了归属判定：
  启动超时会清掉进程记录，归属信息随之丢失）。现在区分两种情况——
  「本会话记录过但设备已消失」= 幂等成功；「从没见过这个 serial」= `DEVICE_NOT_RUNNING`。

### 验证

- 单测 184/184 全绿（新增 1 条幽灵 serial 的回归用例 + 1 条双会话命名用例）。
- 双会话真机回归（两个 `agent.id`、真实 SDK/emulator/adb）：**命名隔离、sessionKey 分区、
  跨会话拒绝（不再伪造成功）、各自 `removeAvd` 只删自己的 AVD —— 全部 PASS**。
- ⚠️ 「两台同时在线并互相操作」这一段**未能在本机完成**：回归途中本机 WHPX 进入故障态
  （`emulator -accel-check` 仍报 usable，但**模板 AVD 用纯命令行也启动不到 `boot_completed`**，
  日志停在 `WHPX ... operational`、androidboot 参数块重复 3 次）。同一台模板 AVD
  在此之前（同一天 14:16/14:22 两次沙箱回归）都只用 69–70 s 就 boot 完成，
  说明是宿主机虚拟化状态问题，不是插件缺陷。恢复需重启 Windows。

## [1.2.0] - 2026-10-26

### 变更（**默认行为变化**）

- **多会话隔离（默认开启）**：一个 Host 进程里的多个会话现在**各自拥有一台模拟器和独立的运行状态**。
  A 会话装包、点击、`android_emulator_stop` 都不再影响 B 会话。
  - 会话标识来自工具 `execute(args, exec)` 的 `exec.agent.id`（即 SessionId），
    无 agent 上下文时落到 `'shared-default'` 共享槽；
  - 所有状态（当前设备、最近安装的包、进程归属）按 `sessionKey` 分区；
  - `android_emulator_start` 会确保**本会话专属 AVD** `<avdNamePrefix|avdName>--<sessionShort>` 存在
    （`sessionShort` = sessionKey 清洗后前 8 字符），用独立端口 `5554 + 2*slot` 启动，
    返回值新增 `sessionKey` 与 `createdAvd`（是否本次新建）；
  - `android_status` 返回值新增 `sessionKey`、`instances[{sessionKey,serial,avd,pid,booted,lastPackage}]`、
    `instanceLimit{count,max}`、`avdDisk{sessionAvdCount,totalGb,freeDiskGb}`；
    `avds[].kind` 区分 `session-pinned`（会话专属）与 `template`（基础模板）。
  - 想恢复 v1.1 的共享行为：`perSession: false`（见下方「说明」）。
- **`DEVICE_BUSY` 跨会话守卫**：**绝不静默跨会话操作**。显式传了别的会话的 `serial` 时，
  所有设备类工具返回 `ok:false, code:"DEVICE_BUSY"` 并说明归属；
  同时运行的模拟器数达到 `maxInstances`（默认 2）时，`android_emulator_start` 也返回 `DEVICE_BUSY`
  并列出当前占用者与下一步。
- **`android_emulator_stop.all` 语义变化**：从「所有设备」改为「**本会话**的全部设备」。
- **会话 AVD 不带快照**：会话专属 AVD 统一以 `-no-snapshot` 启动，每台省下约 2.5 GB 的
  `snapshots/default_boot/ram.img`；代价是每次走无快照冷启动（实测 38.2 s）。

### 新增

- **三个配置项**：`perSession`（默认 `true`）、`maxInstances`（默认 `2`，钳制 1–8）、
  `avdNamePrefix`（会话 AVD 名前缀，空则用 `avdName`）。
- **`android_emulator_stop.removeAvd`**（默认 `false`）：停在设备后**删除本会话**的专属 AVD，
  释放约 4–6.5 GB 磁盘。只删自己的，不碰别人的、也不碰基础模板。
- **磁盘可视化**：`android_status.avdDisk`（`sessionAvdCount` / `totalGb` / `freeDiskGb`），
  剩余磁盘 < 8 GB 时 `suggestions[]` 会提示清理。

### 修复

- **会话专属 AVD 名会撞车（严重，本版本自身缺陷，真机回归抓到）**：真实 dsh 的 SessionId 形如
  `session-<uuid>`，旧实现直接取前 8 字符，得到的永远是通用前缀 `session-` ——
  **所有会话映射到同一个 AVD 名**，「一个会话一台模拟器」实际退化成「所有会话抢同一台」。
  现在截断点落在分隔符上时改取**可辨识段**：剥掉 `session` / `agent` 等通用词后取 UUID 第一段
  （如 `session-9e1ca070-…` → `9e1ca070`），仍拿不到则用 8 位哈希兜底。
  *升级须知*：旧版本已创建的 `dsh_android--session-.avd` 会成为孤儿（新版本用新名字），
  可用 `avdmanager delete avd -n "dsh_android--session-"` 删除，回收约 3.7 GB。
- **`android_emulator_stop { removeAvd: true }` 在设备已停止时不再是无操作**：以前早退分支
  直接返回「没有运行中的模拟器，不需要停止」，AVD 根本不删 —— 于是「先 stop、再
  `stop { removeAvd: true }`」第二步永远回收不了磁盘。现在早退分支同样执行删除，
  并在 message 里报告删除结果与释放空间。
- **分支契约补齐**：per-session 专属 AVD 创建路径新增的 `NO_AVD_MANAGER` / `NO_IMAGE` /
  `AVD_CREATE_FAILED`（`android_emulator_start`）与 `DEVICE_BUSY` / `INTERNAL`
  （`android_emulator_stop`）已写进测试分支表；fail-open 时 `instanceLimit.max`
  不再退化成 `0`（按配置兜成 1–8）。测试从 176/182 → **183/183 全绿**。
- **磁盘行的措辞不再误导**：`avdDisk.sessionAvdCount` 统计的是**跨会话**的全部插件会话 AVD
  （磁盘是共享的，预算必须按总量算），但文本行以前写作「会话 AVD N 个」，容易被读成
  「本会话还有 N 个」。现在明确标注「（跨会话，不只本会话）」，与 `schema` 里的描述一致。

### 说明

- **为什么要默认开**：v1.1 及以前状态是模块级单例，多个会话共享同一台设备——A 启动的设备会被
  B 的 screenshot/tap 直接操作、A 装的包会被 B 的 `app_launch` 默认启动、A 的 `emulator_stop`
  会停掉 B 正在用的设备。这与「一个会话一个隔离环境」的直觉相反，也是本轮修复的问题。
- **资源代价必须先算账**：每台会话模拟器实测约 **4–6.5 GB 磁盘**（含旧快照则更多）
  + **2 GB RAM** + **40–90 s 启动**。`maxInstances` 默认 2，两台就是约 8–13 GB 磁盘 + 4 GB RAM。
  磁盘紧张时调 `maxInstances: 1`，并定期用 `removeAvd: true` 清理。
- **要旧行为**：`perSession: false`。状态仍按 `sessionKey` 分区，但只有 `shared-default` 槽被使用，
  且**会话之间会互相干扰**（A 的点击/装包/停设备会作用在 B 的设备上）。只在愿意接受干扰时用。

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

[1.2.0]: https://github.com/lldwb/dsh-android-emulator/releases/tag/v1.2.0
[1.1.2]: https://github.com/lldwb/dsh-android-emulator/releases/tag/v1.1.2
[1.1.1]: https://github.com/lldwb/dsh-android-emulator/releases/tag/v1.1.1
[1.1.0]: https://github.com/lldwb/dsh-android-emulator/releases/tag/v1.1.0
[1.0.0]: https://github.com/lldwb/dsh-android-emulator/releases/tag/v1.0.0
