# 部署说明

目标环境：一台 Linux 服务器（本次是 Ubuntu 24.04），单进程 Node + systemd，
对外由 Cloudflare Tunnel 转发。不需要 Docker、数据库、对象存储。

## 一、约定

| 项 | 值 | 说明 |
| --- | --- | --- |
| 代码目录 | `/home/ubuntu/dev-projects/fennec-share` | 与其它项目同级，独立目录 |
| 数据目录 | `/home/ubuntu/fennec-share-data` | 权限 `0700`，与代码分离 |
| 备份目录 | `/home/ubuntu/backups/fennec-share/` | 独立磁盘路径，按日期分子目录 |
| 上传暂存 | `/home/ubuntu/fennec-share-staging` | 只放待解压的部署包 |
| 监听 | `127.0.0.1:8770` | 只监听回环，公网由隧道转发 |
| 服务名 | `fennec-share.service` | systemd 系统单元，`User=ubuntu` |
| 域名 | `https://share.fennecmomo.top` | 由 Cloudflare Tunnel 的 Public Hostname 指向 `http://localhost:8770` |

端口、目录都可以用参数覆盖，不必改代码。

## 二、Node 版本

- `package.json` 声明 `engines.node >= 22.12.0`（Vite 7 的下限）。
- 服务器原本只有 Node 23.11.1（Current 线，已停止维护），不满足"使用受维护的 LTS"。
- 部署时安装了 **Node 24 LTS**，只装在 `~/.nvm/versions/node/` 下，**没有动系统 Node**
  （其它项目继续用 `/usr/bin/node`），systemd 单元里写的是 Node 的绝对路径。

> 附加提示：npm 11 会对 `esbuild` 的 postinstall 打印 `allowScripts` 警告（安装脚本策略）。
> 目前不影响构建；如果以后 npm 默认拦截安装脚本，需要显式放行
> `npm install-scripts approve esbuild`，否则 `vite build` 会因为拿不到平台二进制而失败。

装法（用户级，不需要 sudo）：

```bash
export NVM_DIR="$HOME/.nvm"
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
. "$NVM_DIR/nvm.sh"
nvm install 24
nvm which 24        # 记下这个绝对路径，systemd 用得到
```

## 三、首次部署

1. 把部署包传到服务器并解压到暂存目录：

```bash
mkdir -p ~/fennec-share-staging && cd ~/fennec-share-staging
tar -xzf fennec-share-<版本>-<时间戳>.tgz
```

2. 执行部署脚本（幂等，可以反复跑）：

```bash
cd ~/fennec-share-staging/fennec-share
bash deploy/deploy.sh \
  --source "$PWD" \
  --port 8770 \
  --public-base-url https://share.fennecmomo.top
```

脚本依次做这些事，任何一步失败都会停下并打印原因：

1. 校验 Node 版本（低于 22.12 直接退出，并说明 Vite 7 的要求）；
2. 建目录（数据目录 `0700`）；
3. `rsync` 同步代码到 `/home/ubuntu/dev-projects/fennec-share`（排除 `node_modules`、`dist`、`data`）；
4. 生成 `DATA_DIR/fennec-share.env`（已存在则保持不变）；
5. `npm ci`（严格用 lockfile）→ `npm run build`；
6. 渲染 `deploy/fennec-share.service`（替换代码目录 / env 路径 / node 绝对路径）并安装到
   `/etc/systemd/system/`，`daemon-reload` + `enable` + `start|restart`；
7. 轮询 `/healthz`，打印首页与接口状态码。

3. 只部署代码、不碰 systemd（比如调试用）：

```bash
bash deploy/deploy.sh --skip-systemd
```

## 四、导入示例项目（可选）

```bash
cd /home/ubuntu/dev-projects/fennec-share
DATA_DIR=/home/ubuntu/fennec-share-data PUBLIC_BASE_URL=https://share.fennecmomo.top \
  node dist/tools/publish.js seed --demo-dir demo
```

示例项目都带 `demo: true`，页面会显示「示例」标记。`seed` 会跳过同名的非示例项目，
不会覆盖真实数据。不想要示例数据就 `unpublish --slug <slug>`，或者之后用真实项目覆盖同名 slug。

## 五、域名映射

生效的入口是 **Cloudflare Tunnel**，不是 Caddy / Nginx：

1. Cloudflare 仪表盘 → Zero Trust → Networks → Tunnels → 本机那条隧道（`personal`）→ Public Hostname；
2. 新增一条：`share.fennecmomo.top` → `http://localhost:8770`；
3. DNS 会自动创建 CNAME 到隧道，秒级生效，**不需要重启 cloudflared**。

注意：本机 `/etc/cloudflared/config.yml` 是过时的，真正的 ingress 由仪表盘远程下发，
改本地文件没用。

**当前状态（2026-10-18 22:20 CST 起）**：这条 ingress 与 DNS **已经生效**，
`https://share.fennecmomo.top/` 实测 200。它是由仪表盘侧添加的（隧道路由 + 2 条 A 记录），
不是本机改配置文件，也没有重启 cloudflared。如果以后要撤掉，反着做一遍即可，应用侧不受影响。


如果以后改用 Caddy/Nginx 反代，只需要把 `https://share.fennecmomo.top` 反代到
`http://127.0.0.1:8770`，并保留原始 Host 与 `X-Forwarded-*`，应用本身不用改。

## 六、日常运维

```bash
# 看日志
journalctl -u fennec-share -f
journalctl -u fennec-share -n 100 --no-pager

# 重启 / 停止
sudo systemctl restart fennec-share
sudo systemctl stop fennec-share

# 健康检查
curl -s http://127.0.0.1:8770/healthz

# 发布一个新项目（manifest 用绝对路径）
cd /home/ubuntu/dev-projects/fennec-share
DATA_DIR=/home/ubuntu/fennec-share-data PUBLIC_BASE_URL=https://share.fennecmomo.top \
  node dist/tools/publish.js publish --manifest /home/ubuntu/fennec-share-staging/my-tool/manifest.json

# 下架 / 回滚
DATA_DIR=/home/ubuntu/fennec-share-data node dist/tools/publish.js unpublish --slug my-tool --reason "暂时下架"
DATA_DIR=/home/ubuntu/fennec-share-data node dist/tools/publish.js rollback --slug my-tool
```

发布**不需要重启服务**：服务端按 `mtime` 检测 catalog 变化，前端刷新即可看到。

## 七、备份与恢复

```bash
# 手动备份（catalog + 全部项目文件 + history）
cd /home/ubuntu/dev-projects/fennec-share
DATA_DIR=/home/ubuntu/fennec-share-data \
  node dist/tools/publish.js backup --out /home/ubuntu/backups/fennec-share

# 也可以直接用脚本（含旧备份清理，默认保留 14 天）
bash deploy/backup.sh

# 恢复前先校验（不写盘）
DATA_DIR=/home/ubuntu/fennec-share-data \
  node dist/tools/publish.js restore --from /home/ubuntu/backups/fennec-share/fennec-share-backup-<时间戳> --dry-run

# 真正恢复
DATA_DIR=/home/ubuntu/fennec-share-data \
  node dist/tools/publish.js restore --from /home/ubuntu/backups/fennec-share/fennec-share-backup-<时间戳>
```

- 备份清单里每个文件都带 SHA-256，恢复前逐个校验，任何一个不匹配就整体拒绝。
- 恢复是"覆盖 + 保留多余文件"：备份里没有的现有文件不会被删除。
- 恢复的最后一个动作是原子替换 `catalog.json`，并且在 `backups/` 里自动留下恢复前的 catalog。

定时备份（用户 crontab，每天 03:30）：

```cron
30 3 * * * /home/ubuntu/dev-projects/fennec-share/deploy/backup.sh >> /home/ubuntu/logs/fennec-share/backup.log 2>&1
```

## 八、日志

- 应用日志直接进 journald（`StandardOutput=journal`），带时间戳、级别和 `k=v` 字段。
- `journalctl -u fennec-share` 已经够用；如果担心 journald 占盘，加一条配置限制大小：

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' | sudo tee /etc/systemd/journald.conf.d/99-fennec-share.conf
sudo systemctl restart systemd-journald
```

## 九、排错

| 现象 | 排查 |
| --- | --- |
| 502 / 521 | `systemctl status fennec-share`、`journalctl -u fennec-share -n 50`，确认监听的是 `127.0.0.1:8770` |
| 首页白屏 | 打开开发者工具看 `/assets/*` 是否 404；多半是 `npm run build` 没跑或 `WEB_DIST_DIR` 指错 |
| 试玩页白屏 | 大概率是包里写死了 `/assets/...` 绝对路径，见 [HTML_PACKAGE_GUIDE.md](HTML_PACKAGE_GUIDE.md) |
| 下载 404 | 用 `list --json` 看 catalog 里的 `fileName` 是否与请求一致（大小写、空格、中文 NFC） |
| 发布报 `lock_busy` | 有另一个发布在跑，或上次异常退出留下锁；确认没有 node 进程在发布后删掉 `DATA_DIR/.publish.lock` |
| 发布报 `invalid_catalog` | catalog 被手工改坏了；从 `DATA_DIR/backups/` 找最近一份可用的恢复 |
| 端口被占 | 换 `--port`，或 `ss -lntp \| grep 8770` 看是谁 |

## 十、本次真实部署记录

**2026-10-18 21:05 CST 首次部署（由 Hermes 在会话 `furtheragent_60807a1c...` 中执行，全程留原始输出）**

| 项 | 实际值 |
| --- | --- |
| 首次部署包 | `fennec-share-0.1.0-20261018-130140.tgz`（2,023,118 字节，100 个文件），SHA-256 `e19656edafee95d150024aa15d3d95a616175ddb77660e777c6e97c45629e219` |
| 最终同步包 | `fennec-share-0.1.0-20261018-130751.tgz`（2,024,811 字节，97 个文件），SHA-256 `e49e34dde772988613da720549d231bf8a9c1d7b8a113daa2e3213a63b41d291`；相比首包只改了文档、`deploy/deploy.sh` 与 `deploy/package.sh`，运行期代码逐文件一致 |
| 重复部署 | 两次幂等重跑都成功，前端产物哈希不变（`index-D4kkeEw5.js`），`catalog.json` 的 mtime / 大小 / `generatedAt` 都没变，说明重建代码不碰数据 |
| Node | `v24.22.0` LTS，路径 `/home/ubuntu/.nvm/versions/node/v24.22.0/bin/node`；系统 `/usr/bin/node` 仍是 23.11.1，未被改动 |
| 代码目录 | `/home/ubuntu/dev-projects/fennec-share` |
| 数据目录 | `/home/ubuntu/fennec-share-data`（`0700`），`catalog.json` 12,302 字节 |
| 服务 | `fennec-share.service`，`enabled` + `active (running)`，`User=ubuntu`，内存约 25 MB |
| 监听 | `127.0.0.1:8770`（`ss -lntp` 只有回环） |
| 首个版本 | `r-20261018t130216z-50b640` |
| 数据规模 | 5 个项目（全部示例），`projects/` 240 K，`backups/` 36 K |

验证结果（全部为服务器上真实命令输出）：

| 检查 | 结果 |
| --- | --- |
| `/healthz` | `{"status":"ok",...,"catalogRevision":5,"projects":{"total":5,"published":5}}` |
| `/` | 200 |
| `/api/projects` | 200，5 个项目，分类与公开 URL 正确 |
| 下载头 | 200，`Content-Type: application/zip`，`Accept-Ranges: bytes`，`Content-Disposition` 带 `filename*`，`Content-Length: 3563`，带 `ETag` / `Last-Modified` |
| Range | `bytes=0-15` → 206，16 字节 |
| `/play/paper-notes/` | 302 → `/play/paper-notes/r/r-20261018t130216z-50b640/` |
| 下载文件 SHA-256 | 与 `catalog.json` 记录完全一致（`13e690d0...4011d8`） |
| 服务器上跑 selftest | 共 36 项检查：通过 36，失败 0 |
| 重启 | `systemctl restart` 后 `/healthz` 正常，`catalogRevision` 仍为 5 |
| 日志 | 只有启动与优雅关闭日志，无 ERROR / WARN |
| 持续运行复核（21:16 CST） | `is-active` = active，`ActiveEnterTimestamp` 21:11:54，PID 2336123 未变、uptime 连贯，`healthz` 仍 revision 5 / 5 个项目；`du -sh` 数据目录 304 K；`share.fennecmomo.top` DNS 记录数仍为 0 |

加固项实证：`ProtectSystem=full` 下进入运行中服务的挂载命名空间核对，`/usr`、`/etc`、`/boot` 为只读，
`/home` 跟随根分区可写；在数据目录里实际创建并删除测试文件成功，说明服务确实能写自己的数据目录。
（第一版模板误用了 `ProtectSystem=strict`，会把整个文件系统挂成只读，已在部署前修正。）

**2026-10-18 21:32–21:41 CST 内容变更（只动数据，没改代码、没重启服务）**

| 操作 | 结果 |
| --- | --- |
| 下架两个纯占位示例 | `fennec-launcher`、`momo-reader` → 首页隐藏，`/play` 与 `/download` 均 404；发布文件按设计保留，便于回滚 |
| 清理 seed 源 | 删掉服务器 `demo/projects/` 下这两个目录，避免以后 `seed` 又把它们带回来 |
| 上线四个对比项目 | `qs1-repair-desk-deepseek`、`qs1-repair-desk-gpt`、`qs2-lost-station-deepseek`、`qs2-lost-station-gpt`，`revision` 从 5 走到 11 |
| 过程失误与回滚 | 中途我把这四个展示项目当素材加工过：复制成 `index.html`、用编造的示例工单重拍封面、改了 alt（`revision` 一度到 15）。用户指出越界后已全部回滚 |
| 回滚后的状态 | 每项 `web.entry` 指回**原文件名**（`维修工单管理台-小夜版.html` 等），release 的 `web/` 里只有那一个文件；四个 `/play` 的响应体 sha256 与原件逐一相同；封面/截图只保留「页面打开时的样子」和「点开界面后的空表单」，无任何编造数据 |
| 复核 | `/api/projects` = 7 个项目（`total 9 / published 7`，两个下架的仍占目录）；四个 `/play` 都是 302 → 200；封面 200 `image/png`；`ActiveEnterTimestamp` 全程未变，说明没重启过服务 |

刻意没有做的事：`share.fennecmomo.top` 的 DNS 记录数仍为 0，`/etc/cloudflared/config.yml` 未修改，
cloudflared 未重启；Caddy、Nginx、portfolio、managercore、core-server、hermes-bridge 以及用户级单元
全部保持原状；未安装任何 apt 包，未改 ufw，未改系统 Node 与 nodesource 源。
域名映射待单独授权后执行（见第五节）。

## 十一、回滚到上一个部署包

```bash
cd ~/fennec-share-staging
tar -xzf fennec-share-<上一个版本>.tgz
cd fennec-share && bash deploy/deploy.sh --source "$PWD"
```

代码回滚不会动数据目录；如果新版本改坏了 catalog 结构，再用 `restore` 回退数据。

## 十二、初始化 / 重设管理密码

`/admin` 在密码文件不存在时会直接拒绝登录（返回 503），所以部署完代码后要设一次密码。

```bash
cd /home/ubuntu/dev-projects/fennec-share
export DATA_DIR=/home/ubuntu/fennec-share-data
node dist/tools/admin.js set-password --password '<新密码>'   # ≥ 8 位，含字母与数字
node dist/tools/admin.js status                                 # 只显示算法与更新时间
```

如果不想在命令行里出现明文，可以本地生成派生值再拷过去：

```bash
# 本地（Windows / WSL 均可）
node dist/tools/admin.js set-password --password '<新密码>' --out ./admin-auth.json

# 服务器
sudo install -d -m 700 -o ubuntu -g ubuntu /home/ubuntu/fennec-share-data/admin
sudo install -m 600 -o ubuntu -g ubuntu ./admin-auth.json /home/ubuntu/fennec-share-data/admin/auth.json
```

要点：

- `auth.json` 必须属于服务运行用户（默认 `ubuntu`），权限 600；`DATA_DIR/admin` 目录 700。
- 改密码后**不需要重启**：每次登录都会重新读文件。改完会把其它会话踢掉。
- 自助改密码走管理页右上角「修改密码」，无需登录服务器。

部署后自检（无需密码也能做）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8770/admin          # 200
curl -s http://127.0.0.1:8770/api/admin/session                              # {"authenticated":false,...}
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8770/api/admin/login \
  -H 'content-type: application/json' -H 'x-fennec-admin: 1' -d '{"password":"wrong"}'   # 401
ls -l /home/ubuntu/fennec-share-data/admin/auth.json                          # -rw------- ubuntu
```
