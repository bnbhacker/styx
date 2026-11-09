// Rebuild site/vendor/viem.js after a viem upgrade:  node inverse-rh/site/vendor/build.mjs
// Uses the esbuild and viem installed in the workspace root; the output is committed, the site has no build step.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "..", "..", "package.json"));
const esbuild = require("esbuild");
const viem = require("viem/package.json");

const r = await esbuild.build({
  entryPoints: [path.join(here, "entry.js")],
  outfile: path.join(here, "viem.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  minify: true,
  legalComments: "eof",
  banner: { js: `// viem ${viem.version} (MIT), bundled for Styx by vendor/build.mjs` },
  metafile: true,
});
const out = Object.values(r.metafile.outputs)[0];
console.log(`vendor/viem.js: viem ${viem.version}, ${(out.bytes / 1024).toFixed(0)} KB`);
