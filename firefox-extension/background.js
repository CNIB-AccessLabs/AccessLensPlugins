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
  document:  { label: "Title & Language", scan: scanDocument,  display: displayDocument  },
  tabindex:  { label: "Tabindex & Focus Order", scan: scanTabindex, display: displayTabindex },
  forms:     { label: "Forms",            scan: scanForms,     display: displayForms     },
  tables:    { label: "Tables",           scan: scanTables,    display: displayTables    },
  iframes:   { label: "Iframes",          scan: scanIframes,   display: displayIframes   },
  buttons:   { label: "Buttons & interactive", scan: scanButtons, display: displayButtons },
  lists:     { label: "Lists",            scan: scanLists,     display: displayLists     }
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

/* ====================================================================
 * CHECK: TABINDEX — focus order inspector (WCAG 2.4.3)
 *
 * Reports every focusable element on the page, with:
 *   - its DOM position (the order keyboard users naturally expect)
 *   - its FOCUS position (the order the browser will actually traverse,
 *     per HTML "sequential focus navigation order")
 *   - its tabindex value (explicit or implicit)
 *   - its role (native or explicit)
 *
 * Per the HTML spec, sequential focus navigation visits:
 *   1. Elements with positive tabindex, in ascending order of value;
 *      ties broken by DOM order.
 *   2. Then elements with tabindex="0" or naturally focusable elements
 *      with no explicit tabindex, in DOM order.
 *   3. Elements with tabindex="-1" are skipped entirely (still
 *      programmatically focusable via .focus()).
 *
 * Issues flagged:
 *   positive-tabindex     value > 0 breaks the natural DOM order; widely
 *                         considered an anti-pattern.
 *   duplicate-positive    multiple elements share the same positive
 *                         tabindex value; order is undefined among them.
 *   non-interactive       element has tabindex (typically 0) but no
 *                         native interactive role and no interactive
 *                         ARIA role — verify the dev added keyboard
 *                         handlers (Enter/Space) for it.
 *   interactive-skipped   natively interactive element has tabindex="-1"
 *                         — intentionally removed from the tab order;
 *                         common for offscreen widgets but worth a
 *                         second look.
 *   invalid-value         tabindex attribute is not a parseable integer.
 *
 * Inventory-first: every focusable element appears, not just the
 * problematic ones, so the auditor sees the full keyboard journey.
 * ==================================================================== */

function scanTabindex() {
  "use strict";
  try {

    /* ----- helpers ----- */

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

    /* ----- focusability detection ----- */

    var NATIVELY_FOCUSABLE_TAGS = new Set([
      "a", "button", "input", "select", "textarea", "summary",
      "audio", "video", "iframe", "object", "embed"
    ]);
    var INTERACTIVE_ROLES = new Set([
      "button", "link", "checkbox", "radio", "switch", "tab", "menuitem",
      "menuitemcheckbox", "menuitemradio", "option", "combobox", "textbox",
      "searchbox", "slider", "spinbutton", "treeitem", "tabpanel"
    ]);

    function isNativelyInteractive(el) {
      var tag = el.tagName.toLowerCase();
      if (tag === "a") return el.hasAttribute("href");
      if (tag === "button" || tag === "select" || tag === "textarea") {
        return !el.hasAttribute("disabled");
      }
      if (tag === "input") {
        if (el.hasAttribute("disabled")) return false;
        var t = (el.getAttribute("type") || "text").toLowerCase();
        return t !== "hidden";
      }
      if (tag === "summary") return true;
      if (tag === "iframe") return true;
      if (tag === "audio" || tag === "video") return el.hasAttribute("controls");
      return false;
    }

    function getRole(el) {
      var explicit = el.getAttribute("role");
      if (explicit) {
        // First valid token
        var first = explicit.trim().split(/\s+/)[0];
        return { value: first, explicit: true };
      }
      var tag = el.tagName.toLowerCase();
      if (tag === "a") return { value: el.hasAttribute("href") ? "link" : "", explicit: false };
      if (tag === "button") return { value: "button", explicit: false };
      if (tag === "select") return { value: el.multiple ? "listbox" : "combobox", explicit: false };
      if (tag === "textarea") return { value: "textbox", explicit: false };
      if (tag === "summary") return { value: "button", explicit: false };
      if (tag === "input") {
        var t = (el.getAttribute("type") || "text").toLowerCase();
        var map = {
          checkbox: "checkbox", radio: "radio",
          button: "button", submit: "button", reset: "button", image: "button",
          range: "slider", number: "spinbutton",
          search: "searchbox", email: "textbox", tel: "textbox",
          url: "textbox", text: "textbox"
        };
        return { value: map[t] || (t === "password" ? "" : "textbox"), explicit: false };
      }
      return { value: "", explicit: false };
    }

    function isContentEditable(el) {
      var ce = el.getAttribute("contenteditable");
      return ce === "" || ce === "true";
    }

    /* ----- parse tabindex ----- */

    function parseTabindex(raw) {
      if (raw === null) return { present: false, value: null, valid: true, raw: null };
      var trimmed = raw.trim();
      if (trimmed === "") return { present: true, value: null, valid: false, raw: raw, error: "empty value" };
      // HTML parses tabindex as an "integer"; non-integer values are ignored at the platform level.
      // We're stricter: flag anything non-integer.
      if (!/^-?\d+$/.test(trimmed)) {
        return { present: true, value: null, valid: false, raw: raw, error: 'not an integer ("' + raw + '")' };
      }
      var n = parseInt(trimmed, 10);
      return { present: true, value: n, valid: true, raw: raw };
    }

    /* ----- collect candidates ----- */

    // We collect every element that is focusable OR has an explicit tabindex
    // (even if -1, which removes it from tab order but still surfaces in the
    // inventory). Then we walk shadow roots.

    var SELECTOR = [
      "a[href]", "button", "input", "select", "textarea", "summary",
      "audio[controls]", "video[controls]", "iframe", "object", "embed",
      "[tabindex]", "[contenteditable]"
    ].join(",");

    var results = [];
    var seenEls = new Set();
    var domCounter = 0;
    var shadowRoots = 0;

    function processElement(el) {
      if (seenEls.has(el)) return;
      seenEls.add(el);
      if (isHidden(el)) return;
      var rect;
      try { rect = el.getBoundingClientRect(); } catch (e) { return; }
      // Allow 0x0 only for elements with explicit tabindex (could be sr-only).
      var hasExplicitTabindex = el.hasAttribute("tabindex");
      if (rect.width === 0 && rect.height === 0 && !hasExplicitTabindex) return;

      var tag = el.tagName.toLowerCase();
      var tabindex = parseTabindex(el.getAttribute("tabindex"));
      var nativeInteractive = isNativelyInteractive(el);
      var role = getRole(el);
      var hasInteractiveRole = INTERACTIVE_ROLES.has(role.value);
      var contentEditable = isContentEditable(el);

      // Determine whether the element is in the keyboard tab order
      // tabindex value > 0: in order, position = value
      // tabindex value === 0: in order, position = DOM order
      // tabindex value === -1: NOT in tab order (still scriptable focus)
      // no tabindex: in order if natively interactive or contenteditable
      var inTabOrder;
      if (!tabindex.valid && tabindex.present) {
        // Invalid value — HTML spec says treat as not set; we'll surface
        // the issue but treat as untabindexed for ordering
        inTabOrder = nativeInteractive || contentEditable;
      } else if (tabindex.value === null) {
        // No explicit tabindex
        inTabOrder = nativeInteractive || contentEditable;
      } else if (tabindex.value === -1) {
        inTabOrder = false;
      } else {
        inTabOrder = true;
      }

      // Sample text for context
      var sample = "";
      if (tag === "a" || tag === "button" || tag === "summary") {
        sample = txt(el.textContent).slice(0, 80);
      } else if (tag === "input") {
        sample = el.getAttribute("value") || el.getAttribute("placeholder") || "";
        sample = txt(sample).slice(0, 80);
      } else if (tag === "select") {
        sample = "(select)";
      } else if (tag === "textarea") {
        sample = txt(el.value || el.getAttribute("placeholder") || "").slice(0, 80);
      } else if (tag === "iframe") {
        sample = el.getAttribute("title") || el.getAttribute("src") || "(iframe)";
        sample = txt(sample).slice(0, 80);
      } else {
        var aLabel = el.getAttribute("aria-label");
        if (aLabel) sample = aLabel;
        else sample = txt(el.textContent).slice(0, 80);
      }

      results.push({
        domOrderIndex: ++domCounter,
        tag: tag,
        tabindex: tabindex,
        nativeInteractive: nativeInteractive,
        role: role,
        hasInteractiveRole: hasInteractiveRole,
        contentEditable: contentEditable,
        inTabOrder: inTabOrder,
        focusOrderIndex: null,  // assigned after sorting
        sample: sample,
        selector: uniqueSelector(el),
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
      });
    }

    function walk(root) {
      var matches;
      try { matches = root.querySelectorAll(SELECTOR); } catch (e) { return; }
      Array.prototype.forEach.call(matches, function (el) { processElement(el); });
      var all;
      try { all = root.querySelectorAll("*"); } catch (e) { all = []; }
      Array.prototype.forEach.call(all, function (el) {
        if (el.shadowRoot) { shadowRoots++; walk(el.shadowRoot); }
      });
    }

    walk(document);

    /* ----- compute focus order ----- */

    // Per HTML spec sequential focus navigation:
    //   Pass 1: positive tabindex elements sorted by (tabindex asc, DOM asc)
    //   Pass 2: tabindex=0 or implicit focusables in DOM order
    //   Skipped: tabindex=-1 entirely
    var positives = results.filter(function (r) {
      return r.inTabOrder && r.tabindex.valid && r.tabindex.value !== null && r.tabindex.value > 0;
    }).slice();
    positives.sort(function (a, b) {
      if (a.tabindex.value !== b.tabindex.value) return a.tabindex.value - b.tabindex.value;
      return a.domOrderIndex - b.domOrderIndex;
    });

    var zerosOrImplicit = results.filter(function (r) {
      if (!r.inTabOrder) return false;
      // Already counted in positives?
      if (r.tabindex.valid && r.tabindex.value !== null && r.tabindex.value > 0) return false;
      return true;
    }).slice();
    zerosOrImplicit.sort(function (a, b) { return a.domOrderIndex - b.domOrderIndex; });

    var ordered = positives.concat(zerosOrImplicit);
    ordered.forEach(function (r, i) { r.focusOrderIndex = i + 1; });

    /* ----- detect duplicate positive tabindex values ----- */

    var positiveByValue = new Map();
    positives.forEach(function (r) {
      var v = r.tabindex.value;
      if (!positiveByValue.has(v)) positiveByValue.set(v, []);
      positiveByValue.get(v).push(r);
    });

    /* ----- per-element issues ----- */

    results.forEach(function (r) {
      r.issues = [];

      if (r.tabindex.present && !r.tabindex.valid) {
        r.issues.push({ category: "invalid-value", text: 'tabindex="' + r.tabindex.raw + '" is ' + r.tabindex.error });
      }

      if (r.tabindex.valid && r.tabindex.value !== null && r.tabindex.value > 0) {
        r.issues.push({
          category: "positive-tabindex",
          text: 'positive tabindex (' + r.tabindex.value + ') overrides the natural DOM order — anti-pattern; use tabindex="0" or 0 / -1 only'
        });
        var dupes = positiveByValue.get(r.tabindex.value) || [];
        if (dupes.length > 1) {
          var others = dupes.filter(function (o) { return o.domOrderIndex !== r.domOrderIndex; }).map(function (o) { return o.domOrderIndex; });
          r.issues.push({
            category: "duplicate-positive",
            text: dupes.length + ' elements share tabindex="' + r.tabindex.value + '"; order among them is undefined',
            relatedDom: others
          });
        }
      }

      if (r.tabindex.valid && r.tabindex.value === -1 && r.nativeInteractive) {
        r.issues.push({
          category: "interactive-skipped",
          text: 'natively interactive <' + r.tag + '> has tabindex="-1" — deliberately removed from the tab order; verify this is intentional (e.g. an off-screen widget)'
        });
      }

      if (r.tabindex.present && r.tabindex.valid && !r.nativeInteractive && !r.hasInteractiveRole && !r.contentEditable && r.tabindex.value !== null && r.tabindex.value >= 0) {
        // tabindex on a generic element without interactive role
        r.issues.push({
          category: "non-interactive",
          text: '<' + r.tag + '> has tabindex but no native interactive role and no interactive ARIA role — verify keyboard handlers (Enter/Space) and an explicit role are wired up'
        });
      }
    });

    return {
      url: window.location.href,
      isTop: window === window.top,
      results: results,
      shadowRoots: shadowRoots,
      orderedFocusable: ordered.length,
      hasPositiveTabindex: positives.length > 0
    };
  } catch (e) {
    return { url: window.location.href, isTop: window === window.top, results: [], error: String(e && e.message || e) };
  }
}

function displayTabindex(framesData, checkId) {
  "use strict";
  var P = "__a11yn_ext_";
  if (window[P + "cleanup"]) window[P + "cleanup"]();
  // Body is wrapped in try/catch so any thrown error surfaces visibly
  // (red error banner in the top-right + console.error) rather than
  // failing silently inside the executeScript injection boundary.
  try {

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
        domOrderIndex: r.domOrderIndex,
        focusOrderIndex: r.focusOrderIndex,
        tag: r.tag,
        tabindex: r.tabindex,
        nativeInteractive: r.nativeInteractive,
        role: r.role,
        hasInteractiveRole: r.hasInteractiveRole,
        contentEditable: r.contentEditable,
        inTabOrder: r.inTabOrder,
        sample: r.sample,
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
  // Number rows in DOM order across frames (1-based, used as the "row #")
  allResults.forEach(function (r, i) { r.rowIndex = i + 1; });

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
        var color = "#003876", style = "solid";
        var hasErr = r.issues.some(function (i) { return i.category === "positive-tabindex" || i.category === "duplicate-positive" || i.category === "invalid-value"; });
        var hasWarn = r.issues.some(function (i) { return i.category === "non-interactive" || i.category === "interactive-skipped"; });
        if (hasErr) { color = "#b00020"; style = "dashed"; }
        else if (hasWarn) { color = "#b45309"; style = "dashed"; }
        else if (!r.inTabOrder) { color = "#999"; style = "dotted"; }
        el.style.setProperty("outline", "2px " + style + " " + color, "important");
        el.style.setProperty("outline-offset", "1px", "important");
      }
    } catch (e) {}
  });

  /* ----- shadow UI ----- */

  var host = document.createElement("div");
  host.id = P + "host";
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "all:initial !important;position:absolute !important;top:0 !important;left:0 !important;width:0 !important;height:0 !important;margin:0 !important;padding:0 !important;border:0 !important;font:400 16px/1.4 ui-sans-serif,system-ui,sans-serif !important;color:#111 !important;pointer-events:none !important;z-index:2147483647 !important;";
  (document.body || document.documentElement).appendChild(host);
  var shadow = host.attachShadow({ mode: "closed" });

  var css =
    ":host{all:initial;font-family:ui-sans-serif,system-ui,sans-serif !important;}" +
    "*,*::before,*::after{box-sizing:border-box;font-family:ui-sans-serif,system-ui,sans-serif !important;font-style:normal !important;font-weight:400 !important;font-variant:normal !important;text-transform:none !important;letter-spacing:normal !important;text-decoration:none !important;color:#111;}" +
    ".badge{position:absolute;background:#003876;color:#fff;font-size:16px;font-weight:600 !important;line-height:1.2;padding:4px 8px;border-radius:3px;pointer-events:none;max-width:380px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,.4);}" +
    ".badge.err{background:#b00020;}" +
    ".badge.warn{background:#b45309;}" +
    ".badge.skipped{background:#666;}" +
    ".badge.frame{filter:saturate(0.7) brightness(0.9);}" +
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
    ".panel .sortbar{display:flex;gap:6px;padding:6px 14px;border-bottom:1px solid #eee;background:#f5f7fa;font-size:13px;color:#555;align-items:center;}" +
    ".panel .sortbar button{border:1px solid #cfd6e0;background:#fff;color:#003876;padding:3px 8px;border-radius:3px;cursor:pointer;font-size:12px;font-weight:500;}" +
    ".panel .sortbar button.active{background:#0a5d2e;color:#fff !important;border-color:#0a5d2e;}" +
    ".panel .summary{padding:10px 14px;border-bottom:1px solid #eee;background:#f5f7fa;font-size:16px;}" +
    ".panel .summary .miss{color:#b00020;font-weight:600 !important;}" +
    ".panel .summary .ok{color:#0a8043;font-weight:600 !important;}" +
    ".panel .summary .warn{color:#b45309;font-weight:600 !important;}" +
    ".panel ol{margin:0;padding:0;list-style:none;overflow:auto;flex:1 1 auto;}" +
    ".panel li{padding:8px 14px;border-bottom:1px solid #eee;cursor:pointer;font-size:16px;display:flex;align-items:flex-start;gap:10px;border-left:4px solid transparent;}" +
    ".panel li:hover{background:#eef4ff;}" +
    ".panel li.has-err{border-left-color:#b00020;}" +
    ".panel li.has-warn{border-left-color:#b45309;}" +
    ".panel li.not-in-order{background:#fafafa;opacity:0.85;}" +
    ".panel.filter-issues li:not(.has-err):not(.has-warn){display:none;}" +
    ".panel.filter-positive li:not(.has-positive){display:none;}" +
    ".panel.filter-explicit li:not(.has-explicit){display:none;}" +
    ".panel.filter-non-interactive li:not(.is-non-interactive){display:none;}" +
    ".panel.filter-not-in-order li:not(.not-in-order){display:none;}" +
    ".panel li .focuschip{flex:0 0 auto;display:inline-block;min-width:50px;text-align:center;padding:4px 8px;border-radius:3px;background:#0a5d2e;color:#fff !important;font-size:14px;font-weight:700 !important;line-height:1.2;font-family:ui-monospace,monospace !important;}" +
    ".panel li .focuschip.skipped{background:#999;}" +
    ".panel li .focuschip.positive{background:#b00020;}" +
    ".panel li .tichip{flex:0 0 auto;display:inline-block;min-width:48px;text-align:center;padding:4px 8px;border-radius:3px;background:#003876;color:#fff !important;font-size:14px;font-weight:700 !important;line-height:1.2;font-family:ui-monospace,monospace !important;}" +
    ".panel li .tichip.implicit{background:#666;}" +
    ".panel li .tichip.positive{background:#b00020;}" +
    ".panel li .tichip.negative{background:#999;}" +
    ".panel li .tichip.zero{background:#0a8043;}" +
    ".panel li .tichip.invalid{background:#b00020;}" +
    ".panel li .body{flex:1 1 auto;min-width:0;}" +
    ".panel li .meta{color:#555;font-size:14px;margin-bottom:2px;display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;}" +
    ".panel li .frame-label{color:#0a5d2e;font-weight:600;}" +
    ".panel li .sample{font-weight:600 !important;color:#111;font-size:15px;word-break:break-word;}" +
    ".panel li .sample.empty{color:#666;font-style:italic;font-weight:400 !important;}" +
    ".panel li .issues{margin-top:4px;font-size:14px;}" +
    ".panel li .issue{display:flex;gap:6px;margin-top:2px;}" +
    ".panel li .issue .catchip{flex:0 0 auto;padding:1px 6px;border-radius:3px;color:#fff !important;font-size:11px;font-weight:700 !important;line-height:1.4;}" +
    ".panel li .issue .text{flex:1 1 auto;font-weight:600 !important;}" +
    ".panel li .issue.err .text{color:#b00020;}" +
    ".panel li .issue.warn .text{color:#7a4a09;}" +
    ".panel li .issue.err .catchip{background:#b00020;}" +
    ".panel li .issue.warn .catchip{background:#b45309;}" +
    ".panel li .src{color:#666;font-size:14px;font-style:italic;margin-top:3px;word-break:break-all;}" +
    ".panel code{font-family:ui-monospace,monospace !important;font-size:14px;background:rgba(0,0,0,.06);padding:1px 5px;border-radius:3px;}";

  var styleEl = document.createElement("style");
  styleEl.textContent = css;
  shadow.appendChild(styleEl);

  /* ----- badges ----- */

  var badges = [];
  allResults.forEach(function (r) {
    if (!r.positioned) return;
    var badge = document.createElement("div");
    var cls = "badge";
    var hasErr = r.issues.some(function (i) { return i.category === "positive-tabindex" || i.category === "duplicate-positive" || i.category === "invalid-value"; });
    var hasWarn = r.issues.some(function (i) { return i.category === "non-interactive" || i.category === "interactive-skipped"; });
    if (hasErr) cls += " err";
    else if (hasWarn) cls += " warn";
    else if (!r.inTabOrder) cls += " skipped";
    if (!r.isTop) cls += " frame";
    badge.className = cls;
    var prefix = r.isTop ? "" : "[frame] ";
    var tabidxStr = r.tabindex.present ? "ti=" + (r.tabindex.valid ? r.tabindex.value : r.tabindex.raw) : "ti=implicit";
    var focusStr = r.focusOrderIndex !== null ? "F#" + r.focusOrderIndex : "F:skip";
    badge.textContent = "D#" + r.domOrderIndex + " " + prefix + r.tag + " " + focusStr + " " + tabidxStr;
    badge.style.top = (r.pageTop - 28) + "px";
    badge.style.left = r.pageLeft + "px";
    shadow.appendChild(badge);
    badges.push(badge);
    r.badge = badge;
  });

  /* ----- counts ----- */

  var counts = {
    total: allResults.length,
    inOrder: 0,
    notInOrder: 0,
    positive: 0,
    explicit: 0,
    nonInteractive: 0,
    duplicatePositive: 0,
    invalid: 0,
    interactiveSkipped: 0
  };
  allResults.forEach(function (r) {
    if (r.inTabOrder) counts.inOrder++; else counts.notInOrder++;
    if (r.tabindex.present) counts.explicit++;
    if (r.tabindex.valid && r.tabindex.value !== null && r.tabindex.value > 0) counts.positive++;
    r.issues.forEach(function (i) {
      if (i.category === "non-interactive") counts.nonInteractive++;
      if (i.category === "duplicate-positive") counts.duplicatePositive++;
      if (i.category === "invalid-value") counts.invalid++;
      if (i.category === "interactive-skipped") counts.interactiveSkipped++;
    });
  });
  var totalIssues = allResults.filter(function (r) { return r.issues.length > 0; }).length;
  var frameCount = framesData.filter(function (f) { return !f.isTop && f.results && f.results.length; }).length;

  /* ----- console + markdown ----- */

  function mdEsc(s) { return String(s).replace(/\|/g, "\\|").replace(/\n+/g, " "); }
  var md = "| Row | Frame | DOM# | Focus# | Tag | tabindex | Role | Sample | Issues | Selector |\n";
  md += "|-----|-------|------|--------|-----|----------|------|--------|--------|----------|\n";
  allResults.forEach(function (r) {
    var tabidx = r.tabindex.present ? (r.tabindex.valid ? String(r.tabindex.value) : '`"' + mdEsc(r.tabindex.raw) + '"` *(invalid)*') : "*(implicit)*";
    var focusStr = r.focusOrderIndex !== null ? String(r.focusOrderIndex) : "*(skipped)*";
    var issues = r.issues.length ? "⚠ " + r.issues.map(function (i) {
      var more = i.relatedDom && i.relatedDom.length ? " (also DOM#: " + i.relatedDom.map(function (d) { return "D#" + d; }).join(", ") + ")" : "";
      return mdEsc(i.text) + more;
    }).join("; ") : "";
    var frameLabel = r.isTop ? "(top)" : mdEsc(r.frameLabel || r.frameUrl);
    var sampleCell = r.sample ? mdEsc(r.sample) : "*(no text)*";
    var roleCell = r.role.value ? r.role.value + (r.role.explicit ? " *(explicit)*" : "") : "";
    md += "| " + r.rowIndex + " | " + frameLabel + " | D#" + r.domOrderIndex + " | " + focusStr + " | `" + r.tag + "` | " + tabidx + " | " + roleCell + " | " + sampleCell + " | " + issues + " | `" + mdEsc(r.selector) + "` |\n";
  });

  console.group("%c[a11yn tabindex] " + allResults.length + " focusable element(s) — " + counts.positive + " positive tabindex, " + counts.nonInteractive + " non-interactive with tabindex, " + counts.notInOrder + " skipped (tabindex=-1)",
    "color:#003876;font-weight:bold;font-size:13px");
  console.table(allResults.map(function (r) {
    return {
      "row": r.rowIndex,
      frame: r.isTop ? "(top)" : (r.frameLabel || r.frameUrl),
      "DOM#": r.domOrderIndex,
      "Focus#": r.focusOrderIndex !== null ? r.focusOrderIndex : "(skipped)",
      tag: r.tag,
      tabindex: r.tabindex.present ? (r.tabindex.valid ? r.tabindex.value : ("invalid: " + r.tabindex.raw)) : "implicit",
      role: r.role.value,
      sample: r.sample,
      issues: r.issues.length
    };
  }));
  console.log("%cMarkdown table:", "font-weight:bold");
  console.log(md);
  console.groupEnd();

  /* ----- panel ----- */

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }

  var panelEl = document.createElement("div");
  panelEl.className = "panel filter-all";

  var summary = "";
  if (allResults.length === 0) {
    summary += '<span class="warn">No focusable elements found.</span>';
  } else if (totalIssues === 0) {
    summary += '<span class="ok">All ' + counts.inOrder + ' focusable element' + (counts.inOrder === 1 ? "" : "s") + ' use natural tab order.</span>';
  } else {
    var bits = [];
    if (counts.positive) bits.push('<span class="miss">' + counts.positive + ' positive tabindex</span>');
    if (counts.duplicatePositive) bits.push('<span class="miss">' + counts.duplicatePositive + ' duplicate positive</span>');
    if (counts.invalid) bits.push('<span class="miss">' + counts.invalid + ' invalid value</span>');
    if (counts.nonInteractive) bits.push('<span class="warn">' + counts.nonInteractive + ' non-interactive with tabindex</span>');
    if (counts.interactiveSkipped) bits.push('<span class="warn">' + counts.interactiveSkipped + ' interactive skipped (tabindex=-1)</span>');
    summary += bits.join(" · ");
  }
  summary += '<div style="margin-top:6px;color:#555;font-size:14px">';
  summary += counts.total + " focusable · " + counts.inOrder + " in tab order · " + counts.notInOrder + " skipped · " + counts.explicit + " with explicit tabindex · top doc";
  if (frameCount) summary += " + " + frameCount + " frame" + (frameCount === 1 ? "" : "s");
  if (unmatchedFrames) summary += " · ⚠ " + unmatchedFrames + " unpositioned frame(s)";
  summary += "</div>";

  panelEl.innerHTML =
    "<header><strong>Tabindex &amp; Focus Order (" + allResults.length + ")</strong>" +
    '<div class="btns"><button id="' + P + 'copy">Copy MD</button><button id="' + P + 'close">Close</button></div></header>' +
    '<div class="filterbar">' +
      '<button data-filter="all" class="active">All (' + allResults.length + ')</button>' +
      '<button data-filter="issues">Issues (' + totalIssues + ')</button>' +
      '<button data-filter="positive">Positive (' + counts.positive + ')</button>' +
      '<button data-filter="explicit">Explicit tabindex (' + counts.explicit + ')</button>' +
      '<button data-filter="non-interactive">Non-interactive (' + counts.nonInteractive + ')</button>' +
      '<button data-filter="not-in-order">Skipped (' + counts.notInOrder + ')</button>' +
    '</div>' +
    '<div class="sortbar">Sort: ' +
      '<button data-sort="dom" class="active">DOM order</button>' +
      '<button data-sort="focus">Focus order</button>' +
    '</div>' +
    '<div class="summary">' + summary + "</div>" +
    '<ol id="' + P + 'list"></ol>';

  /* ----- render rows ----- */

  function renderRows() {
    var sortMode = panelEl.dataset.sort || "dom";
    var list = panelEl.querySelector("#" + P + "list");
    list.innerHTML = "";
    var sorted = allResults.slice();
    if (sortMode === "focus") {
      // In-order first by focus#, then skipped at end by DOM#
      sorted.sort(function (a, b) {
        if (a.focusOrderIndex === null && b.focusOrderIndex === null) return a.domOrderIndex - b.domOrderIndex;
        if (a.focusOrderIndex === null) return 1;
        if (b.focusOrderIndex === null) return -1;
        return a.focusOrderIndex - b.focusOrderIndex;
      });
    } else {
      sorted.sort(function (a, b) { return a.domOrderIndex - b.domOrderIndex; });
    }

    sorted.forEach(function (r) {
      var li = document.createElement("li");
      var hasErr = r.issues.some(function (i) { return i.category === "positive-tabindex" || i.category === "duplicate-positive" || i.category === "invalid-value"; });
      var hasWarn = r.issues.some(function (i) { return i.category === "non-interactive" || i.category === "interactive-skipped"; });
      if (hasErr) li.classList.add("has-err");
      else if (hasWarn) li.classList.add("has-warn");
      if (r.tabindex.valid && r.tabindex.value !== null && r.tabindex.value > 0) li.classList.add("has-positive");
      if (r.tabindex.present) li.classList.add("has-explicit");
      if (r.issues.some(function (i) { return i.category === "non-interactive"; })) li.classList.add("is-non-interactive");
      if (!r.inTabOrder) li.classList.add("not-in-order");

      var focusStr, focusCls;
      if (r.focusOrderIndex !== null) {
        focusStr = "F#" + r.focusOrderIndex;
        focusCls = "focuschip";
        if (r.tabindex.valid && r.tabindex.value !== null && r.tabindex.value > 0) focusCls += " positive";
      } else {
        focusStr = "skip";
        focusCls = "focuschip skipped";
      }

      var tiStr, tiCls;
      if (!r.tabindex.present) {
        tiStr = "—";
        tiCls = "tichip implicit";
      } else if (!r.tabindex.valid) {
        tiStr = '"' + r.tabindex.raw + '"';
        tiCls = "tichip invalid";
      } else if (r.tabindex.value > 0) {
        tiStr = String(r.tabindex.value);
        tiCls = "tichip positive";
      } else if (r.tabindex.value < 0) {
        tiStr = String(r.tabindex.value);
        tiCls = "tichip negative";
      } else {
        tiStr = "0";
        tiCls = "tichip zero";
      }

      var location = r.isTop ? "" : '<span class="frame-label">[' + esc(r.frameLabel || r.frameUrl) + ']</span> ';
      var roleStr = r.role.value ? esc(r.role.value) + (r.role.explicit ? ' <span style="color:#555">(explicit)</span>' : "") : "";
      var domStr = "DOM #" + r.domOrderIndex;
      var sampleHtml = r.sample
        ? '<div class="sample">"' + esc(r.sample) + '"</div>'
        : '<div class="sample empty">(no text)</div>';

      var issuesHtml = "";
      if (r.issues.length) {
        issuesHtml = '<div class="issues">' + r.issues.map(function (iss) {
          var cls = (iss.category === "positive-tabindex" || iss.category === "duplicate-positive" || iss.category === "invalid-value") ? "issue err" : "issue warn";
          var more = "";
          if (iss.relatedDom && iss.relatedDom.length) {
            more = ' <span style="color:#555">(also DOM #: ' + iss.relatedDom.map(function (d) { return "D#" + d; }).join(", ") + ")</span>";
          }
          return '<div class="' + cls + '"><span class="catchip">' + esc(iss.category) + '</span><span class="text">' + esc(iss.text) + more + '</span></div>';
        }).join("") + '</div>';
      }

      li.innerHTML =
        '<span class="' + focusCls + '">' + esc(focusStr) + '</span>' +
        '<span class="' + tiCls + '">' + esc(tiStr) + '</span>' +
        '<div class="body">' +
          '<div class="meta">' + location + "<code>&lt;" + esc(r.tag) + "&gt;</code>" + (roleStr ? " · " + roleStr : "") + " · " + esc(domStr) + (r.nativeInteractive ? "" : ' <span style="color:#7a4a09">(not natively interactive)</span>') + "</div>" +
          sampleHtml +
          issuesHtml +
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
  }

  panelEl.dataset.sort = "dom";
  shadow.appendChild(panelEl);
  renderRows();

  /* ----- wire filter + sort bars ----- */

  panelEl.querySelectorAll(".filterbar button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var filter = btn.dataset.filter;
      panelEl.className = "panel filter-" + filter;
      panelEl.querySelectorAll(".filterbar button").forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
    });
  });
  panelEl.querySelectorAll(".sortbar button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      panelEl.dataset.sort = btn.dataset.sort;
      panelEl.querySelectorAll(".sortbar button").forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
      renderRows();
    });
  });

  /* ----- drag ----- */

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
  } catch (displayErr) {
    console.error("[a11yn tabindex display error]", displayErr);
    try {
      var errHost = document.createElement("div");
      errHost.style.cssText = "all:initial !important;position:fixed !important;top:12px !important;right:12px !important;z-index:2147483647 !important;background:#b00020 !important;color:#fff !important;padding:12px 16px !important;font:600 14px/1.4 ui-sans-serif,system-ui,sans-serif !important;border-radius:6px !important;max-width:400px !important;box-shadow:0 6px 20px rgba(0,0,0,.25) !important;white-space:pre-wrap !important;";
      errHost.textContent = "Tabindex display error: " + (displayErr && displayErr.message ? displayErr.message : displayErr) + ". See page DevTools console for full stack.";
      (document.body || document.documentElement).appendChild(errHost);
      setTimeout(function () { try { errHost.remove(); } catch (e) {} }, 10000);
    } catch (e) {}
  }
}

/* ====================================================================
 * CHECK: FORMS — form-control inspector
 *
 * Inspects every form control on the page: <input> (non-hidden),
 * <select>, <textarea>, <button>, plus elements with input-like ARIA
 * roles. Groups them by parent <form> (or "no-form" for orphan controls).
 *
 * Issue categories (per control unless noted):
 *
 *   unlabeled                    no accessible name at all
 *   placeholder-as-label         only label source is the placeholder attr
 *   label-in-name-mismatch       visible label text not part of accname
 *                                (WCAG 2.5.3 — affects voice control)
 *   wrapping-label-implicit      <label>text<input/></label> without for=;
 *                                works for SR but Dragon prefers for=id
 *   multiple-labels              more than one <label for="X"> points at
 *                                the same id
 *   label-not-left-aligned       label is above the input but not
 *                                left-aligned with it (magnifier issue)
 *   label-side-positioned        label sits left or right of the input
 *                                (magnifier loses it at high zoom)
 *   label-below-input            label is below the input
 *   multi-control-row            this control shares a horizontal band
 *                                with another (magnifier issue)
 *   required-no-visible-indicator  required attr or aria-required but no
 *                                  asterisk / "required" in label or
 *                                  immediately to the right
 *   required-indicator-no-attr   visible "required" indicator but no
 *                                  required attribute or aria-required
 *   required-aria-contradiction  required attr + aria-required="false"
 *   required-no-aria-required    required attr without aria-required;
 *                                  best practice to set both
 *   bad-idref                    aria-describedby / aria-errormessage /
 *                                aria-controls / aria-labelledby points
 *                                to a non-existent id
 *   invalid-no-error-ref         aria-invalid="true" but no
 *                                aria-describedby / aria-errormessage
 *                                points to a message
 *   missing-autocomplete         input looks like it collects personal
 *                                info (email, name, phone, postcode...)
 *                                but has no autocomplete attribute
 *                                (WCAG 1.3.5)
 *   invalid-autocomplete         autocomplete value not on the HTML
 *                                spec's autofill-detail-tokens list
 *   aria-disabled-focusable      aria-disabled="true" but element still
 *                                in the tab order; confusing for kbd
 *                                users
 *   image-input-no-alt           <input type="image"> with no alt
 *   group-no-fieldset            radios/checkboxes sharing name= but
 *                                not wrapped in <fieldset>+<legend>
 *                                or [role=group][aria-labelledby]
 *                                (per-group flag, attached to each
 *                                member)
 *   empty-legend                 <fieldset>'s <legend> is empty
 *
 * Issues at the <form> level:
 *
 *   form-no-submit               form has no <button>,
 *                                <input type="submit">, or
 *                                <input type="image">
 *   form-native-validation       form lacks novalidate and contains at
 *                                least one field with constraint-
 *                                validation triggers; browser bubble
 *                                messages are inaccessible
 *
 * Filter bar: All / Issues / Unlabeled / Required problems / Invalid
 * wiring / Radio groups / No autocomplete / Wrapping labels / Layout
 * (magnifier) / Native validation / Per-form.
 * ==================================================================== */

function scanForms() {
  "use strict";
  try {

    /* ----- helpers ----- */

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

    /* ----- accessible name (subset of the Names algorithm) ----- */

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
      var sources = [];

      var aLab = el.getAttribute("aria-labelledby");
      if (aLab) {
        var n1 = refNames(aLab, el, seen);
        if (n1) return { name: n1, src: "aria-labelledby", sources: [aLab] };
      }
      var aL = el.getAttribute("aria-label");
      if (aL && aL.trim()) return { name: aL.trim(), src: "aria-label", sources: [aL.trim()] };

      var tag = el.tagName.toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea" || tag === "meter" || tag === "progress") {
        // Label[for]
        if (el.id) {
          var sel;
          try { sel = 'label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id.replace(/"/g, '\\"')) + '"]'; } catch (e) { sel = ""; }
          if (sel) {
            var labs = root.querySelectorAll ? root.querySelectorAll(sel) : doc.querySelectorAll(sel);
            if (labs && labs.length) {
              var collectedNames = [];
              Array.prototype.forEach.call(labs, function (lab) {
                var t = nameFromContent(lab, new Set(seen));
                if (t) collectedNames.push(t);
              });
              if (collectedNames.length) {
                return { name: collectedNames.join(" "), src: "label[for]", sources: collectedNames, labelCount: labs.length };
              }
            }
          }
        }
        // Wrapping label
        var wrap = el.closest && el.closest("label");
        if (wrap) {
          var n3 = nameFromContent(wrap, seen);
          if (n3) return { name: n3, src: "wrapping <label>", sources: [n3], wrappingLabel: wrap };
        }
        if (tag === "input") {
          var t2 = (el.getAttribute("type") || "text").toLowerCase();
          if (t2 === "button" || t2 === "submit" || t2 === "reset") {
            if (el.value) return { name: el.value, src: "value", sources: [el.value] };
            if (t2 === "submit") return { name: "Submit", src: "default (submit)", sources: [] };
            if (t2 === "reset") return { name: "Reset", src: "default (reset)", sources: [] };
          }
          if (t2 === "image" && el.getAttribute("alt")) return { name: el.getAttribute("alt"), src: "alt", sources: [el.getAttribute("alt")] };
        }
      }

      if (tag === "button") {
        var n5 = nameFromContent(el, seen);
        if (n5) return { name: n5, src: "subtree text", sources: [n5] };
      }

      var ti = el.getAttribute("title");
      if (ti && ti.trim()) return { name: ti.trim(), src: "title", sources: [ti.trim()] };

      var ph = el.getAttribute("placeholder");
      if (ph && ph.trim()) return { name: ph.trim(), src: "placeholder", sources: [ph.trim()] };

      return { name: "", src: "", sources: [] };
    }

    /* ----- find associated label(s) — element references, not text ----- */

    function findLabels(el) {
      var doc = el.ownerDocument || document;
      var root = el.getRootNode ? el.getRootNode() : doc;
      var labels = [];

      // label[for=id]
      if (el.id) {
        try {
          var esc = window.CSS && CSS.escape ? CSS.escape(el.id) : el.id.replace(/"/g, '\\"');
          var ls = (root.querySelectorAll && root.querySelectorAll('label[for="' + esc + '"]')) || doc.querySelectorAll('label[for="' + esc + '"]');
          Array.prototype.forEach.call(ls, function (l) { labels.push({ el: l, kind: "for", forValue: el.id }); });
        } catch (e) {}
      }
      // wrapping <label>
      var wrap = el.closest && el.closest("label");
      if (wrap) {
        // Skip if same label was already counted via label[for]
        var already = labels.some(function (l) { return l.el === wrap; });
        if (!already) {
          var hasFor = wrap.hasAttribute("for");
          var forMatches = hasFor && wrap.getAttribute("for") === el.id;
          labels.push({ el: wrap, kind: forMatches ? "for-and-wrap" : "wrap-implicit", forValue: hasFor ? wrap.getAttribute("for") : null });
        }
      }
      return labels;
    }

    /* ----- autocomplete validation ----- */

    // HTML spec autofill detail tokens (selected core set — enough to flag
    // the common usages; the spec also defines section-* prefixes which
    // we accept structurally rather than enumerate).
    var AUTOCOMPLETE_TOKENS = new Set((
      "on off " +
      "name honorific-prefix given-name additional-name family-name honorific-suffix nickname " +
      "username new-password current-password one-time-code " +
      "organization-title organization " +
      "street-address address-line1 address-line2 address-line3 " +
      "address-level1 address-level2 address-level3 address-level4 " +
      "country country-name postal-code " +
      "cc-name cc-given-name cc-additional-name cc-family-name " +
      "cc-number cc-exp cc-exp-month cc-exp-year cc-csc cc-type " +
      "transaction-currency transaction-amount " +
      "language bday bday-day bday-month bday-year sex " +
      "tel tel-country-code tel-national tel-area-code tel-local " +
      "tel-local-prefix tel-local-suffix tel-extension " +
      "email impp url photo " +
      "webauthn"
    ).split(/\s+/));
    var AUTOCOMPLETE_MODIFIERS = new Set("shipping billing home work mobile fax pager".split(/\s+/));

    function validateAutocomplete(raw) {
      if (raw === null) return { present: false };
      var v = raw.trim();
      if (v === "") return { present: true, raw: raw, valid: false, error: "empty value" };
      var tokens = v.toLowerCase().split(/\s+/);
      // Allow optional "section-foo" prefix
      var i = 0;
      if (tokens[i] && /^section-[a-z0-9-]+$/.test(tokens[i])) i++;
      // Optional shipping/billing modifier
      if (tokens[i] && (tokens[i] === "shipping" || tokens[i] === "billing")) i++;
      // Optional contact modifier (home/work/etc.)
      if (tokens[i] && AUTOCOMPLETE_MODIFIERS.has(tokens[i])) i++;
      // The field token
      if (!tokens[i]) return { present: true, raw: raw, valid: false, error: "missing field token" };
      var fieldTok = tokens[i++];
      if (!AUTOCOMPLETE_TOKENS.has(fieldTok)) {
        return { present: true, raw: raw, valid: false, error: 'unknown autofill token "' + fieldTok + '"' };
      }
      // Allow trailing "webauthn"
      if (i < tokens.length && tokens[i] === "webauthn") i++;
      if (i < tokens.length) {
        return { present: true, raw: raw, valid: false, error: 'unexpected trailing token "' + tokens[i] + '"' };
      }
      return { present: true, raw: raw, valid: true, fieldToken: fieldTok };
    }

    /* ----- heuristic: which inputs SHOULD have autocomplete ----- */

    function suggestAutocomplete(el, accName, visibleLabelText) {
      var tag = el.tagName.toLowerCase();
      if (tag !== "input" && tag !== "select" && tag !== "textarea") return null;
      var inputType = (el.getAttribute("type") || "text").toLowerCase();
      if (inputType === "hidden" || inputType === "button" || inputType === "submit" ||
          inputType === "reset" || inputType === "image" || inputType === "file") return null;

      var hints = [
        (el.getAttribute("name") || "").toLowerCase(),
        (el.getAttribute("id") || "").toLowerCase(),
        (el.getAttribute("autocomplete") || "").toLowerCase(),
        (accName || "").toLowerCase(),
        (visibleLabelText || "").toLowerCase()
      ].join(" ");

      if (inputType === "email" || /\b(e-?mail|email-?addr)/.test(hints)) return "email";
      if (inputType === "tel"   || /\b(phone|telephone|mobile|cell|tel-?num)\b/.test(hints)) return "tel";
      if (inputType === "url"   || /\b(homepage|website|url)\b/.test(hints)) return "url";
      if (/\b(first[-\s]?name|given[-\s]?name|forename|fname)\b/.test(hints)) return "given-name";
      if (/\b(last[-\s]?name|family[-\s]?name|surname|lname)\b/.test(hints)) return "family-name";
      if (/\b(full[-\s]?name|your name|^name$|customer[-\s]?name)\b/.test(hints)) return "name";
      if (/\b(organization|company|employer|workplace)\b/.test(hints)) return "organization";
      if (/\b(street|address[-\s]?line|address1|street[-\s]?addr)\b/.test(hints)) return "street-address";
      if (/\b(city|town|locality|address[-\s]?level2)\b/.test(hints)) return "address-level2";
      if (/\b(state|province|region|address[-\s]?level1)\b/.test(hints)) return "address-level1";
      if (/\b(zip|postal[-\s]?code|post[-\s]?code)\b/.test(hints)) return "postal-code";
      if (/\b(country)\b/.test(hints)) return "country";
      if (/\b(birth[-\s]?day|birthday|d[-\s]?o[-\s]?b|date[-\s]?of[-\s]?birth)\b/.test(hints)) return "bday";
      if (/\b(card[-\s]?number|cc[-\s]?num|credit[-\s]?card)\b/.test(hints)) return "cc-number";
      if (/\b(security[-\s]?code|cvv|cvc|cv2)\b/.test(hints)) return "cc-csc";
      if (/\b(username|user[-\s]?name|login)\b/.test(hints)) return "username";
      if (/\b(password|passwd)\b/.test(hints)) {
        if (/\b(new|create|confirm|re-?enter|repeat)\b/.test(hints)) return "new-password";
        return "current-password";
      }
      return null;
    }

    /* ----- required-indicator detection ----- */

    function hasRequiredIndicator(controlEl, labelEls) {
      // Search the associated label text for "*" or "required"
      for (var i = 0; i < labelEls.length; i++) {
        var lt = (labelEls[i].el.textContent || "").trim();
        if (lt.indexOf("*") !== -1) return { found: true, where: "label", text: "*" };
        if (/\brequired\b/i.test(lt)) return { found: true, where: "label", text: "required" };
        if (/\boptional\b/i.test(lt)) continue; // optional indicator doesn't count for required
      }
      // Search siblings to the right of the input for a short text/span
      // containing "*" or "required" (catches the [input] * pattern)
      try {
        var parent = controlEl.parentElement;
        if (!parent) return { found: false };
        var rect = controlEl.getBoundingClientRect();
        // Look at next siblings of the input
        var sib = controlEl.nextSibling;
        while (sib) {
          if (sib.nodeType === 3) {
            if (sib.nodeValue.indexOf("*") !== -1) return { found: true, where: "after-input text", text: "*" };
            if (/\brequired\b/i.test(sib.nodeValue)) return { found: true, where: "after-input text", text: "required" };
          } else if (sib.nodeType === 1) {
            var t = (sib.textContent || "").trim();
            if (t.length <= 40) {  // keep it tight — don't match whole paragraphs
              if (t.indexOf("*") !== -1) return { found: true, where: "after-input element", text: "*" };
              if (/\brequired\b/i.test(t)) return { found: true, where: "after-input element", text: "required" };
            }
            // Stop if we've scanned past a clear block break
            try {
              var sibStyle = window.getComputedStyle(sib);
              if (sibStyle.display === "block" || sibStyle.display === "flex" || sibStyle.display === "grid") break;
            } catch (e) {}
          }
          sib = sib.nextSibling;
        }
      } catch (e) {}
      return { found: false };
    }

    /* ----- label position relative to input ----- */

    function classifyLabelPosition(controlEl, labelEl) {
      // Wrapping label is treated specially — the input is INSIDE the label
      if (labelEl.contains && labelEl.contains(controlEl) && labelEl !== controlEl) {
        // Walk to find the first text node inside the label that precedes the input
        // to determine where the label text sits relative to the input
        try {
          var labelRect = labelEl.getBoundingClientRect();
          var inputRect = controlEl.getBoundingClientRect();
          if (labelRect.bottom <= inputRect.top + 4) return "above-wrapping";
          if (labelRect.top >= inputRect.bottom - 4) return "below-wrapping";
          return "wrapping-mixed";
        } catch (e) { return "wrapping-unknown"; }
      }
      try {
        var lr = labelEl.getBoundingClientRect();
        var ir = controlEl.getBoundingClientRect();
        // Tolerances
        var V_GAP = 4;   // px slack for "above"/"below"
        var H_LEFT_ALIGN = 10;  // px max difference between label.left and input.left
        // Above
        if (lr.bottom <= ir.top + V_GAP) {
          if (Math.abs(lr.left - ir.left) <= H_LEFT_ALIGN) return "above-left-aligned";
          return "above-not-left-aligned";
        }
        // Below
        if (lr.top >= ir.bottom - V_GAP) return "below";
        // Side
        if (lr.right <= ir.left + V_GAP) return "left-side";
        if (lr.left >= ir.right - V_GAP) return "right-side";
        // Overlapping but neither clearly above/below/left/right
        return "overlapping";
      } catch (e) { return "unknown"; }
    }

    /* ----- collect form controls ----- */

    var SELECTOR = [
      'input:not([type="hidden"])', "select", "textarea", "button",
      '[role="textbox"]', '[role="searchbox"]', '[role="combobox"]',
      '[role="checkbox"]', '[role="radio"]', '[role="switch"]',
      '[role="slider"]', '[role="spinbutton"]'
    ].join(",");

    var allControls = [];
    var seenControls = new Set();
    var shadowRoots = 0;

    function walk(root) {
      var matches;
      try { matches = root.querySelectorAll(SELECTOR); } catch (e) { return; }
      Array.prototype.forEach.call(matches, function (el) {
        if (seenControls.has(el)) return;
        seenControls.add(el);
        if (isHidden(el)) return;
        var r;
        try { r = el.getBoundingClientRect(); } catch (e) { return; }
        // 0×0 may be sr-only / virtual; skip unless it's a button (which can be off-screen but meaningful)
        if (r.width === 0 && r.height === 0 && el.tagName.toLowerCase() !== "button") return;
        allControls.push({ el: el, rect: r });
      });
      var all;
      try { all = root.querySelectorAll("*"); } catch (e) { all = []; }
      Array.prototype.forEach.call(all, function (el) {
        if (el.shadowRoot) { shadowRoots++; walk(el.shadowRoot); }
      });
    }

    walk(document);

    /* ----- group radios/checkboxes by [form, name] ----- */

    var groupsByKey = new Map();
    allControls.forEach(function (c) {
      var el = c.el;
      var tag = el.tagName.toLowerCase();
      var type = (el.getAttribute("type") || "").toLowerCase();
      if (tag !== "input" || (type !== "radio" && type !== "checkbox")) return;
      var name = el.getAttribute("name");
      if (!name) return;
      var form = el.form || null;
      var key = (form ? "form" + (form.id || "X") : "noform") + "|" + name + "|" + type;
      if (!groupsByKey.has(key)) groupsByKey.set(key, { name: name, type: type, form: form, members: [] });
      groupsByKey.get(key).members.push(c);
    });

    // For each group with >1 member, check if wrapped in a <fieldset> with <legend>
    // or a [role=group][aria-labelledby] / [aria-label]
    function isGroupedProperly(members) {
      // All members must share an ancestor that's a <fieldset> with a <legend>,
      // OR a [role=group] / [role=radiogroup] with an accessible name.
      // We check the FIRST member's ancestors and verify all others are inside.
      var first = members[0].el;
      var cur = first.parentElement;
      while (cur) {
        var tag = cur.tagName.toLowerCase();
        if (tag === "fieldset") {
          // Does every member share this fieldset as an ancestor?
          var allInside = members.every(function (m) { return cur.contains(m.el); });
          if (allInside) {
            var legend = cur.querySelector(":scope > legend");
            return { grouped: true, fieldset: cur, legend: legend, legendText: legend ? txt(legend.textContent) : "" };
          }
        }
        if (cur.getAttribute && (cur.getAttribute("role") === "group" || cur.getAttribute("role") === "radiogroup")) {
          var allInside2 = members.every(function (m) { return cur.contains(m.el); });
          if (allInside2) {
            var n = accName(cur);
            return { grouped: true, role: cur.getAttribute("role"), accName: n.name, accNameSrc: n.src };
          }
        }
        cur = cur.parentElement;
      }
      return { grouped: false };
    }

    var groupResults = [];
    groupsByKey.forEach(function (g, key) {
      if (g.members.length < 2) return;
      var info = isGroupedProperly(g.members);
      groupResults.push({
        key: key,
        type: g.type,
        name: g.name,
        formId: g.form ? (g.form.id || g.form.name || null) : null,
        memberSelectors: g.members.map(function (m) { return uniqueSelector(m.el); }),
        info: info
      });
    });

    /* ----- detect multi-control rows for magnifier flag ----- */
    // Two controls are in the same row if their vertical centres are within
    // half the smaller height.

    function sameRow(a, b) {
      var ay = (a.rect.top + a.rect.bottom) / 2;
      var by = (b.rect.top + b.rect.bottom) / 2;
      var minH = Math.min(a.rect.height, b.rect.height);
      if (minH <= 0) return false;
      return Math.abs(ay - by) <= minH * 0.5;
    }

    // Sort by vertical position
    var sortedByY = allControls.slice().sort(function (a, b) {
      return a.rect.top - b.rect.top || a.rect.left - b.rect.left;
    });

    // Mark each control with its row members (excluding self)
    var rowMembers = new Map(); // controlEl → array of other controlEls in same row
    for (var i = 0; i < sortedByY.length; i++) {
      var ai = sortedByY[i];
      var row = [];
      for (var j = 0; j < sortedByY.length; j++) {
        if (i === j) continue;
        var bj = sortedByY[j];
        if (sameRow(ai, bj)) row.push(bj.el);
      }
      if (row.length) rowMembers.set(ai.el, row);
    }

    /* ----- main per-control analysis ----- */

    var results = [];
    allControls.forEach(function (c, idx) {
      var el = c.el;
      var tag = el.tagName.toLowerCase();
      var type = (el.getAttribute("type") || "").toLowerCase();

      var labels = findLabels(el);
      var name = accName(el);
      var visibleLabelText = labels.length ? txt(labels[0].el.textContent) : "";
      var requiredAttr = el.hasAttribute("required");
      var ariaRequired = el.getAttribute("aria-required");
      var disabledAttr = el.hasAttribute("disabled");
      var ariaDisabled = el.getAttribute("aria-disabled") === "true";
      var readonlyAttr = el.hasAttribute("readonly");
      var ariaInvalid = el.getAttribute("aria-invalid");
      var describedby = el.getAttribute("aria-describedby");
      var errormessage = el.getAttribute("aria-errormessage");
      var autocompleteRaw = el.getAttribute("autocomplete");
      var autocompleteResult = validateAutocomplete(autocompleteRaw);
      var autocompleteSuggestion = suggestAutocomplete(el, name.name, visibleLabelText);

      var form = el.form || null;

      var issues = [];

      // --- Label / name ---
      if (!name.name) {
        issues.push({ category: "unlabeled", text: "no accessible name (no label, aria-label, aria-labelledby, or title)" });
      } else if (name.src === "placeholder") {
        issues.push({ category: "placeholder-as-label", text: "accessible name comes only from placeholder — placeholder text disappears when typing and isn't a substitute for a label" });
      }

      // Label-in-name (WCAG 2.5.3): visible label should be contained in accname
      if (visibleLabelText && name.name) {
        var vl = visibleLabelText.toLowerCase().replace(/[\s ]+/g, " ").trim();
        var an = name.name.toLowerCase().replace(/[\s ]+/g, " ").trim();
        if (vl && an && an.indexOf(vl) === -1) {
          issues.push({
            category: "label-in-name-mismatch",
            text: 'visible label "' + visibleLabelText + '" is not contained in accessible name "' + name.name + '" — voice-control users say what they see, but the AT API receives different text'
          });
        }
      }

      // Wrapping label without for=
      labels.forEach(function (l) {
        if (l.kind === "wrap-implicit") {
          issues.push({
            category: "wrapping-label-implicit",
            text: '<label> wraps the control but has no for="id" attribute — works in most screen readers but Dragon NaturallySpeaking and some other voice-control tools need explicit for=id'
          });
        }
      });

      // Multiple labels
      var forLabels = labels.filter(function (l) { return l.kind === "for" || l.kind === "for-and-wrap"; });
      if (forLabels.length > 1) {
        issues.push({
          category: "multiple-labels",
          text: forLabels.length + ' <label for="' + el.id + '"> elements point at this control; only the first is reliably used by AT'
        });
      }

      // --- Label position ---
      if (labels.length) {
        var labelEl = labels[0].el;
        var pos = classifyLabelPosition(el, labelEl);
        if (pos === "above-not-left-aligned") {
          issues.push({
            category: "label-not-left-aligned",
            text: "label is above the input but not left-aligned with it — magnifier users following a horizontal magnification band can lose the label"
          });
        } else if (pos === "left-side" || pos === "right-side") {
          issues.push({
            category: "label-side-positioned",
            text: "label sits to the " + (pos === "left-side" ? "left" : "right") + " of the input — magnifier users may not see the label when zoomed in on the input"
          });
        } else if (pos === "below" || pos === "below-wrapping") {
          issues.push({
            category: "label-below-input",
            text: "label is below the input — users (especially magnifier users and AT) generally expect the label above"
          });
        }
      }

      // --- Multi-control row ---
      if (rowMembers.has(el)) {
        var otherEls = rowMembers.get(el);
        issues.push({
          category: "multi-control-row",
          text: "this control shares a horizontal row with " + otherEls.length + " other form control" + (otherEls.length === 1 ? "" : "s") + " — magnifier users following a single horizontal band have to scroll back and forth"
        });
      }

      // --- Required indicator ---
      var isRequired = requiredAttr || ariaRequired === "true";
      var hasVisIndicator = hasRequiredIndicator(el, labels);
      if (isRequired && !hasVisIndicator.found) {
        issues.push({
          category: "required-no-visible-indicator",
          text: 'control is required (required=' + (requiredAttr ? "yes" : "no") + ', aria-required=' + (ariaRequired || "none") + ') but the label has no visible "*" or "required" text'
        });
      } else if (!isRequired && hasVisIndicator.found) {
        issues.push({
          category: "required-indicator-no-attr",
          text: 'label/text near the input shows "' + hasVisIndicator.text + '" but the input has no required attribute or aria-required="true" — browser validation and AT won\'t treat it as required'
        });
      }

      // required / aria-required consistency
      if (requiredAttr && ariaRequired === "false") {
        issues.push({
          category: "required-aria-contradiction",
          text: 'required attribute present but aria-required="false" — contradictory'
        });
      } else if (requiredAttr && !ariaRequired) {
        issues.push({
          category: "required-no-aria-required",
          text: 'required attribute set but no aria-required — best practice to set both (some AT picks up the HTML attribute, some doesn\'t)'
        });
      }

      // --- IDREF validation (aria-describedby / aria-errormessage / aria-labelledby) ---
      var doc = el.ownerDocument || document;
      var root = el.getRootNode ? el.getRootNode() : doc;
      function checkIdRef(attrName, value) {
        if (!value) return;
        var ids = value.trim().split(/\s+/);
        var missing = ids.filter(function (id) {
          var ref = (root.getElementById && root.getElementById(id)) || doc.getElementById(id);
          return !ref;
        });
        if (missing.length) {
          issues.push({
            category: "bad-idref",
            text: attrName + ' references non-existent ID' + (missing.length > 1 ? "s" : "") + ": " + missing.map(function (i) { return '"' + i + '"'; }).join(", ")
          });
        }
      }
      checkIdRef("aria-describedby", describedby);
      checkIdRef("aria-errormessage", errormessage);
      checkIdRef("aria-labelledby", el.getAttribute("aria-labelledby"));
      checkIdRef("aria-controls", el.getAttribute("aria-controls"));

      // aria-invalid="true" with no described-by / errormessage
      if (ariaInvalid === "true" && !describedby && !errormessage) {
        issues.push({
          category: "invalid-no-error-ref",
          text: 'aria-invalid="true" set but the control has no aria-describedby or aria-errormessage pointing to an error message'
        });
      }

      // --- Autocomplete ---
      if (autocompleteResult.present && !autocompleteResult.valid) {
        issues.push({
          category: "invalid-autocomplete",
          text: 'autocomplete="' + autocompleteRaw + '" is invalid: ' + autocompleteResult.error
        });
      }
      if (!autocompleteResult.present && autocompleteSuggestion) {
        issues.push({
          category: "missing-autocomplete",
          text: 'looks like it collects personal info; consider autocomplete="' + autocompleteSuggestion + '" (WCAG 1.3.5 Identify Input Purpose)'
        });
      }

      // --- aria-disabled on focusable ---
      if (ariaDisabled && !disabledAttr) {
        // aria-disabled doesn't remove from tab order unless tabindex=-1 is also set
        var tabidx = el.getAttribute("tabindex");
        var stillFocusable = tabidx === null || (tabidx !== "" && parseInt(tabidx, 10) >= 0);
        if (stillFocusable) {
          issues.push({
            category: "aria-disabled-focusable",
            text: 'aria-disabled="true" but the element is still in the tab order — keyboard users can focus a control that appears disabled. Add tabindex="-1" or use the disabled attribute instead.'
          });
        }
      }

      // --- <input type="image"> alt ---
      if (tag === "input" && type === "image" && !el.getAttribute("alt")) {
        issues.push({
          category: "image-input-no-alt",
          text: '<input type="image"> has no alt attribute'
        });
      }

      // --- Group membership flag (attached per member) ---
      // We compute this here so each radio/checkbox shows whether its group is properly fielded.
      if (tag === "input" && (type === "radio" || type === "checkbox") && el.name) {
        var key = (form ? "form" + (form.id || "X") : "noform") + "|" + el.name + "|" + type;
        var g = groupsByKey.get(key);
        if (g && g.members.length >= 2) {
          var info = isGroupedProperly(g.members);
          if (!info.grouped) {
            issues.push({
              category: "group-no-fieldset",
              text: g.members.length + ' ' + (type === "radio" ? "radio buttons" : "checkboxes") + ' share name="' + el.name + '" but are not wrapped in a <fieldset>+<legend> or a [role="group"] with an accessible name'
            });
          } else if (info.fieldset && info.legend) {
            if (!info.legendText) {
              issues.push({
                category: "empty-legend",
                text: "the <fieldset> wrapping this group has an empty <legend>"
              });
            }
          }
        }
      }

      results.push({
        domIndex: idx + 1,
        tag: tag,
        type: type || null,
        nameAttr: el.getAttribute("name") || null,
        idAttr: el.id || null,
        accName: name.name,
        accNameSrc: name.src,
        visibleLabelText: visibleLabelText,
        labels: labels.map(function (l) { return { kind: l.kind, forValue: l.forValue, labelText: txt(l.el.textContent), labelSelector: uniqueSelector(l.el) }; }),
        required: requiredAttr,
        ariaRequired: ariaRequired,
        disabled: disabledAttr,
        ariaDisabled: ariaDisabled,
        readonly: readonlyAttr,
        ariaInvalid: ariaInvalid,
        describedby: describedby,
        errormessage: errormessage,
        autocomplete: autocompleteRaw,
        autocompleteValid: autocompleteResult.valid,
        autocompleteError: autocompleteResult.error || null,
        autocompleteSuggestion: autocompleteSuggestion,
        formId: form ? (form.id || form.name || null) : null,
        formIndex: form ? (Array.prototype.indexOf.call(document.forms, form) + 1) : null,
        sampleValue: tag === "input" || tag === "textarea" ? (el.value || "").slice(0, 60) : "",
        placeholder: el.getAttribute("placeholder") || null,
        rowMembersCount: rowMembers.has(el) ? rowMembers.get(el).length : 0,
        issues: issues,
        selector: uniqueSelector(el),
        rect: { top: c.rect.top, left: c.rect.left, width: c.rect.width, height: c.rect.height }
      });
    });

    /* ----- per-form issues ----- */

    var formResults = [];
    Array.prototype.forEach.call(document.forms, function (form, fi) {
      var formIssues = [];
      // No submit button?
      var hasSubmit = !!form.querySelector('button:not([type="reset"]):not([type="button"]), input[type="submit"], input[type="image"], button[type="submit"]');
      if (!hasSubmit) {
        formIssues.push({
          category: "form-no-submit",
          text: 'form has no <button>, <input type="submit">, or <input type="image"> — may be submitted via JS only; verify keyboard submission works'
        });
      }
      // Native validation
      var novalidate = form.hasAttribute("novalidate");
      var validatingFields = [];
      if (!novalidate) {
        Array.prototype.forEach.call(form.querySelectorAll("input, select, textarea"), function (f) {
          var t = (f.getAttribute("type") || "text").toLowerCase();
          if (t === "hidden" || t === "submit" || t === "button" || t === "reset" || t === "image") return;
          if (f.hasAttribute("required") ||
              f.hasAttribute("pattern") ||
              t === "email" || t === "url" ||
              ((t === "number" || t === "range") && (f.hasAttribute("min") || f.hasAttribute("max") || f.hasAttribute("step"))) ||
              f.hasAttribute("minlength") || f.hasAttribute("maxlength")) {
            validatingFields.push({
              tag: f.tagName.toLowerCase(),
              name: f.getAttribute("name") || f.id || "",
              type: t,
              selector: uniqueSelector(f)
            });
          }
        });
        if (validatingFields.length) {
          formIssues.push({
            category: "form-native-validation",
            text: 'form lacks novalidate attribute and has ' + validatingFields.length + ' field(s) with constraint-validation triggers (required/pattern/email/url/min/max/minlength/maxlength). On invalid submit the browser shows bubble messages that auto-dismiss with no user control, position off-screen at high magnification, and are inconsistently announced by screen readers. Add novalidate and implement custom accessible validation.',
            validatingFields: validatingFields
          });
        }
      }

      formResults.push({
        formIndex: fi + 1,
        formId: form.id || null,
        formName: form.getAttribute("name") || null,
        formAction: form.getAttribute("action") || null,
        formMethod: form.getAttribute("method") || null,
        novalidate: novalidate,
        controlCount: results.filter(function (r) { return r.formIndex === fi + 1; }).length,
        issues: formIssues,
        selector: uniqueSelector(form)
      });
    });

    return {
      url: window.location.href,
      isTop: window === window.top,
      controls: results,
      forms: formResults,
      groups: groupResults,
      shadowRoots: shadowRoots
    };
  } catch (e) {
    return { url: window.location.href, isTop: window === window.top, error: String(e && e.message || e) };
  }
}

function displayForms(framesData, checkId) {
  "use strict";
  var P = "__a11yn_ext_";
  if (window[P + "cleanup"]) window[P + "cleanup"]();
  try {

  /* ----- aggregate from frames ----- */

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

  // Each frame contributes its own forms and controls. We tag each with the frame label.
  var allControls = [];
  var allForms = [];
  var unmatchedFrames = 0;
  var frameLabelByUrl = new Map();
  framesData.forEach(function (frame) {
    if (!frame || frame.error) return;
    var inFrame = !frame.isTop;
    var offX = 0, offY = 0, positioned = true;
    if (inFrame) {
      var iframe = iframeByUrl.get(frame.url);
      if (iframe) { var ir = iframe.getBoundingClientRect(); offX = ir.left; offY = ir.top; }
      else { positioned = false; unmatchedFrames++; }
    }
    if (inFrame) {
      try { var u = new URL(frame.url); frameLabelByUrl.set(frame.url, u.hostname + u.pathname.replace(/\/$/, "")); }
      catch (e) { frameLabelByUrl.set(frame.url, frame.url); }
    }
    var frameLabel = inFrame ? frameLabelByUrl.get(frame.url) : null;

    (frame.forms || []).forEach(function (f) {
      allForms.push(Object.assign({}, f, {
        frameUrl: frame.url, frameLabel: frameLabel, isTop: !inFrame
      }));
    });
    (frame.controls || []).forEach(function (c) {
      allControls.push(Object.assign({}, c, {
        frameUrl: frame.url, frameLabel: frameLabel, isTop: !inFrame,
        pageTop: window.scrollY + offY + c.rect.top,
        pageLeft: window.scrollX + offX + c.rect.left,
        positioned: positioned,
        iframeEl: inFrame ? iframeByUrl.get(frame.url) || null : null,
        _resolveEl: null
      }));
    });
  });

  // Assign a stable display index across frames
  allControls.forEach(function (c, i) { c.displayIndex = i + 1; });

  // Resolve element refs for outline + click-to-scroll
  allControls.forEach(function (r) {
    var doc;
    if (r.isTop) doc = document;
    else if (r.iframeEl) { try { doc = r.iframeEl.contentDocument; } catch (e) { doc = null; } }
    if (!doc) return;
    try {
      var el = doc.querySelector(r.selector);
      if (el) {
        r._resolveEl = el;
        var hasErr = r.issues.some(function (i) { return i.category === "unlabeled" || i.category === "bad-idref" || i.category === "required-aria-contradiction" || i.category === "invalid-autocomplete" || i.category === "image-input-no-alt" || i.category === "group-no-fieldset" || i.category === "invalid-no-error-ref"; });
        var hasWarn = r.issues.length > 0 && !hasErr;
        var color = hasErr ? "#b00020" : hasWarn ? "#b45309" : "#003876";
        var style = (hasErr || hasWarn) ? "dashed" : "solid";
        el.style.setProperty("outline", "2px " + style + " " + color, "important");
        el.style.setProperty("outline-offset", "1px", "important");
      }
    } catch (e) {}
  });

  /* ----- shadow UI ----- */

  var host = document.createElement("div");
  host.id = P + "host";
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "all:initial !important;position:absolute !important;top:0 !important;left:0 !important;width:0 !important;height:0 !important;margin:0 !important;padding:0 !important;border:0 !important;font:400 16px/1.4 ui-sans-serif,system-ui,sans-serif !important;color:#111 !important;pointer-events:none !important;z-index:2147483647 !important;";
  (document.body || document.documentElement).appendChild(host);
  var shadow = host.attachShadow({ mode: "closed" });

  var CATEGORY_COLORS = {
    "unlabeled":                  "#b00020",
    "placeholder-as-label":       "#b45309",
    "label-in-name-mismatch":     "#b45309",
    "wrapping-label-implicit":    "#b45309",
    "multiple-labels":            "#b45309",
    "label-not-left-aligned":     "#b45309",
    "label-side-positioned":      "#b45309",
    "label-below-input":          "#b45309",
    "multi-control-row":          "#b45309",
    "required-no-visible-indicator": "#b45309",
    "required-indicator-no-attr": "#b45309",
    "required-aria-contradiction":"#b00020",
    "required-no-aria-required":  "#7a4a09",
    "bad-idref":                  "#b00020",
    "invalid-no-error-ref":       "#b00020",
    "missing-autocomplete":       "#7a4a09",
    "invalid-autocomplete":       "#b00020",
    "aria-disabled-focusable":    "#b45309",
    "image-input-no-alt":         "#b00020",
    "group-no-fieldset":          "#b00020",
    "empty-legend":               "#b00020",
    "form-no-submit":             "#b45309",
    "form-native-validation":     "#b45309"
  };

  var css =
    ":host{all:initial;font-family:ui-sans-serif,system-ui,sans-serif !important;}" +
    "*,*::before,*::after{box-sizing:border-box;font-family:ui-sans-serif,system-ui,sans-serif !important;font-style:normal !important;font-weight:400 !important;font-variant:normal !important;text-transform:none !important;letter-spacing:normal !important;text-decoration:none !important;color:#111;}" +
    ".badge{position:absolute;background:#003876;color:#fff;font-size:16px;font-weight:600 !important;line-height:1.2;padding:4px 8px;border-radius:3px;pointer-events:none;max-width:380px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,.4);}" +
    ".badge.err{background:#b00020;}" +
    ".badge.warn{background:#b45309;}" +
    ".badge.frame{filter:saturate(0.7) brightness(0.9);}" +
    ".panel{position:fixed;top:12px;right:12px;width:640px;max-height:85vh;display:flex;flex-direction:column;background:#fff;color:#111;border:1px solid #bbb;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.25);font-size:16px;line-height:1.4;pointer-events:auto;}" +
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
    ".panel .body{overflow:auto;flex:1 1 auto;}" +
    ".panel .formsection{border-bottom:2px solid #ddd;}" +
    ".panel .formsection > .formhead{padding:8px 14px;background:#eef4ff;font-size:14px;font-weight:600 !important;color:#003876;border-top:1px solid #c5d4e8;}" +
    ".panel .formsection > .formhead .formissues{margin-top:4px;font-size:13px;color:#b00020;font-weight:600 !important;}" +
    ".panel .formsection > .formhead .formwarn{margin-top:4px;font-size:13px;color:#b45309;font-weight:600 !important;}" +
    ".panel ol{margin:0;padding:0;list-style:none;}" +
    ".panel li{padding:10px 14px;border-bottom:1px solid #eee;cursor:pointer;font-size:16px;border-left:4px solid transparent;}" +
    ".panel li:hover{background:#eef4ff;}" +
    ".panel li.has-err{border-left-color:#b00020;}" +
    ".panel li.has-warn{border-left-color:#b45309;}" +
    ".panel.filter-issues li:not(.has-err):not(.has-warn){display:none;}" +
    ".panel.filter-unlabeled li:not(.has-unlabeled){display:none;}" +
    ".panel.filter-required li:not(.has-required-issue){display:none;}" +
    ".panel.filter-wiring li:not(.has-wiring-issue){display:none;}" +
    ".panel.filter-radio-groups li:not(.has-group-issue){display:none;}" +
    ".panel.filter-autocomplete li:not(.has-autocomplete-issue){display:none;}" +
    ".panel.filter-wrapping li:not(.has-wrapping-issue){display:none;}" +
    ".panel.filter-layout li:not(.has-layout-issue){display:none;}" +
    ".panel.filter-validation .formsection:not(.has-form-validation),.panel.filter-validation li{display:none;}" +
    ".panel.filter-validation .formsection.has-form-validation{display:block;}" +
    ".panel li .meta{color:#555;font-size:14px;margin-bottom:2px;display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;}" +
    ".panel li .frame-label{color:#0a5d2e;font-weight:600;}" +
    ".panel li .accname{font-weight:600 !important;color:#111;font-size:16px;word-break:break-word;}" +
    ".panel li .accname.empty{color:#b00020;font-style:italic;}" +
    ".panel li .accsource{color:#666;font-size:13px;font-style:italic;}" +
    ".panel li .badges{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;font-size:12px;}" +
    ".panel li .smallchip{padding:1px 6px;border-radius:3px;background:rgba(0,0,0,.06);color:#333;font-weight:600 !important;}" +
    ".panel li .smallchip.req{background:#003876;color:#fff !important;}" +
    ".panel li .smallchip.disabled{background:#888;color:#fff !important;}" +
    ".panel li .smallchip.readonly{background:#5d4037;color:#fff !important;}" +
    ".panel li .smallchip.invalid{background:#b00020;color:#fff !important;}" +
    ".panel li .smallchip.auto{background:#0a5d2e;color:#fff !important;}" +
    ".panel li .issues{margin-top:6px;font-size:14px;}" +
    ".panel li .issue{display:flex;gap:6px;margin-top:2px;}" +
    ".panel li .issue .catchip{flex:0 0 auto;padding:1px 6px;border-radius:3px;color:#fff !important;font-size:11px;font-weight:700 !important;line-height:1.4;}" +
    ".panel li .issue .text{flex:1 1 auto;font-weight:600 !important;}" +
    ".panel li .src{color:#666;font-size:14px;font-style:italic;margin-top:3px;word-break:break-all;}" +
    ".panel code{font-family:ui-monospace,monospace !important;font-size:14px;background:rgba(0,0,0,.06);padding:1px 5px;border-radius:3px;}";

  var styleEl = document.createElement("style");
  styleEl.textContent = css;
  shadow.appendChild(styleEl);

  /* ----- badges on the page ----- */

  var badges = [];
  allControls.forEach(function (r) {
    if (!r.positioned) return;
    var hasErr = r.issues.some(function (i) {
      var c = i.category;
      return c === "unlabeled" || c === "bad-idref" || c === "required-aria-contradiction" ||
             c === "invalid-autocomplete" || c === "image-input-no-alt" || c === "group-no-fieldset" ||
             c === "invalid-no-error-ref" || c === "empty-legend";
    });
    var hasWarn = r.issues.length > 0 && !hasErr;
    var badge = document.createElement("div");
    var cls = "badge";
    if (hasErr) cls += " err";
    else if (hasWarn) cls += " warn";
    if (!r.isTop) cls += " frame";
    badge.className = cls;
    var prefix = r.isTop ? "" : "[frame] ";
    var nameStr = r.accName ? r.accName : "(no name)";
    badge.textContent = "#" + r.displayIndex + " " + prefix + r.tag + (r.type ? "[" + r.type + "]" : "") + ": " + nameStr;
    badge.style.top = (r.pageTop - 28) + "px";
    badge.style.left = r.pageLeft + "px";
    shadow.appendChild(badge);
    badges.push(badge);
    r.badge = badge;
  });

  /* ----- markdown ----- */

  function mdEsc(s) { return String(s).replace(/\|/g, "\\|").replace(/\n+/g, " "); }
  var md = "## Forms\n\n";
  if (allForms.length === 0) {
    md += "*(no <form> elements; controls listed without form grouping)*\n\n";
  }
  allForms.forEach(function (f) {
    md += "### Form #" + f.formIndex + (f.formId ? ' id="' + mdEsc(f.formId) + '"' : "") + (f.frameLabel ? " in " + mdEsc(f.frameLabel) : "") + "\n\n";
    f.issues.forEach(function (i) {
      md += "- ⚠ **" + i.category + "** — " + mdEsc(i.text) + "\n";
    });
    if (f.issues.length) md += "\n";
  });
  md += "### Controls\n\n";
  md += "| # | Frame | Form | Tag | Type | Name | acc-name source | Visible label | Required | autocomplete | Issues | Selector |\n";
  md += "|---|-------|------|-----|------|------|-----------------|---------------|----------|--------------|--------|----------|\n";
  allControls.forEach(function (r) {
    var issues = r.issues.length ? "⚠ " + r.issues.map(function (i) { return mdEsc(i.text); }).join("; ") : "";
    var frameLabel = r.isTop ? "(top)" : mdEsc(r.frameLabel || r.frameUrl);
    var formCell = r.formIndex ? "#" + r.formIndex : "(no form)";
    md += "| " + r.displayIndex + " | " + frameLabel + " | " + formCell + " | `" + r.tag + "` | " + (r.type || "") + " | " + (r.nameAttr ? "`" + mdEsc(r.nameAttr) + "`" : "") + " | `" + mdEsc(r.accName || "(empty)") + "` | " + (r.accNameSrc || "") + " | " + mdEsc(r.visibleLabelText || "") + " | " + (r.required ? "yes" : r.ariaRequired ? "aria=" + r.ariaRequired : "") + " | `" + mdEsc(r.autocomplete || "(none)") + "`" + (r.autocompleteSuggestion ? " *(suggest: " + r.autocompleteSuggestion + ")*" : "") + " | " + issues + " | `" + mdEsc(r.selector) + "` |\n";
  });

  /* ----- counts + summary ----- */

  var issueCount = allControls.filter(function (r) { return r.issues.length > 0; }).length;
  var formIssueCount = allForms.filter(function (f) { return f.issues.length > 0; }).length;
  var counts = {
    unlabeled: allControls.filter(function (r) { return r.issues.some(function (i) { return i.category === "unlabeled"; }); }).length,
    requiredProblems: allControls.filter(function (r) { return r.issues.some(function (i) { return /required-/.test(i.category); }); }).length,
    wiring: allControls.filter(function (r) { return r.issues.some(function (i) { return i.category === "bad-idref" || i.category === "invalid-no-error-ref"; }); }).length,
    radioGroups: allControls.filter(function (r) { return r.issues.some(function (i) { return i.category === "group-no-fieldset" || i.category === "empty-legend"; }); }).length,
    autocomplete: allControls.filter(function (r) { return r.issues.some(function (i) { return i.category === "missing-autocomplete" || i.category === "invalid-autocomplete"; }); }).length,
    wrapping: allControls.filter(function (r) { return r.issues.some(function (i) { return i.category === "wrapping-label-implicit"; }); }).length,
    layout: allControls.filter(function (r) { return r.issues.some(function (i) { return i.category === "label-not-left-aligned" || i.category === "label-side-positioned" || i.category === "label-below-input" || i.category === "multi-control-row"; }); }).length,
    validation: allForms.filter(function (f) { return f.issues.some(function (i) { return i.category === "form-native-validation"; }); }).length
  };
  var frameCount = framesData.filter(function (f) { return !f.isTop && (f.controls && f.controls.length || f.forms && f.forms.length); }).length;

  console.group("%c[a11yn forms] " + allControls.length + " controls across " + allForms.length + " form(s) — " + issueCount + " controls with issues, " + formIssueCount + " forms with issues",
    "color:#003876;font-weight:bold;font-size:13px");
  console.table(allControls.map(function (r) {
    return {
      "#": r.displayIndex,
      frame: r.isTop ? "(top)" : (r.frameLabel || r.frameUrl),
      form: r.formIndex || "(none)",
      tag: r.tag,
      type: r.type || "",
      name: r.nameAttr || "",
      acc: r.accName || "(empty)",
      "acc-src": r.accNameSrc,
      label: r.visibleLabelText,
      req: r.required ? "yes" : r.ariaRequired || "",
      ac: r.autocomplete || "",
      issues: r.issues.length
    };
  }));
  console.log("%cMarkdown:", "font-weight:bold");
  console.log(md);
  console.groupEnd();

  /* ----- panel ----- */

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }

  var panelEl = document.createElement("div");
  panelEl.className = "panel filter-all";

  var summary = "";
  if (allControls.length === 0) {
    summary += '<span class="warn">No form controls found.</span>';
  } else if (issueCount === 0 && formIssueCount === 0) {
    summary += '<span class="ok">All ' + allControls.length + ' controls and ' + allForms.length + ' form(s) look fine.</span>';
  } else {
    summary += '<span class="miss">' + issueCount + ' control' + (issueCount === 1 ? "" : "s") + ' with issues';
    if (formIssueCount) summary += ", " + formIssueCount + " form" + (formIssueCount === 1 ? "" : "s") + " with issues";
    summary += '</span>';
  }
  summary += '<div style="margin-top:6px;color:#555;font-size:14px">' +
    allControls.length + ' controls · ' + allForms.length + ' form(s) · top doc' +
    (frameCount ? ' + ' + frameCount + ' frame' + (frameCount === 1 ? "" : "s") : "") +
    (unmatchedFrames ? ' · ⚠ ' + unmatchedFrames + ' unpositioned frame(s)' : "") +
    '</div>';

  panelEl.innerHTML =
    "<header><strong>Forms (" + allControls.length + " ctrl / " + allForms.length + " form)</strong>" +
    '<div class="btns"><button id="' + P + 'copy">Copy MD</button><button id="' + P + 'close">Close</button></div></header>' +
    '<div class="filterbar">' +
      '<button data-filter="all" class="active">All (' + allControls.length + ')</button>' +
      '<button data-filter="issues">Issues (' + issueCount + ')</button>' +
      '<button data-filter="unlabeled">Unlabeled (' + counts.unlabeled + ')</button>' +
      '<button data-filter="required">Required (' + counts.requiredProblems + ')</button>' +
      '<button data-filter="wiring">Invalid wiring (' + counts.wiring + ')</button>' +
      '<button data-filter="radio-groups">Radio groups (' + counts.radioGroups + ')</button>' +
      '<button data-filter="autocomplete">Autocomplete (' + counts.autocomplete + ')</button>' +
      '<button data-filter="wrapping">Wrapping labels (' + counts.wrapping + ')</button>' +
      '<button data-filter="layout">Layout (' + counts.layout + ')</button>' +
      '<button data-filter="validation">Native validation (' + counts.validation + ')</button>' +
    '</div>' +
    '<div class="summary">' + summary + "</div>" +
    '<div class="body" id="' + P + 'body"></div>';

  // Group controls by form. Build a section per form, plus a "(no form)" section.
  var bodyEl = panelEl.querySelector("#" + P + "body");
  function addFormSection(form, controls) {
    var section = document.createElement("div");
    section.className = "formsection";
    var formIssuesHtml = "";
    var hasValidation = false;
    var formIssueClasses = "";
    if (form) {
      if (form.issues.some(function (i) { return i.category === "form-native-validation"; })) { hasValidation = true; section.classList.add("has-form-validation"); }
      var issueLines = form.issues.map(function (i) {
        var cls = (i.category === "form-no-submit") ? "formwarn" : "formissues";
        return '<div class="' + cls + '">⚠ <strong>' + esc(i.category) + '</strong> — ' + esc(i.text) + (i.validatingFields ? " — fields: " + i.validatingFields.map(function (vf) { return esc(vf.name || vf.tag) + "/" + esc(vf.type); }).join(", ") : "") + "</div>";
      }).join("");
      formIssuesHtml = issueLines;
    }
    var formTitle;
    if (form) {
      formTitle = '<strong>Form #' + form.formIndex + '</strong>';
      if (form.formId) formTitle += ' <code>id="' + esc(form.formId) + '"</code>';
      if (form.formName) formTitle += ' name="' + esc(form.formName) + '"';
      if (form.formAction) formTitle += ' action=' + esc(form.formAction.length > 40 ? form.formAction.slice(0, 40) + "…" : form.formAction);
      formTitle += ' · ' + controls.length + ' control' + (controls.length === 1 ? "" : "s");
      if (form.novalidate) formTitle += ' · <span style="color:#0a8043">novalidate</span>';
      if (form.frameLabel) formTitle += ' <span style="color:#0a5d2e">[' + esc(form.frameLabel) + ']</span>';
    } else {
      formTitle = "<strong>Controls outside any &lt;form&gt; (" + controls.length + ")</strong>";
    }
    var head = document.createElement("div");
    head.className = "formhead";
    head.innerHTML = formTitle + formIssuesHtml;
    section.appendChild(head);

    var list = document.createElement("ol");
    controls.forEach(function (r) {
      var li = document.createElement("li");
      var hasErr = r.issues.some(function (i) {
        var c = i.category;
        return c === "unlabeled" || c === "bad-idref" || c === "required-aria-contradiction" ||
               c === "invalid-autocomplete" || c === "image-input-no-alt" || c === "group-no-fieldset" ||
               c === "invalid-no-error-ref" || c === "empty-legend";
      });
      var hasWarn = r.issues.length > 0 && !hasErr;
      if (hasErr) li.classList.add("has-err");
      if (hasWarn) li.classList.add("has-warn");
      // Filter classes
      r.issues.forEach(function (i) {
        if (i.category === "unlabeled") li.classList.add("has-unlabeled");
        if (/^required-/.test(i.category)) li.classList.add("has-required-issue");
        if (i.category === "bad-idref" || i.category === "invalid-no-error-ref") li.classList.add("has-wiring-issue");
        if (i.category === "group-no-fieldset" || i.category === "empty-legend") li.classList.add("has-group-issue");
        if (i.category === "missing-autocomplete" || i.category === "invalid-autocomplete") li.classList.add("has-autocomplete-issue");
        if (i.category === "wrapping-label-implicit") li.classList.add("has-wrapping-issue");
        if (i.category === "label-not-left-aligned" || i.category === "label-side-positioned" || i.category === "label-below-input" || i.category === "multi-control-row") li.classList.add("has-layout-issue");
      });

      var nameHtml;
      if (r.accName) {
        nameHtml = '<div class="accname">' + esc(r.accName) + '</div><div class="accsource">via ' + esc(r.accNameSrc) + '</div>';
      } else {
        nameHtml = '<div class="accname empty">(no accessible name)</div>';
      }

      var location = r.isTop ? "" : '<span class="frame-label">[' + esc(r.frameLabel || r.frameUrl) + ']</span> ';
      var tagDesc = "<code>&lt;" + esc(r.tag) + (r.type ? ' type="' + esc(r.type) + '"' : "") + "&gt;</code>";

      var chips = [];
      if (r.required) chips.push('<span class="smallchip req">required</span>');
      if (r.ariaRequired === "true" && !r.required) chips.push('<span class="smallchip req">aria-required</span>');
      if (r.disabled) chips.push('<span class="smallchip disabled">disabled</span>');
      if (r.ariaDisabled && !r.disabled) chips.push('<span class="smallchip disabled">aria-disabled</span>');
      if (r.readonly) chips.push('<span class="smallchip readonly">readonly</span>');
      if (r.ariaInvalid === "true") chips.push('<span class="smallchip invalid">aria-invalid</span>');
      if (r.autocomplete) chips.push('<span class="smallchip auto">autocomplete=' + esc(r.autocomplete) + '</span>');

      var issuesHtml = "";
      if (r.issues.length) {
        issuesHtml = '<div class="issues">' + r.issues.map(function (iss) {
          var color = CATEGORY_COLORS[iss.category] || "#b00020";
          return '<div class="issue"><span class="catchip" style="background:' + color + '">' + esc(iss.category) + '</span><span class="text">' + esc(iss.text) + '</span></div>';
        }).join("") + '</div>';
      }

      li.innerHTML =
        '<div class="meta">' +
          '<span style="color:#999">#' + r.displayIndex + '</span> ' + location + tagDesc +
          (r.nameAttr ? ' name="' + esc(r.nameAttr) + '"' : "") +
        '</div>' +
        nameHtml +
        (r.visibleLabelText && r.visibleLabelText !== r.accName ? '<div style="color:#666;font-size:13px">visible label: "' + esc(r.visibleLabelText) + '"</div>' : "") +
        (chips.length ? '<div class="badges">' + chips.join("") + '</div>' : "") +
        issuesHtml +
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
    section.appendChild(list);
    bodyEl.appendChild(section);
  }

  // Forms first
  allForms.forEach(function (f) {
    var ctrls = allControls.filter(function (c) { return c.formIndex === f.formIndex && (c.frameUrl === f.frameUrl); });
    addFormSection(f, ctrls);
  });
  // Orphan controls (no form)
  var orphan = allControls.filter(function (c) { return !c.formIndex; });
  if (orphan.length) addFormSection(null, orphan);

  shadow.appendChild(panelEl);

  /* ----- filter bar wiring ----- */

  panelEl.querySelectorAll(".filterbar button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var filter = btn.dataset.filter;
      panelEl.className = "panel filter-" + filter;
      panelEl.querySelectorAll(".filterbar button").forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
    });
  });

  /* ----- drag ----- */

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
    allControls.forEach(function (r) {
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

  } catch (displayErr) {
    console.error("[a11yn forms display error]", displayErr);
    try {
      var errHost = document.createElement("div");
      errHost.style.cssText = "all:initial !important;position:fixed !important;top:12px !important;right:12px !important;z-index:2147483647 !important;background:#b00020 !important;color:#fff !important;padding:12px 16px !important;font:600 14px/1.4 ui-sans-serif,system-ui,sans-serif !important;border-radius:6px !important;max-width:400px !important;box-shadow:0 6px 20px rgba(0,0,0,.25) !important;white-space:pre-wrap !important;";
      errHost.textContent = "Forms display error: " + (displayErr && displayErr.message ? displayErr.message : displayErr) + ". See page DevTools console for full stack.";
      (document.body || document.documentElement).appendChild(errHost);
      setTimeout(function () { try { errHost.remove(); } catch (e) {} }, 10000);
    } catch (e) {}
  }
}

/* ====================================================================
 * CHECK: TABLES — table semantics inspector
 *
 * Covers WCAG 1.3.1 Info and Relationships. Every <table> (and any
 * element with role="table"/role="grid") on the page is classified
 * data / layout-declared / ambiguous and inspected for issues:
 *
 *   data-no-name              data table lacks <caption>, aria-label, aria-labelledby
 *   data-no-headers           data table has no <th> anywhere
 *   caption-not-first-child   <caption> exists but isn't the first child of <table>
 *   multiple-captions         more than one <caption> inside one <table>
 *   summary-attribute         summary= used (obsolete in HTML5)
 *   presentation-with-data    role="presentation"/"none" but table has data signals
 *   layout-with-data-signals  no <th> but has <caption>/summary/aria-label
 *   nested-table              <table> inside another <table>
 *   th-empty                  <th> with no accessible name
 *   th-invalid-scope          scope= not in row/col/rowgroup/colgroup
 *   th-missing-scope-complex  <th> with no scope= in a table that has both row & col headers
 *   spanned-cell-no-headers   cell with colspan/rowspan > 1 has no headers= in a complex table
 *   bad-headers-idref         headers= references an ID that doesn't exist or isn't a <th> in the same table
 *   th-without-table          <th> outside any <table>
 *   likely-data-no-th         no <th>, but first row visually styled as headers
 *
 * Each table also reports row/col counts and a small <th> inventory.
 * ==================================================================== */

function scanTables() {
  "use strict";
  try {
    var results = [];
    var shadowRoots = 0;
    var url = location.href;
    var isTop = (function () { try { return window.top === window.self; } catch (e) { return false; } })();
    var idCounter = 0;

    function txt(el) {
      if (!el) return "";
      var s = (el.textContent || "").replace(/\s+/g, " ").trim();
      return s;
    }

    function isHidden(el) {
      if (!el || el.nodeType !== 1) return false;
      var n = el;
      while (n && n.nodeType === 1) {
        var cs;
        try { cs = getComputedStyle(n); } catch (e) { return false; }
        if (!cs) return false;
        if (cs.display === "none" || cs.visibility === "hidden") return true;
        n = n.parentNode || (n.getRootNode && n.getRootNode().host);
      }
      return false;
    }

    function ariaHidden(el) {
      for (var n = el; n && n.nodeType === 1; n = n.parentNode || (n.getRootNode && n.getRootNode().host)) {
        if (n.getAttribute && n.getAttribute("aria-hidden") === "true") return true;
      }
      return false;
    }

    function uniqueSelector(el) {
      if (!el || el.nodeType !== 1) return "";
      var path = [];
      var node = el;
      while (node && node.nodeType === 1) {
        if (node.id) {
          path.unshift("#" + CSS.escape(node.id));
          break;
        }
        var name = node.tagName.toLowerCase();
        var parent = node.parentNode;
        if (parent && parent.nodeType === 1) {
          var i = 1, sib = node.previousElementSibling;
          while (sib) {
            if (sib.tagName === node.tagName) i++;
            sib = sib.previousElementSibling;
          }
          name += ":nth-of-type(" + i + ")";
        }
        path.unshift(name);
        node = parent;
        if (!node || (node && node.nodeType === 11)) break; // stop at shadow root / document fragment
      }
      return path.join(" > ");
    }

    function accName(el) {
      if (!el) return "";
      // aria-labelledby
      var alb = el.getAttribute && el.getAttribute("aria-labelledby");
      if (alb) {
        var ids = alb.split(/\s+/).filter(Boolean);
        var pieces = [];
        for (var i = 0; i < ids.length; i++) {
          var root = el.getRootNode ? el.getRootNode() : document;
          var ref = root.getElementById ? root.getElementById(ids[i]) : null;
          if (!ref) ref = document.getElementById(ids[i]);
          if (ref) pieces.push(txt(ref));
        }
        var joined = pieces.join(" ").trim();
        if (joined) return joined;
      }
      // aria-label
      var al = el.getAttribute && el.getAttribute("aria-label");
      if (al && al.trim()) return al.trim();
      // <caption>
      if (el.tagName === "TABLE") {
        var cap = el.querySelector(":scope > caption");
        if (cap) {
          var capText = txt(cap);
          if (capText) return capText;
        }
      }
      // title
      var ti = el.getAttribute && el.getAttribute("title");
      if (ti && ti.trim()) return ti.trim();
      return "";
    }

    function thAccName(th) {
      var alb = th.getAttribute("aria-labelledby");
      if (alb) {
        var ids = alb.split(/\s+/).filter(Boolean);
        var pieces = [];
        for (var i = 0; i < ids.length; i++) {
          var root = th.getRootNode ? th.getRootNode() : document;
          var ref = root.getElementById ? root.getElementById(ids[i]) : null;
          if (!ref) ref = document.getElementById(ids[i]);
          if (ref) pieces.push(txt(ref));
        }
        var joined = pieces.join(" ").trim();
        if (joined) return joined;
      }
      var al = th.getAttribute("aria-label");
      if (al && al.trim()) return al.trim();
      var t = txt(th);
      if (t) return t;
      // image-only header
      var img = th.querySelector("img[alt]");
      if (img) {
        var alt = img.getAttribute("alt");
        if (alt && alt.trim()) return alt.trim();
      }
      var ti = th.getAttribute("title");
      if (ti && ti.trim()) return ti.trim();
      return "";
    }

    var VALID_SCOPE = { row: 1, col: 1, rowgroup: 1, colgroup: 1 };

    function looksLikeHeaderRow(tr) {
      if (!tr) return false;
      var cells = tr.children;
      if (!cells || cells.length < 2) return false;
      var anyTh = false, all = true, count = 0;
      for (var i = 0; i < cells.length; i++) {
        var c = cells[i];
        if (c.tagName !== "TD" && c.tagName !== "TH") continue;
        count++;
        if (c.tagName === "TH") anyTh = true;
        if (c.tagName === "TD") {
          var t = txt(c);
          if (!t) { all = false; continue; }
          var cs;
          try { cs = getComputedStyle(c); } catch (e) { cs = null; }
          var weight = cs ? cs.fontWeight : "";
          // Treat as "header-styled" if bold (>= 600) OR contains a <strong>/<b>
          var bold = (weight === "bold" || (weight && parseInt(weight, 10) >= 600));
          var hasStrong = !!c.querySelector("strong, b");
          if (!(bold || hasStrong)) { all = false; }
        }
      }
      return count >= 2 && all && !anyTh;
    }

    function getTableCells(table) {
      // Direct cells in this table only, not nested table cells.
      var cells = [];
      function walk(node) {
        for (var i = 0; i < node.children.length; i++) {
          var c = node.children[i];
          if (c.tagName === "TABLE") continue; // skip nested
          if (c.tagName === "TD" || c.tagName === "TH") cells.push(c);
          else walk(c);
        }
      }
      walk(table);
      return cells;
    }

    function getTableRows(table) {
      var rows = [];
      function walk(node) {
        for (var i = 0; i < node.children.length; i++) {
          var c = node.children[i];
          if (c.tagName === "TABLE") continue;
          if (c.tagName === "TR") rows.push(c);
          else walk(c);
        }
      }
      walk(table);
      return rows;
    }

    function colsInRow(tr) {
      var n = 0;
      for (var i = 0; i < tr.children.length; i++) {
        var c = tr.children[i];
        if (c.tagName !== "TD" && c.tagName !== "TH") continue;
        var span = parseInt(c.getAttribute("colspan") || "1", 10);
        if (!isFinite(span) || span < 1) span = 1;
        n += span;
      }
      return n;
    }

    function analyseTable(table) {
      var entry = {
        idx: ++idCounter,
        sel: uniqueSelector(table),
        tag: table.tagName.toLowerCase(),
        role: (table.getAttribute && table.getAttribute("role")) || "",
        ariaLabel: (table.getAttribute && table.getAttribute("aria-label")) || "",
        ariaLabelledby: (table.getAttribute && table.getAttribute("aria-labelledby")) || "",
        captionText: "",
        summaryAttr: (table.getAttribute && table.getAttribute("summary")) || "",
        accName: "",
        rows: 0,
        cols: 0,
        hasThead: false,
        hasTbody: false,
        hasTfoot: false,
        thInventory: { col: 0, row: 0, rowgroup: 0, colgroup: 0, unscoped: 0, total: 0 },
        status: "data",
        hidden: isHidden(table) || ariaHidden(table),
        issues: [],
        _resolveSel: uniqueSelector(table)
      };
      entry.accName = accName(table);

      var captions = table.tagName === "TABLE" ? table.querySelectorAll(":scope > caption") : [];
      if (captions && captions.length > 0) {
        entry.captionText = txt(captions[0]);
        if (captions.length > 1) {
          entry.issues.push({ type: "multiple-captions", text: "Table has " + captions.length + " <caption> elements (only one is allowed)" });
        }
        if (table.firstElementChild && table.firstElementChild.tagName !== "CAPTION") {
          entry.issues.push({ type: "caption-not-first-child", text: "<caption> must be the first child of <table>" });
        }
      }

      if (table.tagName === "TABLE") {
        entry.hasThead = !!table.querySelector(":scope > thead");
        entry.hasTbody = !!table.querySelector(":scope > tbody");
        entry.hasTfoot = !!table.querySelector(":scope > tfoot");
      }

      var rows = table.tagName === "TABLE" ? getTableRows(table) : [];
      entry.rows = rows.length;
      var maxCols = 0;
      for (var i = 0; i < rows.length; i++) {
        var c = colsInRow(rows[i]);
        if (c > maxCols) maxCols = c;
      }
      entry.cols = maxCols;

      // Collect <th> inventory and check scope validity.
      var ths = [];
      if (table.tagName === "TABLE") {
        var raw = table.querySelectorAll("th");
        for (var j = 0; j < raw.length; j++) {
          // skip <th> belonging to a nested table
          var anc = raw[j].parentNode;
          var insideThis = false;
          while (anc) {
            if (anc.tagName === "TABLE") { insideThis = (anc === table); break; }
            anc = anc.parentNode;
          }
          if (insideThis) ths.push(raw[j]);
        }
      }
      entry.thInventory.total = ths.length;
      for (var k = 0; k < ths.length; k++) {
        var th = ths[k];
        var sc = (th.getAttribute("scope") || "").trim().toLowerCase();
        if (sc) {
          if (VALID_SCOPE[sc]) {
            entry.thInventory[sc]++;
          } else {
            entry.issues.push({
              type: "th-invalid-scope",
              text: "<th> has invalid scope=\"" + th.getAttribute("scope") + "\" (must be row, col, rowgroup, or colgroup) — " + uniqueSelector(th)
            });
          }
        } else {
          entry.thInventory.unscoped++;
        }
        // empty <th>?
        if (!thAccName(th)) {
          entry.issues.push({
            type: "th-empty",
            text: "Empty <th> — no text, no aria-label, no aria-labelledby, no image alt — " + uniqueSelector(th)
          });
        }
      }

      // Determine whether the table has both row and column headers.
      var hasColHeaders = entry.thInventory.col > 0 || entry.thInventory.colgroup > 0;
      var hasRowHeaders = entry.thInventory.row > 0 || entry.thInventory.rowgroup > 0;
      // If no scope at all, fall back to position-based detection.
      if (!hasColHeaders && !hasRowHeaders && ths.length > 0) {
        // any <th> in first row?
        var firstRow = rows[0];
        var firstRowHasTh = false;
        if (firstRow) {
          for (var fr = 0; fr < firstRow.children.length; fr++) {
            if (firstRow.children[fr].tagName === "TH") { firstRowHasTh = true; break; }
          }
        }
        if (firstRowHasTh) hasColHeaders = true;
        // any <th> as first cell in non-first rows?
        var firstColTh = false;
        for (var rr = 1; rr < rows.length; rr++) {
          var cells = rows[rr].children;
          if (cells.length > 0 && cells[0].tagName === "TH") { firstColTh = true; break; }
        }
        if (firstColTh) hasRowHeaders = true;
      }
      var complex = hasColHeaders && hasRowHeaders;

      // If complex, <th> without scope= is ambiguous.
      if (complex) {
        for (var x = 0; x < ths.length; x++) {
          var th2 = ths[x];
          var sc2 = (th2.getAttribute("scope") || "").trim().toLowerCase();
          if (!sc2) {
            entry.issues.push({
              type: "th-missing-scope-complex",
              text: "<th> in a table with both row and column headers needs scope=\"row\"/\"col\" to disambiguate — " + uniqueSelector(th2) + (txt(th2) ? " (\"" + txt(th2).slice(0, 30) + "\")" : "")
            });
          }
        }
      }

      // Spanned cells without explicit headers= in a complex table.
      if (complex && table.tagName === "TABLE") {
        var allCells = getTableCells(table);
        for (var y = 0; y < allCells.length; y++) {
          var cell = allCells[y];
          var cs = parseInt(cell.getAttribute("colspan") || "1", 10);
          var rs = parseInt(cell.getAttribute("rowspan") || "1", 10);
          if ((cs > 1 || rs > 1) && !cell.getAttribute("headers")) {
            entry.issues.push({
              type: "spanned-cell-no-headers",
              text: (cell.tagName === "TH" ? "<th> " : "<td> ") + "with colspan/rowspan > 1 in a complex table has no headers= attribute — " + uniqueSelector(cell)
            });
          }
        }
      }

      // Validate every headers= idref inside this table.
      if (table.tagName === "TABLE") {
        var allCells2 = getTableCells(table);
        for (var z = 0; z < allCells2.length; z++) {
          var c2 = allCells2[z];
          var hattr = c2.getAttribute("headers");
          if (!hattr) continue;
          var ids = hattr.split(/\s+/).filter(Boolean);
          var missing = [];
          var notTh = [];
          for (var ii = 0; ii < ids.length; ii++) {
            var ref = table.querySelector("#" + CSS.escape(ids[ii]));
            if (!ref) {
              // not in this table, try whole doc
              var anyRef = document.getElementById(ids[ii]);
              if (!anyRef) missing.push(ids[ii]);
              else notTh.push(ids[ii] + " (outside this table)");
            } else if (ref.tagName !== "TH") {
              notTh.push(ids[ii] + " (not a <th>)");
            }
          }
          if (missing.length || notTh.length) {
            var bits = [];
            if (missing.length) bits.push("missing: " + missing.join(", "));
            if (notTh.length) bits.push("invalid: " + notTh.join(", "));
            entry.issues.push({
              type: "bad-headers-idref",
              text: "headers= on cell references " + bits.join("; ") + " — " + uniqueSelector(c2)
            });
          }
        }
      }

      // Classification.
      var role = entry.role.toLowerCase();
      var isPresRole = role === "presentation" || role === "none";
      var dataSignals = [];
      if (entry.thInventory.total > 0) dataSignals.push("<th>");
      if (entry.captionText) dataSignals.push("<caption>");
      if (entry.summaryAttr) dataSignals.push("summary=");
      if (entry.ariaLabel) dataSignals.push("aria-label");
      if (entry.ariaLabelledby) dataSignals.push("aria-labelledby");
      if (role === "table" || role === "grid") dataSignals.push("role=" + role);

      if (isPresRole) {
        entry.status = "layout-declared";
        if (dataSignals.length) {
          entry.issues.push({
            type: "presentation-with-data",
            text: "Table has role=\"" + role + "\" but also carries data semantics: " + dataSignals.join(", ") + ". The role strips semantics, leaving the data elements meaningless."
          });
        }
      } else if (dataSignals.length > 0) {
        entry.status = "data";
      } else {
        entry.status = "ambiguous";
      }

      // Data-table-specific issues.
      if (entry.status === "data") {
        if (!entry.accName) {
          entry.issues.push({
            type: "data-no-name",
            text: "Data table has no accessible name (no <caption>, aria-label, or aria-labelledby). Screen readers can't announce what the table is about."
          });
        }
        if (entry.thInventory.total === 0) {
          entry.issues.push({
            type: "data-no-headers",
            text: "Data table has no <th> elements. Cells have no programmatic header association."
          });
        }
      }

      // Layout/ambiguous tables with data signals (but no <th>).
      if ((entry.status === "ambiguous" || (entry.status === "data" && entry.thInventory.total === 0)) && !isPresRole) {
        var mixed = [];
        if (entry.captionText) mixed.push("<caption>");
        if (entry.summaryAttr) mixed.push("summary=");
        if (entry.ariaLabel) mixed.push("aria-label");
        if (entry.ariaLabelledby) mixed.push("aria-labelledby");
        if (entry.thInventory.total === 0 && mixed.length > 1) {
          entry.issues.push({
            type: "layout-with-data-signals",
            text: "Table has no <th> but carries multiple naming signals: " + mixed.join(", ") + ". Either make it a real data table (add <th>) or remove the labels."
          });
        }
      }

      // Obsolete summary= attribute.
      if (entry.summaryAttr) {
        entry.issues.push({
          type: "summary-attribute",
          text: "summary=\"" + entry.summaryAttr.slice(0, 60) + (entry.summaryAttr.length > 60 ? "…" : "") + "\" — the summary attribute is obsolete in HTML5. Use <caption> or aria-describedby instead."
        });
      }

      // Nested table detection.
      if (table.tagName === "TABLE") {
        var anc2 = table.parentNode;
        while (anc2) {
          if (anc2.tagName === "TABLE") {
            entry.issues.push({
              type: "nested-table",
              text: "Table is nested inside another <table> (" + uniqueSelector(anc2) + "). Nesting confuses screen-reader table navigation."
            });
            break;
          }
          anc2 = anc2.parentNode;
        }
      }

      // Heuristic: ambiguous table whose first row is bold-styled (likely a missing-<th> case).
      if (entry.status === "ambiguous" && entry.thInventory.total === 0 && rows.length >= 2) {
        if (looksLikeHeaderRow(rows[0])) {
          entry.issues.push({
            type: "likely-data-no-th",
            text: "Table has no <th> but its first row is styled like headers (bold or <strong>). Use <th> to mark headers semantically."
          });
        }
      }

      return entry;
    }

    function walk(root) {
      if (!root) return;
      var tables;
      try {
        tables = root.querySelectorAll('table, [role="table"], [role="grid"]');
      } catch (e) {
        tables = [];
      }
      for (var i = 0; i < tables.length; i++) {
        results.push(analyseTable(tables[i]));
      }

      // <th> outside any <table>
      var orphanThs;
      try { orphanThs = root.querySelectorAll("th"); } catch (e) { orphanThs = []; }
      for (var t = 0; t < orphanThs.length; t++) {
        var th = orphanThs[t];
        var anc = th.parentNode;
        var inside = false;
        while (anc && anc.nodeType === 1) {
          if (anc.tagName === "TABLE") { inside = true; break; }
          anc = anc.parentNode;
        }
        if (!inside) {
          results.push({
            idx: ++idCounter,
            sel: uniqueSelector(th),
            tag: "th-orphan",
            status: "orphan",
            accName: thAccName(th),
            rows: 0, cols: 0,
            hasThead: false, hasTbody: false, hasTfoot: false,
            thInventory: { col: 0, row: 0, rowgroup: 0, colgroup: 0, unscoped: 0, total: 0 },
            issues: [{ type: "th-without-table", text: "<th> element outside any <table>" }],
            _resolveSel: uniqueSelector(th)
          });
        }
      }

      // Recurse into open shadow roots.
      var all;
      try { all = root.querySelectorAll("*"); } catch (e) { return; }
      for (var s = 0; s < all.length; s++) {
        if (all[s].shadowRoot) {
          shadowRoots++;
          walk(all[s].shadowRoot);
        }
      }
    }

    walk(document);

    return {
      url: url,
      isTop: isTop,
      results: results,
      shadowRoots: shadowRoots
    };
  } catch (e) {
    return {
      url: location.href,
      isTop: true,
      results: [],
      error: (e && e.message ? e.message : String(e))
    };
  }
}

function displayTables(framesData, checkId) {
  "use strict";
  try {
    var P = "__a11yn_ext_";
    if (window[P + "cleanup"]) {
      try { window[P + "cleanup"](); } catch (e) {}
    }

    var allResults = [];
    var totalShadow = 0;
    var anyError = null;

    for (var fi = 0; fi < framesData.length; fi++) {
      var fd = framesData[fi];
      if (!fd) continue;
      if (fd.error) { anyError = fd.error; continue; }
      if (!fd.results) continue;
      totalShadow += (fd.shadowRoots || 0);
      for (var ri = 0; ri < fd.results.length; ri++) {
        var r = fd.results[ri];
        r._frameId = fd.frameId;
        r._frameUrl = fd.url;
        r._frameIsTop = !!fd.isTop;
        allResults.push(r);
      }
    }

    // Resolve elements (only top frame is reachable from this script).
    for (var ai = 0; ai < allResults.length; ai++) {
      var rr = allResults[ai];
      if (rr._frameIsTop && rr._resolveSel) {
        try { rr._resolveEl = document.querySelector(rr._resolveSel); } catch (e) {}
      }
    }

    var data = 0, layout = 0, ambiguous = 0, orphan = 0, withIssues = 0;
    for (var di = 0; di < allResults.length; di++) {
      var d = allResults[di];
      if (d.status === "data") data++;
      else if (d.status === "layout-declared") layout++;
      else if (d.status === "ambiguous") ambiguous++;
      else if (d.status === "orphan") orphan++;
      if (d.issues && d.issues.length) withIssues++;
    }

    // ----- on-page badges -----
    var host = document.createElement("div");
    host.id = P + "host";
    host.style.setProperty("all", "initial", "important");
    document.documentElement.appendChild(host);
    var shadow = host.attachShadow({ mode: "closed" });

    var style = document.createElement("style");
    style.textContent =
      ':host { all: initial !important; }' +
      '* { box-sizing: border-box; font-family: ui-sans-serif, system-ui, sans-serif !important; }' +
      '.panel { position: fixed; top: 16px; right: 16px; width: 480px; max-height: 80vh; overflow: auto; background: #ffffff; color: #202020; border: 2px solid #003876; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,0.25); z-index: 2147483647; font-size: 16px; line-height: 1.4; }' +
      'header { background: #003876; color: #fff; padding: 10px 12px; display: flex; align-items: center; gap: 8px; }' +
      'header strong { flex: 1; font-size: 16px; }' +
      'header button { font: inherit; font-size: 14px; border: 1px solid #fff; background: transparent; color: #fff; padding: 4px 10px; border-radius: 4px; cursor: pointer; }' +
      'header button:hover { background: rgba(255,255,255,0.15); }' +
      '.summary { padding: 10px 12px; border-bottom: 1px solid #ddd; font-size: 15px; }' +
      '.filterbar { padding: 6px 12px; border-bottom: 1px solid #eee; display: flex; flex-wrap: wrap; gap: 4px; }' +
      '.filterbar button { font: inherit; font-size: 13px; border: 1px solid #aaa; background: #f4f4f4; color: #202020; padding: 3px 8px; border-radius: 4px; cursor: pointer; }' +
      '.filterbar button.active { background: #003876; color: #fff; border-color: #003876; }' +
      'ul { list-style: none; margin: 0; padding: 0; }' +
      'li.row { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; font-size: 15px; }' +
      'li.row:hover { background: #f6f9ff; }' +
      '.chip { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; margin-right: 6px; vertical-align: 1px; }' +
      '.chip.data { background: #1a7f1a; color: #fff; }' +
      '.chip.layout { background: #707070; color: #fff; }' +
      '.chip.ambig { background: #a07000; color: #fff; }' +
      '.chip.orphan { background: #b00020; color: #fff; }' +
      '.chip.idx { background: #003876; color: #fff; }' +
      '.name { color: #003876; font-weight: 600; }' +
      '.name.missing { color: #b00020; font-style: italic; }' +
      '.meta { color: #555; font-size: 13px; margin-top: 4px; }' +
      '.sel { font-family: ui-monospace, monospace !important; font-size: 12px; color: #444; word-break: break-all; }' +
      '.issues { margin-top: 6px; }' +
      '.issue { display: block; background: #fdecec; color: #7a0000; padding: 4px 8px; border-radius: 4px; font-size: 13px; margin-top: 2px; }' +
      '.panel.filter-issues li.row:not(.has-issue) { display: none; }' +
      '.panel.filter-data li.row:not(.is-data) { display: none; }' +
      '.panel.filter-layout li.row:not(.is-layout) { display: none; }' +
      '.panel.filter-ambig li.row:not(.is-ambig) { display: none; }' +
      'footer { padding: 8px 12px; font-size: 12px; color: #666; border-top: 1px solid #ddd; }';
    shadow.appendChild(style);

    var panelEl = document.createElement("div");
    panelEl.className = "panel";

    function esc(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
      });
    }

    var html = "";
    html += '<header><strong>Tables (' + allResults.length + ')</strong>' +
            '<button id="' + P + 'copy">Copy MD</button>' +
            '<button id="' + P + 'close">Close</button></header>';

    var summaryBits = [
      data + " data",
      layout + " layout (declared)",
      ambiguous + " ambiguous",
      orphan ? (orphan + " orphan <th>") : null,
      withIssues + " with issues"
    ].filter(Boolean);
    html += '<div class="summary">' + esc(summaryBits.join(" · ")) +
            (totalShadow ? ' · ' + totalShadow + ' shadow root(s)' : '') +
            (anyError ? ' · <span style="color:#b00020">error: ' + esc(anyError) + '</span>' : '') +
            '</div>';

    html += '<div class="filterbar">' +
            '<button data-filter="all" class="active">All (' + allResults.length + ')</button>' +
            '<button data-filter="issues">Issues (' + withIssues + ')</button>' +
            '<button data-filter="data">Data (' + data + ')</button>' +
            '<button data-filter="layout">Layout (' + layout + ')</button>' +
            '<button data-filter="ambig">Ambiguous (' + (ambiguous + orphan) + ')</button>' +
            '</div>';

    html += '<ul>';
    for (var ix = 0; ix < allResults.length; ix++) {
      var t = allResults[ix];
      var statusChip = "ambig";
      var statusLabel = "AMBIGUOUS";
      if (t.status === "data") { statusChip = "data"; statusLabel = "DATA"; }
      else if (t.status === "layout-declared") { statusChip = "layout"; statusLabel = "LAYOUT"; }
      else if (t.status === "orphan") { statusChip = "orphan"; statusLabel = "ORPHAN <th>"; }
      else if (t.status === "ambiguous") { statusChip = "ambig"; statusLabel = "AMBIGUOUS"; }

      var classes = ["row"];
      if (t.issues && t.issues.length) classes.push("has-issue");
      if (t.status === "data") classes.push("is-data");
      if (t.status === "layout-declared") classes.push("is-layout");
      if (t.status === "ambiguous") classes.push("is-ambig");
      if (t.status === "orphan") classes.push("is-ambig"); // orphans show under ambiguous filter

      html += '<li class="' + classes.join(" ") + '">';
      html += '<span class="chip idx">#' + t.idx + '</span>';
      html += '<span class="chip ' + statusChip + '">' + statusLabel + '</span>';
      if (t.accName) {
        html += '<span class="name">' + esc(t.accName) + '</span>';
      } else if (t.status === "data") {
        html += '<span class="name missing">(no accessible name)</span>';
      }

      var metaParts = [];
      if (t.status !== "orphan") {
        metaParts.push(t.rows + " rows × " + t.cols + " cols");
        var thBits = [];
        if (t.thInventory.col) thBits.push(t.thInventory.col + " col");
        if (t.thInventory.row) thBits.push(t.thInventory.row + " row");
        if (t.thInventory.rowgroup) thBits.push(t.thInventory.rowgroup + " rowgroup");
        if (t.thInventory.colgroup) thBits.push(t.thInventory.colgroup + " colgroup");
        if (t.thInventory.unscoped) thBits.push(t.thInventory.unscoped + " unscoped");
        if (t.thInventory.total === 0) thBits.push("no <th>");
        metaParts.push("<th>: " + thBits.join(", "));
        if (t.hasThead || t.hasTbody || t.hasTfoot) {
          var sections = [];
          if (t.hasThead) sections.push("thead");
          if (t.hasTbody) sections.push("tbody");
          if (t.hasTfoot) sections.push("tfoot");
          metaParts.push(sections.join("/"));
        }
        if (t.role) metaParts.push("role=" + t.role);
        if (t.hidden) metaParts.push("HIDDEN");
      }
      if (metaParts.length) {
        html += '<div class="meta">' + esc(metaParts.join(" · ")) + '</div>';
      }
      html += '<div class="sel">' + esc(t.sel) + '</div>';
      if (t.issues && t.issues.length) {
        html += '<div class="issues">';
        for (var ji = 0; ji < t.issues.length; ji++) {
          html += '<span class="issue">' + esc(t.issues[ji].text) + '</span>';
        }
        html += '</div>';
      }
      html += '</li>';
    }
    html += '</ul>';
    html += '<footer>WCAG 1.3.1 Info and Relationships · Tables inventory</footer>';
    panelEl.innerHTML = html;
    shadow.appendChild(panelEl);

    // Click a row to scroll the element into view and flash it.
    panelEl.querySelectorAll("li.row").forEach(function (li, i) {
      li.style.cursor = "pointer";
      li.addEventListener("click", function (e) {
        if (e.target.closest && e.target.closest("button")) return;
        var r = allResults[i];
        if (r && r._resolveEl) {
          try {
            r._resolveEl.scrollIntoView({ behavior: "smooth", block: "center" });
            r._resolveEl.style.setProperty("box-shadow", "0 0 0 4px #ffeb3b", "important");
            setTimeout(function () {
              try { r._resolveEl.style.removeProperty("box-shadow"); } catch (er) {}
            }, 1400);
          } catch (er) {}
        }
      });
    });

    // Outline top-frame tables.
    for (var oi = 0; oi < allResults.length; oi++) {
      var o = allResults[oi];
      if (o._resolveEl) {
        try {
          var color = (o.issues && o.issues.length) ? "#b00020" : (o.status === "data" ? "#1a7f1a" : "#707070");
          o._resolveEl.style.setProperty("outline", "3px solid " + color, "important");
          o._resolveEl.style.setProperty("outline-offset", "2px", "important");
        } catch (e) {}
      }
    }

    // ----- markdown -----
    var md = "# Tables\n\n";
    md += "Counts: " + data + " data, " + layout + " layout, " + ambiguous + " ambiguous";
    if (orphan) md += ", " + orphan + " orphan <th>";
    md += ", " + withIssues + " with issues.\n\n";
    md += "| # | Status | Name | Dimensions | <th> | Issues | Selector |\n";
    md += "|---|--------|------|------------|------|--------|----------|\n";
    for (var mi = 0; mi < allResults.length; mi++) {
      var mt = allResults[mi];
      var stat = mt.status;
      var dims = mt.status === "orphan" ? "—" : (mt.rows + "×" + mt.cols);
      var thBits2 = [];
      if (mt.thInventory.col) thBits2.push(mt.thInventory.col + "c");
      if (mt.thInventory.row) thBits2.push(mt.thInventory.row + "r");
      if (mt.thInventory.rowgroup) thBits2.push(mt.thInventory.rowgroup + "rg");
      if (mt.thInventory.colgroup) thBits2.push(mt.thInventory.colgroup + "cg");
      if (mt.thInventory.unscoped) thBits2.push(mt.thInventory.unscoped + "u");
      var thStr = thBits2.length ? thBits2.join("+") : (mt.thInventory.total === 0 ? "0" : "");
      var issueStr = mt.issues && mt.issues.length ? mt.issues.map(function (z) { return z.type; }).join("; ") : "";
      var name = mt.accName ? mt.accName.replace(/\|/g, "\\|") : "";
      md += "| " + mt.idx + " | " + stat + " | " + name + " | " + dims + " | " + thStr + " | " + issueStr + " | `" + mt.sel.replace(/\|/g, "\\|") + "` |\n";
    }

    // ----- filter bar -----
    panelEl.querySelectorAll(".filterbar button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var filter = btn.dataset.filter;
        panelEl.className = "panel filter-" + filter;
        panelEl.querySelectorAll(".filterbar button").forEach(function (b) {
          b.classList.toggle("active", b === btn);
        });
      });
    });

    // ----- drag -----
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
        try { header.setPointerCapture(e.pointerId); } catch (ee) {}
        e.preventDefault();
      });
      header.addEventListener("pointermove", function (e) {
        if (!dragging) return;
        var dx = e.clientX - startX, dy = e.clientY - startY;
        panelEl.style.left = (startLeft + dx) + "px";
        panelEl.style.top = (startTop + dy) + "px";
      });
      header.addEventListener("pointerup", function (e) {
        dragging = false;
        try { header.releasePointerCapture(e.pointerId); } catch (ee) {}
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
  } catch (e) {
    // Fallback error banner.
    try {
      var Pe = "__a11yn_ext_";
      var hostE = document.createElement("div");
      hostE.id = Pe + "host";
      hostE.style.cssText = "position:fixed;top:16px;right:16px;background:#b00020;color:#fff;padding:12px 16px;border-radius:6px;z-index:2147483647;font:14px ui-sans-serif,system-ui,sans-serif;max-width:480px;";
      hostE.textContent = "Tables check failed: " + (e && e.message ? e.message : String(e));
      document.documentElement.appendChild(hostE);
      setTimeout(function () { try { hostE.remove(); } catch (er) {} }, 6000);
    } catch (e2) {}
  }
}

/* ====================================================================
 * CHECK: IFRAMES — embedded-document inspector
 *
 * Covers WCAG 2.4.1 Bypass Blocks (frame name is the SR user's way of
 * skipping a frame) and 4.1.2 Name, Role, Value (every iframe must
 * expose an accessible name).
 *
 * The scanner runs in every frame via scripting.executeScript({
 * allFrames: true }) — each frame inventories its OWN iframe children,
 * and the aggregator stitches them together.
 *
 * Per-iframe flags:
 *   missing-name              no title, no aria-label, no aria-labelledby
 *   empty-name                attribute present but empty/whitespace
 *   generic-name              "iframe", "frame", "embedded content", "untitled", "frame N", ...
 *   name-matches-src          name is just the URL / hostname / filename
 *   duplicate-name            two or more iframes share the same non-empty name
 *   tabindex-negative-on-visible  visible iframe with tabindex="-1" removes the embedded doc from tab order
 *   positive-tabindex         tabindex > 0 on iframe
 *   aria-hidden-with-content  aria-hidden="true" on iframe that probably has interactive content
 *   likely-tracking-not-hidden  1x1 / 0x0 / off-screen iframe with no aria-hidden and no title
 *   empty-iframe              <iframe> with no src and no srcdoc
 *   deprecated-frame          <frame> or <frameset> elements
 *   role-presentation-on-iframe  role="presentation"/"none" on a non-trivial iframe
 * ==================================================================== */

function scanIframes() {
  "use strict";
  try {
    var results = [];
    var shadowRoots = 0;
    var url = location.href;
    var isTop = (function () { try { return window.top === window.self; } catch (e) { return false; } })();
    var frameOrigin = (function () { try { return location.origin; } catch (e) { return ""; } })();
    var idCounter = 0;

    function txt(el) {
      if (!el) return "";
      return (el.textContent || "").replace(/\s+/g, " ").trim();
    }

    function isHidden(el) {
      if (!el || el.nodeType !== 1) return false;
      for (var n = el; n && n.nodeType === 1; n = n.parentNode || (n.getRootNode && n.getRootNode().host)) {
        var cs;
        try { cs = getComputedStyle(n); } catch (e) { return false; }
        if (!cs) return false;
        if (cs.display === "none" || cs.visibility === "hidden") return true;
      }
      return false;
    }

    function ariaHiddenChain(el) {
      for (var n = el; n && n.nodeType === 1; n = n.parentNode || (n.getRootNode && n.getRootNode().host)) {
        if (n.getAttribute && n.getAttribute("aria-hidden") === "true") return true;
      }
      return false;
    }

    function uniqueSelector(el) {
      if (!el || el.nodeType !== 1) return "";
      var path = [];
      var node = el;
      while (node && node.nodeType === 1) {
        if (node.id) { path.unshift("#" + CSS.escape(node.id)); break; }
        var name = node.tagName.toLowerCase();
        var parent = node.parentNode;
        if (parent && parent.nodeType === 1) {
          var i = 1, sib = node.previousElementSibling;
          while (sib) {
            if (sib.tagName === node.tagName) i++;
            sib = sib.previousElementSibling;
          }
          name += ":nth-of-type(" + i + ")";
        }
        path.unshift(name);
        node = parent;
        if (!node || (node && node.nodeType === 11)) break;
      }
      return path.join(" > ");
    }

    function computeAccName(el) {
      // aria-labelledby
      var alb = el.getAttribute && el.getAttribute("aria-labelledby");
      if (alb) {
        var ids = alb.split(/\s+/).filter(Boolean);
        var pieces = [];
        for (var i = 0; i < ids.length; i++) {
          var ref = document.getElementById(ids[i]);
          if (ref) pieces.push(txt(ref));
        }
        var joined = pieces.join(" ").trim();
        if (joined) return { value: joined, source: "aria-labelledby" };
        // aria-labelledby present but produces empty/missing
        return { value: "", source: "aria-labelledby", broken: true, ids: ids };
      }
      var al = el.getAttribute && el.getAttribute("aria-label");
      if (al != null) {
        var t = al.trim();
        if (t) return { value: t, source: "aria-label" };
        return { value: "", source: "aria-label", broken: true };
      }
      var ti = el.getAttribute && el.getAttribute("title");
      if (ti != null) {
        var tt = ti.trim();
        if (tt) return { value: tt, source: "title" };
        return { value: "", source: "title", broken: true };
      }
      return { value: "", source: "" };
    }

    var GENERIC = {
      "iframe": 1, "frame": 1, "iframes": 1, "frames": 1,
      "embedded content": 1, "embed": 1,
      "untitled": 1, "untitled frame": 1, "untitled iframe": 1,
      "content": 1, "widget": 1, "ad": 1, "advert": 1, "advertisement": 1
    };
    var GENERIC_PATTERN = /^(?:i?frame)\s*[-_:#]?\s*\d+$/i;

    function isGenericName(name) {
      if (!name) return false;
      var n = name.toLowerCase().trim();
      if (GENERIC[n]) return true;
      if (GENERIC_PATTERN.test(name.trim())) return true;
      return false;
    }

    function matchesSrc(name, src) {
      if (!name || !src) return false;
      var n = name.trim();
      var s = src.trim();
      if (n === s) return true;
      // hostname?
      try {
        var u = new URL(src, location.href);
        if (n === u.hostname) return true;
        if (n === u.origin) return true;
        // last path segment / filename
        var parts = u.pathname.split("/").filter(Boolean);
        if (parts.length) {
          var last = parts[parts.length - 1];
          if (n === last) return true;
          // without query
          var dot = last.lastIndexOf(".");
          if (dot > 0 && n === last.slice(0, dot)) return true;
        }
      } catch (e) {}
      return false;
    }

    function probeOrigin(iframe) {
      // Returns "same", "cross", or "unknown"
      try {
        var w = iframe.contentWindow;
        if (!w) return "unknown";
        // Reading location.href throws for cross-origin
        var href = w.location.href;
        if (href != null) return "same";
        return "unknown";
      } catch (e) {
        return "cross";
      }
    }

    function getSrc(iframe) {
      var s = iframe.getAttribute("src");
      if (s) return s;
      var sd = iframe.getAttribute("srcdoc");
      if (sd) return "srcdoc:" + (sd.length > 40 ? sd.slice(0, 40) + "…" : sd);
      return "";
    }

    function isLikelyTracking(iframe, rect) {
      if (!rect) return false;
      // 0x0 or 1x1 or off-screen-positioned (negative coords with small size)
      if (rect.width <= 1 && rect.height <= 1) return true;
      if (rect.width === 0 && rect.height === 0) return true;
      // positioned far off-screen with non-display:none style
      try {
        var cs = getComputedStyle(iframe);
        if (!cs) return false;
        if (cs.display === "none" || cs.visibility === "hidden") return false;
      } catch (e) {}
      // Far left or top
      if (rect.left <= -1000 || rect.top <= -1000) return true;
      return false;
    }

    function analyseIframe(iframe) {
      var entry = {
        idx: ++idCounter,
        sel: uniqueSelector(iframe),
        tag: iframe.tagName.toLowerCase(),
        titleAttr: iframe.getAttribute("title") || "",
        ariaLabel: iframe.getAttribute("aria-label") || "",
        ariaLabelledby: iframe.getAttribute("aria-labelledby") || "",
        accName: "",
        accSource: "",
        accNameBroken: false,
        src: getSrc(iframe),
        srcRaw: iframe.getAttribute("src") || "",
        hasSrcdoc: !!iframe.getAttribute("srcdoc"),
        role: iframe.getAttribute("role") || "",
        tabindexRaw: iframe.getAttribute("tabindex"),
        tabindex: null,
        sandbox: iframe.getAttribute("sandbox"),
        allow: iframe.getAttribute("allow") || "",
        width: 0,
        height: 0,
        hidden: false,
        ariaHidden: false,
        origin: "unknown",
        crossOrigin: false,
        sameOrigin: false,
        issues: [],
        _resolveSel: uniqueSelector(iframe)
      };

      if (entry.tabindexRaw != null) {
        var n = parseInt(entry.tabindexRaw, 10);
        if (isFinite(n) && String(n) === entry.tabindexRaw.trim()) entry.tabindex = n;
      }

      var nameInfo = computeAccName(iframe);
      entry.accName = nameInfo.value;
      entry.accSource = nameInfo.source;
      entry.accNameBroken = !!nameInfo.broken;

      entry.hidden = isHidden(iframe);
      entry.ariaHidden = ariaHiddenChain(iframe);

      var rect;
      try { rect = iframe.getBoundingClientRect(); } catch (e) { rect = null; }
      if (rect) {
        entry.width = Math.round(rect.width);
        entry.height = Math.round(rect.height);
      }

      // Frame elements (HTML4) are deprecated.
      if (entry.tag === "frame" || entry.tag === "frameset") {
        entry.issues.push({
          type: "deprecated-frame",
          text: "<" + entry.tag + "> is obsolete in HTML5; use <iframe> instead."
        });
      }

      // For <iframe> elements only, probe origin.
      if (entry.tag === "iframe") {
        entry.origin = probeOrigin(iframe);
        entry.sameOrigin = entry.origin === "same";
        entry.crossOrigin = entry.origin === "cross";
      }

      // Empty iframe (no src, no srcdoc).
      if (entry.tag === "iframe" && !iframe.getAttribute("src") && !iframe.getAttribute("srcdoc")) {
        entry.issues.push({
          type: "empty-iframe",
          text: "<iframe> has no src and no srcdoc — empty embed."
        });
      }

      // Naming issues.
      var hasAnyNameAttr = !!iframe.getAttribute("title") || iframe.getAttribute("aria-label") != null || !!iframe.getAttribute("aria-labelledby");
      if (!hasAnyNameAttr && !entry.ariaHidden && !entry.hidden && entry.tag === "iframe") {
        entry.issues.push({
          type: "missing-name",
          text: "<iframe> has no title, no aria-label, and no aria-labelledby. Screen-reader users have nothing to announce when entering the frame."
        });
      } else if (hasAnyNameAttr && !entry.accName) {
        // attribute present but produces empty name
        var details = [];
        if (iframe.getAttribute("title") != null && !iframe.getAttribute("title").trim()) details.push('title=""');
        if (iframe.getAttribute("aria-label") != null && !iframe.getAttribute("aria-label").trim()) details.push('aria-label=""');
        if (iframe.getAttribute("aria-labelledby") && nameInfo.broken && nameInfo.source === "aria-labelledby") {
          details.push("aria-labelledby=\"" + iframe.getAttribute("aria-labelledby") + "\" (IDs missing or empty)");
        }
        entry.issues.push({
          type: "empty-name",
          text: "<iframe> has a name attribute but the result is empty: " + (details.join(", ") || "no usable text")
        });
      }

      if (entry.accName && isGenericName(entry.accName)) {
        entry.issues.push({
          type: "generic-name",
          text: 'Accessible name is generic ("' + entry.accName + '") — give the frame a descriptive name explaining its purpose.'
        });
      }
      if (entry.accName && entry.srcRaw && matchesSrc(entry.accName, entry.srcRaw)) {
        entry.issues.push({
          type: "name-matches-src",
          text: 'Accessible name ("' + entry.accName + '") matches the src URL/hostname/filename — not a descriptive label.'
        });
      }

      // Tabindex issues.
      if (entry.tabindex != null) {
        if (entry.tabindex > 0) {
          entry.issues.push({
            type: "positive-tabindex",
            text: 'tabindex="' + entry.tabindex + '" on <iframe> breaks natural DOM order.'
          });
        } else if (entry.tabindex < 0 && !entry.hidden && !entry.ariaHidden) {
          entry.issues.push({
            type: "tabindex-negative-on-visible",
            text: 'tabindex="-1" on a visible <iframe> removes the embedded document from sequential focus order — sub-page becomes keyboard-unreachable from outside.'
          });
        }
      }

      // aria-hidden with content (heuristic).
      if (entry.tag === "iframe" && iframe.getAttribute("aria-hidden") === "true") {
        // Heuristic: non-trivial size and has src.
        var hasSubstantialSize = entry.width >= 50 && entry.height >= 50;
        if (hasSubstantialSize && (iframe.getAttribute("src") || iframe.getAttribute("srcdoc"))) {
          entry.issues.push({
            type: "aria-hidden-with-content",
            text: 'aria-hidden="true" on a substantial iframe (' + entry.width + '×' + entry.height + ') hides its content from AT. If the embedded document has interactive elements, this creates a focusable-but-hidden trap.'
          });
        }
      }

      // Likely tracking iframe (very small, visible, no name, not hidden from AT).
      if (entry.tag === "iframe" && !entry.hidden && !entry.ariaHidden && rect) {
        if (isLikelyTracking(iframe, rect) && !entry.accName) {
          entry.issues.push({
            type: "likely-tracking-not-hidden",
            text: 'Tiny / off-screen iframe (' + entry.width + '×' + entry.height + ') with no name and no aria-hidden — analytics/pixel iframes should be aria-hidden="true" so SR doesn\'t announce them.'
          });
        }
      }

      // role="presentation"/"none" on iframe.
      var role = (entry.role || "").toLowerCase();
      if (entry.tag === "iframe" && (role === "presentation" || role === "none") &&
          (iframe.getAttribute("src") || iframe.getAttribute("srcdoc"))) {
        entry.issues.push({
          type: "role-presentation-on-iframe",
          text: 'role="' + role + '" on an iframe with content strips its frame role. SR users lose the frame boundary announcement.'
        });
      }

      return entry;
    }

    function walk(root) {
      if (!root) return;
      var iframes;
      try {
        iframes = root.querySelectorAll("iframe, frame, frameset");
      } catch (e) {
        iframes = [];
      }
      for (var i = 0; i < iframes.length; i++) {
        results.push(analyseIframe(iframes[i]));
      }
      var all;
      try { all = root.querySelectorAll("*"); } catch (e) { return; }
      for (var s = 0; s < all.length; s++) {
        if (all[s].shadowRoot) {
          shadowRoots++;
          walk(all[s].shadowRoot);
        }
      }
    }

    walk(document);

    return {
      url: url,
      isTop: isTop,
      frameOrigin: frameOrigin,
      results: results,
      shadowRoots: shadowRoots
    };
  } catch (e) {
    return {
      url: location.href,
      isTop: true,
      results: [],
      error: (e && e.message ? e.message : String(e))
    };
  }
}

function displayIframes(framesData, checkId) {
  "use strict";
  try {
    var P = "__a11yn_ext_";
    if (window[P + "cleanup"]) {
      try { window[P + "cleanup"](); } catch (e) {}
    }

    var allResults = [];
    var totalShadow = 0;
    var anyError = null;
    var totalFrames = 0;

    for (var fi = 0; fi < framesData.length; fi++) {
      var fd = framesData[fi];
      if (!fd) continue;
      totalFrames++;
      if (fd.error) { anyError = fd.error; continue; }
      if (!fd.results) continue;
      totalShadow += (fd.shadowRoots || 0);
      for (var ri = 0; ri < fd.results.length; ri++) {
        var r = fd.results[ri];
        r._frameId = fd.frameId;
        r._frameUrl = fd.url;
        r._frameIsTop = !!fd.isTop;
        allResults.push(r);
      }
    }

    // Cross-iframe duplicate-name detection.
    var byName = {};
    for (var di = 0; di < allResults.length; di++) {
      var rr = allResults[di];
      if (!rr.accName) continue;
      var key = rr.accName.toLowerCase();
      if (!byName[key]) byName[key] = [];
      byName[key].push(rr);
    }
    Object.keys(byName).forEach(function (k) {
      var arr = byName[k];
      if (arr.length < 2) return;
      arr.forEach(function (entry) {
        var others = arr.filter(function (x) { return x !== entry; });
        entry.issues.push({
          type: "duplicate-name",
          text: 'Multiple iframes share the name "' + entry.accName + '" (' + arr.length + ' total). SR users can\'t distinguish them.',
          related: others.map(function (o) { return { idx: o.idx, sel: o.sel }; })
        });
      });
    });

    // Resolve elements (only top frame is reachable).
    for (var ai = 0; ai < allResults.length; ai++) {
      var d = allResults[ai];
      if (d._frameIsTop && d._resolveSel) {
        try { d._resolveEl = document.querySelector(d._resolveSel); } catch (e) {}
      }
    }

    var sameO = 0, crossO = 0, unknownO = 0, hiddenCount = 0, withIssues = 0, deprecated = 0;
    for (var ci = 0; ci < allResults.length; ci++) {
      var c = allResults[ci];
      if (c.tag !== "iframe") deprecated++;
      else if (c.origin === "same") sameO++;
      else if (c.origin === "cross") crossO++;
      else unknownO++;
      if (c.hidden || c.ariaHidden) hiddenCount++;
      if (c.issues && c.issues.length) withIssues++;
    }

    // ---- on-page panel ----
    var host = document.createElement("div");
    host.id = P + "host";
    host.style.setProperty("all", "initial", "important");
    document.documentElement.appendChild(host);
    var shadow = host.attachShadow({ mode: "closed" });

    var style = document.createElement("style");
    style.textContent =
      ':host { all: initial !important; }' +
      '* { box-sizing: border-box; font-family: ui-sans-serif, system-ui, sans-serif !important; }' +
      '.panel { position: fixed; top: 16px; right: 16px; width: 480px; max-height: 80vh; overflow: auto; background: #ffffff; color: #202020; border: 2px solid #003876; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,0.25); z-index: 2147483647; font-size: 16px; line-height: 1.4; }' +
      'header { background: #003876; color: #fff; padding: 10px 12px; display: flex; align-items: center; gap: 8px; }' +
      'header strong { flex: 1; font-size: 16px; }' +
      'header button { font: inherit; font-size: 14px; border: 1px solid #fff; background: transparent; color: #fff; padding: 4px 10px; border-radius: 4px; cursor: pointer; }' +
      'header button:hover { background: rgba(255,255,255,0.15); }' +
      '.summary { padding: 10px 12px; border-bottom: 1px solid #ddd; font-size: 15px; }' +
      '.filterbar { padding: 6px 12px; border-bottom: 1px solid #eee; display: flex; flex-wrap: wrap; gap: 4px; }' +
      '.filterbar button { font: inherit; font-size: 13px; border: 1px solid #aaa; background: #f4f4f4; color: #202020; padding: 3px 8px; border-radius: 4px; cursor: pointer; }' +
      '.filterbar button.active { background: #003876; color: #fff; border-color: #003876; }' +
      'ul { list-style: none; margin: 0; padding: 0; }' +
      'li.row { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; font-size: 15px; }' +
      'li.row:hover { background: #f6f9ff; }' +
      '.chip { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; margin-right: 6px; vertical-align: 1px; }' +
      '.chip.idx { background: #003876; color: #fff; }' +
      '.chip.same { background: #1a7f1a; color: #fff; }' +
      '.chip.cross { background: #6f42c1; color: #fff; }' +
      '.chip.unknown { background: #707070; color: #fff; }' +
      '.chip.hidden { background: #707070; color: #fff; }' +
      '.chip.tag { background: #003876; color: #fff; }' +
      '.chip.deprecated { background: #b00020; color: #fff; }' +
      '.chip.sandbox { background: #555; color: #fff; font-weight: 500; }' +
      '.name { color: #003876; font-weight: 600; }' +
      '.name.missing { color: #b00020; font-style: italic; }' +
      '.meta { color: #555; font-size: 13px; margin-top: 4px; }' +
      '.sel { font-family: ui-monospace, monospace !important; font-size: 12px; color: #444; word-break: break-all; }' +
      '.src { font-family: ui-monospace, monospace !important; font-size: 12px; color: #555; word-break: break-all; margin-top: 4px; }' +
      '.issues { margin-top: 6px; }' +
      '.issue { display: block; background: #fdecec; color: #7a0000; padding: 4px 8px; border-radius: 4px; font-size: 13px; margin-top: 2px; }' +
      '.panel.filter-issues li.row:not(.has-issue) { display: none; }' +
      '.panel.filter-same li.row:not(.is-same) { display: none; }' +
      '.panel.filter-cross li.row:not(.is-cross) { display: none; }' +
      '.panel.filter-hidden li.row:not(.is-hidden) { display: none; }' +
      '.panel.filter-deprecated li.row:not(.is-deprecated) { display: none; }' +
      'footer { padding: 8px 12px; font-size: 12px; color: #666; border-top: 1px solid #ddd; }';
    shadow.appendChild(style);

    function esc(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
      });
    }

    var panelEl = document.createElement("div");
    panelEl.className = "panel";

    var html = "";
    html += '<header><strong>Iframes (' + allResults.length + ')</strong>' +
            '<button id="' + P + 'copy">Copy MD</button>' +
            '<button id="' + P + 'close">Close</button></header>';

    var summaryBits = [];
    summaryBits.push(sameO + " same-origin");
    summaryBits.push(crossO + " cross-origin");
    if (unknownO) summaryBits.push(unknownO + " unknown-origin");
    if (deprecated) summaryBits.push(deprecated + " deprecated <frame>/<frameset>");
    if (hiddenCount) summaryBits.push(hiddenCount + " hidden");
    summaryBits.push(withIssues + " with issues");
    summaryBits.push(totalFrames + " frame(s) scanned");

    html += '<div class="summary">' + esc(summaryBits.join(" · ")) +
            (totalShadow ? ' · ' + totalShadow + ' shadow root(s)' : '') +
            (anyError ? ' · <span style="color:#b00020">error: ' + esc(anyError) + '</span>' : '') +
            '</div>';

    html += '<div class="filterbar">' +
            '<button data-filter="all" class="active">All (' + allResults.length + ')</button>' +
            '<button data-filter="issues">Issues (' + withIssues + ')</button>' +
            '<button data-filter="same">Same-origin (' + sameO + ')</button>' +
            '<button data-filter="cross">Cross-origin (' + crossO + ')</button>' +
            '<button data-filter="hidden">Hidden (' + hiddenCount + ')</button>' +
            (deprecated ? '<button data-filter="deprecated">Deprecated (' + deprecated + ')</button>' : '') +
            '</div>';

    html += '<ul>';
    for (var ix = 0; ix < allResults.length; ix++) {
      var t = allResults[ix];
      var classes = ["row"];
      if (t.issues && t.issues.length) classes.push("has-issue");
      if (t.origin === "same") classes.push("is-same");
      if (t.origin === "cross") classes.push("is-cross");
      if (t.hidden || t.ariaHidden) classes.push("is-hidden");
      if (t.tag !== "iframe") classes.push("is-deprecated");

      html += '<li class="' + classes.join(" ") + '">';
      html += '<span class="chip idx">#' + t.idx + '</span>';

      // origin / tag chip
      if (t.tag !== "iframe") {
        html += '<span class="chip deprecated">&lt;' + t.tag + '&gt;</span>';
      } else if (t.origin === "same") {
        html += '<span class="chip same">SAME-ORIGIN</span>';
      } else if (t.origin === "cross") {
        html += '<span class="chip cross">CROSS-ORIGIN</span>';
      } else {
        html += '<span class="chip unknown">UNKNOWN</span>';
      }

      if (t.hidden) html += '<span class="chip hidden">DISPLAY-HIDDEN</span>';
      else if (t.ariaHidden) html += '<span class="chip hidden">ARIA-HIDDEN</span>';

      if (t.accName) {
        html += '<span class="name">' + esc(t.accName) + '</span>';
        if (t.accSource) html += ' <span style="color:#666; font-size:12px;">(' + esc(t.accSource) + ')</span>';
      } else {
        html += '<span class="name missing">(no accessible name)</span>';
      }

      // meta
      var metaParts = [];
      metaParts.push(t.width + "×" + t.height + " px");
      if (t.tabindexRaw != null) metaParts.push("tabindex=" + t.tabindexRaw);
      if (t.role) metaParts.push("role=" + t.role);
      if (t._frameUrl && !t._frameIsTop) metaParts.push("in frame: " + t._frameUrl);
      html += '<div class="meta">' + esc(metaParts.join(" · ")) + '</div>';

      if (t.sandbox != null) {
        var tokens = t.sandbox.split(/\s+/).filter(Boolean);
        if (tokens.length === 0) {
          html += '<div class="meta"><span class="chip sandbox">sandbox (empty — max restrictions)</span></div>';
        } else {
          var chips = tokens.map(function (tk) { return '<span class="chip sandbox">' + esc(tk) + '</span>'; }).join("");
          html += '<div class="meta">' + chips + '</div>';
        }
      }

      if (t.src) {
        html += '<div class="src" title="' + esc(t.src) + '">src: ' + esc(t.src.length > 120 ? t.src.slice(0, 120) + "…" : t.src) + '</div>';
      }
      html += '<div class="sel">' + esc(t.sel) + '</div>';

      if (t.issues && t.issues.length) {
        html += '<div class="issues">';
        for (var ji = 0; ji < t.issues.length; ji++) {
          var issue = t.issues[ji];
          var text = issue.text;
          if (issue.related && issue.related.length) {
            text += " (also: " + issue.related.map(function (rl) { return "#" + rl.idx; }).join(", ") + ")";
          }
          html += '<span class="issue">' + esc(text) + '</span>';
        }
        html += '</div>';
      }
      html += '</li>';
    }
    html += '</ul>';
    if (crossO) {
      html += '<footer>Cross-origin iframes can\'t be introspected from this script — only their outer attributes (title, aria-label, etc.) are checked. The scanner runs inside each accessible frame and finds its own nested iframes; cross-origin frames inventory themselves and join the aggregated list.</footer>';
    } else {
      html += '<footer>WCAG 2.4.1 Bypass Blocks · 4.1.2 Name, Role, Value</footer>';
    }
    panelEl.innerHTML = html;
    shadow.appendChild(panelEl);

    // Click a row to scroll the element into view and flash it.
    panelEl.querySelectorAll("li.row").forEach(function (li, i) {
      li.style.cursor = "pointer";
      li.addEventListener("click", function (e) {
        if (e.target.closest && e.target.closest("button")) return;
        var r = allResults[i];
        if (r && r._resolveEl) {
          try {
            r._resolveEl.scrollIntoView({ behavior: "smooth", block: "center" });
            r._resolveEl.style.setProperty("box-shadow", "0 0 0 4px #ffeb3b", "important");
            setTimeout(function () {
              try { r._resolveEl.style.removeProperty("box-shadow"); } catch (er) {}
            }, 1400);
          } catch (er) {}
        }
      });
    });

    // Outline top-frame iframes.
    for (var oi = 0; oi < allResults.length; oi++) {
      var o = allResults[oi];
      if (o._resolveEl) {
        try {
          var color = (o.issues && o.issues.length) ? "#b00020" : "#003876";
          o._resolveEl.style.setProperty("outline", "3px solid " + color, "important");
          o._resolveEl.style.setProperty("outline-offset", "2px", "important");
        } catch (e) {}
      }
    }

    // ---- markdown ----
    var md = "# Iframes\n\n";
    md += "Counts: " + sameO + " same-origin, " + crossO + " cross-origin";
    if (unknownO) md += ", " + unknownO + " unknown-origin";
    if (deprecated) md += ", " + deprecated + " <frame>/<frameset>";
    md += ", " + withIssues + " with issues across " + totalFrames + " frame(s).\n\n";
    md += "| # | Tag | Origin | Name | Source | Size | tabindex | Issues | Selector | Src |\n";
    md += "|---|-----|--------|------|--------|------|----------|--------|----------|-----|\n";
    for (var mi = 0; mi < allResults.length; mi++) {
      var mt = allResults[mi];
      var name = mt.accName ? mt.accName.replace(/\|/g, "\\|") : "";
      var src = (mt.src || "").replace(/\|/g, "\\|");
      var issueStr = mt.issues && mt.issues.length ? mt.issues.map(function (z) {
        var s = z.type;
        if (z.related && z.related.length) s += "(also " + z.related.map(function (rr) { return "#" + rr.idx; }).join(",") + ")";
        return s;
      }).join("; ") : "";
      md += "| " + mt.idx +
            " | " + mt.tag +
            " | " + mt.origin +
            " | " + name +
            " | " + (mt.accSource || "") +
            " | " + mt.width + "×" + mt.height +
            " | " + (mt.tabindexRaw == null ? "" : mt.tabindexRaw) +
            " | " + issueStr +
            " | `" + mt.sel.replace(/\|/g, "\\|") + "`" +
            " | " + (src.length > 100 ? src.slice(0, 100) + "…" : src) +
            " |\n";
    }

    // ---- filter bar ----
    panelEl.querySelectorAll(".filterbar button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var filter = btn.dataset.filter;
        panelEl.className = "panel filter-" + filter;
        panelEl.querySelectorAll(".filterbar button").forEach(function (b) {
          b.classList.toggle("active", b === btn);
        });
      });
    });

    // ---- drag ----
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
        try { header.setPointerCapture(e.pointerId); } catch (ee) {}
        e.preventDefault();
      });
      header.addEventListener("pointermove", function (e) {
        if (!dragging) return;
        var dx = e.clientX - startX, dy = e.clientY - startY;
        panelEl.style.left = (startLeft + dx) + "px";
        panelEl.style.top = (startTop + dy) + "px";
      });
      header.addEventListener("pointerup", function (e) {
        dragging = false;
        try { header.releasePointerCapture(e.pointerId); } catch (ee) {}
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
  } catch (e) {
    try {
      var Pe = "__a11yn_ext_";
      var hostE = document.createElement("div");
      hostE.id = Pe + "host";
      hostE.style.cssText = "position:fixed;top:16px;right:16px;background:#b00020;color:#fff;padding:12px 16px;border-radius:6px;z-index:2147483647;font:14px ui-sans-serif,system-ui,sans-serif;max-width:480px;";
      hostE.textContent = "Iframes check failed: " + (e && e.message ? e.message : String(e));
      document.documentElement.appendChild(hostE);
      setTimeout(function () { try { hostE.remove(); } catch (er) {} }, 6000);
    } catch (e2) {}
  }
}

/* ====================================================================
 * CHECK: BUTTONS — interactive-semantics inspector
 *
 * WCAG 2.1.1 Keyboard, 4.1.2 Name/Role/Value, 1.3.1 Info/Relationships,
 * 3.3.1/3.3.2 (button type defaults inside forms).
 *
 * Every native <button>, every <a>, every interactive-role element, and
 * every non-interactive element carrying an inline interaction handler
 * (onclick/onmousedown/onkeydown/onkeypress) is inventoried. The check
 * focuses on the *interaction semantics* angle: is the right element
 * used, is the right keyboard story in place, is the right state
 * exposed.
 *
 * Per-element flags:
 *   button-no-type-in-form       <button> in <form> without type=; defaults to submit
 *   button-type-reset            <button type="reset">
 *   link-as-button               <a href="#"> or href="javascript:..."
 *   link-no-href                 <a> without href (not focusable, not a link)
 *   link-disabled-attr           <a disabled> (disabled has no effect on <a>)
 *   inline-handler-on-link       <a href> with onclick containing preventDefault/return false
 *   div-onclick-no-role          non-interactive element with onclick and no role / tabindex
 *   role-without-tabindex        interactive ARIA role on non-focusable host, no tabindex
 *   role-without-key-handler     interactive role + onclick but no onkey*= attribute (heuristic)
 *   aria-pressed-without-button-role   aria-pressed on element that isn't a button
 *   aria-expanded-bad-role       aria-expanded on element whose role doesn't support it
 *   haspopup-without-expanded    aria-haspopup without aria-expanded
 * ==================================================================== */

function scanButtons() {
  "use strict";
  try {
    var results = [];
    var shadowRoots = 0;
    var url = location.href;
    var isTop = (function () { try { return window.top === window.self; } catch (e) { return false; } })();
    var idCounter = 0;

    var INTERACTIVE_ARIA_ROLES = {
      button: 1, link: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1,
      tab: 1, option: 1, checkbox: 1, radio: 1, switch: 1, treeitem: 1,
      gridcell: 1, slider: 1, spinbutton: 1, combobox: 1, listbox: 1
    };
    // Roles for which aria-expanded is in the supported-states list.
    var ROLES_SUPPORTING_EXPANDED = {
      button: 1, link: 1, combobox: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1,
      menuitemradio: 1, treeitem: 1, gridcell: 1, rowheader: 1, columnheader: 1,
      listbox: 1, application: 1, "switch": 1, row: 1
    };
    // Natively focusable + interactive HTML elements (subset relevant here).
    var NATIVE_INTERACTIVE_TAGS = {
      BUTTON: 1, A: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, SUMMARY: 1, DETAILS: 1,
      AUDIO: 1, VIDEO: 1, IFRAME: 1, OBJECT: 1, EMBED: 1
    };
    // Handler attribute names to look at.
    var CLICK_ATTRS = ["onclick", "onmousedown", "onmouseup", "onpointerdown", "onpointerup"];
    var KEY_ATTRS = ["onkeydown", "onkeyup", "onkeypress"];

    function txt(el) {
      if (!el) return "";
      return (el.textContent || "").replace(/\s+/g, " ").trim();
    }

    function isHidden(el) {
      if (!el || el.nodeType !== 1) return false;
      for (var n = el; n && n.nodeType === 1; n = n.parentNode || (n.getRootNode && n.getRootNode().host)) {
        var cs;
        try { cs = getComputedStyle(n); } catch (e) { return false; }
        if (!cs) return false;
        if (cs.display === "none" || cs.visibility === "hidden") return true;
      }
      return false;
    }

    function uniqueSelector(el) {
      if (!el || el.nodeType !== 1) return "";
      var path = [];
      var node = el;
      while (node && node.nodeType === 1) {
        if (node.id) { path.unshift("#" + CSS.escape(node.id)); break; }
        var name = node.tagName.toLowerCase();
        var parent = node.parentNode;
        if (parent && parent.nodeType === 1) {
          var i = 1, sib = node.previousElementSibling;
          while (sib) {
            if (sib.tagName === node.tagName) i++;
            sib = sib.previousElementSibling;
          }
          name += ":nth-of-type(" + i + ")";
        }
        path.unshift(name);
        node = parent;
        if (!node || (node && node.nodeType === 11)) break;
      }
      return path.join(" > ");
    }

    function computeAccName(el) {
      // Tiny accessible-name resolver — full computation is in the Names check.
      var alb = el.getAttribute && el.getAttribute("aria-labelledby");
      if (alb) {
        var ids = alb.split(/\s+/).filter(Boolean);
        var pieces = [];
        for (var i = 0; i < ids.length; i++) {
          var ref = document.getElementById(ids[i]);
          if (ref) pieces.push(txt(ref));
        }
        var joined = pieces.join(" ").trim();
        if (joined) return joined;
      }
      var al = el.getAttribute && el.getAttribute("aria-label");
      if (al && al.trim()) return al.trim();
      var t = txt(el);
      if (t) return t;
      // <input type=submit/reset/button>: value attr
      if (el.tagName === "INPUT") {
        var v = el.getAttribute("value");
        if (v && v.trim()) return v.trim();
        // type=image: alt
        var alt = el.getAttribute("alt");
        if (alt && alt.trim()) return alt.trim();
      }
      var ti = el.getAttribute && el.getAttribute("title");
      if (ti && ti.trim()) return ti.trim();
      return "";
    }

    function isFormAncestor(el) {
      for (var n = el.parentNode; n && n.nodeType === 1; n = n.parentNode) {
        if (n.tagName === "FORM") return n;
      }
      return null;
    }

    function inlineHandlersOn(el) {
      var out = [];
      for (var i = 0; i < CLICK_ATTRS.length; i++) {
        if (el.hasAttribute && el.hasAttribute(CLICK_ATTRS[i])) out.push(CLICK_ATTRS[i]);
      }
      return out;
    }

    function hasKeyHandlerAttr(el) {
      for (var i = 0; i < KEY_ATTRS.length; i++) {
        if (el.hasAttribute && el.hasAttribute(KEY_ATTRS[i])) return KEY_ATTRS[i];
      }
      return "";
    }

    function isNativelyInteractive(el) {
      if (!el || !el.tagName) return false;
      if (!NATIVE_INTERACTIVE_TAGS[el.tagName]) return false;
      if (el.tagName === "A") return el.hasAttribute("href");
      if (el.tagName === "INPUT") {
        var type = (el.getAttribute("type") || "text").toLowerCase();
        return type !== "hidden";
      }
      if (el.tagName === "AUDIO" || el.tagName === "VIDEO") return el.hasAttribute("controls");
      return true;
    }

    function classify(el, role) {
      var tag = el.tagName;
      if (tag === "BUTTON") return "button";
      if (tag === "INPUT") {
        var type = (el.getAttribute("type") || "text").toLowerCase();
        if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
      }
      if (tag === "A") return "link";
      if (role === "button") return "aria-button";
      if (role === "link") return "aria-link";
      if (role) return "role-" + role;
      // Has handler but no role -> clickable-div
      return "clickable";
    }

    function analyse(el) {
      var roleAttr = (el.getAttribute && el.getAttribute("role")) || "";
      var role = roleAttr.trim().toLowerCase();
      // Pick first valid role token only.
      if (role.indexOf(" ") !== -1) role = role.split(/\s+/)[0];

      var entry = {
        idx: ++idCounter,
        sel: uniqueSelector(el),
        tag: el.tagName.toLowerCase(),
        roleAttr: roleAttr,
        role: role,
        type: (el.tagName === "BUTTON" || el.tagName === "INPUT") ? (el.getAttribute("type") || "").toLowerCase() : "",
        href: el.tagName === "A" ? el.getAttribute("href") : null,
        hasHrefAttr: el.tagName === "A" ? el.hasAttribute("href") : false,
        accName: computeAccName(el),
        tabindexRaw: el.getAttribute("tabindex"),
        tabindex: null,
        ariaPressed: el.getAttribute("aria-pressed"),
        ariaExpanded: el.getAttribute("aria-expanded"),
        ariaHaspopup: el.getAttribute("aria-haspopup"),
        ariaDisabled: el.getAttribute("aria-disabled") === "true",
        disabledAttr: el.hasAttribute("disabled"),
        inlineHandlers: inlineHandlersOn(el),
        keyHandlerAttr: hasKeyHandlerAttr(el),
        formAncestor: !!isFormAncestor(el),
        width: 0,
        height: 0,
        hidden: isHidden(el),
        issues: [],
        _resolveSel: ""
      };
      entry._resolveSel = entry.sel;
      if (entry.tabindexRaw != null) {
        var n = parseInt(entry.tabindexRaw, 10);
        if (isFinite(n) && String(n) === entry.tabindexRaw.trim()) entry.tabindex = n;
      }
      try {
        var rect = el.getBoundingClientRect();
        entry.width = Math.round(rect.width);
        entry.height = Math.round(rect.height);
      } catch (e) {}

      entry.category = classify(el, role);

      // Effective role for downstream checks (used by aria-* state validation).
      var effectiveRole = role;
      if (!effectiveRole) {
        if (entry.tag === "button") effectiveRole = "button";
        else if (entry.tag === "input") {
          if (entry.type === "submit" || entry.type === "button" || entry.type === "reset" || entry.type === "image") effectiveRole = "button";
          else if (entry.type === "checkbox") effectiveRole = "checkbox";
          else if (entry.type === "radio") effectiveRole = "radio";
        }
        else if (entry.tag === "a" && entry.hasHrefAttr) effectiveRole = "link";
        else if (entry.tag === "summary") effectiveRole = "button";
      }
      entry.effectiveRole = effectiveRole;

      // ---- per-element checks ----

      // 1. <button> in <form> without explicit type=
      if (entry.tag === "button" && entry.formAncestor && !el.hasAttribute("type")) {
        entry.issues.push({
          type: "button-no-type-in-form",
          text: "<button> inside <form> with no explicit type= — defaults to submit, which can cause accidental form submission on Enter or click."
        });
      }

      // 2. type="reset"
      if (entry.tag === "button" && entry.type === "reset") {
        entry.issues.push({
          type: "button-type-reset",
          text: "<button type=\"reset\"> — reset buttons routinely surprise users by clearing form data without warning. Review whether it's actually needed."
        });
      }
      if (entry.tag === "input" && entry.type === "reset") {
        entry.issues.push({
          type: "button-type-reset",
          text: "<input type=\"reset\"> — reset buttons routinely surprise users by clearing form data without warning. Review whether it's actually needed."
        });
      }

      // 3. <a href="#"> or javascript: pseudo-protocol
      if (entry.tag === "a" && entry.hasHrefAttr) {
        var h = (entry.href || "").trim();
        if (h === "#" || h === "" || /^javascript:/i.test(h)) {
          entry.issues.push({
            type: "link-as-button",
            text: "<a href=\"" + (h || "") + "\"> — link points nowhere; this is acting as a button. Use <button type=\"button\"> with appropriate styling."
          });
        }
      }

      // 4. <a> with no href
      if (entry.tag === "a" && !entry.hasHrefAttr) {
        entry.issues.push({
          type: "link-no-href",
          text: "<a> without href is not focusable and not a link. Either add href, or use <button>/<span> with appropriate role."
        });
      }

      // 5. <a disabled> — disabled has no effect on <a>
      if (entry.tag === "a" && entry.disabledAttr) {
        entry.issues.push({
          type: "link-disabled-attr",
          text: "<a disabled> — the disabled attribute has no effect on <a>. Use aria-disabled=\"true\" plus tabindex=\"-1\" plus event prevention if disabling intent."
        });
      }

      // 6. inline-handler-on-link
      if (entry.tag === "a" && entry.hasHrefAttr && entry.inlineHandlers.length > 0) {
        var onclickAttr = el.getAttribute("onclick") || "";
        if (/preventDefault|return\s+false/i.test(onclickAttr)) {
          entry.issues.push({
            type: "inline-handler-on-link",
            text: "<a href=\"" + (entry.href || "") + "\"> with onclick that prevents default — the href is decorative; this is acting as a button."
          });
        }
      }

      // 7. div-onclick-no-role — non-interactive element with handler but no role/tabindex
      if (entry.inlineHandlers.length > 0 &&
          !isNativelyInteractive(el) &&
          !role &&
          entry.tabindex == null) {
        entry.issues.push({
          type: "div-onclick-no-role",
          text: "<" + entry.tag + "> has " + entry.inlineHandlers.join("/") + " but no role and no tabindex — keyboard users can't reach this element."
        });
      }

      // 8. role-without-tabindex — interactive role on non-focusable host
      if (role && INTERACTIVE_ARIA_ROLES[role] && !isNativelyInteractive(el) && entry.tabindex == null) {
        entry.issues.push({
          type: "role-without-tabindex",
          text: "role=\"" + role + "\" on <" + entry.tag + "> but no tabindex — element is not keyboard-reachable. Add tabindex=\"0\"."
        });
      }

      // 9. role-without-key-handler — has interactive role + onclick attr, but no onkey* attr
      if (role && INTERACTIVE_ARIA_ROLES[role] && !isNativelyInteractive(el) &&
          entry.inlineHandlers.length > 0 && !entry.keyHandlerAttr) {
        entry.issues.push({
          type: "role-without-key-handler",
          text: "role=\"" + role + "\" with " + entry.inlineHandlers.join("/") + " but no inline onkeydown/onkeyup/onkeypress attribute. If keyboard handlers are wired via addEventListener that's fine — this is a heuristic flag for manual review."
        });
      }

      // 10. aria-pressed only meaningful on buttons
      if (entry.ariaPressed != null && entry.effectiveRole !== "button") {
        entry.issues.push({
          type: "aria-pressed-without-button-role",
          text: "aria-pressed=\"" + entry.ariaPressed + "\" on element whose role is \"" + (entry.effectiveRole || "(none)") + "\" — aria-pressed is only meaningful on role=\"button\" (or native <button>)."
        });
      }

      // 11. aria-expanded only meaningful on certain roles
      if (entry.ariaExpanded != null) {
        var r = entry.effectiveRole;
        if (!r || !ROLES_SUPPORTING_EXPANDED[r]) {
          entry.issues.push({
            type: "aria-expanded-bad-role",
            text: "aria-expanded=\"" + entry.ariaExpanded + "\" on element whose role is \"" + (r || "(none)") + "\" — aria-expanded is only defined on button/link/combobox/tab/menuitem/treeitem/gridcell/row(header)/listbox/application/switch."
          });
        }
      }

      // 12. aria-haspopup without aria-expanded
      if (entry.ariaHaspopup && entry.ariaHaspopup !== "false" && entry.ariaExpanded == null) {
        entry.issues.push({
          type: "haspopup-without-expanded",
          text: "aria-haspopup=\"" + entry.ariaHaspopup + "\" without aria-expanded — the popup's current open/closed state isn't exposed to AT."
        });
      }

      return entry;
    }

    function shouldInclude(el) {
      if (!el || el.nodeType !== 1) return false;
      var tag = el.tagName;
      if (tag === "BUTTON") return true;
      if (tag === "A") return true;
      if (tag === "INPUT") {
        var t = (el.getAttribute("type") || "").toLowerCase();
        if (t === "submit" || t === "button" || t === "reset" || t === "image") return true;
        return false;
      }
      if (tag === "SUMMARY") return true;
      // Has explicit role of interest.
      var role = (el.getAttribute("role") || "").trim().toLowerCase();
      if (role && INTERACTIVE_ARIA_ROLES[role.split(/\s+/)[0]]) return true;
      // Has inline interaction handler.
      for (var i = 0; i < CLICK_ATTRS.length; i++) {
        if (el.hasAttribute(CLICK_ATTRS[i])) return true;
      }
      // Has aria-pressed / aria-expanded / aria-haspopup (i.e. claims to be a button-like).
      if (el.hasAttribute("aria-pressed")) return true;
      if (el.hasAttribute("aria-expanded")) return true;
      return false;
    }

    function walk(root) {
      if (!root) return;
      var all;
      try { all = root.querySelectorAll("*"); } catch (e) { return; }
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (shouldInclude(el)) results.push(analyse(el));
        if (el.shadowRoot) {
          shadowRoots++;
          walk(el.shadowRoot);
        }
      }
    }

    walk(document);

    return {
      url: url,
      isTop: isTop,
      results: results,
      shadowRoots: shadowRoots
    };
  } catch (e) {
    return {
      url: location.href,
      isTop: true,
      results: [],
      error: (e && e.message ? e.message : String(e))
    };
  }
}

function displayButtons(framesData, checkId) {
  "use strict";
  try {
    var P = "__a11yn_ext_";
    if (window[P + "cleanup"]) {
      try { window[P + "cleanup"](); } catch (e) {}
    }

    var allResults = [];
    var totalShadow = 0;
    var anyError = null;

    for (var fi = 0; fi < framesData.length; fi++) {
      var fd = framesData[fi];
      if (!fd) continue;
      if (fd.error) { anyError = fd.error; continue; }
      if (!fd.results) continue;
      totalShadow += (fd.shadowRoots || 0);
      for (var ri = 0; ri < fd.results.length; ri++) {
        var r = fd.results[ri];
        r._frameId = fd.frameId;
        r._frameUrl = fd.url;
        r._frameIsTop = !!fd.isTop;
        allResults.push(r);
      }
    }

    // Resolve elements in the top frame.
    for (var ai = 0; ai < allResults.length; ai++) {
      var d = allResults[ai];
      if (d._frameIsTop && d._resolveSel) {
        try { d._resolveEl = document.querySelector(d._resolveSel); } catch (e) {}
      }
    }

    var nativeBtn = 0, nativeLink = 0, ariaBtn = 0, ariaOther = 0, clickable = 0, toggles = 0, withIssues = 0, hiddenCount = 0;
    for (var ci = 0; ci < allResults.length; ci++) {
      var c = allResults[ci];
      if (c.hidden) hiddenCount++;
      if (c.issues && c.issues.length) withIssues++;
      if (c.ariaPressed != null || c.ariaExpanded != null || c.ariaHaspopup) toggles++;
      if (c.tag === "button" || (c.tag === "input" && (c.type === "submit" || c.type === "button" || c.type === "reset" || c.type === "image"))) nativeBtn++;
      else if (c.tag === "a") nativeLink++;
      else if (c.role === "button") ariaBtn++;
      else if (c.role && c.role !== "link") ariaOther++;
      else clickable++;
    }

    // ---- on-page panel ----
    var host = document.createElement("div");
    host.id = P + "host";
    host.style.setProperty("all", "initial", "important");
    document.documentElement.appendChild(host);
    var shadow = host.attachShadow({ mode: "closed" });

    var style = document.createElement("style");
    style.textContent =
      ':host { all: initial !important; }' +
      '* { box-sizing: border-box; font-family: ui-sans-serif, system-ui, sans-serif !important; }' +
      '.panel { position: fixed; top: 16px; right: 16px; width: 520px; max-height: 80vh; overflow: auto; background: #ffffff; color: #202020; border: 2px solid #003876; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,0.25); z-index: 2147483647; font-size: 16px; line-height: 1.4; }' +
      'header { background: #003876; color: #fff; padding: 10px 12px; display: flex; align-items: center; gap: 8px; }' +
      'header strong { flex: 1; font-size: 16px; }' +
      'header button { font: inherit; font-size: 14px; border: 1px solid #fff; background: transparent; color: #fff; padding: 4px 10px; border-radius: 4px; cursor: pointer; }' +
      'header button:hover { background: rgba(255,255,255,0.15); }' +
      '.summary { padding: 10px 12px; border-bottom: 1px solid #ddd; font-size: 15px; }' +
      '.filterbar { padding: 6px 12px; border-bottom: 1px solid #eee; display: flex; flex-wrap: wrap; gap: 4px; }' +
      '.filterbar button { font: inherit; font-size: 13px; border: 1px solid #aaa; background: #f4f4f4; color: #202020; padding: 3px 8px; border-radius: 4px; cursor: pointer; }' +
      '.filterbar button.active { background: #003876; color: #fff; border-color: #003876; }' +
      'ul { list-style: none; margin: 0; padding: 0; }' +
      'li.row { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; font-size: 15px; }' +
      'li.row:hover { background: #f6f9ff; }' +
      '.chip { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; margin-right: 6px; vertical-align: 1px; }' +
      '.chip.idx { background: #003876; color: #fff; }' +
      '.chip.btn { background: #1a7f1a; color: #fff; }' +
      '.chip.link { background: #6f42c1; color: #fff; }' +
      '.chip.aria { background: #d97706; color: #fff; }' +
      '.chip.clickable { background: #b00020; color: #fff; }' +
      '.chip.toggle { background: #003876; color: #fff; }' +
      '.chip.hidden { background: #707070; color: #fff; }' +
      '.name { color: #003876; font-weight: 600; }' +
      '.name.missing { color: #b00020; font-style: italic; }' +
      '.meta { color: #555; font-size: 13px; margin-top: 4px; }' +
      '.sel { font-family: ui-monospace, monospace !important; font-size: 12px; color: #444; word-break: break-all; }' +
      '.attr { font-family: ui-monospace, monospace !important; font-size: 12px; color: #555; }' +
      '.issues { margin-top: 6px; }' +
      '.issue { display: block; background: #fdecec; color: #7a0000; padding: 4px 8px; border-radius: 4px; font-size: 13px; margin-top: 2px; }' +
      '.panel.filter-issues li.row:not(.has-issue) { display: none; }' +
      '.panel.filter-buttons li.row:not(.is-button) { display: none; }' +
      '.panel.filter-links li.row:not(.is-link) { display: none; }' +
      '.panel.filter-clickable li.row:not(.is-clickable) { display: none; }' +
      '.panel.filter-toggles li.row:not(.is-toggle) { display: none; }' +
      'footer { padding: 8px 12px; font-size: 12px; color: #666; border-top: 1px solid #ddd; }';
    shadow.appendChild(style);

    function esc(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
      });
    }

    var panelEl = document.createElement("div");
    panelEl.className = "panel";

    var html = "";
    html += '<header><strong>Buttons &amp; interactive (' + allResults.length + ')</strong>' +
            '<button id="' + P + 'copy">Copy MD</button>' +
            '<button id="' + P + 'close">Close</button></header>';

    var summaryBits = [
      nativeBtn + " button",
      nativeLink + " link",
      ariaBtn ? (ariaBtn + " role=button") : null,
      ariaOther ? (ariaOther + " other role") : null,
      clickable ? (clickable + " clickable (no role)") : null,
      toggles ? (toggles + " toggle/popup") : null,
      hiddenCount ? (hiddenCount + " hidden") : null,
      withIssues + " with issues"
    ].filter(Boolean);
    html += '<div class="summary">' + esc(summaryBits.join(" · ")) +
            (totalShadow ? ' · ' + totalShadow + ' shadow root(s)' : '') +
            (anyError ? ' · <span style="color:#b00020">error: ' + esc(anyError) + '</span>' : '') +
            '</div>';

    html += '<div class="filterbar">' +
            '<button data-filter="all" class="active">All (' + allResults.length + ')</button>' +
            '<button data-filter="issues">Issues (' + withIssues + ')</button>' +
            '<button data-filter="buttons">Buttons (' + (nativeBtn + ariaBtn) + ')</button>' +
            '<button data-filter="links">Links (' + nativeLink + ')</button>' +
            '<button data-filter="clickable">Clickable-div (' + clickable + ')</button>' +
            '<button data-filter="toggles">Toggles (' + toggles + ')</button>' +
            '</div>';

    html += '<ul>';
    for (var ix = 0; ix < allResults.length; ix++) {
      var t = allResults[ix];
      var classes = ["row"];
      if (t.issues && t.issues.length) classes.push("has-issue");
      // Type classes for filters
      var isButton = (t.tag === "button" ||
                      (t.tag === "input" && (t.type === "submit" || t.type === "button" || t.type === "reset" || t.type === "image")) ||
                      t.role === "button");
      var isLink = (t.tag === "a" || t.role === "link");
      var isClickable = (!t.role && t.inlineHandlers && t.inlineHandlers.length > 0 &&
                        t.tag !== "button" && t.tag !== "a" && t.tag !== "input");
      var isToggle = (t.ariaPressed != null || t.ariaExpanded != null || t.ariaHaspopup);
      if (isButton) classes.push("is-button");
      if (isLink) classes.push("is-link");
      if (isClickable) classes.push("is-clickable");
      if (isToggle) classes.push("is-toggle");

      html += '<li class="' + classes.join(" ") + '">';
      html += '<span class="chip idx">#' + t.idx + '</span>';

      // Type chip(s)
      if (t.tag === "button") {
        html += '<span class="chip btn">&lt;button&gt;' + (t.type ? ' type="' + esc(t.type) + '"' : '') + '</span>';
      } else if (t.tag === "input") {
        html += '<span class="chip btn">&lt;input type="' + esc(t.type) + '"&gt;</span>';
      } else if (t.tag === "a") {
        html += '<span class="chip link">&lt;a' + (t.hasHrefAttr ? ' href' : '') + '&gt;</span>';
      } else if (t.role) {
        html += '<span class="chip aria">&lt;' + esc(t.tag) + ' role="' + esc(t.role) + '"&gt;</span>';
      } else {
        html += '<span class="chip clickable">&lt;' + esc(t.tag) + '&gt;</span>';
      }

      if (isToggle) {
        var togBits = [];
        if (t.ariaPressed != null) togBits.push("aria-pressed=" + t.ariaPressed);
        if (t.ariaExpanded != null) togBits.push("aria-expanded=" + t.ariaExpanded);
        if (t.ariaHaspopup) togBits.push("aria-haspopup=" + t.ariaHaspopup);
        html += '<span class="chip toggle">' + esc(togBits.join(" ")) + '</span>';
      }
      if (t.hidden) html += '<span class="chip hidden">HIDDEN</span>';

      if (t.accName) {
        html += '<span class="name">' + esc(t.accName.length > 60 ? t.accName.slice(0, 60) + "…" : t.accName) + '</span>';
      } else {
        html += '<span class="name missing">(no accessible name)</span>';
      }

      var metaParts = [];
      if (t.tag === "a" && t.hasHrefAttr) metaParts.push("href=" + (t.href || "").slice(0, 60));
      if (t.tabindexRaw != null) metaParts.push("tabindex=" + t.tabindexRaw);
      if (t.inlineHandlers && t.inlineHandlers.length) metaParts.push("inline: " + t.inlineHandlers.join(", "));
      if (t.keyHandlerAttr) metaParts.push("key: " + t.keyHandlerAttr);
      if (t.disabledAttr) metaParts.push("disabled");
      if (t.ariaDisabled) metaParts.push("aria-disabled");
      metaParts.push(t.width + "×" + t.height + " px");
      if (t._frameUrl && !t._frameIsTop) metaParts.push("in frame");
      html += '<div class="meta">' + esc(metaParts.join(" · ")) + '</div>';
      html += '<div class="sel">' + esc(t.sel) + '</div>';

      if (t.issues && t.issues.length) {
        html += '<div class="issues">';
        for (var ji = 0; ji < t.issues.length; ji++) {
          html += '<span class="issue">' + esc(t.issues[ji].text) + '</span>';
        }
        html += '</div>';
      }
      html += '</li>';
    }
    html += '</ul>';
    html += '<footer>WCAG 2.1.1 Keyboard · 4.1.2 Name/Role/Value · 3.3.1/3.3.2 (button type defaults). Heuristic limitations: handlers attached via addEventListener are invisible to static inspection.</footer>';
    panelEl.innerHTML = html;
    shadow.appendChild(panelEl);

    // Click a row to scroll the element into view and flash it.
    panelEl.querySelectorAll("li.row").forEach(function (li, i) {
      li.style.cursor = "pointer";
      li.addEventListener("click", function (e) {
        if (e.target.closest && e.target.closest("button")) return;
        var r = allResults[i];
        if (r && r._resolveEl) {
          try {
            r._resolveEl.scrollIntoView({ behavior: "smooth", block: "center" });
            r._resolveEl.style.setProperty("box-shadow", "0 0 0 4px #ffeb3b", "important");
            setTimeout(function () {
              try { r._resolveEl.style.removeProperty("box-shadow"); } catch (er) {}
            }, 1400);
          } catch (er) {}
        }
      });
    });

    // Outline top-frame elements.
    for (var oi = 0; oi < allResults.length; oi++) {
      var o = allResults[oi];
      if (o._resolveEl) {
        try {
          var color = (o.issues && o.issues.length) ? "#b00020" : "#003876";
          o._resolveEl.style.setProperty("outline", "2px solid " + color, "important");
          o._resolveEl.style.setProperty("outline-offset", "2px", "important");
        } catch (e) {}
      }
    }

    // ---- markdown ----
    var md = "# Buttons & interactive\n\n";
    md += "Counts: " + nativeBtn + " <button>/<input>, " + nativeLink + " <a>";
    if (ariaBtn) md += ", " + ariaBtn + " role=button";
    if (ariaOther) md += ", " + ariaOther + " other role";
    if (clickable) md += ", " + clickable + " clickable-no-role";
    md += ", " + withIssues + " with issues.\n\n";
    md += "| # | Element | Role | Name | href / handler | tabindex | Issues | Selector |\n";
    md += "|---|---------|------|------|----------------|----------|--------|----------|\n";
    for (var mi = 0; mi < allResults.length; mi++) {
      var mt = allResults[mi];
      var elDesc = "<" + mt.tag;
      if (mt.type) elDesc += " type=" + mt.type;
      if (mt.hasHrefAttr && mt.tag === "a") elDesc += " href";
      elDesc += ">";
      var roleStr = mt.role || (mt.effectiveRole !== mt.tag ? mt.effectiveRole : "");
      var name = mt.accName ? mt.accName.replace(/\|/g, "\\|") : "";
      var handler = (mt.tag === "a" && mt.hasHrefAttr) ? mt.href : (mt.inlineHandlers ? mt.inlineHandlers.join(",") : "");
      handler = (handler || "").replace(/\|/g, "\\|");
      var issueStr = mt.issues && mt.issues.length ? mt.issues.map(function (z) { return z.type; }).join("; ") : "";
      md += "| " + mt.idx +
            " | " + elDesc.replace(/\|/g, "\\|") +
            " | " + (roleStr || "") +
            " | " + name +
            " | " + (handler.length > 60 ? handler.slice(0, 60) + "…" : handler) +
            " | " + (mt.tabindexRaw == null ? "" : mt.tabindexRaw) +
            " | " + issueStr +
            " | `" + mt.sel.replace(/\|/g, "\\|") + "` |\n";
    }

    // ---- filter bar ----
    panelEl.querySelectorAll(".filterbar button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var filter = btn.dataset.filter;
        panelEl.className = "panel filter-" + filter;
        panelEl.querySelectorAll(".filterbar button").forEach(function (b) {
          b.classList.toggle("active", b === btn);
        });
      });
    });

    // ---- drag ----
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
        try { header.setPointerCapture(e.pointerId); } catch (ee) {}
        e.preventDefault();
      });
      header.addEventListener("pointermove", function (e) {
        if (!dragging) return;
        var dx = e.clientX - startX, dy = e.clientY - startY;
        panelEl.style.left = (startLeft + dx) + "px";
        panelEl.style.top = (startTop + dy) + "px";
      });
      header.addEventListener("pointerup", function (e) {
        dragging = false;
        try { header.releasePointerCapture(e.pointerId); } catch (ee) {}
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
  } catch (e) {
    try {
      var Pe = "__a11yn_ext_";
      var hostE = document.createElement("div");
      hostE.id = Pe + "host";
      hostE.style.cssText = "position:fixed;top:16px;right:16px;background:#b00020;color:#fff;padding:12px 16px;border-radius:6px;z-index:2147483647;font:14px ui-sans-serif,system-ui,sans-serif;max-width:480px;";
      hostE.textContent = "Buttons check failed: " + (e && e.message ? e.message : String(e));
      document.documentElement.appendChild(hostE);
      setTimeout(function () { try { hostE.remove(); } catch (er) {} }, 6000);
    } catch (e2) {}
  }
}

/* ====================================================================
 * CHECK: LISTS — list semantics inspector (WCAG 1.3.1)
 *
 * Every <ul>, <ol>, <menu>, <dl>, and every [role="list"] container
 * becomes a row. Orphan <li>/<dt>/<dd>/[role="listitem"] elements
 * (those outside an appropriate list container) get their own rows.
 *
 * Per-row flags:
 *   non-li-children          <ul>/<ol>/<menu> with non-<li> direct children
 *                            (other than <script>/<template>)
 *   orphan-li                <li> outside <ul>/<ol>/<menu> or [role="list"]
 *   empty-list               container has no list items at all
 *   empty-list-item          <li>/<dt>/<dd> with no text and no children
 *   list-style-none-no-role  <ul>/<ol> with list-style:none and no
 *                            explicit role="list" (Safari/VO strips
 *                            list semantics)
 *   role-presentation-on-list  role="presentation"/"none" on <ul>/<ol>
 *                            (intentional strip; flagged informationally)
 *   role-list-without-listitem-children
 *                            [role="list"] on non-<ul>/<ol> host with
 *                            children that don't have role="listitem"
 *   role-listitem-orphan     [role="listitem"] without role="list" or
 *                            <ul>/<ol> ancestor
 *   dl-bad-children          <dl> with children other than
 *                            <dt>/<dd>/<div>/<script>/<template>
 *   dl-dt-no-dd              <dt> not followed by a <dd>
 *   dl-dd-no-dt              <dd> not preceded by a <dt> in its group
 * ==================================================================== */

function scanLists() {
  "use strict";
  try {
    var results = [];
    var shadowRoots = 0;
    var url = location.href;
    var isTop = (function () { try { return window.top === window.self; } catch (e) { return false; } })();
    var idCounter = 0;
    var seen = new Set(); // track elements already added so orphan walk doesn't dup

    function txt(el) {
      if (!el) return "";
      return (el.textContent || "").replace(/\s+/g, " ").trim();
    }

    function isHidden(el) {
      if (!el || el.nodeType !== 1) return false;
      for (var n = el; n && n.nodeType === 1; n = n.parentNode || (n.getRootNode && n.getRootNode().host)) {
        var cs;
        try { cs = getComputedStyle(n); } catch (e) { return false; }
        if (!cs) return false;
        if (cs.display === "none" || cs.visibility === "hidden") return true;
      }
      return false;
    }

    function uniqueSelector(el) {
      if (!el || el.nodeType !== 1) return "";
      var path = [];
      var node = el;
      while (node && node.nodeType === 1) {
        if (node.id) { path.unshift("#" + CSS.escape(node.id)); break; }
        var name = node.tagName.toLowerCase();
        var parent = node.parentNode;
        if (parent && parent.nodeType === 1) {
          var i = 1, sib = node.previousElementSibling;
          while (sib) {
            if (sib.tagName === node.tagName) i++;
            sib = sib.previousElementSibling;
          }
          name += ":nth-of-type(" + i + ")";
        }
        path.unshift(name);
        node = parent;
        if (!node || (node && node.nodeType === 11)) break;
      }
      return path.join(" > ");
    }

    function tagOf(el) { return el && el.tagName ? el.tagName.toLowerCase() : ""; }

    function roleOf(el) {
      var r = (el.getAttribute && el.getAttribute("role")) || "";
      r = r.trim().toLowerCase();
      if (r.indexOf(" ") !== -1) r = r.split(/\s+/)[0];
      return r;
    }

    function isPresentationRole(role) { return role === "presentation" || role === "none"; }

    function isInsideList(el) {
      // True if this <li> (or role=listitem) has a list container ancestor.
      for (var n = el.parentNode; n && n.nodeType === 1; n = n.parentNode) {
        var t = tagOf(n);
        if (t === "ul" || t === "ol" || t === "menu") return true;
        if (roleOf(n) === "list") return true;
      }
      return false;
    }

    function isInsideDl(el) {
      for (var n = el.parentNode; n && n.nodeType === 1; n = n.parentNode) {
        if (tagOf(n) === "dl") return true;
      }
      return false;
    }

    function listStyleIsNone(el) {
      try {
        var cs = getComputedStyle(el);
        if (!cs) return false;
        return cs.listStyleType === "none";
      } catch (e) {
        return false;
      }
    }

    function isItemEmpty(el) {
      if (!el) return false;
      var t = txt(el);
      if (t) return false;
      // Any element children?
      for (var i = 0; i < el.children.length; i++) {
        var c = el.children[i];
        var tn = tagOf(c);
        if (tn === "img" && c.getAttribute("alt")) return false;
        if (tn === "input" || tn === "button" || tn === "a" || tn === "select" || tn === "textarea") return false;
      }
      // No text and no meaningful children
      return el.children.length === 0;
    }

    function firstItemSample(container, itemTagSet) {
      for (var i = 0; i < container.children.length; i++) {
        var c = container.children[i];
        var tn = tagOf(c);
        if (itemTagSet[tn]) {
          var t = txt(c);
          if (t) return t.length > 60 ? t.slice(0, 60) + "…" : t;
        }
      }
      return "";
    }

    /* ---- analyse <ul>/<ol>/<menu> ---- */
    function analyseListContainer(el) {
      var t = tagOf(el);
      var role = roleOf(el);
      var entry = {
        idx: ++idCounter,
        sel: uniqueSelector(el),
        tag: t,
        role: role,
        category: t,
        itemCount: 0,
        listStyleNone: false,
        sampleText: "",
        hidden: isHidden(el),
        issues: [],
        _resolveSel: ""
      };
      entry._resolveSel = entry.sel;
      seen.add(el);

      // Direct children analysis.
      var liChildren = 0;
      var badChildren = [];
      for (var i = 0; i < el.children.length; i++) {
        var c = el.children[i];
        var ct = tagOf(c);
        if (ct === "li") {
          liChildren++;
          if (isItemEmpty(c)) {
            entry.issues.push({
              type: "empty-list-item",
              text: "Empty <li> at " + uniqueSelector(c)
            });
          }
          seen.add(c);
        } else if (ct === "script" || ct === "template") {
          // allowed
        } else {
          badChildren.push(ct);
        }
      }
      entry.itemCount = liChildren;
      entry.sampleText = firstItemSample(el, { li: 1 });

      if (badChildren.length) {
        entry.issues.push({
          type: "non-li-children",
          text: "<" + t + "> has " + badChildren.length + " direct child(ren) that are not <li>: <" + badChildren.join(">, <") + ">. Breaks list semantics."
        });
      }
      if (liChildren === 0) {
        entry.issues.push({
          type: "empty-list",
          text: "<" + t + "> contains no <li> items."
        });
      }

      // role="presentation"/"none" on natural list?
      if (isPresentationRole(role)) {
        entry.issues.push({
          type: "role-presentation-on-list",
          text: "<" + t + " role=\"" + role + "\"> intentionally strips list semantics. SR users won't be told this is a list. Verify intent."
        });
      }

      // list-style:none without explicit role="list"?
      entry.listStyleNone = listStyleIsNone(el);
      if (entry.listStyleNone && role !== "list" && !isPresentationRole(role)) {
        entry.issues.push({
          type: "list-style-none-no-role",
          text: "<" + t + "> has list-style:none and no role=\"list\". Safari/VoiceOver strips list semantics when bullets are removed via CSS — add role=\"list\" to keep the list announced."
        });
      }

      return entry;
    }

    /* ---- analyse <dl> ---- */
    function analyseDl(el) {
      var role = roleOf(el);
      var entry = {
        idx: ++idCounter,
        sel: uniqueSelector(el),
        tag: "dl",
        role: role,
        category: "dl",
        itemCount: 0,
        listStyleNone: false,
        sampleText: "",
        hidden: isHidden(el),
        issues: [],
        _resolveSel: ""
      };
      entry._resolveSel = entry.sel;
      seen.add(el);

      // Direct children — allowed: dt, dd, div (HTML5 wrapper), script, template
      var groups = []; // array of {dts:[], dds:[]} per group
      var current = { dts: [], dds: [] };
      var badChildren = [];

      function consumeGroup(g) {
        if (g.dts.length === 0 && g.dds.length === 0) return;
        groups.push(g);
      }

      function processItem(node) {
        var tn = tagOf(node);
        if (tn === "dt") {
          if (current.dds.length > 0) {
            // dd seen earlier; start a new group on this new dt
            consumeGroup(current);
            current = { dts: [], dds: [] };
          }
          current.dts.push(node);
          seen.add(node);
          if (isItemEmpty(node)) entry.issues.push({ type: "empty-list-item", text: "Empty <dt> at " + uniqueSelector(node) });
        } else if (tn === "dd") {
          current.dds.push(node);
          seen.add(node);
          if (isItemEmpty(node)) entry.issues.push({ type: "empty-list-item", text: "Empty <dd> at " + uniqueSelector(node) });
        }
      }

      for (var i = 0; i < el.children.length; i++) {
        var c = el.children[i];
        var ct = tagOf(c);
        if (ct === "dt" || ct === "dd") {
          processItem(c);
        } else if (ct === "div") {
          // Per HTML5, a <div> child of <dl> can wrap one or more dt+dd pairs.
          // Treat its dt/dd descendants as part of this group then reset.
          consumeGroup(current);
          current = { dts: [], dds: [] };
          for (var j = 0; j < c.children.length; j++) {
            processItem(c.children[j]);
          }
          consumeGroup(current);
          current = { dts: [], dds: [] };
        } else if (ct === "script" || ct === "template") {
          // allowed
        } else {
          badChildren.push(ct);
        }
      }
      consumeGroup(current);

      // Now check each group.
      for (var g = 0; g < groups.length; g++) {
        if (groups[g].dts.length > 0 && groups[g].dds.length === 0) {
          entry.issues.push({
            type: "dl-dt-no-dd",
            text: "<dt> not followed by any <dd>: " + groups[g].dts.map(function (n) { return uniqueSelector(n); }).join(", ")
          });
        }
        if (groups[g].dts.length === 0 && groups[g].dds.length > 0) {
          entry.issues.push({
            type: "dl-dd-no-dt",
            text: "<dd> with no preceding <dt>: " + groups[g].dds.map(function (n) { return uniqueSelector(n); }).join(", ")
          });
        }
      }

      if (badChildren.length) {
        entry.issues.push({
          type: "dl-bad-children",
          text: "<dl> has " + badChildren.length + " direct child(ren) that are not <dt>/<dd>/<div>: <" + badChildren.join(">, <") + ">."
        });
      }

      var totalDt = 0, totalDd = 0;
      for (var k = 0; k < groups.length; k++) {
        totalDt += groups[k].dts.length;
        totalDd += groups[k].dds.length;
      }
      entry.itemCount = totalDt + totalDd;
      // sample = first dt text if any
      for (var s = 0; s < groups.length; s++) {
        if (groups[s].dts.length > 0) {
          var sampleNode = groups[s].dts[0];
          var ts = txt(sampleNode);
          if (ts) { entry.sampleText = ts.length > 60 ? ts.slice(0, 60) + "…" : ts; break; }
        }
      }
      if (entry.itemCount === 0) {
        entry.issues.push({
          type: "empty-list",
          text: "<dl> contains no <dt>/<dd> items."
        });
      }
      return entry;
    }

    /* ---- analyse role="list" container on non-natural host ---- */
    function analyseAriaList(el) {
      var role = roleOf(el);
      var entry = {
        idx: ++idCounter,
        sel: uniqueSelector(el),
        tag: tagOf(el),
        role: role,
        category: "aria-list",
        itemCount: 0,
        listStyleNone: false,
        sampleText: "",
        hidden: isHidden(el),
        issues: [],
        _resolveSel: ""
      };
      entry._resolveSel = entry.sel;
      seen.add(el);

      var listitemChildren = 0;
      var bad = [];
      for (var i = 0; i < el.children.length; i++) {
        var c = el.children[i];
        if (roleOf(c) === "listitem") {
          listitemChildren++;
          seen.add(c);
        } else {
          bad.push(tagOf(c));
        }
      }
      entry.itemCount = listitemChildren;
      if (listitemChildren === 0) {
        entry.issues.push({
          type: "empty-list",
          text: "[role=\"list\"] has no role=\"listitem\" children."
        });
      } else if (bad.length > 0) {
        entry.issues.push({
          type: "role-list-without-listitem-children",
          text: "[role=\"list\"] has " + bad.length + " direct child(ren) without role=\"listitem\": <" + bad.join(">, <") + ">."
        });
      }
      return entry;
    }

    /* ---- orphan analyses ---- */
    function analyseOrphan(el, kind) {
      var role = roleOf(el);
      var entry = {
        idx: ++idCounter,
        sel: uniqueSelector(el),
        tag: tagOf(el),
        role: role,
        category: kind,
        itemCount: 0,
        listStyleNone: false,
        sampleText: txt(el).slice(0, 60),
        hidden: isHidden(el),
        issues: [],
        _resolveSel: ""
      };
      entry._resolveSel = entry.sel;
      seen.add(el);

      if (kind === "orphan-li") {
        entry.issues.push({
          type: "orphan-li",
          text: "<li> outside any <ul>/<ol>/<menu> or [role=\"list\"] ancestor."
        });
      } else if (kind === "orphan-listitem") {
        entry.issues.push({
          type: "role-listitem-orphan",
          text: "[role=\"listitem\"] without a <ul>/<ol> or [role=\"list\"] ancestor."
        });
      } else if (kind === "orphan-dt") {
        entry.issues.push({
          type: "dl-dd-no-dt",
          text: "<dt> outside any <dl>."
        });
      } else if (kind === "orphan-dd") {
        entry.issues.push({
          type: "dl-dd-no-dt",
          text: "<dd> outside any <dl>."
        });
      }
      return entry;
    }

    /* ---- walk ---- */
    function walk(root) {
      if (!root) return;
      var containers;
      try {
        containers = root.querySelectorAll('ul, ol, menu, dl, [role="list"]');
      } catch (e) { containers = []; }
      for (var i = 0; i < containers.length; i++) {
        var el = containers[i];
        if (seen.has(el)) continue;
        var t = tagOf(el);
        if (t === "ul" || t === "ol" || t === "menu") {
          results.push(analyseListContainer(el));
        } else if (t === "dl") {
          results.push(analyseDl(el));
        } else if (roleOf(el) === "list") {
          // role="list" on something other than ul/ol — treat as aria-list
          results.push(analyseAriaList(el));
        }
      }

      // Orphan items.
      var li;
      try { li = root.querySelectorAll("li"); } catch (e) { li = []; }
      for (var j = 0; j < li.length; j++) {
        if (seen.has(li[j])) continue;
        if (!isInsideList(li[j])) {
          results.push(analyseOrphan(li[j], "orphan-li"));
        }
      }
      var listitem;
      try { listitem = root.querySelectorAll('[role="listitem"]'); } catch (e) { listitem = []; }
      for (var k = 0; k < listitem.length; k++) {
        if (seen.has(listitem[k])) continue;
        if (!isInsideList(listitem[k])) {
          results.push(analyseOrphan(listitem[k], "orphan-listitem"));
        }
      }
      var dts;
      try { dts = root.querySelectorAll("dt"); } catch (e) { dts = []; }
      for (var m = 0; m < dts.length; m++) {
        if (seen.has(dts[m])) continue;
        if (!isInsideDl(dts[m])) results.push(analyseOrphan(dts[m], "orphan-dt"));
      }
      var dds;
      try { dds = root.querySelectorAll("dd"); } catch (e) { dds = []; }
      for (var n = 0; n < dds.length; n++) {
        if (seen.has(dds[n])) continue;
        if (!isInsideDl(dds[n])) results.push(analyseOrphan(dds[n], "orphan-dd"));
      }

      // Shadow DOM recursion.
      var all;
      try { all = root.querySelectorAll("*"); } catch (e) { return; }
      for (var q = 0; q < all.length; q++) {
        if (all[q].shadowRoot) {
          shadowRoots++;
          walk(all[q].shadowRoot);
        }
      }
    }

    walk(document);

    return {
      url: url,
      isTop: isTop,
      results: results,
      shadowRoots: shadowRoots
    };
  } catch (e) {
    return {
      url: location.href,
      isTop: true,
      results: [],
      error: (e && e.message ? e.message : String(e))
    };
  }
}

function displayLists(framesData, checkId) {
  "use strict";
  try {
    var P = "__a11yn_ext_";
    if (window[P + "cleanup"]) {
      try { window[P + "cleanup"](); } catch (e) {}
    }

    var allResults = [];
    var totalShadow = 0;
    var anyError = null;

    for (var fi = 0; fi < framesData.length; fi++) {
      var fd = framesData[fi];
      if (!fd) continue;
      if (fd.error) { anyError = fd.error; continue; }
      if (!fd.results) continue;
      totalShadow += (fd.shadowRoots || 0);
      for (var ri = 0; ri < fd.results.length; ri++) {
        var r = fd.results[ri];
        r._frameId = fd.frameId;
        r._frameUrl = fd.url;
        r._frameIsTop = !!fd.isTop;
        allResults.push(r);
      }
    }

    // Resolve elements in top frame.
    for (var ai = 0; ai < allResults.length; ai++) {
      var d = allResults[ai];
      if (d._frameIsTop && d._resolveSel) {
        try { d._resolveEl = document.querySelector(d._resolveSel); } catch (e) {}
      }
    }

    var ulCount = 0, dlCount = 0, ariaListCount = 0, orphanCount = 0, singleItem = 0, withIssues = 0;
    for (var ci = 0; ci < allResults.length; ci++) {
      var c = allResults[ci];
      if (c.category === "ul" || c.category === "ol" || c.category === "menu") ulCount++;
      else if (c.category === "dl") dlCount++;
      else if (c.category === "aria-list") ariaListCount++;
      else orphanCount++;
      if (c.itemCount === 1 && (c.category === "ul" || c.category === "ol" || c.category === "menu" || c.category === "aria-list")) singleItem++;
      if (c.issues && c.issues.length) withIssues++;
    }

    var host = document.createElement("div");
    host.id = P + "host";
    host.style.setProperty("all", "initial", "important");
    document.documentElement.appendChild(host);
    var shadow = host.attachShadow({ mode: "closed" });

    var style = document.createElement("style");
    style.textContent =
      ':host { all: initial !important; }' +
      '* { box-sizing: border-box; font-family: ui-sans-serif, system-ui, sans-serif !important; }' +
      '.panel { position: fixed; top: 16px; right: 16px; width: 500px; max-height: 80vh; overflow: auto; background: #ffffff; color: #202020; border: 2px solid #003876; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,0.25); z-index: 2147483647; font-size: 16px; line-height: 1.4; }' +
      'header { background: #003876; color: #fff; padding: 10px 12px; display: flex; align-items: center; gap: 8px; }' +
      'header strong { flex: 1; font-size: 16px; }' +
      'header button { font: inherit; font-size: 14px; border: 1px solid #fff; background: transparent; color: #fff; padding: 4px 10px; border-radius: 4px; cursor: pointer; }' +
      'header button:hover { background: rgba(255,255,255,0.15); }' +
      '.summary { padding: 10px 12px; border-bottom: 1px solid #ddd; font-size: 15px; }' +
      '.filterbar { padding: 6px 12px; border-bottom: 1px solid #eee; display: flex; flex-wrap: wrap; gap: 4px; }' +
      '.filterbar button { font: inherit; font-size: 13px; border: 1px solid #aaa; background: #f4f4f4; color: #202020; padding: 3px 8px; border-radius: 4px; cursor: pointer; }' +
      '.filterbar button.active { background: #003876; color: #fff; border-color: #003876; }' +
      'ul { list-style: none; margin: 0; padding: 0; }' +
      'li.row { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; font-size: 15px; }' +
      'li.row:hover { background: #f6f9ff; }' +
      '.chip { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; margin-right: 6px; vertical-align: 1px; }' +
      '.chip.idx { background: #003876; color: #fff; }' +
      '.chip.ul { background: #1a7f1a; color: #fff; }' +
      '.chip.dl { background: #6f42c1; color: #fff; }' +
      '.chip.aria { background: #d97706; color: #fff; }' +
      '.chip.orphan { background: #b00020; color: #fff; }' +
      '.chip.hidden { background: #707070; color: #fff; }' +
      '.chip.style { background: #555; color: #fff; font-weight: 500; }' +
      '.name { color: #003876; font-weight: 600; }' +
      '.meta { color: #555; font-size: 13px; margin-top: 4px; }' +
      '.sel { font-family: ui-monospace, monospace !important; font-size: 12px; color: #444; word-break: break-all; }' +
      '.sample { color: #303030; font-size: 14px; margin-top: 4px; font-style: italic; }' +
      '.issues { margin-top: 6px; }' +
      '.issue { display: block; background: #fdecec; color: #7a0000; padding: 4px 8px; border-radius: 4px; font-size: 13px; margin-top: 2px; }' +
      '.panel.filter-issues li.row:not(.has-issue) { display: none; }' +
      '.panel.filter-ulol li.row:not(.is-ulol) { display: none; }' +
      '.panel.filter-dl li.row:not(.is-dl) { display: none; }' +
      '.panel.filter-aria li.row:not(.is-aria) { display: none; }' +
      '.panel.filter-single li.row:not(.is-single) { display: none; }' +
      'footer { padding: 8px 12px; font-size: 12px; color: #666; border-top: 1px solid #ddd; }';
    shadow.appendChild(style);

    function esc(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
      });
    }

    var panelEl = document.createElement("div");
    panelEl.className = "panel";

    var html = "";
    html += '<header><strong>Lists (' + allResults.length + ')</strong>' +
            '<button id="' + P + 'copy">Copy MD</button>' +
            '<button id="' + P + 'close">Close</button></header>';

    var summaryBits = [
      ulCount + " <ul>/<ol>/<menu>",
      dlCount + " <dl>",
      ariaListCount ? (ariaListCount + " ARIA list") : null,
      orphanCount ? (orphanCount + " orphan") : null,
      withIssues + " with issues"
    ].filter(Boolean);
    html += '<div class="summary">' + esc(summaryBits.join(" · ")) +
            (totalShadow ? ' · ' + totalShadow + ' shadow root(s)' : '') +
            (anyError ? ' · <span style="color:#b00020">error: ' + esc(anyError) + '</span>' : '') +
            '</div>';

    html += '<div class="filterbar">' +
            '<button data-filter="all" class="active">All (' + allResults.length + ')</button>' +
            '<button data-filter="issues">Issues (' + withIssues + ')</button>' +
            '<button data-filter="ulol">&lt;ul&gt;/&lt;ol&gt; (' + ulCount + ')</button>' +
            '<button data-filter="dl">&lt;dl&gt; (' + dlCount + ')</button>' +
            '<button data-filter="aria">ARIA lists (' + ariaListCount + ')</button>' +
            '<button data-filter="single">Single-item (' + singleItem + ')</button>' +
            '</div>';

    html += '<ul>';
    for (var ix = 0; ix < allResults.length; ix++) {
      var t = allResults[ix];
      var classes = ["row"];
      if (t.issues && t.issues.length) classes.push("has-issue");
      if (t.category === "ul" || t.category === "ol" || t.category === "menu") classes.push("is-ulol");
      else if (t.category === "dl") classes.push("is-dl");
      else if (t.category === "aria-list") classes.push("is-aria");
      else classes.push("is-orphan");
      if (t.itemCount === 1 && (t.category === "ul" || t.category === "ol" || t.category === "menu" || t.category === "aria-list")) classes.push("is-single");

      html += '<li class="' + classes.join(" ") + '">';
      html += '<span class="chip idx">#' + t.idx + '</span>';

      var chipClass = "ul";
      var chipLabel = "&lt;" + t.tag + "&gt;";
      if (t.category === "dl") chipClass = "dl";
      else if (t.category === "aria-list") { chipClass = "aria"; chipLabel = "&lt;" + t.tag + " role=\"list\"&gt;"; }
      else if (t.category === "orphan-li" || t.category === "orphan-listitem" || t.category === "orphan-dt" || t.category === "orphan-dd") {
        chipClass = "orphan";
        chipLabel = "ORPHAN " + chipLabel;
      }
      if (t.role && t.category !== "aria-list" && !chipLabel.indexOf("role=") < 0) {
        chipLabel += ' role="' + esc(t.role) + '"';
      }
      html += '<span class="chip ' + chipClass + '">' + chipLabel + '</span>';

      if (t.listStyleNone) {
        html += '<span class="chip style">list-style: none</span>';
      }
      if (t.hidden) html += '<span class="chip hidden">HIDDEN</span>';

      // item count + sample
      var metaParts = [];
      if (t.category === "ul" || t.category === "ol" || t.category === "menu" || t.category === "aria-list") {
        metaParts.push(t.itemCount + " item" + (t.itemCount === 1 ? "" : "s"));
      } else if (t.category === "dl") {
        metaParts.push(t.itemCount + " dt/dd entries");
      }
      if (t._frameUrl && !t._frameIsTop) metaParts.push("in frame");
      if (metaParts.length) html += '<div class="meta">' + esc(metaParts.join(" · ")) + '</div>';

      if (t.sampleText) html += '<div class="sample">First item: ' + esc(t.sampleText) + '</div>';
      html += '<div class="sel">' + esc(t.sel) + '</div>';

      if (t.issues && t.issues.length) {
        html += '<div class="issues">';
        for (var ji = 0; ji < t.issues.length; ji++) {
          html += '<span class="issue">' + esc(t.issues[ji].text) + '</span>';
        }
        html += '</div>';
      }
      html += '</li>';
    }
    html += '</ul>';
    html += '<footer>WCAG 1.3.1 Info and Relationships · List semantics inventory</footer>';
    panelEl.innerHTML = html;
    shadow.appendChild(panelEl);

    // Click a row to scroll the element into view and flash it.
    panelEl.querySelectorAll("li.row").forEach(function (li, i) {
      li.style.cursor = "pointer";
      li.addEventListener("click", function (e) {
        if (e.target.closest && e.target.closest("button")) return;
        var r = allResults[i];
        if (r && r._resolveEl) {
          try {
            r._resolveEl.scrollIntoView({ behavior: "smooth", block: "center" });
            r._resolveEl.style.setProperty("box-shadow", "0 0 0 4px #ffeb3b", "important");
            setTimeout(function () {
              try { r._resolveEl.style.removeProperty("box-shadow"); } catch (er) {}
            }, 1400);
          } catch (er) {}
        }
      });
    });

    // Outline top-frame containers.
    for (var oi = 0; oi < allResults.length; oi++) {
      var o = allResults[oi];
      if (o._resolveEl) {
        try {
          var color = (o.issues && o.issues.length) ? "#b00020" : "#003876";
          o._resolveEl.style.setProperty("outline", "2px solid " + color, "important");
          o._resolveEl.style.setProperty("outline-offset", "2px", "important");
        } catch (e) {}
      }
    }

    // ---- markdown ----
    var md = "# Lists\n\n";
    md += "Counts: " + ulCount + " <ul>/<ol>/<menu>, " + dlCount + " <dl>";
    if (ariaListCount) md += ", " + ariaListCount + " ARIA list";
    if (orphanCount) md += ", " + orphanCount + " orphan";
    md += ", " + withIssues + " with issues.\n\n";
    md += "| # | Tag | Role | Items | list-style:none | Issues | Selector | First item |\n";
    md += "|---|-----|------|-------|-----------------|--------|----------|------------|\n";
    for (var mi = 0; mi < allResults.length; mi++) {
      var mt = allResults[mi];
      var issueStr = mt.issues && mt.issues.length ? mt.issues.map(function (z) { return z.type; }).join("; ") : "";
      md += "| " + mt.idx +
            " | <" + mt.tag + ">" +
            " | " + (mt.role || "") +
            " | " + mt.itemCount +
            " | " + (mt.listStyleNone ? "yes" : "") +
            " | " + issueStr +
            " | `" + mt.sel.replace(/\|/g, "\\|") + "`" +
            " | " + (mt.sampleText || "").replace(/\|/g, "\\|") +
            " |\n";
    }

    panelEl.querySelectorAll(".filterbar button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var filter = btn.dataset.filter;
        panelEl.className = "panel filter-" + filter;
        panelEl.querySelectorAll(".filterbar button").forEach(function (b) {
          b.classList.toggle("active", b === btn);
        });
      });
    });

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
        try { header.setPointerCapture(e.pointerId); } catch (ee) {}
        e.preventDefault();
      });
      header.addEventListener("pointermove", function (e) {
        if (!dragging) return;
        var dx = e.clientX - startX, dy = e.clientY - startY;
        panelEl.style.left = (startLeft + dx) + "px";
        panelEl.style.top = (startTop + dy) + "px";
      });
      header.addEventListener("pointerup", function (e) {
        dragging = false;
        try { header.releasePointerCapture(e.pointerId); } catch (ee) {}
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
  } catch (e) {
    try {
      var Pe = "__a11yn_ext_";
      var hostE = document.createElement("div");
      hostE.id = Pe + "host";
      hostE.style.cssText = "position:fixed;top:16px;right:16px;background:#b00020;color:#fff;padding:12px 16px;border-radius:6px;z-index:2147483647;font:14px ui-sans-serif,system-ui,sans-serif;max-width:480px;";
      hostE.textContent = "Lists check failed: " + (e && e.message ? e.message : String(e));
      document.documentElement.appendChild(hostE);
      setTimeout(function () { try { hostE.remove(); } catch (er) {} }, 6000);
    } catch (e2) {}
  }
}
