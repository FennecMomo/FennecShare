# 示例项目

这些项目用于本地开发和验收演示，全部通过发布 CLI 导入，不是手工写进 catalog 的。

- 所有 manifest 都带 `"demo": true`，首页和详情弹窗会显示「示例」标记。
- 示例项目不含任何伪造的 EXE / APK 安装包：没有真实二进制的项目，卡片上不会出现「可下载」。
- 现在站上只剩三个都能真正打开/下载的示例；纯占位项目已下线。
- 唯一真实存在的下载文件是 `packages/paper-notes-web-1.0.0.zip`（便签纸网页包的 ZIP），
  它既是真实的静态包，也是下载协议的真实验证对象。

## 导入

```powershell
npm run build
$env:DATA_DIR = 'D:\Projects\Test\TestShow\data'
npm run seed:demo
```

`seed` 会跳过同名且 `demo: false` 的项目，避免覆盖真实数据。

## 目录说明

| 路径 | 说明 |
| --- | --- |
| `projects/paper-notes/` | 便签纸：`web.directory` 方式发布，附一个真实 ZIP 下载 |
| `projects/pixel-garden/` | 像素花园：多页面静态站，显式 `entry`，验证子目录与相对资源 |
| `projects/midnight-clock/` | 夜间时钟：`web.package`（ZIP）方式发布，验证解压与入口探测 |
| `packages/` | 真实 ZIP：下载与解压路径共用 |

> 以前这里还有两个「只有封面、没有内容」的占位示例（桌面启动器、Momo 阅读器），
> 已经在 2026-10-18 按要求下线并删除源目录——它们在任何人都点不开，放在站上只是噪声。
> 「没有文件的卡片不显示假按钮」这个行为改由 `tools/selftest.ts` 与
> `tools/browser-check.mjs` 用临时夹具验证，不再靠站上的占位数据。

## 重建 midnight-clock 的 ZIP

源码在 `projects/midnight-clock/source/`，压缩包需要覆盖**目录内容**而不是外层目录：

```powershell
Push-Location demo\projects\midnight-clock\source
Compress-Archive -Path .\* -DestinationPath ..\..\..\packages\midnight-clock-1.0.0.zip -Force
Pop-Location
```

## 重建 paper-notes 的下载 ZIP

```powershell
Push-Location demo\projects\paper-notes\web
Compress-Archive -Path .\* -DestinationPath ..\..\..\packages\paper-notes-web-1.0.0.zip -Force
Pop-Location
```
