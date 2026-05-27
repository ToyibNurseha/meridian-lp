/**
 * skip-tracker.js
 *
 * Records every pool the bot rejected (screening filter OR safety block) along with
 * the metrics that led to rejection. A cron job periodically re-fetches pool prices
 * to determine what would have happened if we had deployed.
 *
 * Goal: answer "are our filters too tight?" with data, not anecdotes.
 *
 * skip-log.json schema:
 *   {
 *     "skips": [
 *       {
 *         "ts": ISO,
 *         "pool": addr,
 *         "name": "X-SOL",
 *         "reason": "volatility 7.28 > maxVolatility 2.6",
 *         "source": "screening" | "safety_block",
 *         "metrics": { vol, fee_tvl, mcap, smart_wallets, organic, price_at_skip, mcap_at_skip, ... },
 *         "outcomes": {
 *           "1h":  { checked_at, price, change_pct },
 *           "4h":  { ... },
 *           "24h": { ... }
 *         },
 *         "completed": false
 *       }
 *     ]
 *   }
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKIP_LOG_PATH = path.join(__dirname, "skip-log.json");
const MAX_ENTRIES = 1000;
const HORIZONS_MIN = { "1h": 60, "4h": 240, "24h": 1440 };
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";

function load() {
  if (!fs.existsSync(SKIP_LOG_PATH)) return { skips: [] };
  try {
    return JSON.parse(fs.readFileSync(SKIP_LOG_PATH, "utf8"));
  } catch {
    return { skips: [] };
  }
}

function save(data) {
  fs.writeFileSync(SKIP_LOG_PATH, JSON.stringify(data, null, 2));
}

export function recordSkip({ pool, name, reason, source = "screening", metrics = {} }) {
  if (!pool || !reason) return;
  const db = load();
  // Dedupe: don't double-record same pool within 30min
  const cutoff = Date.now() - 30 * 60 * 1000;
  const recent = db.skips.find(
    (s) => s.pool === pool && new Date(s.ts).getTime() >= cutoff
  );
  if (recent) return;

  const entry = {
    ts: new Date().toISOString(),
    pool,
    name: name || pool.slice(0, 8),
    reason: String(reason).slice(0, 200),
    source,
    metrics: {
      volatility: metrics.volatility ?? null,
      fee_active_tvl_ratio: metrics.fee_active_tvl_ratio ?? null,
      mcap: metrics.mcap ?? null,
      smart_wallets: metrics.smart_wallets ?? null,
      organic_score: metrics.organic_score ?? null,
      holders: metrics.holders ?? null,
      bin_step: metrics.bin_step ?? null,
      price_at_skip: metrics.price_at_skip ?? null,
      tvl: metrics.tvl ?? null,
      volume_window: metrics.volume_window ?? null,
      token_age_hours: metrics.token_age_hours ?? null,
    },
    outcomes: {
      "1h": { checked_at: null, price: null, change_pct: null },
      "4h": { checked_at: null, price: null, change_pct: null },
      "24h": { checked_at: null, price: null, change_pct: null },
    },
    completed: false,
  };

  db.skips.push(entry);
  if (db.skips.length > MAX_ENTRIES) db.skips = db.skips.slice(-MAX_ENTRIES);
  save(db);
}

async function fetchCurrentPrice(poolAddress) {
  try {
    const filter = encodeURIComponent(`pool_address=${poolAddress}`);
    const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=5m`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const pool = (data?.data || [])[0];
    if (!pool) return null;
    const price = Number(pool.current_price ?? pool.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

export async function evaluateSkips() {
  const db = load();
  const now = Date.now();
  let updated = 0;

  for (const entry of db.skips) {
    if (entry.completed) continue;
    const ageMin = (now - new Date(entry.ts).getTime()) / 60000;
    const priceAtSkip = Number(entry.metrics?.price_at_skip);
    if (!Number.isFinite(priceAtSkip) || priceAtSkip <= 0) {
      // No baseline price to compare — mark complete to stop revisiting
      if (ageMin >= 1440) entry.completed = true;
      continue;
    }

    let needsFetch = false;
    for (const [horizon, minutes] of Object.entries(HORIZONS_MIN)) {
      if (ageMin < minutes) continue;
      if (entry.outcomes[horizon]?.price != null) continue;
      needsFetch = true;
    }
    if (!needsFetch) {
      if (ageMin >= 1440) entry.completed = true;
      continue;
    }

    const currentPrice = await fetchCurrentPrice(entry.pool);
    if (currentPrice == null) {
      // Pool may have died — mark completed if old enough
      if (ageMin >= 1440) entry.completed = true;
      continue;
    }
    const changePct = ((currentPrice - priceAtSkip) / priceAtSkip) * 100;

    for (const [horizon, minutes] of Object.entries(HORIZONS_MIN)) {
      if (ageMin < minutes) continue;
      if (entry.outcomes[horizon]?.price != null) continue;
      entry.outcomes[horizon] = {
        checked_at: new Date().toISOString(),
        price: currentPrice,
        change_pct: Math.round(changePct * 100) / 100,
      };
      updated++;
    }
    if (ageMin >= 1440 && entry.outcomes["24h"]?.price != null) {
      entry.completed = true;
    }
    // tiny delay to be RPC-friendly
    await new Promise((r) => setTimeout(r, 150));
  }

  if (updated > 0) {
    save(db);
    log("skip_tracker", `Evaluated skips — ${updated} outcome(s) updated`);
  }
  return { updated, total_pending: db.skips.filter((s) => !s.completed).length };
}

export function getSkipStats({ days = 7 } = {}) {
  const db = load();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const eligible = db.skips.filter(
    (s) => new Date(s.ts).getTime() >= cutoff && s.outcomes["4h"]?.price != null
  );
  if (eligible.length === 0) {
    return { window_days: days, sample_count: 0, message: "No completed 4h outcomes yet" };
  }

  const stats = { window_days: days, sample_count: eligible.length };

  for (const horizon of ["1h", "4h", "24h"]) {
    const samples = eligible.filter((s) => s.outcomes[horizon]?.change_pct != null);
    if (samples.length === 0) continue;
    const changes = samples.map((s) => s.outcomes[horizon].change_pct);
    const wins = changes.filter((c) => c > 5).length;
    const losses = changes.filter((c) => c < -5).length;
    const flat = changes.length - wins - losses;
    const avg = changes.reduce((a, b) => a + b, 0) / changes.length;
    stats[horizon] = {
      samples: samples.length,
      avg_change_pct: Math.round(avg * 100) / 100,
      wins_gt5: wins,
      losses_lt_neg5: losses,
      flat_within_5: flat,
      win_rate: Math.round((wins / samples.length) * 1000) / 10, // as %
    };
  }

  // Break down by reason category
  const byReason = {};
  for (const s of eligible) {
    const reasonKey = String(s.reason).split(/[:.]/)[0].slice(0, 40);
    if (!byReason[reasonKey]) byReason[reasonKey] = { count: 0, total_change_4h: 0, wins: 0 };
    byReason[reasonKey].count++;
    if (s.outcomes["4h"]?.change_pct != null) {
      byReason[reasonKey].total_change_4h += s.outcomes["4h"].change_pct;
      if (s.outcomes["4h"].change_pct > 5) byReason[reasonKey].wins++;
    }
  }
  for (const k of Object.keys(byReason)) {
    const r = byReason[k];
    r.avg_change_4h = Math.round((r.total_change_4h / r.count) * 100) / 100;
    delete r.total_change_4h;
  }
  stats.by_reason = byReason;

  return stats;
}
