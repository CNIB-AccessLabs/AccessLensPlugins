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
  aria:      { label: "ARIA Validation",  scan: scanAria,      display: displayAria      },
  contrast:  { label: "Colour Contrast",  scan: scanContrast,  display: displayContrast  },
  document:  { label: "Title & Language", scan: scanDocument,  display: displayDocument  }
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
  // Spread the entire frame result into the aggregated entry so checks
  // that return non-standard shapes (e.g. Title & Language returns title,
  // htmlLang, htmlXmlLang, langAttrs, hreflangLinks, foreignUrls,
  // embeddedLangs — none of which match the "results array" convention)
  // get all their fields through to displayXxx. Safety defaults are still
  // applied for the conventional fields the orchestrator depends on.
  const aggregated = injection.map(i => {
    const r = i.result || {};
    return Object.assign({}, r, {
      frameId: i.frameId,
      url: r.url || "",
      isTop: !!r.isTop,
      results: r.results || [],
      shadowRoots: r.shadowRoots || 0,
      error: r.error
    });
  });
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

    function isVisuallyHidden(el) {
      try {
        var s = window.getComputedStyle(el);
        if (!s) return false;
        if (s.position === "absolute" || s.position === "fixed") {
          if (s.clip === "rect(1px, 1px, 1px, 1px)" || s.clip === "rect(0px, 0px, 0px, 0px)" ||
              s.clip === "rect(0, 0, 0, 0)") return true;
          if (s.width === "1px" && s.height === "1px" && s.overflow === "hidden") return true;
          if (s.clipPath && s.clipPath.indexOf("inset(50%)") !== -1) return true;
        }
        return false;
      } catch (e) { return false; }
    }

    function hiddenReason(el) {
      try {
        if (el.getAttribute("aria-hidden") === "true") return "aria-hidden";
        var s = window.getComputedStyle(el);
        if (!s) return null;
        if (s.display === "none") return "display:none";
        if (s.visibility === "hidden") return "visibility:hidden";
        if (parseFloat(s.opacity) === 0) return "opacity:0";
        return null;
      } catch (e) { return null; }
    }

    function walk(root) {
      var matches;
      try { matches = root.querySelectorAll(SELECTOR); } catch (e) { return; }
      Array.prototype.forEach.call(matches, function (el) {
        if (seenEls.has(el)) return;
        seenEls.add(el);
        var r;
        try { r = el.getBoundingClientRect(); } catch (e) { return; }
        // Capture visibility state instead of filtering — show all discovered
        // headings, mark hidden ones so the auditor sees the full inventory
        // (which often reveals sr-only nav headings, leftover hidden h1s, etc.)
        var hidden = isHidden(el);
        var hReason = hidden ? hiddenReason(el) : null;
        var visuallyHidden = !hidden && isVisuallyHidden(el);

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
          hidden: hidden,
          hiddenReason: hReason,
          visuallyHidden: visuallyHidden,
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
        hidden: r.hidden,
        hiddenReason: r.hiddenReason,
        visuallyHidden: r.visuallyHidden,
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

  // Issue analysis. Hidden headings (display:none, visibility:hidden,
  // aria-hidden, opacity:0) are EXCLUDED from issue calculations — they
  // don't affect document outline navigation, so flagging "multiple h1"
  // because one of them is hidden would be misleading. They're still
  // listed in the panel with a "hidden" indicator so the auditor can see
  // them, but they're treated as not contributing to the visible structure.
  var visibleResults = allResults.filter(function (r) { return !r.hidden; });
  var h1Indices = visibleResults.filter(function (r) { return r.level === 1; }).map(function (r) { return r.index; });
  var h1Count = h1Indices.length;
  var hiddenCount = allResults.filter(function (r) { return r.hidden; }).length;
  var prevValidLevel = 0;
  var prevValidIndex = null;
  allResults.forEach(function (r) {
    r.issues = [];
    if (r.hidden) return; // hidden headings don't get issues — they're inventory-only
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

  // Resolve element references for outline + click-to-scroll. Hidden headings
  // get no outline (there's nothing to outline) but the panel row still links
  // back to the element for inspection in DevTools.
  allResults.forEach(function (r) {
    var doc;
    if (r.isTop) doc = document;
    else if (r.iframeEl) { try { doc = r.iframeEl.contentDocument; } catch (e) { doc = null; } }
    if (!doc) return;
    try {
      var el = doc.querySelector(r.selector);
      if (el) {
        r._resolveEl = el;
        if (!r.hidden) {
          var color = r.issues.length ? "#b00020" : "#003876";
          var style = r.issues.length ? "dashed" : "solid";
          el.style.setProperty("outline", "2px " + style + " " + color, "important");
          el.style.setProperty("outline-offset", "1px", "important");
        }
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
    ".panel .filterbar{display:flex;gap:6px;padding:8px 14px;border-bottom:1px solid #eee;background:#f5f7fa;flex-wrap:wrap;}" +
    ".panel .filterbar button{border:1px solid #cfd6e0;background:#fff;color:#003876;padding:5px 10px;border-radius:3px;cursor:pointer;font-size:13px;font-weight:500;}" +
    ".panel .filterbar button.active{background:#003876;color:#fff !important;border-color:#003876;}" +
    ".panel .filterbar button:hover:not(.active){background:#eef4ff;}" +
    ".panel .summary{padding:10px 14px;border-bottom:1px solid #eee;background:#f5f7fa;font-size:16px;}" +
    ".panel .summary .issue{color:#b00020;font-weight:600 !important;}" +
    ".panel .summary .ok{color:#0a8043;font-weight:600 !important;}" +
    ".panel .summary .warn{color:#b45309;font-weight:600 !important;}" +
    ".panel ol{margin:0;padding:0;list-style:none;overflow:auto;flex:1 1 auto;}" +
    ".panel li{padding:8px 14px 8px 0;border-bottom:1px solid #eee;cursor:pointer;font-size:16px;display:flex;align-items:flex-start;gap:10px;}" +
    ".panel li:hover{background:#eef4ff;}" +
    ".panel li.frame-tag{border-left:3px solid #0a5d2e;}" +
    ".panel li.has-issues{border-left:3px solid #b00020;}" +
    ".panel li.is-hidden{opacity:0.6;background:#fafafa;}" +
    ".panel li.is-hidden .text{font-style:italic;}" +
    ".panel.filter-issues li:not(.has-issues){display:none;}" +
    ".panel.filter-visible li.is-hidden{display:none;}" +
    ".panel.filter-hidden li:not(.is-hidden){display:none;}" +
    ".panel li .gutter{flex:0 0 auto;width:14px;color:#999;font-size:14px;text-align:right;}" +
    ".panel li .levelchip{flex:0 0 auto;display:inline-block;min-width:40px;text-align:center;padding:3px 8px;border-radius:3px;background:#003876;color:#fff !important;font-size:14px;font-weight:700 !important;line-height:1.2;}" +
    ".panel li .levelchip.aria{background:#0a5d2e;}" +
    ".panel li .levelchip.unknown{background:#b45309;}" +
    ".panel li .levelchip.outofrange{background:#b00020;}" +
    ".panel li .levelchip.hidden{background:#888;}" +
    ".panel li .body{flex:1 1 auto;min-width:0;}" +
    ".panel li .meta{color:#555;font-size:14px;margin-bottom:2px;}" +
    ".panel li .frame-label{color:#0a5d2e;font-weight:600;}" +
    ".panel li .hidden-tag{display:inline-block;background:#666;color:#fff !important;padding:1px 6px;border-radius:2px;font-size:11px;font-weight:600 !important;text-transform:uppercase;margin-left:6px;letter-spacing:0.5px;}" +
    ".panel li .sr-only-tag{background:#0a5d2e;}" +
    ".panel li .text{font-weight:600 !important;color:#111;font-size:16px;word-break:break-word;}" +
    ".panel li .text.empty{color:#b00020;font-style:italic;font-weight:600 !important;}" +
    ".panel li .issues{color:#b00020;font-size:14px;margin-top:3px;font-weight:600 !important;}" +
    ".panel li .src{color:#666;font-size:14px;font-style:italic;margin-top:2px;word-break:break-all;}" +
    ".panel code{font-family:ui-monospace,monospace !important;font-size:14px;background:rgba(0,0,0,.06);padding:1px 5px;border-radius:3px;}";

  var styleEl = document.createElement("style");
  styleEl.textContent = css;
  shadow.appendChild(styleEl);

  // Badges. Skip hidden headings (no visible box to badge over) but they
  // still appear in the panel list with a "HIDDEN" tag so the auditor can
  // see them — useful for finding stale or sr-only headings.
  var badges = [];
  allResults.forEach(function (r) {
    if (!r.positioned) return;
    if (r.hidden) return; // no badge for hidden headings
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
  panelEl.className = "panel filter-all";

  var summary = "";
  if (allResults.length === 0) {
    summary += '<span class="warn">No headings found.</span>';
  } else if (issueCount === 0) {
    summary += '<span class="ok">All ' + visibleResults.length + ' visible heading' + (visibleResults.length === 1 ? "" : "s") + ' look structurally valid.</span>';
  } else {
    summary += '<span class="issue">' + issueCount + " of " + visibleResults.length + " visible heading" + (visibleResults.length === 1 ? "" : "s") + " have issues.</span>";
  }
  summary += '<div style="margin-top:6px;color:#555;font-size:14px">';
  summary += h1Count + ' h1' + (h1Count === 1 ? "" : "s") + " · " + visibleResults.length + " visible";
  if (hiddenCount) summary += " · " + hiddenCount + " hidden";
  summary += " · top doc";
  if (frameCount) summary += " + " + frameCount + " frame" + (frameCount === 1 ? "" : "s");
  if (unmatchedFrames) summary += " · ⚠ " + unmatchedFrames + " unpositioned frame(s)";
  summary += '</div>';

  panelEl.innerHTML =
    "<header><strong>Headings (" + allResults.length + ")</strong>" +
    '<div class="btns"><button id="' + P + 'copy">Copy MD</button><button id="' + P + 'close">Close</button></div></header>' +
    '<div class="filterbar">' +
      '<button data-filter="all" class="active">All (' + allResults.length + ')</button>' +
      '<button data-filter="visible">Visible only (' + visibleResults.length + ')</button>' +
      '<button data-filter="hidden">Hidden only (' + hiddenCount + ')</button>' +
      '<button data-filter="issues">Issues (' + issueCount + ')</button>' +
    '</div>' +
    '<div class="summary">' + summary + "</div>" +
    '<ol id="' + P + 'list"></ol>';

  var list = panelEl.querySelector("#" + P + "list");
  allResults.forEach(function (r) {
    var li = document.createElement("li");
    if (!r.isTop) li.classList.add("frame-tag");
    if (r.issues.length) li.classList.add("has-issues");
    if (r.hidden) li.classList.add("is-hidden");

    // Indent gutter based on level (use 18px per level; cap at level 6)
    var indentLevel = (r.level !== null && r.level >= 1 && r.level <= 6) ? r.level - 1 : 0;
    li.style.paddingLeft = (10 + indentLevel * 18) + "px";

    var chipClass = "levelchip";
    if (r.hidden) chipClass += " hidden";
    else if (r.level === null) chipClass += " unknown";
    else if (r.level < 1 || r.level > 6) chipClass += " outofrange";
    else if (r.levelSource === "aria-level") chipClass += " aria";
    var chipText = r.level !== null ? "H" + r.level : "H?";

    var location = r.isTop ? "" : '<span class="frame-label">[' + esc(r.frameLabel || r.frameUrl) + ']</span> ';
    var levelExplain = "";
    if (r.levelSource === "aria-level") levelExplain = ' <span style="color:#0a5d2e">(via aria-level)</span>';
    else if (r.level === null) levelExplain = ' <span style="color:#b45309">(no aria-level)</span>';
    else if (r.level < 1 || r.level > 6) levelExplain = ' <span style="color:#b00020">(out of range)</span>';

    var hiddenTag = "";
    if (r.hidden) hiddenTag = ' <span class="hidden-tag">hidden · ' + esc(r.hiddenReason || "?") + '</span>';
    else if (r.visuallyHidden) hiddenTag = ' <span class="hidden-tag sr-only-tag">sr-only</span>';

    li.innerHTML =
      '<span class="gutter">' + r.index + "</span>" +
      '<span class="' + chipClass + '">' + esc(chipText) + "</span>" +
      '<div class="body">' +
        '<div class="meta">' + location + "<code>" + esc(r.tag) + "</code>" + levelExplain + hiddenTag + "</div>" +
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

  // Wire the filter bar (All / Visible only / Hidden only / Issues)
  panelEl.querySelectorAll(".filterbar button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var filter = btn.dataset.filter;
      panelEl.className = "panel filter-" + filter;
      panelEl.querySelectorAll(".filterbar button").forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
    });
  });

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
        // Push EVERY landmark candidate to results, including those that
        // don't qualify (e.g. <header> inside <article>, <section> without
        // a name). Non-landmarks are tagged isLandmark:false with a
        // human-readable reason — the panel renders them in the main list
        // so the auditor sees the complete inventory of candidates, not
        // just the ones that became landmarks.
        if (role.role === null) {
          results.push({
            tag: el.tagName.toLowerCase(),
            role: null,
            roleExplicit: false,
            isLandmark: false,
            notLandmarkReason: role.note || "no implicit role",
            name: accname.name,
            nameSrc: accname.src,
            selector: uniqueSelector(el),
            rect: { top: r.top, left: r.left, width: r.width, height: r.height }
          });
          return;
        }
        results.push({
          tag: el.tagName.toLowerCase(),
          role: role.role,
          isLandmark: true,
          notLandmarkReason: null,
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
      shadowRoots: shadowRoots
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
  // Non-landmarks are now part of allResults (marked isLandmark:false).
  // We still compute a count for the summary line. (Older variable name kept
  // so the rest of the rendering code didn't need wholesale changes.)
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
        isLandmark: r.isLandmark !== false, // default true if undefined (legacy)
        notLandmarkReason: r.notLandmarkReason || null,
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
  });
  allResults.forEach(function (r, i) { r.index = i + 1; });

  // Populate the count of non-landmark candidates for the summary line.
  allSkipped = allResults.filter(function (r) { return !r.isLandmark; });

  // Issues. Issues that involve other elements carry their related indices so
  // the panel and Markdown output can reference every involved element, not
  // just the current one. Non-landmarks are excluded — they don't have a
  // role and so can't have role-related issues.
  var byRole = {};
  allResults.forEach(function (r) {
    if (!r.isLandmark) return;
    if (!byRole[r.role]) byRole[r.role] = [];
    byRole[r.role].push(r);
  });

  allResults.forEach(function (r) {
    r.issues = [];
    if (!r.isLandmark) return; // non-landmarks: no role-related issues
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
    ".panel .filterbar{display:flex;gap:6px;padding:8px 14px;border-bottom:1px solid #eee;background:#f5f7fa;flex-wrap:wrap;}" +
    ".panel .filterbar button{border:1px solid #cfd6e0;background:#fff;color:#003876;padding:5px 10px;border-radius:3px;cursor:pointer;font-size:13px;font-weight:500;}" +
    ".panel .filterbar button.active{background:#003876;color:#fff !important;border-color:#003876;}" +
    ".panel .filterbar button:hover:not(.active){background:#eef4ff;}" +
    ".panel .summary{padding:10px 14px;border-bottom:1px solid #eee;background:#f5f7fa;font-size:16px;}" +
    ".panel .summary .issue{color:#b00020;font-weight:600 !important;}" +
    ".panel .summary .ok{color:#0a8043;font-weight:600 !important;}" +
    ".panel .summary .warn{color:#b45309;font-weight:600 !important;}" +
    ".panel ol{margin:0;padding:0;list-style:none;overflow:auto;flex:1 1 auto;}" +
    ".panel li{padding:10px 14px;border-bottom:1px solid #eee;cursor:pointer;font-size:16px;display:flex;align-items:flex-start;gap:10px;}" +
    ".panel li:hover{background:#eef4ff;}" +
    ".panel li.has-issues{border-left:3px solid #b00020;}" +
    ".panel li.not-landmark{background:#fafafa;opacity:0.85;}" +
    ".panel.filter-landmarks li.not-landmark{display:none;}" +
    ".panel.filter-non-landmarks li:not(.not-landmark){display:none;}" +
    ".panel.filter-issues li:not(.has-issues){display:none;}" +
    ".panel li .gutter{flex:0 0 auto;width:18px;color:#999;font-size:14px;text-align:right;}" +
    ".panel li .rolechip{flex:0 0 auto;display:inline-block;min-width:100px;text-align:center;padding:4px 10px;border-radius:3px;color:#fff !important;font-size:14px;font-weight:700 !important;line-height:1.2;}" +
    ".panel li .rolechip.not-landmark{background:#999;}" +
    ".panel li .body{flex:1 1 auto;min-width:0;}" +
    ".panel li .meta{color:#555;font-size:14px;margin-bottom:2px;}" +
    ".panel li .frame-label{color:#0a5d2e;font-weight:600;}" +
    ".panel li .name{font-weight:600 !important;color:#111;font-size:16px;word-break:break-word;}" +
    ".panel li .name.unnamed{color:#666;font-style:italic;font-weight:400 !important;}" +
    ".panel li .reason{margin-top:4px;font-size:14px;color:#7a4a09;font-style:italic;}" +
    ".panel li .issues{color:#b00020;font-size:14px;margin-top:4px;font-weight:600 !important;}" +
    ".panel li .src{color:#666;font-size:14px;font-style:italic;margin-top:2px;word-break:break-all;}" +
    ".panel code{font-family:ui-monospace,monospace !important;font-size:14px;background:rgba(0,0,0,.06);padding:1px 5px;border-radius:3px;}";

  var styleEl = document.createElement("style");
  styleEl.textContent = css;
  shadow.appendChild(styleEl);

  // Badges. Only qualifying landmarks get badges on the page — non-landmark
  // candidates (e.g. <section> without a name) are visible in the panel but
  // we don't tag them on the page because they're not part of the AT-visible
  // structure.
  var badges = [];
  allResults.forEach(function (r) {
    if (!r.positioned) return;
    if (!r.isLandmark) return;
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
    var roleStr = r.isLandmark
      ? (r.role + (r.roleExplicit ? " (explicit)" : ""))
      : "*(not a landmark)*";
    var name = r.name ? mdEsc(r.name) : (r.isLandmark ? "*(no name)*" : "");
    var notes = r.isLandmark
      ? (r.issues.length ? "⚠ " + r.issues.map(fmtIssueMd).join("; ") : "")
      : mdEsc(r.notLandmarkReason || "");
    var frameLabel = r.isTop ? "(top)" : mdEsc(r.frameLabel || r.frameUrl);
    md += "| " + r.index + " | " + frameLabel + " | " + roleStr + " | `" + r.tag + "` | " + name + " | " + (r.nameSrc || "") + " | " + notes + " | `" + mdEsc(r.selector) + "` |\n";
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

  var landmarkCount = allResults.filter(function (r) { return r.isLandmark; }).length;
  var nonLandmarkCount = allSkipped.length;

  var panelEl = document.createElement("div");
  panelEl.className = "panel filter-all";

  var summary = "";
  if (allResults.length === 0) {
    summary += '<span class="warn">No landmarks or landmark candidates found on this page.</span>';
  } else if (issueCount === 0) {
    summary += '<span class="ok">All ' + landmarkCount + ' landmark' + (landmarkCount === 1 ? "" : "s") + ' look structurally valid.</span>';
  } else {
    summary += '<span class="issue">' + issueCount + " of " + landmarkCount + " landmark" + (landmarkCount === 1 ? "" : "s") + " have issues.</span>";
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
  if (nonLandmarkCount) summary += " · " + nonLandmarkCount + " non-landmark candidate(s)";
  summary += '</div>';

  panelEl.innerHTML =
    "<header><strong>Landmarks (" + allResults.length + ")</strong>" +
    '<div class="btns"><button id="' + P + 'copy">Copy MD</button><button id="' + P + 'close">Close</button></div></header>' +
    '<div class="filterbar">' +
      '<button data-filter="all" class="active">All (' + allResults.length + ')</button>' +
      '<button data-filter="landmarks">Landmarks (' + landmarkCount + ')</button>' +
      '<button data-filter="non-landmarks">Non-landmarks (' + nonLandmarkCount + ')</button>' +
      '<button data-filter="issues">Issues (' + issueCount + ')</button>' +
    '</div>' +
    '<div class="summary">' + summary + "</div>" +
    '<ol id="' + P + 'list"></ol>';

  var list = panelEl.querySelector("#" + P + "list");
  allResults.forEach(function (r) {
    var li = document.createElement("li");
    if (r.issues.length) li.classList.add("has-issues");
    if (!r.isLandmark) li.classList.add("not-landmark");

    var chipColor = r.isLandmark ? (ROLE_COLORS[r.role] || "#003876") : "#999";
    var chipText = r.isLandmark ? r.role : "not landmark";
    var chipClass = "rolechip" + (r.isLandmark ? "" : " not-landmark");
    var location = r.isTop ? "" : '<span class="frame-label">[' + esc(r.frameLabel || r.frameUrl) + ']</span> ';
    var explicitNote = r.isLandmark && r.roleExplicit ? ' <span style="color:#555">(role="' + esc(r.role) + '")</span>' : "";

    var bodyHtml;
    if (r.isLandmark) {
      bodyHtml =
        '<div class="meta">' + location + "<code>&lt;" + esc(r.tag) + "&gt;</code>" + explicitNote + (r.nameSrc ? ' <span style="color:#999">· via ' + esc(r.nameSrc) + "</span>" : "") + "</div>" +
        '<div class="name' + (r.name ? "" : " unnamed") + '">' + (r.name ? esc(r.name) : "(no accessible name)") + "</div>" +
        (r.issues.length ? '<div class="issues">⚠ ' + esc(r.issues.map(fmtIssuePanel).join("; ")) + "</div>" : "") +
        '<div class="src">' + esc(r.selector) + "</div>";
    } else {
      bodyHtml =
        '<div class="meta">' + location + "<code>&lt;" + esc(r.tag) + "&gt;</code></div>" +
        (r.name ? '<div class="name">' + esc(r.name) + " <span style=\"color:#999;font-size:13px\">(via " + esc(r.nameSrc) + ")</span></div>" : "") +
        '<div class="reason">' + esc(r.notLandmarkReason) + "</div>" +
        '<div class="src">' + esc(r.selector) + "</div>";
    }

    li.innerHTML =
      '<span class="gutter">' + r.index + "</span>" +
      '<span class="' + chipClass + '" style="background:' + chipColor + '">' + esc(chipText) + "</span>" +
      '<div class="body">' + bodyHtml + "</div>";

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

  // Wire the filter bar (All / Landmarks / Non-landmarks / Issues)
  panelEl.querySelectorAll(".filterbar button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var filter = btn.dataset.filter;
      panelEl.className = "panel filter-" + filter;
      panelEl.querySelectorAll(".filterbar button").forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
    });
  });

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

/* ====================================================================
 * CHECK: CONTRAST — text colour contrast inspector (WCAG 1.4.3 / 1.4.6)
 *
 * Mirrors the rule set from CNIB-AccessLabs/auto_a11y's contrast tests.
 * Per-element classification:
 *
 *   pass             contrast meets WCAG AA (4.5:1 normal text, 3:1 large)
 *   pass-warn        meets ratio inside container BUT one or more caveats
 *                    apply that may invalidate the calculation (gradient,
 *                    image, animation, overflow, z-index combined with
 *                    something else) — manual review recommended
 *   fail-aa          contrast inside container fails AA
 *   partial-fail     fails inside AND text overflows the container, so we
 *                    only know about the inside portion; overflowing part
 *                    might be against a different background
 *   cannot-calculate background is gradient / image / transparent /
 *                    stops at a z-index stacking context — automated
 *                    calculation isn't reliable, manual review required
 *
 * Each result carries a caveats[] list so the panel and Markdown both
 * show every reason the calculation might be off.
 *
 * Large text: ≥24px normal OR ≥18.66px bold. Bold = font-weight ≥ 700.
 *
 * Background resolution walks up the DOM compositing semi-transparent
 * layers via Porter-Duff "source-over". Stops at:
 *   - first fully opaque background
 *   - z-index stacking context (marks the result as needing review)
 *   - root (defaults missing background to white, like the browser does)
 *
 * Text nodes are walked via TreeWalker. Excluded:
 *   - empty / whitespace-only text
 *   - display:none, visibility:hidden, opacity:0 (with ancestors)
 *   - common visually-hidden / sr-only patterns
 *
 * AAA mode is computed alongside AA so the panel can surface "passes AA
 * but fails AAA" as additional info. Default reporting level is AA.
 *
 * KNOWN LIMITATIONS vs the auto_a11y reference implementation:
 *   - Multi-breakpoint testing. auto_a11y resizes the viewport to every
 *     CSS-declared media-query breakpoint. A live extension can only test
 *     the user's current viewport. Workaround: resize the browser window
 *     and re-run the check.
 *   - Pseudoclass states. auto_a11y parses CSS rules to compute :hover,
 *     :focus, :visited, :active, :link colour-state contrasts. v1 of this
 *     check tests only the default state.
 *   - prefers-contrast media queries are not separately evaluated.
 *   These are listed in the panel summary so the auditor knows what the
 *   check did NOT cover.
 * ==================================================================== */

function scanContrast() {
  "use strict";
  try {
    /* ----- helpers: colour parsing, luminance, ratio, compositing ----- */

    // Cache a canvas for color-name parsing (browser-converts via fillStyle).
    var _canvas, _ctx;
    function ensureCanvas() {
      if (_canvas) return;
      _canvas = document.createElement("canvas");
      _canvas.width = _canvas.height = 1;
      _ctx = _canvas.getContext("2d");
    }

    function parseColor(str) {
      if (!str || str === "transparent" || str === "none") return { r: 0, g: 0, b: 0, a: 0 };
      // rgba / rgb fast path (most common; getComputedStyle returns these)
      var m = str.match(/rgba?\(\s*(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)(?:[ ,/]+([\d.]+%?))?\s*\)/i);
      if (m) {
        var a = m[4] !== undefined ? (m[4].slice(-1) === "%" ? parseFloat(m[4]) / 100 : parseFloat(m[4])) : 1;
        return { r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]), a: a };
      }
      // 6-digit hex
      var h6 = str.match(/^#([0-9a-f]{6})$/i);
      if (h6) {
        return { r: parseInt(h6[1].substr(0, 2), 16), g: parseInt(h6[1].substr(2, 2), 16), b: parseInt(h6[1].substr(4, 2), 16), a: 1 };
      }
      // 3-digit hex
      var h3 = str.match(/^#([0-9a-f]{3})$/i);
      if (h3) {
        return { r: parseInt(h3[1][0] + h3[1][0], 16), g: parseInt(h3[1][1] + h3[1][1], 16), b: parseInt(h3[1][2] + h3[1][2], 16), a: 1 };
      }
      // Named colors, hsl(), oklch(), etc. — let the browser convert via canvas
      try {
        ensureCanvas();
        _ctx.clearRect(0, 0, 1, 1);
        _ctx.fillStyle = "rgba(0,0,0,0)";
        _ctx.fillRect(0, 0, 1, 1);
        _ctx.fillStyle = str;
        _ctx.fillRect(0, 0, 1, 1);
        var d = _ctx.getImageData(0, 0, 1, 1).data;
        return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
      } catch (e) {
        return { r: 0, g: 0, b: 0, a: 0 };
      }
    }

    function colorToRgbaString(c) {
      return "rgba(" + c.r + ", " + c.g + ", " + c.b + ", " + (Math.round(c.a * 1000) / 1000) + ")";
    }
    function colorToHex(c) {
      function h(v) { var s = Math.max(0, Math.min(255, v)).toString(16); return s.length < 2 ? "0" + s : s; }
      return "#" + h(c.r) + h(c.g) + h(c.b);
    }

    function relLuminance(c) {
      function ch(v) {
        v = v / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      }
      return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
    }

    function contrastRatio(c1, c2) {
      var l1 = relLuminance(c1), l2 = relLuminance(c2);
      var lo = Math.min(l1, l2), hi = Math.max(l1, l2);
      return (hi + 0.05) / (lo + 0.05);
    }

    // Porter-Duff source-over composite: `over` painted on top of `base`.
    function compositeOver(over, base) {
      var a = over.a + base.a * (1 - over.a);
      if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
      return {
        r: Math.round((over.r * over.a + base.r * base.a * (1 - over.a)) / a),
        g: Math.round((over.g * over.a + base.g * base.a * (1 - over.a)) / a),
        b: Math.round((over.b * over.a + base.b * base.a * (1 - over.a)) / a),
        a: a
      };
    }

    /* ----- helpers: visibility filters ----- */

    function getStyle(el) {
      try {
        var win = el.ownerDocument && el.ownerDocument.defaultView;
        return (win || window).getComputedStyle(el);
      } catch (e) { return null; }
    }

    function isHiddenWithAncestors(el) {
      var c = el;
      while (c && c.nodeType === 1) {
        var s = getStyle(c);
        if (!s) return false;
        if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0) return true;
        c = c.parentElement;
      }
      return false;
    }

    function isVisuallyHidden(el) {
      var s = getStyle(el);
      if (!s) return false;
      // Common sr-only patterns
      if (s.position === "absolute" || s.position === "fixed") {
        if (s.clip === "rect(1px, 1px, 1px, 1px)" || s.clip === "rect(0px, 0px, 0px, 0px)" ||
            s.clip === "rect(0, 0, 0, 0)") return true;
        if (s.width === "1px" && s.height === "1px" && s.overflow === "hidden") return true;
        // clip-path inset 50% (modern sr-only)
        if (s.clipPath && s.clipPath.indexOf("inset(50%)") !== -1) return true;
      }
      return false;
    }

    /* ----- complex-bg detection (gradients, images, video) ----- */

    function hasComplexBg(bgImage) {
      if (!bgImage || bgImage === "none") return { hasGradient: false, hasImage: false };
      var lower = bgImage.toLowerCase();
      return {
        hasGradient: lower.indexOf("gradient") !== -1,
        hasImage: lower.indexOf("url(") !== -1
      };
    }

    /* ----- effective background by walking up the DOM ----- */

    function getEffectiveBackground(el) {
      var cur = el;
      var composited = { r: 0, g: 0, b: 0, a: 0 };
      var stoppedAtZIndex = false;
      var zEl = null, zVal = null, zPos = null;
      var hasGradient = false, hasImage = false;

      while (cur && cur.nodeType === 1 && composited.a < 1) {
        var s = getStyle(cur);
        if (!s) break;
        var complex = hasComplexBg(s.backgroundImage);
        if (complex.hasGradient) hasGradient = true;
        if (complex.hasImage) hasImage = true;

        var bg = parseColor(s.backgroundColor);
        if (bg.a > 0) composited = compositeOver(composited, bg);

        // z-index stacking context: anything could be painted on top of us
        // that we can't see from here
        var zi = s.zIndex, pos = s.position;
        if (zi !== "auto" && zi !== "" && (pos === "absolute" || pos === "relative" || pos === "fixed" || pos === "sticky")) {
          stoppedAtZIndex = true; zEl = cur; zVal = zi; zPos = pos;
          break;
        }

        if (composited.a >= 1 && !hasGradient && !hasImage) break;
        cur = cur.parentElement;
      }

      // Reached root without finding opaque bg: browser uses white by default
      if (composited.a < 1 && !hasGradient && !hasImage) {
        composited = compositeOver(composited, { r: 255, g: 255, b: 255, a: 1 });
      }

      return {
        bg: composited,
        stoppedAtZIndex: stoppedAtZIndex,
        zIndexElement: zEl,
        zIndexValue: zVal,
        zIndexPosition: zPos,
        hasGradient: hasGradient,
        hasImage: hasImage
      };
    }

    /* ----- text overflow ----- */

    function checkTextOverflow(el) {
      var er, p, pr;
      try {
        er = el.getBoundingClientRect();
        p = el.parentElement;
        if (!p) return { hasOverflow: false };
        pr = p.getBoundingClientRect();
      } catch (e) { return { hasOverflow: false }; }
      var overflows =
        er.top < pr.top - 0.5 || er.bottom > pr.bottom + 0.5 ||
        er.left < pr.left - 0.5 || er.right > pr.right + 0.5;
      return overflows ? { hasOverflow: true, containerTag: p.tagName.toLowerCase() } : { hasOverflow: false };
    }

    /* ----- animation / long transition detection ----- */

    function getAnimationInfo(el) {
      var c = el;
      while (c && c.nodeType === 1) {
        var s = getStyle(c);
        if (!s) break;
        var animName = s.animationName || s.webkitAnimationName || "";
        if (animName && animName !== "none") {
          return { hasAnimation: true, type: "CSS animation", name: animName, tag: c.tagName.toLowerCase() };
        }
        var trans = s.transition || s.webkitTransition || "";
        var transDur = s.transitionDuration || "0s";
        var maxDur = 0;
        transDur.split(",").forEach(function (d) {
          d = d.trim();
          var v = parseFloat(d);
          if (isNaN(v)) return;
          if (d.slice(-2) === "ms") v /= 1000;
          if (v > maxDur) maxDur = v;
        });
        if (maxDur > 0.5 && trans && (
          trans.indexOf("color") !== -1 || trans.indexOf("background") !== -1 ||
          trans.indexOf("opacity") !== -1 || trans.indexOf("all") !== -1
        )) {
          return { hasAnimation: true, type: "CSS transition (>" + maxDur.toFixed(1) + "s)", name: trans, tag: c.tagName.toLowerCase() };
        }
        c = c.parentElement;
      }
      return { hasAnimation: false };
    }

    /* ----- unique selector (same as other checks) ----- */

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

    /* ----- main scan ----- */

    var results = [];
    var seenEls = new Set();
    var shadowRoots = 0;
    var viewport = { width: window.innerWidth, height: window.innerHeight };

    function processElement(el, textSample) {
      if (seenEls.has(el)) return;
      seenEls.add(el);
      if (isHiddenWithAncestors(el)) return;
      if (isVisuallyHidden(el)) return;
      var rect;
      try { rect = el.getBoundingClientRect(); } catch (e) { return; }
      if (rect.width === 0 && rect.height === 0) return;

      var s = getStyle(el);
      if (!s) return;
      var fg = parseColor(s.color);
      var fontSize = parseFloat(s.fontSize);
      var fontWeight = parseInt(s.fontWeight, 10) || 400;
      var isBold = fontWeight >= 700;
      // Per WCAG: ≥18pt (24px) normal OR ≥14pt (~18.66px) bold
      var isLargeText = fontSize >= 24 || (fontSize >= 18.66 && isBold);

      var bgInfo = getEffectiveBackground(el);
      var overflowInfo = checkTextOverflow(el);
      var animInfo = getAnimationInfo(el);

      // Composite fg with bg in case fg has alpha < 1 (rare but happens)
      var fgComposited = fg.a < 1 ? compositeOver(fg, bgInfo.bg) : fg;

      // Build caveats list — every reason this calculation might be off
      var caveats = [];
      if (bgInfo.hasGradient) caveats.push({ code: "gradient-bg", text: "background contains a gradient — calculation uses only the underlying solid colour" });
      if (bgInfo.hasImage) caveats.push({ code: "image-bg", text: "background contains an image — actual pixel under text may differ from the underlying colour" });
      if (bgInfo.stoppedAtZIndex) caveats.push({ code: "z-index", text: 'walked into a z-index stacking context (<' + bgInfo.zIndexElement.tagName.toLowerCase() + '> position:' + bgInfo.zIndexPosition + ', z-index:' + bgInfo.zIndexValue + ') — could be overlapped by floating content' });
      if (animInfo.hasAnimation) caveats.push({ code: "animation", text: animInfo.type + ' on ancestor <' + animInfo.tag + '> — colours change over time' });
      if (overflowInfo.hasOverflow) caveats.push({ code: "overflow", text: "text overflows its <" + overflowInfo.containerTag + "> container — overflowing portion may sit on a different background" });

      // Decide whether we can calculate at all
      var canCalculate = bgInfo.bg.a >= 1 && !bgInfo.hasGradient && !bgInfo.hasImage;

      var ratio = null;
      var passesAA = false;
      var passesAAA = false;
      var requiredAA = isLargeText ? 3 : 4.5;
      var requiredAAA = isLargeText ? 4.5 : 7;

      if (canCalculate) {
        // Skip if text and bg are identical — likely a data error rather than a real failure
        if (fgComposited.r === bgInfo.bg.r && fgComposited.g === bgInfo.bg.g && fgComposited.b === bgInfo.bg.b) {
          return;
        }
        ratio = contrastRatio(fgComposited, bgInfo.bg);
        ratio = Math.round(ratio * 100) / 100;
        passesAA = ratio >= requiredAA;
        passesAAA = ratio >= requiredAAA;
      }

      // Determine status
      // Note on z-index: per auto_a11y, "z-index alone" should NOT push us to
      // cannot-calculate when contrast passes; it only matters when combined
      // with other issues. So we keep the caveat but allow pass/fail.
      var status;
      if (!canCalculate) {
        status = "cannot-calculate";
      } else if (!passesAA) {
        if (overflowInfo.hasOverflow) status = "partial-fail";
        else status = "fail-aa";
      } else {
        // Passes AA. Are there caveats that make it pass-warn?
        // z-index alone is not enough — only "real" calculation-affecting caveats.
        var blockingCaveats = caveats.filter(function (c) {
          return c.code === "gradient-bg" || c.code === "image-bg" || c.code === "animation" || c.code === "overflow";
        });
        status = blockingCaveats.length > 0 ? "pass-warn" : "pass";
      }

      results.push({
        tag: el.tagName.toLowerCase(),
        text: (textSample || "").substring(0, 120),
        fg: colorToRgbaString(fgComposited),
        fgHex: colorToHex(fgComposited),
        bg: colorToRgbaString(bgInfo.bg),
        bgHex: colorToHex(bgInfo.bg),
        ratio: ratio,
        passesAA: passesAA,
        passesAAA: passesAAA,
        requiredAA: requiredAA,
        requiredAAA: requiredAAA,
        fontSize: fontSize,
        fontWeight: fontWeight,
        isBold: isBold,
        isLargeText: isLargeText,
        status: status,
        caveats: caveats,
        canCalculate: canCalculate,
        selector: uniqueSelector(el),
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
      });
    }

    function walk(root) {
      // TreeWalker over text nodes inside `root`. Shadow roots use the same
      // mechanism (createTreeWalker accepts any node).
      var doc = root.ownerDocument || (root.nodeType === 9 ? root : document);
      var walker;
      try {
        walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode: function (node) {
            if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
            var p = node.parentElement;
            if (!p) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        });
      } catch (e) { return; }

      var node;
      while ((node = walker.nextNode())) {
        processElement(node.parentElement, node.textContent.trim());
      }

      // Recurse into shadow roots
      var allElements;
      try { allElements = root.querySelectorAll("*"); } catch (e) { allElements = []; }
      Array.prototype.forEach.call(allElements, function (el) {
        if (el.shadowRoot) { shadowRoots++; walk(el.shadowRoot); }
      });
    }

    walk(document.body || document.documentElement);

    return {
      url: window.location.href,
      isTop: window === window.top,
      results: results,
      shadowRoots: shadowRoots,
      viewport: viewport
    };
  } catch (e) {
    return { url: window.location.href, isTop: window === window.top, results: [], error: String(e && e.message || e) };
  }
}

function displayContrast(framesData, checkId) {
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
  var viewport = null;
  framesData.forEach(function (frame) {
    if (!frame || frame.error) return;
    if (frame.isTop && frame.viewport) viewport = frame.viewport;
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
        tag: r.tag, text: r.text,
        fg: r.fg, fgHex: r.fgHex, bg: r.bg, bgHex: r.bgHex,
        ratio: r.ratio,
        passesAA: r.passesAA, passesAAA: r.passesAAA,
        requiredAA: r.requiredAA, requiredAAA: r.requiredAAA,
        fontSize: r.fontSize, fontWeight: r.fontWeight,
        isBold: r.isBold, isLargeText: r.isLargeText,
        status: r.status, caveats: r.caveats, canCalculate: r.canCalculate,
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

  // Issues for Markdown / console — populated from caveats and status
  allResults.forEach(function (r) {
    r.issues = r.caveats.map(function (c) { return { text: c.text, related: [] }; });
  });

  function fmtIssuePanel(issue) {
    if (!issue.related || !issue.related.length) return issue.text;
    return issue.text + " (also: " + issue.related.map(function (i) { return "#" + i; }).join(", ") + ")";
  }
  function fmtIssueMd(issue) {
    return mdEsc(issue.text);
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
        if (r.status === "fail-aa" || r.status === "partial-fail") { color = "#b00020"; style = "dashed"; }
        else if (r.status === "pass-warn") { color = "#b45309"; style = "dashed"; }
        else if (r.status === "cannot-calculate") { color = "#6a1b9a"; style = "dashed"; }
        else { color = "#0a8043"; style = "solid"; }
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
    "pass":             "#0a8043",
    "pass-warn":        "#b45309",
    "fail-aa":          "#b00020",
    "partial-fail":     "#b00020",
    "cannot-calculate": "#6a1b9a"
  };
  var STATUS_LABELS = {
    "pass":             "pass",
    "pass-warn":        "pass-warn",
    "fail-aa":          "FAIL",
    "partial-fail":     "PARTIAL",
    "cannot-calculate": "cannot calc"
  };

  var css =
    ":host{all:initial;font-family:ui-sans-serif,system-ui,sans-serif !important;}" +
    "*,*::before,*::after{box-sizing:border-box;font-family:ui-sans-serif,system-ui,sans-serif !important;font-style:normal !important;font-weight:400 !important;font-variant:normal !important;text-transform:none !important;letter-spacing:normal !important;text-decoration:none !important;color:#111;}" +
    ".badge{position:absolute;background:#003876;color:#fff;font-size:16px;font-weight:600 !important;line-height:1.2;padding:4px 8px;border-radius:3px;pointer-events:none;max-width:380px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,.4);}" +
    ".badge.pass{background:#0a8043;}" +
    ".badge.pass-warn{background:#b45309;}" +
    ".badge.fail-aa,.badge.partial-fail{background:#b00020;}" +
    ".badge.cannot-calculate{background:#6a1b9a;}" +
    ".badge.frame{filter:saturate(0.7) brightness(0.9);}" +
    ".panel{position:fixed;top:12px;right:12px;width:560px;max-height:85vh;display:flex;flex-direction:column;background:#fff;color:#111;border:1px solid #bbb;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.25);font-size:16px;line-height:1.4;pointer-events:auto;}" +
    ".panel header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#003876;color:#fff;border-radius:6px 6px 0 0;}" +
    ".panel header strong{font-size:18px;font-weight:600 !important;color:#fff;}" +
    ".panel .btns{display:flex;gap:8px;}" +
    ".panel button{background:transparent;border:1px solid #fff;color:#fff;padding:6px 12px;border-radius:3px;cursor:pointer;font-size:16px;font-weight:500;line-height:1.2;}" +
    ".panel button:hover{background:rgba(255,255,255,.18);}" +
    ".panel .filterbar{display:flex;gap:6px;padding:8px 14px;border-bottom:1px solid #eee;background:#f5f7fa;flex-wrap:wrap;}" +
    ".panel .filterbar button{border:1px solid #cfd6e0;background:#fff;color:#003876;padding:5px 10px;border-radius:3px;cursor:pointer;font-size:13px;font-weight:500;}" +
    ".panel .filterbar button.active{background:#003876;color:#fff !important;border-color:#003876;}" +
    ".panel .filterbar button:hover:not(.active){background:#eef4ff;}" +
    ".panel .summary{padding:10px 14px;border-bottom:1px solid #eee;background:#f5f7fa;font-size:16px;}" +
    ".panel .summary .miss{color:#b00020;font-weight:600 !important;}" +
    ".panel .summary .ok{color:#0a8043;font-weight:600 !important;}" +
    ".panel .summary .warn{color:#b45309;font-weight:600 !important;}" +
    ".panel .limits{padding:8px 14px;background:#faf5e6;border-bottom:1px solid #eee;font-size:13px;color:#7a4a09;}" +
    ".panel .limits strong{color:#7a4a09;font-weight:600 !important;}" +
    ".panel ol{margin:0;padding:0;list-style:none;overflow:auto;flex:1 1 auto;}" +
    ".panel li{padding:10px 14px;border-bottom:1px solid #eee;cursor:pointer;font-size:16px;border-left:4px solid transparent;}" +
    ".panel li:hover{background:#eef4ff;}" +
    ".panel li.status-fail-aa,.panel li.status-partial-fail{border-left-color:#b00020;}" +
    ".panel li.status-pass-warn{border-left-color:#b45309;}" +
    ".panel li.status-cannot-calculate{border-left-color:#6a1b9a;}" +
    ".panel li.status-pass{border-left-color:#0a8043;}" +
    ".panel.filter-fail li:not(.status-fail-aa):not(.status-partial-fail){display:none;}" +
    ".panel.filter-warn li:not(.status-pass-warn){display:none;}" +
    ".panel.filter-cannot li:not(.status-cannot-calculate){display:none;}" +
    ".panel.filter-pass li:not(.status-pass){display:none;}" +
    ".panel li .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}" +
    ".panel li .statuschip{flex:0 0 auto;display:inline-block;min-width:88px;text-align:center;padding:3px 8px;border-radius:3px;color:#fff !important;font-size:13px;font-weight:700 !important;line-height:1.2;}" +
    ".panel li .ratio{flex:0 0 auto;font-weight:600 !important;font-size:16px;color:#111;}" +
    ".panel li .ratio.fail{color:#b00020;}" +
    ".panel li .meta{flex:1 1 auto;color:#555;font-size:14px;min-width:120px;}" +
    ".panel li .frame-label{color:#0a5d2e;font-weight:600;}" +
    ".panel li .swatches{display:flex;gap:4px;margin-top:6px;align-items:center;font-size:13px;color:#555;}" +
    ".panel li .swatch{display:inline-block;width:20px;height:20px;border:1px solid #999;border-radius:2px;flex-shrink:0;}" +
    ".panel li .textsample{margin-top:4px;font-size:14px;color:#333;font-style:italic;word-break:break-word;}" +
    ".panel li .caveats{margin-top:6px;font-size:13px;}" +
    ".panel li .caveat{display:flex;gap:6px;margin-top:2px;color:#7a4a09;}" +
    ".panel li .caveat::before{content:'⚠';flex:0 0 auto;}" +
    ".panel li .src{color:#666;font-size:14px;font-style:italic;margin-top:4px;word-break:break-all;}" +
    ".panel code{font-family:ui-monospace,monospace !important;font-size:13px;background:rgba(0,0,0,.06);padding:1px 5px;border-radius:3px;}";

  var styleEl = document.createElement("style");
  styleEl.textContent = css;
  shadow.appendChild(styleEl);

  // Badges
  var badges = [];
  allResults.forEach(function (r) {
    if (!r.positioned) return;
    var badge = document.createElement("div");
    var cls = "badge " + r.status;
    if (!r.isTop) cls += " frame";
    badge.className = cls;
    var prefix = r.isTop ? "" : "[frame] ";
    var ratioStr = r.ratio != null ? r.ratio.toFixed(2) + ":1" : "n/a";
    badge.textContent = "#" + r.index + " " + prefix + r.tag + " " + STATUS_LABELS[r.status] + " " + ratioStr;
    badge.style.top = (r.pageTop - 28) + "px";
    badge.style.left = r.pageLeft + "px";
    shadow.appendChild(badge);
    badges.push(badge);
    r.badge = badge;
  });

  // Markdown
  function mdEsc(s) { return String(s).replace(/\|/g, "\\|").replace(/\n+/g, " "); }
  var md = "| # | Frame | Status | Ratio | Required | Text size | Foreground | Background | Caveats | Selector |\n";
  md += "|---|-------|--------|-------|----------|-----------|------------|------------|---------|----------|\n";
  allResults.forEach(function (r) {
    var ratioCell = r.ratio != null ? r.ratio.toFixed(2) + ":1" : "—";
    var required = r.requiredAA + ":1" + (r.isLargeText ? " (large)" : " (normal)");
    var sizeCell = r.fontSize + "px" + (r.isBold ? " bold" : "");
    var caveats = r.caveats.length ? "⚠ " + r.caveats.map(function (c) { return mdEsc(c.text); }).join("; ") : "";
    var frameLabel = r.isTop ? "(top)" : mdEsc(r.frameLabel || r.frameUrl);
    md += "| " + r.index + " | " + frameLabel + " | " + r.status + " | " + ratioCell + " | " + required + " | " + sizeCell + " | `" + r.fgHex + "` | `" + r.bgHex + "` | " + caveats + " | `" + mdEsc(r.selector) + "` |\n";
  });

  // Tallies
  var counts = { pass: 0, "pass-warn": 0, "fail-aa": 0, "partial-fail": 0, "cannot-calculate": 0 };
  allResults.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
  var frameCount = framesData.filter(function (f) { return !f.isTop && f.results && f.results.length; }).length;
  var failCount = counts["fail-aa"] + counts["partial-fail"];

  console.group("%c[a11yn contrast] " + allResults.length + " text elements — fail:" + failCount + " warn:" + counts["pass-warn"] + " cannot-calc:" + counts["cannot-calculate"] + " pass:" + counts.pass + " — top doc + " + frameCount + " frame(s)",
    "color:#003876;font-weight:bold;font-size:13px");
  console.table(allResults.map(function (r) {
    return {
      "#": r.index,
      frame: r.isTop ? "(top)" : (r.frameLabel || r.frameUrl),
      tag: r.tag,
      status: r.status,
      ratio: r.ratio != null ? r.ratio.toFixed(2) + ":1" : "—",
      required: r.requiredAA + ":1",
      large: r.isLargeText ? "Y" : "",
      bold: r.isBold ? "Y" : "",
      size: r.fontSize + "px",
      fg: r.fgHex,
      bg: r.bgHex,
      caveats: r.caveats.map(function (c) { return c.code; }).join(",")
    };
  }));
  console.log("%cMarkdown table:", "font-weight:bold");
  console.log(md);
  console.groupEnd();

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }

  var panelEl = document.createElement("div");
  panelEl.className = "panel filter-all";

  var summary = "";
  if (allResults.length === 0) {
    summary += '<span class="warn">No visible text found.</span>';
  } else if (failCount === 0 && counts["pass-warn"] === 0 && counts["cannot-calculate"] === 0) {
    summary += '<span class="ok">All ' + counts.pass + ' text elements pass WCAG AA.</span>';
  } else {
    var bits = [];
    if (failCount) bits.push('<span class="miss">' + failCount + ' fail WCAG AA</span>');
    if (counts["pass-warn"]) bits.push('<span class="warn">' + counts["pass-warn"] + ' pass-with-caveats</span>');
    if (counts["cannot-calculate"]) bits.push('<span class="warn">' + counts["cannot-calculate"] + ' cannot calculate</span>');
    summary += bits.join(" · ");
  }
  summary += '<div style="margin-top:6px;color:#555;font-size:14px">';
  summary += counts.pass + " pass · " + counts["pass-warn"] + " pass-warn · " + counts["fail-aa"] + " fail · " + counts["partial-fail"] + " partial-fail · " + counts["cannot-calculate"] + " cannot-calc · top doc";
  if (frameCount) summary += " + " + frameCount + " frame" + (frameCount === 1 ? "" : "s");
  if (unmatchedFrames) summary += " · ⚠ " + unmatchedFrames + " unpositioned frame(s)";
  summary += '</div>';

  var limits =
    '<strong>Limitations of this v1 check:</strong> ' +
    "tested only at the current viewport (" + (viewport ? viewport.width + "×" + viewport.height + "px" : "unknown") + ") — resize the browser and re-run to test other breakpoints. " +
    "Pseudoclass states (<code>:hover</code>, <code>:focus</code>, <code>:visited</code>, <code>:active</code>, <code>:link</code>) and <code>prefers-contrast</code> media queries are not separately evaluated. " +
    "Use ANDI, auto_a11y, or axe DevTools for those.";

  panelEl.innerHTML =
    "<header><strong>Contrast (" + allResults.length + ")</strong>" +
    '<div class="btns"><button id="' + P + 'copy">Copy MD</button><button id="' + P + 'close">Close</button></div></header>' +
    '<div class="filterbar">' +
      '<button data-filter="all" class="active">All (' + allResults.length + ')</button>' +
      '<button data-filter="fail">Fail (' + failCount + ')</button>' +
      '<button data-filter="warn">Warn (' + counts["pass-warn"] + ')</button>' +
      '<button data-filter="cannot">Cannot calc (' + counts["cannot-calculate"] + ')</button>' +
      '<button data-filter="pass">Pass (' + counts.pass + ')</button>' +
    '</div>' +
    '<div class="summary">' + summary + '</div>' +
    '<div class="limits">' + limits + '</div>' +
    '<ol id="' + P + 'list"></ol>';

  var list = panelEl.querySelector("#" + P + "list");
  allResults.forEach(function (r) {
    var li = document.createElement("li");
    li.classList.add("status-" + r.status);
    var location = r.isTop ? "" : '<span class="frame-label">[' + esc(r.frameLabel || r.frameUrl) + ']</span> ';
    var ratioStr = r.ratio != null ? r.ratio.toFixed(2) + ":1" : "—";
    var ratioClass = (r.status === "fail-aa" || r.status === "partial-fail") ? "ratio fail" : "ratio";
    var sizeStr = r.fontSize + "px" + (r.isBold ? " bold" : "") + " · " + (r.isLargeText ? "large" : "normal") + " (req " + r.requiredAA + ":1)";

    var caveatsHtml = r.caveats.length
      ? '<div class="caveats">' + r.caveats.map(function (c) { return '<div class="caveat">' + esc(c.text) + '</div>'; }).join("") + '</div>'
      : "";

    var aaaInfo = "";
    if (r.canCalculate && r.passesAA && !r.passesAAA) {
      aaaInfo = ' · <span style="color:#b45309">fails AAA (' + r.requiredAAA + ':1)</span>';
    } else if (r.canCalculate && r.passesAAA) {
      aaaInfo = ' · <span style="color:#0a8043">passes AAA</span>';
    }

    li.innerHTML =
      '<div class="row">' +
        '<span class="statuschip" style="background:' + STATUS_COLORS[r.status] + '">' + esc(STATUS_LABELS[r.status]) + '</span>' +
        '<span class="' + ratioClass + '">' + ratioStr + '</span>' +
        '<span class="meta">#' + r.index + " " + location + "<code>&lt;" + esc(r.tag) + "&gt;</code> " + esc(sizeStr) + aaaInfo + '</span>' +
      "</div>" +
      '<div class="textsample">"' + esc(r.text) + '"</div>' +
      '<div class="swatches">' +
        '<span class="swatch" style="background:' + esc(r.fg) + '"></span>' +
        '<code>' + esc(r.fgHex) + '</code>' +
        '<span style="margin:0 8px">on</span>' +
        '<span class="swatch" style="background:' + esc(r.bg) + '"></span>' +
        '<code>' + esc(r.bgHex) + '</code>' +
      "</div>" +
      caveatsHtml +
      '<div class="src">' + esc(r.selector) + '</div>';

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

  panelEl.querySelectorAll(".filterbar button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var filter = btn.dataset.filter;
      panelEl.className = "panel filter-" + filter;
      panelEl.querySelectorAll(".filterbar button").forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
    });
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
 * CHECK: DOCUMENT — page title + language inspector
 *
 * Covers:
 *   WCAG 2.4.2  Page Titled
 *   WCAG 3.1.1  Language of Page
 *   WCAG 3.1.2  Language of Parts
 *
 * What it inspects:
 *   1. <title>: presence, emptiness, generic/suspicious values, duplicates.
 *   2. <html lang> and <html xml:lang>: presence, BCP 47 structural validity,
 *      RFC 5646 case canonicalization, value mismatch between lang and
 *      xml:lang on the same element.
 *   3. Every other element with lang or xml:lang — full inventory, not just
 *      problematic ones. Same validation as the html element. Cross-check
 *      between lang and xml:lang on the same element.
 *   4. Links with hreflang — validate the hreflang value (BCP 47).
 *   5. Links whose href contains a URL-path or query-string language hint
 *      (e.g. "/fr/page.html", "?lang=de") that differs from the page lang
 *      and which has no hreflang — flagged as a Language-of-Parts risk
 *      (3.1.2). Heuristic — auditor must verify the linked document's actual
 *      content language.
 *   6. Text attributes (alt, aria-label, title, placeholder, etc.) that
 *      contain a literal "lang=" substring or HTML markup — smell that the
 *      author tried to embed language declarations inside an attribute,
 *      which is unparsed text and won't work.
 *
 * BCP 47 case conventions per RFC 5646 §2.1.1:
 *   language  lowercase    (en, fr, zh)
 *   script    TitleCase    (Latn, Hans)
 *   region    UPPERCASE alpha or digits  (CA, US, 419)
 *   variants  lowercase    (rozaj, 1996)
 *
 * Region subtags are validated against the ISO 3166-1 alpha-2 registry
 * plus UN M.49 three-digit codes. Region affects which dialect voice a
 * screen reader picks, so a wrong/unregistered region means the user
 * gets the wrong pronunciation model — that's a real accessibility cost,
 * not just a registry-maintenance concern.
 * ==================================================================== */

function scanDocument() {
  "use strict";
  try {

    /* ----- Curated subtag tables ----- */

    // ISO 639-1 / 639-2 common language subtags. We curate rather than
    // include the entire 639 registry — the user is auditing web pages
    // and the long tail rarely appears in real-world HTML.
    var COMMON_LANGUAGES = new Set((
      "aa ab ae af ak am an ar as av ay az " +
      "ba be bg bh bi bm bn bo br bs " +
      "ca ce ch co cr cs cu cv cy " +
      "da de dv dz ee el en eo es et eu " +
      "fa ff fi fj fo fr fy " +
      "ga gd gl gn gu gv " +
      "ha he hi ho hr ht hu hy hz " +
      "ia id ie ig ii ik io is it iu " +
      "ja jv " +
      "ka kg ki kj kk kl km kn ko kr ks ku kv kw ky " +
      "la lb lg li ln lo lt lu lv " +
      "mg mh mi mk ml mn mr ms mt my " +
      "na nb nd ne ng nl nn no nr nv ny " +
      "oc oj om or os " +
      "pa pi pl ps pt " +
      "qu rm rn ro ru rw " +
      "sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw " +
      "ta te tg th ti tk tl tn to tr ts tt tw ty " +
      "ug uk ur uz " +
      "ve vi vo " +
      "wa wo " +
      "xh " +
      "yi yo " +
      "za zh zu " +
      // Common 3-letter codes seen in HTML
      "ace ach ady arn ast bal bem bho bin byn cad chk chm chr cmn dak div " +
      "doi efi eka fil fon fur gez gil gmh got gwi haw hil hmn ibb ilo inh " +
      "jbo jpr jrb kab kac kbd kha krc kru kut lad lez lol loz mad mag mai " +
      "mas mdf men mic min mnc mni moh mos mus myv nap nia niu nog nso nyn " +
      "pap pau peo phn pon raj rom rup sad sah sas sat scn sco sel shn smn " +
      "sog srn syr tem tig tiv tli tmh tog tpi tsi udm umb vai vot wae wal " +
      "war was xal yao yap zap zen zun zza"
    ).split(/\s+/));

    // ISO 3166-1 alpha-2 region subtags — these select dialect/regional
    // pronunciation models in screen readers. Stored as one string per BCP 47
    // group rather than a flat enumerated list.
    var REGION_SUBTAGS = new Set((
      "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ " +
      "BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
      "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ " +
      "DE DJ DK DM DO DZ " +
      "EC EE EG EH ER ES ET " +
      "FI FJ FK FM FO FR " +
      "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY " +
      "HK HM HN HR HT HU " +
      "ID IE IL IM IN IO IQ IR IS IT " +
      "JE JM JO JP " +
      "KE KG KH KI KM KN KP KR KW KY KZ " +
      "LA LB LC LI LK LR LS LT LU LV LY " +
      "MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
      "NA NC NE NF NG NI NL NO NP NR NU NZ " +
      "OM " +
      "PA PE PF PG PH PK PL PM PN PR PS PT PW PY " +
      "QA " +
      "RE RO RS RU RW " +
      "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ " +
      "TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ " +
      "UA UG UM US UY UZ " +
      "VA VC VE VG VI VN VU " +
      "WF WS " +
      "YE YT " +
      "ZA ZM ZW"
    ).split(/\s+/));

    // ISO 15924 script subtags, common subset. TitleCase by convention.
    var SCRIPT_SUBTAGS = new Set((
      "Arab Armn Beng Bopo Brai Cans Cher Cyrl Deva Ethi Geor Grek Gujr Guru " +
      "Hang Hani Hans Hant Hebr Hira Jpan Kana Khmr Knda Kore Laoo Latn Mlym " +
      "Mong Mymr Orya Sinh Taml Telu Tfng Thaa Thai Tibt Yiii Zsym Zxxx Zyyy"
    ).split(/\s+/));

    // UN M.49 three-digit region subtags (macro-regions / continents)
    var NUMERIC_REGIONS = new Set((
      "001 002 003 005 009 011 013 014 015 017 018 019 021 029 030 034 035 " +
      "039 053 054 057 061 142 143 145 150 151 154 155 202 419"
    ).split(/\s+/));

    /* ----- BCP 47 parser ----- */

    function parseBcp47(tag) {
      if (tag == null) return { present: false };
      var t = String(tag).trim();
      if (t === "") return { present: true, empty: true, raw: tag };
      // Must be ASCII letters / digits / dashes
      if (!/^[a-zA-Z0-9-]+$/.test(t)) {
        return { present: true, raw: tag, valid: false, error: "contains characters outside ASCII letters/digits/hyphens" };
      }
      // Hyphens can't be doubled or at edges
      if (t.indexOf("--") !== -1 || t.charAt(0) === "-" || t.charAt(t.length - 1) === "-") {
        return { present: true, raw: tag, valid: false, error: "hyphens must not be doubled or at the start/end" };
      }
      var parts = t.split("-");
      var result = { present: true, raw: tag, valid: true, language: null, extlangs: [], script: null, region: null, variants: [], extensions: [], privateUse: [] };

      // Grandfathered / private-use start with "i" or "x"
      if (parts[0].toLowerCase() === "x" && parts.length > 1) {
        result.language = null;
        result.isPrivateUseOnly = true;
        for (var j = 1; j < parts.length; j++) {
          if (!/^[a-zA-Z0-9]{1,8}$/.test(parts[j])) {
            return { present: true, raw: tag, valid: false, error: 'invalid private-use subtag "' + parts[j] + '"' };
          }
          result.privateUse.push(parts[j]);
        }
        result.canonical = "x-" + result.privateUse.map(function (p) { return p.toLowerCase(); }).join("-");
        return result;
      }

      // Primary language: 2-3 letters (ISO 639-1/2)
      if (!/^[a-zA-Z]{2,3}$/.test(parts[0])) {
        return { present: true, raw: tag, valid: false, error: 'primary language subtag should be 2 or 3 letters (got "' + parts[0] + '")' };
      }
      result.language = parts[0];
      var i = 1;

      // Optional extended languages (up to 3 × 3-letter)
      while (i < parts.length && /^[a-zA-Z]{3}$/.test(parts[i]) && result.extlangs.length < 3) {
        // Only treat as extlang if followed by something that's not a script/region/variant
        // Heuristic: if next part is 4 letters (script) or 2 letters (region) or 4+ alphanumeric (variant), this 3-letter could still be extlang
        // For simplicity, accept it as extlang and move on
        result.extlangs.push(parts[i]);
        i++;
      }

      // Optional script: exactly 4 letters
      if (i < parts.length && /^[a-zA-Z]{4}$/.test(parts[i])) {
        result.script = parts[i];
        i++;
      }

      // Optional region: 2 letters or 3 digits
      if (i < parts.length && /^([a-zA-Z]{2}|[0-9]{3})$/.test(parts[i])) {
        result.region = parts[i];
        i++;
      }

      // Variants: 5-8 alphanumeric, or 4 starting with digit
      while (i < parts.length && /^([a-zA-Z0-9]{5,8}|[0-9][a-zA-Z0-9]{3})$/.test(parts[i])) {
        result.variants.push(parts[i]);
        i++;
      }

      // Extensions: single letter (not x), then 2-8 char subtags
      while (i < parts.length && /^[a-wy-zA-WY-Z]$/.test(parts[i])) {
        var ext = [parts[i]];
        i++;
        while (i < parts.length && /^[a-zA-Z0-9]{2,8}$/.test(parts[i]) && !/^[a-wy-zA-WY-Z]$/.test(parts[i]) && parts[i].toLowerCase() !== "x") {
          ext.push(parts[i]);
          i++;
        }
        if (ext.length < 2) {
          return { present: true, raw: tag, valid: false, error: 'extension singleton "' + ext[0] + '" needs at least one subtag' };
        }
        result.extensions.push(ext);
      }

      // Private use suffix: "x" then 1-8 char subtags
      if (i < parts.length && parts[i].toLowerCase() === "x") {
        i++;
        while (i < parts.length) {
          if (!/^[a-zA-Z0-9]{1,8}$/.test(parts[i])) {
            return { present: true, raw: tag, valid: false, error: 'invalid private-use subtag "' + parts[i] + '"' };
          }
          result.privateUse.push(parts[i]);
          i++;
        }
      }

      if (i < parts.length) {
        return { present: true, raw: tag, valid: false, error: 'unexpected subtag "' + parts[i] + '" at position ' + (i + 1) };
      }

      result.canonical = canonicalize(result);
      return result;
    }

    function canonicalize(r) {
      var parts = [];
      if (r.language) parts.push(r.language.toLowerCase());
      r.extlangs.forEach(function (x) { parts.push(x.toLowerCase()); });
      if (r.script) parts.push(r.script.charAt(0).toUpperCase() + r.script.slice(1).toLowerCase());
      if (r.region) parts.push(/^[0-9]+$/.test(r.region) ? r.region : r.region.toUpperCase());
      r.variants.forEach(function (v) { parts.push(v.toLowerCase()); });
      r.extensions.forEach(function (e) { parts.push(e.map(function (s) { return s.toLowerCase(); }).join("-")); });
      if (r.privateUse.length) {
        parts.push("x");
        r.privateUse.forEach(function (p) { parts.push(p.toLowerCase()); });
      }
      return parts.join("-");
    }

    function validateTag(raw) {
      var p = parseBcp47(raw);
      if (!p.present) return { present: false, raw: null, valid: false, issues: [], warnings: [] };
      if (p.empty) {
        return { present: true, empty: true, raw: raw, valid: false, issues: ["empty value (lang=\"\")"], warnings: [] };
      }
      if (!p.valid) {
        return { present: true, raw: raw, valid: false, issues: ["structurally invalid: " + p.error], warnings: [] };
      }

      var issues = [];
      var warnings = [];

      // Case canonicalization check
      if (p.canonical !== p.raw) {
        var caseProblems = [];
        if (p.language && p.language !== p.language.toLowerCase()) {
          caseProblems.push('language subtag should be lowercase ("' + p.language.toLowerCase() + '", not "' + p.language + '")');
        }
        if (p.script && p.script !== p.script.charAt(0).toUpperCase() + p.script.slice(1).toLowerCase()) {
          var canScript = p.script.charAt(0).toUpperCase() + p.script.slice(1).toLowerCase();
          caseProblems.push('script subtag should be TitleCase ("' + canScript + '", not "' + p.script + '")');
        }
        if (p.region && /^[a-zA-Z]+$/.test(p.region) && p.region !== p.region.toUpperCase()) {
          caseProblems.push('region subtag should be UPPERCASE ("' + p.region.toUpperCase() + '", not "' + p.region + '")');
        }
        p.variants.forEach(function (v) {
          if (v !== v.toLowerCase()) {
            caseProblems.push('variant subtag should be lowercase ("' + v.toLowerCase() + '", not "' + v + '")');
          }
        });
        if (caseProblems.length) {
          issues.push("case convention: " + caseProblems.join("; ") + " (canonical: " + p.canonical + ")");
        }
      }

      // Subtag-value validation
      if (p.language) {
        var lang = p.language.toLowerCase();
        if (!COMMON_LANGUAGES.has(lang)) {
          warnings.push('language subtag "' + lang + '" is not in the curated common-languages list — verify it is an ISO 639 code');
        }
      }
      if (p.region) {
        var reg = /^[a-zA-Z]+$/.test(p.region) ? p.region.toUpperCase() : p.region;
        if (/^[a-zA-Z]+$/.test(p.region)) {
          if (!REGION_SUBTAGS.has(reg)) {
            issues.push('region subtag "' + reg + '" is not a registered ISO 3166-1 alpha-2 code — screen readers may not pick the intended dialect voice');
          }
        } else {
          if (!NUMERIC_REGIONS.has(reg)) {
            warnings.push('numeric region subtag "' + reg + '" is not a registered UN M.49 code');
          }
        }
      }
      if (p.script) {
        var sc = p.script.charAt(0).toUpperCase() + p.script.slice(1).toLowerCase();
        if (!SCRIPT_SUBTAGS.has(sc)) {
          warnings.push('script subtag "' + sc + '" is not in the curated ISO 15924 list — verify it is a real script code');
        }
      }

      return {
        present: true,
        raw: raw,
        valid: true,
        parsed: p,
        canonical: p.canonical,
        caseMatches: p.canonical === p.raw,
        issues: issues,
        warnings: warnings
      };
    }

    /* ----- DOM helpers ----- */

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

    function getXmlLang(el) {
      // Try the namespaced accessor first (correct way), fall back to literal attribute
      try {
        var ns = el.getAttributeNS && el.getAttributeNS("http://www.w3.org/XML/1998/namespace", "lang");
        if (ns !== null && ns !== undefined) return ns;
      } catch (e) {}
      return el.getAttribute("xml:lang");
    }

    function txt(s) { return (s == null ? "" : String(s)).replace(/\s+/g, " ").trim(); }

    /* ----- Title ----- */

    var titleEls = document.querySelectorAll("title");
    // Prefer titles in <head>
    var titleEl = null;
    for (var ti = 0; ti < titleEls.length; ti++) {
      if (titleEls[ti].ownerDocument === document &&
          (titleEls[ti].parentNode === document.head || titleEls[ti].closest("head"))) {
        titleEl = titleEls[ti]; break;
      }
    }
    if (!titleEl && titleEls.length) titleEl = titleEls[0];

    var titleText = titleEl ? txt(titleEl.textContent) : null;
    var titleResult = {
      present: !!titleEl,
      multipleTitles: titleEls.length,
      value: titleText,
      issues: []
    };
    if (!titleEl) {
      titleResult.issues.push({ severity: "error", text: "no <title> element in the document (WCAG 2.4.2)" });
    } else if (!titleText) {
      titleResult.issues.push({ severity: "error", text: "<title> exists but is empty (WCAG 2.4.2)" });
    } else {
      var lower = titleText.toLowerCase();
      var generic = /^(untitled|untitled document|new page|new tab|document|home page|home|page|index|default|test|untitled-?\d*)\.?$/;
      if (generic.test(lower)) {
        titleResult.issues.push({ severity: "warn", text: 'title is generic ("' + titleText + '")' });
      }
      try {
        var hostname = window.location.hostname.toLowerCase();
        if (lower === hostname || lower === window.location.href.toLowerCase()) {
          titleResult.issues.push({ severity: "warn", text: "title matches the URL or hostname rather than describing the page" });
        }
      } catch (e) {}
      if (titleEls.length > 1) {
        titleResult.issues.push({ severity: "warn", text: titleEls.length + " <title> elements found (should be exactly one)" });
      }
    }

    /* ----- <html lang> and <html xml:lang> ----- */

    var htmlEl = document.documentElement;
    var htmlLangAttr = htmlEl ? htmlEl.getAttribute("lang") : null;
    var htmlXmlLangAttr = htmlEl ? getXmlLang(htmlEl) : null;

    var htmlLang = validateTag(htmlLangAttr);
    var htmlXmlLang = validateTag(htmlXmlLangAttr);
    htmlLang.location = "<html lang>";
    htmlXmlLang.location = "<html xml:lang>";

    if (!htmlLangAttr) {
      htmlLang.issues = ["<html> element has no lang attribute (WCAG 3.1.1)"];
      htmlLang.valid = false;
    }

    var htmlLangXmlMismatch = null;
    if (htmlLangAttr && htmlXmlLangAttr) {
      // Compare canonicals so case differences don't trigger a false alarm
      var lc = htmlLang.canonical || htmlLangAttr;
      var xc = htmlXmlLang.canonical || htmlXmlLangAttr;
      if (lc !== xc) {
        htmlLangXmlMismatch = {
          lang: htmlLangAttr,
          xmlLang: htmlXmlLangAttr,
          text: '<html lang="' + htmlLangAttr + '"> and <html xml:lang="' + htmlXmlLangAttr + '"> must be equivalent — they are different'
        };
      }
    }

    /* ----- Every element with lang or xml:lang (inventory) ----- */

    var langAttrs = [];
    // Query for both — supported in modern browsers; need to escape colon for xml:lang
    var allWithLang;
    try {
      allWithLang = document.body
        ? document.body.querySelectorAll("[lang], [\\:lang], [xml\\:lang]")
        : [];
    } catch (e) {
      // Fallback: full doc scan
      allWithLang = document.body ? document.body.querySelectorAll("*") : [];
    }

    Array.prototype.forEach.call(allWithLang, function (el) {
      var l = el.getAttribute("lang");
      var xl = getXmlLang(el);
      if (l === null && xl === null) return;

      var lv = l !== null ? validateTag(l) : null;
      var xlv = xl !== null ? validateTag(xl) : null;
      var entry = {
        tag: el.tagName.toLowerCase(),
        selector: uniqueSelector(el),
        lang: lv,
        xmlLang: xlv,
        sampleText: txt((el.textContent || "")).slice(0, 80),
        issues: []
      };

      // Same-element lang vs xml:lang mismatch
      if (lv && xlv) {
        var lcan = lv.canonical || l;
        var xcan = xlv.canonical || xl;
        if (lcan !== xcan) {
          entry.issues.push({ severity: "error", text: 'lang="' + l + '" and xml:lang="' + xl + '" must match — they are different' });
        }
      }

      langAttrs.push(entry);
    });

    /* ----- Links with hreflang ----- */

    var pageLanguageCanonical = htmlLang.canonical || null;

    var hreflangLinks = [];
    Array.prototype.forEach.call(document.querySelectorAll("a[hreflang], link[hreflang], area[hreflang]"), function (el) {
      var hl = el.getAttribute("hreflang");
      var hlv = validateTag(hl);
      hreflangLinks.push({
        tag: el.tagName.toLowerCase(),
        selector: uniqueSelector(el),
        href: el.getAttribute("href") || "",
        linkText: txt(el.textContent).slice(0, 80) || "(no text)",
        hreflang: hlv,
        matchesPageLang: pageLanguageCanonical && hlv.canonical === pageLanguageCanonical
      });
    });

    /* ----- URL language hints on <a href> (heuristic) ----- */

    // Detect URL paths or query strings that hint at a target language
    // different from the page language. Heuristic — auditor must verify.
    function detectUrlLangHint(href) {
      if (!href) return null;
      var lcHref = href.toLowerCase();
      // Skip in-page anchors and javascript:
      if (lcHref.indexOf("#") === 0 || lcHref.indexOf("javascript:") === 0 ||
          lcHref.indexOf("mailto:") === 0 || lcHref.indexOf("tel:") === 0) return null;

      // /xx/ or /xx-XX/ at start of path
      var pathMatch = lcHref.match(/\/([a-z]{2,3})(?:[-_]([a-z]{2}))?(?:\/|$)/);
      if (pathMatch) {
        var lc = pathMatch[1];
        if (COMMON_LANGUAGES.has(lc) && lc !== "en") {
          // Only flag if not English (default-assumed of most pages and most common path noise)
          // We deliberately use this as a hint, not a hard rule.
          return { source: "url path", code: pathMatch[2] ? (lc + "-" + pathMatch[2].toUpperCase()) : lc };
        }
      }

      // ?lang=xx or ?language=xx-XX or ?locale=xx_XX
      var queryMatch = lcHref.match(/[?&](?:lang|language|locale|l|hl)=([a-z]{2,3})(?:[-_]([a-z]{2}))?/);
      if (queryMatch) {
        var qc = queryMatch[1];
        if (COMMON_LANGUAGES.has(qc)) {
          return { source: "query string", code: queryMatch[2] ? (qc + "-" + queryMatch[2].toUpperCase()) : qc };
        }
      }

      return null;
    }

    var foreignUrls = [];
    Array.prototype.forEach.call(document.querySelectorAll("a[href]"), function (el) {
      var href = el.getAttribute("href") || "";
      var hint = detectUrlLangHint(href);
      if (!hint) return;
      // If link already has hreflang matching the hint, no flag needed
      var hl = el.getAttribute("hreflang");
      var hintLangPart = hint.code.split("-")[0];
      var pageLangPart = pageLanguageCanonical ? pageLanguageCanonical.split("-")[0] : null;
      // Only flag if hint language differs from page language
      if (pageLangPart && hintLangPart === pageLangPart) return;
      // Only flag if hreflang is missing OR doesn't match the hint's primary language
      var matchesHl = hl && hl.toLowerCase().split("-")[0] === hintLangPart;
      if (matchesHl) return;
      foreignUrls.push({
        tag: el.tagName.toLowerCase(),
        selector: uniqueSelector(el),
        href: href,
        linkText: txt(el.textContent).slice(0, 80) || "(no text)",
        hint: hint,
        existingHreflang: hl
      });
    });

    /* ----- Embedded lang in text attributes (smell) ----- */

    var TEXT_ATTRS = ["alt", "title", "aria-label", "aria-roledescription", "aria-description", "placeholder"];
    var embeddedLangs = [];
    Array.prototype.forEach.call(document.querySelectorAll(
      "[alt],[title],[aria-label],[aria-roledescription],[aria-description],[placeholder]"
    ), function (el) {
      TEXT_ATTRS.forEach(function (a) {
        var v = el.getAttribute(a);
        if (v === null) return;
        // Smell 1: contains "lang=" substring (someone tried to embed a lang declaration)
        var hasLangEq = /\blang\s*=/i.test(v) || /\bxml:lang\s*=/i.test(v);
        // Smell 2: contains literal HTML-looking markup
        var hasHtml = /<[a-z][^>]*>/i.test(v);
        if (hasLangEq || hasHtml) {
          embeddedLangs.push({
            tag: el.tagName.toLowerCase(),
            selector: uniqueSelector(el),
            attr: a,
            value: v.length > 120 ? v.slice(0, 120) + "…" : v,
            issues: [
              hasLangEq ? { severity: "warn", text: 'attribute contains "lang=" substring — attribute values are plain text, not HTML; the lang declaration will not take effect' } : null,
              hasHtml ? { severity: "warn", text: 'attribute contains HTML-looking markup — attribute values are unparsed text, so any markup is displayed literally to assistive tech' } : null
            ].filter(Boolean)
          });
        }
      });
    });

    return {
      url: window.location.href,
      isTop: window === window.top,
      title: titleResult,
      htmlLang: htmlLang,
      htmlXmlLang: htmlXmlLang,
      htmlLangXmlMismatch: htmlLangXmlMismatch,
      langAttrs: langAttrs,
      hreflangLinks: hreflangLinks,
      foreignUrls: foreignUrls,
      embeddedLangs: embeddedLangs,
      pageLanguageCanonical: pageLanguageCanonical
    };
  } catch (e) {
    return { url: window.location.href, isTop: window === window.top, error: String(e && e.message || e) };
  }
}

function displayDocument(framesData, checkId) {
  "use strict";
  var P = "__a11yn_ext_";
  if (window[P + "cleanup"]) window[P + "cleanup"]();

  // Flatten frame data into a single sequence of "findings", each with a
  // category for the filter bar. Top frame is reported first; iframes follow.
  var findings = [];
  var frameLabelByUrl = new Map();

  framesData.forEach(function (frame, fi) {
    if (!frame || frame.error) return;
    var inFrame = !frame.isTop;
    var frameLabel = null;
    if (inFrame) {
      try { var u = new URL(frame.url); frameLabel = u.hostname + u.pathname.replace(/\/$/, ""); }
      catch (e) { frameLabel = frame.url; }
      frameLabelByUrl.set(frame.url, frameLabel);
    }
    var fp = { frameUrl: frame.url, frameLabel: frameLabel, isTop: !inFrame };

    // Title
    if (frame.title) {
      findings.push(Object.assign({}, fp, {
        category: "title",
        kind: "page-title",
        title: frame.title
      }));
    }

    // <html lang>
    if (frame.htmlLang) {
      findings.push(Object.assign({}, fp, {
        category: "page-lang",
        kind: "html-lang",
        tag: frame.htmlLang
      }));
    }
    // <html xml:lang>
    if (frame.htmlXmlLang && frame.htmlXmlLang.present) {
      findings.push(Object.assign({}, fp, {
        category: "page-lang",
        kind: "html-xml-lang",
        tag: frame.htmlXmlLang
      }));
    }
    if (frame.htmlLangXmlMismatch) {
      findings.push(Object.assign({}, fp, {
        category: "page-lang",
        kind: "html-lang-xml-mismatch",
        mismatch: frame.htmlLangXmlMismatch
      }));
    }

    // Per-element lang/xml:lang
    (frame.langAttrs || []).forEach(function (a) {
      findings.push(Object.assign({}, fp, {
        category: "lang-attr",
        kind: "element-lang",
        attr: a
      }));
    });

    // Links with hreflang
    (frame.hreflangLinks || []).forEach(function (h) {
      findings.push(Object.assign({}, fp, {
        category: "hreflang",
        kind: "hreflang-link",
        link: h
      }));
    });

    // Foreign URLs (3.1.2 risk)
    (frame.foreignUrls || []).forEach(function (l) {
      findings.push(Object.assign({}, fp, {
        category: "foreign-url",
        kind: "foreign-url",
        link: l
      }));
    });

    // Embedded lang in text attrs
    (frame.embeddedLangs || []).forEach(function (e) {
      findings.push(Object.assign({}, fp, {
        category: "embedded",
        kind: "embedded-lang",
        embedded: e
      }));
    });
  });

  findings.forEach(function (f, i) { f.index = i + 1; });

  // Compute counts per category
  var counts = { title: 0, "page-lang": 0, "lang-attr": 0, hreflang: 0, "foreign-url": 0, embedded: 0 };
  var issueCount = 0;
  findings.forEach(function (f) {
    counts[f.category] = (counts[f.category] || 0) + 1;
    if (findingHasIssue(f)) issueCount++;
  });

  function findingHasIssue(f) {
    if (f.kind === "page-title") return f.title.issues.some(function (i) { return i.severity === "error" || i.severity === "warn"; });
    if (f.kind === "html-lang") return !f.tag.valid || (f.tag.issues && f.tag.issues.length);
    if (f.kind === "html-xml-lang") return !f.tag.valid || (f.tag.issues && f.tag.issues.length);
    if (f.kind === "html-lang-xml-mismatch") return true;
    if (f.kind === "element-lang") {
      if (f.attr.issues && f.attr.issues.length) return true;
      if (f.attr.lang && f.attr.lang.issues && f.attr.lang.issues.length) return true;
      if (f.attr.xmlLang && f.attr.xmlLang.issues && f.attr.xmlLang.issues.length) return true;
      return false;
    }
    if (f.kind === "hreflang-link") return !f.link.hreflang.valid || (f.link.hreflang.issues && f.link.hreflang.issues.length);
    if (f.kind === "foreign-url") return true;
    if (f.kind === "embedded-lang") return f.embedded.issues && f.embedded.issues.length > 0;
    return false;
  }

  // ----- Shadow UI -----
  var host = document.createElement("div");
  host.id = P + "host";
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "all:initial !important;position:absolute !important;top:0 !important;left:0 !important;width:0 !important;height:0 !important;margin:0 !important;padding:0 !important;border:0 !important;font:400 16px/1.4 ui-sans-serif,system-ui,sans-serif !important;color:#111 !important;pointer-events:none !important;z-index:2147483647 !important;";
  (document.body || document.documentElement).appendChild(host);
  var shadow = host.attachShadow({ mode: "closed" });

  var css =
    ":host{all:initial;font-family:ui-sans-serif,system-ui,sans-serif !important;}" +
    "*,*::before,*::after{box-sizing:border-box;font-family:ui-sans-serif,system-ui,sans-serif !important;font-style:normal !important;font-weight:400 !important;font-variant:normal !important;text-transform:none !important;letter-spacing:normal !important;text-decoration:none !important;color:#111;}" +
    ".panel{position:fixed;top:12px;right:12px;width:600px;max-height:85vh;display:flex;flex-direction:column;background:#fff;color:#111;border:1px solid #bbb;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.25);font-size:16px;line-height:1.4;pointer-events:auto;}" +
    ".panel header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#003876;color:#fff;border-radius:6px 6px 0 0;}" +
    ".panel header strong{font-size:18px;font-weight:600 !important;color:#fff;}" +
    ".panel .btns{display:flex;gap:8px;}" +
    ".panel button{background:transparent;border:1px solid #fff;color:#fff;padding:6px 12px;border-radius:3px;cursor:pointer;font-size:16px;font-weight:500;line-height:1.2;}" +
    ".panel button:hover{background:rgba(255,255,255,.18);}" +
    ".panel .filterbar{display:flex;gap:6px;padding:8px 14px;border-bottom:1px solid #eee;background:#f5f7fa;flex-wrap:wrap;}" +
    ".panel .filterbar button{border:1px solid #cfd6e0;background:#fff;color:#003876;padding:5px 10px;border-radius:3px;cursor:pointer;font-size:13px;font-weight:500;}" +
    ".panel .filterbar button.active{background:#003876;color:#fff !important;border-color:#003876;}" +
    ".panel .filterbar button:hover:not(.active){background:#eef4ff;}" +
    ".panel .summary{padding:10px 14px;border-bottom:1px solid #eee;background:#f5f7fa;font-size:16px;}" +
    ".panel .summary .miss{color:#b00020;font-weight:600 !important;}" +
    ".panel .summary .ok{color:#0a8043;font-weight:600 !important;}" +
    ".panel .summary .warn{color:#b45309;font-weight:600 !important;}" +
    ".panel ol{margin:0;padding:0;list-style:none;overflow:auto;flex:1 1 auto;}" +
    ".panel li{padding:10px 14px;border-bottom:1px solid #eee;cursor:pointer;font-size:16px;border-left:4px solid transparent;}" +
    ".panel li:hover{background:#eef4ff;}" +
    ".panel li.has-issue{border-left-color:#b00020;}" +
    ".panel li.has-warn{border-left-color:#b45309;}" +
    ".panel li.ok-row{border-left-color:#0a8043;}" +
    ".panel.filter-title li:not(.cat-title){display:none;}" +
    ".panel.filter-page-lang li:not(.cat-page-lang){display:none;}" +
    ".panel.filter-lang-attr li:not(.cat-lang-attr){display:none;}" +
    ".panel.filter-hreflang li:not(.cat-hreflang){display:none;}" +
    ".panel.filter-foreign-url li:not(.cat-foreign-url){display:none;}" +
    ".panel.filter-embedded li:not(.cat-embedded){display:none;}" +
    ".panel.filter-issues li:not(.has-issue):not(.has-warn){display:none;}" +
    ".panel li .meta{color:#555;font-size:14px;margin-bottom:2px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;}" +
    ".panel li .frame-label{color:#0a5d2e;font-weight:600;}" +
    ".panel li .catchip{display:inline-block;padding:2px 8px;border-radius:3px;color:#fff !important;font-size:12px;font-weight:700 !important;line-height:1.3;background:#003876;}" +
    ".panel li .statuschip{display:inline-block;padding:2px 8px;border-radius:3px;color:#fff !important;font-size:12px;font-weight:700 !important;line-height:1.3;}" +
    ".panel li .statuschip.ok{background:#0a8043;}" +
    ".panel li .statuschip.warn{background:#b45309;}" +
    ".panel li .statuschip.err{background:#b00020;}" +
    ".panel li .statuschip.info{background:#003876;}" +
    ".panel li .body{margin-top:4px;}" +
    ".panel li .title-text{font-weight:600 !important;color:#111;font-size:16px;word-break:break-word;}" +
    ".panel li .title-text.empty{color:#b00020;font-style:italic;}" +
    ".panel li .tagvalue{font-family:ui-monospace,monospace !important;font-size:14px;background:rgba(0,0,0,.06);padding:1px 6px;border-radius:3px;color:#111;}" +
    ".panel li .canonical{color:#0a5d2e;font-family:ui-monospace,monospace !important;font-size:14px;}" +
    ".panel li .row-line{margin:2px 0;font-size:14px;color:#333;}" +
    ".panel li .issuetext{color:#b00020;font-size:14px;margin-top:3px;font-weight:600 !important;}" +
    ".panel li .warntext{color:#b45309;font-size:14px;margin-top:3px;}" +
    ".panel li .src{color:#666;font-size:14px;font-style:italic;margin-top:3px;word-break:break-all;}" +
    ".panel code{font-family:ui-monospace,monospace !important;font-size:14px;background:rgba(0,0,0,.06);padding:1px 5px;border-radius:3px;}" +
    ".panel li .swatch{display:inline-block;font-family:ui-monospace,monospace !important;font-size:13px;color:#333;padding:1px 4px;background:rgba(0,0,0,.04);border-radius:2px;}";

  var styleEl = document.createElement("style");
  styleEl.textContent = css;
  shadow.appendChild(styleEl);

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }

  /* ----- Build summary ----- */

  var totalIssues = findings.filter(findingHasIssue).length;
  var summary = "";
  if (findings.length === 0) {
    summary += '<span class="warn">No title or language information found.</span>';
  } else if (totalIssues === 0) {
    summary += '<span class="ok">All ' + findings.length + ' findings look fine.</span>';
  } else {
    summary += '<span class="miss">' + totalIssues + ' finding' + (totalIssues === 1 ? "" : "s") + ' with issues</span> of ' + findings.length + ' total.';
  }
  summary += '<div style="margin-top:6px;color:#555;font-size:14px">' +
    counts.title + ' title · ' +
    counts["page-lang"] + ' page-lang · ' +
    counts["lang-attr"] + ' lang-attr · ' +
    counts.hreflang + ' hreflang · ' +
    counts["foreign-url"] + ' foreign-url · ' +
    counts.embedded + ' embedded' +
    '</div>';

  var panelEl = document.createElement("div");
  panelEl.className = "panel filter-all";
  panelEl.innerHTML =
    "<header><strong>Title &amp; Language (" + findings.length + ")</strong>" +
    '<div class="btns"><button id="' + P + 'copy">Copy MD</button><button id="' + P + 'close">Close</button></div></header>' +
    '<div class="filterbar">' +
      '<button data-filter="all" class="active">All (' + findings.length + ')</button>' +
      '<button data-filter="issues">Issues (' + totalIssues + ')</button>' +
      '<button data-filter="title">Title (' + counts.title + ')</button>' +
      '<button data-filter="page-lang">Page lang (' + counts["page-lang"] + ')</button>' +
      '<button data-filter="lang-attr">Lang attrs (' + counts["lang-attr"] + ')</button>' +
      '<button data-filter="hreflang">hreflang (' + counts.hreflang + ')</button>' +
      '<button data-filter="foreign-url">Foreign URLs (' + counts["foreign-url"] + ')</button>' +
      '<button data-filter="embedded">Embedded (' + counts.embedded + ')</button>' +
    '</div>' +
    '<div class="summary">' + summary + "</div>" +
    '<ol id="' + P + 'list"></ol>';

  /* ----- Render each finding ----- */

  function tagValueHtml(tv) {
    if (!tv || tv.present === false) return '<span class="warn">(not set)</span>';
    if (tv.empty) return '<span class="tagvalue">""</span> <span class="warn">(empty)</span>';
    var raw = '<span class="tagvalue">"' + esc(tv.raw) + '"</span>';
    if (tv.canonical && tv.canonical !== tv.raw) {
      raw += ' <span class="canonical">→ canonical: "' + esc(tv.canonical) + '"</span>';
    }
    return raw;
  }

  function renderFindingBody(f) {
    if (f.kind === "page-title") {
      var t = f.title;
      var parts = [];
      parts.push('<div class="row-line"><strong>Title:</strong> <span class="title-text' + (t.value ? '' : ' empty') + '">' + (t.value ? esc(t.value) : "(empty)") + '</span></div>');
      if (t.multipleTitles && t.multipleTitles > 1) {
        parts.push('<div class="row-line">' + t.multipleTitles + ' &lt;title&gt; elements found.</div>');
      }
      t.issues.forEach(function (iss) {
        var cls = iss.severity === "error" ? "issuetext" : "warntext";
        parts.push('<div class="' + cls + '">' + esc(iss.text) + '</div>');
      });
      return parts.join("");
    }
    if (f.kind === "html-lang" || f.kind === "html-xml-lang") {
      var loc = f.kind === "html-lang" ? "&lt;html lang&gt;" : "&lt;html xml:lang&gt;";
      var parts2 = [];
      parts2.push('<div class="row-line"><strong>' + loc + ':</strong> ' + tagValueHtml(f.tag) + '</div>');
      (f.tag.issues || []).forEach(function (iss) {
        parts2.push('<div class="issuetext">' + esc(iss) + '</div>');
      });
      (f.tag.warnings || []).forEach(function (w) {
        parts2.push('<div class="warntext">' + esc(w) + '</div>');
      });
      if (f.tag.parsed && f.tag.valid) {
        var bits = [];
        var pp = f.tag.parsed;
        if (pp.language) bits.push("language=<span class=\"swatch\">" + esc(pp.language.toLowerCase()) + "</span>");
        if (pp.script) bits.push("script=<span class=\"swatch\">" + esc(pp.script) + "</span>");
        if (pp.region) bits.push("region=<span class=\"swatch\">" + esc(pp.region) + "</span>");
        if (pp.variants && pp.variants.length) bits.push("variants=<span class=\"swatch\">" + esc(pp.variants.join(", ")) + "</span>");
        if (bits.length) parts2.push('<div class="row-line">' + bits.join(" &middot; ") + "</div>");
      }
      return parts2.join("");
    }
    if (f.kind === "html-lang-xml-mismatch") {
      return '<div class="issuetext">' + esc(f.mismatch.text) + '</div>';
    }
    if (f.kind === "element-lang") {
      var a = f.attr;
      var lines = [];
      lines.push('<div class="row-line"><code>&lt;' + esc(a.tag) + '&gt;</code></div>');
      if (a.lang) {
        lines.push('<div class="row-line"><strong>lang:</strong> ' + tagValueHtml(a.lang) + '</div>');
        (a.lang.issues || []).forEach(function (iss) { lines.push('<div class="issuetext">' + esc(iss) + '</div>'); });
        (a.lang.warnings || []).forEach(function (w) { lines.push('<div class="warntext">' + esc(w) + '</div>'); });
      }
      if (a.xmlLang) {
        lines.push('<div class="row-line"><strong>xml:lang:</strong> ' + tagValueHtml(a.xmlLang) + '</div>');
        (a.xmlLang.issues || []).forEach(function (iss) { lines.push('<div class="issuetext">' + esc(iss) + '</div>'); });
        (a.xmlLang.warnings || []).forEach(function (w) { lines.push('<div class="warntext">' + esc(w) + '</div>'); });
      }
      (a.issues || []).forEach(function (iss) {
        var cls = iss.severity === "error" ? "issuetext" : "warntext";
        lines.push('<div class="' + cls + '">' + esc(iss.text) + '</div>');
      });
      if (a.sampleText) {
        lines.push('<div class="row-line" style="color:#666;font-style:italic">' + esc(a.sampleText) + (a.sampleText.length === 80 ? "…" : "") + '</div>');
      }
      lines.push('<div class="src">' + esc(a.selector) + '</div>');
      return lines.join("");
    }
    if (f.kind === "hreflang-link") {
      var L = f.link;
      var hlines = [];
      hlines.push('<div class="row-line"><code>&lt;' + esc(L.tag) + ' href="' + esc(L.href.length > 60 ? L.href.slice(0,60) + "…" : L.href) + '"&gt;</code> "' + esc(L.linkText) + '"</div>');
      hlines.push('<div class="row-line"><strong>hreflang:</strong> ' + tagValueHtml(L.hreflang) + '</div>');
      (L.hreflang.issues || []).forEach(function (iss) { hlines.push('<div class="issuetext">' + esc(iss) + '</div>'); });
      (L.hreflang.warnings || []).forEach(function (w) { hlines.push('<div class="warntext">' + esc(w) + '</div>'); });
      hlines.push('<div class="src">' + esc(L.selector) + '</div>');
      return hlines.join("");
    }
    if (f.kind === "foreign-url") {
      var F = f.link;
      var flines = [];
      flines.push('<div class="row-line"><code>&lt;a href="' + esc(F.href.length > 60 ? F.href.slice(0,60) + "…" : F.href) + '"&gt;</code> "' + esc(F.linkText) + '"</div>');
      flines.push('<div class="warntext">URL ' + F.hint.source + ' suggests <span class="swatch">' + esc(F.hint.code) + '</span> content (different from page lang). ' + (F.existingHreflang ? 'hreflang="' + esc(F.existingHreflang) + '" is set but does not match this hint.' : 'No hreflang attribute set.') + ' WCAG 3.1.2 risk — verify the linked document\'s actual language.</div>');
      flines.push('<div class="src">' + esc(F.selector) + '</div>');
      return flines.join("");
    }
    if (f.kind === "embedded-lang") {
      var E = f.embedded;
      var elines = [];
      elines.push('<div class="row-line"><code>&lt;' + esc(E.tag) + '&gt;</code> @ <code>' + esc(E.attr) + '</code></div>');
      elines.push('<div class="row-line"><span class="tagvalue">' + esc(E.value) + '</span></div>');
      (E.issues || []).forEach(function (iss) {
        var cls = iss.severity === "error" ? "issuetext" : "warntext";
        elines.push('<div class="' + cls + '">' + esc(iss.text) + '</div>');
      });
      elines.push('<div class="src">' + esc(E.selector) + '</div>');
      return elines.join("");
    }
    return "";
  }

  function statusChipFor(f) {
    if (f.kind === "page-title") {
      var t = f.title;
      if (t.issues.some(function (i) { return i.severity === "error"; })) return { cls: "err", label: "fail" };
      if (t.issues.length) return { cls: "warn", label: "warn" };
      return { cls: "ok", label: "ok" };
    }
    if (f.kind === "html-lang") {
      if (!f.tag.present || !f.tag.valid) return { cls: "err", label: "fail" };
      if (f.tag.issues && f.tag.issues.length) return { cls: "warn", label: "warn" };
      if (f.tag.warnings && f.tag.warnings.length) return { cls: "warn", label: "warn" };
      return { cls: "ok", label: "ok" };
    }
    if (f.kind === "html-xml-lang") {
      if (!f.tag.valid) return { cls: "err", label: "fail" };
      if (f.tag.issues && f.tag.issues.length) return { cls: "warn", label: "warn" };
      if (f.tag.warnings && f.tag.warnings.length) return { cls: "warn", label: "warn" };
      return { cls: "ok", label: "ok" };
    }
    if (f.kind === "html-lang-xml-mismatch") return { cls: "err", label: "mismatch" };
    if (f.kind === "element-lang") {
      var hasErr = false, hasWarn = false;
      var checks = [f.attr.lang, f.attr.xmlLang];
      checks.forEach(function (c) {
        if (!c) return;
        if (!c.valid) hasErr = true;
        if (c.issues && c.issues.length) hasErr = true;
        if (c.warnings && c.warnings.length) hasWarn = true;
      });
      if (f.attr.issues && f.attr.issues.some(function (i) { return i.severity === "error"; })) hasErr = true;
      if (f.attr.issues && f.attr.issues.some(function (i) { return i.severity === "warn"; })) hasWarn = true;
      if (hasErr) return { cls: "err", label: "fail" };
      if (hasWarn) return { cls: "warn", label: "warn" };
      return { cls: "ok", label: "ok" };
    }
    if (f.kind === "hreflang-link") {
      if (!f.link.hreflang.valid) return { cls: "err", label: "fail" };
      if (f.link.hreflang.issues && f.link.hreflang.issues.length) return { cls: "warn", label: "warn" };
      if (f.link.hreflang.warnings && f.link.hreflang.warnings.length) return { cls: "warn", label: "warn" };
      return { cls: "ok", label: "ok" };
    }
    if (f.kind === "foreign-url") return { cls: "warn", label: "review" };
    if (f.kind === "embedded-lang") return { cls: "warn", label: "warn" };
    return { cls: "info", label: "info" };
  }

  var list = panelEl.querySelector("#" + P + "list");
  findings.forEach(function (f) {
    var li = document.createElement("li");
    li.classList.add("cat-" + f.category);
    var chip = statusChipFor(f);
    if (chip.cls === "err") li.classList.add("has-issue");
    else if (chip.cls === "warn") li.classList.add("has-warn");
    else if (chip.cls === "ok") li.classList.add("ok-row");

    var location = f.isTop ? "" : '<span class="frame-label">[' + esc(f.frameLabel || f.frameUrl) + ']</span>';
    var categoryLabel = ({
      "title": "Title",
      "page-lang": "Page lang",
      "lang-attr": "Lang attr",
      "hreflang": "hreflang",
      "foreign-url": "Foreign URL",
      "embedded": "Embedded"
    })[f.category] || f.category;

    li.innerHTML =
      '<div class="meta">' +
        '<span style="color:#999">#' + f.index + '</span>' +
        '<span class="catchip">' + esc(categoryLabel) + '</span>' +
        '<span class="statuschip ' + chip.cls + '">' + esc(chip.label) + '</span>' +
        location +
      "</div>" +
      '<div class="body">' + renderFindingBody(f) + "</div>";

    list.appendChild(li);
  });

  shadow.appendChild(panelEl);

  /* ----- Markdown ----- */

  function mdEsc(s) { return String(s).replace(/\|/g, "\\|").replace(/\n+/g, " "); }
  var md = "| # | Frame | Category | Status | Details |\n";
  md += "|---|-------|----------|--------|---------|\n";
  findings.forEach(function (f) {
    var chip = statusChipFor(f);
    var frameLabel = f.isTop ? "(top)" : mdEsc(f.frameLabel || f.frameUrl);
    var details = "";
    if (f.kind === "page-title") {
      details = (f.title.value ? '"' + mdEsc(f.title.value) + '"' : "*(empty)*");
      if (f.title.issues.length) details += " — " + f.title.issues.map(function (i) { return mdEsc(i.text); }).join("; ");
    } else if (f.kind === "html-lang" || f.kind === "html-xml-lang") {
      var loc = f.kind === "html-lang" ? "html lang" : "html xml:lang";
      details = loc + "=";
      details += f.tag.present ? '`"' + mdEsc(f.tag.raw) + '"`' : "*(absent)*";
      if (f.tag.canonical && f.tag.canonical !== f.tag.raw) details += " → canonical `" + mdEsc(f.tag.canonical) + "`";
      if (f.tag.issues && f.tag.issues.length) details += " ⚠ " + f.tag.issues.map(mdEsc).join("; ");
      if (f.tag.warnings && f.tag.warnings.length) details += " · " + f.tag.warnings.map(mdEsc).join("; ");
    } else if (f.kind === "html-lang-xml-mismatch") {
      details = mdEsc(f.mismatch.text);
    } else if (f.kind === "element-lang") {
      var a = f.attr;
      details = "<" + a.tag + ">";
      if (a.lang) details += " lang=`\"" + mdEsc(a.lang.raw) + "\"`";
      if (a.xmlLang) details += " xml:lang=`\"" + mdEsc(a.xmlLang.raw) + "\"`";
      var msgs = [];
      [a.lang, a.xmlLang].forEach(function (c) {
        if (!c) return;
        if (c.issues) msgs = msgs.concat(c.issues);
        if (c.warnings) msgs = msgs.concat(c.warnings);
      });
      (a.issues || []).forEach(function (i) { msgs.push(i.text); });
      if (msgs.length) details += " — " + msgs.map(mdEsc).join("; ");
      details += " · `" + mdEsc(a.selector) + "`";
    } else if (f.kind === "hreflang-link") {
      var L = f.link;
      details = "<" + L.tag + ' href="' + mdEsc(L.href.length > 60 ? L.href.slice(0,60) + "…" : L.href) + '"> hreflang=`"' + mdEsc(L.hreflang.raw) + '"`';
      if (L.hreflang.issues && L.hreflang.issues.length) details += " ⚠ " + L.hreflang.issues.map(mdEsc).join("; ");
      if (L.hreflang.warnings && L.hreflang.warnings.length) details += " · " + L.hreflang.warnings.map(mdEsc).join("; ");
    } else if (f.kind === "foreign-url") {
      var F2 = f.link;
      details = '<a href="' + mdEsc(F2.href.length > 60 ? F2.href.slice(0,60) + "…" : F2.href) + '"> URL ' + F2.hint.source + ' suggests `' + mdEsc(F2.hint.code) + '`. ' + (F2.existingHreflang ? "Has hreflang=`\"" + mdEsc(F2.existingHreflang) + "\"`" : "No hreflang") + ".";
    } else if (f.kind === "embedded-lang") {
      var E2 = f.embedded;
      details = "<" + E2.tag + "> @ " + E2.attr + "=`" + mdEsc(E2.value) + "`";
      if (E2.issues && E2.issues.length) details += " ⚠ " + E2.issues.map(function (i) { return mdEsc(i.text); }).join("; ");
    }
    md += "| " + f.index + " | " + frameLabel + " | " + f.category + " | " + chip.label + " | " + details + " |\n";
  });

  /* ----- Console ----- */

  console.group("%c[a11yn document] " + findings.length + " findings (" + totalIssues + " with issues)",
    "color:#003876;font-weight:bold;font-size:13px");
  console.table(findings.map(function (f) {
    var chip = statusChipFor(f);
    return {
      "#": f.index,
      frame: f.isTop ? "(top)" : (f.frameLabel || f.frameUrl),
      category: f.category,
      status: chip.label
    };
  }));
  console.log("%cMarkdown table:", "font-weight:bold");
  console.log(md);
  console.groupEnd();

  /* ----- Wire filter bar ----- */

  panelEl.querySelectorAll(".filterbar button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var filter = btn.dataset.filter;
      panelEl.className = "panel filter-" + filter;
      panelEl.querySelectorAll(".filterbar button").forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
    });
  });

  /* ----- Drag-by-header ----- */
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
    delete window[P + "cleanup"];
    delete window[P + "active"];
    console.log("%c[a11yn] cleared.", "color:#003876");
  };
}
