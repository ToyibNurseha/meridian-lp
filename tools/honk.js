/**
 * Honk Index (GooseDAO) — DLMM market-regime metrics, refreshed ~15 min.
 * Free endpoint discovered via the official Scriptable widget source.
 * Used as passive Darwin signals first; may later gate screening cycles.
 */
import { log } from "../logger.js";

const HONK_URL = "http://honk.etherobot.xyz/metrics";
const CACHE_TTL_MS = 15 * 60 * 1000;

let _cache = { at: 0, data: null };

function parseNumeric(value) {
  if (value == null) return null;
  const s = String(value).trim();
  const m = s.match(/^([\d.]+)\s*([MK%]?)/i);
  if (!m) return null;
  let n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2].toUpperCase() === "M") n *= 1_000_000;
  if (m[2].toUpperCase() === "K") n *= 1_000;
  return n;
}

function parseDiffPct(diff) {
  const m = String(diff || "").match(/([+-][\d.]+)%/);
  return m ? Number(m[1]) : null;
}

/**
 * Fetch and parse the Honk Index. Returns null on any failure (non-blocking).
 * { pools, pools_diff_pct, imb_pct, vol_1d, tvl_1d, fees_1d, yield_1d_pct, fetched_at }
 */
export async function fetchHonkIndex() {
  if (_cache.data && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.data;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(HONK_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`honk ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error("unexpected shape");
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    const data = {
      pools: parseNumeric(byName["Pools"]?.value),
      pools_diff_pct: parseDiffPct(byName["Pools"]?.diff),
      imb_pct: parseNumeric(byName["Imb"]?.value),
      vol_1d: parseNumeric(byName["1d Vol"]?.value),
      tvl_1d: parseNumeric(byName["1d TVL"]?.value),
      fees_1d: parseNumeric(byName["1d Fees"]?.value),
      yield_1d_pct: parseNumeric(byName["1d Yield"]?.value),
      fetched_at: new Date().toISOString(),
    };
    _cache = { at: Date.now(), data };
    log("honk", `Honk Index: pools=${data.pools} imb=${data.imb_pct}% yield_1d=${data.yield_1d_pct}%`);
    return data;
  } catch (err) {
    log("honk", `Honk Index fetch failed (non-blocking): ${err.message}`);
    return null;
  }
}

/** One-line summary for prompt injection; null-safe. */
export function honkSummaryLine(h) {
  if (!h) return null;
  const regime = h.yield_1d_pct == null ? "unknown" : h.yield_1d_pct >= 3 ? "HEALTHY" : h.yield_1d_pct >= 1.5 ? "NEUTRAL" : "WEAK";
  const poolsDiff = h.pools_diff_pct == null ? "?" : `${h.pools_diff_pct >= 0 ? "+" : ""}${h.pools_diff_pct}%`;
  return `MARKET REGIME (Honk Index): ${regime} — viable_pools=${h.pools ?? "?"} (${poolsDiff}), swap_imbalance=${h.imb_pct ?? "?"}%, market_1d_yield=${h.yield_1d_pct ?? "?"}% (>=3% healthy, <1.5% weak — in WEAK regime prefer smaller size or skip marginal candidates)`;
}
