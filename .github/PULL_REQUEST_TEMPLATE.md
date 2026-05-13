<!-- Thanks for sending a PR! A few questions to keep review fast. -->

## What this changes

<!-- Short summary of the change and the motivation. Link an issue if there is one. -->

## Which tools does it touch

- [ ] Bookmarklet (`bookmarklet/accesslens.html` and `bookmarklet/src/accesslens.js`)
- [ ] Firefox extension (`firefox-extension/background.js`)
- [ ] Chrome extension (`chrome-extension/background.js`)
- [ ] Docs (`README.md`, `docs/*`)
- [ ] Manifests / icons / packaging

> If you changed the scanner or display logic, it should land in all three of the first three boxes. The bookmarklet has its source embedded in the HTML *and* in `src/accesslens.js`; both copies need to match. See `CONTRIBUTING.md`.

## How you tested it

<!-- AccessLens has no automated tests. Tell us what you ran the build against. Screenshots
     of the panel on representative pages are gold. -->

- [ ] A simple page with standard form controls
- [ ] A page with a same-origin iframe
- [ ] A page with a cross-origin iframe (Dayforce/Workday/anything embedded)
- [ ] Open shadow DOM
- [ ] Both Firefox and a Chromium browser if you touched the extensions

## Anything reviewers should look at closely

<!-- Tricky bits, performance concerns, places you weren't sure of. -->
