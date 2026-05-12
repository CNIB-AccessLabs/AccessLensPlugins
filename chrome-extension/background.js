/*
 * AccessibleName Inspector — background script.
 *
 * Multi-check accessibility inspector. The toolbar button opens popup.html;
 * the popup lets the user pick a check to run, or close the active one.
 * Keyboard shortcuts (Alt+A for names, Alt+H for headings) skip the popup.
 *
 * Each check is a pair of self-contained functions:
 *
 *   scanXxx()         runs in EVERY frame, returns serializable results.
 *   displayXxx(data)  runs in the TOP frame, renders the panel/badges.
 *
 * Both functions are passed to chrome.scripting.executeScript via `func:`,
 * which serializes the function source. They cannot reference outer scope.
 *
 * Active state per tab is stored on `window.__a11yn_ext_active` (the check id)
 * and the cleanup function on `window.__a11yn_ext_cleanup`. The popup queries
 * the active tab to learn what's running.
 */

const api = typeof browser !== "undefined" ? browser : chrome;

const CHECKS = {
  names:    { label: "Accessible Names", scan: scanNames,    display: displayNames    },
  headings: { label: "Headings",         scan: scanHeadings, display: displayHeadings }
};

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.type === "run") {
    runCheck(msg.tabId, msg.checkId).catch(e => console.error("[a11yn] run failed:", e));
    return false;
  }
  if (msg.type === "close") {
    closeActive(msg.tabId).catch(e => console.error("[a11yn] close failed:", e));
    return false;
  }
  if (msg.type === "status") {
    getStatus(msg.tabId).then(sendResponse).catch(() => sendResponse({ active: null }));
    return true; // async response
  }
  return false;
});

api.commands.onCommand.addListener(async (cmd) => {
  try {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0] || tabs[0].id == null) return;
    if (cmd === "run-names")    await runCheck(tabs[0].id, "names");
    if (cmd === "run-headings") await runCheck(tabs[0].id, "headings");
  } catch (e) {
    console.error("[a11yn] command failed:", e);
  }
});

async function runCheck(tabId, checkId) {
  const check = CHECKS[checkId];
  if (!check) return;
  // If something is showing, clear it first regardless of which check.
  await closeActive(tabId);
  // Scan every frame.
  const injection = await api.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: check.scan
  });
  const aggregated = injection.map(i => ({
    frameId: i.frameId,
    url: (i.result && i.result.url) || "",
    isTop: !!(i.result && i.result.isTop),
    results: (i.result && i.result.results) || [],
    shadowRoots: (i.result && i.result.shadowRoots) || 0,
    error: i.result && i.result.error
  }));
  // Render in the top frame.
  await api.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: check.display,
    args: [aggregated, checkId]
  });
}

async function closeActive(tabId) {
  try {
    await api.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => { if (window.__a11yn_ext_cleanup) window.__a11yn_ext_cleanup(); }
    });
  } catch (e) { /* tab might be gone */ }
}

async function getStatus(tabId) {
  try {
    const probe = await api.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => ({ active: window.__a11yn_ext_active || null })
    });
    return (probe[0] && probe[0].result) || { active: null };
  } catch (e) {
    return { active: null };
  }
}

/* ====================================================================
 * SHARED display helpers — duplicated inside each display function
 * because executeScript injection can't share scope. Keep them in sync.
 * ==================================================================== */

/* ====================================================================
 * CHECK: NAMES — accessible name inspector
 * ==================================================================== */

function scanNames() {
  "use strict";
  try {
    function txt(s) { return (s == null ? "" : String(s)).replace(/\s+/g, " ").trim(); }

    function isHidden(el) {
      if (!el || el.nodeType !== 1) return false;
      if (el.getAttribute("aria-hidden") === "true") return true;
      try {
        var win = el.ownerDocument && el.ownerDocument.defaultView;
        if (!win) return false;
        var st = win.getComputedStyle(el);
        return st.display === "none" || st.visibility === "hidden";
      } catch (e) { return false; }
    }

    function nameFromContent(el, seen) {
      if (!el || seen.has(el)) return "";
      seen.add(el);
      var parts = [];
      for (var n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) parts.push(n.nodeValue);
        else if (n.nodeType === 1) {
          if (isHidden(n)) continue;
          var aLab = n.getAttribute && n.getAttribute("aria-labelledby");
          if (aLab) { parts.push(refNames(aLab, n, seen)); continue; }
          var aL = n.getAttribute && n.getAttribute("aria-label");
          if (aL && aL.trim()) { parts.push(aL); continue; }
          if (n.tagName === "IMG") { var alt = n.getAttribute("alt"); if (alt) parts.push(alt); continue; }
          if (n.tagName === "INPUT") {
            var t = (n.getAttribute("type") || "text").toLowerCase();
            if (t === "button" || t === "submit" || t === "reset") { if (n.value) parts.push(n.value); }
            else if (t === "image" && n.alt) parts.push(n.alt);
            continue;
          }
          parts.push(nameFromContent(n, seen));
        }
      }
      return txt(parts.join(" "));
    }

    function refNames(idrefs, contextEl, seen) {
      var doc = contextEl.ownerDocument || document;
      var root = contextEl.getRootNode ? contextEl.getRootNode() : doc;
      return idrefs.split(/\s+/).map(function (id) {
        var ref = (root.getElementById && root.getElementById(id)) || doc.getElementById(id);
        if (!ref) return "";
        var aL = ref.getAttribute("aria-label");
        if (aL && aL.trim()) return aL.trim();
        return nameFromContent(ref, seen);
      }).filter(Boolean).join(" ");
    }

    function accName(el) {
      var seen = new Set();
      var doc = el.ownerDocument || document;
      var root = el.getRootNode ? el.getRootNode() : doc;
      var aLab = el.getAttribute("aria-labelledby");
      if (aLab) { var n1 = refNames(aLab, el, seen); if (n1) return { name: n1, src: "aria-labelledby" }; }
      var aL = el.getAttribute("aria-label");
      if (aL && aL.trim()) return { name: aL.trim(), src: "aria-label" };
      var tag = el.tagName.toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea" || tag === "meter" || tag === "progress") {
        if (el.id) {
          var sel = 'label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id.replace(/"/g, '\\"')) + '"]';
          var lab = (root.querySelector && root.querySelector(sel)) || doc.querySelector(sel);
          if (lab) { var n2 = nameFromContent(lab, seen); if (n2) return { name: n2, src: "label[for]" }; }
        }
        var wrap = el.closest && el.closest("label");
        if (wrap) { var n3 = nameFromContent(wrap, seen); if (n3) return { name: n3, src: "wrapping <label>" }; }
        if (tag === "input") {
          var t2 = (el.getAttribute("type") || "text").toLowerCase();
          if (t2 === "button" || t2 === "submit" || t2 === "reset") {
            if (el.value) return { name: el.value, src: "value" };
            if (t2 === "submit") return { name: "Submit", src: "default (submit)" };
            if (t2 === "reset") return { name: "Reset", src: "default (reset)" };
          }
          if (t2 === "image" && el.getAttribute("alt")) return { name: el.getAttribute("alt"), src: "alt" };
        }
      }
      if (tag === "img") {
        var alt2 = el.getAttribute("alt");
        if (alt2 !== null) return { name: alt2, src: "alt" };
      }
      if (tag === "fieldset") {
        var lg = el.querySelector(":scope > legend");
        if (lg) { var n4 = nameFromContent(lg, seen); if (n4) return { name: n4, src: "legend" }; }
      }
      if (tag === "a" || tag === "button" || tag === "summary" || tag === "details" ||
          (el.matches && el.matches('[role="button"],[role="link"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],[role="treeitem"]'))) {
        var n5 = nameFromContent(el, seen);
        if (n5) return { name: n5, src: "subtree text" };
      }
      var ti = el.getAttribute("title");
      if (ti && ti.trim()) return { name: ti.trim(), src: "title" };
      var ph = el.getAttribute("placeholder");
      if (ph && ph.trim()) return { name: ph.trim(), src: "placeholder (not spec accname)" };
      return { name: "", src: "" };
    }

    function role(el) {
      var explicit = el.getAttribute("role");
      if (explicit) return explicit;
      var tag = el.tagName.toLowerCase();
      if (tag === "a") return el.hasAttribute("href") ? "link" : "";
      if (tag === "button") return "button";
      if (tag === "select") return el.multiple ? "listbox" : "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "summary") return "button";
      if (tag === "details") return "group";
      if (tag === "input") {
        var t = (el.getAttribute("type") || "text").toLowerCase();
        return ({
          checkbox: "checkbox", radio: "radio",
          button: "button", submit: "button", reset: "button", image: "button",
          range: "slider", number: "spinbutton",
          search: "searchbox", email: "textbox", tel: "textbox",
          url: "textbox", text: "textbox"
        })[t] || (t === "password" ? "" : "textbox");
      }
      if (tag === "img") return el.getAttribute("alt") === "" ? "presentation" : "img";
      return "";
    }

    function uniqueSelector(el) {
      if (!el || el.nodeType !== 1) return "";
      var doc = el.ownerDocument || document;
      var root = el.getRootNode ? el.getRootNode() : doc;
      function esc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/(["\\])/g, "\\$1"); }
      function idUnique(id) {
        try { return root.querySelectorAll && root.querySelectorAll("#" + esc(id)).length === 1; }
        catch (e) { return false; }
      }
      if (el.id && idUnique(el.id)) return "#" + esc(el.id);
      var parts = [];
      var cur = el;
      var hops = 0;
      while (cur && cur.nodeType === 1 && hops < 30) {
        var tag = cur.tagName.toLowerCase();
        if (cur !== el && cur.id && idUnique(cur.id)) { parts.unshift("#" + esc(cur.id)); break; }
        var part = tag;
        var parent = cur.parentElement;
        if (parent) {
          var sibs = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === cur.tagName; });
          if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(cur) + 1) + ")";
          parts.unshift(part);
          cur = parent;
        } else { parts.unshift(part); break; }
        hops++;
      }
      return parts.join(" > ");
    }

    var SELECTOR = [
      "a[href]", "button",
      'input:not([type="hidden"])', "select", "textarea",
      "summary", "details",
      '[tabindex]:not([tabindex="-1"])',
      '[contenteditable=""]', '[contenteditable="true"]',
      "[onclick]",
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
      '[role="switch"]', '[role="tab"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
      '[role="menuitemradio"]', '[role="option"]', '[role="combobox"]', '[role="textbox"]',
      '[role="searchbox"]', '[role="slider"]', '[role="spinbutton"]', '[role="treeitem"]'
    ].join(",");

    var results = [];
    var seenEls = new Set();
    var shadowRoots = 0;

    function walk(root) {
      var matches;
      try { matches = root.querySelectorAll(SELECTOR); } catch (e) { return; }
      Array.prototype.forEach.call(matches, function (el) {
        if (seenEls.has(el)) return;
        seenEls.add(el);
        var r;
        try { r = el.getBoundingClientRect(); } catch (e) { return; }
        if (r.width === 0 && r.height === 0) return;
        if (isHidden(el)) return;
        var an = accName(el);
        results.push({
          tag: el.tagName.toLowerCase(),
          role: role(el),
          name: an.name,
          src: an.src,
          missing: !an.name || an.src === "placeholder (not spec accname)",
          selector: uniqueSelector(el),
          rect: { top: r.top, left: r.left, width: r.width, height: r.height }
        });
      });
      var all;
      try { all = root.querySelectorAll("*"); } catch (e) { all = []; }
      Array.prototype.forEach.call(all, function (el) {
        if (el.shadowRoot) { shadowRoots++; walk(el.shadowRoot); }
      });
    }

    walk(document);

    return { url: window.location.href, isTop: window === window.top, results: results, shadowRoots: shadowRoots };
  } catch (e) {
    return { url: window.location.href, isTop: window === window.top, results: [], error: String(e && e.message || e) };
  }
}

function displayNames(framesData, checkId) {
  "use strict";
  var P = "__a11yn_ext_";
  if (window[P + "cleanup"]) window[P + "cleanup"]();

  var iframes = Array.prototype.slice.call(document.querySelectorAll("iframe, frame"));
  var iframeByUrl = new Map();
  iframes.forEach(function (f) {
    var url = "";
    try {
      if (f.contentWindow && f.contentWindow.location && f.contentWindow.location.href !== "about:blank") {
        url = f.contentWindow.location.href;
      }
    } catch (e) {}
    if (!url && f.src) url = f.src;
    if (url && !iframeByUrl.has(url)) iframeByUrl.set(url, f);
  });

  var allResults = [];
  var unmatchedFrames = 0;
  var frameLabelByUrl = new Map();
  framesData.forEach(function (frame) {
    if (!frame || frame.error) return;
    if (!frame.results || !frame.results.length) return;
    var offX = 0, offY = 0, positioned = true, inFrame = !frame.isTop;
    if (inFrame) {
      var iframe = iframeByUrl.get(frame.url);
      if (iframe) { var ir = iframe.getBoundingClientRect(); offX = ir.left; offY = ir.top; }
      else { positioned = false; unmatchedFrames++; }
    }
    if (inFrame) {
      try { var u = new URL(frame.url); frameLabelByUrl.set(frame.url, u.hostname + u.pathname.replace(/\/$/, "")); }
      catch (e) { frameLabelByUrl.set(frame.url, frame.url); }
    }
    frame.results.forEach(function (r) {
      allResults.push({
        tag: r.tag, role: r.role, name: r.name, src: r.src, missing: r.missing,
        selector: r.selector,
        frameUrl: frame.url,
        frameLabel: inFrame ? frameLabelByUrl.get(frame.url) : null,
        isTop: !inFrame,
        pageTop: window.scrollY + offY + r.rect.top,
        pageLeft: window.scrollX + offX + r.rect.left,
        positioned: positioned,
        iframeEl: inFrame ? iframeByUrl.get(frame.url) || null : null,
        _resolveEl: null
      });
    });
  });
  allResults.forEach(function (r, i) { r.index = i + 1; });

  allResults.forEach(function (r) {
    var doc;
    if (r.isTop) doc = document;
    else if (r.iframeEl) { try { doc = r.iframeEl.contentDocument; } catch (e) { doc = null; } }
    if (!doc) return;
    try {
      var el = doc.querySelector(r.selector);
      if (el) {
        r._resolveEl = el;
        el.style.setProperty("outline", r.missing ? "2px dashed #b00020" : "2px solid #003876", "important");
        el.style.setProperty("outline-offset", "1px", "important");
      }
    } catch (e) {}
  });

  var host = document.createElement("div");
  host.id = P + "host";
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "all:initial !important;position:absolute !important;top:0 !important;left:0 !important;width:0 !important;height:0 !important;margin:0 !important;padding:0 !important;border:0 !important;font:400 16px/1.4 ui-sans-serif,system-ui,sans-serif !important;color:#111 !important;pointer-events:none !important;z-index:2147483647 !important;";
  (document.body || document.documentElement).appendChild(host);
  var shadow = host.attachShadow({ mode: "closed" });

  var css =
    ":host{all:initial;font-family:ui-sans-serif,system-ui,sans-serif !important;}" +
    "*,*::before,*::after{box-sizing:border-box;font-family:ui-sans-serif,system-ui,sans-serif !important;font-style:normal !important;font-weight:400 !important;font-variant:normal !important;text-transform:none !important;letter-spacing:normal !important;text-decoration:none !important;color:#111;}" +
    ".badge{position:absolute;background:#003876;color:#fff;font-size:16px;font-weight:600;line-height:1.2;padding:4px 8px;border-radius:3px;pointer-events:none;max-width:380px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,.4);}" +
    ".badge.miss{background:#b00020;}" +
    ".badge.frame{background:#0a5d2e;}" +
    ".badge.frame.miss{background:#7a1518;}" +
    ".panel{position:fixed;top:12px;right:12px;width:460px;max-height:85vh;display:flex;flex-direction:column;background:#fff;color:#111;border:1px solid #bbb;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.25);font-size:16px;line-height:1.4;pointer-events:auto;}" +
    ".panel header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#003876;color:#fff;border-radius:6px 6px 0 0;}" +
    ".panel header strong{font-size:18px;font-weight:600;color:#fff;}" +
    ".panel .btns{display:flex;gap:8px;}" +
    ".panel button{background:transparent;border:1px solid #fff;color:#fff;padding:6px 12px;border-radius:3px;cursor:pointer;font-size:16px;font-weight:500;line-height:1.2;}" +
    ".panel button:hover{background:rgba(255,255,255,.18);}" +
    ".panel .summary{padding:10px 14px;border-bottom:1px solid #eee;background:#f5f7fa;font-size:16px;}" +
    ".panel .summary .miss{color:#b00020;font-weight:600;}" +
    ".panel .summary .ok{color:#0a8043;font-weight:600;}" +
    ".panel .summary .warn{color:#b45309;font-weight:600;}" +
    ".panel ol{margin:0;padding:0;list-style:none;overflow:auto;flex:1 1 auto;}" +
    ".panel li{padding:10px 14px;border-bottom:1px solid #eee;cursor:pointer;font-size:16px;}" +
    ".panel li:hover{background:#eef4ff;}" +
    ".panel li.frame-tag{border-left:3px solid #0a5d2e;}" +
    ".panel li .meta{color:#555;font-size:16px;margin-bottom:2px;}" +
    ".panel li .frame-label{color:#0a5d2e;font-weight:600;}" +
    ".panel li .name{font-weight:600;color:#111;font-size:16px;}" +
    ".panel li .miss{color:#b00020;font-weight:600;font-size:16px;}" +
    ".panel li .src{color:#666;font-size:16px;font-style:italic;margin-top:2px;word-break:break-all;}" +
    ".panel code{font-family:ui-monospace,monospace !important;font-size:16px;background:rgba(0,0,0,.06);padding:1px 5px;border-radius:3px;}" +
    ".panel header strong{font-weight:600 !important;font-size:18px;}" +
    ".badge{font-weight:600 !important;}" +
    ".panel .summary .miss,.panel .summary .ok,.panel .summary .warn,.panel li .name,.panel li .miss,.panel li .frame-label{font-weight:600 !important;}";

  var styleEl = document.createElement("style");
  styleEl.textContent = css;
  shadow.appendChild(styleEl);

  var badges = [];
  allResults.forEach(function (r) {
    if (!r.positioned) return;
    var badge = document.createElement("div");
    var cls = "badge";
    if (r.missing) cls += " miss";
    if (!r.isTop) cls += " frame";
    badge.className = cls;
    var prefix = r.isTop ? "" : "[frame] ";
    badge.textContent = "#" + r.index + " " + prefix + (r.role || r.tag) + ": " + (r.missing ? (r.name ? "⚠ " + r.name : "NO NAME") : r.name);
    badge.style.top = (r.pageTop - 28) + "px";
    badge.style.left = r.pageLeft + "px";
    shadow.appendChild(badge);
    badges.push(badge);
    r.badge = badge;
  });

  var missingCount = allResults.filter(function (r) { return r.missing && !r.name; }).length;
  var placeholderOnlyCount = allResults.filter(function (r) { return r.missing && r.name; }).length;
  var missCount = missingCount + placeholderOnlyCount;
  var frameCount = framesData.filter(function (f) { return !f.isTop && f.results && f.results.length; }).length;

  function mdEsc(s) { return String(s).replace(/\|/g, "\\|").replace(/\n+/g, " "); }
  var md = "| # | Frame | Tag | Role | Accessible Name | Source | Selector |\n";
  md += "|---|-------|-----|------|-----------------|--------|----------|\n";
  allResults.forEach(function (r) {
    var n = r.missing && !r.name ? "⚠ **MISSING**" : (r.missing ? "⚠ **Placeholder only:** " + mdEsc(r.name) : mdEsc(r.name));
    var frameLabel = r.isTop ? "(top)" : mdEsc(r.frameLabel || r.frameUrl);
    md += "| " + r.index + " | " + frameLabel + " | `" + r.tag + "` | " + (r.role || "") + " | " + n + " | " + (r.src || "") + " | `" + mdEsc(r.selector) + "` |\n";
  });

  console.group("%c[a11yn names] " + allResults.length + " interactive elements (" + missCount + " problems) — top doc + " + frameCount + " frame(s)",
    "color:#003876;font-weight:bold;font-size:13px");
  console.table(allResults.map(function (r) {
    return { "#": r.index, frame: r.isTop ? "(top)" : (r.frameLabel || r.frameUrl), tag: r.tag, role: r.role,
      name: r.missing && !r.name ? "⚠ MISSING" : r.name, source: r.src, selector: r.selector };
  }));
  console.log("%cMarkdown table:", "font-weight:bold");
  console.log(md);
  console.groupEnd();

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }

  var panelEl = document.createElement("div");
  panelEl.className = "panel";

  var summary = "";
  if (allResults.length === 0) {
    summary += '<span class="warn">No interactive elements found.</span>';
  } else if (missCount === 0) {
    summary += '<span class="ok">All elements have an accessible name.</span>';
  } else {
    var bits = [];
    if (missingCount) bits.push(missingCount + " missing an accessible name");
    if (placeholderOnlyCount) bits.push(placeholderOnlyCount + " with placeholder only (not a spec accname)");
    summary += '<span class="miss">' + bits.join(", ") + ".</span>";
  }
  if (unmatchedFrames) summary += '<br><span class="warn">⚠ ' + unmatchedFrames + " frame(s) couldn't be positioned.</span>";
  summary += '<div style="margin-top:6px;color:#555;font-size:16px">Top doc' + (frameCount ? " + " + frameCount + " frame" + (frameCount === 1 ? "" : "s") : "") + ".</div>";

  panelEl.innerHTML =
    "<header><strong>Accessible Names (" + allResults.length + ")</strong>" +
    '<div class="btns"><button id="' + P + 'copy">Copy MD</button><button id="' + P + 'close">Close</button></div></header>' +
    '<div class="summary">' + summary + "</div>" +
    '<ol id="' + P + 'list"></ol>';

  var list = panelEl.querySelector("#" + P + "list");
  allResults.forEach(function (r) {
    var li = document.createElement("li");
    if (!r.isTop) li.classList.add("frame-tag");
    var location = r.isTop ? "" : '<span class="frame-label">[' + esc(r.frameLabel || r.frameUrl) + ']</span> ';
    li.innerHTML =
      '<div class="meta">#' + r.index + " " + location + "<code>" + esc(r.tag) + "</code>" + (r.role ? " [" + esc(r.role) + "]" : "") + "</div>" +
      '<div class="' + (r.missing ? "miss" : "name") + '">' + (r.missing && !r.name ? "⚠ NO ACCESSIBLE NAME" : (r.missing ? "⚠ Placeholder only: " + esc(r.name) : esc(r.name))) + "</div>" +
      (r.src ? '<div class="src">via ' + esc(r.src) + " &middot; " + esc(r.selector) + "</div>" : "");
    li.addEventListener("click", function () {
      try {
        if (r._resolveEl) {
          r._resolveEl.scrollIntoView({ behavior: "smooth", block: "center" });
          r._resolveEl.style.setProperty("box-shadow", "0 0 0 4px #ffeb3b", "important");
          setTimeout(function () { try { r._resolveEl.style.removeProperty("box-shadow"); } catch (e) {} }, 1400);
        } else if (r.iframeEl) {
          r.iframeEl.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        if (r.badge) {
          r.badge.style.setProperty("box-shadow", "0 0 0 4px #ffeb3b", "important");
          setTimeout(function () { try { r.badge.style.removeProperty("box-shadow"); } catch (e) {} }, 1400);
        }
      } catch (e) {}
    });
    list.appendChild(li);
  });
  shadow.appendChild(panelEl);

  panelEl.querySelector("#" + P + "close").addEventListener("click", function () { window[P + "cleanup"](); });
  panelEl.querySelector("#" + P + "copy").addEventListener("click", function (e) {
    var btn = e.currentTarget;
    var done = function (ok) { btn.textContent = ok ? "Copied!" : "Copy failed"; setTimeout(function () { btn.textContent = "Copy MD"; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(md).then(function () { done(true); }, function () { done(false); });
    } else {
      var ta = document.createElement("textarea"); ta.value = md; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(true); } catch (err) { done(false); } ta.remove();
    }
  });

  window[P + "active"] = checkId;
  window[P + "cleanup"] = function () {
    try { host.remove(); } catch (e) {}
    allResults.forEach(function (r) {
      if (r._resolveEl) {
        try {
          r._resolveEl.style.removeProperty("outline");
          r._resolveEl.style.removeProperty("outline-offset");
        } catch (e) {}
      }
    });
    delete window[P + "cleanup"];
    delete window[P + "active"];
    console.log("%c[a11yn] cleared.", "color:#003876");
  };
}

/* ====================================================================
 * CHECK: HEADINGS — heading tree inspector
 *
 * Reports h1..h6 and role="heading" elements with:
 *   - their level (from tag name, overridden by aria-level if present)
 *   - their position number (global, in document order across frames)
 *   - their text content
 *   - issues: empty, skipped levels, multiple h1, role="heading" missing
 *     aria-level, out-of-range aria-level
 * ==================================================================== */

function scanHeadings() {
  "use strict";
  try {
    function txt(s) { return (s == null ? "" : String(s)).replace(/\s+/g, " ").trim(); }

    function isHidden(el) {
      if (!el || el.nodeType !== 1) return false;
      if (el.getAttribute("aria-hidden") === "true") return true;
      try {
        var win = el.ownerDocument && el.ownerDocument.defaultView;
        if (!win) return false;
        var st = win.getComputedStyle(el);
        return st.display === "none" || st.visibility === "hidden";
      } catch (e) { return false; }
    }

    function uniqueSelector(el) {
      if (!el || el.nodeType !== 1) return "";
      var doc = el.ownerDocument || document;
      var root = el.getRootNode ? el.getRootNode() : doc;
      function esc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/(["\\])/g, "\\$1"); }
      function idUnique(id) {
        try { return root.querySelectorAll && root.querySelectorAll("#" + esc(id)).length === 1; }
        catch (e) { return false; }
      }
      if (el.id && idUnique(el.id)) return "#" + esc(el.id);
      var parts = [];
      var cur = el;
      var hops = 0;
      while (cur && cur.nodeType === 1 && hops < 30) {
        var tag = cur.tagName.toLowerCase();
        if (cur !== el && cur.id && idUnique(cur.id)) { parts.unshift("#" + esc(cur.id)); break; }
        var part = tag;
        var parent = cur.parentElement;
        if (parent) {
          var sibs = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === cur.tagName; });
          if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(cur) + 1) + ")";
          parts.unshift(part);
          cur = parent;
        } else { parts.unshift(part); break; }
        hops++;
      }
      return parts.join(" > ");
    }

    // Heading sources: native h1..h6 and ARIA role="heading"
    var SELECTOR = 'h1,h2,h3,h4,h5,h6,[role="heading"]';

    var results = [];
    var seenEls = new Set();
    var shadowRoots = 0;

    function walk(root) {
      var matches;
      try { matches = root.querySelectorAll(SELECTOR); } catch (e) { return; }
      Array.prototype.forEach.call(matches, function (el) {
        if (seenEls.has(el)) return;
        seenEls.add(el);
        var r;
        try { r = el.getBoundingClientRect(); } catch (e) { return; }
        if (isHidden(el)) return;

        var tag = el.tagName.toLowerCase();
        var isNative = /^h[1-6]$/.test(tag);
        var level = null;
        var levelSource = null;

        if (isNative) {
          level = parseInt(tag.slice(1), 10);
          levelSource = "tag";
        }
        // aria-level overrides the native level per ARIA spec
        var ariaLevelAttr = el.getAttribute("aria-level");
        if (ariaLevelAttr !== null && ariaLevelAttr.trim() !== "") {
          var parsed = parseInt(ariaLevelAttr.trim(), 10);
          if (!isNaN(parsed)) { level = parsed; levelSource = "aria-level"; }
          else { levelSource = "aria-level (invalid: " + ariaLevelAttr + ")"; }
        }

        var text = txt(el.textContent);

        results.push({
          tag: tag,
          isNative: isNative,
          level: level,
          levelSource: levelSource,
          text: text,
          empty: !text,
          selector: uniqueSelector(el),
          rect: { top: r.top, left: r.left, width: r.width, height: r.height }
        });
      });
      var all;
      try { all = root.querySelectorAll("*"); } catch (e) { all = []; }
      Array.prototype.forEach.call(all, function (el) {
        if (el.shadowRoot) { shadowRoots++; walk(el.shadowRoot); }
      });
    }

    walk(document);

    // Sort by visual order within this frame (top-to-bottom, then left-to-right)
    results.sort(function (a, b) {
      if (a.rect.top !== b.rect.top) return a.rect.top - b.rect.top;
      return a.rect.left - b.rect.left;
    });

    return { url: window.location.href, isTop: window === window.top, results: results, shadowRoots: shadowRoots };
  } catch (e) {
    return { url: window.location.href, isTop: window === window.top, results: [], error: String(e && e.message || e) };
  }
}

function displayHeadings(framesData, checkId) {
  "use strict";
  var P = "__a11yn_ext_";
  if (window[P + "cleanup"]) window[P + "cleanup"]();

  var iframes = Array.prototype.slice.call(document.querySelectorAll("iframe, frame"));
  var iframeByUrl = new Map();
  iframes.forEach(function (f) {
    var url = "";
    try {
      if (f.contentWindow && f.contentWindow.location && f.contentWindow.location.href !== "about:blank") {
        url = f.contentWindow.location.href;
      }
    } catch (e) {}
    if (!url && f.src) url = f.src;
    if (url && !iframeByUrl.has(url)) iframeByUrl.set(url, f);
  });

  var allResults = [];
  var unmatchedFrames = 0;
  var frameLabelByUrl = new Map();
  framesData.forEach(function (frame) {
    if (!frame || frame.error) return;
    if (!frame.results || !frame.results.length) return;
    var offX = 0, offY = 0, positioned = true, inFrame = !frame.isTop;
    if (inFrame) {
      var iframe = iframeByUrl.get(frame.url);
      if (iframe) { var ir = iframe.getBoundingClientRect(); offX = ir.left; offY = ir.top; }
      else { positioned = false; unmatchedFrames++; }
    }
    if (inFrame) {
      try { var u = new URL(frame.url); frameLabelByUrl.set(frame.url, u.hostname + u.pathname.replace(/\/$/, "")); }
      catch (e) { frameLabelByUrl.set(frame.url, frame.url); }
    }
    frame.results.forEach(function (r) {
      allResults.push({
        tag: r.tag,
        isNative: r.isNative,
        level: r.level,
        levelSource: r.levelSource,
        text: r.text,
        empty: r.empty,
        selector: r.selector,
        frameUrl: frame.url,
        frameLabel: inFrame ? frameLabelByUrl.get(frame.url) : null,
        isTop: !inFrame,
        pageTop: window.scrollY + offY + r.rect.top,
        pageLeft: window.scrollX + offX + r.rect.left,
        positioned: positioned,
        iframeEl: inFrame ? iframeByUrl.get(frame.url) || null : null,
        _resolveEl: null
      });
    });
  });
  // Number in document order across frames (1-based).
  allResults.forEach(function (r, i) { r.index = i + 1; });

  // Issue analysis
  var h1Count = allResults.filter(function (r) { return r.level === 1; }).length;
  var prevValidLevel = 0;
  allResults.forEach(function (r) {
    r.issues = [];
    if (r.empty) r.issues.push("empty heading");
    if (!r.isNative && r.level === null) r.issues.push('role="heading" with no aria-level');
    if (r.level !== null && (r.level < 1 || r.level > 6)) r.issues.push("aria-level out of range (expected 1–6, got " + r.level + ")");
    if (r.level !== null && r.level >= 1 && r.level <= 6 && prevValidLevel > 0 && r.level > prevValidLevel + 1) {
      r.issues.push("level skipped (jumps from h" + prevValidLevel + " to h" + r.level + ")");
    }
    if (r.level === 1 && h1Count > 1) r.issues.push("multiple h1 on page");
    if (r.level !== null && r.level >= 1 && r.level <= 6) prevValidLevel = r.level;
  });

  // Resolve element references for outline + click-to-scroll
  allResults.forEach(function (r) {
    var doc;
    if (r.isTop) doc = document;
    else if (r.iframeEl) { try { doc = r.iframeEl.contentDocument; } catch (e) { doc = null; } }
    if (!doc) return;
    try {
      var el = doc.querySelector(r.selector);
      if (el) {
        r._resolveEl = el;
        var color = r.issues.length ? "#b00020" : "#003876";
        var style = r.issues.length ? "dashed" : "solid";
        el.style.setProperty("outline", "2px " + style + " " + color, "important");
        el.style.setProperty("outline-offset", "1px", "important");
      }
    } catch (e) {}
  });

  // Build shadow UI
  var host = document.createElement("div");
  host.id = P + "host";
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "all:initial !important;position:absolute !important;top:0 !important;left:0 !important;width:0 !important;height:0 !important;margin:0 !important;padding:0 !important;border:0 !important;font:400 16px/1.4 ui-sans-serif,system-ui,sans-serif !important;color:#111 !important;pointer-events:none !important;z-index:2147483647 !important;";
  (document.body || document.documentElement).appendChild(host);
  var shadow = host.attachShadow({ mode: "closed" });

  var css =
    ":host{all:initial;font-family:ui-sans-serif,system-ui,sans-serif !important;}" +
    "*,*::before,*::after{box-sizing:border-box;font-family:ui-sans-serif,system-ui,sans-serif !important;font-style:normal !important;font-weight:400 !important;font-variant:normal !important;text-transform:none !important;letter-spacing:normal !important;text-decoration:none !important;color:#111;}" +
    /* badges */
    ".badge{position:absolute;background:#003876;color:#fff;font-size:16px;font-weight:600 !important;line-height:1.2;padding:4px 8px;border-radius:3px;pointer-events:none;max-width:380px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,.4);}" +
    ".badge.issue{background:#b00020;}" +
    ".badge.frame{background:#0a5d2e;}" +
    ".badge.frame.issue{background:#7a1518;}" +
    /* panel */
    ".panel{position:fixed;top:12px;right:12px;width:480px;max-height:85vh;display:flex;flex-direction:column;background:#fff;color:#111;border:1px solid #bbb;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.25);font-size:16px;line-height:1.4;pointer-events:auto;}" +
    ".panel header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#003876;color:#fff;border-radius:6px 6px 0 0;}" +
    ".panel header strong{font-size:18px;font-weight:600 !important;color:#fff;}" +
    ".panel .btns{display:flex;gap:8px;}" +
    ".panel button{background:transparent;border:1px solid #fff;color:#fff;padding:6px 12px;border-radius:3px;cursor:pointer;font-size:16px;font-weight:500;line-height:1.2;}" +
    ".panel button:hover{background:rgba(255,255,255,.18);}" +
    ".panel .summary{padding:10px 14px;border-bottom:1px solid #eee;background:#f5f7fa;font-size:16px;}" +
    ".panel .summary .issue{color:#b00020;font-weight:600 !important;}" +
    ".panel .summary .ok{color:#0a8043;font-weight:600 !important;}" +
    ".panel .summary .warn{color:#b45309;font-weight:600 !important;}" +
    ".panel ol{margin:0;padding:0;list-style:none;overflow:auto;flex:1 1 auto;}" +
    ".panel li{padding:8px 14px 8px 0;border-bottom:1px solid #eee;cursor:pointer;font-size:16px;display:flex;align-items:flex-start;gap:10px;}" +
    ".panel li:hover{background:#eef4ff;}" +
    ".panel li.frame-tag{border-left:3px solid #0a5d2e;}" +
    ".panel li .gutter{flex:0 0 auto;width:14px;color:#999;font-size:14px;text-align:right;}" +
    ".panel li .levelchip{flex:0 0 auto;display:inline-block;min-width:40px;text-align:center;padding:3px 8px;border-radius:3px;background:#003876;color:#fff !important;font-size:14px;font-weight:700 !important;line-height:1.2;}" +
    ".panel li .levelchip.aria{background:#0a5d2e;}" +
    ".panel li .levelchip.unknown{background:#b45309;}" +
    ".panel li .levelchip.outofrange{background:#b00020;}" +
    ".panel li .body{flex:1 1 auto;min-width:0;}" +
    ".panel li .meta{color:#555;font-size:14px;margin-bottom:2px;}" +
    ".panel li .frame-label{color:#0a5d2e;font-weight:600;}" +
    ".panel li .text{font-weight:600 !important;color:#111;font-size:16px;word-break:break-word;}" +
    ".panel li .text.empty{color:#b00020;font-style:italic;font-weight:600 !important;}" +
    ".panel li .issues{color:#b00020;font-size:14px;margin-top:3px;font-weight:600 !important;}" +
    ".panel li .src{color:#666;font-size:14px;font-style:italic;margin-top:2px;word-break:break-all;}" +
    ".panel code{font-family:ui-monospace,monospace !important;font-size:14px;background:rgba(0,0,0,.06);padding:1px 5px;border-radius:3px;}";

  var styleEl = document.createElement("style");
  styleEl.textContent = css;
  shadow.appendChild(styleEl);

  // Badges
  var badges = [];
  allResults.forEach(function (r) {
    if (!r.positioned) return;
    var badge = document.createElement("div");
    var cls = "badge";
    if (r.issues.length) cls += " issue";
    if (!r.isTop) cls += " frame";
    badge.className = cls;
    var levelLabel = r.level !== null ? "H" + r.level : "H?";
    var prefix = r.isTop ? "" : "[frame] ";
    var textPart = r.empty ? "(empty)" : (r.text.length > 50 ? r.text.slice(0, 50) + "…" : r.text);
    badge.textContent = "#" + r.index + " " + prefix + levelLabel + ": " + textPart;
    badge.style.top = (r.pageTop - 28) + "px";
    badge.style.left = r.pageLeft + "px";
    shadow.appendChild(badge);
    badges.push(badge);
    r.badge = badge;
  });

  // Markdown table
  function mdEsc(s) { return String(s).replace(/\|/g, "\\|").replace(/\n+/g, " "); }
  var md = "| # | Frame | Level | Tag | Heading | Issues | Selector |\n";
  md += "|---|-------|-------|-----|---------|--------|----------|\n";
  allResults.forEach(function (r) {
    var levelStr = r.level !== null ? ("H" + r.level + (r.levelSource === "aria-level" ? " *(aria)*" : "")) : "**?**";
    var text = r.empty ? "*(empty)*" : mdEsc(r.text);
    var issues = r.issues.length ? "⚠ " + mdEsc(r.issues.join("; ")) : "";
    var frameLabel = r.isTop ? "(top)" : mdEsc(r.frameLabel || r.frameUrl);
    md += "| " + r.index + " | " + frameLabel + " | " + levelStr + " | `" + r.tag + "` | " + text + " | " + issues + " | `" + mdEsc(r.selector) + "` |\n";
  });

  var issueCount = allResults.filter(function (r) { return r.issues.length; }).length;
  var frameCount = framesData.filter(function (f) { return !f.isTop && f.results && f.results.length; }).length;

  console.group("%c[a11yn headings] " + allResults.length + " headings (" + issueCount + " with issues, " + h1Count + " h1) — top doc + " + frameCount + " frame(s)",
    "color:#003876;font-weight:bold;font-size:13px");
  console.table(allResults.map(function (r) {
    return {
      "#": r.index,
      frame: r.isTop ? "(top)" : (r.frameLabel || r.frameUrl),
      level: r.level !== null ? "H" + r.level + (r.levelSource === "aria-level" ? " (aria)" : "") : "?",
      tag: r.tag,
      heading: r.empty ? "(empty)" : r.text,
      issues: r.issues.join("; ")
    };
  }));
  console.log("%cMarkdown table:", "font-weight:bold");
  console.log(md);
  console.groupEnd();

  // Panel
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }

  var panelEl = document.createElement("div");
  panelEl.className = "panel";

  var summary = "";
  if (allResults.length === 0) {
    summary += '<span class="warn">No headings found.</span>';
  } else if (issueCount === 0) {
    summary += '<span class="ok">All ' + allResults.length + ' heading' + (allResults.length === 1 ? "" : "s") + ' look structurally valid.</span>';
  } else {
    summary += '<span class="issue">' + issueCount + " of " + allResults.length + " heading" + (allResults.length === 1 ? "" : "s") + " have issues.</span>";
  }
  summary += '<div style="margin-top:6px;color:#555;font-size:14px">';
  summary += h1Count + ' h1' + (h1Count === 1 ? "" : "s") + " · top doc";
  if (frameCount) summary += " + " + frameCount + " frame" + (frameCount === 1 ? "" : "s");
  if (unmatchedFrames) summary += " · ⚠ " + unmatchedFrames + " unpositioned frame(s)";
  summary += '</div>';

  panelEl.innerHTML =
    "<header><strong>Headings (" + allResults.length + ")</strong>" +
    '<div class="btns"><button id="' + P + 'copy">Copy MD</button><button id="' + P + 'close">Close</button></div></header>' +
    '<div class="summary">' + summary + "</div>" +
    '<ol id="' + P + 'list"></ol>';

  var list = panelEl.querySelector("#" + P + "list");
  allResults.forEach(function (r) {
    var li = document.createElement("li");
    if (!r.isTop) li.classList.add("frame-tag");

    // Indent gutter based on level (use 18px per level; cap at level 6)
    var indentLevel = (r.level !== null && r.level >= 1 && r.level <= 6) ? r.level - 1 : 0;
    li.style.paddingLeft = (10 + indentLevel * 18) + "px";

    var chipClass = "levelchip";
    if (r.level === null) chipClass += " unknown";
    else if (r.level < 1 || r.level > 6) chipClass += " outofrange";
    else if (r.levelSource === "aria-level") chipClass += " aria";
    var chipText = r.level !== null ? "H" + r.level : "H?";

    var location = r.isTop ? "" : '<span class="frame-label">[' + esc(r.frameLabel || r.frameUrl) + ']</span> ';
    var levelExplain = "";
    if (r.levelSource === "aria-level") levelExplain = ' <span style="color:#0a5d2e">(via aria-level)</span>';
    else if (r.level === null) levelExplain = ' <span style="color:#b45309">(no aria-level)</span>';
    else if (r.level < 1 || r.level > 6) levelExplain = ' <span style="color:#b00020">(out of range)</span>';

    li.innerHTML =
      '<span class="gutter">' + r.index + "</span>" +
      '<span class="' + chipClass + '">' + esc(chipText) + "</span>" +
      '<div class="body">' +
        '<div class="meta">' + location + "<code>" + esc(r.tag) + "</code>" + levelExplain + "</div>" +
        '<div class="text' + (r.empty ? " empty" : "") + '">' + (r.empty ? "(empty heading)" : esc(r.text)) + "</div>" +
        (r.issues.length ? '<div class="issues">⚠ ' + esc(r.issues.join("; ")) + "</div>" : "") +
        '<div class="src">' + esc(r.selector) + "</div>" +
      "</div>";

    li.addEventListener("click", function () {
      try {
        if (r._resolveEl) {
          r._resolveEl.scrollIntoView({ behavior: "smooth", block: "center" });
          r._resolveEl.style.setProperty("box-shadow", "0 0 0 4px #ffeb3b", "important");
          setTimeout(function () { try { r._resolveEl.style.removeProperty("box-shadow"); } catch (e) {} }, 1400);
        } else if (r.iframeEl) {
          r.iframeEl.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        if (r.badge) {
          r.badge.style.setProperty("box-shadow", "0 0 0 4px #ffeb3b", "important");
          setTimeout(function () { try { r.badge.style.removeProperty("box-shadow"); } catch (e) {} }, 1400);
        }
      } catch (e) {}
    });
    list.appendChild(li);
  });
  shadow.appendChild(panelEl);

  panelEl.querySelector("#" + P + "close").addEventListener("click", function () { window[P + "cleanup"](); });
  panelEl.querySelector("#" + P + "copy").addEventListener("click", function (e) {
    var btn = e.currentTarget;
    var done = function (ok) { btn.textContent = ok ? "Copied!" : "Copy failed"; setTimeout(function () { btn.textContent = "Copy MD"; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(md).then(function () { done(true); }, function () { done(false); });
    } else {
      var ta = document.createElement("textarea"); ta.value = md; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(true); } catch (err) { done(false); } ta.remove();
    }
  });

  window[P + "active"] = checkId;
  window[P + "cleanup"] = function () {
    try { host.remove(); } catch (e) {}
    allResults.forEach(function (r) {
      if (r._resolveEl) {
        try {
          r._resolveEl.style.removeProperty("outline");
          r._resolveEl.style.removeProperty("outline-offset");
        } catch (e) {}
      }
    });
    delete window[P + "cleanup"];
    delete window[P + "active"];
    console.log("%c[a11yn] cleared.", "color:#003876");
  };
}
