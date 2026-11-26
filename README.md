# dsh-android-emulator

给 DeepSeek Harness 装上一台**可以被 agent 自己操作的 Android 模拟器**：启动 AVD、安装 APK、像用户一样点击 / 滑动 / 输入，并把界面（UI 树 + 截图）和日志回传给模型——把「改代码 → 装包 → 在设备上点开 → 看界面 / 日志 → 再改」这条反馈环路交给 agent 自己跑完。

- 仓库：<https://github.com/lldwb/dsh-android-emulator>（公开，MIT）
- 要求：Node ≥ 20（见 `package.json` 的 `engines`）；在 Windows 主机上开发与验证（SDK 自动发现路径按 Windows 组织）
- 变更历史见 [CHANGELOG.md](CHANGELOG.md)；设计契约见 [DESIGN.md](./DESIGN.md)

## 加载方式

加载方式：按需（skill: `android-emulator`；入口：`skill` 工具 / `/android-emulator`；关闭：该行 config 设 `onDemand: false`）

15 个工具的 schema 是整包里最大的一块，而安卓调试是「任务点名才会用」的情境型能力——平时不进模型工具表，模型需要时加载自带技能，从下一个模型步开始出现。

## 这个插件解决什么问题

安卓应用开发的验证环路天然是「改代码 → 装包 → 在设备上点开 → 看界面 / 日志 → 再改」。没有这个插件时，agent 写完代码只能停在这里：它看不到界面、点不了按钮、也不知道应用起来后崩没崩，于是只能让你手动跑一遍再回来描述现象——一个需要五六轮来回的反馈环路。

装上这个插件后，agent 手里就有一组 `android_*` 工具，能自己完成闭环：

```text
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

失败**不抛异常**：每个工具都返回 `ok` / `code` / `message` 三件套，agent 可以据此决定下一步（换镜像、建 AVD、重建 APK、换选择器……），而不是被一个异常打断整轮。

形态是 **Host 插件**（无 UI 半）、**零运行时依赖**：不 `import @deepseek-ai/*`、不需要 `node_modules`，安装即用。

## 前置条件

| 依赖 | 要求 | 说明 |
|---|---|---|
| Node.js | ≥ 20 | 插件与测试都用 ESM，`node --test` 跑测试 |
| Android SDK | 含 `platform-tools` / `emulator` / `system-images` | 未设 `ANDROID_HOME` 也能自动发现，见下 |
| Android 系统镜像 | **x86_64** | 目标 AVD 用 `system-images;android-<api>;<tag>;x86_64` |
| JDK | 21（`sdkmanager` / `avdmanager` 需要 `JAVA_HOME`） | 版本过低时 SDK 组件会报错 |
| 硬件加速 | Hyper-V / WHPX 已启用 | 没加速时模拟器启动极慢甚至失败 |

### SDK 自动发现顺序

按顺序取**第一个含 `platform-tools\adb.exe`** 的目录，全都不存在就返回 `NO_SDK` 并在 `android_status` 的 `sdk.problems` 里说明找过哪些位置：

1. 配置项 `sdkPath`（`cordis.patch.yml` 里的 `config`）
2. 环境变量 `ANDROID_HOME`
3. 环境变量 `ANDROID_SDK_ROOT`
4. `%LOCALAPPDATA%\Android\Sdk`
5. `%USERPROFILE%\AppData\Local\Android\Sdk`
6. `C:\Android\Sdk`

「不设环境变量」是常态（SDK 常在 `%LOCALAPPDATA%\Android\Sdk`），所以插件必须能自己找到。发现了 SDK 但缺某个组件时，`android_status` 会按组件给出 `NO_ADB` / `NO_EMULATOR` / `NO_AVD_MANAGER`，而不是笼统的 `NO_SDK`。

## ABI 与 ARM 转译

`arm64-v8a` 的 APK **不需要重建 x86_64 就能直接装、直接测**——官方 x86_64 系统镜像自带 Google 的 ARM64 转译层（`libndk_translation`）。只有 **32 位 ARM（`armeabi-v7a`-only）** 不行。

| 你的 APK 含 | 能否在 x86_64 模拟器上测 | 说明 |
|---|---|---|
| `x86_64` | ✅ 能（原生） | `abiKind: "native"`，性能最好 |
| `arm64-v8a` | ✅ **能（转译）** | `abiKind: "translated"`，**不需要重建 x86_64** |
| 只有 `armeabi-v7a`（32 位） | ❌ 不能 | `ABI_MISMATCH`，官方镜像**没有 32 位 ARM 转译层 / 镜像** |
| 纯 Java/Kotlin（无 `.so`） | ✅ 能 | `abiKind: "none"`，任何 ABI 都装得上 |

**镜像自带转译层，不用自己塞任何东西。** Android 11+ 的 `google_apis` x86_64 系统镜像内置 Google 的 `libndk_translation`（`/system/lib64/libndk_translation.so` 约 3.6 MB，外加一整套 proxy 库）。插件只负责**探测、报告、利用**它，不往镜像里注入 `.so`。

另外：x86_64 主机**只能**跑 x86_64 系统镜像（arm64 镜像在 x86_64 主机上不可用）。

### 怎么读 `translation` / `abiKind`

`android_status` 的 `translation` 对象告诉你能不能跑 ARM 的库：

```jsonc
// android_status → translation
{
  "bridge": "libndk_translation.so",  // 转译层 .so 名；空串 = 没有转译层
  "version": "0.2.3",                // 转译层版本
  "enabled": true,                    // ro.enable.native.bridge.exec 是否为 1
  "kind": "ndk-translation",         // ndk-translation | houdini | native | none
  "arm64": true,                      // 能否运行 arm64-v8a（原生或转译）
  "arm32": false,                     // 能否运行 armeabi-v7a
  "abilist64": ["x86_64", "arm64-v8a"],
  "abilist32": []                     // 空 = 没有 32 位支持
}
```

`kind` 的含义：

| `kind` | 含义 |
|---|---|
| `ndk-translation` | Intel / Google 的 NDK 转译层（`libndk_translation`），最常见 |
| `houdini` | Intel Houdini 转译层（部分第三方镜像 / 真机） |
| `native` | 没有转译层，但设备本身是 ARM（ARM 真机 / ARM 宿主机） |
| `none` | 没有转译层，也不能跑 ARM 库 |

`android_apk_install` 的 `abiKind` 告诉你这次安装**是怎么跑起来的**：

| `abiKind` | 条件 | 含义 |
|---|---|---|
| `"native"` | `matchedAbi` ∈ 设备原生 ABI（`x86_64` / `x86`） | 原生执行，性能最佳 |
| `"translated"` | `matchedAbi` 是 `arm64-v8a` / `armeabi-v7a` 且设备有转译层 | **通过转译执行** |
| `"none"` | 纯 Java APK（无 `lib/<abi>/`） | 没有 native 库，与 ABI 无关 |

典型判断逻辑：

```text
android_status → translation.kind === "ndk-translation" 且 translation.arm64 === true
  ⇒ arm64-v8a 的 APK 可以直接装（abiKind 会是 "translated"）
  ⇒ 但如果 translation.arm32 === false，只含 armeabi-v7a 的 APK 装不了
```

### 转译不等于真机性能

转译层让**功能**可用，但**性能明显低于原生**：首次加载 ARM 库有额外的映射 / 翻译开销，冷启动更慢；大计算（ONNX / TensorFlow Lite / 图像处理 / 加解密）在转译下可能慢数倍；部分依赖特定 CPU 特性的库（NEON/SVE 细节、CPU 型号判断、`/proc/cpuinfo` 分支）可能行为不同。

**不要用转译下的耗时判断真机性能，也不要用它做性能回归的基线。** 要量性能就用 x86_64 原生版（或 ARM 真机）；转译版只用于**功能验证**。

### 32 位 ARM 不支持（`armeabi-v7a`-only）

官方 Android Emulator 镜像生态里**没有** 32 位 ARM 转译层，也没有能在 x86_64 主机运行的 `armeabi-v7a` 系统镜像——镜像的 `abilist32` 直接是空的。所以 APK **只含 `armeabi-v7a`** 时，插件会在 `adb install` **之前**返回 `ABI_MISMATCH`，`message` 会解释原因并给出替代方案，不会让你反复试装。插件**不会**尝试 houdini / libnb 等第三方提取方案（授权与稳定性都不可控）。

替代方案（按推荐顺序）：

1. **改打含 `arm64-v8a` 的包**（绝大多数现代项目本来就有）——最省事，直接走转译测试；
2. **重建含 `x86_64` 的包**——要原生性能时用：
   ```powershell
   ./gradlew assembleDebug -PabiList=x86_64
   # 或 app/build.gradle 的 ndk { abiFilters 'x86_64' }
   ```
3. 必须测 32 位 ARM 时，只能用 **ARM 真机**（`serial` 指向真机即可，插件其余能力都可用）。

### 不能「关掉转译」做对照

转译层由系统镜像决定，**无法通过 emulator 命令行开关**：`emulator -prop` 只接受 `qemu.*` 属性，写 `ro.dalvik.vm.native.bridge=0` 会被忽略并告警（`only 'qemu.*' properties are supported`），启动后属性与 `abilist` 完全不变。

所以本插件**只做探测、不做控制**：

- `android_status.translation` 报告**当前镜像**的转译能力（由镜像决定，不是你配出来的）；
- `android_apk_install.abiKind` 区分 `native` / `translated`，告诉你这次安装实际怎么跑；
- `android_emulator_start` 启动后也会探测一次并返回 `translation`，`message` 里报告实际生效的能力——但它**没有**能改变转译能力的参数，因为底层根本不支持。

**要改变转译能力，只能换镜像**：换一个不带 `libndk_translation` 的 x86_64 镜像就没有转译；换 `arm64-v8a` 镜像则是原生 ARM（但 x86_64 主机跑不了）。插件不会给你一个假装能用的开关。

## 按需加载

15 个 `android_*` 工具默认**不进**模型工具表（每请求省下整包 schema），用「skill 门控」控制：工具默认隐藏，模型加载本插件自带的 `android-emulator` 技能后从**下一个模型步**出现。

- **触发方式（任选其一）**
  - 模型自己调 `skill({ name: "android-emulator" })`——该技能的 description / whenToUse 写明了「需要启安卓模拟器、装 APK、点界面、看 logcat、截图验证时」加载；
  - 用户输入 `/android-emulator` 斜杠调用；
  - `resume` / `fork` 过的会话，历史请求头里已声明过本插件工具 → 自动放行，不用重新加载。
- **为什么「加载了却还调不到」是正常的**：工具表在一次模型步内是固定的，门控在**下一步**才生效。所以加载后这一步仍可能报 `unknown tool`，下一步再调即可；**不要当成功能不存在**。
- **恢复常驻**：配置 `onDemand: false`，工具永远可见。
- **fail-open 边界**：没有 `skill` 工具的模式（`minimal` 等）**自动常驻**——那些模式没有加载技能的入口，门控等于把工具永久藏起来。判据是该 agent 自己 scope 的可见工具集（`ctx.tools.get('skill', agent)`），与宿主平面是否注册了 skill 服务无关。
- 技能正文放在 `lib/skill-content.md`：`android_status` 探环境 → 会话专属 AVD 与 `maxInstances` / 磁盘预算 → 装包（ABI 预检、`translated` 不要用耗时判性能）→ 启动 / 停止 → UI 树与点击 / 滑动 / 输入 / 按键 / 等待 → 截图 → logcat 定位崩溃。

## 安装

插件是标准 dsh bundle（`package.json` 里声明 `dsh.bundle.patch`），三种装法任选其一。

**1) 本机开发目录（推荐）**

```powershell
cd <插件目录>
dsh plugin add .
# 或者用会话里的 plugin_manager 工具：
#   install_bundle target="<插件目录>"
```

装完重启会话即可。它是 Host 插件，**不产生 pendingBuilds**，不需要批准安装脚本。

**2) 从 GitHub**

```powershell
dsh plugin add github:lldwb/dsh-android-emulator
```

**3) 确认它装上了**

```powershell
dsh --profile <你的profile> --dump-config | Select-String android-emulator
```

或在新会话里**先加载一次技能**再让 agent 调用 `android_status`：能返回结构化结果（哪怕 `ok:false`）就说明工具注册成功；若加载技能后仍然完全看不到这些工具，那是 patch 行没进合成树，而不是本插件内部的问题。

## 工具集（15 个）

所有工具的输出对象**前三个字段固定**为 `ok: boolean`、`code: string`、`message: string`。`code: "OK"` 表示成功；失败是 `ok:false` + 机器可读的 `code`（枚举见文末） + 一句人话 `message`。所有工具都接受可选的 `serial`，省略时使用**本会话**的当前设备（见「多会话隔离」）。

| 工具 | 参数 | 返回（除三件套外） |
|---|---|---|
| `android_status` | `{}` | `sdk{found,root,adb,emulator,avdmanager,sdkmanager}`、`avds[{name,target,abi,path,kind}]`（`kind`: `session-pinned` / `template`）、`images[{package,api,tag,abi}]`、`device{serial,state,booted,avd,abis[]}`、`translation{bridge,version,enabled,kind,arm64,arm32,abilist64[],abilist32[]}`、`acceleration{ok,kind,raw}`、`sessionKey`、`instances[{sessionKey,serial,avd,pid,booted,lastPackage}]`、`instanceLimit{count,max}`、`avdDisk{sessionAvdCount,totalGb,freeDiskGb}`、`suggestions[]` |
| `android_avd_create` | `name?`、`image?`、`device?`、`force?` | `avd`、`image`、`created`、`command[]` |
| `android_emulator_start` | `avd?`、`headless?`（默认 `true`）、`cold?`、`timeoutMs?`、`port?` | `serial`、`avd`、`pid`、`bootedInMs`、`logFile`、`translation{…}`、`sessionKey`、`createdAvd`（是否为本会话新建了专属 AVD） |
| `android_emulator_stop` | `serial?`、`all?`（默认 `false`；`true`＝停止**本会话**全部）、`removeAvd?`（默认 `false`；`true`＝同时删除本会话专属 AVD 释放磁盘） | `serial`、`stopped` |
| `android_apk_install` | `apk`（必填）、`serial?`、`grantPermissions?`（默认 `true`）、`reinstall?`（默认 `true`） | `package`、`versionName`、`versionCode`、`abis[]`、`deviceAbis[]`、`matchedAbi`、`abiKind`、`translation{…}`、`installedInMs`、`tips[]` |
| `android_app_launch` | `package?`、`activity?`、`serial?`、`stopFirst?`、`settleMs?`（默认 `1400`） | `package`、`activity`、`pid` |
| `android_app_stop` | `package`（必填）、`serial?` | `package` |
| `android_ui_dump` | `serial?`、`maxNodes?`（默认 `80`）、`clickableOnly?`、`filter?` | `screen{width,height,rotation}`、`nodeCount`、`package`、`nodes[{text,resourceId,contentDesc,className,packageName,clickable,enabled,scrollable,bounds{x1,y1,x2,y2},center{x,y}}]` |
| `android_ui_tap` | `x?`、`y?`、`text?`、`resourceId?`、`contentDesc?`、`index?`、`serial?`、`waitMs?`（默认 `0`） | `tapped{x,y}`、`target{text,resourceId,className,bounds}` |
| `android_ui_swipe` | `x1`、`y1`、`x2`、`y2`、`durationMs?`（默认 `300`）、`serial?` | `from{x,y}`、`to{x,y}`、`durationMs` |
| `android_ui_input` | `text`（必填）、`serial?`、`clear?` | `sent`、`asciiOnly`、`note` |
| `android_ui_key` | `key`（必填，见下） | `key`、`keycode` |
| `android_ui_wait` | `text?`、`resourceId?`、`contentDesc?`、`timeoutMs?`（默认 `10000`）、`intervalMs?`（默认 `500`）、`serial?` | `found`、`waitedMs`、`node{...}` |
| `android_screenshot` | `serial?`、`label?` | `path`（绝对路径）、`width`、`height`、`bytes` |
| `android_logcat` | `serial?`、`lines?`（默认 `200`）、`level?`、`tag?`、`package?` | `lines[]`、`crashed`、`crashSummary` |

行为要点：

- `android_ui_tap` 二选一：给 `x`+`y` 走坐标；否则必须给 `text` / `resourceId` / `contentDesc` 之一，插件先 dump UI 再按元素中心点击。找不到 → `ELEMENT_NOT_FOUND`。
- `android_ui_wait` 超时**不算错误**：返回 `ok:true, found:false`，`message` 说明在等什么。
- `android_app_launch` 启动成功后**默认等 1400 ms** 再返回（`settleMs`，范围 0–15000）。WebView / Capacitor 应用冷启动要 3–5 秒才渲染首屏，`am start -W` 一返回就截图会拿到白屏；默认值不够就调大 `settleMs` 或先 `android_ui_wait` 等首屏元素。
- `android_emulator_start` 在设备启动 / 复用后会**探测一次 `translation` 并返回**，`message` 里报告实际生效的转译能力；它没有开关转译的参数（见上一节）。
- `android_apk_install` 的 `abiKind` 区分 `native` / `translated` / `none`；`translated` 表示 APK 通过 ARM 转译运行，`message` 与 `tips` 会带性能提醒。
- `android_logcat` 的 `crashed` 只认这些崩溃信号：`FATAL EXCEPTION`、`Fatal signal`、`ANR in`、`has died`、`E AndroidRuntime` + `Exception`。正常的 `D AndroidRuntime: Shutting down VM` **不算**崩溃（误报比漏报更糟，会让 agent 误以为应用坏了）；命中时 `crashSummary` 摘出相关几行。
- `android_emulator_stop` 是幂等的，但语义收窄：省略 `serial` 且本来没在运行时返回成功；显式传一个**从没存在过**的 `serial` 会返回 `DEVICE_NOT_RUNNING`（不会假装「已停止 1 台」）。
- `android_ui_input` 只支持 **ASCII 可打印字符**（Android `input text` 的硬限制）：空格转 `%s`，shell 元字符会被过滤并在 `note` 里报告；纯非 ASCII（如中文）→ `BAD_ARGUMENT`。
- 截图与所有落盘路径都是**绝对路径**，可以直接交给 `read_image`。
- 支持的按键：`back`、`home`、`enter`、`menu`、`tab`、`delete`、`escape`、`power`、`volume_up`、`volume_down`、`recent`（映射到对应 keycode，也可以写 `KEYCODE_` 前缀）。

## 典型工作流

一条可用的调用序列（参数就是工具参数，返回值只摘关键字段）：

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
   → 若 APK 只有 32 位 ARM：ok=false, code="ABI_MISMATCH"，不去碰 adb install

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

配置写在 `cordis.patch.yml` 的行 `config` 里（本插件不声明 `Config` schema，字段由插件自己归一化，未知字段忽略）：

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
        perSession: true
        maxInstances: 2
        avdNamePrefix: ''
        onDemand: true
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `sdkPath` | `''`（自动发现） | Android SDK 根目录；指向不存在的位置时继续按自动发现顺序找 |
| `avdName` | `dsh_android` | 基础 AVD 名（`perSession: true` 时是会话专属 AVD 名的模板来源） |
| `outputDir` | `''` → `<tmp>/dsh-android-emulator` | 截图与模拟器日志的落盘目录，一定是绝对路径 |
| `bootTimeoutMs` | `240000` | 等 `sys.boot_completed=1` 的超时；超时返回 `BOOT_TIMEOUT` 并 kill 进程 |
| `emulatorArgs` | `[]` | 追加给 `emulator` 的额外参数（如 `-gpu host`、`-memory 4096`） |
| `adbPath` | `''` | 覆盖 `adb.exe` 路径（SDK 结构非标准时用） |
| `emulatorPath` | `''` | 覆盖 `emulator.exe` 路径 |
| `perSession` | `true` | `true`＝每会话独立模拟器与状态；`false`＝全部会话共享一台，见「多会话隔离」 |
| `maxInstances` | `2` | `perSession: true` 时同时运行的模拟器上限（钳制 1–8）。到上限后 `emulator_start` 返回 `DEVICE_BUSY` |
| `avdNamePrefix` | `''` | 会话专属 AVD 名的前缀；空则用 `avdName`。最终形如 `<前缀>--<sessionShort>` |
| `onDemand` | `true` | 按需门控：15 个工具默认不进模型工具表，加载 `android-emulator` 技能后从下一步出现；`false` = 常驻。没有 `skill` 工具的模式自动 fail-open 常驻 |

## 多会话隔离

**默认每个会话有自己的一台模拟器和独立的运行状态。** A 会话装包、点击、甚至 `android_emulator_stop`，都不会影响 B 会话正在用的设备。

```text
execute(args, exec) 的 exec.agent.id  = SessionId
        ↓
sessionKey = exec.agent?.id ?? 'shared-default'
        ↓
┌───────────────────────┬─────────────────────────┐
│ 状态分区              │ 设备隔离                │
│ getCurrent(key)       │ 每会话专属 AVD          │
│ rememberPackage(key, …)│ <prefix>--<sessionShort>│
│ 进程记录带 sessionKey │ 独立端口 5554 + 2*slot  │
└───────────────────────┴─────────────────────────┘
```

- **`sessionKey`**：来自 `exec.agent.id`（dsh 的 `Agent` 接口就是 `{ readonly id: SessionId }`）。没有 agent 上下文时（例如脚本直接调 `execute`）落到 `'shared-default'` 共享槽。
- **状态分区**：当前设备、最近安装的包都按 `sessionKey` 存；进程表仍按 serial 索引，但每条记录带 `sessionKey` 用于归属判定。
- **专属 AVD**：名字是 `<avdNamePrefix 或 avdName>--<sessionShort>`。`sessionShort` = sessionKey 里非 `[A-Za-z0-9_-]` 的字符换成 `_`，再取前 8 个字符（session id 可能很长 / 带 uuid / 全角字符，必须清洗后才能当 AVD 名）。真实 dsh SessionId 形如 `session-<uuid>`，前 8 字符恒为通用前缀 `session-`；这种「截断点落在分隔符上」的情况会改取可辨识段（`session-9e1ca070-…` → `9e1ca070`），否则所有会话会撞成同一个 AVD 名。第一次启动时若不存在就用 `avdmanager create avd` 从**同一个** system-image + device 配置建出来，并在返回值里 `createdAvd: true` 告诉你这件事。
- **独立端口**：从 `5554` 起按 slot 分配 `5554 + 2*slot`，被占用就顺延；启动前用 `adb devices` 校验。

### 资源代价（先算账）

隔离不是免费的。每台会话模拟器的开销：

| 资源 | 开销 |
|---|---|
| 磁盘 | **≈ 4–6.5 GB**（其中 `userdata-qemu.img.qcow2` ≈ 3.9 GB，`snapshots/default_boot/ram.img` ≈ 2.5 GB） |
| 内存（RAM） | **≈ 2 GB**（运行中） |
| 启动时间 | **40–90 秒**（无快照冷启动） |

所以 `maxInstances` 默认是 **2**——两个会话同时各起一台，就是 ≈ 8–13 GB 磁盘 + 4 GB RAM。磁盘紧张时很容易在装大 APK 时失败。

`android_status` 会返回 `avdDisk` 帮你监控：

```jsonc
"avdDisk": {
  "sessionAvdCount": 2,   // 会话专属 AVD（<prefix>--*）的数量
  "totalGb": 11.3,        // 这些 AVD 合计占多少 GB
  "freeDiskGb": 25.7      // 磁盘剩余 GB
}
```

`suggestions[]` 在剩余磁盘 < 8 GB 时会提示清理。调小上限或按需临时调大：

```yaml
maxInstances: 1     # 严格串行：第二个会话会拿 DEVICE_BUSY
```

> 会话 AVD 统一用 `-no-snapshot` 启动（**不生成**那 2.5 GB 的 `ram.img` 快照）。代价是每次都要走无快照冷启动（约 38 秒），换来每台省下 2.5 GB 磁盘。

### 超限 / 跨会话时的行为

| 场景 | 返回 |
|---|---|
| 已达 `maxInstances`，本会话还要再起一台 | `ok:false, code:"DEVICE_BUSY"`，`message` 列出当前占用者（`sessionKey` 前 8 字符 + serial）并给出下一步（停别的会话 / 调大 `maxInstances`） |
| 显式传的 `serial` 属于**别的会话** | `ok:false, code:"DEVICE_BUSY"`，`message` 说明归属 |
| `android_emulator_stop` 的 `serial` 属于别的会话 | 同上，**不会静默停别人的设备** |

设计原则是 **绝不静默跨会话操作**：宁可返回 `DEVICE_BUSY` 让 agent 明确知道「这台不是我该动的」，也不要在别人的设备上点一下。

### 退回共享模式

```yaml
perSession: false
```

好处是省资源（一台设备所有会话共用，启动一次就行）。**风险必须说清楚**：

- **会话之间会互相干扰**——A 的点击 / 装包 / 停设备会直接作用在 B 正在用的设备上；
- A 调 `android_emulator_stop` 会停掉 B 正在用的模拟器；
- 两个会话同时操作同一界面时，UI 状态会打架（谁点的都算），断言可能莫名其妙地失败；
- 状态仍然按 sessionKey 分区，但**只有 `shared-default` 槽被使用**，分区语义在共享模式下没有实际隔离效果。

只在「我就是想省一台模拟器」且愿意接受互相干扰时用它。

### 清理（会话 AVD 很占磁盘）

一台会话 AVD 就是 4–6.5 GB，跑过几次实验后很容易堆到几十 GB。

**1) 删掉本会话的专属 AVD（推荐）**

```text
android_emulator_stop { "removeAvd": true }
```

`removeAvd` 默认 `false`（只停设备、保留 AVD）；传 `true` 会**删除本会话**的专属 AVD，释放约 4–6 GB。它**只删本会话自己的**（`<prefix>--<sessionShort>`），不会碰别人的、也不会碰基础模板 AVD。

「设备已经停了、但 AVD 还在」的情况也支持：此时 `android_emulator_stop { "removeAvd": true }` 停在早退分支（`message` 说「没有运行中的模拟器，不需要停止」），但仍会**执行删除**并报告释放空间，所以不用为了回收磁盘先起一台设备。

**2) 手工查看 / 清理**

先看 `android_status` 的 `avdDisk`（`sessionAvdCount` / `totalGb` / `freeDiskGb`），再决定要不要清：

```powershell
# 列出所有会话专属 AVD（<prefix>--*）
Get-ChildItem "$env:USERPROFILE\.android\avd" -Directory | Where-Object Name -like 'dsh_android--*'

# 看某一个占多少
'{0:N2} GB' -f ((Get-ChildItem "$env:USERPROFILE\.android\avd\dsh_android--abc12345.avd" -Recurse |
    Measure-Object Length -Sum).Sum / 1GB)

# 删掉（用 avdmanager，别手删目录——.ini 会残留）
& "$env:LOCALAPPDATA\Android\Sdk\cmdline-tools\latest\bin\avdmanager.bat" delete avd -n 'dsh_android--abc12345'

# 或者直接用主机 adb 停设备
adb devices
adb -s emulator-5554 emu kill
```

> `android_emulator_stop { "all": true }` 只停**本会话**的全部设备。想清别的会话留下的东西只能回命令行。插件**不会自动删除** AVD（删错会毁掉别人的环境）；它只保证不会去抢别人的设备，以及在你显式要求 `removeAvd: true` 时清掉自己的。

## 设计要点

- **启动命令**：`emulator -avd <name> -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot-save [-no-snapshot] [-port N]`；`spawn(detached:true)` 后 `unref()`，日志写 `<outputDir>/emulator-<avd>.log`；随后轮询 `getprop sys.boot_completed` 到 `1`（间隔 2s）。
- **停止**：`adb -s <serial> emu kill`，轮询 `adb devices` 直到消失（最多 30s），再兜底 kill 记录的 pid。
- **ABI 预检**：`deviceAbis ∩ apkAbis` 为空 → 直接 `ABI_MISMATCH`，**不调用** `adb install`。
- **UI 树**：`uiautomator dump` 的 XML → 结构化节点；bounds 解析成 `{x1,y1,x2,y2}` 与中心点。
- **截图必须是 Buffer，且要验 PNG magic**：`adb exec-out screencap -p` 的原始字节**只按 Buffer 收**，绝不过 utf8 解码；写盘后还要回读文件头校验 `89 50 4E 47 0D 0A 1A 0A`，不对就报 `INTERNAL`。这不是洁癖——用 PowerShell 5.1 的 `>` / `Out-File` 重定向会把 PNG 变成 UTF-16（magic 变成 `FF FE FD FF`），文件看起来有几百 KB 但 `read_image` 永远打不开；`Out-File -Encoding Byte` 在 PS 5.1 里根本不存在。插件走的是进程内 Buffer，不经过任何 shell 重定向，所以没有这个坑；**但手工用 adb 验证时请用 `cmd /c` 的重定向（二进制安全）或 `adb pull`**。
- **稳定性**：所有外部命令都有超时；子进程 spawn 被权限策略拦下时归一为 `SPAWN_DENIED` 而不是让整个工具调用崩掉。
- **会话 AVD 不带快照**：`perSession: true` 时会话专属 AVD 统一加 `-no-snapshot` 启动，每台省下约 2.5 GB。手工 debug 时想快一点，可以自己用 `emulator -avd <name>` 带快照启动——但插件后续调用仍然只认 `adb devices` 里的 serial。
- **跨会话绝不静默操作**：任何工具在「显式给了 `serial`、但该 serial 属于别的会话」时返回 `DEVICE_BUSY` 并说明归属。这是硬约束，不是可以绕过的提示。

## 限制与已知问题

### WebView 页面无法用文本定位（最容易踩的坑）

Capacitor / Cordova / 任何 WebView 应用的**页面 DOM 对 uiautomator 不可见**：

| 页面 | 节点数 | 带 `text` 的节点 | `clickable` | 能否按文本定位 |
|---|---|---|---|---|
| 首页（WebView） | 7（全是布局容器） | 0 | 1（WebView 容器本身） | ❌ 不能 |
| 工作台（原生控件） | 37 | 22 | 9 | ✅ 能 |

首页 dump 出来只有 `com.example.demo:id/webview` 这一个有意义的节点（`class="android.webkit.WebView"`），所有 `text` 都是空串。

**这不是插件的 bug，是 uiautomator 的能力边界**。这类页面只能：

1. `android_screenshot` 看界面（返回绝对路径，可直接 `read_image`）；
2. `android_ui_tap { "x": 540, "y": 660 }` 按**坐标**点击（坐标从截图里量，或直接点 WebView 容器 `bounds` / `center` 的中心）。

`android_ui_dump` 检测到「节点极少且 text 全空」时会在 `message` 里主动提示这一点，`android_ui_tap` 在 `ELEMENT_NOT_FOUND` 的 `message` 里也会给出同样的降级建议。原生控件页（button / TextView / ToggleButton）才能按 `text` / `resourceId` / `contentDesc` 定位。

### 其它限制

- **无法关闭 ARM 转译**。想验证「纯 x86_64 环境」下应用行为时**不能靠参数关掉转译层**（见「不能『关掉转译』做对照」）。要改转译能力只能换镜像；**本插件不提供假开关**。
- **不支持中文 / 非 ASCII 文本输入**。Android 的 `input text` 只接受 ASCII 可打印字符；发中文会得到 `BAD_ARGUMENT`。绕过办法：用坐标点击聚焦后由输入法输入，或先在宿主机把文本写进剪贴板再粘贴（未内置）。
- **一次只操作一台设备**。多设备并行编排不在当前范围内；`serial` 参数是为将来留的口子。同时有多台设备在线且没给 `serial` 时会返回 `MULTIPLE_DEVICES`，不会瞎猜。
- **headless 是默认**。`emulator_start` 默认 `headless:true`（`-no-window`），所以你看不到模拟器窗口——要看界面请用 `android_screenshot`。
- **首次冷启动很慢**。x86_64 镜像 + 软件 GPU 下第一次开机可能 2–5 分钟；`cold:true` 会更慢。时间不够就调大 `bootTimeoutMs`，不要反复重试（会堆出一堆模拟器进程）。
- **WebView 应用首屏渲染有延迟**。`android_app_launch` 默认等 1400 ms，但 Capacitor 冷启动可能要 3–5 秒；截图是白屏就调大 `settleMs` 或 `android_ui_wait` 等首屏元素。
- **受限权限模式下会 `SPAWN_DENIED`**。插件在 Host 进程里 spawn 子进程；`read-only` / `workspace-write` 之类受限沙箱下会返回该 code，需要 `danger-full-access` 或放宽策略。
- **模拟器设备时钟可能比主机慢**（观察到慢 8 小时）。依赖日志时间戳做相对判断时要注意，别拿它和宿主机时间直接比。
- **不做 APK 重打包 / 重签名**。需要 x86_64 版本时由环境侧用 Gradle 重建，插件只负责装和跑。
- **没有 UI 设置页**。为了零依赖不声明 `Config` schema，也没有「设置 → 插件」页面；配置只能改 patch 行（改完需要重启会话）。
- **`uiautomator dump` 偶尔抓不到页面**（应用刚切换 Activity 或被系统弹窗盖住时）：返回 `UI_DUMP_FAILED`，重试或先 `ui_wait` 一下。
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
| `INSTALL_FAILED` | `adb install` 失败（签名 / 版本 / 空间），看 `message` |
| `ABI_MISMATCH` | 设备与 APK 的 ABI 无交集 → 换含 `arm64-v8a` 或重建含 `x86_64` 的 APK |
| `APK_NOT_FOUND` / `APK_UNREADABLE` | 路径不对 / 不是合法 zip |
| `APP_NOT_FOUND` / `LAUNCH_FAILED` | 包没装 / 启动失败 |
| `ELEMENT_NOT_FOUND` | 选择器没命中 → 先 `ui_dump` 看真实节点 |
| `BAD_ARGUMENT` | 参数不合法（如全角文本、缺坐标、未知按键） |
| `SPAWN_DENIED` | 权限限制导致不能起子进程 → 放宽沙箱策略 |
| `TIMEOUT` / `ADB_FAILED` / `UI_DUMP_FAILED` | 外部命令层面的失败，可重试 |
| `INTERNAL` | 插件自身 bug，请附 `message` 反馈 |

## 开发与测试

```powershell
node --test "test/**/*.test.mjs"    # 单测：全离线，不连模拟器、不联网
```

单测覆盖镜像运行时的两道校验（schema 子集 + 返回值）、UI XML 解析、子进程封装、SDK 发现与 zip 读取、无 SDK / 无设备时的优雅降级。

真机端到端（需要先有运行中的模拟器）：

```powershell
node test/e2e-real.mjs --keep                                   # 不装包：7 通过 / 0 失败 / 4 跳过
node test/e2e-real.mjs --keep --apk <你的.apk> --package <包名>   # 含装包与启动的完整链路
```

在真实 Loader 里验证（改了 `index.js` / `lib/**` 之后必须做）——单测用 mock ctx，看不见「插件没加载 / 行没进合成树 / 工具在真实注册表里叫不动 / 返回值过不了运行时校验」：装进 devkit headless 沙箱后真实调用 `android_status`，确认无 `did not activate`、无 `tool returned invalid output`。

**为什么正文（技能）单独放文件**：技能正文里大量使用 markdown 行内反引号，写成 JS 模板字符串时每个反引号都要转义，漏一个就会提前终止模板字符串、整个插件加载失败（`did not activate`），所以放在 `lib/skill-content.md`，代码侧零转义。

## 仓库与许可

- 仓库：<https://github.com/lldwb/dsh-android-emulator>（公开）
- 许可证：MIT，见 [LICENSE](LICENSE)
- 设计契约：[`DESIGN.md`](./DESIGN.md)；变更历史见 [CHANGELOG.md](./CHANGELOG.md)
