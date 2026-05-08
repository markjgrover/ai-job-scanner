@echo off
:: ============================================================
::  Task Scheduler Setup — Job Match Scanner v3.0
::  Run ONCE as Administrator to schedule daily 7am scans
::
::  Right-click this file and choose "Run as administrator"
:: ============================================================

echo.
echo  Setting up Job Match Scanner daily task...
echo.

set SCRIPT_DIR=%~dp0
set SCRIPT_DIR=%SCRIPT_DIR:~0,-1%

for /f "tokens=*" %%i in ('where node 2^>nul') do set NODE_PATH=%%i
if "%NODE_PATH%"=="" (
    echo  ERROR: Node.js not found. Make sure Node.js is installed.
    pause
    exit /b 1
)

echo  Node.js: %NODE_PATH%
echo  Folder:  %SCRIPT_DIR%
echo.

schtasks /create /tn "JobMatchScanner" /tr "\"%NODE_PATH%\" \"%SCRIPT_DIR%\scan.js\" 1" /sc daily /st 07:00 /f /rl highest

if %ERRORLEVEL% EQU 0 (
    echo.
    echo  SUCCESS! Scheduled task created: "JobMatchScanner"
    echo.
    echo  Runs every day at 7:00 AM automatically.
    echo  Scans last 1 day of emails and uploads to markjgrover.com/jobs/
    echo.
    echo  Useful commands:
    echo    Run now:    schtasks /run /tn "JobMatchScanner"
    echo    Remove:     schtasks /delete /tn "JobMatchScanner" /f
    echo    View:       Open Task Scheduler and find "JobMatchScanner"
    echo.
) else (
    echo.
    echo  Failed. Right-click this file and choose "Run as administrator".
    echo.
)

pause
