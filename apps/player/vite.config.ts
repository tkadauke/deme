import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    outDir: "dist",
    rollupOptions: {
      // Two HTML entries: index.html (the inert host shell) and play.html
      // (the sandboxed iframe's content) — see index.html/play.html for why.
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        play: fileURLToPath(new URL("./play.html", import.meta.url)),
      },
    },
  },
  test: {
    environment: "jsdom",
    exclude: ["**/node_modules/**", "**/dist/**", "**/tsc-out/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
