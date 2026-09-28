@echo off
setlocal
title NI Clock In - Build

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1"
set "BUILD_EXIT_CODE=%ERRORLEVEL%"

echo.
if "%BUILD_EXIT_CODE%"=="0" (
    echo Build completed successfully.
) else (
    echo Build failed. Review the error above before closing this window.
)
echo.
pause
exit /b %BUILD_EXIT_CODE%
