@echo off
setlocal enabledelayedexpansion
cd /d C:\Users\Administrator\Desktop\TEMPINT
set PYTHONUNBUFFERED=1
waitress-serve --listen=127.0.0.1:8080 wsgi:app