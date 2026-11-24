# Android 模拟器（本机）

用 `android_*` 工具在本机 Android 模拟器上完成「装包 → 操作 → 断言」闭环：
起/停模拟器、装 APK、点/滑/输入、看 UI 树与截图、读 logcat 定位崩溃。

> **工具是按需加载的（1.3.0 起）**：15 个 `android_*` 工具平时**不在**工具表里
> （省掉每请求整包 schema）。你加载了本技能之后，它们会从**下一个模型步**开始出现。所以：
> - 加载后如果这一轮还调不到 `android_*`，**不要当成"没有这个能力"**，下一步再调；
> - resume / fork 后的会话若工具又不见了，重新加载一次本技能即可；
> - `minimal` 这类没有 `skill` 工具的模式不门控，工具始终可见。

## 0. 先探环境：`android_status`

**永远从这里开始**，不要一上来就 `avd_create` / `emulator_start`。

`android_status` 一次给全：`sdk{found,root,adb,emulator,avdmanager}`、`avds[]`（`kind` 区分
`session-pinned` / `template`）、`images[]`、当前 `device`、`translation`（ARM 转译能力）、
`acceleration`、本会话 `instances[]`、`instanceLimit{count,max}`、`avdDisk{...}`，
以及最该看的 **`suggestions[]`** —— 它直接写「下一步该做什么」。

- `ok:false, code:"NO_SDK"` → SDK 没找到：设 `ANDROID_HOME` 或配置里的 `sdkPath`。
- 没有设备 → 先确认有 AVD 与系统镜像，再 `android_emulator_start`。

## 1. 会话专属 AVD 与磁盘预算（先算账，再启动）

v1.2.0 起默认 `perSession: true`：**每个会话一台独立模拟器**，AVD 名形如
`<avdNamePrefix|avdName>--<sessionShort>`（例如 `dsh_android--9e1ca070`），状态（当前设备、
最近安装的包、进程归属）也按会话分区——A 会话停设备/装包不会影响 B。

- 同时运行的实例受 **`maxInstances`**（默认 `2`，钳制 1–8）限制；到上限时
  `android_emulator_start` 返回 `DEVICE_BUSY` 并列出当前占用者。**别靠重试冲过去**：
  先 `android_emulator_stop` 停掉本会话不用的实例，或让用户调大上限。
- **磁盘代价必须先算账**：每台会话 AVD 约 **4–6.5 GB**（含旧快照更多）+ 约 2 GB RAM +
  40–90 s 启动。`android_status.avdDisk` 给 `sessionAvdCount`（跨会话总量）/ `totalGb` /
  `freeDiskGb`；剩余 < 8 GB 时 `suggestions[]` 会提示清理。
- **用完就回收**：`android_emulator_stop { removeAvd: true }` 停下本会话实例并**删除本会话
  专属 AVD**（只删自己的，不碰别人的、也不碰基础模板）。设备已经停了也会照删。
- 需要特定镜像时可以先 `android_avd_create { name, image }`；不建也行，`android_emulator_start`
  会自动确保本会话专属 AVD 存在（返回的 `createdAvd` 表示这次新建了）。
- `android_emulator_start` 是**慢操作**（冷启动几十秒到几分钟）；不要因为没立刻返回就重试。

## 2. 装包：`android_apk_install`（装之前先看 ABI）

- 装前会做 **ABI 预检**：设备 ABI 与 APK 里的 `lib/<abi>/` 无交集时直接返回
  `ABI_MISMATCH`，**不会浪费一次必然失败的 `adb install`**。照着 `message` 的建议改包
  （含 `x86_64` / `arm64-v8a`），不要反复重试同一个包。
- 返回的 `abiKind` 区分：`native`（原生 ABI）/ `translated`（ARM 包走镜像内置
  `libndk_translation` 转译）/ `none`（纯 Java，与 ABI 无关）。
- ⚠️ **`translated` 时不要用耗时判断真机性能**：转译可用但明显慢，大计算（如 ONNX 推理）
  会偏慢。要测性能就用原生 ABI 的包。
- 32 位 ARM（`armeabi-v7a`-only）在官方模拟器上**跑不了**（无 32 位转译层），会被预检拦下。
- 装完用 `android_app_launch { package }` 启动（**默认等 1400 ms** 再返回：WebView/Capacitor
  冷启动 3–5 秒才渲染首屏，立刻截图会是白屏）；`android_app_stop { package }` 强停。

## 3. 操作界面：先 dump，再动手

```
android_ui_dump { clickableOnly?, filter?, maxNodes? }    → 屏幕尺寸、包名、节点树
android_ui_tap  { text | resourceId | contentDesc | x+y }  → 点元素中心 / 点坐标
android_ui_swipe{ x1,y1,x2,y2, durationMs? }               → 滑动/翻页/下拉
android_ui_input{ text }                                   → 输入 ASCII 文本
android_ui_key  { key }                                    → back/home/enter/menu/tab/…
android_ui_wait { text | resourceId | contentDesc, timeoutMs? } → 等元素出现
```

- **优先按 `text` / `resourceId` / `contentDesc` 点击**（插件内部先 dump 再取元素中心）；
  坐标点击对分辨率、滚动位置、横竖屏都敏感。节点上的 `center{x,y}` 可直接用于
  `android_ui_tap { x, y }`。
- `android_ui_tap` 找不到元素时返回 `ELEMENT_NOT_FOUND`——**先 `android_ui_dump` 看真实节点**，
  不要凭猜改选择器。
- `android_ui_wait` 超时**不是错误**：返回 `ok:true, found:false`，看 `found` 再决定下一步。
  等网络加载后的元素用它，比固定 sleep 稳。
- `android_ui_input` 只支持 **ASCII 可打印字符**（Android `input text` 的硬限制）：空格转
  `%s`、shell 元字符被过滤（`note` 里会报告），纯中文 → `BAD_ARGUMENT`。中文输入要换方案
  （剪贴板/输入法应用），别反复试同一个调用。
- 支持的按键：`back`、`home`、`enter`、`menu`、`tab`、`delete`、`escape`、`power`、
  `volume_up`、`volume_down`、`recent`。
- **WebView 页面常常 dump 不到文本**（真机实测：只剩 7 个容器节点、`text` 全空）：
  这时改用 `android_screenshot` + 坐标点击，别在文本定位上死磕。

## 4. 看一眼：`android_screenshot`

- 返回**绝对路径** `path`（+ `width`/`height`/`bytes`），直接交给 `read_image` 就能看界面。
  这是「操作到底生效了没」最直接的证据。
- `label` 只是文件名标签，用来区分多张截图（ASCII）。
- 断言前先截图或 dump，不要假设上一步一定生效。

## 5. 崩了？先 `android_logcat` 再猜

- `android_logcat { lines?, level?, tag?, package? }` 返回 `lines[]` +
  **`crashed` / `crashSummary`**：插件会自动识别 `FATAL EXCEPTION`、`AndroidRuntime`、
  `ANR in` 等崩溃信号，`crashSummary` 摘出关键那几行。
- 定位顺序：`crashed:true` → 看 `crashSummary` 的异常类与第一处业务栈帧 → 回到代码；
  `crashed:false` 而行为不对 → 用 `level:"E"` 或 `tag` 收窄。
- 不要在 `crashed:false` 时断定"没问题"——它只代表**没匹配到已知崩溃信号**。

## 6. 一条真实的闭环

```text
android_status                     → sdk.found、有没有在跑的实例、suggestions
android_emulator_start             → serial、sessionKey、bootedInMs、translation
android_apk_install { apk }        → package、matchedAbi、abiKind
android_app_launch { package }     → pid、activity
android_ui_dump                    → 节点树；找到目标元素的 resourceId/text
android_ui_tap { text: "登录" }    → tapped{x,y} + target
android_screenshot { label: "after-login" } → path → read_image 确认
android_logcat { package, lines: 100 }      → crashed / crashSummary
android_emulator_stop { removeAvd: true }   → 停设备并回收磁盘
```

## 7. 边界

- 工具**不抛异常**：失败一律 `ok:false` + `code` + 人话 `message`，照着 `code` 决定下一步
  （错误码表见 README）。`INTERNAL` 才是插件自身 bug。
- 沙箱/权限受限时起不了子进程 → `SPAWN_DENIED`：告诉用户放宽策略，不要重试。
- 本技能只覆盖**本机** Android 模拟器/真机（经 adb）；iOS、云真机不在这里。
