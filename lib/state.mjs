/**
 * dsh-android-emulator — 模块级运行状态（当前设备 + 模拟器进程表 + 最近安装的包）。
 *
 * ## 为什么集中在一个模块
 *
 * DESIGN §7 要求状态集中、只经函数读写，原因有两个：
 *
 * 1. **工具之间要共享上下文**：`android_screenshot` 省略 `serial` 时要知道
 *    `android_emulator_start` 启动的是哪台；`android_app_launch` 省略 `package`
 *    时要知道 `android_apk_install` 刚装的是哪个包。
 * 2. **测试要能注入**：单测里不启动模拟器，直接把 current 设成一个假 serial，
 *    就能验证工具层的参数解析与 schema 返回值。所以这里没有隐藏耦合，只有
 *    模块级变量 + 纯函数，`resetState()` 一键回到初始态。
 *
 * 进程表按 serial 索引：一个 serial 对应一次 `emulator` 启动（pid + 日志文件），
 * 用于 `android_emulator_stop` 在 `adb emu kill` 不够时兜底 kill 进程树。
 */

/** @type {{ serial: string, avd: string, pid: number, logFile: string, startedAt: number } | null} */
let current = null;

/** @type {Map<string, { serial: string, pid: number, avd: string, logFile: string, startedAt: number }>} */
const processes = new Map();

/** 最近一次 `android_apk_install` 安装的包名（`android_app_launch` 省略 package 时用）。 */
let lastPackage = '';

/** 读当前设备（无则 null）。 */
export function getCurrent() {
  return current === null ? null : { ...current };
}

/** 设置当前设备；会合并已有字段（例如只更新 serial 时保留 pid/logFile）。 */
export function setCurrent(patch) {
  if (patch === null || patch === undefined) {
    current = null;
    return;
  }
  current = { ...(current ?? emptyDevice()), ...patch };
}

/** 清空当前设备（设备消失 / 被停止时调用）。 */
export function clearCurrent() {
  current = null;
}

/** 某个 serial 对应的模拟器进程记录。 */
export function getProcess(serial) {
  const record = processes.get(String(serial));
  return record === undefined ? null : { ...record };
}

/** 记录一次模拟器启动（serial → pid/avd/日志）。 */
export function setProcess(serial, info) {
  if (typeof serial !== 'string' || serial === '') return;
  processes.set(serial, { serial, ...info });
}

/** 删除某台设备的进程记录（停止后调用）。 */
export function deleteProcess(serial) {
  processes.delete(String(serial));
}

/** 当前记录的所有模拟器进程。 */
export function listProcesses() {
  return [...processes.values()].map((record) => ({ ...record }));
}

/** 记录最近安装的包名（空串表示没装过）。 */
export function rememberPackage(packageName) {
  lastPackage = typeof packageName === 'string' ? packageName : '';
}

/** 最近安装的包名（空串表示未知）。 */
export function getLastPackage() {
  return lastPackage;
}

/** 当前设备记录的完整空值形状（结果构造器也用它）。 */
export function emptyDevice() {
  return { serial: '', avd: '', pid: 0, logFile: '', startedAt: 0 };
}

/** 重置全部状态（测试用；生产代码不应调用）。 */
export function resetState() {
  current = null;
  processes.clear();
  lastPackage = '';
}
