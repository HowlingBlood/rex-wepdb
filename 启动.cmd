@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js。请先安装 Node.js 20 或更新版本，然后重新启动。
  pause
  exit /b 1
)
node server.mjs --open
if errorlevel 1 (
  echo.
  echo 服务未能启动，请查看上方信息。
  pause
  exit /b 1
)
endlocal

