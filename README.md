# dsh-android-emulator

> 给 DeepSeek Harness 装上一台**可以被 agent 自己操作的 Android 模拟器**：启动 AVD、安装 APK、
> 像用户一样点击/滑动/输入，并把界面（UI 树 + 截图）和日志回传给模型。

## 这个插件解决什么问题

安卓应用开发的验证环路天然是「改代码 → 装包 → 在设备上点开 → 看界面/日志 → 再改」。
没有这个插件时，agent 写完代码只能停在这里：它看不到界面、点不了按钮、也不知道应用起来后
崩没崩，于是只能让你手动跑一遍再回来描述现象——一个需要五六轮来回的反馈环路。

装上这个插件后，agent 手里就有一组 `android_*` 工具，能自己完成闭环：

```
android_status            # 环境自检：SDK / AVD / 镜像 / 加速 / 当前设备
android_avd_create        # 没有可用的 AVD 就建一个
android_emulator_start    # 起模拟器（默认 headless）
android_apk_install       # 装 APK（装之前先做 ABI 预检，避免必然失败的 install）
android_app_launch        # 启动应用
android_ui_dump           # 拿到结构化 UI 树（文本/资源 id/可点性/坐标）
android_ui_tap            # 按元素点（资源 id / 文本 / content-desc）或按坐标点
android_screenshot        # 截图落盘到绝对路径，交给 read_image 直接看
android_logcat            # 抓日志、判断是否崩溃
```

失败**不抛异常**：每个工具都返回 `ok` / `code` / `message` 三件套，agent 可以据此决定下一步
（换镜像、建 AVD、重建 APK、换选择器……），而不是被一个异常打断整轮。

形态是 **Host 插件**（无 UI 半），**零运行时依赖**：不 `import @deepseek-ai/*`、不需要
`node_modules`，安装即用。

## 前置条件

| 依赖 | 要求 | 说明 |
|---|---|---|
| Node.js | ≥ 22 | 插件与测试都用 ESM，`node --test` 跑测试 |
| Android SDK | 含 `platform-tools` / `emulator` / `system-images` | 未设 `ANDROID_HOME` 也能自动发现，见下 |
| Android 系统镜像 | **x86_64** | 目标 AVD 用 `system-images;android-<api>;<tag>;x86_64` |
| JDK | 21（`sdkmanager` / `avdmanager` 需要 `JAVA_HOME`） | 本机实测 `<JDK 21 安装路径>` |
| 硬件加速 | Hyper-V / WHPX 已启用 | 没加速时模拟器启动极慢甚至失败 |

### SDK 自动发现顺序

按顺序取**第一个含 `platform-tools\adb.exe`** 的目录，全都不存在就返回 `NO_SDK` 并在
`android_status` 的 `sdk.problems` 里说明找过哪些位置：

1. 配置项 `sdkPath`（`cordis.patch.yml` 里的 `config`）
2. 环境变量 `ANDROID_HOME`
3. 环境变量 `ANDROID_SDK_ROOT`
4. `%LOCALAPPDATA%\Android\Sdk`
5. `%USERPROFILE%\AppData\Local\Android\Sdk`
6. `C:\Android\Sdk`

> 本机实测：SDK 在 `%LOCALAPPDATA%\Android\Sdk` 且 `ANDROID_HOME` 未设置——所以「不设环境变量」
> 是常态，插件必须能自己找到。发现了 SDK 但缺某个组件时，`android_status` 会按组件给出
> `NO_ADB` / `NO_EMULATOR` / `NO_AVD_MANAGER`，而不是笼统的 `NO_SDK`。

### ⚠️ ABI：ARM 的 APK 可以直接测（v1.1.0 起结论已变）

> **一句话**：`arm64-v8a` 的 APK **不需要重建 x86_64 就能直接装、直接测**——官方 x86_64 系统镜像
> 自带 Google 的 ARM64 转译层。只有 **32 位 ARM（`armeabi-v7a`-only）** 不行。
> 详见下一节「测试 ARM 的 APK」。

- x86_64 主机**只能**跑 x86_64 系统镜像（arm64 镜像在 x86_64 主机上不可用）——这条没变；
- 但「arm-only 的 APK 装不进模拟器」的旧结论**已作废**：镜像里有 `libndk_translation`，
  `abilist` 是 `x86_64,arm64-v8a`，arm64-v8a 的库会被转译执行；
- 判断一个 APK 里有哪些 ABI：`android_apk_install` 的 `abis` 字段（读 zip 中央目录里的
  `lib/<abi>/`），或看 `android_status` 的 `device.abis` / `translation`；
- 什么时候仍然需要重建 x86_64：**要原生性能**（避免转译开销），或 APK 只有 **32 位 ARM**。

## 测试 ARM 的 APK

### 结论先行

| 你的 APK 含 | 能否在 x86_64 模拟器上测 | 说明 |
|---|---|---|
| `x86_64` | ✅ 能（原生） | `abiKind: "native"`，性能最好 |
| `arm64-v8a` | ✅ **能（转译）** | `abiKind: "translated"`，**不需要重建 x86_64** |
| 只有 `armeabi-v7a`（32 位） | ❌ 不能 | `ABI_MISMATCH`，官方镜像**没有 32 位 ARM 转译层/镜像** |
| 纯 Java/Kotlin（无 `.so`） | ✅ 能 | `abiKind: "none"`，任何 ABI 都装得上 |

**镜像自带转译层，不用自己塞任何东西。** Android 11+ 的 `google_apis` x86_64 系统镜像内置了
Google 的 `libndk_translation`（`/system/lib64/libndk_translation.so`，约 3.6 MB，外加一整套
proxy 库）。插件只负责**探测、报告、利用**它，不往镜像里注入 `.so`。

### 本机实测数据（2026-10-24，`system-images;android-35;google_apis;x86_64`）

设备属性（`adb shell getprop`）：

| 属性 | 值 |
|---|---|
| `ro.dalvik.vm.native.bridge` | `libndk_translation.so` |
| `ro.ndk_translation.version` | `0.2.3` |
| `ro.enable.native.bridge.exec` | `1` |
| `ro.dalvik.vm.isa.arm64` | `x86_64`（ARM64 指令由转译层在 x86_64 上执行） |
| `ro.product.cpu.abilist` | `x86_64,arm64-v8a` |
| `ro.product.cpu.abilist32` | **（空）** ← 32 位 ARM/x86 都不支持 |
| `/system/lib64/libndk_translation.so` | 3.6 MB，proxy 库齐备 |

用**原始 arm-only APK**（82 MB，`arm64-v8a` + `armeabi-v7a`）实测：

| 环节 | 结果 |
|---|---|
| `adb install` | **Success，2.6 s** |
| `primaryCpuAbi` | `arm64-v8a`（应用以 ARM64 身份运行） |
| 启动 | `Status: ok / COLD` |
| 截图 | **613,952 B**，完整渲染首页（`read_image` 可读） |
| logcat | `nativeloader … library_path=…/lib/arm64-v8a`（加载的是 ARM64 库） |
| 崩溃 | 无 `FATAL EXCEPTION` |

也就是说：**同一个 APK 既能走 arm64 转译测，也能重建 x86_64 原生测**，不需要为测试牺牲功能。

### 怎么读 `translation` / `abiKind`

`android_status` 的 `translation` 对象告诉你能不能跑 ARM 的库：

```jsonc
// android_status → translation（本机实测）
{
  "bridge": "libndk_translation.so",  // 转译层 .so 名；空串 = 没有转译层
  "version": "0.2.3",                // 转译层版本
  "enabled": true,                    // ro.enable.native.bridge.exec 是否为 1
  "kind": "ndk-translation",         // ndk-translation | houdini | native | none
  "arm64": true,                      // 能否运行 arm64-v8a（原生或转译）
  "arm32": false,                     // 能否运行 armeabi-v7a ← 本机 false
  "abilist64": ["x86_64", "arm64-v8a"],
  "abilist32": []                     // ← 空：没有 32 位支持
}
```

`kind` 的含义：

| `kind` | 含义 |
|---|---|
| `ndk-translation` | Intel/Google 的 NDK 转译层（`libndk_translation`），最常见 |
| `houdini` | Intel Houdini 转译层（部分第三方镜像/真机） |
| `native` | 没有转译层，但设备本身是 ARM（ARM 真机 / ARM 宿主机） |
| `none` | 没有转译层，也不能跑 ARM 库 |

`android_apk_install` 的 `abiKind` 告诉你这次安装**是怎么跑起来的**：

| `abiKind` | 条件 | 含义 |
|---|---|---|
| `"native"` | `matchedAbi` ∈ 设备原生 ABI（`x86_64` / `x86`） | 原生执行，性能最佳 |
| `"translated"` | `matchedAbi` 是 `arm64-v8a` / `armeabi-v7a` 且设备有转译层 | **通过转译执行** |
| `"none"` | 纯 Java APK（无 `lib/<abi>/`） | 没有 native 库，与 ABI 无关 |

所以一段典型的判断逻辑是：

```text
android_status → translation.kind === "ndk-translation" 且 translation.arm64 === true
  ⇒ arm64-v8a 的 APK 可以直接装（abiKind 会是 "translated"）
  ⇒ 但如果 translation.arm32 === false，只含 armeabi-v7a 的 APK 装不了
```

### ⚠️ 性能警告：转译不等于真机性能

转译层让**功能**可用，但**性能明显低于原生**：

- 首次加载 ARM 库有额外的映射/翻译开销，冷启动更慢；
- 大计算（**ONNX / TensorFlow Lite / 图像处理 / 加解密**）在转译下可能慢数倍；
- 部分依赖特定 CPU 特性的库（NEON/SVE 细节、CPU 型号判断、`/proc/cpuinfo` 分支）可能行为不同。

**不要用转译下的耗时判断真机性能，也不要用它做性能回归的基线。**
要量性能就用 x86_64 原生版（或 ARM 真机）；转译版只用于**功能验证**。

### ❌ 32 位 ARM 不支持（`armeabi-v7a`-only）

官方 Android Emulator 镜像生态里**没有** 32 位 ARM 转译层，也没有能在 x86_64 主机运行的
`armeabi-v7a` 系统镜像——本机镜像的 `abilist32` 直接是空的。所以：

- APK **只含 `armeabi-v7a`** 时，插件会在 `adb install` **之前**返回 `ABI_MISMATCH`，
  `message` 会明确解释「官方模拟器已无 32 位 ARM 转译层/镜像」并给出替代方案，不会让你去
  反复试装；
- 插件**不会**尝试 houdini / libnb 等第三方提取方案（授权与稳定性都不可控）。

**替代方案**（按推荐顺序）：

1. **改打含 `arm64-v8a` 的包**（绝大多数现代项目本来就有）——最省事，直接走转译测试；
2. **重建含 `x86_64` 的包**——要原生性能时用：
   ```powershell
   ./gradlew assembleDebug -PabiList=x86_64
   # 或 app/build.gradle 的 ndk { abiFilters 'x86_64' }
   ```
3. 必须测 32 位 ARM 时，只能用 **ARM 真机**（`serial` 指向真机即可，插件其余能力都可用）。

### 为什么不能「关掉转译」做对照（实测结论）

一开始我们以为可以通过 `emulator -prop ro.dalvik.vm.native.bridge=0` 关掉转译，**实测证明不行**：

```text
# 用 -prop 覆盖启动
$ emulator -avd dsh_android -no-window -prop ro.dalvik.vm.native.bridge=0
unexpected '-prop' value ('ro.dalvik.vm.native.bridge=0'), only 'qemu.*' properties are supported

# 启动后再看属性：完全没变
$ adb shell getprop ro.dalvik.vm.native.bridge
libndk_translation.so
$ adb shell getprop ro.product.cpu.abilist
x86_64,arm64-v8a
```

**结论：转译层由系统镜像决定，无法通过 emulator 命令行开关。**
`-prop` 只接受 `qemu.*` 属性，`ro.*`（只读属性）会被忽略并告警。

所以本插件**只做探测、不做控制**：

- `android_status.translation` 报告**当前镜像**的转译能力（由镜像决定，不是你配出来的）；
- `android_apk_install.abiKind` 区分 `native` / `translated`，告诉你这次安装实际怎么跑；
- `android_emulator_start` 启动后也会探测一次并返回 `translation`，`message` 里报告实际生效的能力——
  但它**没有**能改变转译能力的参数，因为底层根本不支持。

**要改变转译能力，只能换镜像**：换一个不带 `libndk_translation` 的 x86_64 镜像就没有转译；
换 `arm64-v8a` 镜像则是原生 ARM（但 x86_64 主机跑不了）。插件不会给你一个假装能用的开关。

## 安装

插件是标准 dsh bundle（`package.json` 里声明 `dsh.bundle.patch`），三种装法任选其一。

### 1. 本机开发目录（推荐）

```powershell
cd <插件目录>
dsh plugin add .
# 或者用会话里的 plugin_manager 工具：
#   install_bundle target="<插件目录>"
```

装完重启会话即可。它是 Host 插件，**不产生 pendingBuilds**，不需要批准安装脚本。

### 2. 从 GitHub

```powershell
dsh plugin add github:lldwb/dsh-android-emulator
```

> 仓库是**公开**的（MIT 许可），无需凭据即可 `git clone` / 安装。

### 3. 手动确认它装上了

```powershell
dsh --profile <你的profile> --dump-config | Select-String android-emulator
```

或在新会话里让 agent 调用一次 `android_status`：能返回结构化结果（哪怕 `ok:false`）就说明工具
注册成功；若模型完全看不到这些工具，那是 patch 行没进合成树，而不是本插件内部的问题。

## 工具集（15 个）

所有工具的输出对象**前三个字段固定**为 `ok: boolean`、`code: string`、`message: string`。
`code: "OK"` 表示成功；失败是 `ok:false` + 机器可读的 `code`（枚举见文末） + 一句人话 `message`。
所有工具都接受可选的 `serial`，省略时使用模块级「当前设备」。

| 工具 | 参数 | 返回（除三件套外） |
|---|---|---|
| `android_status` | `{}` | `sdk{found,root,adb,emulator,avdmanager,sdkmanager}`、`avds[{name,target,abi,path}]`、`images[{package,api,tag,abi}]`、`device{serial,state,booted,avd,abis[]}`、`translation{bridge,version,enabled,kind,arm64,arm32,abilist64[],abilist32[]}`、`acceleration{ok,kind,raw}`、`suggestions[]` |
| `android_avd_create` | `name?`、`image?`、`device?`、`force?` | `avd`、`image`、`created`、`command[]` |
| `android_emulator_start` | `avd?`、`headless?`（默认 `true`）、`cold?`、`timeoutMs?`、`port?` | `serial`、`avd`、`pid`、`bootedInMs`、`logFile`、`translation{bridge,version,enabled,kind,arm64,arm32,abilist64[],abilist32[]}` |
| `android_emulator_stop` | `serial?`、`all?` | `serial`、`stopped` |
| `android_apk_install` | `apk`（必填）、`serial?`、`grantPermissions?`（默认 `true`）、`reinstall?`（默认 `true`） | `package`、`versionName`、`versionCode`、`abis[]`、`deviceAbis[]`、`matchedAbi`、`abiKind`（`"native"` / `"translated"` / `"none"`）、`translation{bridge,version,enabled,kind,arm64,arm32,abilist64[],abilist32[]}`、`installedInMs`、`tips[]` |
| `android_app_launch` | `package?`、`activity?`、`serial?`、`stopFirst?`、`settleMs?`（默认 `1400`） | `package`、`activity`、`pid` |
| `android_app_stop` | `package`（必填）、`serial?` | `package` |
| `android_ui_dump` | `serial?`、`maxNodes?`（默认 `80`）、`clickableOnly?`、`filter?` | `screen{width,height,rotation}`、`nodeCount`、`package`、`nodes[{text,resourceId,contentDesc,className,packageName,clickable,enabled,scrollable,bounds{x1,y1,x2,y2},center{x,y}}]` |
| `android_ui_tap` | `x?`、`y?`、`text?`、`resourceId?`、`contentDesc?`、`index?`、`serial?`、`waitMs?`（默认 `0`） | `tapped{x,y}`、`target{text,resourceId,className,bounds}` |
| `android_ui_swipe` | `x1`、`y1`、`x2`、`y2`、`durationMs?`（默认 `300`）、`serial?` | `from{x,y}`、`to{x,y}`、`durationMs` |
| `android_ui_input` | `text`（必填）、`serial?`、`clear?` | `sent`、`asciiOnly`、`note` |
| `android_ui_key` | `key`（必填，见下表） | `key`、`keycode` |
| `android_ui_wait` | `text?`、`resourceId?`、`contentDesc?`、`timeoutMs?`（默认 `10000`）、`intervalMs?`（默认 `500`）、`serial?` | `found`、`waitedMs`、`node{...}` |
| `android_screenshot` | `serial?`、`label?` | `path`（绝对路径）、`width`、`height`、`bytes` |
| `android_logcat` | `serial?`、`lines?`（默认 `200`）、`level?`、`tag?`、`package?` | `lines[]`、`crashed`、`crashSummary` |

行为要点：

- `android_ui_tap` 二选一：给 `x`+`y` 走坐标；否则必须给 `text` / `resourceId` / `contentDesc`
  之一，插件先 dump UI 再按元素中心点击。找不到 → `ELEMENT_NOT_FOUND`。
- `android_ui_wait` 超时**不算错误**：返回 `ok:true, found:false`，`message` 说明在等什么。
- `android_app_launch` 启动成功后**默认等 1400 ms** 再返回（`settleMs`，范围 0–15000）。
  WebView / Capacitor 应用冷启动要 3–5 秒才渲染首屏，`am start -W` 一返回就截图会拿到白屏；
  如果默认值仍然不够，调大 `settleMs` 或先 `android_ui_wait` 等首屏元素。
- `android_emulator_start` 在设备启动/复用后会**探测一次 `translation` 并返回**，`message` 里报告
  实际生效的转译能力。它**没有**能开关转译的参数——`-prop ro.*` 不被 emulator 支持，
  转译层由系统镜像决定（见「测试 ARM 的 APK」里的实测记录）。
- `android_apk_install` 的 `abiKind` 区分 `native` / `translated` / `none`；`translated` 表示
  APK 通过 ARM 转译运行，`message` 与 `tips` 会带性能提醒（**不要用转译耗时判断真机性能**）。
- `android_ui_input` 只支持 **ASCII 可打印字符**（Android `input text` 的硬限制）：
  空格转 `%s`，shell 元字符会被过滤并在 `note` 里报告；纯非 ASCII（如中文）→ `BAD_ARGUMENT`。
- 截图与所有落盘路径都是**绝对路径**，可以直接交给 `read_image`。
- 支持的按键：`back`、`home`、`enter`、`menu`、`tab`、`delete`、`escape`、`power`、
  `volume_up`、`volume_down`、`recent`（映射到对应 keycode）。

## 典型工作流

下面是一条**真实可用**的调用序列（参数就是工具参数，返回值只摘关键字段）：

```text
1. android_status {}
   → sdk.found=true, avds=[...], device=null
   → 没有设备时 message 会提示「先 avd_create + emulator_start」

2. android_avd_create {"name":"dsh_android","image":"system-images;android-35;google_apis;x86_64"}
   → created=true, avd="dsh_android"

3. android_emulator_start {"avd":"dsh_android","headless":true,"cold":true}
   → serial="emulator-5554", bootedInMs=..., logFile="<outputDir>/emulator-dsh_android.log"

4. android_apk_install {"apk":"E:\\build\\app-x86_64-debug.apk"}
   → package="com.example.app", abis=["x86_64"], deviceAbis=["x86_64"], matchedAbi="x86_64"
   → 若 APK 只有 arm64-v8a：ok=false, code="ABI_MISMATCH"，不去碰 adb install

5. android_app_launch {"package":"com.example.app"}
   → activity="com.example.app/.MainActivity", pid=12345

6. android_ui_dump {"maxNodes":40}
   → screen={width:1080,height:2400,rotation:0}, nodeCount=..., nodes=[{text:"登录",...}]

7. android_ui_tap {"text":"登录","waitMs":800}
   → tapped={x:540,y:1520}, target={text:"登录",...}

8. android_screenshot {"label":"after-login"}
   → path="C:\\Users\\...\\Temp\\dsh-android-emulator\\shot-...png", width=1080, height=2400, bytes=...
   → 模型可以直接 read_image 这个 path 看界面

9. android_logcat {"lines":100,"package":"com.example.app"}
   → crashed=false；崩了则 crashed=true + crashSummary 摘出 FATAL EXCEPTION 那几行

10. android_emulator_stop {"serial":"emulator-5554"}
    → stopped=true
```

给 agent 的建议（写进 system prompt / 任务描述时很管用）：

1. 先 `android_status`，看 `suggestions` 再决定下一步，别一上来就 `avd_create`。
2. `avd_create` / `emulator_start` 是**慢操作**（首次冷启动可能 2–5 分钟），不要因为没立刻返回就重试。
3. 操作界面时**优先按 `resourceId` / `text` 点击**，坐标点击对分辨率和滚动位置敏感。
4. 断言前先 `ui_dump` 或 `screenshot`，不要假设上一步一定生效。
5. `ui_wait` 适合等网络加载后的元素；它超时不报错，要检查 `found`。

## 配置

配置写在 `cordis.patch.yml` 的行 `config` 里（本插件不声明 `Config` schema，字段由插件自己归一化，
未知字段忽略）：

```yaml
- insert:
    - id: android-emulator
      name: dsh-android-emulator
      config:
        sdkPath: '%LOCALAPPDATA%\Android\Sdk'
        avdName: dsh_android
        outputDir: ''
        bootTimeoutMs: 240000
        emulatorArgs: []
        adbPath: ''
        emulatorPath: ''
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `sdkPath` | `''`（自动发现） | Android SDK 根目录；指向不存在的位置时继续按自动发现顺序找 |
| `avdName` | `dsh_android` | 默认 AVD 名（`emulator_start` 不传 `avd` 时使用） |
| `outputDir` | `''` → `<tmp>/dsh-android-emulator` | 截图与模拟器日志的落盘目录，一定是绝对路径 |
| `bootTimeoutMs` | `240000` | 等 `sys.boot_completed=1` 的超时；超时返回 `BOOT_TIMEOUT` 并 kill 进程 |
| `emulatorArgs` | `[]` | 追加给 `emulator` 的额外参数（如 `-gpu host`、`-memory 4096`） |
| `adbPath` | `''` | 覆盖 `adb.exe` 路径（SDK 结构非标准时用） |
| `emulatorPath` | `''` | 覆盖 `emulator.exe` 路径 |

## 设计要点

- **启动命令**：`emulator -avd <name> -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect
  -no-snapshot-save [-no-snapshot] [-port N]`；`spawn(detached:true)` 后 `unref()`，日志写
  `<outputDir>/emulator-<avd>.log`；随后轮询 `getprop sys.boot_completed` 到 `1`（间隔 2s）。
- **停止**：`adb -s <serial> emu kill`，轮询 `adb devices` 直到消失（最多 30s），再兜底 kill 记录的 pid。
- **ABI 预检**：`deviceAbis ∩ apkAbis` 为空 → 直接 `ABI_MISMATCH`，**不调用** `adb install`。
- **UI 树**：`uiautomator dump` 的 XML → 结构化节点；bounds 解析成 `{x1,y1,x2,y2}` 与中心点。
- **截图必须是 Buffer，且要验 PNG magic**：`adb exec-out screencap -p` 的原始字节**只按 Buffer 收**，
  绝不过 utf8 解码；写盘后还要回读文件头校验 `89 50 4E 47 0D 0A 1A 0A`，不对就报 `INTERNAL`。
  这不是洁癖——真机实测里用 PowerShell 5.1 的 `>` / `Out-File` 重定向会把 PNG 变成 UTF-16
  （magic 变成 `FF FE FD FF`），文件看起来有几百 KB 但 `read_image` 永远打不开；
  `Out-File -Encoding Byte` 在 PS 5.1 里根本不存在。插件走的是进程内 Buffer，不经过任何 shell 重定向，
  所以没有这个坑；**但如果你手工用 adb 验证，请用 `cmd /c` 的重定向（二进制安全）或 `adb pull`**。
- **稳定性**：所有外部命令都有超时；子进程 spawn 被权限策略拦下时归一为 `SPAWN_DENIED`
  而不是让整个工具调用崩掉。

## 限制与已知问题

### ⚠️ WebView 页面无法用文本定位（真机实测，最容易踩的坑）

Capacitor / Cordova / 任何 WebView 应用的**页面 DOM 对 uiautomator 不可见**。真机实测
（`com.example.demo`）：

| 页面 | 节点数 | 带 `text` 的节点 | `clickable` | 能否按文本定位 |
|---|---|---|---|---|
| 首页（WebView） | **7**（全是布局容器） | **0** | 1（WebView 容器本身） | ❌ 不能 |
| 工作台（原生控件） | 37 | 22 | 9 | ✅ 能 |

首页 dump 出来只有 `com.example.demo:id/webview` 这一个有意义的节点
（`class="android.webkit.WebView"`），所有 `text` 都是空串。

**这不是插件的 bug，是 uiautomator 的能力边界**。这类页面只能：

1. `android_screenshot` 看界面（返回绝对路径，可直接 `read_image`）；
2. `android_ui_tap { "x": 540, "y": 660 }` 按**坐标**点击（坐标从截图里量，或直接点 WebView 容器
   `bounds` / `center` 的中心）。

`android_ui_dump` 检测到「节点极少且 text 全空」时会在 `message` 里主动提示这一点，
`android_ui_tap` 在 `ELEMENT_NOT_FOUND` 的 `message` 里也会给出同样的降级建议。
原生控件页（button / TextView / ToggleButton）才能按 `text` / `resourceId` / `contentDesc` 定位。

### 其它限制

- **无法关闭 ARM 转译**。想验证「纯 x86_64 环境」下应用行为时，**不能靠参数关掉转译层**：
  emulator 的 `-prop` 只支持 `qemu.*`，设置 `ro.dalvik.vm.native.bridge` 会被忽略并告警
  （实测见「测试 ARM 的 APK」）。要改转译能力只能换镜像；**本插件不提供假开关**。
- **不支持中文/非 ASCII 文本输入**。Android 的 `input text` 只接受 ASCII 可打印字符；
  发中文会得到 `BAD_ARGUMENT`。绕过办法：用坐标点击聚焦后由输入法输入，或先在宿主机把文本写进
  剪贴板再粘贴（v1 未内置）。
- **一次只操作一台设备**。多设备并行编排不在 v1 范围内；`serial` 参数是为将来留的口子。
  同时有多台设备在线且没给 `serial` 时会返回 `MULTIPLE_DEVICES`，不会瞎猜。
- **headless 是默认**。`emulator_start` 默认 `headless:true`（`-no-window`），所以你看不到
  模拟器窗口——要看界面请用 `android_screenshot`（返回绝对路径，可直接 `read_image`）。
- **首次冷启动很慢**。x86_64 镜像 + 软件 GPU 下第一次开机可能 2–5 分钟；`cold:true` 会更慢。
  时间不够就调大 `bootTimeoutMs`，不要反复重试（会堆出一堆模拟器进程）。
- **WebView 应用首屏渲染有延迟**。`android_app_launch` 默认等 1400 ms，但 Capacitor 冷启动
  可能要 3–5 秒；如果截图是白屏，调大 `settleMs` 或 `android_ui_wait` 等首屏元素。
- **x86 主机上 arm-only APK 一定装不上**（`ABI_MISMATCH`），必须用含 `x86_64` 的 APK，
  见上文「x86 主机上必须用 x86_64 的 APK」。
- **受限权限模式下会 `SPAWN_DENIED`**。插件在 Host 进程里 spawn 子进程；`read-only` /
  `workspace-write` 之类受限沙箱下会返回该 code，需要 `danger-full-access` 或放宽策略。
- **模拟器设备时钟可能比主机慢**（真机冒烟里观察到慢 8 小时）。依赖日志时间戳做相对判断
  时要注意，别拿它和宿主机时间直接比。
- **不做 APK 重打包/重签名**。需要 x86_64 版本时由环境侧用 Gradle 重建，插件只负责装和跑。
- **没有 UI 设置页**。为了零依赖，v1 不声明 `Config` schema，也没有「设置 → 插件」页面；
  配置只能改 patch 行（改完需要重启会话）。
- **`uiautomator dump` 偶尔抓不到页面**（应用刚切换 Activity 或被系统弹窗盖住时）：
  返回 `UI_DUMP_FAILED`，重试或先 `ui_wait` 一下。
- **截图是 PNG 全量传输**；分辨率越高越慢，`1080x2400` 量级通常几百 KB。

## 错误码

失败时 `code` 取以下枚举之一（`OK` 表示成功）。agent 应据此决定下一步，而不是解析 `message`：

| code | 含义 / 下一步 |
|---|---|
| `NO_SDK` | 找不到 SDK → 配 `sdkPath` 或设 `ANDROID_HOME` |
| `NO_ADB` / `NO_EMULATOR` / `NO_AVD_MANAGER` | SDK 里缺组件 → 用 SDK Manager 安装 |
| `NO_AVD` / `NO_IMAGE` | 没有 AVD / 没有可用镜像 → `avd_create` |
| `AVD_CREATE_FAILED` | `avdmanager` 失败，看 `message` 里的原始输出 |
| `DEVICE_NOT_RUNNING` | 没有设备 → `emulator_start` |
| `DEVICE_BUSY` / `MULTIPLE_DEVICES` | 设备被占用 / 多台同时在线 → 用 `serial` 指定 |
| `BOOT_TIMEOUT` | 启动超时 → 调大 `bootTimeoutMs` 或查 `logFile` |
| `EMULATOR_START_FAILED` | 模拟器进程没起来，`logFile` 里有原因 |
| `INSTALL_FAILED` | `adb install` 失败（签名/版本/空间），看 `message` |
| `ABI_MISMATCH` | 设备与 APK 的 ABI 无交集 → 重建含 `x86_64` 的 APK |
| `APK_NOT_FOUND` / `APK_UNREADABLE` | 路径不对 / 不是合法 zip |
| `APP_NOT_FOUND` / `LAUNCH_FAILED` | 包没装 / 启动失败 |
| `ELEMENT_NOT_FOUND` | 选择器没命中 → 先 `ui_dump` 看真实节点 |
| `BAD_ARGUMENT` | 参数不合法（如全角文本、缺坐标、未知按键） |
| `SPAWN_DENIED` | 权限限制导致不能起子进程 → 放宽沙箱策略 |
| `TIMEOUT` / `ADB_FAILED` / `UI_DUMP_FAILED` | 外部命令层面的失败，可重试 |
| `INTERNAL` | 插件自身 bug，请附 `message` 反馈 |

## 验证记录

验证分三层，覆盖的东西不同：

| 层 | 做什么 | 覆盖什么 |
|---|---|---|
| 单测 | `node --test "test/**/*.test.mjs"` | 镜像运行时两道校验（schema 子集 + 返回值）；UI XML 解析；子进程封装；SDK 发现与 zip 读取；无 SDK/无设备时的优雅降级。**全离线**，不连模拟器、不联网 |
| 沙箱 | `devkit_sandbox_*` 装进 headless profile 并真实调用 | 插件在真实 Loader 里能激活、行进合成树、工具在真实注册表里可用、返回值过运行时校验 |
| 真机端到端 | `node test/e2e-real.mjs`（可加 `--start`/`--apk`/`--package`） | 真模拟器上的完整链路：status → emulator_start → apk_install → app_launch → ui_dump → ui_tap → screenshot |

### 实测结果（2026-10-24，Windows 11 / AMD Ryzen AI 9 H 365 / 30.8 GB RAM / Hyper-V 开启）

**① 单测**（`npm test`，全离线，不连模拟器、不联网）

```
tests 135 · pass 135 · fail 0 · duration ≈ 2.3 s
```

其中 `test/tool-output.test.mjs` 是防护"`tool returned invalid output`"的核心一组：它真实执行可达分支、
按 `DESIGN §4` 的每个 code 构造失败分支，并**静态扫描**实现里所有 `R.fail(...)`/`toolError(...)`
是否落在 26 个错误码枚举内（实现新增分支却没同步测试时这条会红）。

**② 沙箱**（devkit headless profile，真实 Loader）

```powershell
devkit_sandbox_create  { name: "android-emu-regress" }          # → exitCode 0
devkit_sandbox_install { name, target: "<插件目录>" }  # → exitCode 0
devkit_sandbox_compose { name, grep: "android" }
#   → 合成树里出现： # == dsh-android-emulator / - id: android-emulator / name: dsh-android-emulator
devkit_sandbox_run     { name, task: "调用 android_status / android_logcat / android_ui_dump 并逐字贴出原始输出" }
#   → exitCode 0，无 "did not activate"、无 "tool returned invalid output"
```

沙箱里实际拿到的真实结果（说明插件在真实注册表里可用）：

| 工具 | 沙箱内真实返回摘要 |
|---|---|
| `android_status` | SDK `%LOCALAPPDATA%\Android\Sdk`；AVD `dsh_android[x86_64]`；设备 `emulator-5554` 已启动；加速 `whpx` |
| `android_logcat` | `没有发现崩溃信号（FATAL EXCEPTION / Fatal signal / ANR in / has died / E AndroidRuntime+Exception）` |
| `android_ui_dump` | `屏幕 1080x2400（rotation 0）· 包名 com.example.demo · 共 30 个节点` |

**③ 真机端到端**（模拟器 `emulator-5554`，AVD `dsh_android`，Android 15 / API 35 / x86_64）

被测应用：一个 Capacitor + ONNX Runtime 的安卓应用（包名 `com.example.demo`，x86_64 版 APK ≈ 103 MB，
含 `lib/x86_64/libonnxruntime.so` 等 4 个 native 库）。完整用户操作流 **14/14 项通过**：

| 步骤 | 结果 |
|---|---|
| `android_status` | 设备 `emulator-5554` booted=true，ABI `x86_64/arm64-v8a`，加速 `whpx` |
| `android_apk_install` | 装包成功，`matchedAbi = x86_64`（按设备 ABI 偏好顺序选择，非 APK 列表顺序） |
| `android_app_launch` | pid 4193，`com.example.demo/.MainActivity`，默认 `settleMs=1400` 等首屏 |
| `android_screenshot` | 1080×2400 PNG 614,571 B —— `read_image` 确认能看到「示例应用」首页与三张工作台卡片 |
| `android_ui_dump` | 首页 7 节点、text 全空 → **正确给出 WebView 降级提示**（建议截图 + 坐标点击） |
| `android_ui_tap {x,y}` | `(540,868)` 坐标点击第一张卡片 → 跳转「示例页面」工作台 |
| `android_ui_wait` | 等到文本「示例页面」，waitedMs ≈ 5.2 s |
| `android_ui_dump` | 工作台页 37 节点 / 22 带 text / 9 clickable（原生控件可定位） |
| `android_ui_tap {text}` | **按文本** `"打开图片与设置"` 命中并点击 `(967,215)`（非硬编码坐标） |
| `android_screenshot` | 界面实质变化 614,571 B → 136,834 B，`read_image` 看到弹出的「图片与设置」面板（选择图片/文件夹、识别当前/全部、摄像头实时检测） |
| `android_ui_wait` | 切换后仍可等到「图片」语义 |
| `android_logcat` | 120 行，`crashed=false`（应用运行期间无 FATAL/ANR，且不再把 `D AndroidRuntime: Shutting down VM` 误判为崩溃） |
| `android_ui_tap {text}` 负面 | 不存在的文本 → `ok:false, code:ELEMENT_NOT_FOUND`，message 给出下一步建议 |
| `output.render` | 15 个工具全部可渲染为中文可读文本（沙箱里模型看到的正是这些文本） |

另：`android_emulator_start` 单独实测 —— 冷启动 **38.2 s** 到 `boot_completed=1`（WHPX + SwiftShader，
无窗口），返回 pid / logFile / serial 均正确；`android_emulator_stop` 幂等（本来没运行也返回成功）。

复现命令（真机，需先有运行中的模拟器）：

```powershell
cd <插件目录>
node test/e2e-real.mjs --keep            # 7 通过 / 0 失败 / 4 跳过（不装包）
node test/e2e-real.mjs --keep --apk <你的.apk> --package <包名>   # 含装包与启动的完整链路
```

### v1.1.0 追加：ARM 转译层（2026-10-24 晚，实机复测）

**单测**：`tests 135 · pass 135 · fail 0`（新增 `test/translation.test.mjs`：`translationFromProps` 的 5 种形态、
`abiKind` 判定、`ABI_MISMATCH` 三分支措辞、schema 漂移守护）

**沙箱**：`android-emu-arm-regress`（v1.1.0 代码）→ 合成树出现行、`run` 真实调用
`android_status` 与 `android_apk_install`（原始 arm APK），无 `did not activate` / `invalid output`。

**真机（ARM 转译）**：`emulator-5554` 上安装**原始 arm-only APK**（82.04 MB，ABI 仅 `arm64-v8a`/`armeabi-v7a`）：

| 步骤 | 结果 |
|---|---|
| `android_status.translation` | `kind=ndk-translation`、`bridge=libndk_translation.so`、`version=0.2.3`、`arm64=true`、`arm32=false`、`abilist32=[]` |
| `android_apk_install`（arm APK） | `abiKind=translated`、`matchedAbi=arm64-v8a`、`package=com.example.demo`；message 与 tips 均含转译性能提醒 |
| `android_app_launch` | pid 5293，COLD 启动成功（ARM 指令经 `libndk_translation` 转译到 x86_64） |
| `android_screenshot` | 614,886 B，`read_image` 看到完整「示例应用」首页 —— 与原生 x86_64 版视觉一致 |
| `android_ui_dump` | 首页 7 节点 + **WebView 降级提示** |
| `android_ui_tap {x,y}` → `android_ui_wait` | `(540,868)` 进「示例页面」工作台，等到文本（5.1 s） |
| `android_ui_dump` | 工作台 37 节点 / 22 text / 9 clickable |
| `android_ui_tap {text}` | **按文本**点「打开图片与设置」→ `(967,215)` |
| `android_screenshot` | 界面实质变化 614,886 B → 137,072 B |
| `android_logcat` | 200 行，`crashed=false`（转译下无 FATAL / SIGSEGV / ANR） |
| `android_apk_install`（x86_64 版对照） | `abiKind=native`、`matchedAbi=x86_64` —— 同一设备上两种 ABI 路径被正确区分 |

旁证：logcat `nativeloader … library_path=…/lib/arm64-v8a`；`dumpsys package` → `primaryCpuAbi=arm64-v8a`。

**⑤ 关于转译层的两次自我修正**（记录在案，避免后人再走一遍）

1. 初版 DESIGN 断言「arm-only APK 在 x86_64 模拟器上装不了」→ **错**。实测能装能跑，
   因为 Android 11+ 的 `google_apis` x86_64 镜像**自带** Google `libndk_translation`。
2. 随后设计了 `android_emulator_start.nativeBridge` 参数想开关转译 → **不可行，已删除**。
   实测 `emulator -prop ro.dalvik.vm.native.bridge=0` 被直接忽略，emulator 明确告警
   `only 'qemu.*' properties are supported`；启动后属性与 `abilist` 完全不变。
   插件因此只做**探测**、不做控制——不给用户一个"关掉转译"的假开关。

**④ 验证中发现并修掉的真问题**（记录在案，避免回归）

1. `interact.mjs` 把 5 个 `uiauto` 的导出写成从 `schema.mjs` 导入 → ESM 静态解析期 `SyntaxError`，
   **整个插件不会激活**（Loader 报 `did not activate`，15 个工具全部消失）。这是"mock 单测全绿 ≠ 插件能用"
   的典型形态，靠 `node --test` 之外的 import 冒烟抓到。
2. SDK 自动发现候选取漏 `%USERPROFILE%\Android\Sdk`（本机真实位置）→ 默认配置下 `NO_SDK`。
3. `android_apk_install.matchedAbi` 按 APK 的 ABI 列表取首个，而不是按**设备**的 ABI 偏好顺序 →
   在 `x86_64/arm64-v8a` 设备上误报 `arm64-v8a`。
4. 轮询 `sleep()` 使用 `unref()` → 独立 Node 脚本在等待期间（事件循环为空）直接退出，
   报 `unsettled top-level await`；已改为保持 ref。
5. `android_logcat.crashed` 把 `AndroidRuntime` 子串当崩溃信号 → 正常的
   `D AndroidRuntime: Shutting down VM` 被判成崩溃（**误报比漏报更糟**，会让 agent 误以为应用坏了）。
   已改为只认 `FATAL EXCEPTION` / `Fatal signal` / `ANR in` / `has died` / `E AndroidRuntime`+`Exception`。
6. `android_app_launch` 在包名不存在时误报 `ok:true`（按英文 `Error|Exception` 正则判失败，
   而 adb 的报错是中文）→ 已改为 `result.code !== 0` 一律判失败。
7. `android_app_launch` 后立刻截图得到白屏（Capacitor/WebView 冷启动需 3–5 s）→ 增加 `settleMs`（默认 1400）
   并在 message 里提示"白屏就等 2–3 秒再截"。

## 仓库

- 地址：<https://github.com/lldwb/dsh-android-emulator>
- 可见性：**开源（MIT 许可）** —— 公开仓库，可自由使用、修改与再分发
- 相关文档：[`DESIGN.md`](./DESIGN.md)（冻结契约）、[`CHANGELOG.md`](./CHANGELOG.md)
