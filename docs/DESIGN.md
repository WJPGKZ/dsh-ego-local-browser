# dsh-ego-local-browser · 设计说明（DESIGN）

> 本插件是 [`dsh-ego-browser@0.8.6`](https://github.com/Fisfzy/dsh-ego-browser)（MIT）的本地浏览器 fork。
> 目标：让 agent 用**用户本机已安装的 Chrome / Edge 可执行文件**，带着**用户真实的登录态**，
> 提供同一套 32 个 `ego_*` 浏览器自动化工具 + 实时观察窗，并新增诊断/同步能力。
>
> 本文记录"为什么这么做"，所有数字来自本机实测（Windows 11 build 26200 / Chrome 155.0.8059.80 /
> Edge 155.0.4283.45 / DSH 桌面 0.2.1-rc.1 / node v24.21.0）。

---

## 1. 关键约束：为什么不能直接接管用户日常那个 Chrome

### 1.1 默认 profile + 远程调试端口 = 失败

Chrome 136 起，官方禁止在**默认 user-data-dir** 上开启远程调试（防 cookie/会话被脚本窃取）：

```powershell
chrome.exe --remote-debugging-port=9222
# → 端口从未监听
Get-NetTCPConnection -LocalPort 9222 -State Listen   # 0 条
Invoke-WebRequest http://127.0.0.1:9222/json/version  # 连接失败
```

**任何插件都绕不过这条产品级加固**——这不是配置问题，而是 Chrome 的硬行为。

### 1.2 非默认 profile + 调试端口 = 成功

```powershell
chrome.exe --user-data-dir=E:\AI\DeepSeek\data\cdp-test\profile --remote-debugging-port=9333
# → 端口打开；ws://127.0.0.1:9333/devtools/browser/<uuid> 可连
```

所以 agent 浏览器必须跑在**独立的 user-data-dir** 上，本插件的目标目录是：

```
E:\AI\DeepSeek\data\dsh-ego-local-browser\profile
```

### 1.3 但独立 profile 默认没有登录态 —— 怎么把登录态搬过来

Chrome 的 cookie 自 v20 起使用 **App-Bound Encryption**：密钥材料在 `<User Data>\Local State`
的 `os_crypt.app_bound_encrypted_key` 里，由系统 DPAPI + Chrome 自身路径绑定保护。
**只复制 `Cookies` 数据库而不复制 `Local State`，认证类 cookie（v20）永远解不出来。**

实测（把源 profile 的两个最小文件复制到非默认目录，再用同一个 chrome.exe 启动）：

| 复制内容 | cookie 总数 | 空值数 | 认证 cookie 结果 |
|---|---|---|---|
| 只复制 `Default\Network\Cookies` | 有库但 v20 解不开 | — | `SID` / `__Secure-1PSID` 读不出真实值 |
| **`Local State` + `Default\Network\Cookies`** | **555** | **1** | `SID`=153 字符 ×2、`__Secure-1PSID`=153 ×2、`APISID/SAPISID`=34、`HSID/SSID`=17 —— **全部可解密** |

结论（本插件的核心机制）：

- 复制 **`<源 User Data>\Local State`** → `<目标>\Local State`
- 复制 **`<源 User Data>\<profile>\Network\Cookies`** → `<目标>\Default\Network\Cookies`
- 用**同一个** `chrome.exe`（同一个写入者身份）启动目标 profile

> 注意：源 profile 有 962 MB / 11,700 文件，**绝不整目录复制**；只复制上面两个文件
> （本机实测 20,815 B + 393,216 B）。若源 Chrome 正在运行、库有 `-wal`/`-shm`，
> 插件会额外带上它们以获得更一致的活动快照，并在报告里注明。

### 1.4 开源基线的两个已知盲点

`Fisfzy/dsh-ego-browser` 的 `ego_login_import` 走的是"临时 headless 实例 + CDP 逐 cookie 读"路线，
其失败点是 App-Bound 解密与默认 profile 调试端口限制的组合；它自带的
`--import-chrome-profile` 又只 `cp(Default)`、漏掉 `Local State`。本 fork 直接改掉这两处：

1. 插件启动/同步时走 **最小文件复制（含 Local State）**，不再依赖逐 cookie 读；
2. runtime 的 `--import-chrome-profile` 也补上 `Local State` 并显式处理"源被占用"。

---

## 2. 本插件的架构

```
DSH Host (lib/index.js, Cordis 插件)
├─ lib/local-service.mjs          ← 本 fork 新增：home/配置/白名单/status/sync/doctor 服务
├─ lib/profile-bootstrap.mjs      ← 本 fork 新增：浏览器探测、源 profile 解析、busy 检测、
│                                    最小文件复制、allowlist 裁剪、sync/doctor 报告
├─ lib/local-cdp.mjs              ← 本 fork 新增：起临时 headless Chrome + 原生 WebSocket CDP
│                                    （getCookies / deleteCookies / trimCookies / cookieStats）
├─ lib/index.js                   ← 在基线 bundle 上接线：EGO_* env、Config、2 个新工具、
│                                    /ego/api/local-* 网关、ffmpeg 缓存重定向
├─ lib/client.js                  ← 在基线 client 上加「本地浏览器」设置页（settings.section）
└─ runtime/ego-linux              ← 基线 vendored ego-lite（MIT）；paths.mjs 支持 EGO_LOCAL_HOME，
                                     bin/ego-browser.mjs 的 --import-chrome-profile 补 Local State

Chrome/Edge（用户已装，源 profile 只读）
        │ 只读复制 2 个文件
        ▼
E:\AI\DeepSeek\data\dsh-ego-local-browser\
├─ profile\        ← agent 浏览器 --user-data-dir（非默认目录 → 调试端口可用）
├─ state\          ← runtime 状态（browser.json / ego-cast.json / task-spaces.json）
├─ allowlist.json  ← 域名白名单（热读）
├─ local-config.json ← 设置页写入的源浏览器选择等
├─ local-browser.json ← 上次同步结果摘要（不含 cookie 值）
├─ backups\        ← 同步前旧目标 Cookies 备份
└─ cache\ffmpeg\   ← FFmpeg 缓存（基线默认 ~170MB 会落 C:\Users\<user>\.dsh）
```

**环境变量注入**（插件挂载时写入 host process.env，并叠加进每个 ego 子进程 env）：

| 变量 | 值 | 作用 |
|---|---|---|
| `EGO_LOCAL_HOME` | `<home>` | runtime 的 DATA_DIR / STATE_DIR 根 |
| `EGO_LINUX_PROFILE` | `<home>\profile` | runtime 的 `--user-data-dir` |
| `EGO_LINUX_STATE_DIR` | `<home>\state` | runtime + ego-cast worker 的状态目录 |

这样既有 runtime 的 `paths.mjs`、worker、idle reaper、`ego_auth_flush`、`ego_doctor`
都指向 E 盘，而不是 `%LOCALAPPDATA%\ego-lite-linux`。v1.0.1 起还会把子进程的 `TMP`/`TEMP`
指向 `<home>\tmp`，让 vendored runtime 的 `os.tmpdir()` 临时文件也不落到别的盘。

> v1.0.1 的加固（Copilot 评审后）：`--import-chrome-profile` 改为最小复制；
> `ego_login_import` 改道安全同步；cookie 值读取在 `ego_cdp/ego_cli/ego_script` 入口拦截；
> home 强制 `E:\AI\DeepSeek\data\`；sync/doctor/status 服务级互斥 + 统一 stop→sync→verify；
> live copy 默认关闭并做前后指纹校验；备份失败即同步失败；删除 cookie 改受限并发（~11s → ~7.1s）。
> 完整清单见 [CHANGELOG-v1.0.1.md](CHANGELOG-v1.0.1.md)。

---

## 3. 同步（sync）流程

```
ego_local_sync / 设置页「同步登录态」/ 首次挂载 autoSync
  1. resolveSource：按 browserSource(auto|chrome|edge) 选 browser + User Data + profile
  2. probeSourceBusy：进程探测（Win32_Process 过滤 --type=/crashpad）+ lockfile/SingletonLock
     - 源在跑：只读复制照做，但报告 busy=true + warning（文件被锁 → 明确报 source-locked，绝不静默）
  3. 备份目标旧 Cookies → backups\backup-<ts>\
  4. 最小复制：Local State、<profile>\Network\Cookies（+ 存在的 -wal/-shm）
  5. 起临时 headless Chrome（同款 exe、--user-data-dir=<目标>）→ CDP
     Network.getAllCookies → 非白名单逐个 Network.deleteCookies → 复核 remainingNonAllowlisted
  6. Browser.close 优雅退出（Chrome 落盘 cookie jar）
  7. 写 local-browser.json（时间、源、计数、摘要），返回 SyncReport
```

**域名白名单**：`allowlist.json`，默认
`cityu.edu.hk`、`exlibrisgroup.com`、`nih.gov`、`google.com`、`google.com.hk`
（含子域）。用户可在设置页一行一个编辑。裁剪发生在复制之后、首次用于浏览器之前，
因此目标 profile 一开始就只持有白名单域。

**绝不输出 cookie 值**：SyncReport / DoctorReport 只含名字、域、路径、长度、数量。

---

## 4. 诊断（ego_local_doctor）

一次调用输出：

- 目标 profile 路径、是否存在、文件数/字节数、Local State/Cookies 大小与 mtime、上次同步时间
- cookie 统计：总数 / 空值 / 保留数；每个白名单域的 cookie 数 + 认证字段（SID、
  `__Secure-1PSID`、`__Secure-3PSID`、HSID、SSID、APISID、SAPISID…）的**值长度**
- agent 浏览器：`state\browser.json` 的 running/port/headless/binary + `/json/version` 可达性
- 源浏览器：探测到的 Chrome/Edge 路径+版本、解析出的源 profile、是否正在运行（pids/lockFiles）
- runtime：egoBin、node 版本、platform/arch
- warnings

实现要点：主浏览器在跑 → 附加现有 CDP 端口（不重启浏览器）；没跑 → 用目标 profile 起临时
headless 实例读统计（不改同步状态、不写 local-browser.json）。

---

## 5. 双浏览器支持

- `detectBrowsers()` 探测 Chrome 与 Edge 的可执行文件（ProgramFiles / ProgramFiles(x86) /
  LOCALAPPDATA 三类目录）与标准 User Data 目录；
- `browserSource` 决定**源**与**agent 浏览器二进制**（设置页可选 auto/chrome/edge）；
- `browserBinary` / `sourceUserDataDir` / `sourceProfileDir` 可显式覆盖；
- 源 profile 目录名来自 `Local State` 的 `profile.info_cache`（`last_used` 优先），
  不硬编码 `Default`；
- Edge 的结构与 Chrome 相同（`Local State` + `Default\Network\Cookies`），复用同一套复制/裁剪逻辑。

---

**Edge 源已知限制（v1.0.2 实测）**：Edge 155 的 Local State 同时包含标准 App-Bound key 与微软
Aster App-Bound key（os_crypt.aster_app_bound_encrypted_key）。复制 Edge profile 到目标目录后，
临时 Edge 实例只能解出 19/758 条明文 cookie，认证 cookie 无法解密。因此本机把
rowserSource 保持为 **chrome**；Edge 仅作为可选的 agent 浏览器二进制，不作为登录态来源。
（Chrome 的复制方案实测可完整解密 555 条。）
## 6. 设置页「本地浏览器」

`settings.section`（DSH 0.2.x 的顶部设置页槽位）新增一页，`id=ego-local-browser`：

- 目标 profile 路径 / 上次同步摘要 / 检测到的源浏览器
- 源浏览器选择（auto/chrome/edge）
- 「从系统浏览器同步登录态」按钮（先停 agent 浏览器 → 同步 → 下次 ego_* 自动冷启动）
- 白名单编辑（一行一个域名）
- 「打开诊断」→ DoctorReport 的人类可读摘要 + 原始 JSON
- 风险提示：**同步后 agent 持有这些域名的活会话，等同于用户已登录**

前端通过同源 `POST /ego/api/local-*` 调用 Host（与基线设置页同一 transport）；DSH 0.2.x 的
`/ego/api/set` 对自定义字段可能"报成功但值不变"，因此本地浏览器配置单独存
`local-config.json`，不走 settings namespace。

---

## 7. 安全与风险（必读）

1. **同步后，agent 持有这些域名的活会话**，等同于用户已登录。这是本插件的核心能力，也是最大风险。
   只把**你信任的域名**放进白名单；不要用通配或整站全量导入。
2. 站点可能因设备指纹/会话校验拒绝克隆会话（Google 已观察到疑似此现象）。凭据搬运机制可用
   不等于每个站点都接受克隆会话 —— 以 `ego_local_doctor` 与站点实测为准。
3. 源浏览器若正在运行，cookie 库可能被锁/处于 WAL 状态；插件会如实报告 `source.busy`，
   文件被锁时返回明确错误，**不会静默失败**。
4. Windows 上 ego-lite 是社区移植（非官方支持），复杂多步流程稳定性弱于 macOS。
5. 登录态过期后需要重新 `ego_local_sync`（或在 agent 浏览器里重新登录一次）。
6. 源 profile **始终只读**：插件不修改、不删除、不清洗源目录；所有写入都在 `<home>` 下。
7. 磁盘纪律：本机要求所有数据落 E 盘（含 FFmpeg 缓存与临时目录），插件显式重定向了
   基线默认会写到 `C:\Users\<user>\.dsh` 与 `%LOCALAPPDATA%\ego-lite-linux` 的路径。

---

## 8. 已知差异 / 继承自基线的行为

- 保留基线全部 32 个 `ego_*` 工具、观察窗、CDP 控制面；新增 `ego_local_doctor`、`ego_local_sync`。
- `ego_login_import`（基线的逐 cookie 导入）保留但**不推荐**用于认证站点，同步请用 `ego_local_sync`。
- 基线的 `settings.plugin.item` 注册在 DSH 0.2.x 已退役，本 fork 新增的 `settings.section` 才是
  当前版本真正可见的设置页。
- `runtime/PATCHES.md` 记录 vendored runtime 相对上游的全部本地改动（含本插件的两处）。

---

## 9. 回滚

见 `docs/ROLLBACK.md`（卸载插件 + 删除目标数据 + 恢复旧插件的一键步骤）。
