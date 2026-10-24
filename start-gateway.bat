@echo off
rem Starts the AI Gateway. First run installs dependencies and builds.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22.5 or newer is required: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo Installing dependencies...
  call npm install || (pause & exit /b 1)
)
if not exist server\dist\index.js (
  echo Building...
  call npm run build || (pause & exit /b 1)
)
if not exist web\dist\index.html (
  echo Building dashboard...
  call npm run build || (pause & exit /b 1)
)
start "" http://127.0.0.1:8787
node server\dist\index.js
pause
