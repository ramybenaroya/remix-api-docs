#!/usr/bin/env node
// Builds the command-palette search index from the prerendered docs and injects
// the search.js <script> tag into every generated page.
//
// Run after `prerender` (see sync.sh). Safe to run repeatedly (idempotent).
//
//   node tools/build-search.mjs
//
// Outputs: docs/search-index.json  +  a <script src="/search.js"> tag added to
// every docs/**/index.html (root landing page included so the palette opens there too).

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const SCRIPT_TAG = '<script src="/search.js" defer></script>';

// --- shared slugify -------------------------------------------------------
// KEEP IN SYNC with the identical function in docs/search.js so the slugs in
// search-index.json match the ids assigned to headings at runtime.
function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\- ]+/g, "") // drop punctuation (keep word chars, space, hyphen)
    .replace(/\s+/g, "-") // spaces -> hyphen
    .replace(/-+/g, "-") // collapse hyphens
    .replace(/^-+|-+$/g, ""); // trim hyphens
}

// --- tiny HTML helpers ----------------------------------------------------
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

// Pull headings (h1-h6) from the <main> content region of a rendered page.
function extractHeadings(html) {
  const mainMatch = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (!mainMatch) return [];
  const main = mainMatch[1];
  const headings = [];
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(main))) {
    const text = stripTags(m[2]);
    if (text) headings.push({ level: Number(m[1]), text });
  }
  return headings;
}

// --- walk docs/ for prerendered pages ------------------------------------
function findPages() {
  return readdirSync(DOCS, { recursive: true })
    .map((p) => String(p))
    .filter((p) => p.endsWith(`${sep}index.html`) || p === "index.html")
    .map((p) => join(DOCS, p));
}

function routeFor(file) {
  const rel = relative(DOCS, dirname(file)).split(sep).join("/");
  return rel === "" ? "/" : `/${rel}/`;
}

// --- build the index ------------------------------------------------------
function buildIndex(pages) {
  const entries = [];
  for (const file of pages) {
    const route = routeFor(file);
    if (route === "/") continue; // skip the root landing page

    const headings = extractHeadings(readFileSync(file, "utf8"));
    if (headings.length === 0) continue;

    // First heading is the page title; the rest are searchable subtitles.
    const title = headings[0].text;
    const seen = Object.create(null);
    const subtitles = [];
    for (const h of headings.slice(1)) {
      const base = slugify(h.text);
      if (!base) continue;
      let slug = base;
      let n = 0;
      while (seen[slug]) slug = `${base}-${++n}`;
      seen[slug] = true;
      subtitles.push({ text: h.text, slug });
    }
    entries.push({ title, route, subtitles });
  }
  entries.sort((a, b) => a.title.localeCompare(b.title));
  return entries;
}

// --- inject the script tag (idempotent) ----------------------------------
function injectTag(pages) {
  let injected = 0;
  for (const file of pages) {
    const html = readFileSync(file, "utf8");
    if (html.includes('src="/search.js"')) continue;
    const idx = html.lastIndexOf("</body>");
    const out =
      idx === -1
        ? html + SCRIPT_TAG
        : html.slice(0, idx) + SCRIPT_TAG + html.slice(idx);
    writeFileSync(file, out);
    injected++;
  }
  return injected;
}

// --- main -----------------------------------------------------------------
const pages = findPages();
const index = buildIndex(pages);
writeFileSync(join(DOCS, "search-index.json"), JSON.stringify(index));
const injected = injectTag(pages);

console.log(
  `search index: ${index.length} pages, ` +
    `${index.reduce((n, e) => n + e.subtitles.length, 0)} subtitles -> docs/search-index.json`,
);
console.log(`injected search.js into ${injected}/${pages.length} pages`);
