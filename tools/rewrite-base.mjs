#!/usr/bin/env node
// Rewrites absolute root paths in a prerendered docs build so it can be served
// from a sub-path (a GitHub Pages *project* site, e.g. /remix-api-docs/).
//
//   BASE_PATH=/remix-api-docs node tools/rewrite-base.mjs <dir>
//
// The Remix build emits absolute URLs ("/assets/...", "/api/...") that assume
// hosting at the domain root. This prefixes them with BASE_PATH across the HTML
// pages and the compiled JS (including the `from "/assets/..."` module imports).
//
// Run on a COPY of docs/ at deploy time — it does not need to (and should not)
// touch the root-relative source so it stays re-syncable. If BASE_PATH is empty
// (root hosting, e.g. a user site or custom domain) this is a no-op.
//
// Left untouched on purpose: the "/rmx:f" / "/rmx:h" stream protocol tokens, and
// docs/search.js (which derives its own base from its <script> src at runtime).

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const BASE = (process.env.BASE_PATH || "").replace(/\/+$/, "");
const dir = process.argv[2];

if (!dir) {
  console.error("usage: BASE_PATH=/prefix node tools/rewrite-base.mjs <dir>");
  process.exit(1);
}
if (!BASE) {
  console.log("rewrite-base: BASE_PATH empty -> root hosting, nothing to do");
  process.exit(0);
}

const name = BASE.replace(/^\//, ""); // e.g. "remix-api-docs"

// Absolute href/src attributes (any first segment), skipping protocol-relative
// "//..." and anything already prefixed with the base.
const attrRe = new RegExp(`(\\s(?:href|src)=")/(?!/|${name}/)`, "g");
// Quoted absolute asset/api paths (HTML inline + JS imports/literals). These
// match the literal "/assets" / "/api/" right after the quote, so an already
// prefixed "/<base>/assets" can never match -> safe to re-run.
const assetRe = /(["'])\/assets\b/g;
const apiRe = /(["'])\/api\//g;

function rewriteHtml(s) {
  return s.replace(attrRe, `$1${BASE}/`).replace(assetRe, `$1${BASE}/assets`);
}
function rewriteJs(s) {
  return s.replace(assetRe, `$1${BASE}/assets`).replace(apiRe, `$1${BASE}/api/`);
}

function walk(d, out) {
  for (const entry of readdirSync(d)) {
    const p = join(d, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

let html = 0;
let js = 0;
for (const file of walk(dir, [])) {
  if (file.endsWith(".html")) {
    writeFileSync(file, rewriteHtml(readFileSync(file, "utf8")));
    html++;
  } else if (file.endsWith(".js") && !file.endsWith("/search.js")) {
    writeFileSync(file, rewriteJs(readFileSync(file, "utf8")));
    js++;
  }
}

console.log(`rewrite-base: prefixed paths with ${BASE} in ${html} HTML + ${js} JS files`);
