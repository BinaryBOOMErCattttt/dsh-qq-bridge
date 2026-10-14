@echo off
REM QQ Bridge × NapCat 的一键配置（Windows 桌面版）。
REM
REM 双击运行 = 自动探测 + 配好 NapCat 的网络配置 + 写好 profile 的 .env + 把插件装进
REM desktop profile（每一步都是幂等 + 先备份）。想看它到底会做什么，先跑：
REM
REM     scripts\napcat-setup.cmd --dry-run
REM
REM 传了参数就把它原样交给 node 脚本；双击（没有参数）时结尾停一下，好让人看见结果。
setlocal EnableExtensions
cd /d "%~dp0.." || exit /b 1
chcp 65001 >nul

set "NODE_EXE="
where node >nul 2>&1 && set "NODE_EXE=node"
if not defined NODE_EXE if defined DSH_DESKTOP_NODE_EXECUTABLE set "NODE_EXE=%DSH_DESKTOP_NODE_EXECUTABLE%"
if not defined NODE_EXE (
  echo 找不到 node.exe。
  echo 这个脚本需要 Node.js 22 或更高版本：装一个（https://nodejs.org）之后重开一个终端再试，
  echo 或者从「DeepSeek Harness 的开发者终端」里运行它（那里 PATH 上有它自带的 node）。
  if "%~1"=="" pause
  exit /b 1
)

"%NODE_EXE%" "%~dp0napcat-setup.mjs" %*
set "EXITCODE=%ERRORLEVEL%"

if "%~1"=="" (
  echo.
  echo 退出码 %EXITCODE%（0 = 全部配好；2 = NapCat 配好了，但 profile 那一步没成）
  pause
)
exit /b %EXITCODE%
