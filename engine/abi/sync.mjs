// Copies the ABIs the engine needs out of Foundry's build output, so the engine starts on a checkout without
// `forge build` (contracts/forge-out is git-ignored). Run after any contract change:
//   cd contracts && forge build && cd .. && node engine/abi/sync.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, "..", "..", "contracts", "forge-out");
for (const name of ["InversePool", "V4SpotSource"]) {
  const abi = JSON.parse(fs.readFileSync(path.join(ART, `${name}.sol`, `${name}.json`), "utf8")).abi;
  fs.writeFileSync(path.join(HERE, `${name}.json`), JSON.stringify(abi, null, 1) + "\n");
  console.log(`${name}: ${abi.length} entries`);
}
