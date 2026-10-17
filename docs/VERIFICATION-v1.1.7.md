# v1.1.7 外部复验记录（2026-10-18）

对 commit `94b19ff`（`v1.1.7: harden real-browser bridge lifecycle`）在**干净 profile** 上的独立复验。
记录者不是插件作者，环境与作者机器不同，仅共享同一 DSH 版本。

## 环境

| 项 | 值 |
|---|---|
| OS | Windows 11 |
| DSH | 桌面 `0.2.1-rc.2` |
| Node | `v24.21.0`（ego 运行时内置） |
| Chrome | `155.0.8059.80` |
| Edge | `155.0.4283.62` |
| 安装方式 | `plugin_manager install_bundle` + GitHub 归档 tarball（commit `94b19ff`） |
| 包管理 | pnpm `11.28.5` |
| 前置状态 | profile 内无该插件（Config 查询 0 条） |

## 结论

**可安装、可运行；v1.1.7 的三项桥加固全部实测通过。** 建议将本提交纳入正式 tag，
而不是继续停留在分支上——外部复验证据已足够。

## 检查项

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| A1 | 安装 + 激活 | **PASS** | `application: applied`，`warnings: []`，`1.1.6 → 1.1.7` |
| A2 | 配置写入通道 | **PASS** | `POST /ego/api/local-config` 返回 `{config:{...},saved:true}` |
| A3 | 源浏览器解析 | **PASS** | `Google Chrome · Default (C:\Users\...\AppData\Local\Google\Chrome\User Data)`，`warnings: []` |
| A4 | 桥身份标识 | **PASS** | `bridgeId=dsh-real-browser-bridge`，`ownerNonce`、`ownerPid=42004`、`ownerLeaseMs=5000` 均出现在 `/status` |
| A5 | owner 心跳续租 | **PASS** | 两次采样 `ownerHeartbeatMsAgo` = 854 ms / 1270 ms（间隔约 2.5 s，租约 5 s，未过期） |
| A6 | 重复端口拒绝 | **PASS** | 对 18765 再拉起一个桥：`bridge-start-error EADDRINUSE`，进程 `exit code 1` |
| A7 | 租约过期自退 | **PASS** | `DSH_BRIDGE_OWNER_LEASE_MS=300` 的桥在启动后约 0.75 s 打印 `owner heartbeat expired after 300ms; bridge exiting`，`exit code 0` |
| A8 | 自带回归测试 | **PASS 3/3** | `node --test real-browser\bridge\stability.test.mjs`：identity/duplicate-port、lease expiry、client 无全 body `MutationObserver` 三条全绿 |
| A9 | 真实浏览器只读 | **PASS** | `ego_real action=tabs` 返回真实窗口标签页；`snapshot` 返回带 `[ref]` 的语义树；`hand_read` 返回正文 |
| A10 | 真实浏览器写操作 | **PASS** | `hand_click` 命中链接并返回 `clicked`，同时落盘截图（鲸鱼娘光标 + 粉色「点击」标签可见） |
| A11 | 发布元数据可解析 | **PASS** | `package.json` / `dsh-plugin.json` / `real-browser/extension/manifest.json` / `cordis.patch.yml` 全部通过读取与 JSON 解析 |
| A12 | 克隆 profile 模式 | **PASS** | `ego_page_info` 在 agent 浏览器上正常返回（与真实浏览器模式并存） |

## 复现用的关键命令

```powershell
# 桥身份 / 心跳（期望 ownerHeartbeatMsAgo < ownerLeaseMs）
curl.exe "http://127.0.0.1:18765/status?token=dsh-bridge-local"

# 重复端口（期望 exit 1 + EADDRINUSE）
node real-browser\bridge\server.mjs

# 租约过期（期望约 1s 内 exit 0）
$env:DSH_BRIDGE_PORT="18899"; $env:DSH_BRIDGE_OWNER_NONCE="probe"; $env:DSH_BRIDGE_OWNER_LEASE_MS="300"; node real-browser\bridge\server.mjs

# 回归
node --test real-browser\bridge\stability.test.mjs
```

## 验证限制（如实记录）

1. **未验证"退出 DSH 后桥是否立刻消失"**：需要在宿主进程退出时观察，会中断当前会话，未做。
   该项仍只有作者本机的验证记录。
2. **未执行登录态同步**：源 Chrome 运行中且 `allowLiveCopy=false`，按设计返回
   `source-locked`（行为正确，非缺陷）。
3. Edge 客户端 `stale: true`（约 130 s 未轮询）属浏览器空闲/关闭后的正常表现，不计为失败。

## 附：环境差异导致的配置项

DSH 桌面把 `LOCALAPPDATA` 重定向到 `E:\AI\DeepSeek\data\appdata\local`，插件按默认规则
探测到的是空目录，`ego_local_doctor` 报 `source-userdata-missing`。需显式设置：

```json
{ "browserSource": "chrome",
  "sourceUserDataDir": "C:/Users/<user>/AppData/Local/Google/Chrome/User Data" }
```

这是宿主环境差异，不是插件缺陷；但 README 的"已知限制"里值得加一条，
因为任何便携化/重定向 `LOCALAPPDATA` 的宿主都会遇到。
