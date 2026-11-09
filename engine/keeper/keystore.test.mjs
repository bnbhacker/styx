// Round trip against a keystore written by `cast wallet new` (scrypt, aes-128-ctr). The test key lives only in a
// temp dir and only exists for this test. Skipped when cast is not installed.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { decryptKeystore, readPassphraseFile, loadKeeperKey } from "./keystore.mjs";

const cast = path.join(homedir(), ".foundry", "bin", process.platform === "win32" ? "cast.exe" : "cast");

test("decrypts a cast keystore to the same address, rejects a wrong passphrase", (t) => {
  let out;
  const dir = mkdtempSync(path.join(tmpdir(), "styx-ks-"));
  try {
    try {
      out = execFileSync(cast, ["wallet", "new", dir, "--unsafe-password", "styx-test-pass"], { encoding: "utf8" });
    } catch {
      t.skip("cast not available");
      return;
    }
    const addr = out.match(/0x[0-9a-fA-F]{40}/)[0];
    const file = readdirSync(dir)[0];
    const json = readFileSync(path.join(dir, file), "utf8");
    const key = decryptKeystore(json, "styx-test-pass");
    assert.equal(privateKeyToAccount(key).address.toLowerCase(), addr.toLowerCase());
    assert.throws(() => decryptKeystore(json, "nope"), /mac mismatch/);

    // passphrase files the way Windows writes them
    const pf = path.join(dir, "pass.txt");
    writeFileSync(pf, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("styx-test-pass\r\n", "utf16le")]));
    assert.equal(readPassphraseFile(pf), "styx-test-pass");
    writeFileSync(pf, "﻿styx-test-pass\n");
    assert.equal(readPassphraseFile(pf), "styx-test-pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opens a cast keystore whose password changes under NFKC, and a passphrase file with a trailing space", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "styx-ks-"));
  const pw = "pw№42"; // "pw№42": Foundry derives from these raw bytes, NFKC would make it "pwNo42"
  try {
    let out;
    try {
      out = execFileSync(cast, ["wallet", "new", dir, "--unsafe-password", pw], { encoding: "utf8" });
    } catch {
      t.skip("cast not available");
      return;
    }
    const addr = out.match(/0x[0-9a-fA-F]{40}/)[0].toLowerCase();
    const ksFile = path.join(dir, readdirSync(dir)[0]);
    const json = readFileSync(ksFile, "utf8");
    assert.equal(privateKeyToAccount(decryptKeystore(json, pw)).address.toLowerCase(), addr);

    // cmd's `echo pw > file` writes "pw \r\n": loadKeeperKey falls back to the trimmed password, like cast does
    const pf = path.join(dir, "pass.txt");
    writeFileSync(pf, Buffer.from(pw + " \r\n", "utf8"));
    process.env.KEEPER_KEYSTORE = ksFile;
    process.env.KEEPER_PASSPHRASE_FILE = pf;
    assert.equal(privateKeyToAccount(loadKeeperKey("https://example.invalid")).address.toLowerCase(), addr);
    writeFileSync(pf, "wrong\n");
    assert.throws(() => loadKeeperKey("https://example.invalid"), /mac mismatch/);
    writeFileSync(pf, "\r\n");
    assert.throws(() => loadKeeperKey("https://example.invalid"), /empty or blank/);

    // the NFKC branch: a keystore made with the normalized password still opens from the raw "№" form
    const dir2 = mkdtempSync(path.join(tmpdir(), "styx-ks-"));
    try {
      const out2 = execFileSync(cast, ["wallet", "new", dir2, "--unsafe-password", "pwNo42"], { encoding: "utf8" });
      const addr2 = out2.match(/0x[0-9a-fA-F]{40}/)[0].toLowerCase();
      const json2 = readFileSync(path.join(dir2, readdirSync(dir2)[0]), "utf8");
      assert.equal(privateKeyToAccount(decryptKeystore(json2, pw)).address.toLowerCase(), addr2);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    delete process.env.KEEPER_KEYSTORE;
    delete process.env.KEEPER_PASSPHRASE_FILE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dev key is refused for a remote RPC", () => {
  process.env.KEEPER_DEV_KEY = "0x" + "11".repeat(32);
  try {
    assert.throws(() => loadKeeperKey("https://testnet-rpc.elysium.kinetiq.xyz"), /local dev chain/);
    assert.equal(loadKeeperKey("http://127.0.0.1:8545"), process.env.KEEPER_DEV_KEY);
  } finally {
    delete process.env.KEEPER_DEV_KEY;
  }
});
