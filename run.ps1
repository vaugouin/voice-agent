param(
    [switch]$NoSubtitles,      # both native subtitle lanes off, whatever .env says (VOICE-AGENT-176)
    [string]$BindHost = "127.0.0.1",
    [int]$Port = 3000
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$flags = @("--host", $BindHost, "--port", $Port)
if ($NoSubtitles) { $flags += "--no-subtitles" }
python -m app @flags *> "$PSScriptRoot\uvicorn.log"
