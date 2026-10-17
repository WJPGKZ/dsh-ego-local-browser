# CHANGELOG — v1.0.1（GitHub Copilot 评审后的加固）

> 来源：GitHub Copilot 对本插件 v1.0.0 的完整评审（报告见
> `E:\AI\DeepSeek\workspace\local-browser\copilot-review\review\COPILOT-REVIEW.md`，
> 会话记录 `...\review\copilot-session.md`）。
> 下面记录**采纳**的条目、**结合本机配置调整后**的做法，以及**未采纳**的条目和理由。

## 采纳并实现

### P0-1 运行时 `--import-chrome-profile` 不再递归复制整个 Default profile
- 旧行为：`cp(source/Default → PROFILE_DIR/Default, {recursive:true})`，会把书签/历史/扩展/其它凭据带进目标。
- 新行为：只复制 `Local State` + `<profile>\Network\Cookies`（+ 存在的 `-wal/-shm`；
  `-journal` 仅非空时），保留源锁检测与 `source-locked` / `local-state-missing` 错误码。
- 文件：`runtime/ego-linux/bin/ego-browser.mjs`。

### P0-2 `ego_login_import` 不再写源 profile
- 旧行为：把真实 `userDataDir` 通过 junction 当 `--user-data-dir` 起临时实例；Chrome 启动/退出会写
  `Local State`/Preferences/锁，违反"源 profile 只读"。
- 新行为：工具名保留（32 工具面不变），但实现改为调用本地安全同步管线
  （`local-service.sync()`：最小复制 + 白名单裁剪），参数保留但忽略；watch 面板的登录导入按钮同样改道。
- 文件：`lib/index.js`（`registerLoginImport`、`initCastServer` 回调）。
- 旧的 `importLoginCookies()` 已无任何调用点，标注为 **UNUSED / 禁止重新接线**。

### P0-3 cookie 值读取防护（escape hatch）
- 旧行为：`ego_cdp` / `ego_cli` / `ego_script` 可原样调用 `Network.getAllCookies` / `Storage.getCookies`
  并把值打印进工具结果，绕过"绝不输出 cookie 值"。
- 新行为：三个工具在入口做文本检查，命中 cookie-value 读取模式直接返回
  `cookie-read-blocked` 错误，并提示改用 `ego_local_doctor`（只给计数/长度）。
  这是纵深防御（可被动态字符串绕过），不是沙箱；本地浏览器管线本身不返回 cookie 值。
- 文件：`lib/index.js`（`assertNoCookieValueDump`）。

### P0-4 home 目录限制在 E 盘
- `E:\AI\DeepSeek\data\` 之外（C 盘、UNC、相对路径、`..` 逃逸）一律拒绝，错误码 `invalid-path`。
- 文件：`lib/profile-bootstrap.mjs`（`resolveLocalPaths` + `ALLOWED_HOME_ROOT`）。

### P1-1 源 profile 选择按 `last_used`
- 不再默认优先 `Default`；先选 `lastUsed === true`，再回退 `Default`，报告里记录选择原因。
- 文件：`lib/profile-bootstrap.mjs`。

### P1-2 同步并发：服务级互斥 + 统一 stop→sync→verify
- `status/sync/doctor/ensureReady` 共享一条异步锁链；`sync()` 内部先确认 agent 浏览器已停止
  （最多等 25s）再动 profile，否则返回 `agent-browser-running`。
- 工具、设置页网关、`ego_login_import`、启动 autoSync 全部走同一入口，不再有跨入口竞态。
- 文件：`lib/local-service.mjs`、`lib/index.js`（`setStopBackingBrowser` 注入）。

### P1-3 不删除活动锁
- `withProfileCdp()` 启动临时实例前先做 owner 检查：目标 profile 已有存活实例/端口可连通时
  返回 `profile-busy`，不再无条件删除 `Singleton*`/`lockfile`/`DevToolsActivePort`；只清理确认
  PID 已退出的 stale 文件。
- 文件：`lib/local-cdp.mjs`。

### P1-4 备份更严格
- 备份失败 → 同步失败（`backup-failed`），不再 warning 后继续覆盖；
  备份保留份数 5 → 2；备份目录固定在 E 盘 home 内。
- 文件：`lib/profile-bootstrap.mjs`。

### P1-5 Config 字段完整化
- 新增 `allowLiveCopy` 字段（默认 **false**，live copy 需显式开启），并进入
  Config schema / `resolveConfig` / gateway 白名单 / `createLocalBrowser.loaderConfig`。
- 文件：`lib/index.js`。

### P1-6 运行时临时目录重定向
- 每个 ego 子进程的 `TMP`/`TEMP`（以及 `EGO_LOCAL_TMP`）指向 `<home>\tmp`，
  避免 vendored runtime 的 `os.tmpdir()` 截图/下载临时文件落到其它盘。
- 文件：`lib/index.js`（`resolveEgoEnv`）、`lib/local-service.mjs`（建目录）。

### P1-7 live copy 更严格
- 默认拒绝 live copy；即使显式开启，也对源 `Local State`/`Cookies` 做前后 size+mtime 快照比对，
  不一致或存在非空 `-wal/-shm` 时返回 `source-locked`，报告附 `snapshotConsistent`。
- 文件：`lib/profile-bootstrap.mjs`。

### P1-8 网关加固
- 在既有 Origin 同源校验之外，拒绝 `Sec-Fetch-Site: cross-site / same-site`；
  JSON body 已有 16 KB 上限（基线 `readJsonBody`）。
- 文件：`lib/index.js`。

### P2 采纳项
- 同步删除改受限并发（默认 6 路，按 (domain, path, partitionKey) 分组），保持最终复核；
- 状态/配置写入改临时文件 + rename 原子替换；
- 客户端设置页异步动作加 generation/request token，卸载后不再 setState、过期响应丢弃。
- 文件：`lib/local-cdp.mjs`、`lib/profile-bootstrap.mjs`、`lib/local-service.mjs`、`lib/client.js`。

## 结合本机配置后调整 / 未采纳

| Copilot 建议 | 处理 | 理由 |
|---|---|---|
| P1-6 把 vendored `runtime/ego-browser/dist/out/index.js` 的 tmpdir 全改到 home | **未改 vendored 产物**，改为在宿主侧把 `TMP/TEMP` 重定向到 `<home>\tmp` | 改 dist 产物会破坏与上游/vendored 基线的一致性；本机 `TEMP` 本身已在 E 盘，重定向后更严格且无需动 dist |
| P1-8 要求 CSRF token / 一次性确认 | **部分采纳**：Origin + Sec-Fetch-Site + body 上限；未自造 token | DSH `webServer` 由宿主 session/鉴权层保护，自造 token 会与宿主升级耦合；同步动作已改为显式工具/设置页触发 |
| P2 离线改 SQLite cookie 库（替代逐条 CDP 删除） | **未采纳** | 直接改 Chrome SQLite 需自行实现 schema/WAL 一致性，风险高于收益；先用受限并发把 11s 降下来 |
| P2 备份加密/ACL | **部分采纳**：备份固定在 E 盘 home、保留 2 份、失败即同步失败；未做加密 | 本机是单用户工作站；加密会增加恢复复杂度。风险已写进 README（目录不要同步/分享到云盘） |
| 清理 `ego_login_import` 死代码 | **暂时保留**（标注 UNUSED） | 与上游 diff 对照仍有价值；已确认无调用点。后续可随上游版本一起删 |

## 验证状态

- 模块/工具级：见 `docs/VERIFICATION.md`（重启后补真实站点与 UI 证据）。
- 本轮改动后需要一次 **DSH 完全重启** 才会重新装载 bundle（宿主 bundle/解析快照机制）。
