@echo off
chcp 65001 >nul 2>&1
title 律政工作台
set "PATH=E:\node-v24.19.0-win-x64\node-v24.19.0-win-x64;%PATH%"
cd /d E:\DEMO
start http://localhost:1420
npm run dev
