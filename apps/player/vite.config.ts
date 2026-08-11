import { defineConfig } from "vitest/config";
import { indexHtmlDevCsp, playHtmlDevServer } from "./vite-plugins/play-html-dev-server.js";

// This is the config for `vite`/`vite preview`/`vitest` — it does NOT build
// the app. `pnpm run build` runs two separate `vite build` passes, each with
// its own config: vite.index.config.ts (index.html) and vite.play.config.ts
// (play.html, which needs its own inlineDynamicImports/assetsInlineLimit
// settings — see that file). `build.outDir` still has to match here so
// `vite preview` finds the right folder.
export default defineConfig({
  build: {
    outDir: "dist",
  },
  // play.html is loaded inside an opaque-origin sandboxed iframe (see
  // apps/player/README.md), under which its CSP's 'self' sources can never
  // match — see vite-plugins/inline-play-html.ts. The production build
  // handles this by inlining play.html's script/style/assets and hashing
  // them into the CSP. The plain vite dev server can't do that on the fly
  // for unbundled ESM, so this plugin serves /play.html from a real (cached,
  // watch-invalidated) build via vite.play.config.ts instead, matching
  // production behavior exactly rather than approximating it.
  plugins: [playHtmlDevServer(), indexHtmlDevCsp()],
  test: {
    environment: "jsdom",
    // e2e/ holds Playwright specs (run via `playwright test`, see
    // playwright.config.ts) — jsdom doesn't enforce CSP, which is exactly
    // why those need a real browser instead of vitest.
    exclude: ["**/node_modules/**", "**/dist/**", "**/tsc-out/**", "e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
