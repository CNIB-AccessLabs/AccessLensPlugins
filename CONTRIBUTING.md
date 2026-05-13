# Contributing

Thanks for considering a contribution. This project is built and maintained by CNIB Access Labs, and we welcome bug reports, feature suggestions, and pull requests.

## Bug reports

Open an [issue](https://github.com/CNIB-AccessLabs/AccessLensPlugins/issues) with:

- Which tool (bookmarklet / Firefox extension / Chrome extension)
- Browser and version
- The page or HTML pattern that reproduces the issue (a small standalone repro is ideal — a `data:` URL or a public test page if possible)
- What you expected vs. what you saw
- Console output if any

For pages behind authentication (the Dayforce-shaped case the tool was built for), a screenshot of DevTools showing the relevant DOM is fine when sharing the URL isn't possible.

## Pull requests

The three tools share most of their JavaScript. If your change is to the scanner or display logic, it should ideally land in all three:

- `bookmarklet/src/accesslens.js` and the embedded `<script id="bookmarklet-source">` block in `bookmarklet/accesslens.html`
- `firefox-extension/background.js`
- `chrome-extension/background.js` (currently a byte-identical copy of the Firefox `background.js`)

There is no build step. Each file is hand-maintained. A future improvement on the roadmap is consolidating the shared scanner into a single source file with copy-on-build, but for now the duplication is intentional and trivial to keep in sync.

### Coding conventions

- Plain ES5/ES2017-compatible JavaScript. The extensions and bookmarklet target current evergreen browsers, but the scanner code runs in injected contexts (including pages with no module support), so keep it framework-free and avoid features that need a transpile step.
- No external dependencies. The whole point of this project is that it works in secured environments where calling home is forbidden.
- Indentation: two spaces.
- Use `var` inside the injected scanner functions (they're parsed in random page contexts; `let`/`const` are fine but `var` keeps the hoisting model predictable).
- Comments should explain *why*, not *what* the code is doing.

### Tests

There are no automated tests yet — this is a manual-test project. Before opening a PR, please verify on at least:

1. A simple page with standard form controls (a public test page or `data:` URL is fine).
2. A page with an iframe (same-origin).
3. If you have access: a page with cross-origin iframes (Dayforce, Workday, or similar).

If you can attach screenshots of the panel on each of those scenarios, that's enough for review.

## Code of Conduct

Be kind. We work on accessibility tools because we believe everyone deserves access to digital systems; that ethic applies to our community as much as to our software.

## License

By contributing, you agree your contributions will be licensed under GPL-3.0-or-later, the project's license.
