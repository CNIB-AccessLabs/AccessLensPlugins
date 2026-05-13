# AccessLens — Chrome / Edge / Brave Extension

Same functionality as the [Firefox extension](../firefox-extension): inspects the computed accessible name of every interactive element across all frames including cross-origin iframes plus open shadow DOM. One panel in the top frame with badges over every element. No network calls.

Works in Chrome, Edge, Brave, Arc, and any other Chromium-based browser supporting Manifest V3.

## Install (developer mode, unpacked)

1. Open Chrome (or Edge / Brave / Arc).
2. Go to `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked**.
5. Select this `chrome-extension` folder.
6. Pin the toolbar icon from the puzzle-piece menu if it isn't visible.

The extension stays installed in developer mode across browser restarts. After editing the source, hit the circular refresh icon on the extension card to pick up changes.

## Use

- Click the toolbar icon on any page; a small popup lets you pick which check to run.
- Each interactive element gets an outline and a badge with its computed accessible name. Top-frame elements use blue; iframe elements use green. Anything missing a name is red.
- The right-side panel lists everything across every frame. Click a row to jump to that element.
- **Copy MD** puts a Markdown table on your clipboard. The same table is in DevTools console alongside a `console.table` view.
- Click the toolbar icon again to clear.

## Permanent install for distribution

For deploying to multiple users at CNIB:

1. **Chrome Web Store (recommended for end-user distribution).** Pack the folder, register on the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole) ($5 one-time fee), upload. Can be published privately to specific domains via Google Workspace, or as an unlisted extension only installable via direct link.
2. **Group policy / managed install.** If CNIB has managed Chrome via Google Workspace or an MDM, the extension can be deployed as a force-installed managed extension. The store version is required for this — the Chrome Web Store is the distribution channel.
3. **Self-hosted enterprise mode.** Pack the folder as a `.crx`, host it on an internal server, and configure Chrome's `ExtensionInstallSources` policy. More moving parts; usually only worth it when the Chrome Web Store isn't an option.

For day-to-day testing, the developer-mode unpacked install above is fine and survives browser restarts.

## How it works

See [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md). The `background.js` is byte-identical to the Firefox version — it uses `typeof browser !== "undefined" ? browser : chrome` so the same code runs in both browsers. Only the manifest and icon format differ from the Firefox build.

For details on how the accessible name itself is computed, see [`../docs/ACCESSIBLE_NAME_COMPUTATION.md`](../docs/ACCESSIBLE_NAME_COMPUTATION.md).

## Differences from the Firefox build

Functionally identical. The only manifest changes:

- `background.service_worker` instead of `background.scripts` — Chrome MV3 requires a service worker; Firefox MV3 accepts an event page with scripts.
- PNG icons at 16/32/48/128 — Chrome rejects SVG for `default_icon`; Firefox accepts both.
- No `browser_specific_settings` block — Firefox-only; Chrome ignores it.

## Caveats

- **Custom controls with no semantics.** If a `<div>` was made interactive purely via `addEventListener('click', …)` with no `role`, `tabindex`, inline `onclick`, or any other semantic marker, neither this extension nor assistive technology can identify it as interactive. That's a page-side accessibility bug — file it.
- **Nested iframes.** Badges position correctly for elements in direct child iframes. For iframes inside iframes, the panel still lists the elements (so you don't miss any controls), but the badge position may be approximate or skipped.

## License

GPL-3.0-or-later. See [`../LICENSE`](../LICENSE).
