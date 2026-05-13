# Architecture

All three tools — bookmarklet, Firefox extension, Chrome extension — share the same scanner core. They differ in how the scanner gets injected into the page and how its results are gathered. This doc explains why three implementations exist and how each one is wired.

## The problem they solve

Web accessibility scanners need to walk every interactive element on a page, compute its accessible name, and report which ones don't have one. The naive approach — call `document.querySelectorAll` for interactive elements — fails on modern web apps for two reasons:

1. **Iframes.** Enterprise SaaS routinely embeds sub-products in iframes. A scanner running in the parent document can recurse into a same-origin iframe via `iframe.contentDocument`, but the browser blocks that access for cross-origin iframes. The scanner's `querySelectorAll` simply doesn't see those elements.
2. **Shadow DOM.** Custom elements / web components hide their internals inside a shadow root. `querySelectorAll` skips over them unless the scanner explicitly walks into each `el.shadowRoot`.

The bookmarklet handles shadow DOM and same-origin iframes by recursive walking. It can't handle cross-origin iframes because no page-context script can — that's a hard browser security boundary.

The extensions handle cross-origin iframes by using a privilege the bookmarklet doesn't have: `scripting.executeScript` with `allFrames: true`. The browser injects the scanner into every frame the tab loads, regardless of origin, because the user granted host permissions when installing the extension. Each frame independently scans its own DOM and reports back.

## Shared scanner core

The same scanner logic lives in three places:

- `bookmarklet/src/accesslens.js` (also embedded in `bookmarklet/accesslens.html`)
- `firefox-extension/background.js` (as the `scanFrame` function passed to `scripting.executeScript`)
- `chrome-extension/background.js` (byte-identical copy of the Firefox `background.js`)

The scanner does three things:

1. **Walk the DOM.** Starting from `document`, it calls `querySelectorAll` with a selector covering all standard interactive elements plus elements with interactive ARIA roles. It also walks any `el.shadowRoot` it finds, recursively.
2. **Compute the accessible name** of each candidate element (see [ACCESSIBLE_NAME_COMPUTATION.md](./ACCESSIBLE_NAME_COMPUTATION.md)).
3. **Return the results** along with each element's bounding rect, role, and selector. In the bookmarklet, results are rendered immediately in the same frame. In the extensions, results are returned to the background script as serializable data, then forwarded to the top frame for unified rendering.

## Bookmarklet topology

```
[ User clicks bookmark in browser ]
            │
            ▼
[ JavaScript URL evaluated in page context ]
            │
            ▼
[ scanner.walk(document) ]  ←─ recurses into same-origin iframes via iframe.contentDocument
            │                  recurses into open shadow roots via el.shadowRoot
            ▼
[ panel + badges rendered in same document ]
```

Limit: same-origin policy stops the recursion at cross-origin iframe boundaries. The bookmarklet reports how many were skipped.

## Extension topology

```
[ User clicks toolbar button → popup opens → picks a check ]
            │
            ▼
[ background.js: handleClick ]
            │
            ├──────────────────────────────────────────────┐
            │                                              │
            ▼                                              ▼
[ scripting.executeScript                       (if panel already up:
   { allFrames: true,                             skip scan, just call
     func: scanFrame } ]                          cleanup in top frame)
            │
            ▼
[ scanFrame runs in EACH frame independently ]
   ├─ top frame
   ├─ same-origin child frame
   ├─ cross-origin child frame   ←── this is the win:
   └─ ...                            extension content scripts
                                     are allowed in every frame
            │
            ▼
[ aggregated results: Array<{frameId, url, isTop, results, ...}> ]
            │
            ▼
[ scripting.executeScript
   { frameIds: [0], func: displayResults, args: [aggregated] } ]
            │
            ▼
[ displayResults runs in TOP frame:
    - maps each non-top frame's URL to the iframe element in the top doc
    - computes each iframe element's getBoundingClientRect()
    - draws badges positioned as (iframeRect + elementRect)
    - renders one unified panel with all results ]
```

The badge positioning trick: the top frame doesn't have access to cross-origin iframe content, but it *does* know where each `<iframe>` element sits in its own viewport. So even when the scanner ran inside an inaccessible-from-the-outside frame, the top frame can absolute-position a badge in its own document at the right pixel coordinates by adding the iframe's bounding rect to the element's reported rect.

## Why both extensions instead of one cross-browser build

Firefox MV3 and Chrome MV3 are nearly identical but differ in two places relevant here:

| | Firefox MV3 | Chrome MV3 |
|---|---|---|
| Background | Event page with `scripts: [...]` | Service worker with `service_worker: "..."` |
| Action icon | SVG or PNG | PNG only |
| Manifest extras | `browser_specific_settings.gecko` required for stable IDs | Ignores `browser_specific_settings` |

The `background.js` file itself is byte-identical between the two — it uses `typeof browser !== "undefined" ? browser : chrome` so the same code talks to both browsers' extension APIs. Only the manifest and icon format differ. Splitting into two folders is the simplest way to keep both shippable without a build step.

A future consolidation could share a single source folder and synthesize each browser's `manifest.json` + icons at build time. Not done yet because the duplication is small and the project values having zero build dependencies.

## Toggle behaviour

All three tools support click-to-show, click-again-to-clear:

- **Bookmarklet**: the IIFE checks for `window.__a11yn_cleanup`. If it exists, it calls cleanup and returns; otherwise it scans and installs the cleanup hook on `window`.
- **Extensions**: the background script first probes the top frame for `window.__a11yn_ext_cleanup`. If present, it sends a cleanup message and skips the scan entirely (avoiding the cost of a full-page rescan just to tear down the UI). If absent, it does the full scan-and-display flow.

## Files at a glance

```
AccessLens/
├── LICENSE                            GPL-3.0
├── README.md                          Project overview
├── CHANGELOG.md
├── CONTRIBUTING.md
├── docs/
│   ├── ARCHITECTURE.md                (this file)
│   └── ACCESSIBLE_NAME_COMPUTATION.md What the algorithm computes
├── bookmarklet/
│   ├── accesslens.html                Drag-to-install page with the bookmarklet embedded
│   └── src/
│       └── accesslens.js              Readable source (also embedded in the HTML)
├── firefox-extension/
│   ├── manifest.json                  MV3 with background.scripts (event page)
│   ├── background.js                  Toolbar handler + scanFrame + displayResults
│   └── icons/
│       ├── icon-48.svg
│       └── icon-128.svg
└── chrome-extension/
    ├── manifest.json                  MV3 with background.service_worker
    ├── background.js                  Byte-identical to firefox-extension/background.js
    └── icons/
        ├── icon-16.png
        ├── icon-32.png
        ├── icon-48.png
        └── icon-128.png
```
