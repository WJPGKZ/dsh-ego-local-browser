# Changelog

本文件记录 **dsh-ego-local-browser** 的版本历史（GitHub 仓库：`WJPGKZ/dsh-ego-local-browser`）。
更早的详细记录见 [`docs/CHANGELOG-v1.0.1.md`](docs/CHANGELOG-v1.0.1.md) 与 [`docs/CHANGELOG-v1.1.0.md`](docs/CHANGELOG-v1.1.0.md)。

## v1.1.7 — 2026-10-18

### 稳定性

- bridge 增加固定身份、owner nonce 心跳租约和重复端口保护，避免多个 DSH 实例互相接管或留下残留进程。
- bridge 宿主退出、插件 dispose/HMR 或 heartbeat 超时后自动清理；手动启动的无 owner nonce bridge 保持兼容。
- 新增 bridge 稳定性回归测试，并补充 client bundle 不引入全 body `MutationObserver` 的保护。
- 修复发布元数据与真实浏览器扩展 manifest 的 JSON 可解析性，确保插件包可安装。

### 验证限制

- 本环境未提供 Node.js，因此无法执行 `node --test` 与 `node --check`；已执行 `git diff --check` 和 UTF-8 JSON 结构检查。

## v1.1.6 — 2026-10-17

### 修复

- **修复：DSH 退出后本地浏览器 bridge 残留，导致官方更新 / 官网覆盖安装无法替换 `DeepSeek Harness.exe`（NSIS 静默安装失败）的问题。**
  - `real-browser/bridge/server.mjs` 新增 owner watchdog：宿主进程（`dsh-desktop-host`）消失后 ~0.75 秒内自动退出；`ESRCH` 判为宿主已退出，`EPERM` / 未知异常保持存活并记录日志（60 秒限频，避免误杀与刷屏）。
  - `lib/real-browser-tools.mjs`：跟踪本宿主 spawn 的 bridge 子进程，并通过 `ctx.effect(() => () => stopRealBrowserBridge())` 在插件 dispose / HMR 时主动结束它；对非本宿主启动的已有 bridge 不做 kill。

### 评审

- 上述生命周期改动经 **GitHub Copilot CLI 三轮代码评审**：首轮发现并修正 `ctx.effect` disposer 写法错误（否则 dispose 时清理不会执行）；第二轮补充异常日志限频；最终结论 **“可接受”**。

### 验证

- 隔离测试：宿主存活时 bridge 正常工作，宿主退出后 bridge 自动退出、端口关闭。
- 真实退出 DSH 后：bridge 进程消失、无孤儿 `DeepSeek Harness.exe` 进程；任务管理器干净。
- 重启后 `ego_real` 功能正常，bridge 稳定存活（watchdog 不误杀）。

### 升级说明

- 覆盖安装 / 更新后**重启一次 DSH** 即可生效；数据与登录态不受影响。
- 版本 1.1.4 / 1.1.5 为本地迭代中间版本（1.1.4 引入 watchdog；1.1.5 修正 dispose 清理与异常分类），GitHub 以本 **1.1.6** 作为最终版本。

## v1.1.3 — 2026-10-17

- docs-only 发布：CSP 限制说明、鲸鱼娘图标等文档改动。

## v1.1.2 — 2026-10-17

- 修复 `ego_real` 跨 client 路由：命令不再落到错误的浏览器（Chrome/Edge 同时连接时）。

## v1.1.1 — 2026-10-17

- 修复 `ego_real` 工具的渲染契约。

## v1.1.0 — 2026-10-17

- 新增**真实浏览器模式**：直接驱动任务栏里的 Chrome/Edge（真实 profile/登录态），MV3 扩展 + 本机 loopback bridge，鲸鱼娘光标、点击/填写/读取/截图等 `ego_real` 操作；详见 `docs/CHANGELOG-v1.1.0.md`。

## v1.0.2 — 2026-10-16

- 修复 `ego_local_doctor` summary 大小统计；记录真实环境验收结果。

## v1.0.1 — 2026-10-16

- 本地 Chrome/Edge 登录态 fork 首个版本（经 GitHub Copilot review 后加固），详见 `docs/CHANGELOG-v1.0.1.md`。
