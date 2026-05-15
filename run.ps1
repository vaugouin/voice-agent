$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
python -m uvicorn app.main:app --host 127.0.0.1 --port 3000 *> "$PSScriptRoot\uvicorn.log"
