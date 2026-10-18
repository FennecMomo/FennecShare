# 验证报告

这份文档只记录**真正跑过**的检查，命令、输出、结论都来自实际执行。
跑不了或没验证的部分单独列在最后一节，不写成"应该没问题"。

## 一、验证环境

| 项 | 值 |
| --- | --- |
| 开发机 | Windows，Node.js v24.15.0，npm 12.0.1 |
| Linux 验证 | WSL2 Ubuntu 24.04.4 LTS，x86_64，Node v22.23.1，npm 10.9.8 |
| 浏览器验收 | Microsoft Edge（playwright-core 1.64.1 驱动本机已安装的 Edge，未下载 Chromium） |
| 服务器 | Ubuntu 24.04.4 LTS，x86_64，systemd 255，2 vCPU / 7.5 GiB（详见第六节） |

## 二、构建与类型检查

```
npm ci                  → 安装成功（lockfile 生效）
npm run build           → tsc(web) + tsc(server) + vite build 全部通过
                          dist/web/index.html 0.72 kB
                          dist/web/assets/index-*.css 13.19 kB
                          dist/web/assets/index-*.js  237.29 kB
npm run typecheck       → 无错误（strict + noUnusedLocals + noUnusedParameters）
```

## 三、集成自测（`npm run selftest`）

自测会在系统临时目录里新建数据目录、造夹具、起真实 HTTP 服务（端口 0），
跑完自动清理。夹具里的 `.exe` / `.apk` 是**文本占位文件**，只用于验证协议，
不是可执行程序。

```
共 48 项检查：通过 48，失败 0
```

| 分组 | 检查项 |
| --- | --- |
| 发布事务 | 新增项目（网页 + EXE + 中文名 APK）；重复发布报告无需更新；只更新 APK 时保留 EXE 与网页入口；`removeDownloads` 显式删旧文件；并发发布两个项目不丢记录；无效 manifest 被拒绝且不改 catalog；ZIP 路径穿越包被拒绝且不写包外文件；缺 `index.html` 的包被拒绝；多入口包未指定 entry 被拒绝；多入口包显式指定 entry 后可发布 |
| HTTP 行为 | `/` 返回 HTML 且带 CSP 与 `X-Frame-Options`；`/healthz` 返回服务状态与项目计数；`/api/projects` 不泄露 `storage` 与绝对路径；`/play/<slug>` 308 规范化；`/play/<slug>/` 302 到版本目录；版本目录返回 HTML 且长缓存、无站点 CSP；静态资源 MIME 正确（js/css/svg）；缺失 js 返回 404 而不是 HTML；未开 SPA fallback 时深层路径 404；开 SPA fallback 后深层路径返回入口 HTML 且缺失资源仍 404；不存在的项目/版本 404；下载头正确（含中文文件名，`filename*=UTF-8''` 且头是纯 ASCII）；HEAD 无响应体；Range 返回 206 与正确分片（前缀范围与后缀范围都比对了 SHA-256）；语法错误的 Range 按 RFC 忽略、越界 Range 返回 416 + `Content-Range: bytes */<size>`；`/download/<slug>` 跳到默认项、多个下载且无默认项时返回 409 并列出可选项；未登记文件名 404；媒体只暴露登记过的图片；6 条路径穿越/数据目录探测全部被拒；发布后无需重启即可见 |
| 下架与回滚 | 下架后首页、试玩、下载统一 404 且文件保留；回滚恢复上一状态；历史可列出且能指定目标 |
| 备份恢复 | 备份 → 再发布 → 恢复，catalog revision 与下载项回到备份时；校验失败的备份拒绝恢复 |

## 四、浏览器验收（`node tools/browser-check.mjs`）

真实 Edge 渲染 + 真实键鼠事件。

```
浏览器检查 25 项：通过 25，失败 0
```

| 场景 | 检查项 |
| --- | --- |
| 桌面 1440×900 | 5 张卡片与封面都渲染；无横向溢出且 ≥3 列；单类型筛选 → 2 张；多选 OR（网页+手机APP）→ 4 张；清空恢复 5 张；整卡点击打开弹窗并锁背景滚动；弹窗内点击不误关；方向键与缩略图切换图片；Esc 关闭并把焦点还给原卡片；点遮罩关闭；Tab/Enter 键盘可达；详情按钮来自真实数据（`/play/` 链接、`_blank`、`rel=noopener`）；没有文件的项目不显示假按钮而是显示「暂未提供」 |
| 在线体验 | 稳定入口真的重定向到版本目录；便签纸页面能添加、勾选（计数器 0/1 → 1/1）；像素花园 `/about/` 子页面直接访问能加载到共享样式表 |
| 下载 | 点下载按钮触发真实文件下载，文件名 `.zip`，`download.failure()` 为 null |
| 移动端 390×844 | 无横向溢出；卡片单列；筛选按钮不溢出；弹窗全屏且内部可滚动 |
| reduced-motion | `prefers-reduced-motion: reduce` 下卡片过渡时长 < 0.01s |
| 异常状态 | 接口失败显示错误面板 + 重试按钮；空列表显示空状态；筛选无结果给出清除入口并且能恢复 |

顺带确认：站点 CSP 真的生效 —— 用注入脚本的形式执行 `new Function(...)` 被浏览器拒绝
（`script-src 'self'`），所以浏览器验收改用 DOM 接口与 Playwright，而不是页面内注入。

截图见 `artifacts/`：`home-desktop.png`、`home-mobile.png`、`home-mobile-dialog.png`、
`play-paper-notes.png`、`state-error.png`、`state-empty.png`。

## 五、Linux 验证（`bash tools/verify-linux.sh`）

在 WSL Ubuntu 24.04 里**从零**跑一遍（临时目录，不共享 Windows 的 `node_modules`）：

```
npm ci                  → 成功（全新安装）
npm run build           → 成功
publish seed            → 5 个示例项目发布成功
HTTP 冒烟              → / 200、/api/projects 200、/play/paper-notes 308、
                          /play/paper-notes/ 302、/play/pixel-garden/about/ 302、
                          /download/...zip 200、/download/paper-notes 302、
                          /play/not-exist/ 404、/catalog.json 404
下载头                 → Content-Type: application/zip、Accept-Ranges: bytes、
                          Content-Disposition 带 filename 与 filename*=UTF-8''、
                          Content-Length: 3563
Range bytes=0-15       → 206，16 字节
SHA-256 对比           → 下载内容哈希与 catalog 记录一致
自测套件               → 共 48 项：通过 48，失败 0
```

结论：Linux 上安装、构建、发布、运行、下载协议都可用，且**没有复用 Windows 的
`node_modules`**。

## 六、服务器部署验证

服务器：Ubuntu 24.04.4 LTS，2 vCPU（AMD EPYC 7K62），7.5 GiB 内存，99 GiB 磁盘（可用 51 GiB），systemd 255。
入口是 Cloudflare Tunnel（`cloudflared-personal`），Caddy / Nginx 都不承载本站。

部署由 Hermes 在该机器的专用会话中执行，全程留原始命令输出。

| 检查 | 结果 |
| --- | --- |
| 包完整性 | sha256sum 与本地一致（`e19656eda...e219`），100 个文件，顶层目录正确 |
| Node 运行时 | 新装 `v24.22.0` LTS 于 `~/.nvm/versions/node/v24.22.0/bin/node`；系统 `/usr/bin/node` 仍是 23.11.1，未改动 |
| 依赖安装 | `npm ci` 成功（172 个包，4 秒），`npm run build` 成功 |
| 服务状态 | `fennec-share.service` enabled + active，`User=ubuntu`，内存约 25 MB |
| 监听 | `ss -lntp` 只有 `127.0.0.1:8770` |
| `/healthz` | 200，`catalogRevision: 5`，`projects.total: 5`，重启后 revision 不变 |
| `/` | 200 |
| `/api/projects` | 200，5 个项目，分类、`web.publicUrl`、`downloads` 均正确 |
| 下载头 | 200，`application/zip`，`Accept-Ranges: bytes`，`filename*=UTF-8''`，`Content-Length: 3563`，`ETag` + `Last-Modified` |
| Range | `bytes=0-15` → 206，16 字节 |
| `/play/paper-notes/` | 302 → `/play/paper-notes/r/r-20261018t130216z-50b640/`，跟随后 200 |
| 下载内容哈希 | 与 `catalog.json` 记录完全一致 |
| 服务器上跑自测 | 「共 48 项检查：通过 48，失败 0」 |
| 重启 | `systemctl restart` 后 `/healthz` 正常，`catalogRevision` 不变 |
| 日志 | `journalctl -u fennec-share` 只有启动与优雅关闭，无 ERROR / WARN |
| 持续运行复核 | 部署约 5 分钟后再次只读核对：`is-active` = active，PID 与启动时间未变、uptime 连贯（没有崩溃重拉），`healthz` 仍 revision 5 / 5 个项目 |
| 加固实证 | 进运行中服务的挂载命名空间核对：`/usr`、`/etc`、`/boot` 只读，`/home` 可写；在数据目录实际写入并删除测试文件成功 |
| 重复部署 | 同一包再跑一次 `deploy.sh` 成功；前端产物哈希不变，`catalog.json` 的 mtime/大小/`generatedAt` 不变，`revision` 仍是 5 |
| 改动面 | `share.fennecmomo.top` DNS 记录数 0（未映射）；cloudflared、Caddy、Nginx、其它 systemd 单元、系统 Node、apt 源、ufw 全部未动 |

### 内容变更后的复验（2026-10-18 21:41 CST）

下架 2 个占位项目、上线 4 个对比项目、换封面、修 alt 之后，在服务器上重新核对：

| 检查 | 结果 |
| --- | --- |
| `/api/projects` | `revision 15`，7 个项目；两个占位不在列表里，`total 9 / published 7` 的差异来自被下架但保留文件的两个项目 |
| 四个新项目 | `/play/<slug>/` 全部 302 → 版本目录，跟随后 200，字节数与源文件一致（90592 / 24832 / 207617 / 32283） |
| 回滚后 | 四个 `/play` 的响应体 sha256 与原件完全一致（`2d924fdc…`、`8fd4cc41…`、`47fdb68d…`、`e82a67c5…`），说明线上返回的就是用户交的那份文件 |
| 入口 | `web.entry` 指回原文件名，当前 release 的 `web/` 只有那一个文件，没有 `index.html` 副本 |
| 封面 | 只保留页面自身画面（打开时的空状态 / 开始界面 / 空表单 / 游戏内），`cover.alt` 与 `screenshots[0].alt` 如实描述状态 |
| 占位地址 | `fennec-launcher`、`momo-reader` 的 `/play` 均 404 |
| 服务 | `ActiveEnterTimestamp` 全程未变（21:11:54），发布没有触发重启 |

本地同样跑了一遍数据驱动的浏览器验收：**25 项全过**（界面弹窗、筛选、移动端、异常状态、真实下载、分享链接、管理页面）。
数量断言改成从 `/api/projects` 推导，换内容不用改测试。

**域名尚未映射**：`share.fennecmomo.top` 目前没有 DNS 记录，隧道里也没有对应 ingress。
按任务约束，DNS 与 Cloudflare 配置需要单独授权后才动，因此这个域名的公网可访问性
**没有验证**（也不能声称已验证）。映射目标与步骤见 [DEPLOYMENT.md](DEPLOYMENT.md) 第五节：
Cloudflare Zero Trust → Tunnels → `personal` → Public Hostname 新增
`share.fennecmomo.top` → `http://localhost:8770`，DNS 由面板自动创建。


## 七、分享链接与管理后台（2026-10-18 本地验证）

| 检查 | 结果 |
| --- | --- |
| 分享按钮 | 点击后不打开详情，剪贴板里是 `http(s)://<host>/?p=<slug>`，按钮切成「已复制」并弹出提示 |
| 分享链接打开 | 带 `?p=<slug>` 打开首页会自动弹出对应项目；`Esc` 关闭后地址栏参数被清掉，刷新不再弹 |
| 管理页面 | `/admin` 返回 200，带 CSP、`no-store`、`X-Robots-Tag: noindex` |
| 登录 | 错误密码 401；正确密码 200 并下发 `HttpOnly; SameSite=Strict` cookie；未登录读接口 401 |
| 防跨站 | 缺 `x-fennec-admin` 头的写请求 403；`Origin` 与 `Host` 不一致 403 |
| 元信息编辑 | 标题/排序/版本号写入 catalog，revision +1，且**不产生新版本目录** |
| 封面替换 | 生成新 release，旧 release 目录保留；新封面 200 `image/png` 且字节与上传内容一致；`web` 记录不变 |
| 非图片上传 | 把 SVG 冒充 `image/png` 上传 → 415，catalog 不变 |
| 截图增删 | 追加后数量 +1、`alt` 正确；删除后数量 -1；越界序号 400 |
| 改密码 | 旧密码失效、新密码可用、其它会话被踢、当前会话保留；弱密码 400 |

集成自测扩到 **48 项**（新增管理接口 13 项），浏览器验收扩到 **25 项**（新增分享 2 项、管理页面 3 项），
全部通过。管理页面的浏览器用例只在设置了 `ADMIN_PASSWORD` 环境变量时运行，仓库里不存密码。

## 八、公网端到端验证（2026-10-18 22:25 CST）

`share.fennecmomo.top` 的隧道路由与 DNS 生效后，用真实浏览器（Edge）从公网跑了一遍
`npm run check:public`：

| 检查 | 结果 |
| --- | --- |
| HTTPS 首页 | 200，证书正常，卡片渲染完整 |
| 分享按钮 | 复制出 `https://share.fennecmomo.top/?p=qs1-repair-desk-deepseek` |
| 分享链接 | 打开 `/?p=paper-notes` 自动弹出「便签纸」，`Esc` 后地址栏参数被清掉 |
| 试玩页 | `/play/paper-notes/` → 302 → 版本目录 200 |
| 管理页登录 | `/admin` 200，密码登录后读到 9 个项目（含 2 个下架） |
| 会话 cookie | `HttpOnly` + `Secure`（HTTPS 下）+ `SameSite=Strict` |
| 退出登录 | `/api/admin/session` 立刻回到 `authenticated: false` |

同一次部署里服务器侧的观测：进程从 2336123 换成 2357217（SIGTERM 优雅退出 → 新进程启动），
`catalogRevision` 保持 19（部署不动数据），四个 `/play` 与 paper-notes 下载均正常，
`auth.json` 权限 600、属主 ubuntu、哈希与本地生成的一致。

> 这轮验证没有修改任何项目数据：管理页只做了登录、读列表、退出。

## 九、标签、试玩包与数据看板（2026-10-19 本地验证）

这一轮新增五项能力，本地全部跑通：管理页新建项目、管理页发布新版本（试玩包 / 下载包）、
一键发布试玩（只收 HTML/ZIP）、标签体系、点击与下载统计。

### 10.1 自动化检查

| 套件 | 结果 |
| --- | --- |
| 集成自测 `npm run selftest` | **56 项全过**（新增 8 项：标签增删、新建项目、单文件 HTML 发布、ZIP 自动识别入口、非页面内容拒绝、下载包上传/覆盖、埋点上报与后台聚合、未登录拒绝写入） |
| 浏览器验收 `tools/browser-check.mjs` | **29 项全过**（有标签的数据 29 项，无标签的数据 28 项并跳过标签筛选） |
| 类型检查 / 构建 | 通过（前端两个入口 + 服务端） |

浏览器里真实操作过的流程（对着临时数据目录 `data-preview`，不碰真实项目）：

1. 后台「添加项目」建出 `upload-demo` → 列表出现、状态已上架；
2. 上传单文件 `upload-demo.html` → 入口保留原文件名，`/play/upload-demo/` 打开后页面里是上传的内容；
3. 上传 `upload-demo.apk` → 下载列表出现 `Windows / 256 B`，`/download/upload-demo/upload-demo.apk` 可取回；
4. 前台用 `/?p=upload-demo` 打开 → 弹窗标题正确；
5. 后台删掉「实验」标签 → 该标签从项目上一起消失。

数据目录里的落地结果（同一次验证）：

```
projects/upload-demo/history/000001-create.json
projects/upload-demo/history/000002-web.json
projects/upload-demo/history/000003-downloads.json
projects/upload-demo/releases/r-.../web/upload-demo.html        ← 原文件名
projects/upload-demo/releases/r-.../downloads/01-9bc038d0.apk   ← 内部存储名，对外仍是原名
```

### 10.2 埋点

| 场景 | 验证方式 | 结果 |
| --- | --- | --- |
| 分享点击 | 浏览器点卡片分享 → 查 `/api/projects` | 计数 +1 |
| 试玩点击 | 详情里点「在线体验」→ 查 `/api/projects` | 计数 +1 |
| 下载 | `GET /download/...` → 查 `/api/projects` 与 `/api/admin/stats` | 计数 +1，`HEAD` 与 `bytes=N-` 不计 |
| 后台看板 | 打开 `/admin` → 数据 Tab | 总量、14 天趋势、平台分布、按项目四块都有数 |

埋点文件是 `DATA_DIR/stats/events.jsonl`，一行一个事件；不记 IP / UA / cookie。

## 十、没有验证 / 明确不支持的部分

| 项 | 说明 |
| --- | --- |
| 真实 EXE / APK 的安装与运行 | 只在协议层验证了下载（头、Range、哈希、文件名）。示例数据里不含真实安装包，也不声称它们能安装 |
| `bytes=abc`、一次多段 Range | 按 RFC 7233 的宽松策略：语法错误或 `bytes=0-1,3-4` 这类多段请求直接返回 200 全量，不返回 416 |
| 断点续传管理器 | 支持 `Range` 请求，但没有做多连接分片下载或续传管理 |
| SharedArrayBuffer / WebGL / Service Worker 类试玩包 | 没有开 COOP/COEP，这类包不保证能跑 |
| 同源隔离 | 试玩包与主站同源，能读写本站 localStorage；信任边界靠"只发布你信任的包"，没有做域名级隔离 |
| 高并发压测 | 只做了并发发布（写锁）验证，没有做下载吞吐压测 |
| 超大文件 | 默认限额 4 GiB，但没有实测大文件；服务器出口带宽约 5 Mbps |
| 浏览器兼容 | 只在 Edge（Chromium）上实测；Safari / Firefox 未实测，代码只用了标准 API |
| 域名 HTTPS | 由上游 Cloudflare 提供，本项目不处理证书 |
| 埋点准确性 | 客户端上报的点击可被脚本伪造或拦截（没有签名、没有防机器人）；下载是服务端计数，相对可靠。数字用于看趋势，不适合当结算依据 |
| 埋点容量 | `events.jsonl` 只追加不归档；超过 20 万条会打 warn 日志，需要手工挪走旧文件 |
| 标签 | 单层标签，没有分组、没有层级、没有颜色；改名等价于「删掉再建」（引用会被一起摘掉） |
| 管理页上传 | 单次请求体在内存里处理；试玩包按 2 GiB、下载包按 4 GiB 上限放行，超大包会很吃内存 |
| 并发编辑 | 管理页没有「同一项目正在被别人编辑」的提示，两个标签页同时保存时以后保存的为准 |
