@echo off
title FisioGestao (desenvolvimento)
cd /d "%~dp0"
if not exist ".env" (echo Crie o arquivo .env a partir de .env.example antes de iniciar. & pause & exit /b 1)
start "" http://localhost:3000
node server\server.js
pause
