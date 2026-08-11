import { expect, test } from "@playwright/test";

/**
 * Regression test for the play.html CSP bug: play.html is loaded inside
 * index.html's `sandbox="allow-scripts"` iframe (no `allow-same-origin`,
 * see apps/player/README.md), which gives it an opaque origin. CSP's
 * `'self'` source can never match an opaque origin, so a `'self'`-based CSP
 * there silently refuses to load the page's own script/style/assets. jsdom
 * (used by the rest of this app's vitest suite) doesn't enforce CSP at all,
 * so this class of bug is invisible everywhere except a real browser — this
 * test exists specifically to close that gap.
 */
test("index.html's sandboxed iframe loads play.html with no CSP violations and the game renders", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/index.html");

  const iframe = page.locator("iframe");
  // The whole point of the opaque-origin isolation this CSP fix has to
  // preserve: allow-same-origin must never come back (see README.md).
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");

  const playFrame = page.frameLocator("iframe");
  await expect(playFrame.locator(".canvas-host canvas")).toBeVisible();
  await expect(playFrame.locator(".verb-bar button")).toHaveCount(4);

  // Give wasmoon's glue.wasm init, the Lua sandbox boot, and the study
  // room's asset load (background image, item/npc sprites) time to run and
  // fail loudly into the console/pageerror listeners above if anything is
  // still CSP-blocked, before asserting on the listeners below.
  await page.waitForTimeout(2000);

  await expect(playFrame.locator(".message-toast.is-error")).toBeHidden();

  expect(pageErrors, `unexpected page errors:\n${pageErrors.join("\n")}`).toEqual([]);

  const cspViolations = consoleErrors.filter((text) => /content security policy|refused to/i.test(text));
  expect(cspViolations, `CSP violations:\n${cspViolations.join("\n")}`).toEqual([]);
  expect(consoleErrors, `console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
