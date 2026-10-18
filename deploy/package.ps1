# Windows 上的打包入口：调用 WSL 里的 GNU tar 生成部署包。
# Windows 自带的 tar.exe 不支持 --transform，所以这里借助 WSL（已验证可用）。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy/package.ps1
param(
  [string]$OutDir = 'artifacts'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
if (-not $wsl) {
  throw '没有找到 wsl.exe。请改用 Linux 服务器或 WSL 执行：bash deploy/package.sh'
}

$drive = $repo.Substring(0, 1).ToLower()
$rest = $repo.Substring(2).Replace('\', '/')
$wslRepo = "/mnt/$drive$rest"

& wsl.exe bash -lc "cd '$wslRepo' && bash deploy/package.sh '$OutDir'"
if ($LASTEXITCODE -ne 0) { throw "打包失败，退出码 $LASTEXITCODE" }