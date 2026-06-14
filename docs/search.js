/*
 * Command-palette fuzzy search for the Remix API docs.
 *
 * Opens on Cmd/Ctrl+K, Cmd/Ctrl+Shift+P, or "/" and fuzzy-searches every page
 * title and section heading (from /search-index.json, built by
 * tools/build-search.mjs). Selecting a result navigates to the page, jumping to
 * the chosen heading.
 *
 * Self-contained vanilla JS, no dependencies. Injected into every page by the
 * build script, so the destination page re-runs it and performs the scroll.
 */
(function () {
  "use strict";

  // Base path the site is served under (e.g. "/remix-api-docs" for a GitHub
  // Pages project site, or "" at the domain root). Derived from this script's
  // own URL so the palette works wherever it's deployed, with no rewrite needed.
  var BASE = "";
  var thisScript = document.currentScript;
  if (thisScript && thisScript.src) {
    try {
      BASE = new URL(thisScript.src).pathname.replace(/\/search\.js.*$/, "");
    } catch (e) {
      /* keep BASE = "" */
    }
  }

  // Platform-aware modifier label for the hints ("⌘" on macOS, "Ctrl" elsewhere).
  var IS_MAC = /mac|iphone|ipad|ipod/i.test(
    navigator.platform || navigator.userAgent || "",
  );
  var MOD = IS_MAC ? "⌘" : "Ctrl";

  // --- shared slugify -----------------------------------------------------
  // KEEP IN SYNC with the identical function in tools/build-search.mjs so the
  // ids we assign to headings match the slugs stored in search-index.json.
  function slugify(text) {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\- ]+/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  // --- heading ids --------------------------------------------------------
  // The rendered pages have no heading ids; assign them so we can scroll to a
  // section. Re-runnable: the runtime may re-render <main> after we load.
  function assignIds() {
    var main = document.querySelector("main");
    if (!main) return false;
    var heads = main.querySelectorAll("h1,h2,h3,h4,h5,h6");
    var seen = Object.create(null);
    for (var i = 0; i < heads.length; i++) {
      var h = heads[i];
      var base = slugify(h.textContent || "");
      if (!base) continue;
      var slug = base,
        n = 0;
      while (seen[slug]) slug = base + "-" + ++n;
      seen[slug] = true;
      if (h.id !== slug) h.id = slug;
    }
    return heads.length > 0;
  }

  function scrollToId(id) {
    var el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ block: "start" });
      return true;
    }
    return false;
  }

  // On arrival with a #hash, the ids didn't exist at parse time (and the
  // runtime may still be hydrating), so retry assign+scroll for a few seconds.
  function scrollToHashWithRetry() {
    var id = decodeURIComponent((location.hash || "").slice(1));
    if (!id) return;
    var tries = 0;
    var timer = setInterval(function () {
      assignIds();
      if (scrollToId(id) || ++tries > 40) clearInterval(timer);
    }, 100);
  }

  // --- data ---------------------------------------------------------------
  var candidatesPromise = null;
  function loadCandidates() {
    if (!candidatesPromise) {
      candidatesPromise = fetch(BASE + "/search-index.json")
        .then(function (r) {
          return r.json();
        })
        .then(function (pages) {
          var out = [];
          for (var i = 0; i < pages.length; i++) {
            var p = pages[i];
            var ctx = p.route.replace(/^\/api\//, "").replace(/\/$/, "");
            out.push({
              kind: "title",
              label: p.title,
              context: ctx,
              route: p.route,
            });
            var subs = p.subtitles || [];
            for (var j = 0; j < subs.length; j++) {
              out.push({
                kind: "heading",
                label: subs[j].text,
                context: p.title,
                route: p.route,
                slug: subs[j].slug,
              });
            }
          }
          return out;
        })
        .catch(function () {
          return [];
        });
    }
    return candidatesPromise;
  }

  // --- fuzzy matching -----------------------------------------------------
  // Greedy in-order subsequence match with bonuses for contiguous runs,
  // word/path boundaries and camelCase boundaries; returns null if no match.
  function fuzzyMatch(query, str) {
    var q = query.toLowerCase();
    var s = str.toLowerCase();
    if (!q) return { score: 0, pos: [] };
    var pos = [];
    var qi = 0;
    var score = 0;
    var prev = -2;
    for (var i = 0; i < s.length && qi < q.length; i++) {
      if (s[i] !== q[qi]) continue;
      var bonus = 0;
      if (i === prev + 1) bonus += 8; // contiguous
      var pc = i > 0 ? s[i - 1] : "";
      if (i === 0 || pc === " " || pc === "/" || pc === "-" || pc === ".")
        bonus += 12; // boundary
      if (
        i > 0 &&
        str[i - 1] === str[i - 1].toLowerCase() &&
        str[i] !== str[i].toLowerCase()
      )
        bonus += 8; // camelCase boundary
      score += 10 + bonus;
      pos.push(i);
      prev = i;
      qi++;
    }
    if (qi < q.length) return null;
    if (s.indexOf(q) === 0) score += 30; // prefix
    if (s === q) score += 60; // exact
    score -= (s.length - pos.length) * 0.2; // prefer tighter matches
    score -= pos[0] * 0.5; // prefer earlier starts
    return { score: score, pos: pos };
  }

  function search(query, candidates) {
    var results = [];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var m = fuzzyMatch(query, c.label);
      if (!m) continue;
      var score = m.score;
      if (c.kind === "title") score += 20; // boost page titles over headings
      results.push({ item: c, score: score, pos: m.pos });
    }
    results.sort(function (a, b) {
      return b.score - a.score;
    });
    return results.slice(0, 50);
  }

  // --- rendering ----------------------------------------------------------
  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function highlight(text, pos) {
    if (!pos || !pos.length) return escapeHtml(text);
    var set = Object.create(null);
    for (var i = 0; i < pos.length; i++) set[pos[i]] = true;
    var html = "";
    for (var j = 0; j < text.length; j++) {
      var ch = escapeHtml(text[j]);
      html += set[j] ? "<mark>" + ch + "</mark>" : ch;
    }
    return html;
  }

  // --- styles -------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById("rmx-search-styles")) return;
    var style = document.createElement("style");
    style.id = "rmx-search-styles";
    style.textContent =
      "#rmx-search-overlay{position:fixed;inset:0;z-index:2147483647;display:none;" +
      "align-items:flex-start;justify-content:center;" +
      "background:var(--rmx-color-overlay-scrim,rgba(0,0,0,.28));" +
      "padding:12vh 16px 16px}" +
      "#rmx-search-overlay.open{display:flex}" +
      "#rmx-search-box{width:100%;max-width:640px;max-height:70vh;display:flex;" +
      "flex-direction:column;overflow:hidden;" +
      "background:var(--rmx-surface-lvl0,#fff);" +
      "color:var(--rmx-color-text-primary,#151515);" +
      "border:1px solid var(--rmx-color-border-default,#d1d1d1);" +
      "border-radius:var(--rmx-radius-lg,12px);" +
      "box-shadow:var(--rmx-shadow-xl,0 24px 52px rgba(0,0,0,.14));" +
      "font-family:var(--rmx-font-family-sans,system-ui,sans-serif)}" +
      "#rmx-search-input{width:100%;box-sizing:border-box;border:0;outline:0;" +
      "padding:16px 18px;font-size:var(--rmx-font-size-lg,16px);" +
      "background:transparent;color:inherit;" +
      "border-bottom:1px solid var(--rmx-color-border-subtle,#e7e7e7)}" +
      "#rmx-search-results{list-style:none;margin:0;padding:6px;overflow-y:auto;flex:1}" +
      "#rmx-search-results li{display:flex;flex-direction:column;gap:2px;" +
      "padding:8px 12px;border-radius:var(--rmx-radius-sm,4px);cursor:pointer}" +
      "#rmx-search-results li.active{background:var(--rmx-surface-lvl2,#f5f5f5)}" +
      "#rmx-search-results .rmx-s-label{font-size:var(--rmx-font-size-md,14px);" +
      "font-weight:var(--rmx-font-weight-medium,500)}" +
      "#rmx-search-results .rmx-s-ctx{font-size:var(--rmx-font-size-xs,12px);" +
      "color:var(--rmx-color-text-muted,#6d6d6d)}" +
      "#rmx-search-results .rmx-s-kind{float:right;font-size:var(--rmx-font-size-xxs,11px);" +
      "color:var(--rmx-color-text-muted,#6d6d6d);text-transform:uppercase;" +
      "letter-spacing:var(--rmx-letter-spacing-meta,.06em)}" +
      "#rmx-search-results mark{background:transparent;color:" +
      "var(--rmx-color-text-link,#1A72FF);font-weight:var(--rmx-font-weight-bold,700)}" +
      "#rmx-search-empty{padding:18px;color:var(--rmx-color-text-muted,#6d6d6d);" +
      "font-size:var(--rmx-font-size-sm,13px)}" +
      // footer with navigation hints inside the palette
      "#rmx-search-footer{display:flex;gap:14px;flex-wrap:wrap;padding:8px 14px;" +
      "border-top:1px solid var(--rmx-color-border-subtle,#e7e7e7);" +
      "color:var(--rmx-color-text-muted,#6d6d6d);font-size:var(--rmx-font-size-xs,12px)}" +
      // small discoverable trigger pill (fixed, bottom-right)
      "#rmx-search-hint{position:fixed;right:16px;bottom:16px;z-index:2147483646;" +
      "display:inline-flex;align-items:center;gap:6px;cursor:pointer;" +
      "padding:7px 12px;border:1px solid var(--rmx-color-border-default,#d1d1d1);" +
      "border-radius:var(--rmx-radius-full,9999px);" +
      "background:var(--rmx-surface-lvl0,#fff);color:var(--rmx-color-text-secondary,#4f4f4f);" +
      "box-shadow:var(--rmx-shadow-md,0 6px 18px rgba(0,0,0,.08));" +
      "font-family:var(--rmx-font-family-sans,system-ui,sans-serif);" +
      "font-size:var(--rmx-font-size-xs,12px)}" +
      "#rmx-search-hint:hover{border-color:var(--rmx-color-border-strong,#b0b0b0)}" +
      ".rmx-kbd{display:inline-block;padding:1px 6px;border-radius:var(--rmx-radius-sm,4px);" +
      "border:1px solid var(--rmx-color-border-default,#d1d1d1);" +
      "background:var(--rmx-surface-lvl1,#f8f8f8);color:var(--rmx-color-text-secondary,#4f4f4f);" +
      "font-family:var(--rmx-font-family-mono,ui-monospace,monospace);" +
      "font-size:var(--rmx-font-size-xxs,11px);line-height:1.6}";
    document.head.appendChild(style);
  }

  // --- palette UI ---------------------------------------------------------
  var ui = null; // { overlay, input, list, empty }
  var results = [];
  var activeIndex = 0;
  var lastFocused = null;

  function buildUI() {
    injectStyles();
    var overlay = document.createElement("div");
    overlay.id = "rmx-search-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");

    var box = document.createElement("div");
    box.id = "rmx-search-box";

    var input = document.createElement("input");
    input.id = "rmx-search-input";
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = "Search the API docs…";
    input.setAttribute("aria-label", "Search the API docs");

    var list = document.createElement("ul");
    list.id = "rmx-search-results";

    var empty = document.createElement("div");
    empty.id = "rmx-search-empty";
    empty.style.display = "none";

    var footer = document.createElement("div");
    footer.id = "rmx-search-footer";
    footer.innerHTML =
      '<span><span class="rmx-kbd">↑</span> <span class="rmx-kbd">↓</span> navigate</span>' +
      '<span><span class="rmx-kbd">↵</span> open</span>' +
      '<span><span class="rmx-kbd">esc</span> close</span>';

    box.appendChild(input);
    box.appendChild(list);
    box.appendChild(empty);
    box.appendChild(footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    overlay.addEventListener("mousedown", function (e) {
      if (e.target === overlay) close();
    });
    input.addEventListener("input", function () {
      runQuery(input.value);
    });
    input.addEventListener("keydown", onInputKeydown);

    ui = { overlay: overlay, input: input, list: list, empty: empty };
  }

  function isOpen() {
    return ui && ui.overlay.classList.contains("open");
  }

  function open() {
    if (!ui) buildUI();
    if (isOpen()) return;
    lastFocused = document.activeElement;
    loadCandidates();
    ui.overlay.classList.add("open");
    ui.input.value = "";
    runQuery("");
    ui.input.focus();
  }

  function close() {
    if (!isOpen()) return;
    ui.overlay.classList.remove("open");
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  function runQuery(query) {
    loadCandidates().then(function (candidates) {
      if (!isOpen()) return;
      query = query.trim();
      results = query ? search(query, candidates) : [];
      activeIndex = 0;
      render(query);
    });
  }

  function render(query) {
    var list = ui.list;
    list.innerHTML = "";
    if (!results.length) {
      ui.empty.textContent = query
        ? "No matches for “" + query + "”"
        : "Type to search titles and section headings…";
      ui.empty.style.display = "";
      return;
    }
    ui.empty.style.display = "none";
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var it = r.item;
      var li = document.createElement("li");
      li.className = i === activeIndex ? "active" : "";
      li.innerHTML =
        '<div class="rmx-s-label"><span class="rmx-s-kind">' +
        (it.kind === "title" ? "page" : "§") +
        "</span>" +
        highlight(it.label, r.pos) +
        '</div><div class="rmx-s-ctx">' +
        escapeHtml(it.context) +
        "</div>";
      (function (idx) {
        li.addEventListener("mousemove", function () {
          setActive(idx);
        });
        li.addEventListener("click", function () {
          go(results[idx].item);
        });
      })(i);
      list.appendChild(li);
    }
  }

  function setActive(i) {
    if (i === activeIndex) return;
    var items = ui.list.children;
    if (items[activeIndex]) items[activeIndex].className = "";
    activeIndex = i;
    if (items[activeIndex]) items[activeIndex].className = "active";
  }

  function move(delta) {
    if (!results.length) return;
    var next = (activeIndex + delta + results.length) % results.length;
    setActive(next);
    var el = ui.list.children[next];
    if (el) el.scrollIntoView({ block: "nearest" });
  }

  function onInputKeydown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[activeIndex]) go(results[activeIndex].item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  // --- navigation ---------------------------------------------------------
  function normalizePath(p) {
    return p.replace(/\/+$/, "");
  }

  function go(item) {
    close();
    var hash = item.kind === "heading" ? "#" + item.slug : "";
    var target = BASE + item.route; // routes in the index are base-relative
    if (normalizePath(location.pathname) === normalizePath(target)) {
      // Same page: just scroll, no reload.
      if (item.kind === "heading") {
        assignIds();
        if (history.replaceState) history.replaceState(null, "", hash);
        scrollToId(item.slug);
      }
      return;
    }
    location.assign(target + hash);
  }

  // --- global shortcuts ---------------------------------------------------
  function isTyping(el) {
    if (!el) return false;
    var tag = el.tagName;
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      el.isContentEditable
    );
  }

  document.addEventListener(
    "keydown",
    function (e) {
      var mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        isOpen() ? close() : open();
        return;
      }
      // Cmd/Ctrl+Shift+P (note: Firefox reserves this for Private Window).
      if (mod && e.shiftKey && (e.code === "KeyP" || e.key === "P" || e.key === "p")) {
        e.preventDefault();
        isOpen() ? close() : open();
        return;
      }
      if (e.key === "/" && !isOpen() && !isTyping(e.target)) {
        e.preventDefault();
        open();
        return;
      }
      if (e.key === "Escape" && isOpen()) {
        e.preventDefault();
        close();
      }
    },
    true,
  );

  // --- discoverable trigger hint ------------------------------------------
  function buildHint() {
    if (document.getElementById("rmx-search-hint")) return;
    injectStyles();
    var hint = document.createElement("button");
    hint.id = "rmx-search-hint";
    hint.type = "button";
    hint.setAttribute("aria-label", "Open search (" + MOD + "K)");
    hint.innerHTML =
      "Search <span class=\"rmx-kbd\">" +
      MOD +
      " K</span>";
    hint.addEventListener("click", open);
    document.body.appendChild(hint);
  }

  // --- boot ---------------------------------------------------------------
  function boot() {
    assignIds();
    scrollToHashWithRetry();
    buildHint();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
