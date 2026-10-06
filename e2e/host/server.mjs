/**
 * Serves the test host page (e2e/host/index.html) on 127.0.0.1, a different site from the
 * game on localhost, so the iframe is truly cross-origin.
 *
 *   node e2e/host/server.mjs            ports 3200 and 3201
 *   HOST_PORTS=4000 node e2e/host/server.mjs
 *
 * Point it at a preview deployment with ?game=https://<preview>.vercel.app (that origin's
 * ALLOWED_HOSTS must include http://127.0.0.1:*).
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const page = readFileSync(new URL("./index.html", import.meta.url));
const ports = (process.env.HOST_PORTS ?? "3200,3201").split(",").map(Number);

for (const port of ports) {
  createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path !== "/" && path !== "/index.html") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page);
  }).listen(port, "127.0.0.1", () => console.log(`test host: http://127.0.0.1:${port}/`));
}
