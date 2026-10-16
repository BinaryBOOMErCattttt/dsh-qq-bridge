@echo off
REM QQ Bridge × NapCat 的一键配置（Windows 桌面版）。
REM
REM 双击运行 = 自动探测 + 配好 NapCat 的网络配置 + 写好 profile 的 .env + 把插件装进
REM desktop profile（每一步都是幂等 + 先备份）。想看它到底会做什么，先跑：
REM
REM     scripts\napcat-setup.cmd --dry-run
REM
REM 传了参数就把它原样交给 node 脚本；双击（没有参数）时结尾停一下，好让人看见结果。
REM
REM 想确认自己用的是哪份 node，跑 `scripts\napcat-setup.cmd --where`。
REM
REM 三个 cmd 的坑（都是实测踩出来的，别顺手「简化」）：
REM   * `if not "%V%"==""` 而不是 `if defined V`：桌面版注入的变量可能是**一个空格**，
REM     `if defined` 认它，于是后面的 `for %%D in (" ")` 会把一个空格当命令去跑。
REM   * 括号块里不要出现引号套引号（`if not defined V if not "%V%"=="" ...`）：
REM     cmd 会直接报 `The syntax of the command is incorrect.`，而那句话里没有行号。
REM   * 去空格那一步（`%V: =%`）必须**单独占一行**：写进 `if` 里时 cmd 会把替换语法本身
REM     当成命令的一部分，同样报那句没有行号的语法错误（实测）。
REM   * 这个文件必须是 CRLF（见 .gitattributes）：LF 的 .cmd 在括号块与标签上会认错行。
setlocal EnableExtensions
cd /d "%~dp0.." || exit /b 1
chcp 65001 >nul

REM 找 node.exe。顺序是有讲究的：
REM   1. PATH 上的（用户自己装过 Node 就用它，最不意外）；
REM   2. 桌面版注入的环境变量；
REM   3. **桌面版自带的那份 Node**（`resources\runtime\<版本>\dependencies\node\bin\node.exe`，
REM      实测 v24.x，能独立跑这个脚本）。「装了 DSH 的机器上不一定装过 Node」是发布版最常见
REM      的一堵墙：那份 Node 在 resources 里、不暴露给 PATH，用户双击 .cmd 时当然找不到它。
REM      所以「新用户能不能一键配好」就取决于这一步探不探得到。
REM      刻意**不**退到 `resources\runtime\bin\node.cmd`：那份包装自己是
REM      `"%DSH_DESKTOP_NODE_EXECUTABLE%" --expose-internals %*`，而桌面版双击启动时那个变量
REM      并不存在 —— 调它只会得到一句 `'" "' is not recognized`（实测）。
REM 安装目录只探常见的几处，不遍历全盘。
set "NODE_EXE="
where node >nul 2>&1 && set "NODE_EXE=node"
REM 先把桌面版那个变量里的空格去掉再判空：它可能是空串、也可能是一个空格（实测两种都出现过），
REM 而一个空格会让 `for %%D in (" ")` 把空格当命令去跑。
set "DSH_NODE=%DSH_DESKTOP_NODE_EXECUTABLE: =%"
if "%NODE_EXE%"=="" if not "%DSH_NODE%"=="" set "NODE_EXE=%DSH_DESKTOP_NODE_EXECUTABLE%"
if "%NODE_EXE%"=="" call :find_bundled_node
if "%NODE_EXE%"=="" goto no_node

"%NODE_EXE%" "%~dp0napcat-setup.mjs" %*
set "EXITCODE=%ERRORLEVEL%"

if "%~1"=="" (
  echo.
  echo 退出码 %EXITCODE%（0 = 全部配好；2 = NapCat 配好了，但 profile 那一步没成）
  pause
)
exit /b %EXITCODE%

:no_node
echo 找不到 node.exe：这个脚本要靠 node 跑同一个目录里的 napcat-setup.mjs。
echo.
echo 桌面版 DSH 自带一份 Node，就在它的安装目录里：
echo     ^<DSH 安装目录^>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
echo 常见位置是 "%%ProgramFiles%%\DeepSeek Harness" 或 "%%LOCALAPPDATA%%\Programs\DeepSeek Harness"，
echo 我们都没找到。两种办法：
echo   1^) 把上面那条路径换成你的实际安装位置，然后在仓库根目录直接调用：
echo        那串路径\node.exe scripts\napcat-setup.mjs
echo   2^) 装一个 Node.js（https://nodejs.org，22 或更高）之后重开终端再跑本脚本。
if "%~1"=="" pause
exit /b 1

REM ---- 探测桌面版自带的那份 Node --------------------------------------------
REM 为什么写成子过程：主流程要能在「一个都没找到」时干净地继续（`call` 会返回）。
:find_bundled_node
call :try_node "%ProgramFiles%\DeepSeek Harness"
call :try_node "%ProgramFiles(x86)%\DeepSeek Harness"
call :try_node "%LOCALAPPDATA%\Programs\DeepSeek Harness"
call :try_node "%LOCALAPPDATA%\DeepSeek Harness"
REM 装在别的盘（D 盘最常见）：探几个常见位置，而不是递归搜。
call :try_node "D:\DeepSeek Harness"
call :try_node "D:\Program Files\DeepSeek Harness"
call :try_node "D:\Apps\DeepSeek Harness"
REM 用户自己解到 %USERPROFILE% 下也见得到。
call :try_node "%USERPROFILE%\DeepSeek Harness"
call :try_node "%USERPROFILE%\Desktop\DeepSeek Harness"
exit /b 0

REM 试一个候选安装目录：只认「里面确实有桌面版的 resources\runtime」的那些，
REM 免得把随便一个同名目录当成安装位置。版本目录名（primary-runtime）会变，所以扫一层。
:try_node
if not "%NODE_EXE%"=="" exit /b 0
set "DSH_DIR=%~f1"
if not exist "%DSH_DIR%\resources\runtime" exit /b 0
for /d %%R in ("%DSH_DIR%\resources\runtime\*") do call :pick_node "%%~fR"
exit /b 0

:pick_node
if not "%NODE_EXE%"=="" exit /b 0
if exist "%~f1\dependencies\node\bin\node.exe" set "NODE_EXE=%~f1\dependencies\node\bin\node.exe"
exit /b 0
