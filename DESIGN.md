# dsh-android-emulator — 设计与接口契约（冻结版 v1）

> 本文件是并行开发的**唯一契约**。实现、测试、文档都以此为准；改接口先改这里并通知队友。
> 发布前可精简并入 README，但 `contract` 部分必须在 README 里保留。

## 1. 目标

给 DeepSeek Harness 增加一个 **Android 模拟器测试插件**：agent 能在开发安卓应用时
自己启动模拟器、安装 APK、像用户一样点击/滑动/输入，并看到界面（截图 / UI 树）与日志，
从而形成「改代码 → 装包 → 操作 → 断言」的闭环。

形态：**Host 插件**（无 UI 半）。零运行时依赖（不 import `@deepseek-ai/*`，不装 `node_modules`），
因此 `install_bundle` 不会有 pendingBuilds，也不需要 approvedBuilds。

## 2. 关键环境事实（2026-10-24 实测，本机）

| 事实 | 值 |
|---|---|
| Android SDK | `%LOCALAPPDATA%\Android\Sdk`（`ANDROID_HOME` 未设，必须能自动发现） |
| JDK | `<JDK 21 安装路径>`（avatar/sdkmanager 需要 JAVA_HOME） |
| 主机 CPU | AMD Ryzen AI 9 H 365 · 30.8 GB RAM · Hyper-V 已启用 |
| 加速 | x86_64 主机 → **只能用 x86_64 系统镜像 + WHPX**；arm64 镜像在 x86 主机上不可用 |
| 目标 APK | `<被测应用>.apk`（86 MB，包名 `com.example.demo`） |
| 目标 APK 的 ABI | `arm64-v8a` / `armeabi-v7a`。**2026-10-24 复测修正**：初版断言"在 x86_64 模拟器上装不了"是**错的**——实测**能装能跑**（见下一行），因为镜像自带 ARM64 转译层 |
| 镜像 ARM 转译（实测） | `ro.dalvik.vm.native.bridge=libndk_translation.so`、`ro.ndk_translation.version=0.2.3`、`ro.enable.native.bridge.exec=1`、`ro.dalvik.vm.isa.arm64=x86_64`、`abilist=x86_64,arm64-v8a`、**`abilist32` 为空**、`/system/lib64/libndk_translation.so` 3.6 MB + 一整套 proxy 库 |
| ARM64 APK 实测 | 原 APK（82 MB，arm64+armv7）`adb install` **Success 2.6 s**，`primaryCpuAbi=arm64-v8a`；启动 `Status: ok / COLD`；截图 613,952 B 完整渲染首页；logcat `nativeloader … library_path=…/lib/arm64-v8a`；无 FATAL |
| 32 位 ARM | **不可用**：官方镜像生态只有 `x86_64` / `arm64-v8a`（无 32 位 x86、无 armeabi-v7a 镜像），故 `armeabi-v7a`-only APK 无法在官方模拟器运行。不要承诺支持 |
| DSH 权限 | 插件在 Host 进程内 `spawn` 子进程；当前会话 `danger-full-access`，但受限模式下会 EPERM |

## 3. 工具集（15 个，前缀 `android_`）

所有工具的输出对象**第一个三件套固定**：`ok: boolean`、`code: string`、`message: string`。
失败不抛异常，返回 `ok:false` + 机器可读 `code` + 人话 `message`（agent 据此决定下一步）。
`code` 为 `"OK"` 表示成功。

| 工具 | 参数 | 输出（除三件套外的字段） |
|---|---|---|
| `android_status` | `{}` | `sdk{found,root,adb,emulator,avdmanager,sdkmanager}`、`avds[{name,target,abi,path,kind}]`（`kind`: `session-pinned` / `template` / `other`）、`images[{package,api,tag,abi}]`、`device{serial,state,booted,avd,abis[]}`、`translation{...}`、`acceleration{ok,kind,raw}`、`sessionKey`、`instances[{sessionKey,serial,avd,pid,booted,lastPackage}]`、`instanceLimit{count,max}`、`avdDisk{sessionAvdCount,totalGb,freeDiskGb}`、`suggestions[]` |
| `android_avd_create` | `name?`、`image?`、`device?`、`force?` | `avd`、`image`、`created`、`command[]` |
| `android_emulator_start` | `avd?`、`headless?`(默认 true)、`cold?`、`timeoutMs?`、`port?` | `serial`、`avd`、`pid`、`bootedInMs`、`logFile`、`translation{...}`、`sessionKey`、`createdAvd`(是否为本会话新建了专属 AVD) |
| `android_emulator_stop` | `serial?`、`all?`(默认 false；true=停止**本会话**全部)、`removeAvd?`(默认 false；true=同时删除本会话专属 AVD) | `serial`、`stopped`、`removedAvd`(被删除的 AVD 名，未删为空串) |
| `android_apk_install` | `apk`(必填)、`serial?`、`grantPermissions?`(默认 true)、`reinstall?`(默认 true) | `package`、`versionName`、`versionCode`、`abis[]`、`deviceAbis[]`、`matchedAbi`、`abiKind`(`"native"` / `"translated"` / `"none"`)、`translation{bridge,version,enabled,kind,arm64,arm32,abilist64[],abilist32[]}`、`installedInMs`、`tips[]` |
| `android_app_launch` | `package?`、`activity?`、`serial?`、`stopFirst?`、`settleMs?`(默认 1400，0=立刻返回) | `package`、`activity`、`pid` |
| `android_app_stop` | `package`(必填)、`serial?` | `package` |
| `android_ui_dump` | `serial?`、`maxNodes?`(默认 80)、`clickableOnly?`、`filter?` | `screen{width,height,rotation}`、`nodeCount`、`package`、`nodes[{text,resourceId,contentDesc,className,packageName,clickable,enabled,scrollable,bounds{x1,y1,x2,y2},center{x,y}}]` |
| `android_ui_tap` | `x?`、`y?`、`text?`、`resourceId?`、`contentDesc?`、`index?`、`serial?`、`waitMs?`(默认 0) | `tapped{x,y}`、`target{text,resourceId,className,bounds}` |
| `android_ui_swipe` | `x1`、`y1`、`x2`、`y2`、`durationMs?`(默认 300)、`serial?` | `from{x,y}`、`to{x,y}`、`durationMs` |
| `android_ui_input` | `text`(必填)、`serial?`、`clear?` | `sent`、`asciiOnly`、`note` |
| `android_ui_key` | `key`(必填，见 §7)、`serial?` | `key`、`keycode` |
| `android_ui_wait` | `text?`、`resourceId?`、`contentDesc?`、`timeoutMs?`(默认 10000)、`intervalMs?`(默认 500)、`serial?` | `found`、`waitedMs`、`node{...}` |
| `android_screenshot` | `serial?`、`label?` | `path`、`width`、`height`、`bytes` |
| `android_logcat` | `serial?`、`lines?`(默认 200)、`level?`、`tag?`、`package?` | `lines[]`、`crashed`、`crashSummary` |

约束：
- `android_ui_tap` 二选一：给 `x`+`y` 走坐标；否则必须给 `text`/`resourceId`/`contentDesc` 之一，先 dump 再按元素中心点击。找不到 → `code:"ELEMENT_NOT_FOUND"`。
- 所有工具接受可选 `serial`；省略时用模块级「当前设备」。没有运行时 `code:"DEVICE_NOT_RUNNING"`。
- `android_ui_wait` 超时**不报错**：`ok:true, found:false`，`message` 说明等不到什么。

## 4. 错误码（`code` 枚举，冻结）

`OK`、`NO_SDK`、`NO_ADB`、`NO_EMULATOR`、`NO_AVD_MANAGER`、`NO_AVD`、`NO_IMAGE`、`AVD_CREATE_FAILED`、
`DEVICE_NOT_RUNNING`、`DEVICE_BUSY`、`MULTIPLE_DEVICES`、`BOOT_TIMEOUT`、`EMULATOR_START_FAILED`、
`INSTALL_FAILED`、`ABI_MISMATCH`、`APK_NOT_FOUND`、`APK_UNREADABLE`、`APP_NOT_FOUND`、`LAUNCH_FAILED`、
`ELEMENT_NOT_FOUND`、`BAD_ARGUMENT`、`SPAWN_DENIED`、`TIMEOUT`、`ADB_FAILED`、`UI_DUMP_FAILED`、`INTERNAL`

## 5. 模块划分与边界（写作用域）

```
<插件目录>\
  package.json          # 清单（plugin-impl）
  cordis.patch.yml      # insert 一行 id: android-emulator（plugin-impl）
  index.js              # 仅接线：发现配置 → 构建工具 → ctx.effect 注册（plugin-impl）
  lib/
    schema.mjs          # objectSchema/prop/text/renderResult/renderJson、结果构造（plugin-impl）
    exec.mjs            # run/runBuffer/which/spawn 错误归一（plugin-impl）
    sdk.mjs             # discoverSdk/listAvds/listSystemImages/accelCheck/apkAbis/deviceAbis（plugin-impl）
    adb.mjs             # adb 封装（devices/resolveSerial/shell/install/launch/screencap/dumpUi/input/logcat）
    emulator.mjs        # 启动/停止模拟器进程（detached）
    uiauto.mjs          # uiautomator XML → 节点数组；findNodes（plugin-impl）
    state.mjs           # 模块级当前设备/进程表（plugin-impl）
    tools/device.mjs    # android_status/avd_create/emulator_start/emulator_stop/apk_install/app_launch/app_stop/logcat
    tools/interact.mjs  # android_ui_dump/tap/swipe/input/key/wait/screenshot
  locale/{zh,en}.json   # 卡片标题/描述（plugin-impl）
  icon.svg              # 原始图标（plugin-impl）
  README.md / CHANGELOG.md / .gitignore   # plugin-qa
  test/**               # plugin-qa
```

**写作用域互斥**：`plugin-impl` 拥有 `package.json / cordis.patch.yml / index.js / lib/** / locale/** / icon.svg`；
`plugin-qa` 拥有 `test/** / README.md / CHANGELOG.md / .gitignore`；Lead 拥有 `DESIGN.md` 与最终 `package.json` 的 version 字段。
谁都不改别人的文件；需要对方改，发消息。

### 5.1 核心内部契约（plugin-impl 必须按此签名实现，qa 按此写测试）

```js
// lib/exec.mjs — 永不抛异常（除编程错误）
run(file, args, opts?) => Promise<{ code:number|null, stdout:string, stderr:string, timedOut:boolean, error?:{code:string,message:string} }>
  // opts: { timeoutMs?:number=15000, input?:string, env?:object, cwd?:string }
runBuffer(file, args, opts?) => Promise<{ code, stdout:Buffer, stderr:string, timedOut:boolean, error? }>
which(name, opts?) => Promise<string|null>   // Windows 补 .exe/.bat，查 PATH + opts.extraDirs

// lib/sdk.mjs
discoverSdk(config) => Promise<{ found, root, adb, emulator, avdmanager, sdkmanager, problems:string[] }>
listAvds(sdk) => Promise<Array<{ name, path, target, abi, device }>>
listSystemImages(sdk) => Promise<Array<{ package, api, tag, abi, path }>>
accelCheck(sdk) => Promise<{ ok:boolean, kind:string, raw:string }>
apkAbis(apkPath) => Promise<string[]>              // 读 zip 中央目录，取 lib/<abi>/ 去重
deviceAbis(adb, serial) => Promise<string[]>       // ro.product.cpu.abilist → ro.product.cpu.abi

// lib/adb.mjs
adbDevices(adb) => Promise<Array<{ serial, state }>>
resolveSerial(adb, wanted) => Promise<string>       // 抛 {code:'DEVICE_NOT_RUNNING'|'MULTIPLE_DEVICES'} —— 由工具层转结果
adbShell(adb, serial, argv:string[], opts?) => Promise<{code,stdout,stderr}>
waitForBoot(adb, serial, timeoutMs) => Promise<boolean>
installApk(adb, serial, apk, {grant,reinstall}) => Promise<{code,stdout,stderr}>
launchApp(adb, serial, pkg, activity?) => Promise<{code,stdout,stderr,pid}>
screencap(adb, serial) => Promise<Buffer>
dumpUi(adb, serial) => Promise<string>             // XML 文本
logcat(adb, serial, n) => Promise<string[]>

// lib/uiauto.mjs（纯函数，易测）
parseUiXml(xml) => { screen:{width,height,rotation}, packageName, nodes:[{
  index, text, resourceId, contentDesc, className, packageName,
  clickable, enabled, scrollable, bounds:{x1,y1,x2,y2}, center:{x,y} }] }
findNodes(nodes, { text, resourceId, contentDesc, className, exact? }) => nodes[]
```

**返回值校验红线**：每个工具 `output.schema` 的 `properties` 必须**恰好**覆盖返回对象的全部键
（`additionalProperties:false` 下多一个键就 `tool returned invalid output`），`required` 覆盖所有
非可选字段，且 `execute` 的每个分支（成功/每个失败码）都必须满足。

## 6. 配置（零依赖，手写归一化，不声明 `Config`）

`cordis.patch.yml` 里行 config 可写；`apply(ctx, config)` 内自行合并默认值：

```yaml
sdkPath: '%LOCALAPPDATA%\Android\Sdk'   # 省略则自动发现
avdName: 'dsh_android'                   # 基础 AVD 名（perSession 时是模板来源）
outputDir: ''                            # 省略 → <tmp>/dsh-android-emulator
bootTimeoutMs: 240000
emulatorArgs: []                         # 额外 emulator 参数
adbPath: ''                              # 覆盖
emulatorPath: ''                         # 覆盖
perSession: true                         # true=每会话独立模拟器（默认，见 §7.2）；false=全部会话共享一台（v1.1 行为）
maxInstances: 2                          # perSession 时同时运行的模拟器上限
avdNamePrefix: ''                        # 会话专属 AVD 名前缀；空则用 avdName
```

自动发现顺序：`config.sdkPath` → `%ANDROID_HOME%` → `%ANDROID_SDK_ROOT%` →
`%LOCALAPPDATA%\Android\Sdk` → `%USERPROFILE%\Android\Sdk` → `%USERPROFILE%\AppData\Local\Android\Sdk` → `C:\Android\Sdk`。
取第一个含 `platform-tools\adb.exe` 的目录。

> 2026-10-24 勘误（plugin-qa 实测发现）：初版漏了 `%USERPROFILE%\Android\Sdk`，而本机 SDK 正在那里
> （`%LOCALAPPDATA%\Android\Sdk`）→ 默认配置下 `discoverSdk({})` 返回 `found:false`，`android_status` 报 `NO_SDK`。
> 该候选必须补上，否则真机验收必须先手工配 `sdkPath`。

## 7. 行为约定

- **启动**：`emulator -avd <name> -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot-save [-no-snapshot] [-port N]`，
  `spawn(detached:true, stdio:['ignore', fd, fd])` → `unref()`；日志写 `<outputDir>/emulator-<avd>.log`。
  然后轮询 `getprop sys.boot_completed` 到 `1`（间隔 2s）。超时 kill 进程并返回 `BOOT_TIMEOUT`。
- **停止**：`adb -s <serial> emu kill`，轮询 `adb devices` 直到消失（最多 30s），再兜底 kill 记录的 pid。
- **安装前 ABI 预检**：`deviceAbis ∩ apkAbis` 为空 → 直接 `ABI_MISMATCH`，不调用 adb install。
  `message` 必须写明设备 ABI、APK ABI，并按 §7.1 给出针对性的下一步。
- **AbiKind 判定**（`android_apk_install.abiKind`）：`matchedAbi` 属于设备**原生** ABI
  （`x86_64` / `x86`）→ `"native"`；`matchedAbi` 是 `arm64-v8a` / `armeabi-v7a` 且设备有转译层 →
  `"translated"`；纯 Java APK（无 native 库）→ `"none"`。

### 7.1 ARM / 转译层（v1.1.0 新增）

- **能力探测**：`translation` 对象由 `ro.dalvik.vm.native.bridge`、`ro.ndk_translation.version`、
  `ro.enable.native.bridge.exec`、`ro.dalvik.vm.isa.arm64`、`ro.dalvik.vm.isa.arm`、
  `ro.product.cpu.abilist64`、`ro.product.cpu.abilist32` 合成：
  ```js
  { bridge, version, enabled, kind, arm64, arm32, abilist64: [], abilist32: [] }
  // kind: "ndk-translation" | "houdini" | "native" | "none"
  // arm64/arm32: 设备能否运行该位宽的 ARM 库（原生或转译）
  ```
  探测失败不得影响主流程（返回 `kind:"none"` 的空对象，`message` 里注明探测失败）。
- **`kind` 判定**：bridge 含 `ndk_translation` → `"ndk-translation"`；含 `houdini` → `"houdini"`；
  bridge 为空但 abilist 含 arm* → `"native"`（ARM 真机）；否则 `"none"`。
- **`arm64` / `arm32`**：`abilist64`/`abilist32` 或 `abilist` 含 `arm64-v8a` / `armeabi-v7a`。
  实测本机镜像：`arm64=true, arm32=false`（`abilist32` 为空）。
- **安装到 `abiKind:"translated"` 时**，`tips` 与 `message` 必须包含性能提醒：
  「该 APK 通过 ARM 转译（`libndk_translation` 0.2.3）运行：功能可用，但性能低于原生；
  **不要用转译下的耗时判断真机性能**，大计算（如 ONNX 推理）可能明显变慢。」
- **`ABI_MISMATCH` 的 message 分情况**：
  - APK 含 `arm64-v8a` 但设备不匹配 → 提示重建含 `x86_64` 的版本，或换带转译层的镜像；
  - APK 只有 `armeabi-v7a`（32 位）且 `translation.arm32 === false` → 明确说明
    「官方 Android Emulator 已无 32 位 ARM 转译层/镜像（abilist32 为空），
    32 位 ARM APK 无法在官方模拟器运行；请改用含 arm64-v8a 或 x86_64 的包」；
  - 不要笼统只说"重建 x86_64"。
- **⚠️ `nativeBridge` 无法通过命令行控制（2026-10-24 实测，曾误写进契约，已删除）**：
  `emulator -prop ro.dalvik.vm.native.bridge=0` 会被直接忽略，emulator 明确告警
  `unexpected '-prop' value (...), only 'qemu.*' properties are supported`。
  实测对照：新建 AVD 带该 `-prop` 启动后，`getprop ro.dalvik.vm.native.bridge` 仍是
  `libndk_translation.so`、`abilist` 仍含 `arm64-v8a`，与不传参数的 AVD **完全一致**。
  所以：**转译层由系统镜像决定，插件只探测、不控制**。`android_emulator_start`/`android_status`/
  `apk_install` 只返回 `translation` 探测值；要改变转译能力只能换镜像（或改 system.img 的 build.prop，
  需 `-writable-system`，不推荐）。**不要给用户一个假装能用的开关。**
- **性能提示**：`android_emulator_start` / `android_apk_install` 在 `abiKind:"translated"` 或
  `translation.kind !== "native"` 时，`message` 末尾附一句转译性能说明。
- **点击**：`adb -s <s> shell input tap <x> <y>`。按元素点击时 dump → findNodes 取第一个 → 中心点。
- **文本**：`input text` 只支持 ASCII 可打印字符。空格转 `%s`；过滤 shell 元字符
  （`' " \` $ \ & | ; < > ( ) * ? ~ # !`）并在 `note` 里报告被过滤字符；纯非 ASCII → `ok:false, code:"BAD_ARGUMENT"`，
  message 说明 Android `input text` 不支持非 ASCII，建议改用坐标点击输入法或先复制到剪贴板。
- **键位映射**：`back→4, home→3, enter→66, menu→82, tab→61, delete→67, escape→111, power→26, volume_up→24, volume_down→25, recent→187`。
- **截图**：`exec-out screencap -p` 取 Buffer；PNG 头解析宽高（IHDR 字节 16..24）；写 `<outputDir>/shot-<ts>.png`。
- **logcat**：`logcat -d -t <n>`，可加 `-s <tag>`；`crashed` 只认**真正的崩溃信号**：
  `FATAL EXCEPTION`、`Fatal signal`、`ANR in `、`has died`、或 `E AndroidRuntime` 且同行含 `Exception`。
  **禁止只看 `AndroidRuntime` 子串**——实测误报：应用正常启动/退出时会打
  `D AndroidRuntime: Shutting down VM`（debug 级别），把它当崩溃会让 agent 误判"应用坏了"。
  判定为崩溃时 `crashSummary` 只摘录命中的行（最多 20 行），不要把整段 logcat 塞进去。
- **首屏等待**：`android_app_launch` 成功后默认先等 `settleMs`（默认 1400 ms）再返回。理由（实测）：
  Capacitor/WebView 冷启动要 3–5 s 才渲染，launch 后立刻 `android_screenshot` 会拿到**白屏 PNG**
  （有效但全白），agent 会误判应用异常。message 里必须提示"若截图仍白屏，等 2–3 秒再截一次"。
- 所有对外路径用**绝对路径**（agent 的 read_image 需要）。
- 模块级状态集中在 `lib/state.mjs`，用函数读写，方便测试注入；**从 v1.2.0 起按会话分区**（见 §7.2）。

### 7.2 多会话隔离（v1.2.0 新增）

**问题**：DSH 的一个 Host 进程里可以同时开多个会话，而插件模块是**单实例**（模块级状态）。
v1.1 的状态是全局的（`let current` / `Map processes` / `lastPackage`），所以两个会话会互相干扰：
A 启动的设备会被 B 的 screenshot/tap 直接操作、A 装的包会被 B 的 `app_launch` 默认启动、
A 调 `emulator_stop` 会停掉 B 正在用的设备。

**会话标识**：工具 `execute(args, exec)` 的 `exec.agent?.id` 就是 SessionId
（dsh 的 `Agent` 接口即 `{ readonly id: SessionId }`，见 `packages/core/agent/src/types.ts`）。
`sessionKey = exec.agent?.id ?? 'shared-default'`（无 agent 上下文 → 共享槽，兼容脚本直调）。

**状态分区**：`lib/state.mjs` 全部改为按 sessionKey 索引：
- `getCurrent(key)` / `setCurrent(key, patch)` / `clearCurrent(key)`
- `rememberPackage(key, pkg)` / `getLastPackage(key)`
- 进程表仍按 serial 索引，但每条记录带 `sessionKey`（用于归属判定与 `instances` 展示）

**设备隔离（`perSession: true`，默认）**：
1. `android_emulator_start` 先查**本会话**的 current 设备是否仍在线 → 在线则复用（`createdAvd:false`）。
2. 否则确保**本会话专属 AVD** 存在：名字 `<avdNamePrefix|avdName>--<sessionShort>`，
   `sessionShort` = sessionKey 清洗（非 `[A-Za-z0-9_-]` → `_`）后前 8 字符；**但截断点落在
   分隔符上时必须改取可辨识段** —— 真实 dsh SessionId 是 `session-<uuid>`，前 8 字符恒为
   `session-`，直接用会让所有会话撞成同一个 AVD 名（多会话隔离彻底失效）。实现见
   `lib/state.mjs#sessionShort`：按分隔符切段、剥掉 `session`/`agent` 等通用词、取第一段
   （`session-9e1ca070-…` → `9e1ca070`），没有可辨识段时用 8 位哈希兜底。不存在则用
   `avdmanager create avd` 从同一 system-image + 同一 device 配置创建（`createdAvd:true`）。
3. 端口：从 5554 起按 slot 分配（`5554 + 2*slot`），被占则顺延；启动前用 `adb devices` 校验。
4. **实例上限**：同时运行的模拟器数 ≥ `maxInstances`（默认 2）→ 返回 `DEVICE_BUSY`，
   message 列出当前占用者（sessionKey 前 8 字符 + serial）并给下一步（停别的会话 / 调大 maxInstances）。
5. `android_emulator_stop` **只停本会话**的设备。给了 `serial` 但它属于别的会话 → `DEVICE_BUSY`
   并说明归属（**不静默停别人的设备**）。`all:true` 也只停本会话的全部。
6. `perSession: false` → 退回 v1.1 的共享行为（状态仍按会话分区，但只有 `shared-default` 槽被使用）。

**绝不静默跨会话操作**：任何工具在「显式给了 serial、但该 serial 不属于本会话」时，
必须返回 `DEVICE_BUSY` 并说明归属，而不是直接操作。

### 7.3 磁盘预算与回收（v1.2.0 实测）

每台模拟器的真实磁盘占用远大于 system image 本身（2026-10-26 实测，单 AVD 6.52 GB）：

```
userdata-qemu.img.qcow2        3.93 GB   ← data partition 6GB 的 qcow2，随安装/运行增长
snapshots/default_boot/ram.img 2.50 GB   ← 快照 RAM 镜像（firstboot.saveToLocalSnapshot=yes）
```

因此：

- **会话 AVD 启动一律加 `-no-snapshot`**（在 `-no-snapshot-save` 之外）：不需要快照加速
  （冷启动 40–75 s 可接受），避免每台多出 ~2.5 GB 的 `ram.img`。
- `maxInstances` 默认 2 是硬保护：两台 ≈ 8–13 GB；不要调到 8 以上除非磁盘充裕。
- `android_emulator_stop { removeAvd: true }` 删除**本会话**专属 AVD（释放 4–6 GB）。
  设备已经停止时同样生效（早退分支也必须执行删除，否则「先 stop 再 stop{removeAvd}」回收不了磁盘）。
- `android_status.avdDisk` 暴露 `{ sessionAvdCount, totalGb, freeDiskGb }`；
  `freeDiskGb < 8` 时 `suggestions[]` 必须给一条清理建议。
- `android_emulator_start` 在磁盘余量 < 8 GB 时**不失败**，只在 message 尾部附警示（`ok` 仍 true）。
- 手工清理：`~/.android/avd/` 下形如 `<prefix>--<sessionShort>.avd` 的目录即会话 AVD。

## 8. 验收标准（端到端，Lead 执行）

1. `node --test` 全绿，且测试**镜像运行时两道校验**（schema 子集 + 返回值）。
2. `devkit_sandbox_*`：装进 headless 沙箱 → `compose` 看到行 → `run` 真实调用 `android_status` 与 `android_ui_dump`，
   输出不是 `tool returned invalid output`。
3. 真机链路：启动 AVD（x86_64）→ 用插件装**目标 APK** → `android_app_launch` 成功 →
   `android_screenshot` 得到非空 PNG（`read_image` 能看到界面）→ `android_ui_dump` 列出节点 →
   `android_ui_tap` 点一个节点 → 截图界面发生变化。
   **v1.1.0 追加**：同一链路要跑**两份 APK**——含 `x86_64` 的重建版（`abiKind:"native"`）与
   **原始 arm-only 版**（`abiKind:"translated"`），两者都必须能启动并截图；后者 `translation.kind`
   必须是 `"ndk-translation"`、`matchedAbi` 必须是 `arm64-v8a`。
4. `android_status` 必须能报告 `translation`（本机实测：`bridge=libndk_translation.so`、
   `version=0.2.3`、`arm64=true`、`arm32=false`）。
5. **多会话隔离（v1.2.0 追加）**：用两个不同的 `exec.agent.id` 各调一遍 `android_status` /
   `android_emulator_start`，断言 (a) 两边 `sessionKey` 不同；(b) 自己的 `serial` 只出现在自己的
   `instances` 里；(c) 用一个会话的 serial 在另一个会话里调 `android_screenshot` 得到 `DEVICE_BUSY`；
   (d) 实例数达 `maxInstances` 后 `android_emulator_start` 返回 `DEVICE_BUSY`。
6. 仓库：**公开（MIT）**，`gh repo view --json visibility` = `PUBLIC`；`git status` 无 ahead/behind。
7. 版本：`package.json` 的 `version` 首次提交为 `1.0.0`；之后任何改动升版并在同一次提交。

## 9. 明确不做

- 不做 UI 设置页（零依赖省掉 schemastery；配置走 patch）。
- 不做中文文本输入（Android `input text` 无此能力；不引入 ADBKeyboard）。
- **同一会话内一次一台**；跨会话可以并行，但受 `perSession` 与 `maxInstances` 约束（见 §7.2）。
  不在单个会话里做多设备编排——多设备矩阵是下一层的事，v1.x 不做。
- **不自己塞 ARM 转译层**（v1.1.0 结论）：官方 `x86_64` 系统镜像**已内置** Google 的
  `libndk_translation`（arm64 转译），插件只负责**探测/报告/利用**，不往镜像里注入 .so。
- **不支持 32 位 ARM（`armeabi-v7a`-only）**：官方镜像生态没有 32 位转译层，也没有可在 x86_64
  主机运行的 armeabi-v7a 系统镜像。插件对这类 APK 明确报 `ABI_MISMATCH` 并解释原因，
  不尝试 houdini/libnb 等第三方提取方案（授权与稳定性都不可控）。
- 不做 APK 重打包/重签名（如需 x86_64 原生性能版，由应用侧用 gradle 重建）。
