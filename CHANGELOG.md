# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-05-12

### CSV export + "Run all" master panel

- **Copy CSV** button added to every per-check panel alongside the existing Copy MD button. The CSV is auto-derived from the panel's pipe-separated MD table at click time — same data, different format.
- **Run all 21 checks & export** button added at the top of the popup. Runs every check sequentially across all frames, then opens a master panel summarising every check's findings.
- **Master panel:** collapsible per-check sections (auto-open for checks with issues, collapsed for clean ones), inline issue list per section, "Open this check on its own" button to drill into any one check.
- **Combined Markdown export** — single `# CNIB AccessLens — All Checks` document with one `## Check Name` section per check, each containing a count summary plus an issues table.
- **Combined CSV export** — flat 6-column spreadsheet: `Check, #, Issue type, Description, Selector, Frame`. Designed for triage; load it in Excel/Numbers/Sheets and sort/filter to plan remediation. Page-level issues (e.g. `ErrNoReducedMotionSupport`, `no-skip-link`) are included as rows with `(page-level)` in the Selector column.
- **Download MD / Download CSV** — both formats save to the user's Downloads folder. Filenames: `accesslens-{hostname}-{YYYY-MM-DD-HHMM}.{md|csv}`.
- **Sender-routed "Open this check"** — the master panel's per-section button posts `run_from_panel` to the background script. The background derives the tab from `sender.tab.id` rather than relying on the page to know its own tab ID.

### Rebrand — AccessibleName Inspector → CNIB AccessLens

The project started as a single-purpose accessible-name inspector and has grown into a 21-check browser extension covering most of WCAG 2. The original name no longer describes what the tool does, so the project has been rebranded to **CNIB AccessLens** — matching the **CNIB AccessLabs** parent brand styling.

- **New public repository:** `CNIB-AccessLabs/AccessLensPlugins` (replaces `CNIB-AccessLabs/AccessibleName`). This repo is the public, browser-side complement to the main **CNIB AccessLens** accessibility-testing platform (a separate private repository).
- **New Firefox extension ID:** `accesslens@cnib.ca` (replaces `a11y-names@cnib.ca`). This is a clean break — anyone running the previous extension will need to uninstall and re-install. The upgrade path is not preserved.
- **New bookmarklet filename:** `bookmarklet/accesslens.html` (replaces `a11y-names.html`).
- **New toolbar icon:** the yellow phone-circle from the CNIB AccessLabs lockup.
- **Popup header:** now shows the phone-circle icon next to the "CNIB AccessLens" wordmark.
- **Footer attribution:** "A CNIB Access Labs project · CNIB-AccessLabs/AccessLensPlugins".
- **Manifest description:** updated to "Multi-check accessibility inspector from CNIB Access Labs: accessible names, headings, contrast, focus order, forms, ARIA, and more. Reports across iframes (including cross-origin) and shadow DOM. No network calls."
- **Internal JavaScript identifiers preserved:** the `__a11yn_ext_` global prefix, the `[a11yn]` and `[a11y-names]` console-log prefixes, and the bookmarklet's `_a11y_names_cleanup_` global all remain unchanged. They are invisible to users; renaming them carried risk of subtle breakage with no user-facing benefit.



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
- **Tabindex & Focus Order check.** WCAG 2.4.3 (Focus Order). Lists every focusable element with both its DOM position and its position in the browser's sequential focus navigation order (positive tabindex sorted ascending then DOM order; then `tabindex="0"` and implicit focusables in DOM order; `tabindex="-1"` skipped). Per-row chips show focus position and tabindex value. The panel offers a sort toggle (DOM order vs. focus order) so divergence is visible at a glance. Inventory-first — every focusable appears, with status chips for the ones that need attention. Flags:
  - **positive-tabindex** — value > 0 overrides natural DOM order (anti-pattern).
  - **duplicate-positive** — multiple elements share the same positive tabindex value; order among them is undefined.
  - **non-interactive** — element has tabindex but no native interactive role and no interactive ARIA role; verify keyboard handlers (Enter/Space) are wired up.
  - **interactive-skipped** — natively interactive element has `tabindex="-1"`; deliberately removed from the tab order, worth a second look.
  - **invalid-value** — tabindex attribute is not a parseable integer.
- **Animation check.** WCAG 2.2.2 Pause Stop Hide, 2.3.1 Three Flashes, 2.3.3 Animation from Interactions. Walks every accessible CSSStyleSheet (including stylesheets inside open shadow roots), inventories every rule with an `animation` declaration, matches each animation to its `@keyframes` body (where available), and also inspects the DOM for obsolete intrinsic-motion elements and animated-GIF candidates. Rule IDs follow auto_a11y (CNIB-AccessLabs) conventions for cross-tool portability.
  - **ErrInfiniteAnimation** — `animation-iteration-count: infinite` on an element that doesn't look like a spinner.
  - **WarnInfiniteAnimationLikelySpinner** — same, but the element matches the spinner heuristic (class/id contains `spinner`/`loader`/`loading`/`busy`/`progress`/`throbber`/`preloader`/`spin`/`ring`/`dots`, OR `role="progressbar"`/`"status"`, OR `aria-label` matches `/loading|please wait|spinner/i`, OR rendered as a small square ≤ 100×100 px with width≈height). Downgraded from error to warning because spinners typically hide once content loads and aren't expected to have pause controls.
  - **WarnLongAnimation** — `animation-duration > 5s` (or any comma-separated value > 5s). Also fires for `transition-duration > 5s` (rendered as a "CSS transition" row).
  - **WarnProblematicAnimation** — `@keyframes` body contains a pattern likely to trigger seizures, vestibular issues, or disorientation. Three sub-patterns:
    - `flash-opacity` — opacity oscillates between < 0.3 and > 0.7 within a ≤ 1s animation (WCAG 2.3.1 candidate).
    - `shake-translate` — `transform: translate*` with absolute amplitude ≥ 15 px in a ≤ 1s animation (vestibular trigger).
    - `fast-rotate` — `transform: rotate*` in a ≤ 1s animation.
  - **ErrNoReducedMotionSupport** — page-level. Fires when at least one CSS animation exists on the page but no `@media (prefers-reduced-motion: reduce)` or `(prefers-reduced-motion: no-preference)` rule appears in any stylesheet. Vestibular-disorder users cannot opt out of motion (WCAG 2.3.3 AAA + 2.2.2).
  - **ErrMarqueeElement** / **ErrBlinkElement** — obsolete HTML elements with intrinsic continuous motion.
  - **InfoAnimatedGifCandidate** — `<img>` with `.gif` src. Informational — we can't confirm whether the GIF is actually animated (would require decoding the image data); flagged for manual review.
  - Animations inside an `@media (prefers-reduced-motion)` block are NOT flagged — those are the proper responsive-motion path.
  - Page-level info banner shows whether a reduced-motion media rule was found anywhere.
  - Each animation row includes a collapsible `@keyframes` body so the auditor can see exactly what motion is being defined.
  - Filter bar: All / Issues / Infinite / Long / Problematic / `<marquee>`/`<blink>` / GIFs.
  - **Limitations**: JS-driven animations (setInterval / setTimeout / requestAnimationFrame loops) are invisible to static inspection — auto_a11y uses AI rules for these and we don't try. Carousel/slider detection is intentionally out of scope (too heuristic). GIF animation can't be confirmed without decoding image data.
- **Non-text contrast check.** WCAG 1.4.11 Non-text Contrast and 2.4.7 Focus Visible. Element-level focus-indicator contrast inspector that complements the rule-level Focus visible check. Programmatically focuses each interactive element with `preventScroll: true`, reads the computed focus-state styles (which reflect `:focus`/`:focus-visible` rules via the cascade), measures focus-indicator-vs-background contrast, then blurs. Original active element and scroll position are snapshot at the start and restored at the end so page state is unchanged.
  - **Element categories** (matching auto_a11y / CNIB-AccessLabs rule prefixes): `Input` (`<input>`, `<textarea>`, `<select>`), `Button` (`<button>`, `<input type="button|submit|reset|image">`, `[role="button"]`), `Link` (`<a href>`, `[role="link"]`), `Tabindex` (non-interactive hosts with `tabindex` ≥ 0), `Handler` (non-interactive hosts with inline interaction handlers).
  - **Statuses:**
    - **pass** — focus-indicator contrast ≥ 3:1 against the resolved background.
    - **focus-contrast-fail** — focus-indicator contrast < 3:1. Issue type `Err{Category}FocusContrastFail`.
    - **transparent-outline** — outline-color alpha < 0.5. Issue type `Err{Category}TransparentOutline` (or `WarnInputTransparentFocus` for inputs, matching auto_a11y's naming).
    - **gradient-bg** — element has a CSS gradient background. Issue type `Warn{Category}FocusGradientBackground`.
    - **image-bg** — element has a `background-image: url(...)`. Issue type `Warn{Category}FocusImageBackground`.
    - **parent-gradient-bg** / **parent-image-bg** — element is transparent and an ancestor carries the gradient/image. Issue types `Warn{Category}FocusParent{Gradient,Image}Background`.
    - **z-index-floating** — element (or ancestor) has a z-index with transparent background; floats over unpredictable content. Issue type `Warn{Category}FocusZIndexFloating`.
    - **outline-exceeds-parent** — outline width + offset extends beyond the parent's bounds and the parent has a different background. Issue type `Warn{Category}FocusOutlineExceedsParent` (added alongside the contrast result; doesn't replace it).
    - **no-focus-indicator** — element shows no visible change on focus (outline:none and no box-shadow). Cross-reference the Focus visible check for the source CSS rule.
  - **Background resolution** reuses Porter-Duff source-over compositing: walks up the DOM, composes semi-transparent layers over the next ancestor, stops at the first opaque ancestor, defaults to white at the root. Gradient/image ancestors short-circuit the walk and surface the warning categories above.
  - **Issue type names follow auto_a11y conventions** (`Err*` / `Warn*` + category + descriptor) so findings are portable between tools.
  - Filter bar: All / Issues / Fail / Transparent / Cannot verify / Pass.
  - **Limitations**: programmatic focus may trigger focus event handlers on the page (we snapshot/restore the active element to undo state, but side-effects in handlers can persist); contrast against gradient/image backgrounds genuinely can't be auto-verified; the rule prefix convention drops the `aria-disabled`/`disabled` cases (per 1.4.11, inactive components are exempt). Browser-default focus rings on form controls without authored `:focus` styling are tested against the browser's default outline-color (typically a blue or black indicator depending on platform).
- **Reflow check.** WCAG 1.4.4 Resize Text and 1.4.10 Reflow. Page-level inspection plus per-element rows for the elements that block reflow.
  - **Page-level info banner** at the top of the panel shows the parsed `<meta name="viewport">`, current viewport / page-width dimensions (with "overflows" marker if a horizontal scrollbar is currently visible), and `<html>`/`<body>` computed `overflow`/`overflow-x`/`overflow-y` values.
  - **Page-level issues**: `no-viewport-meta` (no viewport tag at all — mobile uses the desktop viewport), `viewport-user-scalable-no` (blocks pinch-zoom — 1.4.4 violation), `viewport-maximum-scale-limited` (`maximum-scale < 2` caps zoom below 200%), `multiple-viewport-meta` (more than one viewport tag), `root-overflow-hidden` (`overflow:hidden` on `<html>` or `<body>` — prevents scrolling on zoom), `page-overflows-horizontally` (informational — current viewport already has a horizontal scrollbar).
  - **Per-element issues**:
    - **min-width-too-wide** — element with computed `min-width` > 320 CSS px. Forces horizontal scrolling at the 1.4.10 minimum viewport.
    - **fixed-px-width-no-max** — element with computed `width` > 400 px (and rendered width > 320 px) AND no responsive `max-width` (`max-width: none`/`auto`, or another px value > 320). Percentage / vw / vh max-widths exempt the element. Heuristic — picks up the obvious "I declared `width: 1280px` and forgot `max-width: 100%`" pattern.
    - **px-font-size-small** — element with `font-size` < 12 px and visible text. Informational; small text doesn't survive 200% zoom well.
  - Filter bar: All / Issues / Min-width / Fixed width / Small text.
  - **Limitations in footer**: real 1.4.10 testing requires resize to 320×256; real 1.4.4 testing requires zoom to 200%. The check only surfaces the static signals that commonly indicate failures.
- **Focus visible check.** WCAG 2.4.7 Focus Visible. Walks every accessible `CSSStyleSheet` (including stylesheets inside open shadow roots) and collects every rule whose selector contains `:focus`, `:focus-visible`, or `:focus-within`. Inventory-first — every focus-related rule on the page becomes a panel row. Each row shows the full selector, the rule's declarations as a code block, the source stylesheet URL + rule index, an approximate count of matching elements on the page, and a classification chip:
  - **suppress-only** — rule suppresses `outline` (`outline:0`/`none`/`0px`, or `outline-style:none`/`outline-width:0`) AND has no replacement (no `box-shadow`, no `border` change, no `background` change, no `text-decoration` change, no `transform`/`filter`/`opacity`/`color`/`text-shadow` change, and no replacement outline). WCAG 2.4.7 violation if it matches any keyboard-focusable element.
  - **suppress-with-replacement** — suppresses `outline` but provides a substitute style. Flagged as "manual review needed" because we can't measure whether the substitute meets the contrast requirement (WCAG 1.4.11 / 2.4.11) without actually focusing the element.
  - **replacement-only** — doesn't touch outline, just adds a focus style on top of the default UA outline. Generally safe.
  - **no-style-change** — `:focus` rule with no visible-property change (cursor, z-index, etc.). Informational.
  - **Page-level flags**: `universal-outline-suppressor` fires for bare `* { outline: 0 }`, `html * { outline: none }`, etc. — non-`:focus` rules with broad selectors that nuke default focus indicators across the whole page (the worst pattern). `cross-origin-stylesheets-untestable` reports the count of stylesheets the scanner couldn't read due to CORS, with a yellow informational banner.
  - Click a row to scroll/highlight the first element on the page the selector would match (when one exists).
  - Filter bar: All / Issues / Suppress-only / Suppress+repl / Replacement-only.
  - **Limitations in footer**: contrast of replacement indicators not measured; cross-origin stylesheets skipped; inline `style="..."` attributes not inspected; `:focus-visible` vs `:focus` is reported per rule but no judgment made.
- **Media check.** WCAG 1.2.1 Audio-only/Video-only, 1.2.2 Captions (Prerecorded), 1.2.3/1.2.5 Audio Description / Media Alternative, 1.4.2 Audio Control, 2.2.2 Pause Stop Hide. Inventories every `<video>`, `<audio>`, and every `<iframe>` whose `src` host matches a known media-provider pattern: YouTube (`youtube.com`/`youtube-nocookie.com` `/embed/`), Vimeo (`player.vimeo.com`), Wistia (`*.wistia.com`/`.net`), Dailymotion (`/embed/`), Twitch (`player.twitch.tv`, `clips.twitch.tv`), Loom (`/embed/`), Vidyard (`play.vidyard.com`), SoundCloud (`w.soundcloud.com`), Spotify (`open.spotify.com/embed`).
  - Each row shows kind chip (`<video>` / `<audio>` / provider name), attribute chips (`autoplay`, `loop`, `muted`, `no controls`, `HIDDEN`), accessible name, dimensions, `<track>` inventory with srclang and default flag, transcript-search result (green ✓ if a transcript-looking link or heading was found within 3 ancestor levels, red ✗ otherwise), src, and selector.
  - **no-controls** — `<video>` / `<audio>` without `controls` attribute. Custom JS controls are invisible to static inspection.
  - **autoplay** — `autoplay` attribute set (or `?autoplay=1`/`?autoPlay=true` etc. in a provider iframe URL). WCAG 1.4.2 / 2.2.2.
  - **autoplay-with-loop** — both `autoplay` and `loop`. Plays forever; clear 2.2.2 violation.
  - **autoplay-muted-no-controls** — muted autoplay video without controls. Browsers allow muted autoplay but the user still needs a pause/hide mechanism.
  - **video-no-captions** — `<video>` with no `<track kind="captions">` and no `<track kind="subtitles">` child.
  - **captions-default-off** — caption/subtitle tracks exist but none has the `default` attribute. The user has to dig for them.
  - **video-no-poster** — `<video>` with no `poster` attribute (informational; not a hard WCAG issue).
  - **video-no-transcript** / **audio-no-transcript** — no transcript-looking link or heading found within 3 ancestor levels. Transcript heuristic searches for `<a>` text/href and `<h1>–<h6>` text matching `/transcript|text alternative|caption file|subtitle file|read transcript|view transcript/i`.
  - **embed-autoplay-in-url** — provider iframe URL has an autoplay parameter (covers `autoplay`, `autoPlay`, `auto-play`, `auto_play` with values `1`/`true`/`y`/`on`).
  - **embed-no-title** — media provider iframe with no `title`/`aria-label`/`aria-labelledby` (also flagged in the Iframes check; surfaced here too for media context).
  - Filter bar: All / Issues / Video / Audio / Embeds / Autoplay.
  - **Limitations in panel footer**: custom JS-driven controls/captions are invisible; we can't verify caption or transcript accuracy, only existence; media duration is unknown so WCAG 1.4.2's "under 3 seconds" exception isn't applied; live captions can't be evaluated.
- **Skip links check.** WCAG 2.4.1 Bypass Blocks. Walks the first 10 focusable elements in DOM order and inspects each. A row is rendered for every one of those — inventory-first, so even on a page with no skip link the auditor can see what's at the top of the tab order.
  - **Skip-link candidate detection** — any `<a href="#id">` (or same-document anchor where the path matches) whose text matches `/skip|jump|to main|to content|main content|to nav|to search|bypass/i` OR whose target resolves to `<main>`, `<h1>`, `[role="main"]`, `role="heading" aria-level="1"`, or any landmark (banner / navigation / main / complementary / contentinfo / region / search / form). Either signal is sufficient — text-matching catches the "Skip to main" pattern, target-is-landmark catches link clusters like "→ Main / → Navigation / → Search" that don't use the word "skip".
  - **Per-candidate status**: `ok` (target exists and is a main-content anchor), `target-missing` (`#id` doesn't resolve), `target-not-landmark` (target is some random div), `target-not-focusable` (target is non-interactive without `tabindex="-1"` — focus won't actually move there after activation).
  - **Page-level banner** at the top: green when a skip-link candidate is the first focusable element, red otherwise. Two page issues are surfaced: `no-skip-link` (no candidate in the first 10 focusable) and `skip-link-not-first` (a candidate exists but other focusable elements precede it).
  - Each row shows: focus order position, status chip, element + role + href, accessible name, target details (`<main>` / role / first 60 chars of target text), and unique selector.
  - Filter bar: All / Issues / Skip-link candidates / First-focusable / Target not landmark.
  - **Limitation noted in footer**: can't actually focus the link to test if "visually-hidden-until-focus" styling makes it visible — only the link's current rendered state is observed. Positive tabindex values are not specially handled (they're an anti-pattern flagged in the Tabindex check).
- **Target size check.** WCAG 2.5.8 Target Size (Minimum, AA · 24×24 CSS px) and 2.5.5 Target Size (Enhanced, AAA · 44×44 CSS px). Measures every interactive element's bounding rect and classifies into one of five statuses:
  - **pass** — at least 24×24 AND at least 44×44 (no issue at either level).
  - **fail-aaa-only** — at least 24×24 but smaller than 44×44, and the 44-px spacing exception fails (another target is within 22 px of this target's centre). Issue at AAA only.
  - **fail-aa-spacing-ok** — smaller than 24×24 but the 24-px spacing exception applies (no other target inside the 12-px-radius circle). Informational; not an issue.
  - **fail-aa** — smaller than 24×24 AND the spacing exception fails (another target is within 12 px). Hard issue.
  - **inline-link** — `<a href>` inside flow text, exempt per the inline exception.
  - Spacing test follows the WCAG technique: a circle of the required diameter centred on the target's bounding box must not intersect any other target's bounding box. Implemented as `distance-from-centre-to-nearest-point-of-other-target ≥ radius` over all other interactive elements on the page.
  - **Excluded per spec**: hidden elements, `disabled`/`aria-disabled` elements, and 0×0 targets (these don't need to meet the criterion).
  - **Caveats in panel footer**: measurement uses current rendered size (responsive pages may differ); rotation/transforms use the bounding rect (may overestimate the actual hit area); "equivalent control" and "user-agent" spec exceptions are not detected (these need semantic understanding).
  - Filter bar: All / Issues / Fail AA / Fail AAA only / Inline / Pass. Outline colour matches status (red for AA fail, amber for AAA only, purple for inline, green otherwise).
- **Lists check.** WCAG 1.3.1 Info and Relationships. One row per `<ul>`, `<ol>`, `<menu>`, `<dl>`, and `[role="list"]` container, plus rows for orphan `<li>`/`<dt>`/`<dd>`/`[role="listitem"]` (items that aren't inside an appropriate list container). Each row shows the element + role chip, a "list-style: none" indicator when present, item count, the first item's text as a sample, and unique selector.
  - **non-li-children** — `<ul>`/`<ol>`/`<menu>` with direct children that aren't `<li>` (other than `<script>`/`<template>`).
  - **orphan-li** — `<li>` outside any `<ul>`/`<ol>`/`<menu>` or `[role="list"]` ancestor.
  - **empty-list** — `<ul>`/`<ol>`/`<dl>`/`[role="list"]` with no list items.
  - **empty-list-item** — `<li>`/`<dt>`/`<dd>` with no text and no children.
  - **list-style-none-no-role** — `<ul>`/`<ol>` with computed `list-style: none` and no explicit `role="list"`. Safari/VoiceOver strips list semantics when bullets are removed via CSS; this is the standard workaround prompt.
  - **role-presentation-on-list** — `role="presentation"`/`"none"` on a natural list element. Intentionally strips list semantics; flagged so the auditor confirms intent.
  - **role-list-without-listitem-children** — `[role="list"]` on a non-`<ul>`/`<ol>` host with direct children that don't have `role="listitem"`.
  - **role-listitem-orphan** — `[role="listitem"]` outside any `role="list"` or natural list ancestor.
  - **dl-bad-children** — `<dl>` with direct children other than `<dt>`, `<dd>`, `<div>` (HTML5 group wrapper), `<script>`, `<template>`.
  - **dl-dt-no-dd** — `<dt>` group has no `<dd>` before the next `<dt>` or end.
  - **dl-dd-no-dt** — `<dd>` with no preceding `<dt>` in its group.
  - Filter bar: All / Issues / `<ul>`/`<ol>` / `<dl>` / ARIA lists / Single-item (lists with exactly one item — not invalid, available as a filter for the misuse-as-styling smell).
- **Buttons & interactive check.** WCAG 2.1.1 Keyboard, 4.1.2 Name/Role/Value, 3.3.1/3.3.2. Inventories every native `<button>`, every `<input type="button|submit|reset|image">`, every `<a>`, every element with an interactive ARIA role (`button`, `link`, `menuitem`, `tab`, `option`, `checkbox`, `radio`, `switch`, `treeitem`, …), and every non-interactive element carrying inline interaction handlers (`onclick`/`onmousedown`/`onmouseup`/`onpointerdown`/`onpointerup`) or button-toggle ARIA state attributes (`aria-pressed`/`aria-expanded`/`aria-haspopup`). Each row shows element + type chip, role, accessible name, href/handler source, tabindex, dimensions, disabled state, and unique selector.
  - **button-no-type-in-form** — `<button>` inside `<form>` without explicit `type=`. Defaults to `submit`, which causes accidental submission on Enter.
  - **button-type-reset** — `<button type="reset">` / `<input type="reset">`. Reset buttons routinely surprise users by clearing already-typed data without warning.
  - **link-as-button** — `<a href="#">` or `<a href="javascript:…">`. Looks like a link to AT and to the URL bar but is acting as a button.
  - **link-no-href** — `<a>` with no `href`. Not focusable, not a link.
  - **link-disabled-attr** — `<a disabled>`. The `disabled` attribute has no effect on `<a>`.
  - **inline-handler-on-link** — `<a href>` with `onclick` containing `preventDefault` or `return false`. The link goes nowhere; should be a button.
  - **div-onclick-no-role** — `<div>`/`<span>` (or any non-interactive element) with an inline click handler attribute and no role and no tabindex. Keyboard-unreachable.
  - **role-without-tabindex** — interactive ARIA role on a non-focusable host without `tabindex`. Element is not keyboard-reachable; add `tabindex="0"`.
  - **role-without-key-handler** — interactive role + inline `onclick` attribute but no inline `onkeydown`/`onkeyup`/`onkeypress`. Heuristic only — handlers wired via `addEventListener` are invisible to static inspection, so this is flagged as "verify keyboard handlers wired."
  - **aria-pressed-without-button-role** — `aria-pressed` on an element whose effective role isn't `button`.
  - **aria-expanded-bad-role** — `aria-expanded` on an element whose role doesn't support it (not in `button`/`link`/`combobox`/`tab`/`menuitem`/`treeitem`/`gridcell`/`row(header)`/`listbox`/`application`/`switch`).
  - **haspopup-without-expanded** — `aria-haspopup` set but no `aria-expanded`. The popup's open/closed state isn't exposed to AT.
  - Filter bar: All / Issues / Buttons / Links / Clickable-div / Toggles.
  - **Limitation note in the panel footer**: event handlers attached via `addEventListener` are not inspectable from script — `role-without-key-handler` and `div-onclick-no-role` flag only the inline-attribute cases.
- **Iframes check.** WCAG 2.4.1 Bypass Blocks and 4.1.2 Name, Role, Value. Inventories every `<iframe>` (and deprecated `<frame>`/`<frameset>`) across the top document and every nested frame the scanner can reach (the content script runs in each frame via `allFrames: true`, so each frame finds its own iframe children and they're stitched together in the panel). Per row: tag, origin chip (SAME-ORIGIN / CROSS-ORIGIN / UNKNOWN), hidden chip when applicable, accessible name with its source (aria-labelledby / aria-label / title), dimensions, tabindex, role, sandbox token chips, truncated `src` (or `srcdoc:` preview), and unique selector. Outline matches issue state on the page.
  - **missing-name** — no `title`, no `aria-label`, no `aria-labelledby` (SR users navigate frames by name; without one there's nothing to announce).
  - **empty-name** — attribute is present but resolves to empty (`title=""`, `aria-label=""`, or `aria-labelledby` pointing at missing/empty IDs). Often worse than no name because some tools register it as labeled.
  - **generic-name** — name is in the generic deny-list (`iframe`, `frame`, `embedded content`, `untitled`, `widget`, `ad`, …) or matches the pattern `frame N` / `iframe N`.
  - **name-matches-src** — name is just the full src URL, the hostname, the origin, or the last path segment of the URL. Often auto-generated by CMSes; not descriptive.
  - **duplicate-name** — two or more iframes share the same non-empty name; surfaced as a cross-iframe cluster with `related` entries so the panel shows every member.
  - **tabindex-negative-on-visible** — visible iframe with `tabindex="-1"` removes the whole embedded document from sequential focus order. Often unintended; a frequent source of "I can't tab into the chat widget" bugs.
  - **positive-tabindex** — `tabindex>0` on an iframe breaks natural DOM order.
  - **aria-hidden-with-content** — `aria-hidden="true"` on a substantial-sized iframe (≥50×50) that has `src` or `srcdoc`. Hiding the iframe from AT without removing interactive content from the tab order creates a focusable-but-hidden zombie.
  - **likely-tracking-not-hidden** — 1×1 / 0×0 / off-screen iframe (left ≤ −1000 or top ≤ −1000) without `aria-hidden="true"` and without a name. Analytics / pixel iframes should be `aria-hidden="true"` so SR doesn't announce them.
  - **role-presentation-on-iframe** — `role="presentation"`/`"none"` on an iframe with `src`/`srcdoc`; the role strips the iframe's frame semantics so SR users lose the frame boundary.
  - **empty-iframe** — `<iframe>` with no `src` and no `srcdoc`.
  - **deprecated-frame** — `<frame>` / `<frameset>` elements (obsolete in HTML5).
  - Filter bar: All / Issues / Same-origin / Cross-origin / Hidden / Deprecated (last only when present).
- **Tables check.** WCAG 1.3.1 Info and Relationships. Inventories every `<table>` and every element with `role="table"` / `role="grid"` on the page. Each table is classified into one of three statuses:
  - **data** — table has at least one of `<th>`, `<caption>`, `summary=`, `aria-label`, `aria-labelledby`, or `role="table"`/`"grid"`.
  - **layout-declared** — `<table>` carries `role="presentation"` or `role="none"`.
  - **ambiguous** — none of the above; almost certainly layout but the developer didn't declare it. Listed informationally for manual review.
  - Each row shows status chip, accessible name, row/column count, `<th>` inventory (`N col, N row, N rowgroup, N colgroup, N unscoped`), `<thead>`/`<tbody>`/`<tfoot>` presence, and full unique selector. Outline colour matches status (green for data, gray for layout, amber for ambiguous, red on the outline if there are issues). Panel filter bar: All / Issues / Data / Layout / Ambiguous.
  - Per-table flags: `data-no-name` (data table lacks caption/aria-label/aria-labelledby), `data-no-headers` (data table has no `<th>`), `caption-not-first-child`, `multiple-captions`, `summary-attribute` (obsolete in HTML5), `presentation-with-data` (`role="presentation"`/`"none"` on a table that also has `<th>`/`<caption>`/etc. — the role strips semantics, leaving the data elements meaningless), `layout-with-data-signals` (no `<th>` but multiple naming signals — mixed intent), `nested-table` (table inside another table — disorients SR table navigation).
  - Per-`<th>` flags: `th-empty` (no text, no aria-label, no aria-labelledby, no image alt), `th-invalid-scope` (not row/col/rowgroup/colgroup), `th-missing-scope-complex` (table has both row and column headers, but this `<th>` has no scope= to disambiguate).
  - Per-cell flags: `spanned-cell-no-headers` (`colspan>1`/`rowspan>1` in a complex table with no explicit `headers=` wiring), `bad-headers-idref` (`headers=` references a missing ID, an ID outside this table, or a non-`<th>` element).
  - Other: `th-without-table` (`<th>` outside any `<table>`), `likely-data-no-th` (no `<th>` but the first row is bold-styled or wraps `<strong>`/`<b>` — heuristic that the developer used visual styling instead of semantic markup).
- **Forms check.** Covers WCAG 1.3.1, 1.3.5, 3.3.1, 3.3.2, 4.1.2. Inventories every form control on the page and groups them by their owning `<form>` element (controls outside any form get their own section). Each control shows its tag/type, accessible name, raw associated label text, required state, autocomplete value, and visible required indicator state. The panel's filter bar — All / Issues / Unlabeled / Required / Invalid wiring / Radio groups / Autocomplete / Wrapping labels / Layout / Native validation — lets auditors focus by category. Per-control flags:
  - **unlabeled** — no accessible name from any of `<label for>`, wrapping `<label>`, `aria-labelledby`, `aria-label`, or `title`.
  - **placeholder-as-label** — only `placeholder` provides a name; placeholders disappear when the user starts typing and have poor SR/voice-control support.
  - **wrapping-label-implicit** — `<label>text<input/></label>` without `for=`. Dragon NaturallySpeaking voice control only reliably reaches inputs through explicit `<label for="id">` association — implicit wrapping breaks "click <name>" commands.
  - **label-in-name-mismatch** — visible label text isn't a substring of the accessible name (WCAG 2.5.3 Label in Name); voice users may say what they see and miss.
  - **multiple-labels** — input has more than one `<label for>` pointing at it; behaviour is inconsistent across AT.
  - **label-not-left-aligned** / **label-side-positioned** / **label-below-input** — label isn't positioned directly above and left-aligned with its input. Magnifier users following a viewport from the input will not find a label to the right, below, or significantly indented from the input's left edge.
  - **multi-control-row** — multiple form controls share a horizontal band on the page. At high magnification the user can't see them at the same time and loses spatial context.
  - **required-no-visible-indicator** — control has `required`/`aria-required="true"` but no `*` or "required" text is visible in or near its label. Sighted users get no warning before submission.
  - **required-indicator-no-attr** — label text contains `*` or "required" but the control has neither `required` nor `aria-required="true"`. The visible promise doesn't match the actual constraint.
  - **required-aria-contradiction** — `aria-required="false"` together with a required attribute (or vice versa).
  - **required-attr-data-may-be-blank** — uses the HTML `required` attribute, which means data must always be present. If the control can legitimately be empty until the user reaches it, `aria-required="true"` is the correct vocabulary; HTML `required` also enables native browser bubble validation, which is inaccessible.
  - **bad-idref** — `aria-labelledby` / `aria-describedby` / `aria-errormessage` references an ID not present in the document.
  - **invalid-no-error-ref** — control has `aria-invalid="true"` but no `aria-errormessage` or `aria-describedby` pointing to the error text.
  - **missing-autocomplete** / **invalid-autocomplete** — personal-data fields (name, email, address parts, phone, dob, cc-*) should declare an HTML autofill token so password managers and AT can identify them. Unknown tokens flagged and a likely token suggested from the field's name/id/label.
  - **aria-disabled-focusable** — `aria-disabled="true"` (without `disabled`) leaves the control in the tab order; screen readers announce it as disabled but it still receives focus and typing.
  - **image-input-no-alt** — `<input type="image">` with no `alt` (Submit button is announced as just "submit query" or worse).
  - **group-no-fieldset** — two or more radios or checkboxes sharing a `name` are not wrapped in `<fieldset><legend>`. Group questions need a group label.
  - **empty-legend** — `<fieldset>` with empty/whitespace `<legend>` or no `<legend>` at all.
  - Per-form flags:
    - **form-no-submit** — form has no submit button (no `<button>` without `type="button"`, no `input[type=submit/image]`); users with motor impairments may rely on the Enter key, but a form without a submit button often has unpredictable submit behaviour.
    - **form-native-validation** — form uses HTML constraint validation (`required`, `pattern`, `type="email"`, `min`/`max`/`minlength`/`maxlength`) without `novalidate`. Browser-native bubble messages float off to the right of the offending field, auto-dismiss on a short timer the user can't control, often fall off-screen at high magnification, and are announced inconsistently across screen readers. Custom inline error text with `aria-describedby`/`aria-errormessage` is the accessible alternative.
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
- Extension renamed to **CNIB AccessLens** to reflect its expansion beyond names. Existing Firefox extension ID (`accesslens@cnib.ca`) is preserved so updates land in place.

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

- Bookmarklet (`bookmarklet/accesslens.html`) — drag-to-install, fully self-contained, no network calls. Walks the top document and same-origin iframes plus open shadow roots.
- Firefox WebExtension (`firefox-extension/`) — MV3, uses `scripting.executeScript` with `allFrames: true` to run the scanner in every frame regardless of origin. Aggregates results in a single panel rendered in the top frame.
- Chrome / Edge / Brave WebExtension (`chrome-extension/`) — MV3 service worker variant. Byte-identical `background.js` to the Firefox version.
- Implements the common path of the W3C Accessible Name and Description Computation 1.2.
- Selector covers `a[href]`, `button`, `input` (non-hidden), `select`, `textarea`, `summary`, `details`, `[tabindex]` ≥ 0, `[contenteditable]`, `[onclick]`, and elements with interactive ARIA roles.
- Output: on-page badges, floating panel, console `console.table`, and Markdown table on clipboard for pasting into notebooks or bug reports.
