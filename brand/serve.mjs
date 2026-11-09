// Static server for the brand sheet (port 4690), so a browser can render styx.html over http.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".png": "image/png", ".css": "text/css", ".js": "text/javascript" };
const PORT = Number(process.env.PORT || 4690);

http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    let f = path.normalize(path.join(ROOT, decodeURIComponent(u.pathname)));
    if (!f.startsWith(ROOT)) return res.writeHead(403).end();
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "styx.html");
    if (!fs.existsSync(f)) return res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(f).pipe(res);
  })
  .listen(PORT, () => console.log(`styx brand on http://localhost:${PORT}/styx.html#sheet`));
