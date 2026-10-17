# Changelog

本文件记录 **dsh-ego-local-browser** 的版本历史（GitHub 仓库：`WJPGKZ/dsh-ego-local-browser`）。
更早的详细记录见 [`docs/CHANGELOG-v1.0.1.md`](docs/CHANGELOG-v1.0.1.md) 与 [`docs/CHANGELOG-v1.1.0.md`](docs/CHANGELOG-v1.1.0.md)。

## v1.2.0 — 2026-10-18

### 真实浏览器优先 + 桥自启动

- **客户端身份**：扩展每次轮询上报 `clientId` 与 `role`（`config.json` 为 `real` | `agent`），
  桥按 clientId 区分实例，并在 `/status` 暴露 `clientId` / `role` / `byBrowser` 汇总；老扩展（无 clientId）
  按 `legacy:<browser>` 登记且默认 `role=real`，保持兼容。
- **agent 浏览器专用副本**：插件加载时 materialize `real-browser/extension-agent/`（`role: "agent"`），
  agent 浏览器应加载这一份，真实 Chrome/Edge 加载 `real-browser/extension/`。
- **真实优先路由**：`resolveBrowserRoute` / `selectClient` 只在 `role=real` 的客户端中选择；
  `role=agent` 的客户端仅在 `browserMode=agent` 时使用。每个动作返回 `clientId` / `clientRole` / `clientSelection`。
- **投递期固定**：命令携带 `clientId`，桥只投递给该实例；未带 clientId 的旧命令仍按浏览器名路由。
  修掉了"真实 Chrome 与 agent 浏览器抢同一条 `chrome` 通道"的竞态。
- **桥自启动**：新增 `autoStartBridge`（默认 `true`），插件 `apply()` 时即拉起桥；
  关闭后仍可由 `ego_real` 按需启动。设置页可改，`/ego/api/local-config` 可持久化。
- **诊断**：`ego_real_doctor` 增加 `clientDetails`（含角色）、`bridgeStarts`、`lastStartError`、`extensionAgentDir`。

### 修复

- `/status` 在 `byBrowser` 处把 `reduce` 的对象传给 `Object.fromEntries`，导致 500 `object is not iterable`。
- 稳定性测试的心跳请求缺少 token（403）；`policy.test` 期望未跟上 `clientRole` / `clientSelection`。

### 验证（Windows 11 / DSH 桌面 0.2.1-rc.2 / Chrome 155 / Edge 155）

- 三客户端并存（Chrome real + Chrome agent + Edge real）时，`ego_page_info` / `ego_real tabs` / `ego_js`
  在**不传 client** 的情况下全部命中真实 Chrome，agent 客户端一次未被选中。
- `client=edge` 命中真实 Edge 并复现 Canvas GE1362 四次 quiz 成绩；`client=chrome` 命中真实 Chrome 并复现 PASS CS1315 Assignment 1 最高 40/40。
- 桥自启动：插件加载后未调用任何 `ego_*` 即 `/status` 可达（`bridgeStarts: 1`）。
- `node --check` 全部改动文件通过；`node --test` **10/10**；提交内 0 删除。

## v1.1.8 — 2026-10-18

### 浏览器策略

- 普通页面类 `ego_*` 默认优先路由到用户任务栏里的真实 Chrome/Edge。
- 真实 bridge 未连接时，默认策略返回明确 `browserRoute` 诊断并安全回退 agent；`real-only` 拒绝回退，`agent` 强制使用隔离浏览器。
- 隔离任务空间、无人值守调用以及 CDP/网络/文件/任务空间专用工具保持 agent 模式，避免真实浏览器与隔离能力静默混用。
- 新增策略路由单元测试和设置页配置项。

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
