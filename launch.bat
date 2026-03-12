@echo off
set ELECTRON_RUN_AS_NODE=
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0electron\main.js"
