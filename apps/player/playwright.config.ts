import { defineConfig } from "@playwright/test";

// Regression coverage for the play.html CSP bug: vitest's jsdom environment
// doesn't enforce CSP, so that class of bug is invisible to the rest of the
// suite (see e2e/play-sandbox.spec.ts and apps/player/README.md). This runs
// against a real build served by `vite preview` — jsdom couldn't tell this
// apart from a working page, only a real browser can.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4319",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec vite preview --port 4319 --strictPort",
    url: "http://localhost:4319/index.html",
    reuseExistingServer: !process.env["CI"],
    timeout: 30_000,
  },
});
