import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { capabilities, config } from "./config.ts";
import { createApp } from "./api/app.ts";
import { makePayPal } from "./paypal/index.ts";
import { Store } from "./store/store.ts";

const store = new Store(config.dataDir, config.mode === "live" ? new URL("../seed/snapshot.json", import.meta.url).pathname : undefined);
const paypal = makePayPal();
const { app } = createApp(store, paypal);

const webDist = new URL("../../web/dist/", import.meta.url).pathname;
if (existsSync(webDist)) {
  const root = new URL("../../web/dist", import.meta.url).pathname;
  app.use("/assets/*", serveStatic({ root }));
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ path: `${root}/index.html` }));
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  const caps = capabilities();
  console.log(`Chaperone on http://localhost:${info.port}`);
  console.log(`  mode=${caps.mode}  paypal=${paypal.kind}${caps.paypal ? ` (${caps.paypalEnv}, ${caps.paymentMode})` : ""}  gemini=${caps.gemini ? config.geminiModel : "off (heuristic)"}  channel3=${caps.channel3 ? "on" : "off (offline catalog)"}`);
});
