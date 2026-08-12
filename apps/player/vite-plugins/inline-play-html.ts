import { createHash } from "node:crypto";
import type { OutputAsset, OutputChunk, Plugin } from "vite";

/**
 * play.html is loaded inside an iframe sandboxed *without* `allow-same-origin`
 * (see apps/player/README.md), which gives it a unique opaque security
 * origin. CSP's `'self'` source is matched against that origin, and an
 * opaque origin never equals anything — including itself across two source
 * expressions — so `'self'` can never match play.html's own script,
 * stylesheet, or any other same-path resource. Hash-source and `data:`
 * source expressions don't depend on origin at all, so they're the only CSP
 * mechanisms that work here. This plugin inlines play.html's built JS and
 * CSS as literal `<script>`/`<style>` content (the broadly-supported,
 * spec-original hash-source use case — unlike hashing an *external*
 * `<script src>`, which needs a matching `integrity` attribute and has
 * spottier cross-browser support), then rewrites the CSP meta tag to match
 * exactly what's inlined. img-src/connect-src move to `data:` because
 * play.html's build (see vite.play.config.ts) inlines every image and the
 * wasmoon glue.wasm as base64 data URIs too, for the same origin-blindness
 * reason — nothing play.html loads is a same-path network request anymore.
 */
export function inlinePlayHtml(): Plugin {
  return {
    name: "deme:inline-play-html",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const htmlFileName = Object.keys(bundle).find((name) => name === "play.html");
      if (!htmlFileName) return;
      const htmlAsset = bundle[htmlFileName] as OutputAsset;
      let html = assetSourceToString(htmlAsset);

      const scriptMatch = html.match(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/i);
      if (!scriptMatch) {
        throw new Error("inline-play-html: could not find play.html's module script tag");
      }
      const scriptFile = scriptMatch[1].replace(/^\//, "");
      const scriptChunk = bundle[scriptFile];
      if (!scriptChunk || scriptChunk.type !== "chunk") {
        throw new Error(`inline-play-html: could not find JS chunk for ${scriptFile}`);
      }
      // Vite wraps every dynamic import() (pixi.js uses these internally to
      // lazy-load its WebGL/WebGPU/Canvas renderer backends) in a preload
      // helper call whose second argument is meant to be replaced, per
      // chunk, with that chunk's list of dependency URLs to preload. With
      // `inlineDynamicImports: true` there's only ever one chunk and nothing
      // to preload, but Vite still leaves the bare `__VITE_PRELOAD__`
      // identifier in the output unreplaced — a `ReferenceError` at runtime.
      // vite-plugin-singlefile hits the same interaction and fixes it the
      // same way: substitute the marker with a no-op value.
      const scriptCode = escapeInlineContent(
        (scriptChunk as OutputChunk).code.replace(/"?__VITE_PRELOAD__"?/g, "void 0"),
        "script",
      );
      // Replacer must be a function: a string replacement would run `$&`/`$1`-style
      // pattern substitution against the *replacement* text, and minified bundle
      // code routinely contains literal `$&` (e.g. regex-escaping helpers) that
      // would otherwise get corrupted by that substitution.
      html = html.replace(scriptMatch[0], () => `<script type="module">${scriptCode}</script>`);
      delete bundle[scriptFile];

      const linkMatch = html.match(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*\/?>/i);
      if (!linkMatch) {
        throw new Error("inline-play-html: could not find play.html's stylesheet link tag");
      }
      const cssFile = linkMatch[1].replace(/^\//, "");
      const cssAsset = bundle[cssFile];
      if (!cssAsset || cssAsset.type !== "asset") {
        throw new Error(`inline-play-html: could not find CSS asset for ${cssFile}`);
      }
      const cssText = escapeInlineContent(assetSourceToString(cssAsset as OutputAsset), "style");
      html = html.replace(linkMatch[0], () => `<style>${cssText}</style>`);
      delete bundle[cssFile];

      const scriptHash = `sha256-${sha256Base64(scriptCode)}`;
      const styleHash = `sha256-${sha256Base64(cssText)}`;

      // Rewritten by replacing the 'self' token within each directive (not
      // by matching the whole directive string), so this survives play.html
      // reordering/reformatting its CSP later instead of silently leaving a
      // broken 'self' in place if an exact-string match stopped matching.
      html = rewriteCsp(html, {
        "script-src": (tokens) => replaceSelf(tokens, `'${scriptHash}'`),
        "style-src": (tokens) => replaceSelf(tokens, `'${styleHash}'`),
        // Every image and wasmoon's glue.wasm are inlined as base64 data:
        // URIs by play.html's build (see vite.play.config.ts) — nothing it
        // loads is a same-path network request 'self' could match anyway.
        "img-src": (tokens) => replaceSelf(tokens, "data:"),
        "connect-src": (tokens) => replaceSelf(tokens, "data:"),
        // pixi.js spawns a blob: worker eagerly on init (texture-loading
        // support detection) regardless of whether the demo ever loads a
        // texture format that needs it — verified against a real build, not
        // assumed. blob: is content-addressed by this page's own generated
        // content, not by origin, so it isn't subject to the same
        // opaque-origin problem 'self' has here.
        "worker-src": (tokens) => replaceSelf(tokens, "blob:"),
      });

      htmlAsset.source = html;
    },
  };
}

function assetSourceToString(asset: OutputAsset): string {
  return typeof asset.source === "string"
    ? asset.source
    : Buffer.from(asset.source).toString("utf8");
}

// Browsers compute CSP hashes over the exact literal text between the tags,
// so escaping must happen before hashing, not after — the hash has to match
// what's actually served. `<\/script` is valid inside a JS string/template
// literal (an unnecessary-but-legal identity escape), so this can't change
// program behavior, only text that would otherwise prematurely close the tag.
function escapeInlineContent(content: string, tag: "script" | "style"): string {
  return content.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);
}

function sha256Base64(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("base64");
}

function replaceSelf(tokens: string[], replacement: string): string[] {
  return tokens.map((token) => (token === "'self'" ? replacement : token));
}

/** Applies per-directive token transforms to the page's CSP `<meta>` tag, keyed by directive name. */
function rewriteCsp(
  html: string,
  transforms: Record<string, (tokens: string[]) => string[]>,
): string {
  const metaMatch = html.match(
    /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/i,
  );
  if (!metaMatch) {
    throw new Error("inline-play-html: could not find the CSP <meta> tag");
  }
  const directiveNames = new Set(Object.keys(transforms));
  const seen = new Set<string>();
  const directives = metaMatch[2]
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean)
    .map((directive) => {
      const [name, ...tokens] = directive.split(/\s+/);
      const transform = name ? transforms[name] : undefined;
      if (!transform || !name) return directive;
      seen.add(name);
      return [name, ...new Set(transform(tokens))].join(" ");
    });
  const missing = [...directiveNames].filter((name) => !seen.has(name));
  if (missing.length > 0) {
    throw new Error(
      `inline-play-html: CSP is missing expected director${missing.length === 1 ? "y" : "ies"}: ${missing.join(", ")}`,
    );
  }
  return html.replace(metaMatch[0], () => `${metaMatch[1]}${directives.join("; ")}${metaMatch[3]}`);
}
