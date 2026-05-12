# AccessibleName

Lightweight, self-contained accessibility tooling that reports the **computed accessible name** of every interactive element on a web page — across iframes (including cross-origin) and shadow DOM.

Built by [CNIB Access Labs](https://github.com/CNIB-AccessLabs) to make accessibility testing on enterprise SaaS (Dayforce, Workday, ServiceNow, anything iframe-heavy) faster than dropping into ANDI for every quick check. The same code ships three ways so you can pick the right tool for the situation:

| Tool | Best for | Limitations |
|------|----------|-------------|
| **[Bookmarklet](./bookmarklet)** | Quick check on a single page, no install, runs locally | Bound by same-origin policy — can't see inside cross-origin iframes |
| **[Firefox extension](./firefox-extension)** | Full coverage including cross-origin iframes | Temporary install unless signed; see install docs |
| **[Chrome / Edge / Brave extension](./chrome-extension)** | Full coverage; permanent in developer mode | Same as above |

All three implement the common path of the [W3C Accessible Name and Description Computation 1.2](https://www.w3.org/TR/accname-1.2/). All three are **self-contained** — no network calls, no telemetry, no external dependencies. Safe to run on internal apps and secured environments where calling home would be a violation.

For a deeper read on the algorithm and architecture, see [`docs/ACCESSIBLE_NAME_COMPUTATION.md`](./docs/ACCESSIBLE_NAME_COMPUTATION.md) and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Quick start

**Bookmarklet (30 seconds):** Open [`bookmarklet/a11y-names.html`](./bookmarklet/a11y-names.html) in your browser, drag the **a11y: names** button to your bookmarks bar, then click it on any page you want to inspect.

**Firefox extension (1 minute):** Go to `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, point at [`firefox-extension/manifest.json`](./firefox-extension/manifest.json). Click the toolbar icon to open the inspector menu.

**Chrome / Edge / Brave extension (1 minute):** Go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, select the [`chrome-extension`](./chrome-extension) folder. Click the toolbar icon to open the inspector menu.

## What it shows you

When you trigger any of the three tools, every interactive element on the page gets:

- An **outline** in blue (or red, if no accessible name) so you can see at a glance which controls have a name and which don't.
- A **badge** above each element with its computed accessible name and the rule that produced it (`aria-label`, `<label for>`, subtree text, etc.).
- A **floating panel** on the right with a clickable list of everything — click a row to scroll to the element and flash it.
- A **Copy MD** button that puts a Markdown table on your clipboard for pasting into a bug report, audit notebook, or ticket.
- The **DevTools console** also has the full table as a `console.table` and as raw Markdown.

In the extensions, top-frame elements show blue badges and iframe elements show green, so you can immediately tell where each control lives.

## Why three tools instead of one

Same-origin policy. A bookmarklet runs as page-context script, so the browser refuses to let it read into a cross-origin iframe — that's a hard browser-security boundary, not a tool limitation. Enterprise SaaS routinely embeds sub-products in cross-origin iframes (Dayforce Learning, embedded Workday modules), and a bookmarklet stops at the frame boundary.

A WebExtension content script is allowed to run in every frame the tab loads, regardless of origin, because the user explicitly granted host permissions when installing. That's why the extensions can give you full-page coverage where the bookmarklet can't.

The bookmarklet still has its place — no install, no maintenance, easy to share — so we ship both.

## What it does *not* do

This is a **name inspector**, not a full accessibility scanner. It tells you whether interactive elements have accessible names; it does not check colour contrast, heading order, ARIA validity, focus visibility, or any of the other dozens of WCAG criteria. For those, use axe DevTools or your existing scanner. AccessibleName fills a narrow gap: rapid "does this control have a name and where does it come from?" inspection, especially inside iframes that other tools struggle with.

It also can't find `<div>` elements made interactive purely through `addEventListener('click', …)` with no role, `tabindex`, inline `onclick`, or other semantic marker. That's not a bug — assistive technology can't find those either. When the tool is silent on a visible interactive control, that itself is the diagnosis: the page has no semantic for it.

## License

GPL-3.0-or-later. See [LICENSE](./LICENSE).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Issues and PRs welcome.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
