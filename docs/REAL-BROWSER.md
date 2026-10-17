# 真实浏览器模式（Real Taskbar Browser Mode）

> v1.1.0 起，`dsh-ego-local-browser` 除了原来的「agent 浏览器（克隆登录态）」，
> 还提供**真实浏览器模式**：直接操作**你任务栏里的 Chrome/Edge 窗口**（真实 profile、真实登录态），
> 让 agent 的点击、填表、阅读**肉眼可见**，并用「鲸鱼娘」光标把动作指给你看。

## 1. 为什么需要扩展桥

| 尝试 | 结果（实测） |
|---|---|
| 在默认 profile 上开 `--remote-debugging-port` | **被拒绝**（Chrome 136+ 安全策略；Edge 155 同样） |
| 用 junction 指到真实 User Data 再开调试端口 | 端口能开，但 Edge 的 **Aster App-Bound 加密**只解出 40/758 条 cookie（真实登录 cookie 读不出来） |
| 复制 `Local State + Cookies` 到独立 profile | Chrome 可解（555 条），Edge **不可解**（Aster 绑定原始路径） |
| **扩展桥（本方案）** | ✅ 在你的真实浏览器内执行 DOM 动作，不复制 profile、不读 cookie、不开调试端口 |

## 2. 组件

```
real-browser/
├─ extension/            # MV3 扩展：background.js（长轮询 + 命令执行）
│  ├─ manifest.json      #     content.js（snapshot/click/fill/read/scroll/wait）
│  └─ icons/icon-*.png   #     鲸鱼娘图标 16/32/48/128
├─ bridge/
│  ├─ server.mjs         # 本机桥（身份校验、owner nonce 心跳租约、按浏览器客户端路由、超时/取消）
│  ├─ vision.js          # 鲸鱼娘光标 + 粉框高亮 + 可见阅读/点击/填写
│  ├─ cli.mjs            # 手动调试用 CLI（agent 工具 ego_real 内部走 HTTP，不依赖它）
│  └─ verify.mjs         # 17 项能力矩阵（chrome/edge 各跑一遍）
└─ tools/
   ├─ open-in-user-browser.mjs  # 从任务栏方式打开真实浏览器（无 --user-data-dir）
   └─ screen-capture.mjs        # 桌面截图（人工验收用）
```

- 桥只绑定 `127.0.0.1`，所有请求带固定本地 token；不监听外网。
- 桥状态 `/status` 会公开固定 `bridgeId` 与当前 `ownerNonce`。插件只接受正确身份的桥；对插件自己启动的桥还会校验 owner nonce，手动启动的无 owner nonce 桥保持兼容；同一端口已被占用时新桥以非零状态退出。
- 插件启动桥时传递 `EGO_REAL_BRIDGE_PORT`，并以 owner nonce 每约 2.5 秒发送 heartbeat；停止心跳后桥约 5 秒内自动退出，避免残留进程。
- 扩展只与 `http://127.0.0.1:18765/*` 通信（`host_permissions` 声明），不向任何远端上传数据。
- 桥/扩展都不读取 cookie 内容；它们操作的是**已登录页面的 DOM**。

## 3. 安装扩展（一次性）

1. **Chrome**：地址栏 `chrome://extensions/` → 右上「开发者模式」→「加载已解压的扩展程序」→ 选 `real-browser/extension`
2. **Edge**：地址栏 `edge://extensions/` → 左侧「开发人员模式」→「加载解压缩的扩展」→ 同一目录
3. 用 `ego_real action=status` 或 `ego_real_doctor` 检查：`clients` 里应出现 `chrome` / `edge`

> 不需要重启 DSH；扩展随浏览器启动自动连接。若浏览器重启后桥没连上，等 5-30 秒（MV3 service worker 唤醒）。

## 4. 工具

### 统一路由策略

普通页面类 `ego_*` 默认优先路由到已连接的真实 Chrome/Edge。真实 bridge 未连接时，
`browserMode=real` 会返回带 `browserRoute` 的 agent 结果并记录明确 fallback 原因；
不会把一次调用静默地拆成两个浏览器执行。`browserMode=real-only` 会在未连接时返回
`real-browser-required`；`browserMode=agent` 始终使用 agent 浏览器。

即使真实浏览器已连接，`isolateSpaces=true`、`unattended=true` 或需要 CDP/网络响应/
文件上传下载/任务空间的工具也保持 agent 模式。`ego_real` 和 `ego_real_doctor` 始终是
显式真实浏览器工具。

### `ego_real`

| action | 作用 |
|---|---|
| `status` | 桥状态、已连接的浏览器、扩展目录 |
| `tabs` | 列出真实浏览器标签页（id/title/url/active） |
| `open` | **从任务栏方式**打开真实浏览器到某 URL（同你点任务栏图标；`browser: chrome\|edge\|auto`） |
| `navigate` | 当前/指定标签页导航 |
| `page_info` / `snapshot` / `read` | 页面信息 / 语义树（`[ref]` + `likelyLoginPage`）/ 读元素 |
| `hand_read` | **鲸鱼娘光标逐块滚动阅读**（`maxBlocks`/`delayMs`，可截图） |
| `hand_click` / `hand_fill` | 光标先指到目标 + 粉框高亮，再点击/填写（可选截图） |
| `click` / `fill` / `js` / `scroll` / `screenshot` / `wait_selector` / `wait_url` | 与 agent 浏览器一致的原子能力 |
| `extension` | 打印扩展目录与安装步骤 |

### `ego_real_doctor`

桥健康、客户端列表、扩展目录、浏览器二进制路径、策略提示（不复制 profile / 不读 cookie / 不自动登录）。

## 5. 可见效果（鲸鱼娘）

- 光标：`🖐` 已替换为 npm `whale-maid-cursor` 的**鲸鱼娘 PNG**（base64 内嵌在 `vision.js`，46 CSS px）
- 标签：粉色小标签显示 `阅读中…` / `点击` / `填写`
- 高亮：目标元素粉色描边 + 柔光
- 阅读：平滑滚动逐块扫过，光标跟随
- 收尾：2.5 秒自动淡出；`pointer-events:none`，不挡用户操作

## 6. 登录策略（重要）

- 真实浏览器模式**不复制、不读取登录数据**；页面是否已登录完全取决于用户自己的浏览器。
- `snapshot` 会返回 `likelyLoginPage`（URL/title/密码框启发式）。为 true 时 agent **必须停下请用户登录**。
- 用户登录后，重新 `snapshot` 继续；不尝试自动填账号/密码/2FA。

## 7. 验收与排查

```powershell
# 桥状态（应看到 clients: chrome/edge）
node real-browser\bridge\cli.mjs status

# 能力矩阵（17/17）
node real-browser\bridge\verify.mjs edge
node real-browser\bridge\verify.mjs chrome
node --test real-browser\bridge\stability.test.mjs
```

常见问题：

| 现象 | 处理 |
|---|---|
| `clients` 为空 | 浏览器没开 / 扩展未加载 / 等 30s 让 service worker 唤醒 |
| `bridge-timeout` | 桥没起：`node real-browser\bridge\server.mjs`；或浏览器窗口最小化过久（扩展补丁含 20s keepalive，重载扩展生效） |
| `content-script-not-ready` | 页面刚提交/受限页（`chrome://`、应用商店）；重试或换普通网页 |
| 截图里看不到鲸鱼娘 | 截图要落在动作后 ~1-2s 内（`--shot` 参数已处理） |

## 8. 安全边界

- 扩展拥有 `<all_urls>` 内容脚本权限（这是操作任意页面的前提），仅在你本机由你安装/卸载。
- 桥 token 是本地固定串（`dsh-bridge-local`），仅防误连，不防本机恶意进程；不要在企业多用户机器上开放。
- 真实浏览器模式不产生 profile 副本，因此**不新增**登录态泄露面；但与 agent 浏览器模式一样，agent 能代表你操作已登录页面——权限等同你本人。

## 9. 已知限制

- **严格 CSP 的站点**（如 GitHub）：页面禁止 MAIN-world `eval`，因此 `ego_real action=js` 与鲸鱼娘可见效果在这些站点会**降级**（点击/填写/导航/快照/截图仍正常，只是看不到光标动画）。Canvas / 普通站点不受影响。
- 可见效果依赖页面允许注入样式与定位元素；全屏播放器、PDF 内置查看器等特殊页面无法叠加光标。
- **扩展重载（推荐一次）**：仓库里的扩展补丁（ping 握手、结果校验、30s 看门狗、MV3 keepalive）需要你在
  `chrome://extensions` 与 `edge://extensions` 各点一次「重新加载」后生效；不重载也能用（服务端已兼容旧版）。
