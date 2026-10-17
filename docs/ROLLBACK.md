# 卸载 / 回滚（dsh-ego-local-browser）

本插件对 profile 的改动只有三处：`package.json` 的 `dependencies` + `dsh.profile.bundles`、
`pnpm-lock.yaml`、`node_modules\dsh-ego-local-browser`（以及它的 client bundle）。
数据全部在独立目录 `E:\AI\DeepSeek\data\dsh-ego-local-browser`，**源 Chrome/Edge profile 从未被写入**。

## 0. 先停掉 agent 浏览器（可选但推荐）

```powershell
# 用装了插件的 DSH 会话跑一次 ego_doctor / 或让 agent 调 ego_local_doctor 前先确认
# 也可直接杀进程（只杀 --user-data-dir 指向本插件 home 的 chrome）：
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -match 'dsh-ego-local-browser' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

注意：不要动用户日常 Chrome（命令行里没有 `--user-data-dir` 的那个）。

## 1. 从 profile 卸载插件

优先用 DSH 界面的 **设置 → 插件 → dsh-ego-local-browser → 卸载**（= 官方 `remove_bundle`）。

等价 CLI：

```powershell
dsh plugin --profile desktop remove dsh-ego-local-browser
```

卸载后**完全退出并重启 DSH 桌面端**（client bundle 与 bundles 列表是启动快照）。

## 2. 恢复原来的 dsh-ego-browser（可选）

如果还想保留原版浏览器工具：

```powershell
dsh plugin --profile desktop add dsh-ego-browser
```

或从 npm 源重装（本机可联网，`registry.npmjs.org` 实测 200）：

```powershell
dsh plugin --profile desktop add "dsh-ego-browser@^0.8.6"
```

## 3. 删除本插件的数据目录（可选，释放磁盘）

```powershell
# 先确认没有进程占用
Remove-Item -LiteralPath 'E:\AI\DeepSeek\data\dsh-ego-local-browser' -Recurse -Force
```

这个目录里只有本插件自己产生的：browser profile 副本（白名单裁剪后）、state、allowlist、
local-config、备份、ffmpeg 缓存。删掉不影响源浏览器。

## 4. 可保留的痕迹（无害）

- `E:\AI\DeepSeek\data\plugins\dsh-ego-local-browser` —— 插件源码目录（`file:` 安装源），可留作以后重装，也可删。
- 旧的 `C:\Users\Wesley Wang\AppData\Local\ego-lite-linux` 是**上一个插件时代**留下的目录联结，
  指向 `E:\AI\DeepSeek\data\ego-lite-linux`；与本插件无关，可另行清理（不要用本插件的回滚步骤删它）。
- 源浏览器里的白名单/登录态不会因为卸载而改变（插件从未写源 profile）。

## 5. 校验源 profile 没被动过

```powershell
$ud = 'C:\Users\Wesley Wang\AppData\Local\Google\Chrome\User Data'
Get-Item -LiteralPath "$ud\Local State", "$ud\Default\Network\Cookies" |
  Select-Object FullName, Length, LastWriteTime
```

这些文件的大小/修改时间应与使用本插件前一致（Chrome 自己启动时的正常时间戳变化除外；
本插件只读复制它们，从不打开写入）。

## 6. 故障时的最小回滚（保留新插件但关闭自动同步）

如果不想卸载、只想停掉"自动复制登录态"：

- 设置 → 本地浏览器 → 或直接编辑
  `E:\AI\DeepSeek\data\dsh-ego-local-browser\local-config.json`：

```json
{ "autoSync": false }
```

然后重启 DSH（或重新挂载插件）。已有 profile 不会被删除，ego_* 工具照常工作。
