@echo off
rem Tat he thong AIoT Smart Room (backend, giong noi, duong ham Internet).
title Tat AIoT Smart Room
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-aiot.ps1"
echo.
pause
