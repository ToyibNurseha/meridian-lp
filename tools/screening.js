import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked, getBlockedDevs } from "../dev-blocklist.js";
import { log } from "../logger.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { recordSkip } from "../skip-tracker.js";
import { confirmIndicatorPreset } from "./chart-indicators.js";
import { getVolumeSignal } from "./dexscreener.js";
import { getAgentMeridianBase, getAgentMeridianHeaders } from "./agent-meridian.js";
import { getGeckoSignalMap } from "./gecko.js";

const DATAPI_JUP = "https://datapi.jup.ag/v1";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
const PVP_SHORTLIST_LIMIT = 2;
const PVP_RIVAL_LIMIT = 2;
const PVP_MIN_ACTIVE_TVL = 5_000;
const PVP_MIN_HOLDERS = 500;
const PVP_MIN_GLOBAL_FEES_SOL = 30;

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function scoreCandidate(pool) {
  const feeTvl = Number(pool.fee_active_tvl_ratio || 0);
  const organic = Number(pool.organic_score || 0);
  const volume = Number(pool.volume_window || 0);
  const holders = Number(pool.holders || 0);
  const base = feeTvl * 1000 + organic * 10 + volume / 100 + holders / 100;
  // Cross-validation boost: pool appearing in GeckoTerminal trending/new is a 2nd-source signal
  const geckoBoost = pool.gecko_signal === "both" ? 200 : pool.gecko_signal ? 100 : 0;
  // Bitquery boost: fresh pool detected at creation = first-mover edge
  const bitqueryBoost = pool.bitquery_signal ? 150 : 0;
  // Helius boost: smart wallet opened a position here — strongest signal. Scales with signer count.
  const heliusBoost = pool.helius_signal ? 300 + (Array.isArray(pool.helius_signers) ? pool.helius_signers.length * 50 : 0) : 0;
  return base + geckoBoost + bitqueryBoost + heliusBoost;
}

function numeric(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isUsableVolatility(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function includesCaseInsensitive(values, value) {
  if (!Array.isArray(values) || values.length === 0 || !value) return false;
  const needle = String(value).toLowerCase();
  return values.some((entry) => String(entry).toLowerCase() === needle);
}

function getPoolLaunchpad(pool) {
  const base = pool?.token_x || {};
  return base?.launchpad ||
    base?.launchpad_platform ||
    pool?.base_token_launchpad ||
    pool?.launchpad ||
    pool?.launchpad_platform ||
    null;
}

function getPoolBaseMint(pool) {
  return pool?.token_x?.address ||
    pool?.base_token_address ||
    pool?.base_mint ||
    pool?.base?.mint ||
    null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function getRawPoolScreeningRejectReason(pool, s) {
  const base = pool?.token_x || {};
  const quote = pool?.token_y || {};
  const binStep = numeric(pool?.dlmm_params?.bin_step);
  const tvl = numeric(pool?.tvl ?? pool?.active_tvl);
  const feeActiveTvlRatio = numeric(pool?.fee_active_tvl_ratio);
  const volatility = numeric(pool?.volatility);
  const volume = numeric(pool?.volume);
  const holders = numeric(pool?.base_token_holders);
  const mcap = numeric(base?.market_cap);
  const baseOrganic = numeric(base?.organic_score);
  const quoteOrganic = numeric(quote?.organic_score);
  const launchpad = getPoolLaunchpad(pool);
  const createdAt = numeric(base?.created_at);

  if (s.excludeHighSupplyConcentration && pool?.base_token_has_high_supply_concentration === true) {
    return "base token has high supply concentration";
  }
  if (pool?.base_token_has_critical_warnings === true) return "base token has critical warnings";
  if (pool?.quote_token_has_critical_warnings === true) return "quote token has critical warnings";
  if (pool?.base_token_has_high_single_ownership === true) return "base token has high single ownership";
  if (pool?.pool_type && pool.pool_type !== "dlmm") return `pool_type ${pool.pool_type} is not dlmm`;

  if (mcap == null || mcap < s.minMcap) return `mcap ${mcap ?? "unknown"} below minMcap ${s.minMcap}`;
  if (mcap > s.maxMcap) return `mcap ${mcap} above maxMcap ${s.maxMcap}`;
  if (holders == null || holders < s.minHolders) return `holders ${holders ?? "unknown"} below minHolders ${s.minHolders}`;
  if (volume == null || volume < s.minVolume) return `volume ${volume ?? "unknown"} below minVolume ${s.minVolume}`;
  if (tvl == null || tvl < s.minTvl) return `TVL ${tvl ?? "unknown"} below minTvl ${s.minTvl}`;
  if (s.maxTvl != null && tvl > s.maxTvl) return `TVL ${tvl} above maxTvl ${s.maxTvl}`;
  if (binStep == null || binStep < s.minBinStep) return `bin_step ${binStep ?? "unknown"} below minBinStep ${s.minBinStep}`;
  if (binStep > s.maxBinStep) return `bin_step ${binStep} above maxBinStep ${s.maxBinStep}`;
  if (feeActiveTvlRatio == null || feeActiveTvlRatio < s.minFeeActiveTvlRatio) {
    return `fee/active-TVL ${feeActiveTvlRatio ?? "unknown"} below minFeeActiveTvlRatio ${s.minFeeActiveTvlRatio}`;
  }
  if (!isUsableVolatility(volatility)) {
    return `volatility ${volatility ?? "unknown"} is unusable`;
  }
  // Momentum-wait gate: skip pools that just pumped hard (no point deploying buy-the-dip
  // while price keeps ripping — will OOR upward immediately). Wait for consolidation.
  const recentPriceChange = numeric(pool?.pool_price_change_pct);
  if (
    s.maxRecentPumpPct != null &&
    Number.isFinite(s.maxRecentPumpPct) &&
    s.maxRecentPumpPct > 0 &&
    recentPriceChange != null &&
    recentPriceChange > s.maxRecentPumpPct
  ) {
    return `recent pump +${recentPriceChange.toFixed(1)}% > maxRecentPumpPct ${s.maxRecentPumpPct}%. Wait for consolidation.`;
  }
  if (baseOrganic == null || baseOrganic < s.minOrganic) {
    return `base organic ${baseOrganic ?? "unknown"} below minOrganic ${s.minOrganic}`;
  }
  if (quoteOrganic == null || quoteOrganic < s.minQuoteOrganic) {
    return `quote organic ${quoteOrganic ?? "unknown"} below minQuoteOrganic ${s.minQuoteOrganic}`;
  }
  if (
    pool?.discord_signal &&
    Array.isArray(s.allowedLaunchpads) &&
    s.allowedLaunchpads.length > 0 &&
    launchpad &&
    !includesCaseInsensitive(s.allowedLaunchpads, launchpad)
  ) {
    return `launchpad ${launchpad} not in allow-list`;
  }
  if (includesCaseInsensitive(s.blockedLaunchpads, launchpad)) {
    return `blocked launchpad (${launchpad})`;
  }
  if (s.minTokenAgeHours != null) {
    const maxCreatedAt = Date.now() - s.minTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt > maxCreatedAt) return `token age below minTokenAgeHours ${s.minTokenAgeHours}`;
  }
  if (s.maxTokenAgeHours != null) {
    const minCreatedAt = Date.now() - s.maxTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt < minCreatedAt) return `token age above maxTokenAgeHours ${s.maxTokenAgeHours}`;
  }
  return null;
}

async function fetchDiscordSignalCandidates() {
  const res = await fetch(`${getAgentMeridianBase()}/signals/discord/candidates`, {
    headers: getAgentMeridianHeaders(),
  });
  if (!res.ok) throw new Error(`discord signal candidates ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.candidates) ? data.candidates : [];
}

async function fetchHeliusSignalCandidates({ maxAgeMinutes = 30, limit = 20 } = {}) {
  const fs = await import("fs");
  const path = await import("path");
  const { fileURLToPath } = await import("url");
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../helius-signals.json");
  if (!fs.existsSync(file)) return [];

  let signals;
  try { signals = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
  if (!Array.isArray(signals)) return [];

  const cutoff = Date.now() - maxAgeMinutes * 60_000;
  const recent = signals
    .filter((s) => Array.isArray(s?.candidate_pool_addresses) && new Date(s.queued_at).getTime() >= cutoff)
    .slice(0, limit);
  if (recent.length === 0) return [];

  // Aggregate: for each candidate pool address, collect signers that touched it
  const byAddress = new Map();
  for (const s of recent) {
    for (const addr of s.candidate_pool_addresses) {
      if (!addr) continue;
      const entry = byAddress.get(addr) || { signers: new Set(), latestAt: 0 };
      entry.signers.add(s.signer);
      entry.latestAt = Math.max(entry.latestAt, new Date(s.queued_at).getTime());
      byAddress.set(addr, entry);
    }
  }
  return Array.from(byAddress.entries()).map(([address, info]) => ({
    address,
    signers: Array.from(info.signers),
    latest_at: new Date(info.latestAt).toISOString(),
  }));
}

async function fetchBitquerySignalCandidates({ maxAgeMinutes = 60, limit = 10 } = {}) {
  const fs = await import("fs");
  const path = await import("path");
  const { fileURLToPath } = await import("url");
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bitquery-signals.json");
  if (!fs.existsSync(file)) return [];

  let signals;
  try { signals = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
  if (!Array.isArray(signals)) return [];

  const cutoff = Date.now() - maxAgeMinutes * 60_000;
  const recent = signals
    .filter((s) => s?.pool_address && s.status !== "consumed" && new Date(s.queued_at).getTime() >= cutoff)
    .slice(0, limit);
  if (recent.length === 0) return [];

  const details = await Promise.allSettled(
    recent.map((s) => fetchPoolDiscoveryDetail({ poolAddress: s.pool_address, timeframe: config.screening.timeframe }))
  );

  return recent.map((s, i) => {
    const detail = details[i].status === "fulfilled" ? details[i].value : null;
    if (!detail) return null;
    return { signal: s, discovery_pool: detail };
  }).filter(Boolean);
}

async function fetchPoolDiscoveryPage({ page_size, filters, timeframe, category }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${timeframe}` +
    `&category=${category}`;

  log("screening", `API call [${category}/${timeframe}]: ${decodeURIComponent(url.split("filter_by=")[1]?.split("&")[0] ?? "").replace(/&&/g, " | ")}`);
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

async function fetchPoolDiscoveryDetail({ poolAddress, timeframe }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}` +
    `&timeframe=${timeframe}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return (data.data || [])[0] ?? null;
}

async function applyVolatilityTimeframe(rawPools, sourceTimeframe) {
  if (!Array.isArray(rawPools) || rawPools.length === 0) return rawPools;
  const volatilityTimeframe = getVolatilityTimeframe(sourceTimeframe);

  // Tag primary-timeframe values on every pool before any overwrite
  for (const pool of rawPools) {
    if (!pool) continue;
    pool[`volume_${sourceTimeframe}`] = pool.volume ?? null;
    pool[`volatility_${sourceTimeframe}`] = pool.volatility ?? null;
    pool.volatility_timeframe = volatilityTimeframe;
  }

  if (sourceTimeframe === volatilityTimeframe) return rawPools;

  const uniquePoolAddresses = [...new Set(rawPools.map((pool) => pool?.pool_address).filter(Boolean))];
  const longResults = await Promise.allSettled(
    uniquePoolAddresses.map((poolAddress) =>
      fetchPoolDiscoveryDetail({ poolAddress, timeframe: volatilityTimeframe })
        .then((pool) => ({
          poolAddress,
          volatility: numeric(pool?.volatility),
          volume: numeric(pool?.volume),
        }))
    )
  );

  const metricsByPool = new Map();
  for (const result of longResults) {
    if (result.status !== "fulfilled") continue;
    metricsByPool.set(result.value.poolAddress, result.value);
  }

  for (const pool of rawPools) {
    if (!pool?.pool_address) continue;
    const metrics = metricsByPool.get(pool.pool_address);
    if (!metrics) continue;

    pool[`volume_${volatilityTimeframe}`] = metrics.volume;
    pool[`volatility_${volatilityTimeframe}`] = metrics.volatility;

    // Use longer-timeframe values as the canonical ones for filtering
    if (metrics.volatility != null) pool.volatility = metrics.volatility;
    if (metrics.volume != null) pool.volume = metrics.volume;
  }

  return rawPools;
}

async function searchAssetsBySymbol(symbol) {
  const res = await fetch(`${DATAPI_JUP}/assets/search?query=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`assets/search ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [data];
}

async function enrichDiscordSignalLaunchpads(rawPools) {
  const missing = rawPools.filter((pool) =>
    pool?.discord_signal &&
    !getPoolLaunchpad(pool) &&
    getPoolBaseMint(pool)
  );
  if (missing.length === 0) return;

  const uniqueMints = [...new Set(missing.map(getPoolBaseMint).filter(Boolean))];
  const results = await Promise.allSettled(
    uniqueMints.map(async (mint) => {
      const assets = await searchAssetsBySymbol(mint);
      const asset = assets.find((item) => item?.id === mint) || assets[0] || null;
      return { mint, asset };
    })
  );

  const byMint = new Map();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const launchpad = result.value.asset?.launchpad || result.value.asset?.launchpadPlatform || null;
    if (!launchpad) continue;
    byMint.set(result.value.mint, {
      launchpad,
      dev: result.value.asset?.dev || null,
      holderCount: numeric(result.value.asset?.holderCount),
      organicScore: numeric(result.value.asset?.organicScore),
      marketCap: numeric(result.value.asset?.mcap ?? result.value.asset?.fdv),
      createdAt: result.value.asset?.createdAt ? Date.parse(result.value.asset.createdAt) : null,
    });
  }

  for (const pool of missing) {
    const mint = getPoolBaseMint(pool);
    const asset = byMint.get(mint);
    if (!asset) continue;
    pool.token_x ||= {};
    pool.token_x.launchpad = asset.launchpad;
    pool.base_token_launchpad = asset.launchpad;
    if (asset.dev && !pool.token_x.dev) pool.token_x.dev = asset.dev;
    if (asset.holderCount != null && pool.base_token_holders == null) pool.base_token_holders = asset.holderCount;
    if (asset.organicScore != null && pool.token_x.organic_score == null) pool.token_x.organic_score = asset.organicScore;
    if (asset.marketCap != null && pool.token_x.market_cap == null) pool.token_x.market_cap = asset.marketCap;
    if (asset.createdAt != null && pool.token_x.created_at == null) pool.token_x.created_at = asset.createdAt;
    log("screening", `Discord signal launchpad enriched from Jupiter: ${pool.name || mint} — ${asset.launchpad}`);
  }
}

async function findRivalPool(mint) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}&filter_by=${encodeURIComponent(`tvl>${PVP_MIN_ACTIVE_TVL}`)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`rival pool search ${res.status}`);
  const data = await res.json();
  const pools = Array.isArray(data?.data) ? data.data : [];
  return pools.find((pool) => pool?.token_x?.address === mint || pool?.token_y?.address === mint) || null;
}

async function enrichPvpRisk(pools) {
  const shortlist = [...pools]
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, PVP_SHORTLIST_LIMIT);

  if (shortlist.length === 0) return;

  const symbolCache = new Map();

  await Promise.all(shortlist.map(async (pool) => {
    const symbol = normalizeSymbol(pool.base?.symbol);
    const ownMint = pool.base?.mint;
    if (!symbol || !ownMint) return;

    let assets = symbolCache.get(symbol);
    if (!assets) {
      assets = await searchAssetsBySymbol(symbol).catch(() => []);
      symbolCache.set(symbol, assets);
    }

    const rivalAssets = assets
      .filter((asset) => normalizeSymbol(asset?.symbol) === symbol && asset?.id && asset.id !== ownMint)
      .sort((a, b) => Number(b?.liquidity || 0) - Number(a?.liquidity || 0))
      .slice(0, PVP_RIVAL_LIMIT);

    for (const rival of rivalAssets) {
      const rivalHolders = Number(rival?.holderCount || 0);
      const rivalFees = Number(rival?.fees || 0);
      if (rivalHolders < PVP_MIN_HOLDERS || rivalFees < PVP_MIN_GLOBAL_FEES_SOL) continue;

      const rivalPool = await findRivalPool(rival.id).catch(() => null);
      if (!rivalPool) continue;

      pool.is_pvp = true;
      pool.pvp_risk = "high";
      pool.pvp_symbol = pool.base?.symbol || symbol;
      pool.pvp_rival_name = rival?.name || pool.pvp_symbol;
      pool.pvp_rival_mint = rival.id;
      pool.pvp_rival_pool = rivalPool.address;
      pool.pvp_rival_tvl = round(Number(rivalPool.tvl || 0));
      pool.pvp_rival_holders = rivalHolders;
      pool.pvp_rival_fees = Number(rivalFees.toFixed(2));
      log("screening", `PVP guard: ${pool.name} has active rival ${pool.pvp_rival_name} (${rival.id.slice(0, 8)})`);
      break;
    }
  }));
}



/**
 * Refresh live metrics for discord-only signal pools.
 * Their discovery_pool is a snapshot from when the signal was captured — volume/volatility/fee
 * can be 0 even if the pool is active right now. We overwrite with fresh data from the
 * pool discovery API so filtering uses current numbers, not stale ones.
 */
async function refreshDiscordOnlyPools(pools, timeframe) {
  if (!pools.length) return;
  const FIELDS = ["volume", "fee", "active_tvl", "tvl", "volatility", "fee_active_tvl_ratio"];
  const results = await Promise.allSettled(
    pools.map((pool) =>
      fetchPoolDiscoveryDetail({ poolAddress: pool.pool_address, timeframe })
        .then((fresh) => ({ pool, fresh }))
    )
  );
  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value.fresh) continue;
    const { pool, fresh } = result.value;
    for (const field of FIELDS) {
      const val = numeric(fresh[field]);
      if (val != null) pool[field] = val;
    }
    log("screening", `Discord signal refreshed live data: ${pool.name || pool.pool_address} — vol=${pool.volume?.toFixed(0)} fee=${pool.fee?.toFixed(2)}`);
  }
}

/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */
export async function discoverPools({
  page_size = 100,
} = {}) {
  const s = config.screening;
  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    s.excludeHighSupplyConcentration ? "base_token_has_high_supply_concentration=false" : null,
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    s.maxTvl != null ? `tvl<=${s.maxTvl}` : null,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    `quote_token_organic_score>=${s.minQuoteOrganic}`,
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
    Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0
      ? `base_token_launchpad=[${s.allowedLaunchpads.join(",")}]`
      : null,
  ].filter(Boolean).join("&&");

  const categories = s.category === "trending+new"
    ? ["trending", "new"]
    : [s.category || "trending"];

  const categoryResults = await Promise.allSettled(
    categories.map((cat) => fetchPoolDiscoveryPage({ page_size, filters, timeframe: s.timeframe, category: cat }))
  );

  const seenAddresses = new Set();
  let rawPools = [];
  for (let i = 0; i < categoryResults.length; i++) {
    const result = categoryResults[i];
    if (result.status !== "fulfilled") {
      log("screening", `Category [${categories[i]}] failed: ${result.reason?.message || "unknown"}`);
      continue;
    }
    const returned = result.value?.data?.length ?? 0;
    const total = result.value?.total ?? 0;
    log("screening", `Category [${categories[i]}]: ${returned} returned (API total matching filters: ${total})`);
    for (const pool of (result.value?.data || [])) {
      const addr = pool?.pool_address;
      if (addr && !seenAddresses.has(addr)) {
        seenAddresses.add(addr);
        rawPools.push(pool);
      }
    }
  }
  log("screening", `Fetched ${rawPools.length} unique pools from [${categories.join("+")}]`);

  if (config.screening.useDiscordSignals) {
    const signalCandidates = await fetchDiscordSignalCandidates().catch((error) => {
      log("screening", `Discord signal fetch failed: ${error.message}`);
      return [];
    });
    const signalPools = signalCandidates
      .map((candidate) => {
        const discoveryPool = candidate.discovery_pool;
        if (!discoveryPool?.pool_address) return null;
        return {
          ...discoveryPool,
          discord_signal: true,
          discord_signal_count: candidate.source_count || 1,
          discord_signal_seen_count: candidate.seen_count || 1,
          discord_signal_first_seen_at: candidate.first_seen_at || null,
          discord_signal_last_seen_at: candidate.last_seen_at || null,
        };
      })
      .filter(Boolean);

    if (config.screening.discordSignalMode === "only") {
      rawPools = signalPools;
      // Refresh all signal pools with live data since discovery_pool is a stale snapshot
      await refreshDiscordOnlyPools(rawPools, s.timeframe);
    } else if (signalPools.length > 0) {
      const byPool = new Map(rawPools.map((pool) => [pool.pool_address, pool]));
      const discordOnlyPools = [];
      for (const signalPool of signalPools) {
        if (byPool.has(signalPool.pool_address)) {
          byPool.set(signalPool.pool_address, {
            ...byPool.get(signalPool.pool_address),
            discord_signal: true,
            discord_signal_count: signalPool.discord_signal_count,
            discord_signal_seen_count: signalPool.discord_signal_seen_count,
            discord_signal_first_seen_at: signalPool.discord_signal_first_seen_at,
            discord_signal_last_seen_at: signalPool.discord_signal_last_seen_at,
          });
        } else {
          byPool.set(signalPool.pool_address, signalPool);
          discordOnlyPools.push(signalPool);
        }
      }
      rawPools = Array.from(byPool.values());
      // Refresh discord-only pools with live data — their discovery_pool is a stale snapshot
      // so volume/volatility/fee may be 0 even when the pool is active right now
      if (discordOnlyPools.length > 0) {
        await refreshDiscordOnlyPools(discordOnlyPools, s.timeframe);
      }
    }
  }

  if (config.screening.useHeliusSignals !== false) {
    const heliusSignals = await fetchHeliusSignalCandidates().catch((error) => {
      log("screening", `Helius signal fetch failed: ${error.message}`);
      return [];
    });
    if (heliusSignals.length > 0) {
      const byPool = new Map(rawPools.map((p) => [p.pool_address, p]));
      const unmatched = [];
      let tagged = 0;
      for (const sig of heliusSignals) {
        if (byPool.has(sig.address)) {
          Object.assign(byPool.get(sig.address), {
            helius_signal: true,
            helius_signers: sig.signers,
            helius_signal_at: sig.latest_at,
          });
          tagged++;
        } else {
          unmatched.push(sig);
        }
      }
      if (unmatched.length > 0) {
        const details = await Promise.allSettled(
          unmatched.map((sig) => fetchPoolDiscoveryDetail({ poolAddress: sig.address, timeframe: s.timeframe }))
        );
        let injected = 0;
        for (let i = 0; i < unmatched.length; i++) {
          const detail = details[i].status === "fulfilled" ? details[i].value : null;
          if (!detail?.pool_address) continue;
          if (s.maxTokenAgeHours != null && detail.base_token_created_at != null) {
            const ageH = (Date.now() - detail.base_token_created_at) / 3_600_000;
            if (ageH > s.maxTokenAgeHours) {
              log("screening", `Helius inject skip: ${detail.name || detail.pool_address?.slice(0, 8)} — age ${Math.round(ageH)}h > maxTokenAgeHours ${s.maxTokenAgeHours}`);
              continue;
            }
          }
          if (s.minFeeActiveTvlRatio != null && detail.fee_active_tvl_ratio != null) {
            if (detail.fee_active_tvl_ratio < s.minFeeActiveTvlRatio) {
              log("screening", `Helius inject skip: ${detail.name || detail.pool_address?.slice(0, 8)} — fee/TVL ${detail.fee_active_tvl_ratio}% < min ${s.minFeeActiveTvlRatio}%`);
              continue;
            }
          }
          byPool.set(detail.pool_address, {
            ...detail,
            helius_signal: true,
            helius_signers: unmatched[i].signers,
            helius_signal_at: unmatched[i].latest_at,
          });
          injected++;
        }
        if (injected > 0) log("screening", `Helius: injected ${injected} smart-wallet pool(s) not in trending`);
      }
      rawPools = Array.from(byPool.values());
      if (tagged > 0) log("screening", `Helius: ${tagged} trending pool(s) also touched by smart wallets`);
    }
  }

  if (config.screening.useBitquerySignals !== false) {
    const bitquerySignals = await fetchBitquerySignalCandidates().catch((error) => {
      log("screening", `Bitquery signal fetch failed: ${error.message}`);
      return [];
    });
    if (bitquerySignals.length > 0) {
      const byPool = new Map(rawPools.map((p) => [p.pool_address, p]));
      let added = 0;
      for (const { signal, discovery_pool } of bitquerySignals) {
        const enriched = {
          ...discovery_pool,
          bitquery_signal: true,
          bitquery_signal_at: signal.queued_at,
          bitquery_signer: signal.signer || null,
        };
        if (byPool.has(discovery_pool.pool_address)) {
          Object.assign(byPool.get(discovery_pool.pool_address), {
            bitquery_signal: true,
            bitquery_signal_at: signal.queued_at,
            bitquery_signer: signal.signer || null,
          });
        } else {
          byPool.set(discovery_pool.pool_address, enriched);
          added++;
        }
      }
      rawPools = Array.from(byPool.values());
      if (added > 0) log("screening", `Bitquery: added ${added} fresh pool(s) not in trending list`);
    }
  }

  rawPools = await applyVolatilityTimeframe(rawPools, s.timeframe);
  await enrichDiscordSignalLaunchpads(rawPools);

  if (config.screening.useGeckoSignals !== false) {
    try {
      const geckoMap = await getGeckoSignalMap();
      let tagged = 0;
      for (const pool of rawPools) {
        const signal = geckoMap.get(pool?.pool_address);
        if (signal) {
          pool.gecko_signal = signal;
          tagged++;
        }
      }
      if (tagged > 0) log("screening", `Gecko cross-validation: ${tagged} pool(s) also trending/new on GeckoTerminal`);
    } catch (error) {
      log("screening", `Gecko signal fetch failed: ${error.message}`);
    }
  }

  const filteredExamples = [];
  const thresholdedRawPools = rawPools.filter((pool) => {
    const reason = getRawPoolScreeningRejectReason(pool, s);
    if (!reason) return true;
    filteredExamples.push({ name: pool.name || pool.pool_address || "unknown pool", reason });
    if (pool.discord_signal) log("screening", `Discord signal filtered: ${pool.name || pool.pool_address} — ${reason}`);
    try {
      recordSkip({
        pool: pool.pool_address,
        name: pool.name,
        reason,
        source: "screening",
        metrics: {
          volatility: pool.volatility,
          fee_active_tvl_ratio: pool.fee_active_tvl_ratio,
          mcap: pool.mcap,
          organic_score: pool.organic_score,
          holders: pool.holders,
          bin_step: pool.bin_step,
          price_at_skip: pool.current_price ?? pool.price,
          tvl: pool.tvl,
          volume_window: pool.volume_window,
          token_age_hours: pool.token_age_hours,
        },
      });
    } catch {}
    return false;
  });

  const condensed = thresholdedRawPools.map(condensePool);

  // Hard-filter blacklisted tokens and blocked deployers (what pool discovery already gave us)
  let pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    if (p.dev && isDevBlocked(p.dev)) {
      log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol} in pool ${p.name}`);
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens/devs`);

  // If pool discovery didn't supply dev field, batch-fetch from Jupiter for any pools
  // where dev is null — but only if the dev blocklist is non-empty (avoid useless calls)
  const blockedDevs = getBlockedDevs();
  if (Object.keys(blockedDevs).length > 0) {
    const missingDev = pools.filter((p) => !p.dev && p.base?.mint);
    if (missingDev.length > 0) {
      const devResults = await Promise.allSettled(
        missingDev.map((p) =>
          fetch(`${DATAPI_JUP}/assets/search?query=${p.base.mint}`)
            .then((r) => r.ok ? r.json() : null)
            .then((d) => {
              const t = Array.isArray(d) ? d[0] : d;
              return { pool: p.pool, dev: t?.dev || null };
            })
            .catch(() => ({ pool: p.pool, dev: null }))
        )
      );
      const devMap = {};
      for (const r of devResults) {
        if (r.status === "fulfilled") devMap[r.value.pool] = r.value.dev;
      }
      pools = pools.filter((p) => {
        const dev = devMap[p.pool];
        if (dev) p.dev = dev; // enrich in-place
        if (dev && isDevBlocked(dev)) {
          log("dev_blocklist", `Filtered blocked deployer (jup) ${dev.slice(0, 8)} token ${p.base?.symbol}`);
          return false;
        }
        return true;
      });
    }
  }

  const totalFromApi = categoryResults.reduce((acc, r) => {
    return acc + (r.status === "fulfilled" ? (r.value?.total ?? 0) : 0);
  }, 0);

  return {
    total: totalFromApi,
    pools,
    filtered_examples: filteredExamples,
  };
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
export async function getTopCandidates({ limit = 10 } = {}) {
  const { config } = await import("../config.js");
  const discovery = await discoverPools({ page_size: 100 });
  const { pools } = discovery;
  const filteredOut = Array.isArray(discovery.filtered_examples) ? [...discovery.filtered_examples] : [];

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));
  const minTvl = Number(config.screening.minTvl ?? 0);
  const maxTvl = config.screening.maxTvl == null ? null : Number(config.screening.maxTvl);
  const minFeeActiveTvlRatio = Number(config.screening.minFeeActiveTvlRatio ?? 0);

  let eligible = pools
    .filter((p) => {
      const tvl = Number(p.tvl ?? p.active_tvl ?? 0);
      if (Number.isFinite(minTvl) && minTvl > 0 && tvl < minTvl) {
        pushFilteredReason(filteredOut, p, `TVL $${tvl} below minTvl $${minTvl}`);
        return false;
      }
      if (Number.isFinite(maxTvl) && maxTvl > 0 && tvl > maxTvl) {
        pushFilteredReason(filteredOut, p, `TVL $${tvl} above maxTvl $${maxTvl}`);
        return false;
      }
      const feeActiveTvlRatio = Number(p.fee_active_tvl_ratio);
      if (Number.isFinite(minFeeActiveTvlRatio) && minFeeActiveTvlRatio > 0 && (!Number.isFinite(feeActiveTvlRatio) || feeActiveTvlRatio < minFeeActiveTvlRatio)) {
        pushFilteredReason(filteredOut, p, `fee/active-TVL ${Number.isFinite(feeActiveTvlRatio) ? feeActiveTvlRatio : "unknown"} below minFeeActiveTvlRatio ${minFeeActiveTvlRatio}`);
        return false;
      }
      if (!isUsableVolatility(p.volatility)) {
        pushFilteredReason(filteredOut, p, `volatility ${p.volatility ?? "unknown"} is unusable`);
        return false;
      }
      if (occupiedPools.has(p.pool)) {
        pushFilteredReason(filteredOut, p, "already have an open position in this pool");
        return false;
      }
      if (occupiedMints.has(p.base?.mint)) {
        pushFilteredReason(filteredOut, p, "already holding this base token in another pool");
        return false;
      }
      if (isPoolOnCooldown(p.pool)) {
        log("screening", `Filtered cooldown pool ${p.name} (${p.pool.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "pool cooldown active");
        return false;
      }
      if (isBaseMintOnCooldown(p.base?.mint)) {
        log("screening", `Filtered cooldown token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "token cooldown active");
        return false;
      }
      return true;
    })
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, limit);

  if (config.screening.avoidPvpSymbols && eligible.length > 0) {
    await enrichPvpRisk(eligible);
    if (config.screening.blockPvpSymbols) {
      const before = eligible.length;
      const pvpRemoved = eligible.filter((p) => p.is_pvp);
      pvpRemoved.forEach((p) => pushFilteredReason(filteredOut, p, "PVP hard filter"));
      eligible.splice(0, eligible.length, ...eligible.filter((p) => !p.is_pvp));
      if (eligible.length < before) {
        log("screening", `PVP hard filter removed ${before - eligible.length} pool(s)`);
      }
    }
  }

  // Enrich with OKX data — advanced info (risk/bundle/sniper) + ATH price (no API key required)
  if (eligible.length > 0) {
    const { getAdvancedInfo, getPriceInfo, getClusterList, getRiskFlags } = await import("./okx.js");
    const okxResults = await Promise.allSettled(
      eligible.map(async (p) => {
        if (!p.base?.mint) return { adv: null, price: null, clusters: [], risk: null };
        const [adv, price, clusters, risk] = await Promise.allSettled([
          getAdvancedInfo(p.base.mint),
          getPriceInfo(p.base.mint),
          getClusterList(p.base.mint),
          getRiskFlags(p.base.mint),
        ]);

        const mintShort = p.base.mint.slice(0, 8);
        if (adv.status !== "fulfilled")      log("okx", `advanced-info unavailable for ${p.name} (${mintShort})`);
        if (price.status !== "fulfilled")    log("okx", `price-info unavailable for ${p.name} (${mintShort})`);
        if (clusters.status !== "fulfilled") log("okx", `cluster-list unavailable for ${p.name} (${mintShort})`);
        if (risk.status !== "fulfilled")     log("okx", `risk-check unavailable for ${p.name} (${mintShort})`);

        return {
          adv: adv.status === "fulfilled" ? adv.value : null,
          price: price.status === "fulfilled" ? price.value : null,
          clusters: clusters.status === "fulfilled" ? clusters.value : [],
          risk: risk.status === "fulfilled" ? risk.value : null,
        };
      })
    );
    for (let i = 0; i < eligible.length; i++) {
      const r = okxResults[i];
      if (r.status !== "fulfilled") continue;
      const { adv, price, clusters, risk } = r.value;
      if (adv) {
        eligible[i].risk_level      = adv.risk_level;
        eligible[i].bundle_pct      = adv.bundle_pct;
        eligible[i].sniper_pct      = adv.sniper_pct;
        eligible[i].suspicious_pct  = adv.suspicious_pct;
        eligible[i].smart_money_buy = adv.smart_money_buy;
        eligible[i].dev_sold_all    = adv.dev_sold_all;
        eligible[i].dex_boost       = adv.dex_boost;
        eligible[i].dex_screener_paid = adv.dex_screener_paid;
        if (adv.creator && !eligible[i].dev) eligible[i].dev = adv.creator;
      }
      if (risk) {
        eligible[i].is_rugpull = risk.is_rugpull;
        eligible[i].is_wash    = risk.is_wash;
      }
      if (price) {
        eligible[i].price_vs_ath_pct = price.price_vs_ath_pct;
        eligible[i].ath              = price.ath;
      }
      if (clusters?.length) {
        // Surface KOL presence and top cluster trend for LLM
        eligible[i].kol_in_clusters      = clusters.some((c) => c.has_kol);
        eligible[i].top_cluster_trend    = clusters[0]?.trend ?? null;      // buy|sell|neutral
        eligible[i].top_cluster_hold_pct = clusters[0]?.holding_pct ?? null;
      }
    }
    // Wash trading hard filter — fake volume = misleading fee yield
    eligible.splice(0, eligible.length, ...eligible.filter((p) => {
      if (p.is_wash) {
        log("screening", `Risk filter: dropped ${p.name} — wash trading flagged`);
        pushFilteredReason(filteredOut, p, "wash trading flagged");
        return false;
      }
      return true;
    }));

    // Holder concentration hard filter — pre-fetch so LLM doesn't waste cycles
    // on pools with permanent disqualifiers. Static rejects also cooldown the
    // base mint so the same pool doesn't resurface every cycle.
    if (eligible.length > 0) {
      const { getTokenHolders } = await import("./token.js");
      const { cooldownBaseMint } = await import("../pool-memory.js");
      const cooldownHours = Number(config.screening.staticRejectCooldownHours ?? 24);
      const maxTop10 = Number(config.screening.maxTop10Pct ?? 100);
      const maxBots  = Number(config.screening.maxBotHoldersPct ?? 100);

      const holderResults = await Promise.allSettled(
        eligible.map((p) =>
          p.base?.mint
            ? getTokenHolders({ mint: p.base.mint, limit: 20 })
            : Promise.resolve(null)
        )
      );

      const survivors = [];
      for (let i = 0; i < eligible.length; i++) {
        const p = eligible[i];
        const r = holderResults[i];
        if (r.status !== "fulfilled" || !r.value) {
          survivors.push(p);
          continue;
        }
        const top10 = Number(r.value.top_10_real_holders_pct ?? 0);
        const botsPct = r.value.bot_holders_pct;
        p.top10_pct = top10;
        p.bot_holders_pct = botsPct;

        if (Number.isFinite(top10) && top10 > maxTop10) {
          const reason = `top10 concentration ${top10.toFixed(2)}% > maxTop10Pct ${maxTop10}%`;
          log("screening", `Static reject: ${p.name} — ${reason}`);
          pushFilteredReason(filteredOut, p, reason);
          cooldownBaseMint(p.base.mint, cooldownHours, reason);
          continue;
        }
        if (botsPct != null && Number.isFinite(botsPct) && botsPct > maxBots) {
          const reason = `bot holders ${botsPct.toFixed(2)}% > maxBotHoldersPct ${maxBots}%`;
          log("screening", `Static reject: ${p.name} — ${reason}`);
          pushFilteredReason(filteredOut, p, reason);
          cooldownBaseMint(p.base.mint, cooldownHours, reason);
          continue;
        }
        survivors.push(p);
      }
      const dropped = eligible.length - survivors.length;
      eligible.splice(0, eligible.length, ...survivors);
      if (dropped > 0) log("screening", `Holder concentration filter removed ${dropped} pool(s); base mints cooldowned for ${cooldownHours}h`);
    }

    // ATH filter — drop pools where price is too close to ATH
    const athFilter = config.screening.athFilterPct;
    if (athFilter != null) {
      const threshold = 100 + athFilter; // e.g. -20 → threshold = 80 (price must be <= 80% of ATH)
      const before = eligible.length;
      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        if (p.price_vs_ath_pct == null) return true; // no data → don't filter
        if (p.price_vs_ath_pct > threshold) {
          log("screening", `ATH filter: dropped ${p.name} — ${p.price_vs_ath_pct}% of ATH (limit: ${threshold}%)`);
          pushFilteredReason(filteredOut, p, `${p.price_vs_ath_pct}% of ATH > ${threshold}% limit`);
          return false;
        }
        return true;
      }));
      if (eligible.length < before) log("screening", `ATH filter removed ${before - eligible.length} pool(s)`);
    }

    // Drop any pools whose creator is on the dev blocklist (caught via advanced-info)
    const before = eligible.length;
    const filtered = eligible.filter((p) => {
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer (okx) ${p.dev.slice(0, 8)} token ${p.base?.symbol}`);
        pushFilteredReason(filteredOut, p, "blocked deployer");
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...filtered);
    if (eligible.length < before) log("dev_blocklist", `Filtered ${before - eligible.length} pool(s) via OKX creator check`);
  }

  // Enrich with DexScreener volume trend — passive signal, no hard filter
  if (eligible.length > 0) {
    const volResults = await Promise.allSettled(
      eligible.map((pool) => getVolumeSignal(pool.pool))
    );
    volResults.forEach((r, i) => {
      eligible[i].dex_volume = r.status === "fulfilled" ? r.value : null;
    });
  }

  // Pump gate using DexScreener as fallback for Helius-injected pools where
  // pool_price_change_pct is null (bypasses the earlier getRawPoolScreeningRejectReason gate)
  const maxPump = config.screening.maxRecentPumpPct;
  if (maxPump != null && Number.isFinite(maxPump) && maxPump > 0) {
    const before = eligible.length;
    eligible = eligible.filter((pool) => {
      if (pool.price_change_pct != null) return true; // already checked in getRawPoolScreeningRejectReason
      const dexChange = pool.dex_volume?.price_change_h1;
      if (dexChange == null || !Number.isFinite(dexChange) || dexChange <= maxPump) return true;
      log("screening", `Pump gate (dex fallback): dropped ${pool.name} — 1h +${dexChange}% > maxRecentPumpPct ${maxPump}%`);
      pushFilteredReason(filteredOut, pool, `recent pump +${dexChange.toFixed(1)}% > maxRecentPumpPct ${maxPump}% (dex signal)`);
      return false;
    });
    if (eligible.length < before) log("screening", `Pump gate removed ${before - eligible.length} candidate(s) via DexScreener fallback`);
  }

  if (config.indicators.enabled && eligible.length > 0) {
    const confirmations = await Promise.all(
      eligible.map(async (pool) => {
        try {
          const confirmation = await confirmIndicatorPreset({
            mint: pool.base?.mint,
            side: "entry",
          });
          return { pool: pool.pool, confirmation };
        } catch (error) {
          return {
            pool: pool.pool,
            confirmation: {
              enabled: true,
              confirmed: true,
              skipped: true,
              reason: `Indicator confirmation unavailable: ${error.message}`,
              intervals: [],
            },
          };
        }
      }),
    );
    const confirmationByPool = new Map(confirmations.map((entry) => [entry.pool, entry.confirmation]));
    const before = eligible.length;
    const confirmedEligible = eligible.filter((pool) => {
      const confirmation = confirmationByPool.get(pool.pool);
      pool.indicator_confirmation = confirmation || null;
      if (!confirmation || confirmation.confirmed) return true;
      pushFilteredReason(filteredOut, pool, `indicator reject: ${confirmation.reason}`);
      log("screening", `Indicator rejected ${pool.name} (${pool.pool.slice(0, 8)}): ${confirmation.reason}`);
      return false;
    });
    eligible.splice(0, eligible.length, ...confirmedEligible);
    if (eligible.length < before) {
      log("screening", `Indicator confirmation removed ${before - eligible.length} candidate(s)`);
    }
  }

  return {
    candidates: eligible,
    total_screened: pools.length,
    filtered_examples: filteredOut.slice(0, 3),
  };
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const pool = await fetchPoolDiscoveryDetail({ poolAddress: pool_address, timeframe });

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  return pool;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics (the numbers that matter)
    tvl: round(p.tvl),
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    fee_active_tvl_ratio: p.fee_active_tvl_ratio != null ? fix(p.fee_active_tvl_ratio, 4) : null,
    volatility: fix(p.volatility, 4),
    volatility_timeframe: p.volatility_timeframe || getVolatilityTimeframe(config.screening.timeframe),

    // Per-timeframe breakdown (populated when sourceTimeframe !== volatilityTimeframe)
    ...(p.volatility_timeframe && p.volatility_timeframe !== config.screening.timeframe ? {
      [`volume_${config.screening.timeframe}`]: round(p[`volume_${config.screening.timeframe}`] ?? null),
      [`volume_${p.volatility_timeframe}`]: round(p[`volume_${p.volatility_timeframe}`] ?? null),
      [`volatility_${config.screening.timeframe}`]: fix(p[`volatility_${config.screening.timeframe}`] ?? null, 4),
      [`volatility_${p.volatility_timeframe}`]: fix(p[`volatility_${p.volatility_timeframe}`] ?? null, 4),
    } : {}),

    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    dev: p.token_x?.dev || null,
    launchpad: getPoolLaunchpad(p),

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,
    discord_signal: Boolean(p.discord_signal),
    discord_signal_count: p.discord_signal_count || 0,
    discord_signal_seen_count: p.discord_signal_seen_count || 0,
    discord_signal_last_seen_at: p.discord_signal_last_seen_at || null,
    gecko_signal: p.gecko_signal || null,
    bitquery_signal: Boolean(p.bitquery_signal),
    bitquery_signal_at: p.bitquery_signal_at || null,
    helius_signal: Boolean(p.helius_signal),
    helius_signers: p.helius_signers || null,
    helius_signal_at: p.helius_signal_at || null,

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,
  };
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  const value = Number(n);
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : null;
}

function pushFilteredReason(list, pool, reason) {
  if (!list || !pool) return;
  list.push({
    name: pool.name || `${pool.base?.symbol || "?"}-${pool.quote?.symbol || "?"}`,
    reason,
  });
}
