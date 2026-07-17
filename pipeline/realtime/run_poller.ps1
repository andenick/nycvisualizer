# Supervisor wrapper for the Jane NYC realtime poller.
# Restarts poller.py if it ever exits (restart-if-dead). The poller's own
# single-instance guard (port 47654 + poller.lock) makes overlapping launches
# impossible, so a stale restart simply exits until the port frees.
$ErrorActionPreference = 'Continue'
$env:PYTHONIOENCODING = 'utf-8'
# Portable: resolve everything relative to this script's own directory.
# Override the interpreter with $env:PYTHON if 'python' is not on PATH.
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$py     = if ($env:PYTHON) { $env:PYTHON } else { 'python' }
$script = Join-Path $here 'poller.py'
$logDir = Join-Path $here 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log    = Join-Path $logDir 'supervisor.log'
while ($true) {
    "$(Get-Date -Format o)  supervisor: launching poller" | Out-File -Append -Encoding utf8 $log
    try {
        # merge stdout+stderr to the log; piping (not *>>) so native stderr warnings
        # are captured as text, not raised as PowerShell NativeCommandErrors.
        & $py $script 2>&1 | Out-File -Append -Encoding utf8 $log
    } catch {
        "$(Get-Date -Format o)  supervisor: launch error: $($_.Exception.Message)" | Out-File -Append -Encoding utf8 $log
    }
    $code = $LASTEXITCODE
    "$(Get-Date -Format o)  supervisor: poller exited (code=$code); restart soon" | Out-File -Append -Encoding utf8 $log
    if ($code -eq 3) { Start-Sleep -Seconds 30 } else { Start-Sleep -Seconds 10 }
}
