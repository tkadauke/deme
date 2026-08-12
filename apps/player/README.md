# @deme/player

The browser shell that hosts a deme game. Structured as two pages, not one,
specifically for the iframe + CSP isolation the scripting sandbox's threat
model calls for (see [`docs/architecture.md`](../../docs/architecture.md#scripting)):
unreviewed, community-authored Lua runs inside `@deme/engine`'s sandboxed
wasmoon VM (instruction budget, call-depth limit, memory ceiling — see
[`packages/engine/src/lua-sandbox.ts`](../../packages/engine/src/lua-sandbox.ts)),
and this app is the defense-in-depth layer around _that_: if a VM-level
sandbox escape ever happened anyway, it should still not be able to reach
this page's DOM, cookies, or another game's saved data.

## The two pages

- **`index.html`** — the host shell. Runs no game code and has no
  `script-src` in its CSP at all; its only job is embedding `play.html` in
  an `<iframe sandbox="allow-scripts">`.
- **`play.html`** — where the game actually renders: PixiJS, `GameSession`,
  and the wasmoon VM. Its CSP allows `'wasm-unsafe-eval'` (WebAssembly
  compilation only — not general `eval`) alongside a hash-source/`data:`/
  `blob:` CSP — see "play.html's CSP" below for why it isn't `'self'`.

The `sandbox="allow-scripts"` attribute on the iframe **deliberately omits
`allow-same-origin`**. That omission is what makes the isolation real: a
sandboxed iframe without `allow-same-origin` runs its content under a
unique, opaque origin, distinct both from `index.html`'s origin and from
every other game's `play.html` origin. An opaque origin can't read or write
another origin's DOM, cookies, or `localStorage` — so even a full JS-level
compromise inside `play.html` has nothing to reach out to. Adding
`allow-same-origin` back would defeat this entirely; don't.

## play.html's CSP: hash-source and `data:`/`blob:`, not `'self'`

CSP's `'self'` source is matched against the protected document's security
origin. `play.html`'s opaque origin (see above) is never equal to anything
— including another opaque origin from the same page reloaded — so a
`'self'`-based CSP there can never match its own script, stylesheet, or any
other same-path resource; it just silently refuses to load. (This isn't
theoretical: it's exactly the bug this section describes fixing.)

`play.html`'s build (`vite.play.config.ts`, and `vite-plugins/inline-play-html.ts`)
works around this by not depending on origin matching at all:

- The built JS and CSS are inlined into `play.html` itself as literal
  `<script>`/`<style>` content (via `assetsInlineLimit`/`inlineDynamicImports`
  for the JS, and a post-build inlining pass for both), and the CSP's
  `script-src`/`style-src` are rewritten at build time to hash-source
  expressions computed over that exact inlined content. Hash-matching
  external `<script src>` also exists in CSP3, but needs a matching
  `integrity` attribute and has had inconsistent cross-browser support
  (Firefox lagged Chromium here for years); hashing _inline_ content is the
  original, universally-supported CSP2 use case, so this sidesteps that
  entirely. The tradeoff — no separately cacheable JS/CSS file — is fine for
  a single sandboxed play page.
- Every image and wasmoon's `glue.wasm` are inlined as base64 `data:` URIs
  in the same build (see "wasmoon's `.wasm` load" below), so `img-src`/
  `connect-src` use `data:` instead of `'self'`.
- PixiJS spawns a `blob:` Worker on init (texture-loading support
  detection) regardless of which texture formats the game actually uses, so
  `worker-src` uses `blob:`.

Because none of this depends on the document's origin, it works identically
whether `play.html` is opened directly (a real origin, where `'self'` would
have worked too) or embedded in the sandboxed iframe (an opaque origin,
where it wouldn't) — the same build output is correct either way, dev or
production. See `e2e/play-sandbox.spec.ts` for the regression test: it loads
the actual built `index.html` in a real browser (Playwright — vitest's
jsdom environment doesn't enforce CSP, so this bug class is invisible to
the rest of the suite) and asserts zero CSP violations and console errors.

`vite.config.ts` (used by `vite`/`vite preview`/`vitest`) doesn't build
`play.html` directly — `pnpm run build` runs `vite.index.config.ts` and
`vite.play.config.ts` as two separate `vite build` passes, because
`inlineDynamicImports` (needed so PixiJS's internally code-split
WebGPU/WebGL/Canvas renderer chunks end up in the one script tag that gets
inlined) is a Rollup output option that only works with a single entry
point. `vite dev` serves `/play.html` from a real (cached, watch-invalidated)
`vite.play.config.ts` build via `vite-plugins/play-html-dev-server.ts`
instead of Vite's normal unbundled-ESM dev transform, so dev behaves
identically to production instead of needing a separate, weaker dev-only
CSP.

PixiJS's default renderer also needs `new Function`-based fast paths for
uniform/shader syncing, which need `'unsafe-eval'` — not something this CSP
grants. `src/app.ts` imports `pixi.js/unsafe-eval` (PixiJS's own polyfill
entry point for exactly this) before creating the `Application`, which
swaps those fast paths for slower CSP-safe equivalents instead.

## HTTP-header CSP (`public/_headers`)

Two directives — `frame-ancestors` and `X-Frame-Options` — are not
permitted in a `<meta http-equiv="Content-Security-Policy">` tag (the CSP
spec ignores them there); they only take effect as real HTTP response
headers. [`public/_headers`](./public/_headers) sets them using the
Netlify/Cloudflare Pages convention (Vite copies `public/` into `dist/`
verbatim, and both platforms read a `_headers` file from the site root at
that path). Deploying elsewhere (a different static host, a CDN, an nginx
config) needs the equivalent header configuration in that platform's own
format — copy the two header lines in `_headers`.

## wasmoon's `.wasm` load

`src/app.ts` imports wasmoon's `glue.wasm` as a Vite asset
(`import wasmUrl from "wasmoon/dist/glue.wasm?url"`) and passes it to
`@deme/engine`'s `setLuaWasmUri` before booting a `GameSession`. This isn't
optional wiring: `wasmoon`'s `LuaFactory` defaults an unset wasm URI to
`https://unpkg.com/wasmoon@<version>/dist/glue.wasm` whenever it detects a
browser (`window`/`self`), which `play.html`'s CSP has no reason to ever
allow — wasmoon expects bundler consumers to resolve and supply the URI
themselves rather than rely on that default. See
[`setLuaWasmUri`'s doc comment](../../packages/engine/src/lua-sandbox.ts)
for the full explanation.

`play.html`'s build inlines `glue.wasm` as a base64 `data:` URI (see
"play.html's CSP" above), same as it does for content images — so this
import resolves to a `data:` string, not a network path, and wasmoon's own
`fetch()` call against it (it fetches the URI regardless of scheme to get
an `ArrayBuffer`) never leaves the page. That also sidesteps what used to
be a separate problem: the opaque origin `play.html`'s sandboxed iframe
runs under makes every _real_ subresource fetch it makes cross-origin with
respect to this same server (an opaque origin can never be "same-origin"
with anything), which is why [`public/_headers`](./public/_headers) still
carries a wide-open `Access-Control-Allow-Origin: *` — defense-in-depth for
any future asset that doesn't end up inlined, since none of it is
per-user or credentialed — even though nothing `play.html` loads today
still needs it.
