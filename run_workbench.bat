@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo   LocalTexOCR Workbench Starting...
echo ========================================

if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] .venv folder not found. Please install dependencies first.
    pause
    exit /b
)

:: Kill old instance if already running on port 3000
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000') do (
    if NOT "%%a"=="" (
        echo Cleaning up existing process on port 3000...
        taskkill /f /pid %%a >nul 2>&1
    )
)

:: Start browser after delay
echo Waiting for server... (3s delay for browser)
start /b cmd /c "timeout /t 3 >nul && start http://localhost:3000"

:: Start server
echo Starting LocalTexOCR server on port 3000...
.venv\Scripts\python.exe server.py

if %ERRORLEVEL% neq 0 (
    echo [ERROR] Server exited unexpectedly.
    pause
)
pause
