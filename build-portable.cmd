@echo off
setlocal
title NI Clock In - Portable Build
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" -Portable
set "BUILD_EXIT_CODE=%ERRORLEVEL%"
echo.
if "%BUILD_EXIT_CODE%"=="0" (
    echo Portable build completed successfully.
) else (
    echo Build failed. Review the error above before closing this window.
)
pause
exit /b %BUILD_EXIT_CODE%
