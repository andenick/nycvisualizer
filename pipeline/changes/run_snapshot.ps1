# JaneNYCGtfsSnap — 6-hourly GTFS snapshot + diff cycle (S3).
# Registered as Windows Scheduled Task "JaneNYCGtfsSnap" (interactive user).
# Env-parameterized: NYCV_PIPELINE_ROOT points at the NYCPlatform root so the Python
# code carries no absolute path literals (public-repo hygiene).

# NOTE: ErrorActionPreference is deliberately "Continue". Python/urllib3 emits a benign
# RequestsDependencyWarning to stderr; under "Stop" PowerShell would treat that native
# stderr write as a terminating NativeCommandError and abort the run. We keep Continue
# and additionally silence the warning at source via PYTHONWARNINGS.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path      # ...\changes
$platform = Split-Path -Parent $here                          # ...\NYCPlatform
$env:NYCV_PIPELINE_ROOT = $platform
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONWARNINGS = "ignore"
$env:PYTHONUNBUFFERED = "1"

$logdir = Join-Path $here "logs"
New-Item -ItemType Directory -Force -Path $logdir | Out-Null
$log = Join-Path $logdir ("gtfssnap-" + (Get-Date -Format "yyyy-MM-dd") + ".log")

$stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
Add-Content -Path $log -Value "==== $stamp  run_diffs.py start ===="
# Merge stderr into stdout (2>&1) and append everything to the log. Merging avoids the
# native-stderr terminating-error trap entirely.
& "python" (Join-Path $here "run_diffs.py") 2>&1 | Add-Content -Path $log
$code = $LASTEXITCODE
Add-Content -Path $log -Value "==== exit $code ===="
exit $code
