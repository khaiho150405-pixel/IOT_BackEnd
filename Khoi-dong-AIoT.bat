@echo off
rem Khoi dong he thong AIoT Smart Room: Ollama, backend (cong 3100) va duong ham Internet.
rem Bam dup de chay. Giu cua so mo trong luc dung; dong cua so (hoac chay Tat-AIoT.bat) de tat.
title AIoT Smart Room
cd /d "%~dp0"
echo ==============================================================
echo   AIoT Smart Room - dang khoi dong he thong...
echo   Lan dau co the mat 1-2 phut (cho Ollama va mo hinh giong noi).
echo ==============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\aiot-supervisor.ps1"
echo.
echo He thong AIoT da dung.
pause
