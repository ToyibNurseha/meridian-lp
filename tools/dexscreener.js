/**
 * DexScreener volume trend signal.
 * Free, no auth. Queried per-pool by pair address.
 * Returns volume acceleration + buy pressure metrics.
 */

import { log } from "../logger.js";

const BASE = "https://api.dexscreener.com/latest/dex/pairs/solana";
const CACHE_TTL_MS = 60_000;

const _cache = new Map(); // poolAddress → { data, fetchedAt }

export async function getVolumeSignal(poolAddress) {
  const now = Date.now();
  const cached = _cache.get(poolAddress);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  try {
    const res = await fetch(`${BASE}/${poolAddress}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`dexscreener ${res.status}`);
    const json = await res.json();
    const pair = json?.pairs?.[0];
    if (!pair) return null;

    const vol = pair.volume || {};
    const txns = pair.txns || {};
    const priceChange = pair.priceChange || {};

    const h1 = Number(vol.h1 ?? 0);
    const h24 = Number(vol.h24 ?? 0);
    const m5 = Number(vol.m5 ?? 0);
    const buysH1 = Number(txns.h1?.buys ?? 0);
    const sellsH1 = Number(txns.h1?.sells ?? 0);
    const buysM5 = Number(txns.m5?.buys ?? 0);
    const sellsM5 = Number(txns.m5?.sells ?? 0);

    const hourlyAvg = h24 > 0 ? h24 / 24 : null;
    const trendRatio = hourlyAvg != null && hourlyAvg > 0 ? h1 / hourlyAvg : null;
    const netBuyRatioH1 = (buysH1 + sellsH1) > 0 ? buysH1 / (buysH1 + sellsH1) : null;
    const netBuyRatioM5 = (buysM5 + sellsM5) > 0 ? buysM5 / (buysM5 + sellsM5) : null;

    const data = {
      volume_h1: h1,
      volume_h24: h24,
      volume_m5: m5,
      trend_ratio: trendRatio != null ? parseFloat(trendRatio.toFixed(2)) : null,
      net_buy_ratio_h1: netBuyRatioH1 != null ? parseFloat(netBuyRatioH1.toFixed(2)) : null,
      net_buy_ratio_m5: netBuyRatioM5 != null ? parseFloat(netBuyRatioM5.toFixed(2)) : null,
      price_change_h1: Number(priceChange.h1 ?? 0),
      price_change_m5: Number(priceChange.m5 ?? 0),
    };

    _cache.set(poolAddress, { data, fetchedAt: now });
    return data;
  } catch (e) {
    log("dexscreener", `Volume signal failed for ${poolAddress?.slice(0, 8)}: ${e.message}`);
    return null;
  }
}

/**
 * Human-readable summary for LLM prompt.
 * trendRatio > 1.5 = accelerating, < 0.5 = dying
 * netBuyRatio > 0.6 = buyers dominating
 */
export function formatVolumeSignal(signal) {
  if (!signal) return "unavailable";
  const trend = signal.trend_ratio != null
    ? signal.trend_ratio >= 1.5 ? `↑ accelerating (${signal.trend_ratio}x avg)`
    : signal.trend_ratio <= 0.5 ? `↓ dying (${signal.trend_ratio}x avg)`
    : `→ normal (${signal.trend_ratio}x avg)`
    : "?";
  const buyPressure = signal.net_buy_ratio_h1 != null
    ? signal.net_buy_ratio_h1 >= 0.6 ? `buyers dominant (${Math.round(signal.net_buy_ratio_h1 * 100)}%)`
    : signal.net_buy_ratio_h1 <= 0.4 ? `sellers dominant (${Math.round((1 - signal.net_buy_ratio_h1) * 100)}%)`
    : `balanced (${Math.round(signal.net_buy_ratio_h1 * 100)}% buys)`
    : "?";
  return `vol_trend=${trend} | buy_pressure=${buyPressure} | 1h_change=${signal.price_change_h1 >= 0 ? "+" : ""}${signal.price_change_h1}%`;
}
