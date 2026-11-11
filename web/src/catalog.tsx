import { useState } from "react";
import { api, usd, type Purchase } from "./api.ts";

/**
 * What Channel3's catalog says about this exact product: its real retailers and prices,
 * 90 days of price history, and, when the purchase was stopped, a real seller to buy from instead.
 */
export function CatalogPanel({ p, notify }: { p: Purchase; notify: (m: string, err?: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const seller = p.verdict.checks.find((c) => c.rule === "market.catalog_seller");
  const price = p.verdict.checks.find((c) => c.rule === "market.catalog_price");
  const hist = p.verdict.checks.find((c) => c.rule === "market.price_history");
  if (!seller && !hist) return null;
  const offers = String(seller?.data?.offers ?? "")
    .split(" · ")
    .filter(Boolean)
    .map((s) => {
      const m = /^(\S+) \$([\d.]+)(.*)$/.exec(s);
      return m ? { domain: m[1]!, price: Number(m[2]), out: /out of stock/.test(m[3] ?? "") } : null;
    })
    .filter((x): x is { domain: string; price: number; out: boolean } => !!x);
  const me = p.intent.listing.merchant.domain.replace(/^www\./, "");
  const series = String(hist?.data?.series ?? "").split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const alt = seller?.data?.altDomain as string | undefined;
  const altPrice = Number(seller?.data?.altPrice ?? 0);
  const buyAlt = async () => {
    setBusy(true);
    try {
      const r = await api<{ purchase: Purchase }>("POST", `/api/purchases/${p.id}/alternative`, {});
      notify(`Proposed the real one from ${alt}: ${r.purchase.verdict.headline}`);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const all = [...offers.map((o) => o.price), p.intent.listing.price, ...series];
  const lo = Math.min(...all), hi = Math.max(...all);
  const x = (v: number) => (hi === lo ? 50 : ((v - lo) / (hi - lo)) * 100);
  const listed = offers.some((o) => o.domain === me);
  return (
    <section className="c3">
      <header>
        <h3>What Channel3's catalog says</h3>
        <span className="faint">Live product detail and price history for this exact product, checked at the gate.</span>
      </header>
      {offers.length > 0 && (
        <div className="c3-strip" role="img" aria-label="Where this purchase's price sits among the product's real retailers">
          <div className="c3-axis">
            {offers.map((o) => (
              <span key={o.domain} className={`c3-dot${o.domain === me ? " me" : ""}${o.out ? " out" : ""}`} style={{ left: `${x(o.price)}%` }} title={`${o.domain} $${o.price.toFixed(2)}${o.out ? " (out of stock)" : ""}`} />
            ))}
            {!listed && <span className="c3-dot bad" style={{ left: `${x(p.intent.listing.price)}%` }} title={`${me} $${p.intent.listing.price.toFixed(2)}: not in Channel3`} />}
          </div>
          <div className="c3-scale num faint"><span>{usd(lo)}</span><span>{usd(hi)}</span></div>
        </div>
      )}
      <table className="c3-table">
        <tbody>
          {offers.map((o) => (
            <tr key={o.domain} className={o.domain === me ? "me" : ""}>
              <td>{o.domain}{o.domain === me && <em> · this seller</em>}</td>
              <td className="num">{usd(o.price)}</td>
              <td className="faint">{o.out ? "out of stock" : "in stock"}</td>
            </tr>
          ))}
          {!listed && (
            <tr className="bad">
              <td>{me}<em> · this seller, not in Channel3</em></td>
              <td className="num">{usd(p.intent.listing.price)}</td>
              <td className="faint">unknown</td>
            </tr>
          )}
        </tbody>
      </table>
      {price && <p className="c3-note bad">{price.title}. {price.detail}</p>}
      {series.length >= 5 && <History series={series} price={p.intent.listing.price} status={String(hist?.data?.status ?? "")} days={Number(hist?.data?.days ?? series.length)} />}
      {p.state === "blocked" && alt && (
        <div className="c3-alt">
          <div>
            <b>Buy the real one instead</b>
            <span className="faint">Same product from {alt}, a retailer Channel3 lists, for {usd(altPrice)}. It goes through the same gate.</span>
          </div>
          <button className="btn primary sm" disabled={busy} onClick={buyAlt}>
            <span>{busy ? "Checking…" : `Propose ${alt}`}</span>
          </button>
        </div>
      )}
    </section>
  );
}

function History({ series, price, status, days }: { series: number[]; price: number; status: string; days: number }) {
  const W = 520, H = 70, P = 6;
  const lo = Math.min(...series, price), hi = Math.max(...series, price);
  const y = (v: number) => (hi === lo ? H / 2 : H - P - ((v - lo) / (hi - lo)) * (H - 2 * P));
  const step = (W - 2 * P) / Math.max(1, series.length - 1);
  const d = series.map((v, i) => `${i ? "L" : "M"}${(P + i * step).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return (
    <div className="c3-hist">
      <div className="c3-hist-head">
        <span>{days}-day price</span>
        <span className="num faint">{usd(Math.min(...series))}–{usd(Math.max(...series))}{status ? ` · today "${status}"` : ""}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="c3-svg" role="img" aria-label={`Price over ${days} days, this purchase at ${usd(price)}`}>
        <path d={`${d}L${W - P},${H}L${P},${H}Z`} className="c3-area" />
        <path d={d} className="c3-line" />
        <line x1={P} x2={W - P} y1={y(price)} y2={y(price)} className="c3-buy" />
        <text x={W - P} y={y(price) - 4} textAnchor="end" className="c3-buy-l">this purchase {usd(price)}</text>
      </svg>
    </div>
  );
}
