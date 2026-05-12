# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-05-12

### Added

- **Headings check.** Reports every `<h1>` … `<h6>` and `[role="heading"]` element with its level, document-order number, text content, and selector. Indented tree view in the panel; coloured "H{level}" chips per row. Hotkey: **Alt+H**. Flags:
  - Empty headings (no text content).
  - Skipped levels (e.g. `<h2>` followed by `<h4>`).
  - Multiple `<h1>` on a single page.
  - `role="heading"` with no `aria-level`.
  - `aria-level` out of the 1–6 range.
  - `aria-level` overriding the native `<hN>` level (shown as informational, not flagged).
- **Popup-driven multi-check architecture.** The toolbar icon now opens a popup listing every check. The popup shows whether an inspection is currently displayed on the page and offers a Close button. Each check still works as a one-keystroke hotkey (Alt+A for names, Alt+H for headings) that skips the popup entirely.
- Extension renamed to **AccessibleName Inspector** to reflect its expansion beyond names. Existing Firefox extension ID (`a11y-names@cnib.ca`) is preserved so updates land in place.

### Changed

- Bumped extension manifests to `1.1.0`.

### Migration notes

- After updating, the toolbar click no longer runs the names check directly — it opens the popup. The previous one-click flow is preserved via the **Alt+A** hotkey, which runs names directly. If you want toolbar-click-to-names, that's a configuration tweak.
- The Firefox extension `commands` section changed; you may need to re-confirm keyboard shortcuts in `about:addons` → Manage Extension Shortcuts.

## [1.0.4] — 2026-05-11

### Fixed

- **Placeholder-only inputs now display as a problem in the panel**, matching how they're already counted in the summary. Previously a form input whose only "name" was its `placeholder` attribute was counted as missing in the header tally but rendered in the panel with the normal blue "name" styling, so the count and the visible list disagreed (e.g. "3 missing" but only 2 entries looked red). Placeholder-only entries now render with the red "miss" styling and the prefix "⚠ Placeholder only: …" so the count and the list are consistent.

### Changed

- The summary line now splits the problem count into the two distinct categories: "N missing an accessible name, M with placeholder only (not a spec accname)". This lets the auditor prioritise truly-unnamed elements over placeholder-only ones.
- Markdown table output uses **Placeholder only:** as a bold prefix for placeholder-only entries (was just `⚠ name`).
- Bumped extension manifests to `1.0.4`.

## [1.0.3] — 2026-05-11

### Fixed

- **`@font-face` hijacking leaked into the inspector UI** despite Shadow DOM isolation. v1.0.1's Shadow DOM correctly blocked selector inheritance, but `@font-face` rules in the host document are global — they remap font *names* across the whole document, including shadow trees. A page that declares `@font-face { font-family: -apple-system; src: url(lobster.woff); }` makes every `-apple-system` lookup resolve to Lobster, even inside our shadow root. The UI now uses only **CSS generic font-family keywords** (`ui-sans-serif`, `system-ui`, `sans-serif`, `ui-monospace`, `monospace`), which are language tokens rather than font names and cannot be redefined by `@font-face`. The host element's font is also locked via inline `style` with `!important`, and key font properties inside the shadow are marked `!important`.

### Changed

- Bumped extension manifests to `1.0.3`.

## [1.0.2] — 2026-05-11

### Fixed

- **Selectors in the panel and Markdown are now unique CSS paths.** Previously the "Selector" column was a short label like `button.btn-primary` — readable but ambiguous when a page had many same-class siblings, making the value useless for pasting into DevTools. The selector now walks up the DOM with `:nth-of-type` disambiguation and short-circuits on the nearest unique-`id` ancestor, producing pastable selectors like `#main > nav > ul:nth-of-type(2) > li:nth-of-type(3) > a`.
- **In the extensions, this also fixes the wrong-element-outlined bug**: `displayResults` uses the selector with `doc.querySelector` to re-find the element for outlining and click-to-scroll. With the old ambiguous selector, the outline could land on the first same-tag-same-class element rather than the actual one. The new selectors are unique within their document so `querySelector` resolves correctly.

### Changed

- Bumped extension manifests to `1.0.2`.

## [1.0.1] — 2026-05-11

### Fixed

- **UI isolation from site styles.** The panel and badges previously inherited the site's `font-family` and other inheritable CSS properties, which caused the inspector UI to render in the site's font (e.g. Lobster on a creative-script site). The UI is now wrapped in a closed Shadow DOM with `:host { all: initial }` and an explicit `font-family` reset on every element inside, so site CSS can no longer reach the inspector.
- **Outlines on inspected elements** are now set with `!important` so pages that include `* { outline: none !important; }` resets can't suppress them. Cleanup uses `style.removeProperty` to restore the page's original state.

### Changed

- **Minimum text size of 16px** for every piece of UI text (panel header, list, badges, buttons, source notes). Previously a mix of 11–13px; the inspector's own UI should meet the same readability bar we're testing pages against.
- Bumped extension manifests to `1.0.1`.

### Added

- Added GitHub community-health files: bug-report and feature-request issue templates, PR template, Code of Conduct under `.github/`.

## [1.0.0] — 2026-05-11

Initial release.

### Added

- Bookmarklet (`bookmarklet/a11y-names.html`) — drag-to-install, fully self-contained, no network calls. Walks the top document and same-origin iframes plus open shadow roots.
- Firefox WebExtension (`firefox-extension/`) — MV3, uses `scripting.executeScript` with `allFrames: true` to run the scanner in every frame regardless of origin. Aggregates results in a single panel rendered in the top frame.
- Chrome / Edge / Brave WebExtension (`chrome-extension/`) — MV3 service worker variant. Byte-identical `background.js` to the Firefox version.
- Implements the common path of the W3C Accessible Name and Description Computation 1.2.
- Selector covers `a[href]`, `button`, `input` (non-hidden), `select`, `textarea`, `summary`, `details`, `[tabindex]` ≥ 0, `[contenteditable]`, `[onclick]`, and elements with interactive ARIA roles.
- Output: on-page badges, floating panel, console `console.table`, and Markdown table on clipboard for pasting into notebooks or bug reports.
