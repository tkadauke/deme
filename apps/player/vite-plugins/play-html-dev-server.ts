import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/**
 * Serves /play.html during `vite dev` from a real, inlined build (via
 * vite.play.config.ts) instead of Vite's normal unbundled-ESM dev transform.
 *
 * Vite's dev server serves each imported module as its own request, which
 * has no equivalent of "one hashable inline script" — the CSP fix here
 * depends on (see vite-plugins/inline-play-html.ts). Rebuilding play.html on
 * demand keeps dev behavior identical to production instead of maintaining a
 * separate, weaker dev-only CSP that could mask this exact bug reappearing.
 *
 * Trades per-module HMR on this one page for correctness: a full rebuild
 * (a few seconds) runs on the first request after a relevant file changes,
 * then serves from cache until the next change.
 */
export function playHtmlDevServer(): Plugin {
  let cached: string | null = null;
  let building: Promise<string> | null = null;

  async function buildPlayHtml(): Promise<string> {
    const { build } = await import("vite");
    const result = await build({
      configFile: fileURLToPath(new URL("../vite.play.config.ts", import.meta.url)),
      logLevel: "warn",
      build: { write: false },
    });
    const built = Array.isArray(result) ? result[0] : result;
    const output = built && "output" in built ? built.output : undefined;
    const htmlOutput = output?.find((item) => item.fileName === "play.html");
    if (!htmlOutput || htmlOutput.type !== "asset") {
      throw new Error("play-html-dev-server: nested build did not produce play.html");
    }
    return typeof htmlOutput.source === "string"
      ? htmlOutput.source
      : Buffer.from(htmlOutput.source).toString("utf8");
  }

  return {
    name: "deme:play-html-dev-server",
    apply: "serve",
    configureServer(server) {
      server.watcher.on("all", () => {
        cached = null;
      });

      server.middlewares.use(async (req, res, next) => {
        if (!req.url) {
          next();
          return;
        }
        const path = req.url.split("?")[0];
        if (path !== "/play.html") {
          next();
          return;
        }
        try {
          if (!cached) {
            building ??= buildPlayHtml().finally(() => {
              building = null;
            });
            cached = await building;
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html");
          res.end(cached);
        } catch (error) {
          next(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
  };
}

/**
 * index.html's production CSP has no `script-src`/`connect-src` at all —
 * it's the inert host shell, it runs no game code, see README.md. `vite
 * dev` doesn't know that: it always injects its own HMR client script (and
 * its WebSocket connection back to the dev server) into every page it
 * serves, which that CSP then blocks (real console errors, `default-src
 * 'none'` catching both as a fallback). index.html is never sandboxed —
 * it's always the top-level page — so unlike play.html, a plain `'self'`
 * is completely fine for it (CSP's `'self'` for `connect-src` also permits
 * the matching `ws:`/`wss:` origin, which is what the HMR client uses);
 * this only ever runs in dev (`apply: "serve"`), so the committed file and
 * the production build are untouched.
 */
export function indexHtmlDevCsp(): Plugin {
  return {
    name: "deme:index-html-dev-csp",
    apply: "serve",
    transformIndexHtml(html, ctx) {
      if (!ctx.filename.endsWith("index.html")) return html;
      return html.replace(
        /(<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*)"/i,
        (match, prefix: string) => `${prefix}; script-src 'self'; connect-src 'self'"`,
      );
    },
  };
}
