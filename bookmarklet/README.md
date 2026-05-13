# AccessLens — Bookmarklet

Drag-to-install bookmarklet for quick accessibility-name inspection on any page. No build step, no dependencies, no network calls. Same scanner core as the [Firefox](../firefox-extension) and [Chrome](../chrome-extension) extensions, but bound by browser same-origin policy — see "Limitations" below.

## Install

Open [`accesslens.html`](./accesslens.html) in your browser and drag the **a11y: names** button to your bookmarks bar. The page reads its embedded `<script id="bookmarklet-source">` block and URL-encodes it into the bookmark's `href` on page load, so the install page and the bookmarklet are always in sync.

## Use

Click the bookmark on any page you want to inspect. Each interactive element gets an outline and a badge with its computed accessible name. A floating panel on the right lists everything with a **Copy MD** button that puts a Markdown table on your clipboard. The same table is also dumped to the DevTools console. Click the bookmark again to clear.

## Limitations

The bookmarklet runs as a page-context script. The browser's same-origin policy prevents it from reading or modifying content inside cross-origin iframes. Modern enterprise SaaS (Dayforce, Workday, ServiceNow, salesforce-embedded modules) commonly embed sub-products in cross-origin iframes; when the bookmarklet encounters one, it reports the count of skipped frames in the panel and console.

For full coverage across all frames including cross-origin, use the extensions:

- [Firefox extension](../firefox-extension)
- [Chrome / Edge / Brave extension](../chrome-extension)

The bookmarklet still has its place — no install, no maintenance, easy to share — so all three ship.

A few sites with very strict Content Security Policy (`script-src 'self'` with no `'unsafe-inline'`) block bookmarklets entirely. If clicking the bookmark does nothing and DevTools shows a CSP violation, you need the extension.

## How it works

[`accesslens.html`](./accesslens.html) contains the readable source inside a `<script id="bookmarklet-source" type="text/template">` block. A small script at the bottom of the HTML:

1. Reads that template's text content.
2. URL-encodes it with `encodeURIComponent`.
3. Prepends `javascript:` and sets the result as the `href` of the install button.

This pattern means there's no separate minify-and-encode step in the build pipeline — there is no build pipeline. Edit the source in the HTML, reload, drag the new bookmark.

[`src/accesslens.js`](./src/accesslens.js) is the same source extracted as a standalone file for syntax highlighting in Git diffs and editor support. It is functionally identical to the embedded copy in the HTML.

## Architecture

See [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for how the bookmarklet differs from the extensions.

## License

GPL-3.0-or-later. See [`../LICENSE`](../LICENSE).
