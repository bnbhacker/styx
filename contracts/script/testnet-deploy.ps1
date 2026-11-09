# Styx v1.1 -> Elysium TESTNET (chainId 99801). Run it yourself in a terminal: cast and forge ask for the
# keystore passwords; no key or password goes into the environment or the repo.
#
#   cd inverse-rh\contracts
#   powershell -ExecutionPolicy Bypass -File script\testnet-deploy.ps1 -Lp 0xYourRabbyAddress
#
# What it does:
#   1. creates (or imports) two Foundry keystores if missing: the owner (deployer) and a separate hot keeper key;
#   2. checks the chain id and both balances;
#   3. asks "yes", then runs script/Deploy.s.sol with KEEPER = the keeper address (if forge stops part-way it offers
#      `--resume` instead of a second deploy);
#   4. checks that every deploy transaction has a successful receipt, then isKeeper and USE_ARBSYS on chain;
#   5. optionally allowlists your own wallet as an LP (-Lp), so you can add liquidity from the site;
#   6. prints how to write the keeper's passphrase file and the engine command.
# Exit codes: 0 done; 1 stopped (nothing or a partial deploy, see the message); 2 deployed but a follow-up step is left.
# Gas is ~0.1 gwei here: the whole deploy costs about 0.001 HYPE. The keeper spends little per fill or report, but
# listing a v3 coin first grows that pool's oracle to 1000 observations (~22.4M gas, ~0.003 HYPE): give it ~0.2 HYPE.
#
# Reviewed 07.11 twice, the second time end to end in a real PowerShell 5.1 console (ru-RU, CP 866) with every
# password typed: Foundry's hidden prompt leaves an empty line on stdout, so addresses are picked out of cast's
# output by pattern; passwords must be ASCII (English layout).
param(
  [string]$Owner = "styx-owner",
  [string]$Keeper = "styx-keeper",
  [string]$Lp = "",
  [string]$Rpc = "https://testnet-rpc.elysium.kinetiq.xyz"
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$PublicRpc = "https://testnet-rpc.elysium.kinetiq.xyz"
$Explorer = "https://explorer-elysium-testnet.t.conduit.xyz"
$fb = Join-Path $HOME ".foundry\bin"
if (($env:PATH -split ';') -notcontains $fb) { $env:PATH = "$fb;$env:PATH" }
$castExe = Join-Path $fb "cast.exe"
$forgeExe = Join-Path $fb "forge.exe"
$ks = Join-Path $HOME ".foundry\keystores"
$contracts = Split-Path $PSScriptRoot -Parent
$engine = Split-Path $contracts -Parent
$runFile = Join-Path $contracts "broadcast\Deploy.s.sol\99801\run-latest.json"
$inv = [Globalization.CultureInfo]::InvariantCulture

# arguments first, so a typo never costs a password prompt
if ($Lp -and $Lp -cnotmatch '^0x[0-9a-fA-F]{40}$') { throw "-Lp must be a 0x address (0x + 40 hex), got '$Lp'" }
if ($Lp -match '^0x0{40}$') { throw "-Lp is the zero address: setLpAllowed(0, ...) switches the LP gate, it does not allow an LP" }
if ($Owner -eq $Keeper) { throw "-Owner and -Keeper must name two different keystores" }

# These skip or replace Foundry's keystore password prompts (ETH_KEYSTORE also clashes with --account).
$bad = @(Get-ChildItem Env: | Where-Object { $_.Name -match '^(ETH_PASSWORD|ETH_KEYSTORE|CAST_PASSWORD|CAST_UNSAFE_PASSWORD)$' } | ForEach-Object { $_.Name })
if ($bad.Count) { Write-Host ("Run this, then rerun the script:  Remove-Item Env:" + ($bad -join ", Env:")); throw ("{0} set in this console: it changes the keystore password prompts (see the line above)." -f ($bad -join ", ")) }
# Deploy.s.sol and forge/cast also read these: shown at the yes prompt (names only for ETH_/FOUNDRY_, they may hold API keys)
$envIn = @(Get-ChildItem Env: | Where-Object { $_.Name -match '^(GUARDIAN|TREASURY|REBATE_SOURCE|MAX_POOL_CASH)$' } | ForEach-Object { "$($_.Name)=$($_.Value)" })
$envIn += @(Get-ChildItem Env: | Where-Object { $_.Name -match '^(ETH_|FOUNDRY_|DAPP_|CHAIN$)' -and $_.Name -ne 'ETH_KEYSTORE_ACCOUNT' } | ForEach-Object { $_.Name })

# A read-only cast call with retries; $null when it keeps failing (cast prints its own error above).
function Read-Cast([int]$Tries) {
  for ($i = 1; $i -le $Tries; $i++) {
    $o = & cast @args
    if ($LASTEXITCODE -eq 0) { return "$o".Trim() }
    if ($i -lt $Tries) { Start-Sleep -Seconds 3 }
  }
  return $null
}

# cast's hidden password prompt prints an empty line to stdout: take the one line that is an address.
function Get-Address($out) {
  $a = @($out | ForEach-Object { "$_".Trim() } | Where-Object { $_ -match '^0x[0-9a-fA-F]{40}$' })
  if ($a.Count -ne 1) { return $null }
  return [string]$a[0]
}
function Read-KeystoreAddress([string]$name, [string]$why) {
  Write-Host "Password of keystore '$name' ($why):"
  $out = @(cast wallet address --account $name)
  $code = $LASTEXITCODE
  Write-Host ""
  if ($code -ne 0) { throw "could not open keystore '$name' (wrong password? English layout, ASCII only). Rerun and retype it; do NOT delete the file, it may hold funds." }
  $addr = Get-Address $out
  if (-not $addr) { throw "cast wallet address --account $name printed no address" }
  return $addr
}

$chain = Read-Cast 3 chain-id --rpc-url $Rpc
if ($null -eq $chain) { throw "cannot reach $Rpc (see the cast error above)" }
if ($chain -ne "99801") { throw "RPC $Rpc is chain $chain, expected 99801 (Elysium testnet)" }
if ($Rpc -ne $PublicRpc) { Write-Warning "-Rpc is $Rpc, not the public Elysium RPC. A local fork also reports 99801; the script stops later if the node has no ArbSys." }

Write-Host ""
Write-Host "Switch the keyboard to English (EN) now and keep it there: answers, the private key and all passwords."
Write-Host "Passwords: ASCII only (Latin letters, digits, punctuation). In this console Foundry misreads Cyrillic input."
Write-Host ""

New-Item -ItemType Directory -Force -Path $ks | Out-Null
$addrOf = @{}
foreach ($n in @($Owner, $Keeper)) {
  $p = Join-Path $ks $n
  if (-not (Test-Path -LiteralPath $p)) {
    do {
      $how = "$(Read-Host "Keystore '$n' is missing. Type n = new random key, i = import a private key")".Trim().ToLower()
      # the same keys on a Russian layout
      if ($how -eq [string][char]0x0448) { $how = "i" } elseif ($how -eq [string][char]0x0442) { $how = "n" }
    } while ($how -ne "n" -and $how -ne "i")
    if ($how -eq "i") {
      Write-Host "cast asks for the private key, then a NEW password for '$n' (both hidden, typed once):"
      cast wallet import $n --interactive
    } else {
      Write-Host "cast asks 'Enter secret:' = a NEW password for '$n' (hidden, typed once):"
      cast wallet new $ks $n
    }
    if ($LASTEXITCODE -ne 0) { throw "creating keystore '$n' failed. If cast said 'stream did not contain valid UTF-8', the password had a non-ASCII character: switch to the English layout and rerun." }
    Write-Host "cast asked only once. Type the password of '$n' again to confirm it:"
    $out = @(cast wallet address --account $n)
    $code = $LASTEXITCODE
    Write-Host ""
    if ($code -ne 0) {
      Remove-Item -LiteralPath $p -Force
      if ($how -eq "i") { throw "the password of '$n' did not match; the keystore file made a moment ago was deleted (your private key itself is untouched). Rerun the script." }
      throw "the password of '$n' did not match; the keystore created a moment ago was deleted (its random key was never used). Rerun the script."
    }
    $addrOf[$n] = Get-Address $out
    if ($how -eq "n") {
      $role = if ($n -eq $Owner) { "the pool owner key" } else { "the keeper key" }
      Write-Host "Back up $p and its password: this file is the only copy of $role."
    }
  }
}

$ownerAddr = if ($addrOf[$Owner]) { $addrOf[$Owner] } else { Read-KeystoreAddress $Owner "to read its address; forge asks again to sign" }
$keeperAddr = if ($addrOf[$Keeper]) { $addrOf[$Keeper] } else { Read-KeystoreAddress $Keeper "to read its address" }
if ($ownerAddr -eq $keeperAddr) { throw "owner and keeper must be different keys" }
if ($Lp -and $Lp -eq $keeperAddr) { throw "-Lp is the keeper (hot key, it also reports the NAV): use your own wallet" }
if ($Lp -and $Lp -eq $ownerAddr) { Write-Host "-Lp is the owner, already allowed by Deploy.s.sol: skipping setLpAllowed"; $Lp = "" }

$obs = Read-Cast 3 balance $ownerAddr --ether --rpc-url $Rpc
$kbs = Read-Cast 3 balance $keeperAddr --ether --rpc-url $Rpc
if ($null -eq $obs -or $null -eq $kbs) { throw "cannot read balances from $Rpc" }
$ob = [decimal]$obs
$kb = [decimal]$kbs
Write-Host ("owner  {0}  {1} HYPE" -f $ownerAddr, $ob.ToString("0.######", $inv))
Write-Host ("keeper {0}  {1} HYPE" -f $keeperAddr, $kb.ToString("0.######", $inv))
if ($ob -lt 0.01) { throw "Send the owner ($ownerAddr) some test HYPE first (faucet or bridge from HyperEVM testnet), then rerun." }
if ($kb -lt 0.05) { Write-Warning ("The keeper has {0} HYPE: send it ~0.2 HYPE before starting the engine (each v3 listing costs ~0.003)." -f $kb.ToString("0.######", $inv)) }

$note = ""
if ($envIn.Count) { $note = "`nALSO from this console's environment: " + ($envIn -join ", ") + " (Remove-Item Env:NAME if not meant for Styx)" }
$ans = "$(Read-Host ("Deploy InversePool + V4SpotSource to chain 99801 via {0}`nfrom {1}, keeper {2}?{3}`nType yes" -f $Rpc, $ownerAddr, $keeperAddr, $note))".Trim().ToLower()
# "yes" typed on a Russian layout
if ($ans -eq ([string][char]0x043D + [char]0x0443 + [char]0x044B)) { $ans = "yes" }
if ($ans -ne "yes") { Write-Host "Stopped, nothing sent."; exit 1 }

Write-Host ""
Write-Host "forge compiles, simulates, then asks 'Enter keystore password:' - that is the password of '$Owner' (it signs)."
Write-Host "Its log prints 'USE_ARBSYS false': that line comes from forge's local simulation, which has no Nitro"
Write-Host "precompiles. The real value is read from the chain after the deploy."
$resumeCmd = "cd `"$contracts`"; & `"$forgeExe`" script script/Deploy.s.sol --rpc-url $Rpc --account $Owner --sender $ownerAddr --broadcast --slow --resume"
$oldNet = $env:NETWORK; $oldKeeper = $env:KEEPER
$nonce0 = Read-Cast 3 nonce $ownerAddr --rpc-url $Rpc
if ($null -eq $nonce0) { throw "cannot read the nonce of $ownerAddr from $Rpc" }
$t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
Push-Location $contracts
try {
  $env:NETWORK = "elysium"
  $env:KEEPER = $keeperAddr
  $more = @()
  while ($true) {
    forge script script/Deploy.s.sol --rpc-url $Rpc --account $Owner --sender $ownerAddr --broadcast --slow @more
    if ($LASTEXITCODE -eq 0) { break }
    # forge gives a sent tx a hash in run-latest.json; a tx whose send reply was lost shows only as a higher owner nonce
    $sent = 0
    if (Test-Path -LiteralPath $runFile) {
      $pr = Get-Content -LiteralPath $runFile -Raw | ConvertFrom-Json
      if ([int64]$pr.timestamp -ge $t0) { $sent = @(@($pr.transactions) | Where-Object { $_.hash }).Count }
    }
    $nonce1 = Read-Cast 3 nonce $ownerAddr --rpc-url $Rpc
    if ($more.Count -eq 0 -and $sent -eq 0 -and $nonce1 -eq $nonce0) { throw "forge script failed before any transaction reached the chain (see above): fix the cause and rerun the script" }
    if ($null -ne $nonce1 -and ([int64]$nonce1 - [int64]$nonce0) -gt $sent) { throw "A transaction reached the chain that forge has no record of, so --resume cannot finish this deploy (owner nonce $nonce0 -> $nonce1). Abandon the partly configured pool and rerun the whole script: it deploys a fresh one." }
    Write-Host ""
    Write-Warning "forge stopped part-way: the pool may already exist with default settings and the LP gate off. Do NOT rerun the whole script, that deploys a second pool."
    $a = "$(Read-Host "Type resume to send the rest of this same deploy (forge asks the password of '$Owner' again), anything else to stop")".Trim()
    if ($a -ne "resume") { Write-Host "Stopped part-way. Finish later with this one line (password of '$Owner'):"; Write-Host "  $resumeCmd"; Write-Host "The receipt check and the engine command are then up to you."; exit 1 }
    $more = @("--resume")
  }
} finally {
  $env:NETWORK = $oldNet
  $env:KEEPER = $oldKeeper
  Pop-Location
}

# forge exits 0 when it dropped a tx after one RPC error, and also when it only lost the receipt of a MINED tx:
# take receipts from the run file, ask the chain for the rest, stop only if a tx really is not mined
$run = Get-Content -LiteralPath $runFile -Raw | ConvertFrom-Json
if ([int64]$run.timestamp -lt $t0) { throw "$runFile is older than this run: forge recorded no broadcast (see the forge output above)" }
$txs = @($run.transactions)
$okBlock = @{}
foreach ($r in @($run.receipts)) {
  if ($r.status -eq '0x1') { $okBlock[([string]$r.transactionHash).ToLower()] = [Convert]::ToInt64(([string]$r.blockNumber).Substring(2), 16) }
}
foreach ($t in $txs) {
  $h = ([string]$t.hash).ToLower()
  if (-not $h -or $okBlock.ContainsKey($h)) { continue }
  $st = Read-Cast 3 receipt $h status --async --rpc-url $Rpc
  if ($st -ne "true") { continue }
  $bn = Read-Cast 3 receipt $h blockNumber --async --rpc-url $Rpc
  if ($bn -match '^\d+$') {
    $okBlock[$h] = [int64]$bn
    Write-Host "  forge lost the receipt of $h; the chain has it (success)."
    Write-Host "  (ignore forge's 'Use --resume' warning above for this tx: it is mined; --resume would only fail with 'EOA nonce changed unexpectedly')"
  }
}
$missing = @($txs | Where-Object { -not $okBlock.ContainsKey(([string]$_.hash).ToLower()) })
if ($txs.Count -eq 0 -or $missing.Count -ne 0) {
  foreach ($m in $missing) { Write-Host ("  no successful receipt: {0} {1} at {2}, tx {3}" -f $m.transactionType, $m.contractName, $m.contractAddress, $m.hash) }
  Write-Host "If the missing ones are the last in the list, send them with this one line:"
  Write-Host "  $resumeCmd"
  throw ("{0} of {1} deploy transactions have no successful receipt on {2}. Do NOT rerun this script (it would deploy a second pool). --resume resends by position, so if forge refuses with 'EOA nonce changed unexpectedly', abandon this pool and rerun the whole script." -f $missing.Count, $txs.Count, $Rpc)
}
$poolTx = $txs | Where-Object { $_.contractName -eq "InversePool" -and $_.transactionType -eq "CREATE" } | Select-Object -First 1
$srcTx = $txs | Where-Object { $_.contractName -eq "V4SpotSource" -and $_.transactionType -eq "CREATE" } | Select-Object -First 1
if (-not $poolTx) { throw "InversePool not found in $runFile" }
if ($poolTx.transaction.from -ne $ownerAddr) { throw "InversePool in $runFile was sent by $($poolTx.transaction.from), not $ownerAddr" }
$pool = $poolTx.contractAddress
$block = $okBlock[([string]$poolTx.hash).ToLower()]

Write-Host ""
Write-Host "DEPLOYED  InversePool  $pool  (block $block)"
Write-Host "          V4SpotSource $($srcTx.contractAddress)"
Write-Host "          $Explorer/address/$pool"
Write-Host ""

function Show-Next {
  $passFile = Join-Path $HOME ".styx\keeper.pass"
  Write-Host ""
  Write-Host "Next:"
  Write-Host "  1. Save the keeper's password for the engine, outside the repo (UTF-8, no trailing spaces):"
  Write-Host "     New-Item -ItemType Directory -Force `"$(Split-Path $passFile -Parent)`" | Out-Null"
  Write-Host "     `$p = Read-Host -AsSecureString 'keeper password'"
  Write-Host "     [IO.File]::WriteAllText(`"$passFile`", [Net.NetworkCredential]::new('', `$p).Password)"
  Write-Host "     & `"$castExe`" wallet address --keystore `"$(Join-Path $ks $Keeper)`" --password-file `"$passFile`""
  Write-Host "     (the last line must print $keeperAddr)"
  Write-Host "  2. Start the engine (keeper + site on http://localhost:4681):"
  Write-Host ""
  Write-Host "  `$env:NETWORK=`"elysium`"; `$env:ELY_RPC=`"$Rpc`"; `$env:STYX_POOL=`"$pool`"; `$env:STYX_FROM_BLOCK=`"$block`"; `$env:KEEPER_KEYSTORE=`"$(Join-Path $ks $Keeper)`"; `$env:KEEPER_PASSPHRASE_FILE=`"$passFile`"; node `"$engine\engine\elysium.mjs`""
  if ($Rpc -ne $PublicRpc) { Write-Host "  (if -Rpc carries a provider key, pasting this line saves it in the PowerShell history)" }
}
$lpCmd = "& `"$castExe`" send $pool `"setLpAllowed(address,bool)`" $Lp true --account $Owner --rpc-url $Rpc"

$isK = Read-Cast 5 call $pool "isKeeper(address)(bool)" $keeperAddr --rpc-url $Rpc
$arb = Read-Cast 5 call $pool "USE_ARBSYS()(bool)" --rpc-url $Rpc
if ($null -eq $isK -or $null -eq $arb) {
  Write-Warning "The deploy above went through, but $Rpc did not answer the read-back. Do NOT redeploy. When the RPC answers, both lines must print true:"
  Write-Host "  & `"$castExe`" call $pool `"isKeeper(address)(bool)`" $keeperAddr --rpc-url $Rpc"
  Write-Host "  & `"$castExe`" call $pool `"USE_ARBSYS()(bool)`" --rpc-url $Rpc"
  if ($Lp) { Write-Host "Then allowlist your LP wallet (password of '$Owner'):"; Write-Host "  $lpCmd" }
  Write-Host "Only after both print true:"
  Show-Next
  exit 2
}
if ($isK -ne "true") { throw "deployed at $pool, but isKeeper($keeperAddr) is ${isK}: do not start the engine" }
# Elysium is Nitro: the pool must count L2 blocks through ArbSys (false means the node is not Elysium, e.g. a fork)
if ($arb -ne "true") { throw "InversePool $pool is deployed, but USE_ARBSYS is ${arb}: $Rpc is not a Nitro node. Do not use this pool; redeploy against the real Elysium RPC. LP not allowlisted, engine command not printed." }
Write-Host "isKeeper($keeperAddr) = true, USE_ARBSYS = true"

$lpFailed = $false
if ($Lp) {
  Write-Host "Allowlisting $Lp as an LP (password of '$Owner' again):"
  cast send $pool "setLpAllowed(address,bool)" $Lp true --account $Owner --rpc-url $Rpc
  if ($LASTEXITCODE -ne 0) { $lpFailed = $true }
}
Show-Next
if ($lpFailed) {
  Write-Host ""
  Write-Warning "NOT DONE: $Lp is not allowlisted, so the site cannot add liquidity from it yet. Run (password of '$Owner'):"
  Write-Host "  $lpCmd"
  exit 2
}
