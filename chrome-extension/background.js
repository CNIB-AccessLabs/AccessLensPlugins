/*
 * AccessibleName Inspector — background script.
 *
 * Multi-check accessibility inspector. The toolbar button opens popup.html;
 * the popup lets the user pick a check to run, or close the active one.
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
  names:     { label: "Accessible Names", scan: scanNames,     display: displayNames     },
  headings:  { label: "Headings",         scan: scanHeadings,  display: displayHeadings  },
  landmarks: { label: "Landmarks",        scan: scanLandmarks, display: displayLandmarks },
  images:    { label: "Images",           scan: scanImages,    display: displayImages    },
  links:     { label: "Link Text",        scan: scanLinks,     display: displayLinks     },
  aria:      { label: "ARIA Validation",  scan: scanAria,      display: displayAria      }
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

  // Make the panel draggable by its header. The user can move it off any
  // element they want to inspect. Buttons inside the header still receive
  // clicks normally — pointerdown on a button target is ignored.
  // Uses setPointerCapture so the drag survives the cursor passing over
  // iframes or other elements that would normally swallow mouse events.
  (function () {
    var header = panelEl.querySelector("header");
    if (!header) return;
    header.style.cursor = "move";
    header.style.userSelect = "none";
    header.style.touchAction = "none";
    var dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    header.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest("button")) return;
      var rect = panelEl.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
      startX = e.clientX; startY = e.clientY;
      dragging = true;
      panelEl.style.left = startLeft + "px";
      panelEl.style.top = startTop + "px";
      panelEl.style.right = "auto";
      try { header.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    header.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var newLeft = startLeft + (e.clientX - startX);
      var newTop = startTop + (e.clientY - startY);
      var minLeft = 40 - panelEl.offsetWidth;
      var maxLeft = window.innerWidth - 40;
      var maxTop = window.innerHeight - 40;
      newLeft = Math.max(minLeft, Math.min(maxLeft, newLeft));
      newTop = Math.max(0, Math.min(maxTop, newTop));
      panelEl.style.left = newLeft + "px";
      panelEl.style.top = newTop + "px";
    });
    header.addEventListener("pointerup", function (e) {
      dragging = false;
      try { header.releasePointerCapture(e.pointerId); } catch (err) {}
    });
    header.addEventListener("pointercancel", function () { dragging = false; });
  })();

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

  // Issue analysis. Issues that involve OTHER elements (multiple h1, skipped
  // level) carry their related element indices so the panel and Markdown
  // output can reference all the involved elements, not just the current one.
  var h1Indices = allResults.filter(function (r) { return r.level === 1; }).map(function (r) { return r.index; });
  var prevValidLevel = 0;
  var prevValidIndex = null;
  allResults.forEach(function (r) {
    r.issues = [];
    if (r.empty) r.issues.push({ text: "empty heading", related: [] });
    if (!r.isNative && r.level === null) r.issues.push({ text: 'role="heading" with no aria-level', related: [] });
    if (r.level !== null && (r.level < 1 || r.level > 6)) {
      r.issues.push({ text: "aria-level out of range (expected 1–6, got " + r.level + ")", related: [] });
    }
    if (r.level !== null && r.level >= 1 && r.level <= 6 && prevValidLevel > 0 && r.level > prevValidLevel + 1) {
      r.issues.push({
        text: "level skipped (jumps from h" + prevValidLevel + " at #" + prevValidIndex + " to h" + r.level + ")",
        related: [prevValidIndex]
      });
    }
    if (r.level === 1 && h1Indices.length > 1) {
      r.issues.push({
        text: "multiple h1 on page",
        related: h1Indices.filter(function (i) { return i !== r.index; })
      });
    }
    if (r.level !== null && r.level >= 1 && r.level <= 6) {
      prevValidLevel = r.level;
      prevValidIndex = r.index;
    }
  });

  // Helpers to render an issue with references to its related elements.
  // Panel uses compact "#3, #7" form; Markdown adds the selector for each.
  function fmtIssuePanel(issue) {
    if (!issue.related || !issue.related.length) return issue.text;
    return issue.text + " (also: " + issue.related.map(function (i) { return "#" + i; }).join(", ") + ")";
  }
  function fmtIssueMd(issue) {
    if (!issue.related || !issue.related.length) return mdEsc(issue.text);
    var refs = issue.related.map(function (i) {
      var other = allResults[i - 1];
      return "#" + i + " `" + mdEsc(other ? other.selector : "") + "`";
    });
    return mdEsc(issue.text) + " (also: " + refs.join(", ") + ")";
  }

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
    var issues = r.issues.length ? "⚠ " + r.issues.map(fmtIssueMd).join("; ") : "";
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
      issues: r.issues.map(fmtIssuePanel).join("; ")
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
        (r.issues.length ? '<div class="issues">⚠ ' + esc(r.issues.map(fmtIssuePanel).join("; ")) + "</div>" : "") +
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

  // Make the panel draggable by its header. The user can move it off any
  // element they want to inspect. Buttons inside the header still receive
  // clicks normally — pointerdown on a button target is ignored.
  // Uses setPointerCapture so the drag survives the cursor passing over
  // iframes or other elements that would normally swallow mouse events.
  (function () {
    var header = panelEl.querySelector("header");
    if (!header) return;
    header.style.cursor = "move";
    header.style.userSelect = "none";
    header.style.touchAction = "none";
    var dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    header.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest("button")) return;
      var rect = panelEl.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
      startX = e.clientX; startY = e.clientY;
      dragging = true;
      panelEl.style.left = startLeft + "px";
      panelEl.style.top = startTop + "px";
      panelEl.style.right = "auto";
      try { header.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    header.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var newLeft = startLeft + (e.clientX - startX);
      var newTop = startTop + (e.clientY - startY);
      var minLeft = 40 - panelEl.offsetWidth;
      var maxLeft = window.innerWidth - 40;
      var maxTop = window.innerHeight - 40;
      newLeft = Math.max(minLeft, Math.min(maxLeft, newLeft));
      newTop = Math.max(0, Math.min(maxTop, newTop));
      panelEl.style.left = newLeft + "px";
      panelEl.style.top = newTop + "px";
    });
    header.addEventListener("pointerup", function (e) {
      dragging = false;
      try { header.releasePointerCapture(e.pointerId); } catch (err) {}
    });
    header.addEventListener("pointercancel", function () { dragging = false; });
  })();

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
 * CHECK: LANDMARKS — landmark / page-region inspector
 *
 * Reports both implicit (HTML5 sectioning) landmarks and explicit ARIA
 * role landmarks, applying the correct nesting rules:
 *
 *   <header>  → banner          if NOT nested inside article/aside/main/nav/section
 *   <footer>  → contentinfo     if NOT nested inside article/aside/main/nav/section
 *   <nav>     → navigation      always
 *   <main>    → main            always
 *   <aside>   → complementary   always
 *   <search>  → search          always (HTML 2024+ element)
 *   <section> → region          only when it has an accessible name
 *   <form>    → form            only when it has an accessible name
 *   [role=…]  → that role       any of the eight landmark roles
 *
 * Issues flagged:
 *   - Multiple <main> on a page
 *   - role="region" without an accessible name (region requires a name)
 *   - Multiple landmarks of the same role without distinct names
 *     (auditors can't tell them apart with a screen reader)
 *
 * Accessible name uses only aria-labelledby and aria-label. Some AT use
 * the first heading inside a landmark as an implicit label, but this is
 * inconsistent and out of scope for v1.
 * ==================================================================== */

function scanLandmarks() {
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

    function landmarkAccName(el) {
      var aLab = el.getAttribute("aria-labelledby");
      if (aLab) {
        var doc = el.ownerDocument || document;
        var root = el.getRootNode ? el.getRootNode() : doc;
        var parts = aLab.split(/\s+/).map(function (id) {
          var ref = (root.getElementById && root.getElementById(id)) || doc.getElementById(id);
          return ref ? txt(ref.textContent) : "";
        }).filter(Boolean);
        if (parts.length) return { name: parts.join(" "), src: "aria-labelledby" };
      }
      var aL = el.getAttribute("aria-label");
      if (aL && aL.trim()) return { name: aL.trim(), src: "aria-label" };
      return { name: "", src: "" };
    }

    function isInsideSectioningContent(el) {
      var cur = el.parentElement;
      while (cur) {
        var t = cur.tagName.toLowerCase();
        if (t === "article" || t === "aside" || t === "main" || t === "nav" || t === "section") return true;
        cur = cur.parentElement;
      }
      return false;
    }

    var LANDMARK_ROLES = /^(banner|navigation|main|complementary|contentinfo|region|search|form)$/;

    function effectiveRole(el, accname) {
      var explicit = el.getAttribute("role");
      if (explicit) {
        // Pick the first landmark role from the role attribute (space-separated).
        var roles = explicit.split(/\s+/);
        for (var i = 0; i < roles.length; i++) {
          if (LANDMARK_ROLES.test(roles[i])) {
            return { role: roles[i], explicit: true, note: null };
          }
        }
      }
      var tag = el.tagName.toLowerCase();
      if (tag === "nav")    return { role: "navigation",    explicit: false, note: null };
      if (tag === "main")   return { role: "main",          explicit: false, note: null };
      if (tag === "aside")  return { role: "complementary", explicit: false, note: null };
      if (tag === "search") return { role: "search",        explicit: false, note: null };
      if (tag === "header") {
        if (isInsideSectioningContent(el)) {
          return { role: null, explicit: false, note: "<header> inside sectioning content has no landmark role" };
        }
        return { role: "banner", explicit: false, note: null };
      }
      if (tag === "footer") {
        if (isInsideSectioningContent(el)) {
          return { role: null, explicit: false, note: "<footer> inside sectioning content has no landmark role" };
        }
        return { role: "contentinfo", explicit: false, note: null };
      }
      if (tag === "section") {
        if (accname.name) return { role: "region", explicit: false, note: null };
        return { role: null, explicit: false, note: "<section> without accessible name is not a landmark" };
      }
      if (tag === "form") {
        if (accname.name) return { role: "form", explicit: false, note: null };
        return { role: null, explicit: false, note: "<form> without accessible name is not a landmark" };
      }
      return { role: null, explicit: false, note: null };
    }

    var SELECTOR = [
      "header", "nav", "main", "aside", "footer", "section", "form", "search",
      '[role~="banner"]', '[role~="navigation"]', '[role~="main"]',
      '[role~="complementary"]', '[role~="contentinfo"]', '[role~="region"]',
      '[role~="search"]', '[role~="form"]'
    ].join(",");

    var results = [];
    var seenEls = new Set();
    var shadowRoots = 0;
    var skipped = [];

    function walk(root) {
      var matches;
      try { matches = root.querySelectorAll(SELECTOR); } catch (e) { return; }
      Array.prototype.forEach.call(matches, function (el) {
        if (seenEls.has(el)) return;
        seenEls.add(el);
        if (isHidden(el)) return;
        var r;
        try { r = el.getBoundingClientRect(); } catch (e) { return; }
        var accname = landmarkAccName(el);
        var role = effectiveRole(el, accname);
        if (role.role === null) {
          if (role.note) {
            skipped.push({
              tag: el.tagName.toLowerCase(),
              note: role.note,
              selector: uniqueSelector(el)
            });
          }
          return;
        }
        results.push({
          tag: el.tagName.toLowerCase(),
          role: role.role,
          roleExplicit: role.explicit,
          name: accname.name,
          nameSrc: accname.src,
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

    // Sort by visual order within the frame
    results.sort(function (a, b) {
      if (a.rect.top !== b.rect.top) return a.rect.top - b.rect.top;
      return a.rect.left - b.rect.left;
    });

    return {
      url: window.location.href,
      isTop: window === window.top,
      results: results,
      shadowRoots: shadowRoots,
      skipped: skipped
    };
  } catch (e) {
    return { url: window.location.href, isTop: window === window.top, results: [], error: String(e && e.message || e) };
  }
}

function displayLandmarks(framesData, checkId) {
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
  var allSkipped = [];
  var unmatchedFrames = 0;
  var frameLabelByUrl = new Map();
  framesData.forEach(function (frame) {
    if (!frame || frame.error) return;
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
    (frame.results || []).forEach(function (r) {
      allResults.push({
        tag: r.tag, role: r.role, roleExplicit: r.roleExplicit,
        name: r.name, nameSrc: r.nameSrc,
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
    (frame.skipped || []).forEach(function (s) { allSkipped.push(s); });
  });
  allResults.forEach(function (r, i) { r.index = i + 1; });

  // Issues. Issues that involve other elements carry their related indices so
  // the panel and Markdown output can reference every involved element, not
  // just the current one.
  var byRole = {};
  allResults.forEach(function (r) {
    if (!byRole[r.role]) byRole[r.role] = [];
    byRole[r.role].push(r);
  });

  allResults.forEach(function (r) {
    r.issues = [];
    if (r.role === "main" && byRole["main"].length > 1) {
      r.issues.push({
        text: "multiple main landmarks on page (only one expected)",
        related: byRole["main"].filter(function (o) { return o.index !== r.index; }).map(function (o) { return o.index; })
      });
    }
    if (r.role === "region" && !r.name) {
      r.issues.push({ text: 'role="region" without an accessible name', related: [] });
    }
    if (byRole[r.role].length > 1 && !r.name) {
      // Per WCAG 1.3.1 and ARIA Authoring Practices: when multiple landmarks
      // share a role, EACH needs a distinguishing accessible name. So we flag
      // every unnamed one in the cluster, regardless of whether the others are
      // named or not. `related` references every other landmark of this role
      // so the auditor sees the whole cluster.
      r.issues.push({
        text: "no accessible name, but there are " + byRole[r.role].length + " " + r.role + " landmarks on the page — each needs a distinguishing label",
        related: byRole[r.role].filter(function (o) { return o.index !== r.index; }).map(function (o) { return o.index; })
      });
    }
    if (byRole[r.role].length > 1 && r.name) {
      var sameName = byRole[r.role].filter(function (o) { return o.name === r.name && o.index !== r.index; });
      if (sameName.length) {
        r.issues.push({
          text: "multiple " + r.role + " landmarks share the same name '" + r.name + "'",
          related: sameName.map(function (o) { return o.index; })
        });
      }
    }
  });

  // Helpers to render an issue with references to its related elements.
  // Panel uses compact "#3, #7" form; Markdown adds the selector for each.
  function fmtIssuePanel(issue) {
    if (!issue.related || !issue.related.length) return issue.text;
    return issue.text + " (also: " + issue.related.map(function (i) { return "#" + i; }).join(", ") + ")";
  }
  function fmtIssueMd(issue) {
    if (!issue.related || !issue.related.length) return mdEsc(issue.text);
    var refs = issue.related.map(function (i) {
      var other = allResults[i - 1];
      return "#" + i + " `" + mdEsc(other ? other.selector : "") + "`";
    });
    return mdEsc(issue.text) + " (also: " + refs.join(", ") + ")";
  }

  // Try to resolve element references for outline + click-to-scroll
  allResults.forEach(function (r) {
    var doc;
    if (r.isTop) doc = document;
    else if (r.iframeEl) { try { doc = r.iframeEl.contentDocument; } catch (e) { doc = null; } }
    if (!doc) return;
    try {
      var el = doc.querySelector(r.selector);
      if (el) {
        r._resolveEl = el;
        var hasIssue = r.issues.length > 0;
        var color = hasIssue ? "#b00020" : "#003876";
        var style = hasIssue ? "dashed" : "solid";
        el.style.setProperty("outline", "2px " + style + " " + color, "important");
        el.style.setProperty("outline-offset", "1px", "important");
      }
    } catch (e) {}
  });

  // Shadow UI
  var host = document.createElement("div");
  host.id = P + "host";
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "all:initial !important;position:absolute !important;top:0 !important;left:0 !important;width:0 !important;height:0 !important;margin:0 !important;padding:0 !important;border:0 !important;font:400 16px/1.4 ui-sans-serif,system-ui,sans-serif !important;color:#111 !important;pointer-events:none !important;z-index:2147483647 !important;";
  (document.body || document.documentElement).appendChild(host);
  var shadow = host.attachShadow({ mode: "closed" });

  // Role-specific chip colours
  var ROLE_COLORS = {
    banner:        "#37474f",
    navigation:    "#003876",
    main:          "#1b5e20",
    complementary: "#6a1b9a",
    contentinfo:   "#5d4037",
    region:        "#ef6c00",
    search:        "#00695c",
    form:          "#0277bd"
  };

  var css =
    ":host{all:initial;font-family:ui-sans-serif,system-ui,sans-serif !important;}" +
    "*,*::before,*::after{box-sizing:border-box;font-family:ui-sans-serif,system-ui,sans-serif !important;font-style:normal !important;font-weight:400 !important;font-variant:normal !important;text-transform:none !important;letter-spacing:normal !important;text-decoration:none !important;color:#111;}" +
    ".badge{position:absolute;background:#003876;color:#fff;font-size:16px;font-weight:600 !important;line-height:1.2;padding:4px 8px;border-radius:3px;pointer-events:none;max-width:380px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,.4);}" +
    ".badge.issue{background:#b00020;}" +
    ".badge.frame{filter:saturate(0.7) brightness(0.9);}" +
    ".panel{position:fixed;top:12px;right:12px;width:500px;max-height:85vh;display:flex;flex-direction:column;background:#fff;color:#111;border:1px solid #bbb;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.25);font-size:16px;line-height:1.4;pointer-events:auto;}" +
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
    ".panel li{padding:10px 14px;border-bottom:1px solid #eee;cursor:pointer;font-size:16px;display:flex;align-items:flex-start;gap:10px;}" +
    ".panel li:hover{background:#eef4ff;}" +
    ".panel li .gutter{flex:0 0 auto;width:18px;color:#999;font-size:14px;text-align:right;}" +
    ".panel li .rolechip{flex:0 0 auto;display:inline-block;min-width:100px;text-align:center;padding:4px 10px;border-radius:3px;color:#fff !important;font-size:14px;font-weight:700 !important;line-height:1.2;}" +
    ".panel li .body{flex:1 1 auto;min-width:0;}" +
    ".panel li .meta{color:#555;font-size:14px;margin-bottom:2px;}" +
    ".panel li .frame-label{color:#0a5d2e;font-weight:600;}" +
    ".panel li .name{font-weight:600 !important;color:#111;font-size:16px;word-break:break-word;}" +
    ".panel li .name.unnamed{color:#666;font-style:italic;font-weight:400 !important;}" +
    ".panel li .issues{color:#b00020;font-size:14px;margin-top:4px;font-weight:600 !important;}" +
    ".panel li .src{color:#666;font-size:14px;font-style:italic;margin-top:2px;word-break:break-all;}" +
    ".panel .skipped{padding:10px 14px;border-top:1px solid #eee;background:#fafafa;font-size:14px;color:#555;}" +
    ".panel .skipped summary{cursor:pointer;font-weight:600 !important;}" +
    ".panel .skipped ul{margin:6px 0 0 0;padding-left:18px;}" +
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
    var color = ROLE_COLORS[r.role] || "#003876";
    badge.style.background = r.issues.length ? "#b00020" : color;
    var prefix = r.isTop ? "" : "[frame] ";
    var nameStr = r.name ? r.name : "(no name)";
    badge.textContent = "#" + r.index + " " + prefix + r.role + ": " + nameStr;
    badge.style.top = (r.pageTop - 28) + "px";
    badge.style.left = r.pageLeft + "px";
    shadow.appendChild(badge);
    badges.push(badge);
    r.badge = badge;
  });

  // Markdown
  function mdEsc(s) { return String(s).replace(/\|/g, "\\|").replace(/\n+/g, " "); }
  var md = "| # | Frame | Role | Tag | Accessible Name | Source | Issues | Selector |\n";
  md += "|---|-------|------|-----|-----------------|--------|--------|----------|\n";
  allResults.forEach(function (r) {
    var roleStr = r.role + (r.roleExplicit ? " (explicit)" : "");
    var name = r.name ? mdEsc(r.name) : "*(no name)*";
    var issues = r.issues.length ? "⚠ " + r.issues.map(fmtIssueMd).join("; ") : "";
    var frameLabel = r.isTop ? "(top)" : mdEsc(r.frameLabel || r.frameUrl);
    md += "| " + r.index + " | " + frameLabel + " | " + roleStr + " | `" + r.tag + "` | " + name + " | " + (r.nameSrc || "") + " | " + issues + " | `" + mdEsc(r.selector) + "` |\n";
  });

  var issueCount = allResults.filter(function (r) { return r.issues.length; }).length;
  var frameCount = framesData.filter(function (f) { return !f.isTop && f.results && f.results.length; }).length;

  console.group("%c[a11yn landmarks] " + allResults.length + " landmarks (" + issueCount + " with issues) — top doc + " + frameCount + " frame(s)",
    "color:#003876;font-weight:bold;font-size:13px");
  console.table(allResults.map(function (r) {
    return {
      "#": r.index,
      frame: r.isTop ? "(top)" : (r.frameLabel || r.frameUrl),
      role: r.role + (r.roleExplicit ? " (explicit)" : ""),
      tag: r.tag,
      name: r.name || "(no name)",
      issues: r.issues.map(fmtIssuePanel).join("; ")
    };
  }));
  if (allSkipped.length) {
    console.log("%cCandidates that didn't qualify as landmarks (" + allSkipped.length + "):", "font-weight:bold;color:#555");
    console.table(allSkipped);
  }
  console.log("%cMarkdown table:", "font-weight:bold");
  console.log(md);
  console.groupEnd();

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }

  var panelEl = document.createElement("div");
  panelEl.className = "panel";

  var summary = "";
  if (allResults.length === 0) {
    summary += '<span class="warn">No landmarks found on this page.</span>';
  } else if (issueCount === 0) {
    summary += '<span class="ok">All ' + allResults.length + ' landmark' + (allResults.length === 1 ? "" : "s") + ' look structurally valid.</span>';
  } else {
    summary += '<span class="issue">' + issueCount + " of " + allResults.length + " landmark" + (allResults.length === 1 ? "" : "s") + " have issues.</span>";
  }
  // Role inventory
  var roleSummary = Object.keys(byRole).sort().map(function (role) {
    var n = byRole[role].length;
    return n + " " + role + (n === 1 ? "" : "s");
  }).join(", ");
  summary += '<div style="margin-top:6px;color:#555;font-size:14px">';
  if (roleSummary) summary += roleSummary + " · ";
  summary += "top doc";
  if (frameCount) summary += " + " + frameCount + " frame" + (frameCount === 1 ? "" : "s");
  if (unmatchedFrames) summary += " · ⚠ " + unmatchedFrames + " unpositioned frame(s)";
  if (allSkipped.length) summary += " · " + allSkipped.length + " non-landmark candidate(s)";
  summary += '</div>';

  panelEl.innerHTML =
    "<header><strong>Landmarks (" + allResults.length + ")</strong>" +
    '<div class="btns"><button id="' + P + 'copy">Copy MD</button><button id="' + P + 'close">Close</button></div></header>' +
    '<div class="summary">' + summary + "</div>" +
    '<ol id="' + P + 'list"></ol>' +
    (allSkipped.length
      ? '<details class="skipped"><summary>Non-landmark candidates (' + allSkipped.length + ')</summary><ul>' +
          allSkipped.map(function (s) {
            return "<li><code>&lt;" + esc(s.tag) + "&gt;</code> — " + esc(s.note) + " <span style=\"color:#999\">(" + esc(s.selector) + ")</span></li>";
          }).join("") +
        '</ul></details>'
      : "");

  var list = panelEl.querySelector("#" + P + "list");
  allResults.forEach(function (r) {
    var li = document.createElement("li");
    var chipColor = ROLE_COLORS[r.role] || "#003876";
    var location = r.isTop ? "" : '<span class="frame-label">[' + esc(r.frameLabel || r.frameUrl) + ']</span> ';
    var explicitNote = r.roleExplicit ? ' <span style="color:#555">(role="' + esc(r.role) + '")</span>' : "";
    li.innerHTML =
      '<span class="gutter">' + r.index + "</span>" +
      '<span class="rolechip" style="background:' + chipColor + '">' + esc(r.role) + "</span>" +
      '<div class="body">' +
        '<div class="meta">' + location + "<code>&lt;" + esc(r.tag) + "&gt;</code>" + explicitNote + (r.nameSrc ? ' <span style="color:#999">· via ' + esc(r.nameSrc) + "</span>" : "") + "</div>" +
        '<div class="name' + (r.name ? "" : " unnamed") + '">' + (r.name ? esc(r.name) : "(no accessible name)") + "</div>" +
        (r.issues.length ? '<div class="issues">⚠ ' + esc(r.issues.map(fmtIssuePanel).join("; ")) + "</div>" : "") +
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

  // Make the panel draggable by its header. The user can move it off any
  // element they want to inspect. Buttons inside the header still receive
  // clicks normally — pointerdown on a button target is ignored.
  // Uses setPointerCapture so the drag survives the cursor passing over
  // iframes or other elements that would normally swallow mouse events.
  (function () {
    var header = panelEl.querySelector("header");
    if (!header) return;
    header.style.cursor = "move";
    header.style.userSelect = "none";
    header.style.touchAction = "none";
    var dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    header.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest("button")) return;
      var rect = panelEl.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
      startX = e.clientX; startY = e.clientY;
      dragging = true;
      panelEl.style.left = startLeft + "px";
      panelEl.style.top = startTop + "px";
      panelEl.style.right = "auto";
      try { header.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    header.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var newLeft = startLeft + (e.clientX - startX);
      var newTop = startTop + (e.clientY - startY);
      var minLeft = 40 - panelEl.offsetWidth;
      var maxLeft = window.innerWidth - 40;
      var maxTop = window.innerHeight - 40;
      newLeft = Math.max(minLeft, Math.min(maxLeft, newLeft));
      newTop = Math.max(0, Math.min(maxTop, newTop));
      panelEl.style.left = newLeft + "px";
      panelEl.style.top = newTop + "px";
    });
    header.addEventListener("pointerup", function (e) {
      dragging = false;
      try { header.releasePointerCapture(e.pointerId); } catch (err) {}
    });
    header.addEventListener("pointercancel", function () { dragging = false; });
  })();

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
 * CHECK: IMAGES — image alt-text inspector
 *
 * Inspects every image-like element on the page:
 *   <img>, <input type="image">, <area>, [role="img"]
 *   <svg> when it has role="img" or aria-label/aria-labelledby
 *     (untyped <svg> without those is opaque — we don't flag it here
 *      because it could be a decorative shape or a meaningful graphic)
 *
 * Each image is classified as ONE of:
 *
 *   LABELED      good — has an accessible name from aria-labelledby,
 *                aria-label, alt, or title
 *   DECORATIVE   alt="" (explicit empty), role="presentation"/"none",
 *                or aria-hidden="true" — intentionally hidden from AT
 *   MISSING      no alt attribute at all and no aria-* labeling — AT
 *                may announce the src URL or skip the image
 *   SUSPICIOUS   has alt but the text looks wrong:
 *                  - looks like a filename (image.jpg, IMG_1234)
 *                  - generic single word (image, photo, icon, logo)
 *                  - starts with "image of …", "picture of …" (redundant)
 *
 * The panel uses chip colours to distinguish the four states at a glance.
 * ==================================================================== */

function scanImages() {
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

    function imageAccName(el) {
      var aLab = el.getAttribute("aria-labelledby");
      if (aLab) {
        var doc = el.ownerDocument || document;
        var root = el.getRootNode ? el.getRootNode() : doc;
        var parts = aLab.split(/\s+/).map(function (id) {
          var ref = (root.getElementById && root.getElementById(id)) || doc.getElementById(id);
          return ref ? txt(ref.textContent) : "";
        }).filter(Boolean);
        if (parts.length) return { name: parts.join(" "), src: "aria-labelledby" };
      }
      var aL = el.getAttribute("aria-label");
      if (aL && aL.trim()) return { name: aL.trim(), src: "aria-label" };
      // alt attribute — explicit empty alt is decorative, handled separately
      var alt = el.getAttribute("alt");
      if (alt !== null && alt !== "") return { name: alt, src: "alt" };
      // <svg> can have a <title> child as its accessible name
      if (el.tagName && el.tagName.toLowerCase() === "svg") {
        var firstTitle = el.querySelector(":scope > title");
        if (firstTitle) {
          var t = txt(firstTitle.textContent);
          if (t) return { name: t, src: "<title> child" };
        }
      }
      var ti = el.getAttribute("title");
      if (ti && ti.trim()) return { name: ti.trim(), src: "title" };
      return { name: "", src: "" };
    }

    function isDecorative(el) {
      if (el.getAttribute("aria-hidden") === "true") return true;
      var role = el.getAttribute("role");
      if (role === "presentation" || role === "none") return true;
      var alt = el.getAttribute("alt");
      if (alt === "") return true; // explicit empty alt
      return false;
    }

    // Returns the kind of "suspicious" warning, or null if the alt looks fine.
    function checkAltSuspicious(altText) {
      if (!altText) return null;
      var t = altText.trim();
      if (!t) return null;
      if (/\.(jpe?g|png|gif|webp|svg|bmp|tiff?|avif|heic)$/i.test(t)) {
        return "alt text looks like a filename";
      }
      if (/^(IMG[_-]|DSC[_FN-]|P\d{7,8}|GOPR|PXL_)/i.test(t)) {
        return "alt text looks like a camera filename";
      }
      var lower = t.toLowerCase();
      var generic = ["image", "picture", "photo", "graphic", "icon", "img", "logo", "pic"];
      if (generic.indexOf(lower) !== -1) {
        return 'alt text is generic ("' + t + '") — describe what the image conveys';
      }
      if (/^(image|picture|photo|graphic) of /i.test(t)) {
        return 'alt text starts with redundant phrase ("' + t.split(/ /).slice(0, 2).join(" ") + ' …") — AT already announces "image"';
      }
      return null;
    }

    var SELECTOR = [
      "img",
      'input[type="image"]',
      "area",
      '[role="img"]',
      'svg[aria-label]', 'svg[aria-labelledby]'
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
        if (isHidden(el)) return;
        var r;
        try { r = el.getBoundingClientRect(); } catch (e) { return; }
        // Skip 0x0 — usually invisible tracking pixels; we still report explicit
        // role="img" elements with 0 dimensions because those are likely
        // CSS-styled icons.
        var tag = el.tagName.toLowerCase();
        var role = el.getAttribute("role");
        if (r.width === 0 && r.height === 0 && role !== "img") return;

        var hasAltAttribute = el.hasAttribute("alt");
        var rawAlt = el.getAttribute("alt");
        var an = imageAccName(el);
        var decorative = isDecorative(el);
        var suspicious = !decorative && rawAlt && rawAlt !== "" ? checkAltSuspicious(rawAlt) : null;

        var srcInfo = "";
        if (tag === "img") srcInfo = el.getAttribute("src") || "";
        else if (tag === "input") srcInfo = el.getAttribute("src") || "";
        else if (tag === "area") srcInfo = el.getAttribute("href") || "";
        else if (tag === "svg") srcInfo = "(inline svg)";
        else if (role === "img") srcInfo = "(role=img on " + tag + ")";

        // Classification
        var status;
        if (decorative) status = "decorative";
        else if (suspicious) status = "suspicious";
        else if (!an.name && (tag === "img" || tag === "input" || tag === "area" || role === "img" || tag === "svg")) status = "missing";
        else status = "labeled";

        // For img elements specifically, "missing" requires NO alt attribute.
        // alt="" already handled as decorative; alt="X" gives a name. The
        // "missing" case is when alt is entirely absent OR present but empty
        // AND we couldn't get a name from aria.
        if (tag === "img" && hasAltAttribute && !decorative && !an.name && !suspicious) {
          // alt is present but produced empty name through accName logic — odd
          // edge case (shouldn't normally happen); treat as labeled empty.
          status = "decorative";
        }

        results.push({
          tag: tag,
          role: role || null,
          status: status,
          name: an.name,
          nameSrc: an.src,
          rawAlt: rawAlt,
          hasAltAttribute: hasAltAttribute,
          decorative: decorative,
          suspicious: suspicious,
          src: srcInfo,
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

    results.sort(function (a, b) {
      if (a.rect.top !== b.rect.top) return a.rect.top - b.rect.top;
      return a.rect.left - b.rect.left;
    });

    return { url: window.location.href, isTop: window === window.top, results: results, shadowRoots: shadowRoots };
  } catch (e) {
    return { url: window.location.href, isTop: window === window.top, results: [], error: String(e && e.message || e) };
  }
}

function displayImages(framesData, checkId) {
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
        tag: r.tag, role: r.role, status: r.status,
        name: r.name, nameSrc: r.nameSrc,
        rawAlt: r.rawAlt, hasAltAttribute: r.hasAltAttribute,
        decorative: r.decorative, suspicious: r.suspicious,
        src: r.src,
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

  // Compute issues per image based on status
  allResults.forEach(function (r) {
    r.issues = [];
    if (r.status === "missing") {
      if (r.tag === "img" && !r.hasAltAttribute) {
        r.issues.push({ text: "no alt attribute (and no aria-* label) — screen readers may announce the src URL", related: [] });
      } else if (r.tag === "input") {
        r.issues.push({ text: "<input type=\"image\"> has no accessible name", related: [] });
      } else if (r.tag === "area") {
        r.issues.push({ text: "<area> has no accessible name", related: [] });
      } else if (r.role === "img") {
        r.issues.push({ text: "[role=\"img\"] element has no accessible name", related: [] });
      } else if (r.tag === "svg") {
        r.issues.push({ text: "<svg> with role=\"img\" or aria-* labeling has no accessible name", related: [] });
      } else {
        r.issues.push({ text: "no accessible name", related: [] });
      }
    } else if (r.status === "suspicious") {
      r.issues.push({ text: r.suspicious, related: [] });
    }
  });

  function fmtIssuePanel(issue) {
    if (!issue.related || !issue.related.length) return issue.text;
    return issue.text + " (also: " + issue.related.map(function (i) { return "#" + i; }).join(", ") + ")";
  }
  function fmtIssueMd(issue) {
    if (!issue.related || !issue.related.length) return mdEsc(issue.text);
    var refs = issue.related.map(function (i) {
      var other = allResults[i - 1];
      return "#" + i + " `" + mdEsc(other ? other.selector : "") + "`";
    });
    return mdEsc(issue.text) + " (also: " + refs.join(", ") + ")";
  }

  // Resolve element refs for outline + click-to-scroll
  allResults.forEach(function (r) {
    var doc;
    if (r.isTop) doc = document;
    else if (r.iframeEl) { try { doc = r.iframeEl.contentDocument; } catch (e) { doc = null; } }
    if (!doc) return;
    try {
      var el = doc.querySelector(r.selector);
      if (el) {
        r._resolveEl = el;
        var color, style;
        if (r.status === "missing") { color = "#b00020"; style = "dashed"; }
        else if (r.status === "suspicious") { color = "#b45309"; style = "dashed"; }
        else if (r.status === "decorative") { color = "#999"; style = "dotted"; }
        else { color = "#003876"; style = "solid"; }
        el.style.setProperty("outline", "2px " + style + " " + color, "important");
        el.style.setProperty("outline-offset", "1px", "important");
      }
    } catch (e) {}
  });

  // Shadow UI host
  var host = document.createElement("div");
  host.id = P + "host";
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "all:initial !important;position:absolute !important;top:0 !important;left:0 !important;width:0 !important;height:0 !important;margin:0 !important;padding:0 !important;border:0 !important;font:400 16px/1.4 ui-sans-serif,system-ui,sans-serif !important;color:#111 !important;pointer-events:none !important;z-index:2147483647 !important;";
  (document.body || document.documentElement).appendChild(host);
  var shadow = host.attachShadow({ mode: "closed" });

  var STATUS_COLORS = {
    labeled:    "#003876",
    decorative: "#666666",
    missing:    "#b00020",
    suspicious: "#b45309"
  };
  var STATUS_LABELS = {
    labeled:    "labeled",
    decorative: "decorative",
    missing:    "MISSING",
    suspicious: "suspicious"
  };

  var css =
    ":host{all:initial;font-family:ui-sans-serif,system-ui,sans-serif !important;}" +
    "*,*::before,*::after{box-sizing:border-box;font-family:ui-sans-serif,system-ui,sans-serif !important;font-style:normal !important;font-weight:400 !important;font-variant:normal !important;text-transform:none !important;letter-spacing:normal !important;text-decoration:none !important;color:#111;}" +
    ".badge{position:absolute;background:#003876;color:#fff;font-size:16px;font-weight:600 !important;line-height:1.2;padding:4px 8px;border-radius:3px;pointer-events:none;max-width:380px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,.4);}" +
    ".badge.frame{filter:saturate(0.7) brightness(0.9);}" +
    ".panel{position:fixed;top:12px;right:12px;width:520px;max-height:85vh;display:flex;flex-direction:column;background:#fff;color:#111;border:1px solid #bbb;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.25);font-size:16px;line-height:1.4;pointer-events:auto;}" +
    ".panel header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#003876;color:#fff;border-radius:6px 6px 0 0;}" +
    ".panel header strong{font-size:18px;font-weight:600 !important;color:#fff;}" +
    ".panel .btns{display:flex;gap:8px;}" +
    ".panel button{background:transparent;border:1px solid #fff;color:#fff;padding:6px 12px;border-radius:3px;cursor:pointer;font-size:16px;font-weight:500;line-height:1.2;}" +
    ".panel button:hover{background:rgba(255,255,255,.18);}" +
    ".panel .summary{padding:10px 14px;border-bottom:1px solid #eee;background:#f5f7fa;font-size:16px;}" +
    ".panel .summary .miss{color:#b00020;font-weight:600 !important;}" +
    ".panel .summary .ok{color:#0a8043;font-weight:600 !important;}" +
    ".panel .summary .warn{color:#b45309;font-weight:600 !important;}" +
    ".panel ol{margin:0;padding:0;list-style:none;overflow:auto;flex:1 1 auto;}" +
    ".panel li{padding:10px 14px;border-bottom:1px solid #eee;cursor:pointer;font-size:16px;display:flex;align-items:flex-start;gap:10px;}" +
    ".panel li:hover{background:#eef4ff;}" +
    ".panel li .gutter{flex:0 0 auto;width:22px;color:#999;font-size:14px;text-align:right;}" +
    ".panel li .statuschip{flex:0 0 auto;display:inline-block;min-width:90px;text-align:center;padding:4px 8px;border-radius:3px;color:#fff !important;font-size:14px;font-weight:700 !important;line-height:1.2;}" +
    ".panel li .body{flex:1 1 auto;min-width:0;}" +
    ".panel li .meta{color:#555;font-size:14px;margin-bottom:2px;}" +
    ".panel li .frame-label{color:#0a5d2e;font-weight:600;}" +
    ".panel li .name{font-weight:600 !important;color:#111;font-size:16px;word-break:break-word;}" +
    ".panel li .name.no-name{color:#666;font-style:italic;font-weight:400 !important;}" +
    ".panel li .alt{margin-top:2px;color:#444;font-size:14px;word-break:break-word;}" +
    ".panel li .alt em{color:#666;font-style:italic;font-weight:400 !important;}" +
    ".panel li .issues{color:#b00020;font-size:14px;margin-top:4px;font-weight:600 !important;}" +
    ".panel li .src{color:#666;font-size:14px;font-style:italic;margin-top:2px;word-break:break-all;}" +
    ".panel li .imgsrc{color:#0a5d2e;font-size:13px;margin-top:2px;word-break:break-all;}" +
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
    if (!r.isTop) cls += " frame";
    badge.className = cls;
    badge.style.background = STATUS_COLORS[r.status] || "#003876";
    var prefix = r.isTop ? "" : "[frame] ";
    var label = STATUS_LABELS[r.status] || r.status;
    var summary = r.name ? r.name : (r.status === "decorative" ? "(decorative)" : "(no name)");
    badge.textContent = "#" + r.index + " " + prefix + r.tag + " " + label + ": " + summary;
    badge.style.top = (r.pageTop - 28) + "px";
    badge.style.left = r.pageLeft + "px";
    shadow.appendChild(badge);
    badges.push(badge);
    r.badge = badge;
  });

  // Markdown
  function mdEsc(s) { return String(s).replace(/\|/g, "\\|").replace(/\n+/g, " "); }
  function truncSrc(s) {
    if (!s) return "";
    if (s.length <= 60) return s;
    return s.slice(0, 28) + "…" + s.slice(-28);
  }
  var md = "| # | Frame | Element | Status | Accessible Name | Source | Alt | src/href | Issues | Selector |\n";
  md += "|---|-------|---------|--------|-----------------|--------|-----|----------|--------|----------|\n";
  allResults.forEach(function (r) {
    var elem = "`" + r.tag + (r.tag === "input" ? '[type="image"]' : "") + "`";
    var name = r.name ? mdEsc(r.name) : (r.status === "decorative" ? "*(decorative)*" : "*(none)*");
    var altCell = r.rawAlt === null ? "*(no alt attr)*"
                : r.rawAlt === "" ? "`alt=\"\"`"
                : "`" + mdEsc(r.rawAlt) + "`";
    var issues = r.issues.length ? "⚠ " + r.issues.map(fmtIssueMd).join("; ") : "";
    var frameLabel = r.isTop ? "(top)" : mdEsc(r.frameLabel || r.frameUrl);
    md += "| " + r.index + " | " + frameLabel + " | " + elem + " | " + r.status + " | " + name + " | " + (r.nameSrc || "") + " | " + altCell + " | `" + mdEsc(truncSrc(r.src)) + "` | " + issues + " | `" + mdEsc(r.selector) + "` |\n";
  });

  // Tallies
  var counts = { labeled: 0, decorative: 0, missing: 0, suspicious: 0 };
  allResults.forEach(function (r) { counts[r.status]++; });
  var frameCount = framesData.filter(function (f) { return !f.isTop && f.results && f.results.length; }).length;
  var problemCount = counts.missing + counts.suspicious;

  console.group("%c[a11yn images] " + allResults.length + " image-like elements (" + counts.missing + " missing, " + counts.suspicious + " suspicious, " + counts.decorative + " decorative) — top doc + " + frameCount + " frame(s)",
    "color:#003876;font-weight:bold;font-size:13px");
  console.table(allResults.map(function (r) {
    return {
      "#": r.index,
      frame: r.isTop ? "(top)" : (r.frameLabel || r.frameUrl),
      element: r.tag,
      status: r.status,
      name: r.name || (r.status === "decorative" ? "(decorative)" : "(none)"),
      alt: r.rawAlt === null ? "(no attr)" : r.rawAlt,
      issues: r.issues.map(fmtIssuePanel).join("; ")
    };
  }));
  console.log("%cMarkdown table:", "font-weight:bold");
  console.log(md);
  console.groupEnd();

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }

  var panelEl = document.createElement("div");
  panelEl.className = "panel";

  var summary = "";
  if (allResults.length === 0) {
    summary += '<span class="warn">No image-like elements found.</span>';
  } else if (problemCount === 0) {
    summary += '<span class="ok">All ' + counts.labeled + ' labeled image' + (counts.labeled === 1 ? "" : "s") + ' look good (' + counts.decorative + ' marked decorative).</span>';
  } else {
    var bits = [];
    if (counts.missing) bits.push(counts.missing + " missing");
    if (counts.suspicious) bits.push(counts.suspicious + " suspicious");
    summary += '<span class="miss">' + bits.join(", ") + " of " + allResults.length + " images.</span>";
  }
  summary += '<div style="margin-top:6px;color:#555;font-size:14px">';
  summary += counts.labeled + " labeled · " + counts.decorative + " decorative · " + counts.missing + " missing · " + counts.suspicious + " suspicious";
  summary += " · top doc";
  if (frameCount) summary += " + " + frameCount + " frame" + (frameCount === 1 ? "" : "s");
  if (unmatchedFrames) summary += " · ⚠ " + unmatchedFrames + " unpositioned frame(s)";
  summary += "</div>";

  panelEl.innerHTML =
    "<header><strong>Images (" + allResults.length + ")</strong>" +
    '<div class="btns"><button id="' + P + 'copy">Copy MD</button><button id="' + P + 'close">Close</button></div></header>' +
    '<div class="summary">' + summary + "</div>" +
    '<ol id="' + P + 'list"></ol>';

  var list = panelEl.querySelector("#" + P + "list");
  allResults.forEach(function (r) {
    var li = document.createElement("li");
    var chipColor = STATUS_COLORS[r.status] || "#003876";
    var chipLabel = STATUS_LABELS[r.status] || r.status;
    var location = r.isTop ? "" : '<span class="frame-label">[' + esc(r.frameLabel || r.frameUrl) + ']</span> ';
    var elemTag = r.tag + (r.tag === "input" ? '[type="image"]' : "") + (r.role ? ' [role="' + esc(r.role) + '"]' : "");

    var nameHtml;
    if (r.name) {
      nameHtml = '<div class="name">' + esc(r.name) + (r.nameSrc ? ' <span style="color:#999;font-weight:400;font-size:14px">via ' + esc(r.nameSrc) + "</span>" : "") + "</div>";
    } else if (r.status === "decorative") {
      nameHtml = '<div class="name no-name">(decorative — intentionally no name)</div>';
    } else {
      nameHtml = '<div class="name no-name">(no accessible name)</div>';
    }

    var altHtml = "";
    if (r.rawAlt === null) {
      altHtml = '<div class="alt"><em>alt attribute absent</em></div>';
    } else if (r.rawAlt === "") {
      altHtml = '<div class="alt"><code>alt=""</code> <em>(explicit empty alt)</em></div>';
    } else {
      altHtml = '<div class="alt"><code>alt=' + esc(JSON.stringify(r.rawAlt)) + "</code></div>";
    }

    var srcHtml = r.src ? '<div class="imgsrc">' + esc(truncSrc(r.src)) + "</div>" : "";

    li.innerHTML =
      '<span class="gutter">' + r.index + "</span>" +
      '<span class="statuschip" style="background:' + chipColor + '">' + esc(chipLabel) + "</span>" +
      '<div class="body">' +
        '<div class="meta">' + location + "<code>&lt;" + esc(elemTag) + "&gt;</code></div>" +
        nameHtml +
        altHtml +
        srcHtml +
        (r.issues.length ? '<div class="issues">⚠ ' + esc(r.issues.map(fmtIssuePanel).join("; ")) + "</div>" : "") +
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

  // Drag-by-header (same pattern as other checks)
  (function () {
    var header = panelEl.querySelector("header");
    if (!header) return;
    header.style.cursor = "move";
    header.style.userSelect = "none";
    header.style.touchAction = "none";
    var dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    header.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest("button")) return;
      var rect = panelEl.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
      startX = e.clientX; startY = e.clientY;
      dragging = true;
      panelEl.style.left = startLeft + "px";
      panelEl.style.top = startTop + "px";
      panelEl.style.right = "auto";
      try { header.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    header.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var newLeft = startLeft + (e.clientX - startX);
      var newTop = startTop + (e.clientY - startY);
      var minLeft = 40 - panelEl.offsetWidth;
      var maxLeft = window.innerWidth - 40;
      var maxTop = window.innerHeight - 40;
      newLeft = Math.max(minLeft, Math.min(maxLeft, newLeft));
      newTop = Math.max(0, Math.min(maxTop, newTop));
      panelEl.style.left = newLeft + "px";
      panelEl.style.top = newTop + "px";
    });
    header.addEventListener("pointerup", function (e) {
      dragging = false;
      try { header.releasePointerCapture(e.pointerId); } catch (err) {}
    });
    header.addEventListener("pointercancel", function () { dragging = false; });
  })();

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
 * CHECK: LINKS — link text quality inspector
 *
 * Reports every <a href> link and every element with role="link",
 * classifying each by the quality of its accessible name. Per WCAG 2.4.4
 * (Link Purpose in Context) and 2.4.9 (Link Purpose, Link Only), link
 * text should describe its destination.
 *
 * Per-link status (worst-case wins):
 *
 *   ok           name is descriptive and unique to its destination
 *   empty        no accessible name at all
 *   generic      name is one of a list of well-known generic phrases
 *                ("click here", "more", "read more", "learn more", …)
 *   url-as-text  the visible text is the link's URL — AT will read out
 *                the whole URL letter by letter, useless
 *   ambiguous    one of two cross-link problems:
 *                  - same text → different href (AT reads the same name
 *                    for two destinations; user can't pick)
 *                  - same href → different text (less critical but
 *                    inconsistent; reported for awareness)
 *
 * The cross-link clusters are surfaced via the `related` field on each
 * issue so the panel shows "(also: #3, #7)" and the Markdown table shows
 * the related selectors.
 * ==================================================================== */

function scanLinks() {
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

    // Same name algorithm as the Names check (common path of accname-1.2),
    // simplified to what links use.
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

    function linkAccName(el) {
      var seen = new Set();
      var aLab = el.getAttribute("aria-labelledby");
      if (aLab) { var n1 = refNames(aLab, el, seen); if (n1) return { name: n1, src: "aria-labelledby" }; }
      var aL = el.getAttribute("aria-label");
      if (aL && aL.trim()) return { name: aL.trim(), src: "aria-label" };
      var n2 = nameFromContent(el, seen);
      if (n2) return { name: n2, src: "subtree text" };
      var ti = el.getAttribute("title");
      if (ti && ti.trim()) return { name: ti.trim(), src: "title" };
      return { name: "", src: "" };
    }

    // Known generic phrases. Matched case-insensitively against the FULL
    // trimmed accessible name (so "Read more about quantum physics" doesn't
    // trip — only literally "read more" does).
    var GENERIC_PHRASES = [
      "click here", "click", "here", "more", "read more", "more...",
      "learn more", "see more", "show more", "view more", "view all",
      "details", "info", "more info", "more information",
      "this", "this link", "link", "this page",
      "go", "continue", "next", "previous", "back",
      "open", "view", "read", "read on", "submit"
    ];
    var GENERIC_SET = new Set(GENERIC_PHRASES.map(function (s) { return s.toLowerCase(); }));

    function isGenericText(name) {
      if (!name) return false;
      return GENERIC_SET.has(name.trim().toLowerCase());
    }

    function classifyHref(href) {
      if (!href) return "none";
      var h = href.trim().toLowerCase();
      if (h === "" || h === "#") return "empty-hash";
      if (h.indexOf("#") === 0) return "hash";
      if (h.indexOf("javascript:") === 0) return "javascript";
      if (h.indexOf("mailto:") === 0) return "mailto";
      if (h.indexOf("tel:") === 0) return "tel";
      if (h.indexOf("http") === 0 || h.indexOf("//") === 0 || h.indexOf("/") === 0) return "http";
      return "other";
    }

    function looksLikeUrl(s) {
      if (!s) return false;
      var t = s.trim();
      // Bare URL forms: starts with http://, https://, www., or contains :// in middle
      return /^(https?:\/\/|www\.)/i.test(t) || /:\/\//.test(t);
    }

    var SELECTOR = "a[href], [role=\"link\"]";

    var results = [];
    var seenEls = new Set();
    var shadowRoots = 0;

    function walk(root) {
      var matches;
      try { matches = root.querySelectorAll(SELECTOR); } catch (e) { return; }
      Array.prototype.forEach.call(matches, function (el) {
        if (seenEls.has(el)) return;
        seenEls.add(el);
        if (isHidden(el)) return;
        var r;
        try { r = el.getBoundingClientRect(); } catch (e) { return; }
        if (r.width === 0 && r.height === 0) return;

        var tag = el.tagName.toLowerCase();
        var href = el.getAttribute("href");
        var hrefKind = classifyHref(href);
        var an = linkAccName(el);
        var nameLower = (an.name || "").trim().toLowerCase();

        results.push({
          tag: tag,
          role: el.getAttribute("role") || (tag === "a" ? "link" : null),
          href: href || "",
          hrefKind: hrefKind,
          name: an.name,
          nameSrc: an.src,
          nameLower: nameLower,
          isEmpty: !an.name,
          isGeneric: isGenericText(an.name),
          isUrlAsText: !!an.name && looksLikeUrl(an.name) && classifyHref(an.name) !== "none",
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

    results.sort(function (a, b) {
      if (a.rect.top !== b.rect.top) return a.rect.top - b.rect.top;
      return a.rect.left - b.rect.left;
    });

    return { url: window.location.href, isTop: window === window.top, results: results, shadowRoots: shadowRoots };
  } catch (e) {
    return { url: window.location.href, isTop: window === window.top, results: [], error: String(e && e.message || e) };
  }
}

function displayLinks(framesData, checkId) {
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
        tag: r.tag, role: r.role,
        href: r.href, hrefKind: r.hrefKind,
        name: r.name, nameSrc: r.nameSrc, nameLower: r.nameLower,
        isEmpty: r.isEmpty, isGeneric: r.isGeneric, isUrlAsText: r.isUrlAsText,
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

  // Cross-link clustering:
  //   sameTextDifferentHref: links with identical (lowercased) name but
  //                          different href values
  //   sameHrefDifferentText: links with identical href but different names
  //
  // Both clusters reference the OTHER members so each row tells the auditor
  // about its full set.
  var byNameLower = new Map(); // name → array of links
  var byHref = new Map();      // href (normalized) → array of links
  allResults.forEach(function (r) {
    if (r.nameLower) {
      if (!byNameLower.has(r.nameLower)) byNameLower.set(r.nameLower, []);
      byNameLower.get(r.nameLower).push(r);
    }
    if (r.href) {
      var key = r.href.trim();
      if (!byHref.has(key)) byHref.set(key, []);
      byHref.get(key).push(r);
    }
  });

  allResults.forEach(function (r) {
    r.issues = [];

    if (r.isEmpty) {
      r.issues.push({ text: "no accessible name (empty link)", related: [] });
    }
    if (r.isGeneric) {
      r.issues.push({
        text: 'generic link text "' + r.name + '" — describe the destination',
        related: []
      });
    }
    if (r.isUrlAsText) {
      r.issues.push({
        text: "link text is the URL — AT will read it character by character; use descriptive text",
        related: []
      });
    }

    // Cluster checks — only flag when the cluster's name/href is meaningful.
    if (r.nameLower) {
      var sameNameGroup = byNameLower.get(r.nameLower);
      if (sameNameGroup.length > 1) {
        var differentHref = sameNameGroup.filter(function (o) {
          return o.index !== r.index && o.href !== r.href;
        });
        if (differentHref.length) {
          r.issues.push({
            text: 'same link text "' + r.name + '" used for different destinations — AT cannot distinguish them',
            related: differentHref.map(function (o) { return o.index; })
          });
        }
      }
    }
    if (r.href && r.href.trim() && r.hrefKind === "http") {
      var sameHrefGroup = byHref.get(r.href.trim());
      if (sameHrefGroup && sameHrefGroup.length > 1) {
        var differentText = sameHrefGroup.filter(function (o) {
          return o.index !== r.index && o.nameLower !== r.nameLower;
        });
        if (differentText.length) {
          r.issues.push({
            text: "same destination but described with different text — pick one consistent name",
            related: differentText.map(function (o) { return o.index; })
          });
        }
      }
    }
  });

  // Derive status (worst-case wins). Drives chip colour.
  allResults.forEach(function (r) {
    if (r.isEmpty) r.status = "empty";
    else if (r.isUrlAsText) r.status = "url-as-text";
    else if (r.isGeneric) r.status = "generic";
    else if (r.issues.some(function (i) { return /different destinations/.test(i.text); })) r.status = "ambiguous";
    else if (r.issues.some(function (i) { return /different text/.test(i.text); })) r.status = "inconsistent";
    else r.status = "ok";
  });

  function fmtIssuePanel(issue) {
    if (!issue.related || !issue.related.length) return issue.text;
    return issue.text + " (also: " + issue.related.map(function (i) { return "#" + i; }).join(", ") + ")";
  }
  function fmtIssueMd(issue) {
    if (!issue.related || !issue.related.length) return mdEsc(issue.text);
    var refs = issue.related.map(function (i) {
      var other = allResults[i - 1];
      return "#" + i + " `" + mdEsc(other ? other.selector : "") + "`";
    });
    return mdEsc(issue.text) + " (also: " + refs.join(", ") + ")";
  }

  // Resolve element refs for outline + click-to-scroll
  allResults.forEach(function (r) {
    var doc;
    if (r.isTop) doc = document;
    else if (r.iframeEl) { try { doc = r.iframeEl.contentDocument; } catch (e) { doc = null; } }
    if (!doc) return;
    try {
      var el = doc.querySelector(r.selector);
      if (el) {
        r._resolveEl = el;
        var color, style;
        if (r.status === "empty") { color = "#b00020"; style = "dashed"; }
        else if (r.status === "generic" || r.status === "url-as-text" || r.status === "ambiguous") { color = "#b45309"; style = "dashed"; }
        else if (r.status === "inconsistent") { color = "#b45309"; style = "dotted"; }
        else { color = "#003876"; style = "solid"; }
        el.style.setProperty("outline", "2px " + style + " " + color, "important");
        el.style.setProperty("outline-offset", "1px", "important");
      }
    } catch (e) {}
  });

  // Shadow UI host
  var host = document.createElement("div");
  host.id = P + "host";
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "all:initial !important;position:absolute !important;top:0 !important;left:0 !important;width:0 !important;height:0 !important;margin:0 !important;padding:0 !important;border:0 !important;font:400 16px/1.4 ui-sans-serif,system-ui,sans-serif !important;color:#111 !important;pointer-events:none !important;z-index:2147483647 !important;";
  (document.body || document.documentElement).appendChild(host);
  var shadow = host.attachShadow({ mode: "closed" });

  var STATUS_COLORS = {
    ok:           "#003876",
    empty:        "#b00020",
    generic:      "#b45309",
    "url-as-text":"#b45309",
    ambiguous:    "#b45309",
    inconsistent: "#7a4a09"
  };
  var STATUS_LABELS = {
    ok:           "ok",
    empty:        "EMPTY",
    generic:      "generic",
    "url-as-text":"url-as-text",
    ambiguous:    "ambiguous",
    inconsistent: "inconsistent"
  };

  var css =
    ":host{all:initial;font-family:ui-sans-serif,system-ui,sans-serif !important;}" +
    "*,*::before,*::after{box-sizing:border-box;font-family:ui-sans-serif,system-ui,sans-serif !important;font-style:normal !important;font-weight:400 !important;font-variant:normal !important;text-transform:none !important;letter-spacing:normal !important;text-decoration:none !important;color:#111;}" +
    ".badge{position:absolute;background:#003876;color:#fff;font-size:16px;font-weight:600 !important;line-height:1.2;padding:4px 8px;border-radius:3px;pointer-events:none;max-width:380px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,.4);}" +
    ".badge.frame{filter:saturate(0.7) brightness(0.9);}" +
    ".panel{position:fixed;top:12px;right:12px;width:520px;max-height:85vh;display:flex;flex-direction:column;background:#fff;color:#111;border:1px solid #bbb;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.25);font-size:16px;line-height:1.4;pointer-events:auto;}" +
    ".panel header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#003876;color:#fff;border-radius:6px 6px 0 0;}" +
    ".panel header strong{font-size:18px;font-weight:600 !important;color:#fff;}" +
    ".panel .btns{display:flex;gap:8px;}" +
    ".panel button{background:transparent;border:1px solid #fff;color:#fff;padding:6px 12px;border-radius:3px;cursor:pointer;font-size:16px;font-weight:500;line-height:1.2;}" +
    ".panel button:hover{background:rgba(255,255,255,.18);}" +
    ".panel .summary{padding:10px 14px;border-bottom:1px solid #eee;background:#f5f7fa;font-size:16px;}" +
    ".panel .summary .miss{color:#b00020;font-weight:600 !important;}" +
    ".panel .summary .ok{color:#0a8043;font-weight:600 !important;}" +
    ".panel .summary .warn{color:#b45309;font-weight:600 !important;}" +
    ".panel ol{margin:0;padding:0;list-style:none;overflow:auto;flex:1 1 auto;}" +
    ".panel li{padding:10px 14px;border-bottom:1px solid #eee;cursor:pointer;font-size:16px;display:flex;align-items:flex-start;gap:10px;}" +
    ".panel li:hover{background:#eef4ff;}" +
    ".panel li .gutter{flex:0 0 auto;width:22px;color:#999;font-size:14px;text-align:right;}" +
    ".panel li .statuschip{flex:0 0 auto;display:inline-block;min-width:100px;text-align:center;padding:4px 8px;border-radius:3px;color:#fff !important;font-size:14px;font-weight:700 !important;line-height:1.2;}" +
    ".panel li .body{flex:1 1 auto;min-width:0;}" +
    ".panel li .meta{color:#555;font-size:14px;margin-bottom:2px;}" +
    ".panel li .frame-label{color:#0a5d2e;font-weight:600;}" +
    ".panel li .name{font-weight:600 !important;color:#111;font-size:16px;word-break:break-word;}" +
    ".panel li .name.no-name{color:#666;font-style:italic;font-weight:400 !important;}" +
    ".panel li .href{color:#0a5d2e;font-size:13px;margin-top:2px;word-break:break-all;}" +
    ".panel li .issues{color:#b00020;font-size:14px;margin-top:4px;font-weight:600 !important;}" +
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
    if (!r.isTop) cls += " frame";
    badge.className = cls;
    badge.style.background = STATUS_COLORS[r.status] || "#003876";
    var prefix = r.isTop ? "" : "[frame] ";
    var label = STATUS_LABELS[r.status] || r.status;
    var summary = r.name || "(empty)";
    badge.textContent = "#" + r.index + " " + prefix + "link " + label + ": " + summary;
    badge.style.top = (r.pageTop - 28) + "px";
    badge.style.left = r.pageLeft + "px";
    shadow.appendChild(badge);
    badges.push(badge);
    r.badge = badge;
  });

  // Markdown
  function mdEsc(s) { return String(s).replace(/\|/g, "\\|").replace(/\n+/g, " "); }
  function truncHref(s) {
    if (!s) return "";
    if (s.length <= 60) return s;
    return s.slice(0, 28) + "…" + s.slice(-28);
  }
  var md = "| # | Frame | Status | Accessible Name | Source | href | Issues | Selector |\n";
  md += "|---|-------|--------|-----------------|--------|------|--------|----------|\n";
  allResults.forEach(function (r) {
    var name = r.name ? mdEsc(r.name) : "*(empty)*";
    var issues = r.issues.length ? "⚠ " + r.issues.map(fmtIssueMd).join("; ") : "";
    var frameLabel = r.isTop ? "(top)" : mdEsc(r.frameLabel || r.frameUrl);
    md += "| " + r.index + " | " + frameLabel + " | " + r.status + " | " + name + " | " + (r.nameSrc || "") + " | `" + mdEsc(truncHref(r.href)) + "` | " + issues + " | `" + mdEsc(r.selector) + "` |\n";
  });

  // Tallies
  var counts = { ok: 0, empty: 0, generic: 0, "url-as-text": 0, ambiguous: 0, inconsistent: 0 };
  allResults.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
  var frameCount = framesData.filter(function (f) { return !f.isTop && f.results && f.results.length; }).length;
  var problemCount = allResults.length - counts.ok;

  console.group("%c[a11yn links] " + allResults.length + " links (" + problemCount + " with issues) — top doc + " + frameCount + " frame(s)",
    "color:#003876;font-weight:bold;font-size:13px");
  console.table(allResults.map(function (r) {
    return {
      "#": r.index,
      frame: r.isTop ? "(top)" : (r.frameLabel || r.frameUrl),
      status: r.status,
      name: r.name || "(empty)",
      href: r.href,
      issues: r.issues.map(fmtIssuePanel).join("; ")
    };
  }));
  console.log("%cMarkdown table:", "font-weight:bold");
  console.log(md);
  console.groupEnd();

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }

  var panelEl = document.createElement("div");
  panelEl.className = "panel";

  var summary = "";
  if (allResults.length === 0) {
    summary += '<span class="warn">No links found.</span>';
  } else if (problemCount === 0) {
    summary += '<span class="ok">All ' + allResults.length + ' links look good.</span>';
  } else {
    var bits = [];
    if (counts.empty)         bits.push(counts.empty + " empty");
    if (counts.generic)       bits.push(counts.generic + " generic");
    if (counts["url-as-text"]) bits.push(counts["url-as-text"] + " url-as-text");
    if (counts.ambiguous)     bits.push(counts.ambiguous + " ambiguous (same text, diff dest)");
    if (counts.inconsistent)  bits.push(counts.inconsistent + " inconsistent (same dest, diff text)");
    summary += '<span class="miss">' + bits.join(", ") + " of " + allResults.length + " links.</span>";
  }
  summary += '<div style="margin-top:6px;color:#555;font-size:14px">';
  summary += counts.ok + " ok · top doc";
  if (frameCount) summary += " + " + frameCount + " frame" + (frameCount === 1 ? "" : "s");
  if (unmatchedFrames) summary += " · ⚠ " + unmatchedFrames + " unpositioned frame(s)";
  summary += "</div>";

  panelEl.innerHTML =
    "<header><strong>Links (" + allResults.length + ")</strong>" +
    '<div class="btns"><button id="' + P + 'copy">Copy MD</button><button id="' + P + 'close">Close</button></div></header>' +
    '<div class="summary">' + summary + "</div>" +
    '<ol id="' + P + 'list"></ol>';

  var list = panelEl.querySelector("#" + P + "list");
  allResults.forEach(function (r) {
    var li = document.createElement("li");
    var chipColor = STATUS_COLORS[r.status] || "#003876";
    var chipLabel = STATUS_LABELS[r.status] || r.status;
    var location = r.isTop ? "" : '<span class="frame-label">[' + esc(r.frameLabel || r.frameUrl) + ']</span> ';
    var elemTag = r.tag + (r.role && r.role !== "link" ? ' [role="' + esc(r.role) + '"]' : "");

    var nameHtml;
    if (r.name) {
      nameHtml = '<div class="name">' + esc(r.name) + (r.nameSrc ? ' <span style="color:#999;font-weight:400;font-size:14px">via ' + esc(r.nameSrc) + "</span>" : "") + "</div>";
    } else {
      nameHtml = '<div class="name no-name">(empty link)</div>';
    }

    var hrefHtml = r.href ? '<div class="href">→ ' + esc(truncHref(r.href)) + "</div>" : "";

    li.innerHTML =
      '<span class="gutter">' + r.index + "</span>" +
      '<span class="statuschip" style="background:' + chipColor + '">' + esc(chipLabel) + "</span>" +
      '<div class="body">' +
        '<div class="meta">' + location + "<code>&lt;" + esc(elemTag) + "&gt;</code></div>" +
        nameHtml +
        hrefHtml +
        (r.issues.length ? '<div class="issues">⚠ ' + esc(r.issues.map(fmtIssuePanel).join("; ")) + "</div>" : "") +
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

  // Drag-by-header
  (function () {
    var header = panelEl.querySelector("header");
    if (!header) return;
    header.style.cursor = "move";
    header.style.userSelect = "none";
    header.style.touchAction = "none";
    var dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    header.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest("button")) return;
      var rect = panelEl.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
      startX = e.clientX; startY = e.clientY;
      dragging = true;
      panelEl.style.left = startLeft + "px";
      panelEl.style.top = startTop + "px";
      panelEl.style.right = "auto";
      try { header.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    header.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var newLeft = startLeft + (e.clientX - startX);
      var newTop = startTop + (e.clientY - startY);
      var minLeft = 40 - panelEl.offsetWidth;
      var maxLeft = window.innerWidth - 40;
      var maxTop = window.innerHeight - 40;
      newLeft = Math.max(minLeft, Math.min(maxLeft, newLeft));
      newTop = Math.max(0, Math.min(maxTop, newTop));
      panelEl.style.left = newLeft + "px";
      panelEl.style.top = newTop + "px";
    });
    header.addEventListener("pointerup", function (e) {
      dragging = false;
      try { header.releasePointerCapture(e.pointerId); } catch (err) {}
    });
    header.addEventListener("pointercancel", function () { dragging = false; });
  })();

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
 * CHECK: ARIA — ARIA usage validator
 *
 * Validates every element that uses any `role` or `aria-*` attribute on
 * the page. Reports only elements that have at least one issue, since a
 * heavy-ARIA page can have hundreds of valid attributes and listing all
 * of them isn't useful for auditing.
 *
 * Issue categories:
 *
 *   unknown-role          role value not in ARIA 1.2's concrete role list
 *                         (Levenshtein-based "did you mean" suggestion)
 *   abstract-role         role is one of ARIA's abstract roles, which
 *                         must not be used by authors (e.g. "widget",
 *                         "composite", "input", "landmark")
 *   unknown-attr          aria-* attribute name not in ARIA 1.2's list
 *                         (also gets a "did you mean" suggestion)
 *   bad-bool              aria-* attribute requires true/false but got
 *                         something else (e.g. aria-expanded="yes")
 *   bad-tristate          aria-checked/aria-pressed got something other
 *                         than true/false/mixed
 *   bad-idref             ID-reference attribute (aria-labelledby,
 *                         aria-describedby, aria-controls, aria-owns,
 *                         aria-activedescendant, aria-errormessage,
 *                         aria-details, aria-flowto) points to one or
 *                         more IDs that don't exist in the document
 *   missing-required      role declares a required aria-* attribute
 *                         that isn't present (e.g. role="checkbox"
 *                         requires aria-checked)
 *   presentation-conflict role="presentation" or role="none" on a
 *                         focusable element conflicts with its native
 *                         interactive role
 *
 * The Levenshtein suggester returns the nearest valid token if the edit
 * distance is ≤ 3, which catches typos but won't suggest unrelated
 * names. Distance is computed inline (small implementation, no library).
 * ==================================================================== */

function scanAria() {
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

    /* ----- ARIA 1.2 vocabulary tables (compact, hand-curated) ----- */

    var VALID_ROLES = new Set([
      // Document structure
      "application", "article", "blockquote", "caption", "cell", "code", "columnheader",
      "comment", "definition", "deletion", "directory", "document", "emphasis", "feed",
      "figure", "generic", "group", "heading", "img", "image", "insertion", "list", "listitem",
      "mark", "math", "meter", "none", "note", "paragraph", "presentation", "row",
      "rowgroup", "rowheader", "separator", "strong", "subscript", "suggestion",
      "superscript", "table", "term", "time",
      // Widget roles
      "alert", "alertdialog", "button", "checkbox", "combobox", "dialog", "gridcell",
      "link", "log", "marquee", "menuitem", "menuitemcheckbox", "menuitemradio",
      "option", "progressbar", "radio", "scrollbar", "searchbox", "slider", "spinbutton",
      "status", "switch", "tab", "tabpanel", "textbox", "timer", "tooltip", "treeitem",
      // Composite widget roles
      "grid", "listbox", "menu", "menubar", "radiogroup", "tablist", "tree", "treegrid",
      // Landmark roles
      "banner", "complementary", "contentinfo", "form", "main", "navigation", "region", "search",
      // DPUB-ARIA
      "doc-abstract", "doc-acknowledgments", "doc-afterword", "doc-appendix",
      "doc-backlink", "doc-biblioentry", "doc-bibliography", "doc-biblioref",
      "doc-chapter", "doc-colophon", "doc-conclusion", "doc-cover", "doc-credit",
      "doc-credits", "doc-dedication", "doc-endnote", "doc-endnotes", "doc-epigraph",
      "doc-epilogue", "doc-errata", "doc-example", "doc-footnote", "doc-foreword",
      "doc-glossary", "doc-glossref", "doc-index", "doc-introduction", "doc-noteref",
      "doc-notice", "doc-pagebreak", "doc-pagelist", "doc-part", "doc-preface",
      "doc-prologue", "doc-pullquote", "doc-qna", "doc-subtitle", "doc-tip", "doc-toc",
      // SVG/Graphics
      "graphics-document", "graphics-object", "graphics-symbol"
    ]);

    var ABSTRACT_ROLES = new Set([
      "command", "composite", "input", "landmark", "range", "roletype",
      "section", "sectionhead", "select", "structure", "widget", "window"
    ]);

    var VALID_ARIA_ATTRS = new Set([
      "aria-activedescendant", "aria-atomic", "aria-autocomplete", "aria-braillelabel",
      "aria-brailleroledescription", "aria-busy", "aria-checked", "aria-colcount",
      "aria-colindex", "aria-colindextext", "aria-colspan", "aria-controls",
      "aria-current", "aria-describedby", "aria-description", "aria-details",
      "aria-disabled", "aria-dropeffect", "aria-errormessage", "aria-expanded",
      "aria-flowto", "aria-grabbed", "aria-haspopup", "aria-hidden", "aria-invalid",
      "aria-keyshortcuts", "aria-label", "aria-labelledby", "aria-level", "aria-live",
      "aria-modal", "aria-multiline", "aria-multiselectable", "aria-orientation",
      "aria-owns", "aria-placeholder", "aria-posinset", "aria-pressed", "aria-readonly",
      "aria-relevant", "aria-required", "aria-roledescription", "aria-rowcount",
      "aria-rowindex", "aria-rowindextext", "aria-rowspan", "aria-selected",
      "aria-setsize", "aria-sort", "aria-valuemax", "aria-valuemin", "aria-valuenow",
      "aria-valuetext"
    ]);

    var ID_REF_ATTRS = new Set([
      "aria-labelledby", "aria-describedby", "aria-controls", "aria-details",
      "aria-owns", "aria-flowto", "aria-activedescendant", "aria-errormessage"
    ]);

    // Strict boolean (true/false; "" / undefined also acceptable per spec for some)
    var BOOLEAN_ATTRS = new Set([
      "aria-atomic", "aria-busy", "aria-disabled", "aria-grabbed", "aria-hidden",
      "aria-modal", "aria-multiline", "aria-multiselectable", "aria-readonly",
      "aria-required", "aria-selected"
    ]);
    // Tristate: true/false/mixed
    var TRISTATE_ATTRS = new Set(["aria-checked", "aria-pressed"]);
    // aria-expanded: true/false (undefined allowed)
    var EXPANDED_VALUES = new Set(["true", "false", ""]);
    // aria-haspopup: false/true/menu/listbox/tree/grid/dialog
    var HASPOPUP_VALUES = new Set(["false", "true", "menu", "listbox", "tree", "grid", "dialog", ""]);
    // aria-current: false/true/page/step/location/date/time
    var CURRENT_VALUES = new Set(["false", "true", "page", "step", "location", "date", "time", ""]);
    // aria-invalid: false/true/grammar/spelling
    var INVALID_VALUES = new Set(["false", "true", "grammar", "spelling", ""]);
    // aria-live: off/polite/assertive
    var LIVE_VALUES = new Set(["off", "polite", "assertive", ""]);
    // aria-orientation: horizontal/vertical/undefined
    var ORIENTATION_VALUES = new Set(["horizontal", "vertical", "undefined", ""]);
    // aria-sort: ascending/descending/none/other
    var SORT_VALUES = new Set(["ascending", "descending", "none", "other", ""]);
    // aria-autocomplete: inline/list/both/none
    var AUTOCOMPLETE_VALUES = new Set(["inline", "list", "both", "none", ""]);

    // Only roles where a missing attribute is a real bug. We deliberately
    // exclude roles whose "required" attributes have a sensible default:
    //
    //   role="checkbox" / "radio" / "switch"  — aria-checked defaults to false
    //   role="combobox"                       — aria-expanded defaults to false
    //
    // For those, a missing attribute is functionally equivalent to the
    // default, so flagging generates noise without surfacing a real bug.
    //
    // For the roles below, missing the attribute is a real problem:
    //   - heading: aria-level defaults to 2, but if a developer reached for
    //     role="heading" instead of <h1>..<h6> they almost certainly want a
    //     specific level — getting silently treated as h2 is rarely intent.
    //   - scrollbar / slider / meter: AT literally cannot describe the
    //     control's position or value without aria-valuenow (no sensible
    //     default — there's no "default position" for an arbitrary slider).
    var REQUIRED_ATTRS_BY_ROLE = {
      "heading":   ["aria-level"],
      "scrollbar": ["aria-controls", "aria-valuenow"],
      "slider":    ["aria-valuenow"],
      "meter":     ["aria-valuenow"]
    };

    // Map each native HTML element/type to its implicit ARIA role. Used to
    // flag explicit role= attributes that just duplicate what the browser
    // already provides — e.g. <nav role="navigation"> or <button role="button">.
    // Only the clear-cut cases are listed; native elements with
    // context-dependent implicit roles (header/footer/section/form) are
    // omitted to avoid false positives.
    function implicitRoleOf(el) {
      var tag = el.tagName.toLowerCase();
      if (tag === "a") return el.hasAttribute("href") ? "link" : null;
      if (tag === "button") return "button";
      if (tag === "input") {
        var t = (el.getAttribute("type") || "text").toLowerCase();
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        if (t === "button" || t === "submit" || t === "reset") return "button";
        if (t === "range") return "slider";
        if (t === "number") return "spinbutton";
        if (t === "search") return "searchbox";
        if (t === "text" || t === "email" || t === "tel" || t === "url") return "textbox";
        return null;
      }
      if (tag === "select") return el.multiple ? "listbox" : "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "nav") return "navigation";
      if (tag === "main") return "main";
      if (tag === "aside") return "complementary";
      if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") return "heading";
      if (tag === "ul" || tag === "ol") return "list";
      if (tag === "li") return "listitem";
      if (tag === "table") return "table";
      if (tag === "tr") return "row";
      if (tag === "dialog") return "dialog";
      if (tag === "details") return "group";
      if (tag === "summary") return "button";
      if (tag === "progress") return "progressbar";
      if (tag === "fieldset") return "group";
      if (tag === "output") return "status";
      if (tag === "img" && el.getAttribute("alt") === "") return "presentation";
      return null;
    }

    /* ----- helpers ----- */

    function levenshtein(a, b) {
      var m = a.length, n = b.length;
      if (m === 0) return n;
      if (n === 0) return m;
      var prev = new Array(n + 1), cur = new Array(n + 1);
      for (var j = 0; j <= n; j++) prev[j] = j;
      for (var i = 1; i <= m; i++) {
        cur[0] = i;
        for (var k = 1; k <= n; k++) {
          var cost = a.charAt(i - 1) === b.charAt(k - 1) ? 0 : 1;
          cur[k] = Math.min(cur[k - 1] + 1, prev[k] + 1, prev[k - 1] + cost);
        }
        var tmp = prev; prev = cur; cur = tmp;
      }
      return prev[n];
    }

    function findClosest(input, validSet) {
      if (!input) return null;
      var best = null, bestDist = 4;
      validSet.forEach(function (item) {
        var d = levenshtein(input.toLowerCase(), item.toLowerCase());
        if (d < bestDist) { bestDist = d; best = item; }
      });
      return best;
    }

    function primaryRole(roleAttr) {
      if (!roleAttr) return null;
      var tokens = roleAttr.trim().split(/\s+/);
      for (var i = 0; i < tokens.length; i++) {
        if (VALID_ROLES.has(tokens[i])) return tokens[i];
      }
      return null;
    }

    function isFocusableNatively(el) {
      var tag = el.tagName.toLowerCase();
      if (el.hasAttribute("disabled")) return false;
      if (tag === "a" && el.hasAttribute("href")) return true;
      if (tag === "button" || tag === "select" || tag === "textarea") return true;
      if (tag === "input") {
        var t = (el.getAttribute("type") || "text").toLowerCase();
        return t !== "hidden";
      }
      if (tag === "summary" || tag === "details") return true;
      return false;
    }

    function validateElement(el) {
      var issues = [];
      var doc = el.ownerDocument || document;
      var root = el.getRootNode ? el.getRootNode() : doc;

      // ----- Role validation
      var roleAttr = el.getAttribute("role");
      if (roleAttr) {
        var roleTokens = roleAttr.trim().split(/\s+/);
        roleTokens.forEach(function (token) {
          if (!token) return;
          if (VALID_ROLES.has(token)) return;
          if (ABSTRACT_ROLES.has(token)) {
            issues.push({
              text: 'abstract role "' + token + '" cannot be used by authors',
              category: "abstract-role",
              related: []
            });
          } else {
            var suggestion = findClosest(token, VALID_ROLES);
            issues.push({
              text: 'unknown role "' + token + '"' + (suggestion ? ' — did you mean "' + suggestion + '"?' : ''),
              category: "unknown-role",
              related: []
            });
          }
        });

        // ----- presentation/none on focusable
        if ((roleTokens.indexOf("presentation") !== -1 || roleTokens.indexOf("none") !== -1)) {
          var tabidxAttr = el.getAttribute("tabindex");
          var hasFocusTabindex = tabidxAttr !== null && tabidxAttr !== "" && parseInt(tabidxAttr, 10) >= 0;
          if (isFocusableNatively(el) || hasFocusTabindex) {
            issues.push({
              text: 'role="presentation"/"none" applied to a focusable element conflicts with its native role',
              category: "presentation-conflict",
              related: []
            });
          }
        }

        // ----- redundant role (explicit role duplicates the native implicit role)
        var implicit = implicitRoleOf(el);
        var primaryAtThisPoint = primaryRole(roleAttr);
        if (implicit && primaryAtThisPoint && primaryAtThisPoint === implicit) {
          var elDesc = "<" + el.tagName.toLowerCase();
          if (el.tagName.toLowerCase() === "input" && el.getAttribute("type")) {
            elDesc += ' type="' + el.getAttribute("type") + '"';
          }
          elDesc += ">";
          issues.push({
            text: elDesc + ' already has implicit role "' + implicit + '" — explicit role="' + primaryAtThisPoint + '" is redundant',
            category: "redundant-role",
            related: []
          });
        }
      }

      // ----- aria-* attribute validation
      Array.prototype.forEach.call(el.attributes, function (attr) {
        var name = attr.name;
        if (name.indexOf("aria-") !== 0) return;
        var val = attr.value;
        var valLower = val.trim().toLowerCase();

        // Name validation
        if (!VALID_ARIA_ATTRS.has(name)) {
          var suggestion = findClosest(name, VALID_ARIA_ATTRS);
          issues.push({
            text: 'unknown attribute "' + name + '"' + (suggestion ? ' — did you mean "' + suggestion + '"?' : ''),
            category: "unknown-attr",
            related: []
          });
          return;
        }

        // ID-reference validation
        if (ID_REF_ATTRS.has(name) && val.trim()) {
          var idsToCheck = val.trim().split(/\s+/);
          var missing = idsToCheck.filter(function (id) {
            var ref = (root.getElementById && root.getElementById(id)) || doc.getElementById(id);
            return !ref;
          });
          if (missing.length) {
            issues.push({
              text: name + " references nonexistent ID" + (missing.length > 1 ? "s" : "") + ": " + missing.map(function (i) { return '"' + i + '"'; }).join(", "),
              category: "bad-idref",
              related: []
            });
          }
        }

        // Value validation
        if (BOOLEAN_ATTRS.has(name)) {
          if (valLower !== "true" && valLower !== "false" && valLower !== "") {
            issues.push({
              text: name + ' should be "true" or "false" (got "' + val + '")',
              category: "bad-bool",
              related: []
            });
          }
        } else if (TRISTATE_ATTRS.has(name)) {
          if (valLower !== "true" && valLower !== "false" && valLower !== "mixed" && valLower !== "") {
            issues.push({
              text: name + ' should be "true", "false", or "mixed" (got "' + val + '")',
              category: "bad-tristate",
              related: []
            });
          }
        } else if (name === "aria-expanded") {
          if (!EXPANDED_VALUES.has(valLower) && valLower !== "undefined") {
            issues.push({
              text: 'aria-expanded should be "true" or "false" (got "' + val + '")',
              category: "bad-bool",
              related: []
            });
          }
        } else if (name === "aria-haspopup") {
          if (!HASPOPUP_VALUES.has(valLower)) {
            issues.push({
              text: 'aria-haspopup should be one of true/false/menu/listbox/tree/grid/dialog (got "' + val + '")',
              category: "bad-bool",
              related: []
            });
          }
        } else if (name === "aria-current") {
          if (!CURRENT_VALUES.has(valLower)) {
            issues.push({
              text: 'aria-current should be one of false/true/page/step/location/date/time (got "' + val + '")',
              category: "bad-bool",
              related: []
            });
          }
        } else if (name === "aria-invalid") {
          if (!INVALID_VALUES.has(valLower)) {
            issues.push({
              text: 'aria-invalid should be one of false/true/grammar/spelling (got "' + val + '")',
              category: "bad-bool",
              related: []
            });
          }
        } else if (name === "aria-live") {
          if (!LIVE_VALUES.has(valLower)) {
            issues.push({
              text: 'aria-live should be one of off/polite/assertive (got "' + val + '")',
              category: "bad-bool",
              related: []
            });
          }
        } else if (name === "aria-orientation") {
          if (!ORIENTATION_VALUES.has(valLower)) {
            issues.push({
              text: 'aria-orientation should be horizontal or vertical (got "' + val + '")',
              category: "bad-bool",
              related: []
            });
          }
        } else if (name === "aria-sort") {
          if (!SORT_VALUES.has(valLower)) {
            issues.push({
              text: 'aria-sort should be ascending/descending/none/other (got "' + val + '")',
              category: "bad-bool",
              related: []
            });
          }
        } else if (name === "aria-autocomplete") {
          if (!AUTOCOMPLETE_VALUES.has(valLower)) {
            issues.push({
              text: 'aria-autocomplete should be inline/list/both/none (got "' + val + '")',
              category: "bad-bool",
              related: []
            });
          }
        }
      });

      // ----- Required attributes for primary role
      var primary = primaryRole(roleAttr);
      if (primary && REQUIRED_ATTRS_BY_ROLE[primary]) {
        REQUIRED_ATTRS_BY_ROLE[primary].forEach(function (requiredAttr) {
          if (!el.hasAttribute(requiredAttr)) {
            issues.push({
              text: 'role="' + primary + '" requires ' + requiredAttr,
              category: "missing-required",
              related: []
            });
          }
        });
      }

      return { issues: issues, primaryRole: primary, roleAttr: roleAttr };
    }

    /* ----- Selector: every element with role or any aria-* attribute ----- */
    var SELECTOR_PARTS = ["[role]"];
    VALID_ARIA_ATTRS.forEach(function (a) { SELECTOR_PARTS.push("[" + a + "]"); });
    var SELECTOR = SELECTOR_PARTS.join(",");

    var results = [];
    var seenEls = new Set();
    var shadowRoots = 0;
    var ariaElementCount = 0;

    function walk(root) {
      var matches;
      try { matches = root.querySelectorAll(SELECTOR); } catch (e) { return; }
      Array.prototype.forEach.call(matches, function (el) {
        if (seenEls.has(el)) return;
        seenEls.add(el);
        if (isHidden(el)) return;
        ariaElementCount++;
        var validation = validateElement(el);
        var r;
        try { r = el.getBoundingClientRect(); } catch (e) { return; }
        // Collect every role/aria-* attribute so the panel can show the
        // developer's full intent on this element — useful even when nothing
        // is wrong, because seeing the inventory tells you whether ARIA is
        // being used appropriately, redundantly, or not enough.
        var ariaAttrs = [];
        Array.prototype.forEach.call(el.attributes, function (attr) {
          if (attr.name === "role" || attr.name.indexOf("aria-") === 0) {
            ariaAttrs.push({ name: attr.name, value: attr.value });
          }
        });
        results.push({
          tag: el.tagName.toLowerCase(),
          roleAttr: validation.roleAttr,
          primaryRole: validation.primaryRole,
          implicitRole: implicitRoleOf(el),
          ariaAttrs: ariaAttrs,
          issues: validation.issues,
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

    results.sort(function (a, b) {
      if (a.rect.top !== b.rect.top) return a.rect.top - b.rect.top;
      return a.rect.left - b.rect.left;
    });

    return {
      url: window.location.href,
      isTop: window === window.top,
      results: results,
      shadowRoots: shadowRoots,
      ariaElementCount: ariaElementCount
    };
  } catch (e) {
    return { url: window.location.href, isTop: window === window.top, results: [], error: String(e && e.message || e) };
  }
}

function displayAria(framesData, checkId) {
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
  var totalAriaElements = 0;
  var frameLabelByUrl = new Map();
  framesData.forEach(function (frame) {
    if (!frame || frame.error) return;
    totalAriaElements += frame.ariaElementCount || 0;
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
        roleAttr: r.roleAttr, primaryRole: r.primaryRole,
        ariaAttrs: r.ariaAttrs,
        issues: r.issues,
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

  function fmtIssuePanel(issue) {
    if (!issue.related || !issue.related.length) return issue.text;
    return issue.text + " (also: " + issue.related.map(function (i) { return "#" + i; }).join(", ") + ")";
  }
  function fmtIssueMd(issue) {
    if (!issue.related || !issue.related.length) return mdEsc(issue.text);
    var refs = issue.related.map(function (i) {
      var other = allResults[i - 1];
      return "#" + i + " `" + mdEsc(other ? other.selector : "") + "`";
    });
    return mdEsc(issue.text) + " (also: " + refs.join(", ") + ")";
  }

  // Resolve element refs for outline + click-to-scroll. Outline colour reflects
  // status: red dashed for issues, amber dashed for redundant-role-only, thin
  // gray for valid usage (so auditors can see the ARIA footprint at a glance).
  allResults.forEach(function (r) {
    var doc;
    if (r.isTop) doc = document;
    else if (r.iframeEl) { try { doc = r.iframeEl.contentDocument; } catch (e) { doc = null; } }
    if (!doc) return;
    try {
      var el = doc.querySelector(r.selector);
      if (el) {
        r._resolveEl = el;
        var hasError = r.issues.some(function (i) { return i.category !== "redundant-role"; });
        var hasRedundantOnly = r.issues.length > 0 && !hasError;
        if (hasError) {
          el.style.setProperty("outline", "2px dashed #b00020", "important");
        } else if (hasRedundantOnly) {
          el.style.setProperty("outline", "2px dashed #b45309", "important");
        } else {
          el.style.setProperty("outline", "1px dotted #999", "important");
        }
        el.style.setProperty("outline-offset", "1px", "important");
      }
    } catch (e) {}
  });

  // Shadow UI host
  var host = document.createElement("div");
  host.id = P + "host";
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "all:initial !important;position:absolute !important;top:0 !important;left:0 !important;width:0 !important;height:0 !important;margin:0 !important;padding:0 !important;border:0 !important;font:400 16px/1.4 ui-sans-serif,system-ui,sans-serif !important;color:#111 !important;pointer-events:none !important;z-index:2147483647 !important;";
  (document.body || document.documentElement).appendChild(host);
  var shadow = host.attachShadow({ mode: "closed" });

  var CATEGORY_COLORS = {
    "unknown-role":          "#b00020",
    "abstract-role":         "#b00020",
    "unknown-attr":          "#b00020",
    "bad-bool":              "#b45309",
    "bad-tristate":          "#b45309",
    "bad-idref":             "#b00020",
    "missing-required":      "#b00020",
    "presentation-conflict": "#b45309",
    "redundant-role":        "#b45309"
  };

  function rowStatus(r) {
    if (r.issues.length === 0) return "ok";
    if (r.issues.every(function (i) { return i.category === "redundant-role"; })) return "redundant";
    return "issues";
  }

  var css =
    ":host{all:initial;font-family:ui-sans-serif,system-ui,sans-serif !important;}" +
    "*,*::before,*::after{box-sizing:border-box;font-family:ui-sans-serif,system-ui,sans-serif !important;font-style:normal !important;font-weight:400 !important;font-variant:normal !important;text-transform:none !important;letter-spacing:normal !important;text-decoration:none !important;color:#111;}" +
    ".badge{position:absolute;background:#003876;color:#fff;font-size:16px;font-weight:600 !important;line-height:1.2;padding:4px 8px;border-radius:3px;pointer-events:none;max-width:380px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,.4);}" +
    ".badge.issues{background:#b00020;}" +
    ".badge.redundant{background:#b45309;}" +
    ".badge.ok{background:#666;}" +
    ".badge.frame{filter:saturate(0.7) brightness(0.9);}" +
    ".panel{position:fixed;top:12px;right:12px;width:560px;max-height:85vh;display:flex;flex-direction:column;background:#fff;color:#111;border:1px solid #bbb;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.25);font-size:16px;line-height:1.4;pointer-events:auto;}" +
    ".panel header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#003876;color:#fff;border-radius:6px 6px 0 0;}" +
    ".panel header strong{font-size:18px;font-weight:600 !important;color:#fff;}" +
    ".panel .btns{display:flex;gap:8px;}" +
    ".panel button{background:transparent;border:1px solid #fff;color:#fff;padding:6px 12px;border-radius:3px;cursor:pointer;font-size:16px;font-weight:500;line-height:1.2;}" +
    ".panel button:hover{background:rgba(255,255,255,.18);}" +
    ".panel .filterbar{display:flex;gap:6px;padding:8px 14px;border-bottom:1px solid #eee;background:#f5f7fa;}" +
    ".panel .filterbar button{border:1px solid #cfd6e0;background:#fff;color:#003876;padding:5px 12px;border-radius:3px;cursor:pointer;font-size:14px;font-weight:500;}" +
    ".panel .filterbar button.active{background:#003876;color:#fff !important;border-color:#003876;}" +
    ".panel .filterbar button:hover:not(.active){background:#eef4ff;}" +
    ".panel .summary{padding:10px 14px;border-bottom:1px solid #eee;background:#f5f7fa;font-size:16px;}" +
    ".panel .summary .miss{color:#b00020;font-weight:600 !important;}" +
    ".panel .summary .ok{color:#0a8043;font-weight:600 !important;}" +
    ".panel .summary .warn{color:#b45309;font-weight:600 !important;}" +
    ".panel ol{margin:0;padding:0;list-style:none;overflow:auto;flex:1 1 auto;}" +
    ".panel li{padding:10px 14px;border-bottom:1px solid #eee;cursor:pointer;font-size:16px;border-left:4px solid transparent;}" +
    ".panel li:hover{background:#eef4ff;}" +
    ".panel li.status-issues{border-left-color:#b00020;}" +
    ".panel li.status-redundant{border-left-color:#b45309;}" +
    ".panel li.status-ok{border-left-color:#0a8043;}" +
    ".panel.filter-issues li.status-ok,.panel.filter-issues li.status-redundant{display:none;}" +
    ".panel.filter-redundant li.status-ok,.panel.filter-redundant li.status-issues{display:none;}" +
    ".panel li .statuschip{flex:0 0 auto;display:inline-block;min-width:80px;text-align:center;padding:3px 8px;border-radius:3px;color:#fff !important;font-size:13px;font-weight:700 !important;line-height:1.2;margin-right:8px;}" +
    ".panel li .statuschip.issues{background:#b00020;}" +
    ".panel li .statuschip.redundant{background:#b45309;}" +
    ".panel li .statuschip.ok{background:#0a8043;}" +
    ".panel li .row{display:flex;align-items:center;}" +
    ".panel li .meta{color:#555;font-size:14px;margin-bottom:2px;flex:1 1 auto;}" +
    ".panel li .frame-label{color:#0a5d2e;font-weight:600;}" +
    ".panel li .attrs{margin-top:4px;font-size:14px;display:flex;flex-wrap:wrap;gap:6px;}" +
    ".panel li .attrchip{background:rgba(0,0,0,.06);color:#333;padding:2px 6px;border-radius:3px;font-family:ui-monospace,monospace !important;font-size:13px;word-break:break-all;}" +
    ".panel li .attrchip.bad{background:#fde2e2;color:#b00020;}" +
    ".panel li .attrchip.redundant{background:#fdf3e2;color:#b45309;}" +
    ".panel li .issues-block{margin-top:6px;font-size:14px;}" +
    ".panel li .issue{display:flex;gap:8px;margin-top:2px;}" +
    ".panel li .issue .catchip{flex:0 0 auto;display:inline-block;padding:2px 6px;border-radius:3px;color:#fff !important;font-size:12px;font-weight:700 !important;line-height:1.3;}" +
    ".panel li .issue .text{flex:1 1 auto;color:#111;font-weight:600 !important;}" +
    ".panel li .src{color:#666;font-size:14px;font-style:italic;margin-top:4px;word-break:break-all;}" +
    ".panel code{font-family:ui-monospace,monospace !important;font-size:14px;background:rgba(0,0,0,.06);padding:1px 5px;border-radius:3px;}";

  var styleEl = document.createElement("style");
  styleEl.textContent = css;
  shadow.appendChild(styleEl);

  // Badges. Every ARIA-using element gets a badge, with colour by status.
  // Issues are red, redundant-only are amber, valid usage is gray (so the
  // page is visibly annotated with the ARIA footprint).
  var badges = [];
  allResults.forEach(function (r) {
    if (!r.positioned) return;
    var status = rowStatus(r);
    var badge = document.createElement("div");
    var cls = "badge " + status;
    if (!r.isTop) cls += " frame";
    badge.className = cls;
    var prefix = r.isTop ? "" : "[frame] ";
    var summaryText;
    if (status === "issues" || status === "redundant") {
      summaryText = r.issues.length + " issue" + (r.issues.length === 1 ? "" : "s") + " — " + r.issues[0].text;
    } else {
      var roleDesc = r.roleAttr ? 'role="' + r.roleAttr + '"' : (r.ariaAttrs.length + " aria-* attr" + (r.ariaAttrs.length === 1 ? "" : "s"));
      summaryText = "valid ARIA — " + roleDesc;
    }
    badge.textContent = "#" + r.index + " " + prefix + r.tag + ": " + summaryText;
    badge.style.top = (r.pageTop - 28) + "px";
    badge.style.left = r.pageLeft + "px";
    shadow.appendChild(badge);
    badges.push(badge);
    r.badge = badge;
  });

  // Markdown
  function mdEsc(s) { return String(s).replace(/\|/g, "\\|").replace(/\n+/g, " "); }
  var md = "| # | Frame | Element | Status | role | Implicit role | ARIA attrs | Issues | Selector |\n";
  md += "|---|-------|---------|--------|------|---------------|------------|--------|----------|\n";
  allResults.forEach(function (r) {
    var attrs = r.ariaAttrs.map(function (a) { return a.name + '="' + mdEsc(a.value) + '"'; }).join(" ");
    var issuesCell = r.issues.length ? "⚠ " + r.issues.map(fmtIssueMd).join("; ") : "";
    var frameLabel = r.isTop ? "(top)" : mdEsc(r.frameLabel || r.frameUrl);
    md += "| " + r.index + " | " + frameLabel + " | `" + r.tag + "` | " + rowStatus(r) + " | " + (r.roleAttr ? "`" + mdEsc(r.roleAttr) + "`" : "") + " | " + (r.implicitRole ? "`" + mdEsc(r.implicitRole) + "`" : "") + " | `" + mdEsc(attrs) + "` | " + issuesCell + " | `" + mdEsc(r.selector) + "` |\n";
  });

  var totalIssues = allResults.reduce(function (a, r) { return a + r.issues.filter(function (i) { return i.category !== "redundant-role"; }).length; }, 0);
  var totalRedundant = allResults.reduce(function (a, r) { return a + r.issues.filter(function (i) { return i.category === "redundant-role"; }).length; }, 0);
  var issueRowCount = allResults.filter(function (r) { return rowStatus(r) === "issues"; }).length;
  var redundantRowCount = allResults.filter(function (r) { return rowStatus(r) === "redundant"; }).length;
  var okRowCount = allResults.filter(function (r) { return rowStatus(r) === "ok"; }).length;
  var frameCount = framesData.filter(function (f) { return !f.isTop && f.results && f.results.length; }).length;

  console.group("%c[a11yn aria] " + allResults.length + " ARIA-using elements (" + issueRowCount + " with issues, " + redundantRowCount + " redundant-only, " + okRowCount + " valid) — top doc + " + frameCount + " frame(s)",
    "color:#003876;font-weight:bold;font-size:13px");
  console.table(allResults.map(function (r) {
    return {
      "#": r.index,
      frame: r.isTop ? "(top)" : (r.frameLabel || r.frameUrl),
      element: r.tag,
      status: rowStatus(r),
      role: r.roleAttr || "",
      implicitRole: r.implicitRole || "",
      ariaAttrs: r.ariaAttrs.map(function (a) { return a.name; }).join(" "),
      issues: r.issues.map(fmtIssuePanel).join("; ")
    };
  }));
  console.log("%cMarkdown table:", "font-weight:bold");
  console.log(md);
  console.groupEnd();

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }

  var panelEl = document.createElement("div");
  // The filter classes (filter-all / filter-issues / filter-redundant) drive
  // CSS-based show/hide so we don't need to re-render the list on toggle.
  panelEl.className = "panel filter-all";

  var summary = "";
  if (allResults.length === 0) {
    summary += '<span class="warn">No elements use role or aria-* attributes on this page.</span>';
  } else if (issueRowCount === 0 && redundantRowCount === 0) {
    summary += '<span class="ok">All ' + allResults.length + ' ARIA-using element' + (allResults.length === 1 ? "" : "s") + ' look valid.</span>';
  } else {
    var bits = [];
    if (issueRowCount) bits.push('<span class="miss">' + totalIssues + " issue" + (totalIssues === 1 ? "" : "s") + " across " + issueRowCount + " element" + (issueRowCount === 1 ? "" : "s") + "</span>");
    if (redundantRowCount) bits.push('<span class="warn">' + redundantRowCount + " redundant role" + (redundantRowCount === 1 ? "" : "s") + "</span>");
    summary += bits.join(" · ");
  }
  summary += '<div style="margin-top:6px;color:#555;font-size:14px">';
  summary += allResults.length + " ARIA-using element" + (allResults.length === 1 ? "" : "s") + " on page (" + okRowCount + " valid, " + redundantRowCount + " redundant, " + issueRowCount + " with issues) · top doc";
  if (frameCount) summary += " + " + frameCount + " frame" + (frameCount === 1 ? "" : "s");
  if (unmatchedFrames) summary += " · ⚠ " + unmatchedFrames + " unpositioned frame(s)";
  summary += "</div>";

  panelEl.innerHTML =
    "<header><strong>ARIA Usage (" + allResults.length + ")</strong>" +
    '<div class="btns"><button id="' + P + 'copy">Copy MD</button><button id="' + P + 'close">Close</button></div></header>' +
    '<div class="filterbar">' +
      '<button data-filter="all" class="active">All (' + allResults.length + ')</button>' +
      '<button data-filter="issues">Issues (' + issueRowCount + ')</button>' +
      '<button data-filter="redundant">Redundant (' + redundantRowCount + ')</button>' +
    '</div>' +
    '<div class="summary">' + summary + "</div>" +
    '<ol id="' + P + 'list"></ol>';

  // Identify which attribute names appear in issues, so we can highlight the
  // offending ones as red attribute chips.
  function attrIsImplicatedInIssue(attrName, issues) {
    for (var i = 0; i < issues.length; i++) {
      if (issues[i].text.indexOf(attrName) !== -1) return true;
    }
    return false;
  }
  function attrIsImplicatedInRedundant(attrName, issues) {
    if (attrName !== "role") return false;
    return issues.some(function (i) { return i.category === "redundant-role"; });
  }

  var list = panelEl.querySelector("#" + P + "list");
  allResults.forEach(function (r) {
    var status = rowStatus(r);
    var li = document.createElement("li");
    li.classList.add("status-" + status);
    var location = r.isTop ? "" : '<span class="frame-label">[' + esc(r.frameLabel || r.frameUrl) + ']</span> ';
    var attrChips = r.ariaAttrs.map(function (a) {
      var bad = attrIsImplicatedInIssue(a.name, r.issues);
      var redundant = attrIsImplicatedInRedundant(a.name, r.issues);
      var chipClass = "attrchip";
      if (bad) chipClass += " bad";
      else if (redundant) chipClass += " redundant";
      return '<span class="' + chipClass + '"><code>' + esc(a.name) + (a.value ? "=" + esc(JSON.stringify(a.value)) : "") + "</code></span>";
    }).join("");

    var issuesHtml = r.issues.map(function (issue) {
      var color = CATEGORY_COLORS[issue.category] || "#b00020";
      return '<div class="issue"><span class="catchip" style="background:' + color + '">' + esc(issue.category) + '</span><span class="text">' + esc(fmtIssuePanel(issue)) + "</span></div>";
    }).join("");

    var statusChipLabel = status === "issues" ? "ISSUES" : (status === "redundant" ? "redundant" : "ok");
    var implicitNote = r.implicitRole ? ' <span style="color:#999;font-size:13px">(implicit: ' + esc(r.implicitRole) + ')</span>' : "";

    li.innerHTML =
      '<div class="row">' +
        '<span class="statuschip ' + status + '">' + esc(statusChipLabel) + '</span>' +
        '<span class="meta">#' + r.index + " " + location + "<code>&lt;" + esc(r.tag) + "&gt;</code>" + implicitNote + "</span>" +
      "</div>" +
      '<div class="attrs">' + attrChips + "</div>" +
      (issuesHtml ? '<div class="issues-block">' + issuesHtml + "</div>" : "") +
      '<div class="src">' + esc(r.selector) + "</div>";

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

  // Filter bar toggling: swap the panel's filter-* class so CSS controls display.
  panelEl.querySelectorAll(".filterbar button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var filter = btn.dataset.filter;
      panelEl.className = "panel filter-" + filter;
      panelEl.querySelectorAll(".filterbar button").forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
    });
  });

  // Drag-by-header
  (function () {
    var header = panelEl.querySelector("header");
    if (!header) return;
    header.style.cursor = "move";
    header.style.userSelect = "none";
    header.style.touchAction = "none";
    var dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    header.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest("button")) return;
      var rect = panelEl.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
      startX = e.clientX; startY = e.clientY;
      dragging = true;
      panelEl.style.left = startLeft + "px";
      panelEl.style.top = startTop + "px";
      panelEl.style.right = "auto";
      try { header.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    header.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var newLeft = startLeft + (e.clientX - startX);
      var newTop = startTop + (e.clientY - startY);
      var minLeft = 40 - panelEl.offsetWidth;
      var maxLeft = window.innerWidth - 40;
      var maxTop = window.innerHeight - 40;
      newLeft = Math.max(minLeft, Math.min(maxLeft, newLeft));
      newTop = Math.max(0, Math.min(maxTop, newTop));
      panelEl.style.left = newLeft + "px";
      panelEl.style.top = newTop + "px";
    });
    header.addEventListener("pointerup", function (e) {
      dragging = false;
      try { header.releasePointerCapture(e.pointerId); } catch (err) {}
    });
    header.addEventListener("pointercancel", function () { dragging = false; });
  })();

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
