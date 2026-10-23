@echo off
title 页边 · 本地阅读
cd /d "%~dp0margin"
if not exist "server\index.mjs" (
  echo 找不到 server\index.mjs，请先构建。
  pause
  exit /b 1
)
node "server\index.mjs"
echo.
echo 服务已退出。
pause