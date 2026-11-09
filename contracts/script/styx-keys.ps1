# Styx wallets made on 07.11.2026: addresses, balances and (on request) private keys.
# The keys live as encrypted Foundry keystores in %USERPROFILE%\.foundry\keystores (styx-owner, styx-keeper);
# their random passwords are in %USERPROFILE%\.styx\owner.pass and keeper.pass. Nothing secret is in this file
# or in the repo.
#
#   powershell -ExecutionPolicy Bypass -File script\styx-keys.ps1                    # addresses + balances
#   powershell -ExecutionPolicy Bypass -File script\styx-keys.ps1 -ShowPrivateKeys   # also the private keys
#
# Importing into Rabby/MetaMask: "Import private key" and paste the 0x... key. Anyone with the key controls the
# wallet: do not paste it into chats, sites or screenshots. Back up both folders above to keep the wallets.
param([switch]$ShowPrivateKeys, [string]$Rpc = "https://testnet-rpc.elysium.kinetiq.xyz")
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$cast = Join-Path $HOME ".foundry\bin\cast.exe"
$ks = Join-Path $HOME ".foundry\keystores"
$dir = Join-Path $HOME ".styx"

foreach ($w in @(@("styx-owner", "owner.pass", "pool owner (deployer)"), @("styx-keeper", "keeper.pass", "keeper (hot key the engine uses)"))) {
  $file = Join-Path $ks $w[0]
  $pass = Join-Path $dir $w[1]
  if (-not (Test-Path -LiteralPath $file)) { Write-Warning "$file is missing"; continue }
  if (-not (Test-Path -LiteralPath $pass)) { Write-Warning "$pass is missing"; continue }
  $addr = @(@(& $cast wallet address --keystore $file --password-file $pass) | Where-Object { "$_" -match '^0x[0-9a-fA-F]{40}$' })[0]
  $bal = @(& $cast balance $addr --ether --rpc-url $Rpc 2>$null)[0]
  Write-Host ""
  Write-Host ("{0}  {1}" -f $w[0], $w[2])
  Write-Host ("  address  {0}" -f $addr)
  Write-Host ("  balance  {0} HYPE (Elysium testnet)" -f $bal)
  Write-Host ("  keystore {0}" -f $file)
  Write-Host ("  password {0}" -f $pass)
  if ($ShowPrivateKeys) {
    $pk = @(@(& $cast wallet private-key --keystore $file --password-file $pass) | Where-Object { "$_" -match '^0x[0-9a-fA-F]{64}$' })[0]
    Write-Host ("  PRIVATE  {0}" -f $pk)
  }
}
if ($ShowPrivateKeys) { Write-Host ""; Write-Host "Clear the screen when done (cls): the keys are now in this console's scrollback." }
