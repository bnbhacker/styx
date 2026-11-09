# Kept for old notes: the check now lives in live-check.ps1 for every chain.
#   powershell -File script/rh-live-check.ps1   ==   powershell -File script/live-check.ps1 -Net rh
& (Join-Path $PSScriptRoot "live-check.ps1") -Net rh
