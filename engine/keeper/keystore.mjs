// Web3 Secret Storage (v3) keystore decryption — the file format `cast wallet import` writes to
// ~/.foundry/keystores/<name>. The keeper never sees a raw key in env: it reads the keystore path and a
// passphrase file (both paths, not secrets) and decrypts in memory. Same scheme as skinpad/keeper.
import { readFileSync } from "node:fs";
import { scryptSync, pbkdf2Sync, createDecipheriv } from "node:crypto";
import { keccak256, toHex } from "viem";

export function decryptKeystore(json, passphrase) {
  let ks;
  try {
    ks = JSON.parse(json);
  } catch {
    // never echo the content: with the two env vars swapped it would be the passphrase (review 06.11)
    throw new Error("the keystore file is not JSON (are KEEPER_KEYSTORE and KEEPER_PASSPHRASE_FILE swapped?)");
  }
  if (ks.version !== 3) throw new Error(`unsupported keystore version ${ks.version}`);
  const c = ks.crypto || ks.Crypto;
  const salt = Buffer.from(c.kdfparams.salt, "hex");
  const derive = (pass) => {
    if (c.kdf === "scrypt") {
      const { n = 262144, r = 8, p = 1, dklen } = c.kdfparams;
      return scryptSync(pass, salt, dklen, { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 });
    }
    if (c.kdf === "pbkdf2") {
      const { c: iters = 262144, dklen, prf = "hmac-sha256" } = c.kdfparams;
      if (prf !== "hmac-sha256") throw new Error(`unsupported prf ${prf}`);
      return pbkdf2Sync(pass, salt, iters, dklen, "sha256");
    }
    throw new Error(`unsupported kdf ${c.kdf}`);
  };
  const ciphertext = Buffer.from(c.ciphertext, "hex");
  // Foundry (eth-keystore) and geth derive from the raw UTF-8 bytes; ethers normalizes to NFKC first.
  // Try raw, then NFKC, so a password with e.g. "№" (NFKC "No") opens either way (deploy-script review 07.11).
  const raw = Buffer.from(passphrase, "utf8");
  const nfkc = Buffer.from(passphrase.normalize("NFKC"), "utf8");
  let dk = null;
  for (const pass of raw.equals(nfkc) ? [raw] : [raw, nfkc]) {
    const d = derive(pass);
    const mac = keccak256(toHex(Buffer.concat([d.subarray(16, 32), ciphertext])));
    if (mac.slice(2) === c.mac.toLowerCase()) {
      dk = d;
      break;
    }
  }
  if (!dk) throw new Error("wrong passphrase (mac mismatch)");
  if (c.cipher !== "aes-128-ctr") throw new Error(`unsupported cipher ${c.cipher}`);
  const d = createDecipheriv("aes-128-ctr", dk.subarray(0, 16), Buffer.from(c.cipherparams.iv, "hex"));
  return "0x" + Buffer.concat([d.update(ciphertext), d.final()]).toString("hex");
}

/** Passphrase file as Windows editors write it: UTF-16 with BOM or UTF-8 with/without BOM; trailing CR/LF dropped. */
export function readPassphraseFile(passFile) {
  const buf = readFileSync(passFile);
  let text;
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    if (buf[0] === 0xfe) body.swap16();
    text = body.toString("utf16le");
  } else {
    text = buf.toString("utf8").replace(/^﻿/, "");
  }
  return text.replace(/[\r\n]+$/, "");
}

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;

/**
 * Keeper key from KEEPER_KEYSTORE + KEEPER_PASSPHRASE_FILE (paths outside the repo). KEEPER_DEV_KEY is accepted only
 * when the RPC is a local dev chain (anvil), so a test key can never sign on a real network. null = no keeper.
 * prefix: "KEEPER" for the main key, "KEEPER2" for the optional second key that sends the defensive transactions.
 */
export function loadKeeperKey(rpc, prefix = "KEEPER") {
  const path = process.env[`${prefix}_KEYSTORE`];
  if (path) {
    const passFile = process.env[`${prefix}_PASSPHRASE_FILE`];
    if (!passFile) throw new Error(`${prefix}_KEYSTORE is set but ${prefix}_PASSPHRASE_FILE is not`);
    const json = readFileSync(path, "utf8");
    const pass = readPassphraseFile(passFile);
    try {
      return decryptKeystore(json, pass);
    } catch (e) {
      if (!/mac mismatch/.test(e.message)) throw e;
      // `cmd /c echo pw > file` leaves a trailing space; cast --password-file trims it, so do the same as a fallback
      const trimmed = pass.replace(/\s+$/, "");
      if (trimmed !== pass) {
        try {
          return decryptKeystore(json, trimmed);
        } catch {}
      }
      // an empty password is valid for cast, so only say "empty" once the file has failed
      if (!trimmed) throw new Error(`wrong passphrase (mac mismatch): ${passFile} is empty or blank`);
      throw e;
    }
  }
  const dev = process.env[`${prefix}_DEV_KEY`];
  if (dev) {
    if (!LOCAL.test(rpc)) throw new Error(`${prefix}_DEV_KEY only works against a local dev chain (127.0.0.1/localhost)`);
    return dev;
  }
  return null;
}
