# 架构说明

## 一、进程与请求链路

只有一个 Node 进程（`dist/server/index.js`），Express 5 按固定顺序挂载中间件：

```
请求
 ├── 安全头 / 访问日志
 ├── GET /healthz                       → 健康检查（含 catalog 版本）
 ├── /api/*                             → GET /api/projects、GET /api/projects/:slug
 ├── /play/*                            → 在线试玩：稳定入口重定向 + 版本目录静态服务
 ├── /download/*                        → 下载：流式 + Range + Content-Disposition
 ├── /media/*                           → 封面/截图：只允许 catalog 登记过的图片
 ├── 站点静态文件                        → dist/web（index.html 带 CSP）
 └── 404 / 500
```

顺序是刻意的：`/play` 和 `/download` 必须在站点静态之前，否则会被前端路由抢走。
每个前缀中间件自己解析 `req.path`（按 `/` 切段、逐段 decodeURIComponent），
没有使用 Express 的通配路由语法，避免 `path-to-regexp` 版本差异带来的坑。

前端是纯静态资源，`index.html` 由服务端注入 CSP 头；`/assets/*` 走一年期不可变缓存，
其它文件一小时。前端所有请求都是同源相对路径，没有任何域名或端口写死。

## 二、数据布局

```
DATA_DIR/
├── catalog.json                      # 唯一索引，schemaVersion = 1
├── .publish.lock                     # 写锁（O_CREAT|O_EXCL）
├── projects/<slug>/
│   ├── releases/<releaseId>/
│   │   ├── web/                      # 试玩内容（index.html 及其资源）
│   │   ├── downloads/<存储名>         # 下载文件
│   │   ├── media/<文件名>             # 封面/截图
│   │   └── release.json              # 这一版的清单：哈希、大小、来源 manifest
│   └── history/000001-publish.json   # 每次发布/下架/回滚的完整状态快照
├── staging/<随机名>/                  # 发布过程中的临时目录，成功后 rename 成 release
└── backups/                          # catalog 自动备份（保留最近 30 份）
```

关键点：

- **代码与数据分离**：数据目录可以用 `DATA_DIR` 指到仓库之外，部署时就是这样做的。
- **一个 release 一个目录**：URL 里带 `releaseId`，所以静态资源可以发 `immutable` 长缓存，
  换版本就是换 URL，不需要缓存失效逻辑。
- **history 是状态快照而不是 diff**：回滚就是把某份快照原样写回 catalog，简单且不会算错。
- **staging 与 projects 在同一个文件系统**：发布成功的最后一步是 `rename`，要么整份出现，
  要么完全不出现，不会留下半个版本目录。

## 三、catalog 结构

```jsonc
{
  "schemaVersion": 1,
  "revision": 12,                       // 每次改动 +1，前端可用它判断是否更新
  "generatedAt": "2026-10-18T12:45:03.100Z",
  "projects": [
    {
      "id": "demo-tool",
      "slug": "demo-tool",
      "title": "演示工具",
      "summary": "……",
      "description": "……",              // 详情弹窗正文，保留换行
      "categories": ["web", "desktop"],  // 至少一个
      "cover": { "url": "/media/demo-tool/r/r-.../cover-ab12cd34ef.svg", "alt": "…", "sha256": "…" },
      "screenshots": [ /* 同上 */ ],
      "createdAt": "…", "updatedAt": "…", "publishedAt": "…",
      "displayVersion": "1.0.0",         // 可为 null
      "sortOrder": 10,                   // 越大越靠前
      "published": true,                 // false = 下架，接口不返回
      "demo": true,                      // 示例数据标记，UI 显示「示例」
      "web": {
        "releaseId": "r-20261018t124503z-ef8585",
        "entry": "index.html",
        "publicUrl": "/play/demo-tool/",  // 对外永远是稳定入口
        "spaFallback": false,
        "contentHash": "…",               // 内容指纹，用于幂等判断
        "publishedAt": "…"
      },
      "downloads": [
        {
          "id": "dl-9f2c1a7be340",
          "fileName": "演示工具-1.0.0.apk",
          "platform": "android",
          "version": "1.0.0",
          "size": 12345,
          "sha256": "…",
          "contentType": "application/vnd.android.package-archive",
          "publicUrl": "/download/demo-tool/%E6%BC%94%E7%A4%BA%E5%B7%A5%E5%85%B7-1.0.0.apk",
          "releaseId": "r-…",
          "isDefault": false,
          "storage": "projects/demo-tool/releases/r-…/downloads/01-9f2c1a7b.apk"
        }
      ],
      "releaseHistory": [ { "releaseId": "r-…", "createdAt": "…", "parts": ["web","downloads"], "fingerprint": "…" } ],
      "lastFingerprint": "…"
    }
  ]
}
```

- 对外接口用 `toPublicProject()` 剥掉 `storage` 等内部字段，前端拿不到磁盘路径。
- `validateCatalog()` 在**读**和**写**两侧都跑：读的时候发现不合法就回退到上一份可用 catalog
  并记日志，写的时候不合法直接拒绝发布，绝不把坏数据落盘。
- 校验覆盖：slug 唯一且格式合法、文件名唯一、文件 id 唯一、最多一个默认下载、
  `sha256` 是 64 位十六进制、`storage` 是安全的相对路径、`web.publicUrl` 必须是 `/play/<slug>/`、
  URL 必须同源相对路径。

## 四、发布事务

`publishProject()` 是唯一的写入口，步骤固定：

1. **解析 manifest**（相对路径以 manifest 所在目录为基准），一次性收集所有字段错误。
2. **加写锁**：`DATA_DIR/.publish.lock`，`O_CREAT|O_EXCL` 原子创建；并发发布会排队等待
   （默认 30 秒），进程崩了留下的锁按 15 分钟过期或 pid 存活性回收。
3. **暂存内容**到 `staging/<随机名>`：
   - ZIP 走安全解压（拒绝 `..`、绝对路径、盘符、UNC、符号链接、大小写冲突，限制文件数与总体积）；
   - 目录走安全复制（同样的检查）；
   - 探测入口：显式 `entry` 优先，否则找唯一的 `index.html`，多个就报错要求指定，不猜；
   - 媒体与下载文件各自算出 SHA-256，下载文件按内容哈希命名，避免同名不同内容被浏览器缓存混淆。
4. **算出最终项目记录**（新内容 + 上次保留的部分）并计算内容指纹。
5. **幂等判断**：指纹与上次相同且 `published` 状态没变 → 直接返回 `unchanged`，不创建新版本。
6. **落盘**：把 staging 目录 `rename` 成 `projects/<slug>/releases/<releaseId>`，写入 `release.json`。
7. **追加历史快照**到 `projects/<slug>/history/`。
8. **原子替换 catalog**：写同目录临时文件 → `fsync` → `rename` 覆盖 → `fsync` 目录；
   替换前把旧 catalog 备份到 `backups/`（保留最近 30 份）。
9. **释放写锁**。

任何一步失败，catalog 都不会被改；最多留下一个未被引用的 release 目录（不影响线上，
可以用 `cleanup` 的约定手工清理）。中途失败时旧项目仍然完整可用。

合并规则（容易踩坑的地方）：

- 下载按 `fileName` 合并：新文件名出现在本次发布里就替换，没出现就保留。
  文件名带版本号（`Tool-1.0.0.exe`）时，旧版本会**保留**——这正是"只加一个新平台不会误删别的"的原因。
- 想删旧文件必须显式写 `removeDownloads: ["旧文件名"]`。
- 只提交 APK 时不会动网页入口和 EXE；只提交网页时不会动下载。
- `categories`、`title` 等元信息以 manifest 为准（manifest 是元信息的唯一来源）。

## 五、缓存策略

| 内容 | 头 | 原因 |
| --- | --- | --- |
| `/assets/*`（前端构建产物） | `public, max-age=31536000, immutable` | 文件名带内容哈希 |
| `/play/<slug>/r/<releaseId>/*` | 同上 | 版本目录本身就不可变 |
| `/media/<slug>/r/<releaseId>/*` | 同上 | 同上 |
| `/download/<slug>/<file>` | `public, max-age=3600` + `ETag` + `Last-Modified` | 单文件可能被同 URL 替换 |
| `/api/projects` | `no-store` | 发布后必须立刻看到 |
| `index.html` | `no-cache` | 保证引用到最新的 assets |

catalog 缓存在进程内，靠 `(mtimeMs, size)` 判断是否需要重读；并发请求共用同一个读取中的
Promise，避免惊群。解析失败时保留上一份可用 catalog，只记日志。

## 六、安全边界

- **路径**：所有磁盘路径都由 `resolveWithin()` 拼装，请求里的路径段先拒绝 `/`、`\`、`.`、`..`
  和非法百分号编码；下载只接受 catalog 里登记过的文件名（NFC 归一化后比较）；
  媒体只接受 catalog 里登记过的图片且扩展名必须是图片类型。
- **头**：站点页面发 CSP（`script-src 'self'`、`frame-ancestors 'none'`）与 `X-Frame-Options: DENY`。
  试玩内容**不发** CSP，也不发 `X-Frame-Options` —— 大量现成的 HTML 包依赖内联脚本和 CDN 资源，
  一刀切会直接白屏；试玩是"用户信任的第三方静态内容"，隔离靠独立目录和不共享 cookie，
  不靠 CSP。这个取舍写在这里，是为了以后不要"顺手加上"。
- **信息泄露**：`catalog.json`、`release.json`、history 快照都不在可访问路径里；
  `/api/projects` 不含 `storage` 与绝对路径。
- **写操作**：只有 CLI 能写 catalog，HTTP 层没有任何写入接口。

## 七、前端状态机

```
loading ──成功──> ready（有数据）
   │                 └── 定时/聚焦刷新失败 ──> ready（保留旧数据 + 顶部提示条 + 重试）
   └──失败──> error（整页错误面板 + 重试）
ready(空数组) ──> 空状态面板
ready + 有筛选 + 过滤后为空 ──> 筛选空状态面板（一键清空筛选）
```

- 刷新节流 30 秒，避免切标签页反复打接口。
- 详情弹窗用原生 `<dialog>` + `showModal()`：焦点陷阱、`Esc`、焦点归位都是浏览器实现，
  比手写更可靠；遮罩点击通过比较 `event.target === dialog` 判断。
- 打开的弹窗里如果项目在刷新后消失（比如被下架），会自动关闭，不会留下悬空面板。
