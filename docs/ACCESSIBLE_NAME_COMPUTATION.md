# Accessible Name Computation

The "accessible name" of a control is the string that assistive technologies (screen readers, voice control, switch input) read out or match against. A button with no accessible name is announced as just "button" — useless to a screen reader user. The W3C [Accessible Name and Description Computation 1.2](https://www.w3.org/TR/accname-1.2/) spec defines exactly how browsers should compute that string from the DOM. This is what every accessibility tool — ANDI, axe, Lighthouse — implements internally.

AccessLens implements the **common path** of accname-1.2, which covers the overwhelming majority of real-world cases. It is **not** a fully spec-conformant implementation; for spec-edge cases (deep `aria-labelledby` chains, presentational role children, `<title>` on SVG, name from author vs. name from content rules per role), ANDI remains the reference tool. AccessLens is built for fast, repeatable inspection — not as an audit-of-record.

## What gets computed

For each interactive element, AccessLens walks this priority list and returns the first match. The `source` column in the panel tells you which rule produced the name.

| Priority | Source | Notes |
|----------|--------|-------|
| 1 | `aria-labelledby` | Each id-ref is resolved; the referenced elements' text is concatenated. |
| 2 | `aria-label` | Used if non-empty after trimming. |
| 3 | `<label for="...">` | For form controls (`input`, `select`, `textarea`, `meter`, `progress`). |
| 4 | Wrapping `<label>` | For form controls inside a `<label>`. |
| 5 | `value` | For `<input type="button|submit|reset">`. Includes the browser's default ("Submit" / "Reset") when the attribute is absent. |
| 6 | `alt` | For `<img>` and `<input type="image">`. An empty `alt=""` is treated as an explicit empty name (meaning "decorative"). |
| 7 | `<legend>` | For `<fieldset>` (the legend's text content). |
| 8 | Subtree text | For `<a>`, `<button>`, `<summary>`, `<details>`, and elements with interactive ARIA roles (button, link, menuitem, tab, option, checkbox, radio, switch, treeitem). The text content of the element is collected, with `aria-hidden`/`display:none` children excluded and `aria-labelledby`/`aria-label` honoured recursively. |
| 9 | `title` | Last-resort fallback; many assistive tech vendors do use this as a name source. |
| 10 | `placeholder` | **Flagged as non-spec.** Real screen readers vary on whether they fall back to placeholder; AccessLens surfaces it so you can see it's the only "name" the control has, but the panel labels it explicitly so you know it's not really the accessible name. |

If none of those produce a non-empty string, the element is flagged with a red badge and **NO ACCESSIBLE NAME** in the panel.

## What it doesn't compute (yet)

These edge cases are not fully handled. In most cases the tool will produce a reasonable answer anyway, but if you're auditing for spec conformance, fall back to ANDI:

- **Recursive `aria-labelledby` with circular references**: the tool uses a `seen` set to prevent infinite recursion, but the order in which a circular chain resolves may differ from a fully spec-conformant implementation.
- **Name from content vs. name from author per role**: the spec distinguishes between roles that allow subtree text as a name (e.g. `button`) and roles that don't (e.g. `textbox`). AccessLens uses subtree text for the role list above but doesn't enforce the full per-role matrix.
- **Presentational children**: an element with `role="presentation"` or `role="none"` is supposed to be skipped in name computation but its children's text contributes. AccessLens recurses into them as normal; this is usually correct but the spec has subtler rules.
- **SVG `<title>`**: SVG's name-from-title rule is not implemented separately; SVG elements are treated as generic.
- **`<table>` captions, `<th>` for cells**: tables are not currently inspected as interactive elements.

## Why this still beats the obvious alternative

You might wonder: why not just call the browser's experimental `getAccessibleName()` (available in some browsers under flags) or use a library like `dom-accessibility-api`?

- `Element.getAccessibleName()` is not in any cross-browser stable API. It exists in DevTools protocol, not in page-context JS.
- `dom-accessibility-api` is excellent but ships as an npm package (~15KB minified). Bundling it into a bookmarklet is possible but the bookmarklet's whole point is to be a self-contained, copy-paste-able URL with no build step. The hand-rolled implementation here trades a small amount of spec coverage for zero dependencies and total transparency.

## References

- [W3C Accessible Name and Description Computation 1.2](https://www.w3.org/TR/accname-1.2/)
- [W3C HTML Accessibility API Mappings 1.0](https://www.w3.org/TR/html-aam-1.0/)
- [W3C WAI-ARIA 1.2](https://www.w3.org/TR/wai-aria-1.2/)
- [ANDI (SSA Accessible Name and Description Inspector)](https://www.ssa.gov/accessibility/andi/help/index.html)
