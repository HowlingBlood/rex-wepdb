@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 20 或更新版本。
  pause
  exit /b 1
)
node scripts/build-visitor.mjs
if errorlevel 1 (
  echo 构建失败，请查看上方提示。
  pause
  exit /b 1
)
node scripts/serve-visitor.mjs --open
if errorlevel 1 (
  echo 访客页服务未能启动，请查看上方提示。
  pause
  exit /b 1
)
endlocal
