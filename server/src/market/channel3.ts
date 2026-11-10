/**
 * Channel3: one API, 100M+ products, offers across 25k+ retailers.
 * Chaperone uses it twice: the agent searches it to shop, and the gate uses the
 * SAME product's offers across other retailers as the market price reference.
 */
import { config } from "../config.ts";
import { timed } from "../telemetry.ts";

export interface C3Offer {
  url: string;
  domain: string;
  price: { price: number; compare_at_price?: number | null; currency: string };
  availability: string;
  condition?: string | null;
}

export interface C3Product {
  id: string;
  title: string;
  description?: string | null;
  brands?: { id: string; name: string }[];
  images?: { url: string; cleaned_url?: string | null; is_main_image?: boolean }[];
  category?: { slug: string; title: string } | null;
  key_features?: string[] | null;
  offers: C3Offer[];
  structured_attributes?: Record<string, unknown>;
}

export class Channel3Error extends Error {}

export async function channel3Search(query: string, opts: { maxPrice?: number; minPrice?: number; limit?: number } = {}): Promise<C3Product[]> {
  if (!config.channel3Key) throw new Channel3Error("CHANNEL3_API_KEY is not set");
  const body: Record<string, unknown> = { query, limit: opts.limit ?? 8 };
  const price: Record<string, number> = {};
  if (opts.minPrice != null) price.min_price = opts.minPrice;
  if (opts.maxPrice != null) price.max_price = opts.maxPrice;
  body.filters = { availability: ["InStock"], ...(Object.keys(price).length ? { price } : {}) };
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await timed("channel3", `search "${query.slice(0, 40)}"`, () => fetch("https://api.trychannel3.com/v1/search", {
        method: "POST",
        headers: { "x-api-key": config.channel3Key, "Content-Type": "application/json", "x-user-id": "chaperone-demo" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      }).then((r) => { if (r.status === 429 || r.status >= 500) throw new Channel3Error(`Channel3 ${r.status}`); return r; }), (r) => `${r.status}`);
      if (res.status === 429 || res.status >= 500) throw new Channel3Error(`Channel3 ${res.status}`);
      if (!res.ok) throw new Channel3Error(`Channel3 search failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { products?: C3Product[] };
      return json.products ?? [];
    } catch (e) {
      lastErr = e;
      if (!(e instanceof Channel3Error) || !/429|5\d\d/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}
