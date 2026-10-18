# HTML 包规范与打包指南

试玩内容会被放到一个固定子路径下：

```
https://share.fennecmomo.top/play/<slug>/r/<releaseId>/
```

页面里的**相对路径**在这个地址下能正常工作，**以 `/` 开头的绝对路径会指向站点根**，
也就是跑到 Fennec Share 自己的资源上去，结果就是 404 或样式全丢。
这份文档说明怎么把包打成"放哪儿都能跑"的样子。

## 一、三条硬规则

1. **资源必须用相对路径**：`./assets/app.js`、`../shared/style.css`，不要用 `/assets/app.js`。
2. **入口文件叫 `index.html`，放在包根目录**（或者放在唯一的一层外层目录里）。
3. **不要假设站点根就是你的根**：任何 `fetch('/api/...')`、`new Worker('/worker.js')`
   都会打到 Fennec Share 自己的路径上。

## 二、不同构建工具的设置

| 工具 | 设置 |
| --- | --- |
| Vite | `base: './'`（默认是 `/`，必须改） |
| webpack | `output.publicPath: './'` |
| Parcel | `--public-url ./` |
| Next.js（静态导出） | `assetPrefix: './'`，且只能用 `output: 'export'` |
| Create React App | 设 `PUBLIC_URL=.`，注意 CRA 对相对路径支持一般，建议换 Vite |

Vite 例子：

```ts
// vite.config.ts
export default defineConfig({
  base: './',
  build: { outDir: 'dist' },
});
```

## 三、打包

把 **目录内容** 打进 ZIP，不要连外层目录一起打：

```bash
# 正确：解压得到 index.html、assets/...
cd my-site/dist && zip -r ../../my-site-web.zip .

# 错误：解压得到 my-site/index.html —— 虽然有外层目录也能用（工具会自动往里找一层），
#       但多套一层更容易出意外
cd my-site && zip -r ../my-site-web.zip my-site
```

Windows PowerShell：

```powershell
Push-Location .\dist
Compress-Archive -Path .\* -DestinationPath ..\my-site-web.zip -Force
Pop-Location
```

不要打包的东西：`node_modules/`、`.git/`、源码、`*.map`（可选）、本地测试文件。

## 四、常见故障对照

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| 白屏，控制台 `/assets/index-xxx.js` 404 | 写死了 `/assets` | 重新用 `base: './'` 构建 |
| 样式丢失但 HTML 出来了 | CSS 用了绝对路径 | 同上 |
| 页面能开但接口 404 | 前端直接请求了 `/api/...` | 改成相对路径，或者本项目不提供后端接口（本项目没有后端能力） |
| 刷新子页面 404 | 用了前端路由（history 模式） | manifest 里设 `"web.spaFallback": true` |
| 中文文件名乱码 | ZIP 里没标 UTF-8 | 用 `Compress-Archive` / 系统自带 zip 重新打包，别用老工具 |
| 发布时报「多个入口」 | 包里有多个 `index.html`（比如 `docs/` 里还有一份） | 删掉多余的，或在 manifest 里写 `web.entry` 指定一个 |
| 发布时报「路径不安全」 | ZIP 里有 `../`、绝对路径、盘符、符号链接 | 重新打包，别用会写绝对路径的工具 |
| 发布时报「大小写冲突」 | 包里有 `Image.png` 和 `image.png` | 改名，Windows/Linux 行为不一致的包不能上线 |

## 五、能跑什么、不能跑什么

能跑：

- 纯静态 HTML / CSS / JS，包括 canvas、Web Audio、localStorage、IndexedDB
- 打包好的 React / Vue / Svelte 等 SPA（配 `spaFallback: true`）
- 多页面站点，子目录里的 `index.html` 可以直接访问和刷新
- WASM（`.wasm` 的 MIME 已正确配置为 `application/wasm`）

不能保证：

- 需要后端接口的项目（本项目不提供任何写接口）
- 需要 `SharedArrayBuffer` 的项目（需要 COOP/COEP 头，这里没开）
- 需要 Service Worker 跨路径控制的项目
- 依赖 `window.top` 访问父页面的项目（试玩页在独立标签打开，不是 iframe）

## 六、一个最小可用的包

```
hello/
├── index.html
└── app.js
```

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hello</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <h1>Hello</h1>
    <script src="./app.js"></script>
  </body>
</html>
```

仓库里的 `demo/projects/paper-notes/`（目录方式）和 `demo/projects/midnight-clock/`（ZIP 方式）
就是两个可以直接对照的真实例子。

## 七、发布前的自检

```bash
# 1. 本地起一个静态服务器，用子路径访问一次
npx serve -l 4173 .        # 然后访问 http://127.0.0.1:4173/
# 2. 确认没有以 / 开头的资源引用
grep -rn 'src="/\|href="/' index.html assets/ || echo "没有绝对路径引用"
# 3. 发布
DATA_DIR=/home/ubuntu/fennec-share-data node dist/tools/publish.js validate --manifest <文件>
```

发布工具会自动扫一遍包内文本文件里形如 `src="/...`、`href="/...`、`url(/...` 的引用，
发现可疑就放在 `warnings` 里提醒你——**它只提示不修改**，因为盲改压缩后的 JS 只会更难查。
