# AccessibleName — Firefox WebExtension

Manifest V3 Firefox extension that runs the AccessibleName scanner in every frame the tab loads, including cross-origin iframes. One panel in the top frame aggregates results from every frame with badges positioned correctly over each element.

This is what the [bookmarklet](../bookmarklet) can't do: same-origin policy blocks page-context scripts from looking inside cross-origin iframes. A WebExtension content script is granted host permissions on install, so the browser allows it to run in every frame regardless of origin.

No network calls. No telemetry. Inspector-only — never modifies page state beyond the overlay UI.

## Install (temporary, for testing)

1. Open Firefox.
2. Go to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…**.
4. Select [`manifest.json`](./manifest.json) from this folder.
5. The blue accessibility icon appears in the toolbar. Pin it from the extensions overflow menu if you don't see it.

Temporary add-ons disappear when Firefox closes. See "Permanent install" below.

## Use

- Click the **AccessibleName Inspector** toolbar button on any page; a small popup lets you pick which check to run.
- Each interactive element gets an outline and a badge with its computed accessible name. Top-frame elements use blue; iframe elements use green. Anything missing a name is red.
- The right-side panel lists everything across every frame. Click a row to jump to that element.
- **Copy MD** puts a Markdown table on your clipboard for your notebook. The same table is in DevTools console alongside a `console.table` view.
- Click the toolbar button again to clear.

## Permanent install

Firefox blocks unsigned permanent installs by default. Three paths from least to most effort:

1. **Firefox Developer Edition or Nightly.** In `about:config`, set `xpinstall.signatures.required` to `false`, then drop a packed `.xpi` (just zip the contents of this folder and rename to `.xpi`) into Firefox.
2. **Enterprise Firefox policy.** If your IT has Firefox ESR or managed Firefox, an enterprise policy can allow specific extension IDs to install unsigned. The ID in this manifest is `a11y-names@cnib.ca`. Talk to whoever manages the Firefox config in your environment.
3. **Mozilla AMO signing.** Submit to https://addons.mozilla.org/ as an unlisted add-on — Mozilla signs it and you can self-distribute the signed `.xpi` for permanent install with no `about:config` changes. Free and reasonably fast.

## What it inspects

- All interactive elements per the W3C ARIA spec: `a[href]`, `button`, form controls, `summary`, `details`, anything with `tabindex` ≥ 0, `[contenteditable]`, `[onclick]`, and elements with explicit interactive ARIA roles (button, link, checkbox, radio, switch, tab, menuitem, option, combobox, textbox, searchbox, slider, spinbutton, treeitem).
- Walks open shadow DOM recursively within each frame.
- Skips elements with zero dimensions, `display: none`, `visibility: hidden`, or `aria-hidden="true"`.

For details on how the accessible name itself is computed, see [`../docs/ACCESSIBLE_NAME_COMPUTATION.md`](../docs/ACCESSIBLE_NAME_COMPUTATION.md).

## How it works

See [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md). Short version:

- The user clicks the toolbar button.
- `background.js` uses `scripting.executeScript({ allFrames: true, func: scanFrame })` to inject the scanner into every frame in the tab. Each frame independently walks its DOM and returns serializable results.
- `background.js` aggregates the per-frame results and uses a second `scripting.executeScript` call targeting the top frame to inject `displayResults` with the aggregated data.
- The top frame renders one panel and positions badges over both same-origin and cross-origin frame content by adding each iframe element's `getBoundingClientRect()` to the per-frame element rects.

`background.js` is byte-identical between this extension and the [Chrome extension](../chrome-extension). Only the manifest differs.

## Caveats

- **Custom controls with no semantics.** If a `<div>` was made interactive purely via `addEventListener('click', …)` with no `role`, `tabindex`, inline `onclick`, or any other semantic marker, neither this extension nor assistive technology can identify it as interactive. That's a page-side accessibility bug — file it.
- **Nested iframes.** Badges position correctly for elements in direct child iframes. For iframes inside iframes, the panel still lists the elements (so you don't miss any controls), but the badge position may be approximate or skipped. The summary line reports if any frames weren't matched.

## License

GPL-3.0-or-later. See [`../LICENSE`](../LICENSE).
