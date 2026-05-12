# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-05-12

### Added

- **Headings and Landmarks now show complete inventories** (like the user's existing bookmarklets). Headings includes hidden ones (`display:none`, `visibility:hidden`, `aria-hidden="true"`, `opacity:0`) with a "HIDDEN · reason" tag, and visually-hidden sr-only headings with an "sr-only" tag — hidden headings don't get page badges and don't trigger multi-h1 / skipped-level issues (those affect visible navigation), but they're in the list so auditors can spot stale or AT-only headings. Landmarks now lists non-qualifying candidates (e.g. `<header>` inside `<article>`, `<section>` without a name) in the main panel with a "not landmark" chip and the reason — previously these were hidden in a collapsible section. Both panels gain a filter bar (All / Visible / Hidden / Issues for headings; All / Landmarks / Non-landmarks / Issues for landmarks).
- **Headings check.** Reports every `<h1>` … `<h6>` and `[role="heading"]` element with its level, document-order number, text content, and selector. Indented tree view in the panel; coloured "H{level}" chips per row. Flags:
  - Empty headings (no text content).
  - Skipped levels (e.g. `<h2>` followed by `<h4>`).
  - Multiple `<h1>` on a single page.
  - `role="heading"` with no `aria-level`.
  - `aria-level` out of the 1–6 range.
  - `aria-level` overriding the native `<hN>` level (shown as informational, not flagged).
- **Landmarks check.** Reports page-region landmarks (banner, navigation, main, complementary, contentinfo, region, search, form) from both HTML5 sectioning elements and explicit `role="…"` attributes. Applies the correct nesting rules: `<header>`/`<footer>` only count as banner/contentinfo when not nested inside `<article>`/`<aside>`/`<main>`/`<nav>`/`<section>`; `<section>`/`<form>` only become landmarks when they have an accessible name (via `aria-labelledby` or `aria-label`). Per-role chip colours in the panel. Flags:
  - Multiple `<main>` landmarks on a single page.
  - `role="region"` without an accessible name.
  - Multiple landmarks of the same role with no accessible name, or sharing the same name (AT can't tell them apart).
  - Candidates that didn't qualify as landmarks (e.g. `<section>` without a name) are listed under a collapsible "Non-landmark candidates" section so they're not silently invisible.
- **Issue messages now reference every involved element.** When a single issue spans multiple elements (multiple `<h1>`, multiple unnamed same-role landmarks, skipped heading level pointing back to an earlier heading), each row now lists the related element indices inline. The panel uses compact form — `multiple h1 on page (also: #5, #8)` — and the Markdown table expands to include selectors — `multiple h1 on page (also: #5 \`#main > h1\`, #8 \`#sidebar > h1\`)` — so audit notes are self-contained.
- **Images check.** Reports every image-like element on the page: `<img>`, `<input type="image">`, `<area>`, `[role="img"]`, and `<svg>` with explicit `role="img"` or `aria-label`/`aria-labelledby`. Each image is classified into one of four statuses with chip colours:
  - **labeled** — has an accessible name from `aria-labelledby`, `aria-label`, `alt`, `<title>` child (for `<svg>`), or `title` attribute
  - **decorative** — `alt=""`, `role="presentation"`/`"none"`, or `aria-hidden="true"` (intentionally hidden from AT)
  - **MISSING** — no alt attribute and no aria-* labeling (screen readers may announce the src URL)
  - **suspicious** — alt is present but the text looks wrong: filename pattern (`.jpg`, `IMG_1234`), generic single word ("image", "photo", "logo"), or redundant prefix ("image of …")
  - Panel shows each image's raw `alt` attribute alongside its computed accessible name and a truncated `src`/`href`, so auditors can verify whether the alt actually describes what the image conveys.
- **Title & Language check.** Combines three WCAG criteria into one page-level inspector:
  - **WCAG 2.4.2 (Page Titled).** `<title>` presence, non-empty, not generic ("Untitled", "Document", "New Page"), not matching the URL/hostname, exactly one `<title>` in `<head>`.
  - **WCAG 3.1.1 (Language of Page).** `<html lang>` presence + BCP 47 structural validation + RFC 5646 case canonicalization (language lowercase, script TitleCase, region UPPERCASE, variants lowercase) + value lookup against ISO 639 (curated 200+ language subtags), ISO 3166-1 alpha-2 (full registered region set), UN M.49 numeric regions, and ISO 15924 scripts. Region validation matters because the region subtag drives screen-reader dialect/voice selection — an unregistered region means the user gets the wrong pronunciation model.
  - **`<html xml:lang>`** validated identically; mismatch between `<html lang>` and `<html xml:lang>` flagged as an error (RFC 5646 says they must be equivalent).
  - **Every other `lang` and `xml:lang` attribute on the page** — full inventory, not just problematic ones. Same validation rules. Cross-check on same element: `lang="en"` with `xml:lang="fr"` flagged.
  - **`hreflang` on links** validated as BCP 47.
  - **WCAG 3.1.2 (Language of Parts) — heuristic.** `<a href>` URLs whose path or query string suggests a different language than the page (`/fr/page.html`, `?lang=de`) and which lack a matching `hreflang` are flagged for manual review.
  - **Embedded-language smell.** Text attributes (`alt`, `aria-label`, `title`, `aria-roledescription`, `aria-description`, `placeholder`) that contain a literal `lang=` substring or HTML markup — flagged because attribute values are plain text and any embedded markup is ignored by assistive tech.
  - Panel filter bar: All / Issues / Title / Page lang / Lang attrs / hreflang / Foreign URLs / Embedded.
- **Colour Contrast check.** Tests text colour against background per WCAG 1.4.3 AA (4.5:1 normal text, 3:1 large text) and also reports AAA status (7:1 / 4.5:1). Mirrors the rule set from CNIB-AccessLabs/auto_a11y. Per-element status:
  - **pass** — meets WCAG AA, no caveats
  - **pass-warn** — meets the calculated ratio but one or more caveats apply (gradient bg, image bg, animation, overflow) — manual review recommended
  - **fail-aa** — contrast inside container fails AA
  - **partial-fail** — fails inside AND text overflows the container, so the overflowing portion can't be tested
  - **cannot-calculate** — gradient/image/transparent/z-index stacking makes automated calculation unreliable; flagged for manual review
  - Background resolution walks up the DOM compositing semi-transparent layers via Porter-Duff source-over. Stops at the first opaque ancestor, at a z-index stacking context, or at root (defaulting to white).
  - Skipped: visually-hidden (sr-only) text, `display:none` / `visibility:hidden` / `opacity:0` descendants, empty/whitespace-only text nodes, elements where text colour equals background (data error).
  - Large text detection: ≥24px normal OR ≥18.66px bold (font-weight ≥ 700).
  - Filter bar in panel: All / Fail / Warn / Cannot-calc / Pass.
  - **Known limitations vs auto_a11y**, surfaced inside the panel: tested only at the user's current viewport (auto_a11y resizes to every CSS-declared media-query breakpoint); pseudoclass states (`:hover`, `:focus`, `:visited`, `:active`, `:link`) are not separately evaluated; `prefers-contrast` media queries not handled.
- **ARIA Validation check.** Lists every element on the page that uses `role` or any `aria-*` attribute, with a status chip (ok / redundant / issues) plus the element's complete ARIA attribute inventory. The panel header has a filter bar — All / Issues / Redundant — so you can either survey the developer's overall approach (is ARIA being used too much, too little, or duplicated?) or focus only on actionable bugs. Each ARIA-using element also gets a coloured outline on the page (red for issues, amber for redundant-only, light gray dotted for valid usage) so the page itself shows the ARIA footprint. Issue categories:
  - **unknown-role** — role value not in ARIA 1.2's concrete role list, with Levenshtein-based "did you mean" suggestion
  - **abstract-role** — role is one of ARIA's abstract roles (e.g. `widget`, `composite`), which must not be used by authors
  - **unknown-attr** — `aria-*` attribute name not in ARIA 1.2's list, with suggestion
  - **bad-bool** / **bad-tristate** — boolean or tristate attribute got an invalid value (e.g. `aria-expanded="yes"`)
  - **bad-idref** — ID-reference attribute (`aria-labelledby`, `aria-describedby`, `aria-controls`, `aria-owns`, `aria-activedescendant`, `aria-errormessage`, `aria-details`, `aria-flowto`) references one or more IDs that don't exist in the document
  - **missing-required** — role declares a required `aria-*` attribute that isn't present AND the attribute has no sensible default. Fires for `role="heading"` (needs `aria-level` — defaults to `2`, but if the developer reached for `role="heading"` they almost certainly meant a specific level), `role="scrollbar"` (needs `aria-controls` and `aria-valuenow`), `role="slider"` (needs `aria-valuenow`), and `role="meter"` (needs `aria-valuenow`). Roles whose required attributes have sensible defaults — `checkbox` / `radio` / `switch` (`aria-checked` defaults to `false`) and `combobox` (`aria-expanded` defaults to `false`) — are deliberately NOT flagged.
  - **redundant-role** — explicit `role` attribute duplicates the element's native implicit role (e.g. `<nav role="navigation">`, `<button role="button">`, `<h2 role="heading">`). Not a bug, but a smell: tells you about the developer's understanding of native semantics.
  - **presentation-conflict** — `role="presentation"`/`"none"` on a focusable element conflicts with its native interactive role
- **Link Text check.** Reports every `<a href>` and `[role="link"]` element with its accessible name, classified per WCAG 2.4.4 / 2.4.9. Statuses:
  - **ok** — descriptive, unique to its destination
  - **EMPTY** — no accessible name at all
  - **generic** — name is one of a list of well-known generic phrases ("click here", "more", "read more", "learn more", "view all", and ~25 others)
  - **url-as-text** — visible text is the URL itself (AT reads it character by character)
  - **ambiguous** — same text → different `href` (cross-link cluster, references via `(also: #3, #7)`)
  - **inconsistent** — same `href` → different text (cross-link cluster)
  - Cross-link clusters surface in the `related` field on each issue so the panel and Markdown both show every member of the cluster, not just the current row.
- **Popup-driven multi-check architecture.** The toolbar icon opens a popup listing every available check. The popup shows whether an inspection is currently displayed on the page and offers a Close button. No keyboard shortcuts are bound by default — Chrome enforces a four-shortcut limit on extension commands and we have more than that, so all activation goes through the toolbar popup.
- **Draggable inspector panel.** Grab the panel's title bar to move it anywhere on screen — useful when the default top-right position covers the element you're inspecting. Uses pointer capture so the drag survives crossing iframes and other elements that would otherwise swallow mouse events. Buttons inside the title bar (Close, Copy MD) still receive clicks normally. The bookmarklet panel is also draggable.
- Extension renamed to **AccessibleName Inspector** to reflect its expansion beyond names. Existing Firefox extension ID (`a11y-names@cnib.ca`) is preserved so updates land in place.

### Changed

- Bumped extension manifests to `1.1.0`.

### Migration notes

- After updating, the toolbar click no longer runs the names check directly — it opens the popup, where every check (including names) is one click away.

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
