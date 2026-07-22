# JaneNYCDerive — hourly realtime-derivation cycle (S2 derive2).
# Registered as Windows Scheduled Task "JaneNYCDerive" (interactive user), hourly at :20
# (offset from the poller flush windows so it reads settled archive hours).
# Env-parameterized: NYCV_PIPELINE_ROOT points at the NYCPlatform root so the Python code
# carries no absolute path literals (public-repo hygiene). Mirrors changes/run_snapshot.ps1.

# ErrorActionPreference stays "Continue": Python/urllib3 emits a benign
# RequestsDependencyWarning to stderr; under "Stop" PowerShell would treat that native
# stderr write as a terminating NativeCommandError and abort. We keep Continue and also
# silence warnings at source via PYTHONWARNINGS.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path      # ...\realtime\derive2
$platform = Split-Path -Parent (Split-Path -Parent $here)    # ...\NYCPlatform
$env:NYCV_PIPELINE_ROOT = $platform
# Archive root: read NYCV_ARCHIVE_ROOT from the platform .env if present (keeps any
# machine-specific archive location out of the repo). If unset, the Python code defaults
# to <pipeline>/realtime/archive.
$envFile = Join-Path $platform ".env"
if (Test-Path $envFile) {
  $m = Select-String -Path $envFile -Pattern '^\s*NYCV_ARCHIVE_ROOT\s*=\s*(.+?)\s*$' | Select-Object -First 1
  if ($m) { $env:NYCV_ARCHIVE_ROOT = $m.Matches[0].Groups[1].Value.Trim('"').Trim("'") }
}
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONWARNINGS = "ignore"
$env:PYTHONUNBUFFERED = "1"

$logdir = Join-Path $here "logs"
New-Item -ItemType Directory -Force -Path $logdir | Out-Null
$log = Join-Path $logdir ("derive-" + (Get-Date -Format "yyyy-MM-dd") + ".log")

$stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
Add-Content -Path $log -Value "==== $stamp  run_derive.py start ===="
# Incremental derivation (only days whose archive input changed). Merge stderr into
# stdout (2>&1) so a native-stderr write can't trip a terminating error.
& "python" (Join-Path $here "run_derive.py") 2>&1 | Add-Content -Path $log
$code1 = $LASTEXITCODE
Add-Content -Path $log -Value "---- run_derive exit $code1 ----"

# Refresh the published Observed Bus Headways dataset roll.
& "python" (Join-Path $here "package_headways.py") 2>&1 | Add-Content -Path $log
$code2 = $LASTEXITCODE
Add-Content -Path $log -Value "==== package_headways exit $code2 ===="

if ($code1 -ne 0) { exit $code1 }
exit $code2
