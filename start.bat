@echo off
title TradBot - Trading Intelligence
color 0B

echo.
echo  ======================================
echo     TRADBOT - Starting...
echo  ======================================
echo.

:: Kill existing processes on ports
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3001 ^| findstr LISTENING') do taskkill /PID %%a /F >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do taskkill /PID %%a /F >nul 2>&1
timeout /t 2 /nobreak >nul

:: Start Backend
echo [1/3] Starting API server...
start "TradBot-API" /MIN cmd /c "cd /d %~dp0server && node index.js"
timeout /t 4 /nobreak >nul

:: Verify Backend
curl -s http://localhost:3001/api/markets >nul 2>&1
if %errorlevel%==0 (
    echo [OK] API server running on port 3001
) else (
    echo [WARN] API server loading...
)

:: Start Frontend
echo [2/3] Starting frontend...
start "TradBot-UI" /MIN cmd /c "cd /d %~dp0client && npm run dev"
timeout /t 5 /nobreak >nul

:: Open Browser
echo [3/3] Opening browser...
start http://localhost:3000

echo.
echo  ======================================
echo     TRADBOT is running!
echo     http://localhost:3000
echo     Close this window to stop.
echo  ======================================
echo.
pause
