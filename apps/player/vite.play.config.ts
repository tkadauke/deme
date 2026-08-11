import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { inlinePlayHtml } from "./vite-plugins/inline-play-html.js";

// play.html runs inside an iframe sandboxed *without* `allow-same-origin`
// (see apps/player/README.md), which gives it an opaque origin — CSP's
// `'self'` never matches anything there. See
// vite-plugins/inline-play-html.ts for the full explanation of why this
// build inlines everything (script, style, images, wasmoon's glue.wasm) and
// switches the CSP to hash-source/`data:` instead of `'self'`.
//
// Built as its own pass, separate from index.html (vite.index.config.ts),
// because `inlineDynamicImports` — needed so pixi.js's internally
// code-split renderer chunks end up in the one script tag we inline —
// is a Rollup output option that only works with a single entry point.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    assetsInlineLimit: () => true,
    modulePreload: false,
    rollupOptions: {
      input: {
        play: fileURLToPath(new URL("./play.html", import.meta.url)),
      },
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  plugins: [inlinePlayHtml()],
});
