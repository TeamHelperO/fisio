@echo off
title FisioGestao
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>nul || set "NODE=%LOCALAPPDATA%\Programs\node-v26.13.1-win-x64\node.exe"
if not exist "%NODE%" if not "%NODE%"=="node" (echo Node.js nao encontrado. Instale em https://nodejs.org & pause & exit /b 1)
start "" http://localhost:3000
"%NODE%" --disable-warning=ExperimentalWarning server\server.js
pause
