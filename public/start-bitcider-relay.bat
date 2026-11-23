@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 20 or newer is required to run the BitCider desktop relay.
  echo Install Node.js from https://nodejs.org/ and then reopen this file.
  pause
  exit /b 1
)
echo Starting your BitCider desktop Cider relay...
echo Keep this window open while using the BitChord addon.
echo.
node "%~dp0bitcider-relay.mjs"
echo.
echo The BitCider relay has stopped.
pause
