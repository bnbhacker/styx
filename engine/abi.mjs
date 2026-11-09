// Contract ABIs for the engine, committed under engine/abi (refresh with `node engine/abi/sync.mjs` after
// `forge build`). Kept out of contracts/forge-out so a Practice-only checkout without Foundry still starts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), "abi");
const read = (name) => JSON.parse(fs.readFileSync(path.join(HERE, `${name}.json`), "utf8"));

export const POOL_ABI = read("InversePool");
export const SRC_ABI = read("V4SpotSource");
// decode V4SpotSource reverts (OutOfBand, NoFeed...) bubbling out of pool calls
export const ABI = [...POOL_ABI, ...SRC_ABI.filter((x) => x.type === "error")];
