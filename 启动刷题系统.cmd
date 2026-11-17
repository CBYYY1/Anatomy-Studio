@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo   Anatomy Studio - local study system
echo   ------------------------------------------------
echo.

set "PY="

rem ---- 1) python on PATH ----
for %%P in (python.exe) do if not defined PY set "CAND=%%~$PATH:P"
if defined CAND (
  "!CAND!" -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PY=!CAND!"
)

rem ---- 2) common install locations ----
if not defined PY (
  for %%C in (
    "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
    "%USERPROFILE%\miniconda3\python.exe"
    "%USERPROFILE%\anaconda3\python.exe"
    "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
    "C:\Python313\python.exe"
    "C:\Python312\python.exe"
  ) do (
    if not defined PY if exist %%C (
      %%C -c "import sys" >nul 2>nul
      if not errorlevel 1 set "PY=%%~C"
    )
  )
)

if not defined PY (
  echo   [!] Python not found.
  echo       Install Python 3.10+ from https://www.python.org/downloads/
  echo       Remember to tick "Add python.exe to PATH".
  echo.
  pause
  exit /b 1
)

rem ---- 3) make sure fastapi / uvicorn exist ----
"!PY!" -c "import fastapi, uvicorn" >nul 2>nul
if errorlevel 1 (
  echo   Installing dependencies ^(fastapi, uvicorn^) ...
  "!PY!" -m pip install --disable-pip-version-check -q fastapi uvicorn
  "!PY!" -c "import fastapi, uvicorn" >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   [!] Failed to install fastapi / uvicorn.
    echo       Run manually:  "!PY!" -m pip install fastapi uvicorn
    echo.
    pause
    exit /b 1
  )
)

echo   Python : !PY!
echo   Starting server ...
echo.

"!PY!" "%~dp0server.py"

echo.
echo   Server stopped.
pause
