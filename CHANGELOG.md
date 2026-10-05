# Changelog

## 0.5.0

- **文件传输**:卡片 / 趋势卡新增「📁 文件」入口,进入远端目录浏览器 —— 列目录(目录优先排序)、上传、下载、新建目录、删除(非空目录先确认再递归)。走 `/server-deck/api/hosts/<id>/files*` 的 SFTP 桥(池内长连接另开 SFTP 通道),REST 与 PTY 一致仅回环放行;桌面端经 Electron 代理,下载用 fetch→Blob→`a[download]`,附件名按 RFC 5987 交付(中文文件名可读)。
- **对话工具**:`server_deck_upload`(本机 → 远端)与 `server_deck_download`(远端 → 本机),单文件 SFTP,自动创建本机父目录;与 `server_deck_exec` 同一条连接池。
- **修复:DSH 桌面端 WebSocket 报错**。桌面端页面跑在自定义协议 `dsh-app://app` 上,旧的 `ptyUrl()` 用 `location.host` 拼出 `ws://app/...` 必然连不上;现改用 `__DSH_TRANSPORT__.streamBaseUrl`(Host 的回环 origin)再派生 `ws:`/`wss:`,正好命中 Electron 只放行 `ws://127.0.0.1:<port>/*` 的改写规则。Web 端行为不变(同源)。地址拼装失败时终端内联给出可读原因,不再白屏。
- 终端页头新增「📁 文件」快捷入口;支持深链 `#sd-files/<hostId>`。
- 新增联机自测 `scripts/itest-live.mjs`(对台账首台真机跑列表/上传/下载/建删/PTY 回显)与 `test/transfer.test.ts`(路径拼接、错误映射、WS 地址派生)。

## 0.4.0

- 卡片新增实时网速（↓接收 / ↑发送）与当月流量累计。Linux 双快照 `/proc/net/dev`，Darwin/BSD `netstat -ibn`，Windows CIM 网卡差分；lo / docker / veth / br- / tun / wg 等虚拟口跳过，Proxmox `vmbr*` 与 Windows `vEthernet` 计入。Closes #20.
- 月流量落盘 `~/.dsh/server-deck-metrics/{hostId}/net-month.json`：主机重启续计，计数器回绕跳过该段增量，换月清零；删主机级联清理。

## 0.3.2

- 对话工具 `server_deck_hosts` / `server_deck_exec`：对台账主机非交互 SSH 下发（不走卡片 xterm，不暴露浏览器 REST）。Closes #16.
- Windows OpenSSH：命令包一层 EncodedCommand + 内层 `cmd.exe /c`；已指定 cmd/powershell/pwsh 则不包装。

## 0.3.1

- Windows OpenSSH：POSIX 探针拿不到 CPU/内存时再跑 `powershell.exe -EncodedCommand`（CIM），卡片能出系统名 / CPU / 内存 / 磁盘。Closes #14.
- FreeBSD / OpenBSD：无 `/proc` 时读 `kern.cp_time` 与 `hw.physmem`。
- Linux / macOS 路径不变；有 CPU 或内存时不打 PowerShell。

## 0.3.0

- DSH 0.1.5-rc.1 / 0.1.5-rc.2：页签优先注册官方原生右侧栏；better-sidebar 降为旧宿主回退。
- 官方已有的赞踩、交付文件卡不画。
- README：兼容表与点星引导前置。0.2.x 进入维护态（DSH ≤ 0.1.2-rc.1）。

## 0.2.3

- Broader server compatibility: probes run in `/bin/sh` (not the login shell), so fish/zsh hosts still report OS and CPU / memory / disk. Linux reads `/proc` instead of GNU `top`/`free` (Ubuntu, Debian, RHEL, Alpine, Arch/CachyOS). macOS Darwin fallbacks unchanged. Closes #10.

## 0.2.2

- Compatible with DeepSeek Harness `0.1.2-rc.1` (also `0.1.1-rc.2` / `0.1.2-alpha.4`). Use `dsh-better-sidebar@0.18.0` when mounting as a sidebar tab.
- Test gate: committed ModuleLoader client id and cordis.patch.yml insert.name must equal package.json name.

## 0.2.1

- Fix client ModuleLoader registration id: use `package.json` `name` (`dsh-server-deck`) instead of the leftover `@dsh-abilities/server-deck`. DSH Desktop 2.0.5 requires the ids to match or the plugin fails to load. Closes #1.

## 0.2.0

- 独立「趋势」视图与卡片视图切换:每台主机 CPU / 内存 / 磁盘三张独立 SVG 趋势图,展示最新值与窗口均值(悬停看最高 / 最低 / 样本数)。
- 时间窗口:1 小时(滚动,默认)/ 24 小时(滚动)/ 一周 / 一个月(按本地自然日 0 点对齐,含今天)/ 自定义(≤31 天)。
- 展示粒度:自动 / 10s / 30s / 1m / 5m / 15m / 1h;单次查询上限 1200 点,超限自动升档。
- 主机侧常驻采集(默认 10s,可选 30s / 1m / 5m),与面板是否打开无关;离线也记一条用于画断档。
- 时序落盘 `~/.dsh/server-deck-metrics/{hostId}/`(raw 3h / 1m 24h / 15m 7d / 1h 31d);删除主机级联清理。
- 查询窗口早于本地记录时,自动从服务器 sysstat(`sar -u` / `sar -r`)回填历史 CPU / 内存(限频 10 分钟;磁盘容量无法回填)。
- `GET /status` 改为读采集快照;`?force=1` 才立即探测;趋势图 hover 竖线 + 悬浮数值卡。

## 0.1.1

- Compatible with DeepSeek Harness `0.1.2-alpha.4` (also `0.1.1-rc.2`).
- Drop `@deepseek-ai/dsh-client-runtime` from `dsh.client.inject` — that package was removed in DSH 0.1.2-alpha.1. Client still dual-mounts via nested `betterSidebar` fiber.
- Peer `@deepseek-ai/dsh-host-webserver` is now `0.1.1-rc.2 || >=0.1.2-alpha.2` so npm semver accepts the alpha line.

## 0.1.0

- Card dashboard per connected host: status, OS, uptime, cores, latency, CPU / memory / disk meters.
- Click a card to open an xterm.js interactive terminal (WebSocket ↔ ssh2 shell).
- Import hosts from `~/.ssh/config` (skips wildcards and git-hosting aliases).
- Dual mount: dsh-better-sidebar tab, or a standalone collapsible right drawer.
- Loopback-only API and PTY routes; secrets in `~/.dsh/server-deck.secrets.json` (0600).
