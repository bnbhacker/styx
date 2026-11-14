// node --test engine/keeper/guards.test.mjs — the chain-reading halves of the keeper's guards, against fake nodes.
import test from "node:test";
import assert from "node:assert/strict";
import { transferLogs, applyTransfers } from "./holders.mjs";
import { firstFunder } from "./funding.mjs";

const pad = (a) => "0x" + a.replace(/^0x/, "").padStart(64, "0");
const A = (n) => "0x" + n.toString(16).padStart(40, "0");

test("transferLogs shrinks the window where the node refuses it, in order, within the budget", async () => {
  const all = Array.from({ length: 100 }, (_, i) => ({ blockNumber: BigInt(i * 10), n: i }));
  let calls = 0;
  const getLogs = async ({ fromBlock, toBlock }) => {
    calls++;
    const hit = all.filter((l) => l.blockNumber >= BigInt(fromBlock) && l.blockNumber <= BigInt(toBlock));
    if (hit.length > 16) throw new Error("logs count limit exceeded");
    return hit;
  };
  const got = await transferLogs("0xT", 0n, 999n, getLogs);
  assert.deepEqual(got.map((l) => l.n), all.map((l) => l.n));
  assert.ok(calls > 1 && calls < 40, `calls ${calls}`);
  // a quiet history is one request
  calls = 0;
  assert.equal((await transferLogs("0xT", 0n, 150n, getLogs)).length, 16);
  assert.equal(calls, 1);
  await assert.rejects(transferLogs("0xT", 0n, 999n, getLogs, { left: 50 }), /too many transfers/);
  // a refusal on a single block cannot be split: it surfaces
  await assert.rejects(transferLogs("0xT", 5n, 5n, async () => { throw new Error("node down"); }), /node down/);
});

test("applyTransfers: mints, burns, moves; ERC-721 logs skipped", () => {
  const h = { balances: new Map(), minted: new Set(), logs: 0 };
  const log = (from, to, v, extra = []) => ({ topics: ["0xddf2", pad(from), pad(to), ...extra], data: pad(v.toString(16)) });
  applyTransfers(h, [log(A(0), A(1), 1000n), log(A(1), A(2), 300n), log(A(2), A(0), 100n), log(A(1), A(3), 1n, [pad("7")])]);
  assert.deepEqual([...h.minted], [A(1)]);
  assert.equal(h.balances.get(A(1)), 700n);
  assert.equal(h.balances.get(A(2)), 200n);
  assert.equal(h.balances.has(A(0)), false);
  assert.equal(h.balances.has(A(3)), false);
  assert.equal(h.logs, 4);
});

/** A fake archive node: the wallet is funded at `block` by the given transactions. */
function node({ block, txs, code = {} }) {
  let calls = 0;
  const rpc = async (method, [a, tag]) => {
    calls++;
    if (method === "eth_getBalance") return BigInt(tag) >= block ? "0x5" : "0x0";
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_getBlockByNumber") return BigInt(a) === block ? { transactions: txs } : { transactions: [] };
    if (method === "eth_getCode") return code[a] || "0x";
    throw new Error(method);
  };
  return { rpc, calls: () => calls };
}

test("firstFunder: finds the funding block and the plain transfer in it", async () => {
  const w = A(0xabc);
  const funder = A(0xf00d);
  for (const block of [0n, 1n, 17n, 4_999_999n, 6_400_000n]) {
    const n = node({ block, txs: [{ from: A(9), to: A(8), value: "0x1", type: "0x2" }, { from: funder, to: w, value: "0x5", type: "0x2" }] });
    assert.equal(await firstFunder(w, n.rpc, 6_400_000n), funder, `block ${block}`);
    assert.ok(n.calls() < 2 * 17 * 8 + 10, `calls ${n.calls()}`);
  }
});

test("firstFunder: bridge deposits, contract funders, self-sends and unfunded wallets link nobody", async () => {
  const w = A(0xabc);
  const f = A(0xf00d);
  const at = (txs, code) => firstFunder(w, node({ block: 500n, txs, code }).rpc, 1000n);
  assert.equal(await at([{ from: f, to: w, value: "0x5", type: "0x64" }]), null); // Arbitrum deposit
  assert.equal(await at([{ from: f, to: w, value: "0x0", type: "0x2" }]), null); // no value
  assert.equal(await at([{ from: w, to: w, value: "0x5", type: "0x2" }]), null);
  assert.equal(await at([{ from: f, to: A(7), value: "0x5", type: "0x2" }]), null); // paid inside a contract call
  assert.equal(await at([{ from: f, to: w, value: "0x5", type: "0x2" }], { [f]: "0x6080" }), null); // a contract
  assert.equal(await firstFunder(w, node({ block: 2000n, txs: [] }).rpc, 1000n), null); // never funded
});
