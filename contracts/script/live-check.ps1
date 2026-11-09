# Live ArbSys + constructor check through eth_call only (nothing is signed or sent).
# Forge/anvil forks do not run Nitro precompiles, so this is the only way to see what the deployed
# contract will see. Run from inverse-rh/contracts after `forge build`:
#   powershell -File script/live-check.ps1 -Net elysium     # or -Net rh
param([ValidateSet("rh", "elysium")][string]$Net = "elysium")
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = "Stop"
$nets = @{
  rh      = @{ rpc = $(if ($env:RH_RPC) { $env:RH_RPC } else { "https://rpc.mainnet.chain.robinhood.com" }); weth = "0bd7d308f8e1639fab988df18a8011f41eacad73"; chain = 4663 }
  elysium = @{ rpc = $(if ($env:ELY_RPC) { $env:ELY_RPC } else { "https://testnet-rpc.elysium.kinetiq.xyz" }); weth = "cd57f65c2b0e5881cfc2e609f7cd53b746e1f234"; chain = 99801 }
}
$rpc = $nets[$Net].rpc
$weth = $nets[$Net].weth

function Rpc($method, $params) {
  $body = @{ jsonrpc = "2.0"; id = 1; method = $method; params = $params } | ConvertTo-Json -Depth 10 -Compress
  $r = Invoke-RestMethod -Uri $rpc -Method Post -ContentType "application/json" -Body $body
  if ($r.error) { throw "$method : $($r.error.message)" }
  $r.result
}
function Word($hex, $i) { [System.Numerics.BigInteger]::Parse("0" + $hex.Substring(2 + 64 * $i, 64), "AllowHexSpecifier") }
function Artifact($name) { (Get-Content "forge-out/$name.sol/$name.json" -Raw | ConvertFrom-Json).bytecode.object }

$cid = [Convert]::ToInt64((Rpc "eth_chainId" @()), 16)
if ($cid -ne $nets[$Net].chain) { throw "rpc answers chainId $cid, expected $($nets[$Net].chain)" }
$n = [Convert]::ToInt64((Rpc "eth_blockNumber" @()), 16)
$tag = "0x{0:x}" -f $n
$hdr = Rpc "eth_getBlockByNumber" @($tag, $false)
"$Net (chainId $cid): pinned L2 block N = $n (l1BlockNumber in header = $([Convert]::ToInt64($hdr.l1BlockNumber, 16)))"

# 1) What the EVM sees inside a call at block N (same 50k gas cap as InversePool's constructor).
$out = Rpc "eth_call" @(@{ data = (Artifact "ArbProbe"); gas = "0x1c9c380" }, $tag)
"probe: block.number    = $(Word $out 0)"
"probe: arbBlockNumber  = $(Word $out 1)"
"probe: timestamp       = $(Word $out 2)"
"probe: chainid         = $(Word $out 3)"
"probe: staticcall ok   = $(Word $out 4)  return bytes = $(Word $out 5)"

# 2) InversePool's real constructor on the live chain, then its own view functions on that code.
$init = (Artifact "InversePool") + $weth.PadLeft(64, "0") + "dead".PadLeft(64, "0")
$runtime = Rpc "eth_call" @(@{ data = $init; gas = "0x1c9c380" }, $tag)
"InversePool constructor ran: runtime $((($runtime.Length) - 2) / 2) bytes"
try {
  $gas = Rpc "eth_estimateGas" @(@{ data = $init })
  "InversePool deploy gas (estimate, incl. parent-chain data cost) = $([Convert]::ToInt64($gas, 16))"
} catch { "InversePool deploy gas estimate failed: $_" }
$addr = "0x00000000000000000000000000000000000c0de1"
$override = @{ $addr = @{ code = $runtime } }
$use = Rpc "eth_call" @(@{ to = $addr; data = "0x68352bc4" }, $tag, $override)
$bn = Rpc "eth_call" @(@{ to = $addr; data = "0x57e871e7" }, $tag, $override)
"InversePool.USE_ARBSYS()   = $(Word $use 0)"
"InversePool.blockNumber()  = $(Word $bn 0)   (expected N = $n)"
