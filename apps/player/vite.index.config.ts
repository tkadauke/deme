import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// index.html is the inert host shell: no game code, no script-src, its
// stylesheet loads under the page's real (non-opaque) origin — a plain
// build with no inlining is fine. Built separately from play.html (see
// vite.play.config.ts) because play.html's build needs
// `inlineDynamicImports`, which Rollup only allows for a single entry.
export default defineConfig({
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
      },
    },
  },
});
