/**
 * GeckoTerminal API — free, no key required.
 * Cross-validates Meteora API candidates against GeckoTerminal's view:
 *   - trending = top DLMM pools by 24h volume (from DLMM-specific endpoint)
 *   - new      = recently created pools (from network-wide new_pools, filtered to DLMM)
 *
 * Rate limit: 30 req/min free tier. We use ≤3 req per cycle, cached 60s.
 */

import { log } from "../logger.js";

const BASE = "https://api.geckoterminal.com/api/v2";
const NETWORK = "solana";
const DLMM_DEX_ID = "meteora";
const TRENDING_PAGES = 2; // 2 × 20 = top 40 DLMM pools by 24h volume
const CACHE_TTL_MS = 60_000;
const HEADERS = { Accept: "application/json;version=20230302" };

let _cache = { trending: [], new: [], fetchedAt: 0 };

async function fetchTrendingPage(page) {
  const url = `${BASE}/networks/${NETWORK}/dexes/${DLMM_DEX_ID}/pools?page=${page}&sort=h24_volume_usd_desc`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`gecko trending p${page} ${res.status}`);
  const json = await res.json();
  return (json?.data || []).map((p) => p?.attributes?.address).filter(Boolean);
}

async function fetchNewDlmmPools() {
  const url = `${BASE}/networks/${NETWORK}/new_pools?page=1`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`gecko new_pools ${res.status}`);
  const json = await res.json();
  return (json?.data || [])
    .filter((p) => p?.relationships?.dex?.data?.id === DLMM_DEX_ID)
    .map((p) => p?.attributes?.address)
    .filter(Boolean);
}

/**
 * Returns Map<poolAddress, "trending"|"new"|"both">.
 * Cached 60s. Failures degrade gracefully — partial maps still useful.
 */
export async function getGeckoSignalMap() {
  if (Date.now() - _cache.fetchedAt < CACHE_TTL_MS && (_cache.trending.length || _cache.new.length)) {
    return buildSignalMap(_cache.trending, _cache.new);
  }

  const trendingTasks = Array.from({ length: TRENDING_PAGES }, (_, i) =>
    fetchTrendingPage(i + 1).catch((e) => {
      log("gecko", `trending p${i + 1} failed: ${e.message}`);
      return [];
    })
  );
  const [trendingPages, fresh] = await Promise.all([
    Promise.all(trendingTasks),
    fetchNewDlmmPools().catch((e) => {
      log("gecko", `new_pools failed: ${e.message}`);
      return [];
    }),
  ]);
  const trending = trendingPages.flat();

  _cache = { trending, new: fresh, fetchedAt: Date.now() };
  log("gecko", `Fetched ${trending.length} top-volume + ${fresh.length} newly-created DLMM pools`);
  return buildSignalMap(trending, fresh);
}

function buildSignalMap(trending, fresh) {
  const map = new Map();
  for (const addr of trending) map.set(addr, "trending");
  for (const addr of fresh) map.set(addr, map.has(addr) ? "both" : "new");
  return map;
}
