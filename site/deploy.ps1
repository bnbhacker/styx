# Styx site -> Vercel (project "styx", domain styxperps.xyz).
#
# Vercel serves only the static site. The engine (prices, paper book, keeper, /api/rpc) is a long-running Node
# process on its own host; Vercel proxies /api/* to it, so the site keeps calling same-origin "/api/...".
#
# vercel CLI breaks on this repo's Cyrillic path (deploys hang in BLOCKED), so the files are staged under an ASCII
# path first and deployed from there. The project link (.vercel/project.json) is kept next to this script.
#
#   powershell -ExecutionPolicy Bypass -File inverse-rh\site\deploy.ps1 [-Api https://api.styxperps.xyz]

param([string]$Api = "https://api.styxperps.xyz", [string]$Project = "styx")

$ErrorActionPreference = "Stop"
if ($Api -notmatch '^https://[a-z0-9.-]+(:\d+)?$') { throw "-Api must be an https origin without a path, got '$Api'" }
$src = $PSScriptRoot
$stage = Join-Path $env:TEMP "styx-site-stage"

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage -Confirm:$false }
New-Item -ItemType Directory -Force (Join-Path $stage "vendor") | Out-Null

# only what the browser loads: no build scripts, no deploy files
foreach ($f in "index.html", "app.js", "real.js", "style.css", "favicon.svg", "og.png") { Copy-Item (Join-Path $src $f) $stage }
Copy-Item (Join-Path $src "vendor\viem.js") (Join-Path $stage "vendor")

$vercel = @{
  rewrites = @(@{ source = "/api/:path*"; destination = "$Api/api/:path*" })
  headers  = @(
    @{ source = "/(.*)"; headers = @(
        @{ key = "X-Content-Type-Options"; value = "nosniff" },
        @{ key = "Referrer-Policy"; value = "strict-origin-when-cross-origin" },
        @{ key = "X-Frame-Options"; value = "DENY" }
      ) },
    # the page itself always revalidates, so a redeploy reaches everyone at once
    @{ source = "/"; headers = @(@{ key = "Cache-Control"; value = "no-cache" }) }
  )
}
# UTF-8 without BOM: Vercel rejects a vercel.json that starts with a BOM
[IO.File]::WriteAllText((Join-Path $stage "vercel.json"), ($vercel | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))

$link = Join-Path $src ".vercel\project.json"
if (Test-Path $link) {
  New-Item -ItemType Directory -Force (Join-Path $stage ".vercel") | Out-Null
  Copy-Item $link (Join-Path $stage ".vercel")
}
Write-Host "staged $((Get-ChildItem $stage -Recurse -File).Count) files -> $stage (API -> $Api)"

# vercel writes to stderr even on success, and Node's outbound connections here drop now and then: retry
$ErrorActionPreference = "Continue"
$env:NODE_OPTIONS = "--dns-result-order=ipv4first"
if (-not (Test-Path $link)) {
  vercel link --yes --project $Project --cwd $stage 2>&1 | Select-Object -Last 3
  New-Item -ItemType Directory -Force (Join-Path $src ".vercel") | Out-Null
  Copy-Item (Join-Path $stage ".vercel\project.json") $link
}
for ($i = 1; $i -le 6; $i++) {
  $out = vercel deploy --prod --yes --cwd $stage 2>&1
  $text = $out -join "`n"
  # without a terminal the CLI ends with a JSON summary
  if ($text -match '"readyState":\s*"READY"') {
    Write-Host "deploy OK (attempt $i)"
    $out | Select-String -Pattern '^\S*\s*(Production|Aliased|Inspect)\s' | ForEach-Object { $_.Line.Trim() } | Select-Object -Unique
    exit 0
  }
  Write-Host "attempt $i failed, retrying..."
  $out | Select-Object -Last 4
  Start-Sleep -Seconds 10
}
Write-Host "deploy failed"
exit 1
