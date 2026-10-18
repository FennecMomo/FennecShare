# Hermes 发布指南

这份文档是给 Hermes（以及任何接手发布的人）看的：怎么把一个新项目安全地放上线。
所有操作都在服务器上的代码目录里执行，**不需要改代码、不需要重启服务**。

## 一、前置

```bash
cd /home/ubuntu/dev-projects/fennec-share
export DATA_DIR=/home/ubuntu/fennec-share-data
export PUBLIC_BASE_URL=https://share.fennecmomo.top
CLI="node dist/tools/publish.js"
```

发布前先确认服务是活的：

```bash
curl -s http://127.0.0.1:8770/healthz
```

## 二、三步发布

### 1. 准备目录

```
/home/ubuntu/fennec-share-staging/my-tool/
├── manifest.json
├── MyTool-1.0.0.exe        # 下载文件（可选）
├── web/                    # 网页包目录（可选）
│   └── index.html
└── media/
    ├── cover.png           # 封面（可选）
    └── shot-1.png          # 截图（可选，最多 20 张）
```

所有相对路径都以 **manifest 所在目录** 为基准，和你在哪个目录执行命令无关。

### 2. 写 manifest.json

最小可用（只有下载）：

```json
{
  "slug": "my-tool",
  "title": "我的小工具",
  "summary": "一句话说明它做什么。",
  "categories": ["desktop"],
  "downloads": [
    {
      "fileName": "MyTool-1.0.0.exe",
      "path": "MyTool-1.0.0.exe",
      "platform": "windows",
      "version": "1.0.0",
      "default": true
    }
  ]
}
```

带网页试玩 + 多平台下载：

```json
{
  "slug": "my-tool",
  "title": "我的小工具",
  "summary": "一句话说明它做什么。",
  "description": "详情弹窗里的正文，可以换行。\n第二段。",
  "categories": ["web", "desktop", "mobile"],
  "displayVersion": "1.0.0",
  "sortOrder": 10,
  "cover": { "path": "media/cover.png", "alt": "我的小工具封面" },
  "screenshots": [
    { "path": "media/shot-1.png", "alt": "主界面" }
  ],
  "web": { "directory": "web", "entry": "index.html", "spaFallback": false },
  "downloads": [
    { "fileName": "MyTool-1.0.0.exe", "path": "MyTool-1.0.0.exe", "platform": "windows", "version": "1.0.0", "default": true },
    { "fileName": "MyTool-1.0.0.apk", "path": "MyTool-1.0.0.apk", "platform": "android", "version": "1.0.0" }
  ]
}
```

用 ZIP 当网页包时把 `web.directory` 换成 `web.package: "web.zip"`。

### 3. 发布

```bash
# 先只校验，不写盘
$CLI validate --manifest /home/ubuntu/fennec-share-staging/my-tool/manifest.json

# 看将要发生什么
$CLI publish --manifest /home/ubuntu/fennec-share-staging/my-tool/manifest.json --dry-run

# 正式发布
$CLI publish --manifest /home/ubuntu/fennec-share-staging/my-tool/manifest.json
```

成功后返回 JSON（加 `--json` 时是纯 JSON，方便程序解析）：

```json
{
  "ok": true,
  "status": "created",
  "changed": true,
  "slug": "my-tool",
  "releaseId": "r-20261018t131500z-a1b2c3",
  "catalogRevision": 7,
  "parts": ["web", "downloads", "media", "meta"],
  "web": { "entry": "index.html", "publicUrl": "/play/my-tool/", "absoluteUrl": "https://share.fennecmomo.top/play/my-tool/" },
  "downloads": [ { "fileName": "MyTool-1.0.0.exe", "publicUrl": "/download/my-tool/MyTool-1.0.0.exe", "size": 1234567, "sha256": "…" } ],
  "warnings": [],
  "message": "新增项目 my-tool 成功（catalog revision 7）。"
}
```

`status` 的取值：

| 值 | 含义 | 后续动作 |
| --- | --- | --- |
| `created` | 新项目上线 | 打开 `/play/my-tool/` 与下载地址核对 |
| `updated` | 已有项目更新 | 同上，注意 `parts` 里说明了改了哪部分 |
| `unchanged` | 内容与线上完全一致，没有创建新版本 | 不用做任何事 |
| `validated` | 只跑了 `--dry-run` | 去掉 `--dry-run` 再跑一次 |

## 三、字段全表

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `slug` | 是 | 小写字母/数字/连字符，不能连续连字符，最长 64；决定所有 URL |
| `title` | 是 | 最长 120 |
| `summary` | 否 | 最长 400；不写会填「该项目暂未提供简介。」 |
| `description` | 否 | 详情正文，最长 20000，换行会保留 |
| `categories` | 否 | `web` / `desktop` / `mobile`；不写会按实际文件推导，推导不出就报错 |
| `displayVersion` | 否 | 显示用版本号，最长 40；可以是字符串或数字 |
| `sortOrder` | 否 | 数字，越大越靠前，默认 0 |
| `published` | 否 | 默认 `true`；`false` 等于发布成下架状态 |
| `demo` | 否 | 默认 `false`；`true` 会在页面显示「示例」 |
| `cover` | 否 | 图片路径，或 `{ path, alt }`，或 `null` 表示清空 |
| `screenshots` | 否 | 图片路径数组（最多 20），或 `[{ path, alt }]`，空数组表示清空 |
| `web.package` | 二选一 | ZIP 包路径 |
| `web.directory` | 二选一 | 静态目录路径 |
| `web.entry` | 否 | 入口文件（相对包根目录）。包内有多个 `index.html` 时**必须**指定 |
| `web.spaFallback` | 否 | 默认 `false`；前端路由（history 模式）的项目设为 `true` |
| `downloads[].fileName` | 是 | 对外文件名：不能含路径分隔符、控制字符、首尾空格；同项目内不能重名 |
| `downloads[].path` | 是 | 源文件路径 |
| `downloads[].platform` | 是 | `windows` / `android` / `html` / `linux` / `macos` / `other` |
| `downloads[].version` | 否 | 显示用版本 |
| `downloads[].default` | 否 | `/download/<slug>` 快捷地址用哪个，最多一个 |
| `downloads[].contentType` | 否 | 覆盖 MIME 类型，一般不用写 |
| `removeDownloads` | 否 | 要移除的旧文件名数组（不加就永远保留） |

未知字段会被忽略并在 `warnings` 里提示——如果写错了字段名，注意看这条警告。

## 四、限额（默认值，可用环境变量调整）

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `FH_PUBLISH_MAX_DOWNLOAD_BYTES` | 4 GiB | 单个下载文件 |
| `FH_PUBLISH_MAX_IMAGE_BYTES` | 12 MiB | 单张封面/截图 |
| `FH_PUBLISH_MAX_ZIP_BYTES` | 2 GiB | ZIP 包本身 |
| `FH_PUBLISH_MAX_FILES` | 20000 | 包内文件数 |
| `FH_PUBLISH_MAX_UNCOMPRESSED_BYTES` | 4 GiB | 解压后总体积 |
| `FH_PUBLISH_MAX_ENTRY_BYTES` | 512 MiB | 包内单文件 |
| `FH_PUBLISH_EXTRA_EXTENSIONS` | 空 | 额外允许的下载扩展名，逗号分隔 |

允许的下载扩展名：`exe msi msix appx apk ipa zip 7z dmg pkg deb rpm appimage tar gz tgz xz zst jar`。

> 服务器出口带宽约 5 Mbps：给访客下载 100 MB 的文件需要 3 分钟以上，大文件请在项目简介里标清大小。

## 五、错误码与处理

| 错误码 | 含义 | 怎么修 |
| --- | --- | --- |
| `manifest_missing` | manifest 路径不存在 | 检查绝对路径 |
| `manifest_invalid` | 字段校验失败 | 按提示逐条改，一次会列出全部问题 |
| `invalid_package` | 包内容有问题（路径穿越、符号链接、缺入口、多入口、超限、大小写冲突） | 按提示重新打包 |
| `lock_busy` | 另一个发布正在跑 | 等它结束；确认无进程后删 `DATA_DIR/.publish.lock` |
| `invalid_catalog` | 现有 catalog 结构损坏 | 从 `DATA_DIR/backups/` 找最近可用的恢复 |
| `project_not_found` | `unpublish`/`rollback` 指定的 slug 不存在 | 先 `list` |
| `invalid_backup` | 备份清单校验失败 | 重新备份，别手工改备份文件 |

退出码：`0` 成功，`1` 执行失败，`2` 输入/manifest 不合法。

## 六、更新已有项目

- **只换网页**：manifest 里只留 `web`，其他字段照抄上次的元信息即可（元信息以 manifest 为准，
  漏写会变回默认值）。想保留原有截图就不要写 `screenshots`。
- **只加一个新平台**：只写新的 `downloads` 项，旧的会自动保留。
- **删旧文件**：必须写 `removeDownloads`。
- 重复发布完全相同的 manifest 会返回 `unchanged`，不会刷一堆版本目录。
- 只改封面/截图的描述（`alt`）也算 `media` 变更，CLI 会把它归到 `media` 而不是 `meta`；
  这时图片本身可能没变，新的 release 里图片 sha256 与上一个版本相同，属于预期。
- 每次发布都会留一份状态快照，改错了用 `rollback --slug <slug>` 回到上一个状态。

## 七、下架与恢复

```bash
$CLI unpublish --slug my-tool --reason "等 2.0 版本"
```

下架后：首页不再显示、`/play/my-tool/` 与 `/download/...` 都返回 404，**文件保留**。
恢复只要重新发布一次同样的 manifest（`published` 默认就是 `true`）。

## 八、发不出去时先自查

1. `$CLI validate --manifest <文件>` 能过吗？
2. 包的根目录里到底有没有 `index.html`？（有外层目录也行，工具会自动往里找一层）
3. 网页包是不是把 `/assets/...` 写死了？→ 见 [HTML_PACKAGE_GUIDE.md](HTML_PACKAGE_GUIDE.md)
4. 下载文件名是否带了路径分隔符、前后空格、特殊字符？
5. `df -h` 还有空间吗？`/healthz` 正常吗？

## 九、发布后的核对清单

```bash
$CLI list --json | head -40
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8770/play/my-tool/
curl -sI http://127.0.0.1:8770/download/my-tool/MyTool-1.0.0.exe | head -8
```

- [ ] 首页能看到卡片，分类正确
- [ ] `/play/<slug>/` 302 到版本目录后能正常加载
- [ ] 下载能下，`Content-Length` 与文件大小一致，SHA-256 与返回的 JSON 一致
- [ ] 详情弹窗里没有空按钮
