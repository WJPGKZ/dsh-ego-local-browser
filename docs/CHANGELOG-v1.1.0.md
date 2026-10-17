# CHANGELOG v1.1.0

## 新增：真实浏览器模式（Real Taskbar Browser Mode）

- 新增 `ego_real` / `ego_real_doctor` 工具：直接操作**用户任务栏里的真实 Chrome/Edge**（真实 profile、真实登录态），
  通过随包提供的 MV3 扩展 + 本机 127.0.0.1:18765 桥接，不复制 profile、不读 cookie、不开调试端口。
- 新增 `real-browser/` 目录：扩展（鲸鱼娘图标 + 内容脚本）、桥服务器、鲸鱼娘光标 `vision.js`、
  17 项能力矩阵 `verify.mjs`、任务栏方式打开浏览器与桌面截图小工具。
- 新增可见效果：**鲸鱼娘（蓝发 Q 版鲸鱼女仆）光标** + 粉色标签（阅读中…/点击/填写）+ 元素粉色高亮 +
  平滑滚动逐块阅读；动作结束 2.5s 自动淡出，`pointer-events:none` 不挡用户。
- `ego_real action=open` 等价于用户点任务栏图标：以真实浏览器、真实 profile 打开 URL，
  并回传新建标签页 id。
- `ego_real action=snapshot` 附带 `likelyLoginPage` 判定；需要登录时 agent 停下请用户本人登录（不自动登录）。
- 安全边界：扩展仅与 `127.0.0.1:18765` 通信；桥按客户端（chrome/edge）路由、带超时/取消、结果契约严格校验；
  服务端兼容旧扩展（legacy-snapshot），扩展补丁需重载后生效（更稳的 keepalive/看门狗）。

## 修复（真实浏览器桥）

- 内容脚本命令返回值契约：`{ok:true,value}` 双层包装 → 桥统一解包；失败返回显式错误而非 `undefined`。
- `verify.mjs` 的 `js/screenshot` 未带 tabId 导致命中活动标签页 → 全部命令强制作用域到测试标签页。
- 旧服务端全局 `pollWaiter` 单槽导致跨客户端唤醒/11s 卡顿 → 改为按客户端 FIFO + 新轮询主动取队列。
- MV3 service worker 休眠导致的 60-90s 停顿 → 扩展补丁加入 20s API nudge、内容脚本 keepalive、30s 命令看门狗。
- 鲸鱼娘光标在 `hand_click`/`hand_fill` 后可能滞留 → 2.5s 自动淡出安全网。
- Edge 155 的 Aster App-Bound 加密导致「复制 profile 登录态」不可用 → 文档明确：Edge 请用真实浏览器模式，不要做登录态克隆源。

## 验证

- `node real-browser/bridge/verify.mjs edge` → **17/17 passed**
- `node real-browser/bridge/verify.mjs chrome` → **17/17 passed**
- 鲸鱼娘光标证据：`whale-edge-read-mid.png` / `whale-edge-read-move.png`（Edge, Canvas MA1508, 用户已登录）、
  `whale-chrome-fill.png` / `whale-chrome-click.png`（Chrome, 桥测试页）
- DOM 事实：动作中 `opacity:1`、`img.naturalWidth=90`、`pointer-events:none`、唯一 `#__dsh_hand`；动作后 `opacity:0`。
- 真实浏览器打开证据：`open-in-user-browser chrome https://example.com/?dsh=taskbar-chrome` →
  Chrome 主进程命令行**无** `--user-data-dir`（真实 profile），桥可见该标签页。
