# VERIFICATION — dsh-ego-local-browser v1.0.2

> 本文件是验收证据索引。A = 模块/服务层（重启前已完成），B = 真实宿主层（本次完全重启后实测）。
> 证据原始文件都在 `E:\AI\DeepSeek\workspace\local-browser\evidence\`；
> GitHub 仓库：https://github.com/WJPGKZ/dsh-ego-local-browser

## A. 模块/服务层（已完成，可复现）

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| A1 | 加载冒烟：模块导出 / 35 工具注册 / gateway 路由 / env 接线 / home 布局 / 白名单 / config | **33/33 PASS** | `loadtest\harness.mjs` |
| A2 | 真实 Chrome 同步：555 cookies → 白名单保留 23（无 github 时）/ 31（含 github 时）、删除 532/524、非白名单残留 0、失败 0 | **12/12 PASS** | `lead-sync.txt`、`A-sync.json` |
| A3 | 认证字段值长度（绝不输出值）：SID / `__Secure-1PSID` / `__Secure-3PSID` = 153，HSID/SSID = 17，APISID 系 = 34 | PASS | `A-sync.json` |
| A4 | 源 profile 只读：Local State + Cookies 的 size/mtime/sha256 同步前后完全一致 | PASS | `A-sync.json`、`lead-sync.txt` |
| A5 | 单域白名单：555 → 9，remaining 0 | PASS | `A-trim-one.json` |
| A6 | 目标 profile 重开浏览器复核：23 条、非白名单 0 | PASS | `A-sync.json` |
| A7 | doctor：profile/文件数/cookie 统计/调试端口字段/源 busy，不改写同步状态 | 25/25 PASS | `A-doctor.json` |
| A8 | 运行时 paths env：`EGO_LOCAL_HOME` / `EGO_LINUX_STATE_DIR` / `EGO_LINUX_PROFILE` | 13/13 PASS | `A-paths.json` |
| A9 | `--import-chrome-profile` 最小复制（只 Local State + Cookies + sidecar） | 31/31 + 15/15 PASS | `A-import-profile*.json/txt` |
| A10 | 源锁/占用显式失败（source-locked/target-busy/local-state-missing/cookies-missing） | PASS | `A-errors.json` |
| A11 | 错误码形状（无 cookie 值泄漏） | 28/28 PASS | `A-errors.json` |
| A12 | home 路径硬边界（只允许 `E:\AI\DeepSeek\data\`） | 23/23 PASS | `A-paths-restriction.json` |
| A13 | 备份策略：失败即 fatal、保留 2 份 | 13/13 PASS | `A-backup.json` |
| A14 | 锁 owner：活 PID/监听端口/歧义锁 → `profile-busy` 且不删锁 | 9/9 PASS | `A-lock-owner.json` |
| A15 | 契约形状（导出/报告字段/新增字段） | 35/35 PASS | `A-conformance.json` |
| A16 | 与 local-service 集成：status→sync→doctor→env | 7/7 PASS | `A-integration-lead-service.json` |
| A17 | 客户端设置页（vm 渲染/点击/fetch mock/卸载/过期响应） | 92/92 PASS | `B-client-smoke.txt` |
| A18 | 性能：532 条删除 ~8.3s→~4.4s（6 路受限并发）；整次同步 10.95s→**7.0~7.1s** | PASS | `A-sync.json` |

## B. 真实宿主层（2026-10-17 15:52 完全重启后实测）

| # | handoff 验收项 | 结果 | 证据 |
|---|---|---|---|
| B1 | node_modules / dependencies / `dsh.profile.bundles` 三处一致 | ✅ dep=`file:...dsh-ego-local-browser-1.0.2.tgz`，bundles 含项，node_modules 版本 1.0.2；旧插件保留且 `disabled: true` | profile package.json / cordis.patch.yml |
| B2 | 工具表出现 `ego_*` 全套 + 诊断工具 | ✅ 35 个 ego_*（含 `ego_local_doctor` / `ego_local_sync`） | `ego_help(tools)` 输出 |
| B3 | `ego_status` / doctor 报 profile 路径与调试端口字段 | ✅ `ego_status` available=true；doctor 报 home/profile/state、debugPort 字段、源浏览器 Chrome 155；agent 浏览器在用时 running=true | 本会话工具输出 |
| B4 | 目标 profile 里 Local State/Cookies 存在，cookie>300、empty<5 | ✅ boot autoSync: total=555 / empty=1 / kept=31；Local State 18792 B、Cookies 393216 B | `local-browser.json`、doctor |
| B5 | 白名单裁剪后只剩白名单域 | ✅ trim.totalBefore=555 → after=31，`remainingNonAllowlisted=0`，byDomain 只含 cityu/exlibris/nih/google.com.hk/github.com | `local-browser.json` |
| B6 | `SID` / `__Secure-1PSID` 长度 > 0（只打印长度） | ✅ SID=153、`__Secure-1PSID`=153、`__Secure-3PSID`=153、NID=335、HSID/SSID=17 | doctor 输出 |
| B7 | 打开白名单站点，如实记录登录态 | ✅ 页面可加载：cityu.edu.hk、julac-cuh.primo.exlibrisgroup.com、www.google.com.hk、pubmed.ncbi.nlm.nih.gov、github.com。**登录态**：github.com = 已登录（`WJPGKZ`）；CityU/JULAC = 未登录（cookie 已带过去，但 Okta SSO 要求重新登录；点 Sign in 会正常跳转 auth.cityu.edu.hk）；Google = 未登录（显示"登录"，与 handoff 中的疑似会话校验一致）；PubMed 无需登录 | 本会话浏览器实测 |
| B8 | C: 不新增文件；目标 profile 全在 E 盘 | ✅ C: Chrome 目录文件数 11770（与装入前一致）、字节数 1,016,379,634 完全一致；Edge 目录文件数 14315 一致（字节 +1,131 B，为 Edge 自身后台写入，非本插件）。插件 home 171 MB 全部在 `E:\AI\DeepSeek\data\dsh-ego-local-browser` | `disk-baseline.json`、`disk-after.json` |
| B9 | 源 profile size/mtime 不变 | ✅ `Local State` sha256=aec2cae7…、`Cookies` sha256=78c31cbd…、Preferences 未变，全部与装入前一致 | `disk-after.json` |
| B10 | 回滚步骤 | ✅ `docs/ROLLBACK.md`（卸载新版/启用旧版/删数据/重启），本轮未实际卸载 | 文档 |
| B11 | 设置页「本地浏览器」可用 | ✅ 客户端 live 槽位 occupant：`registrant=dsh-ego-local-browser, id=ego-local-browser, order=61, active=true`；client smoke 92/92。截图未取：DSH Web 需要宿主打印的带 token URL，agent 浏览器无法复用用户 GUI 会话（不是插件问题） | Client Slots inspect |
| B12 | 用插件浏览器能力发布 GitHub | ✅ agent 浏览器（登录态 `WJPGKZ`）打开 github.com/new 创建仓库，再用本机凭据推 55 个文件；仓库 https://github.com/WJPGKZ/dsh-ego-local-browser 已可访问、README 正常渲染 | `E2E-github-repo.png`、`E2E-github-readme.png` |

## C. 已知限制 / 诚实记录

- **CityU / JULAC / Google 未登录**：cookie 已按白名单搬过去，但这些站点（Okta SSO / Google 会话校验）不接受克隆会话；
  需要时在 agent 浏览器窗口里手动登录一次，或先退出 Chrome 后 `ego_local_sync` 再重试。
- **GitHub 已登录**：github.com 的 cookie 克隆有效，本次发布即复用了该登录态，无需额外登录。
- Edge 源未做完整 E2E（Edge 当时在运行，只覆盖检测/解析路径）。
- 设置页截图未取：DSH Web 需要宿主打印的认证 URL，agent 浏览器不能复用用户 GUI session；
  槽位注册与组件 smoke 测试已覆盖。
- cookie 值读取拦截是工具入口文本防护（纵深防御），不是沙箱。
- v1.0.1 的 doctor 文字摘要里 profile 文件大小显示 `undefined`（JSON 数据正确）；v1.0.2 已修，
  已装入 profile，**下次重启生效**（不影响本会话已验收的同步/诊断行为）。

## D. Edge 源实测限制（2026-10-17，CityU 登录态在 Edge 的场景）

用户说明 CityU 的 AIMS/Canvas 登录在 Edge。实测把源切到 Edge 后：

- rowserSource=edge 的同步流程本身正常（Edge 关闭 → 最小复制 Local State 72624 B + Cookies 458752 B、
  snapshotConsistent=true），但临时 Edge 实例通过 CDP 只读到 **19 条明文 cookie**（Bing/MSN 基础项），
  Edge cookie 库中 **758 个 v20 加密项无法解密**。
- 原因：Edge 155 使用微软 **Aster App-Bound Encryption**（os_crypt.aster_app_bound_encrypted_key），
  加密与 Edge 运行环境绑定；复制 profile 后解不开。cookie 表中 host_key/name 为明文，
  可确认 Edge 里确实有 CityU 相关 cookie（.cityu.edu.hk 25、uth.cityu.edu.hk 4、
  sso.canvaslms.com 1、cityuhk-lms.ap.panopto.com 1 等），但值不可读。
- 处理：按用户指示不再追 Edge 登录态，已 **回退到 Chrome 源**并重新同步成功
  （555 → 白名单保留 31，snapshotConsistent=true；GitHub 登录态实测仍有效 WJPGKZ）。
- 结论：本机 rowserSource 保持 **chrome**；Edge 仅可作 agent 浏览器二进制，不作登录态来源。