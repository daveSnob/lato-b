@echo off
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" digest.mjs > ultimo-aggiornamento.log 2>&1
"C:\Program Files\nodejs\node.exe" push-reddit.mjs >> ultimo-aggiornamento.log 2>&1
