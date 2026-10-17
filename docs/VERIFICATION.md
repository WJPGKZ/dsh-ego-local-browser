# VERIFICATION — dsh-ego-local-browser v1.0.1

> 本文件是验收证据索引。分两层：
> - **A. 模块/服务层**（本机已实测通过，重启前可复现）
> - **B. 真实宿主层**（需要 DSH 完全重启装入新 bundle 后，用 `ego_*` 工具 + 设置页 + 真站点验证）
>
> 证据原始文件都在 `E:\AI\DeepSeek\workspace\local-browser\evidence\`。

## A. 模块/服务层（已完成，可复现）

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| A1 | 加载冒烟：模块导出 / 34+ 工具注册 / gateway 路由 / env 接线 / home 布局 / white-list / config | **33/33 PASS** | `lead` 自测：`loadtest\harness.mjs` |
| A2 | 真实 Chrome 同步：555 cookies → 白名单保留 23、删除 532、非白名单残留 0、失败 0 | **12/12 PASS**（lead）/ A-sync 同数字 | `lead-sync.txt`、`A-sync.json` |
| A3 | 认证字段值长度（绝不输出值）：SID / `__Secure-1PSID` / `__Secure-3PSID` = 153，HSID/SSID = 17，APISID 系 = 34 | PASS | `A-sync.json` |
| A4 | 源 profile 只读：Local State + Cookies 的 size/mtime/sha256 同步前后完全一致 | PASS | `A-sync.json`、`lead-sync.txt` |
| A5 | 单域白名单：555 → 9（only cityu 子域），remaining 0 | PASS | `A-trim-one.json` |
| A6 | 目标 profile 重启后复核：重新起浏览器读回 23 条、非白名单 0 | PASS | `A-sync.json` |
| A7 | doctor：profile/文件数/cookie 统计/调试端口字段/源 busy，不改写同步状态 | 25/25 PASS | `A-doctor.json` |
| A8 | 运行时 paths env：`EGO_LOCAL_HOME` / `EGO_LINUX_STATE_DIR` / `EGO_LINUX_PROFILE`，无 env 回退原路径 | 13/13 PASS | `A-paths.json` |
| A9 | `--import-chrome-profile` 最小复制（只 Local State + Cookies[+sidecar]），拒绝 Preferences/Bookmarks/History/Login Data/Extensions | 31/31 + 15/15 PASS | `A-import-profile.json/.txt`、`A-import-profile-minimal.json` |
| A10 | 源锁/占用的显式失败：source-locked / target-busy / local-state-missing / cookies-missing 均非 0 退出且不改目标 | PASS | `A-import-profile.txt`、`A-errors.json` |
| A11 | 错误码形状（无 cookie 值泄漏）：source-userdata-missing / source-profile-not-found / source-browser-not-found / source-locked / invalid-path / profile-busy / backup-failed | 28/28 PASS | `A-errors.json` |
| A12 | home 路径硬边界：仅允许 `E:\AI\DeepSeek\data\` 之下；拒绝相对/UNC/其它盘/root 外/`..`/空 | 23/23 PASS | `A-paths-restriction.json` |
| A13 | 备份策略：失败即 fatal（旧库不被覆盖），保留 2 份 | 13/13 PASS | `A-backup.json` |
| A14 | 锁 owner：活 PID lockfile / 监听端口 / 歧义锁 → `profile-busy` 且不删锁；死锁才清理 | 9/9 PASS | `A-lock-owner.json` |
| A15 | 契约形状：导出/报告字段/新增字段（ALLOWED_HOME_ROOT、selectionReason、snapshotConsistent） | 35/35 PASS | `A-conformance.json` |
| A16 | 与 Lead local-service 集成：status→sync(555/532/23)→status(lastSyncAt)→doctor→applyRuntimeEnv | 7/7 PASS | `A-integration-lead-service.json` |
| A17 | 客户端设置页（vm 渲染 + 点击 + fetch mock + 卸载/过期响应）：92/92 PASS | PASS | `B-client-smoke.txt`、`B-client-diff.patch` |
| A18 | 性能：逐条删除 532 条 ~8.3s → 受限并发 ~4.4s；整次同步 ~10.95s → **7.12s** | PASS | `A-sync.json`（durationMs） |

关键数字（v1.0.1）：`total=555, empty=1, kept=23, deleted=532, remainingNonAllowlisted=0, failures=0,
snapshotConsistent=true, selectionReason=last-used, duration≈7.1s`。

## B. 真实宿主层（重启后补）

| # | handoff 验收项 | 状态 | 证据 |
|---|---|---|---|
| B1 | `dsh plugin --profile desktop add` 后 node_modules / dependencies / `dsh.profile.bundles` 三处一致 | 待重启后复核（安装已写入 tarball 依赖） | 待补 |
| B2 | 刷新页面工具表出现 `ego_*` 全套 + `ego_local_doctor`/`ego_local_sync` | 待重启后 `cordis_inspect Tool.listTools` | 待补 |
| B3 | `ego_status` / `ego_local_doctor` 报目标 profile 路径 + 调试端口 | 待补 | 待补 |
| B4 | 引导：目标 profile 里 Local State/Cookies 存在，cookie>300、empty<5 | 待补（boot autoSync 或显式 sync） | 待补 |
| B5 | 白名单裁剪后只剩白名单域 | 待补 | 待补 |
| B6 | SID / `__Secure-1PSID` 长度 > 0（只打印长度） | 待补 | 待补 |
| B7 | 打开白名单站点（cityu / pubmed / google），如实记录登录态 | 待补 | 待补 |
| B8 | C: 不新增文件；目标 profile 全在 E:\AI\DeepSeek\data 下 | 待补（baseline 已有 `disk-baseline.json`） | 待补 |
| B9 | 源 profile size/mtime 不变 | 待补（重启后复跑 snapshot） | 待补 |
| B10 | 回滚步骤可执行 | 文档已写 `docs/ROLLBACK.md` | 待演练 |
| B11 | 设置页「本地浏览器」可用（同步/白名单/诊断/风险提示） | 待补截图 | 待补 |
| B12 | 用插件浏览器能力发布到 GitHub | 待补（需要时请用户登录） | 待补 |

## C. 已知限制 / 诚实记录

- 站点是否接受克隆会话未在 v1.0.1 重启前验证（Google 曾观察到疑似设备/会话校验）；不粉饰，重启后逐个记录。
- Edge 源未做完整 E2E（Edge 当时在运行，只覆盖了检测/解析路径）。
- 源浏览器运行中的"真实并发写"无法在只读真源上稳定制造；用活 PID lockfile / 监听端口 / 非空 sidecar 三种可控场景覆盖。
- cookie 读取拦截是工具入口的文本防护（纵深防御），不是沙箱；动态拼接仍可能绕过，README 已写明。
- DSH 升级后需要重新核对 loader/bundle 契约（本次安装已验证一次 tarball `file:` 安装路径）。
