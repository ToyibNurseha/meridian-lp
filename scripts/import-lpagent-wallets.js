#!/usr/bin/env node
/**
 * import-lpagent-wallets.js
 *
 * Imports top-performing LPer wallets from LPAgent (via Agent Meridian proxy)
 * into smart-wallets.json. Source tag: "lpagent-top".
 *
 * Pipeline:
 *   1. Fetch raw top N hot Meteora DLMM pools (no screening filters).
 *   2. For each pool, GET /top-lp/{poolAddress} via Agent Meridian.
 *   3. Filter owners passing minWinRate / minRoi / minTotalPnl.
 *   4. Merge into smart-wallets.json with source="lpagent-top".
 *
 * Env:
 *   LPAGENT_TOP_POOLS     default 50
 *   LPAGENT_MIN_WIN_RATE  default 70  (percent)
 *   LPAGENT_MIN_ROI_PCT   default 10  (percent)
 *   LPAGENT_MIN_PNL_USD   default 100 (lifetime PnL floor)
 *   LPAGENT_MAX_KEEP      default 200 (cap of total wallets in file)
 *
 * Usage:
 *   node scripts/import-lpagent-wallets.js
 *   node scripts/import-lpagent-wallets.js --dry-run
 *   node scripts/import-lpagent-wallets.js --top 30 --min-win-rate 60
 */

import "../envcrypt.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { agentMeridianJson, getAgentMeridianHeaders } from "../tools/agent-meridian.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WALLETS_PATH = path.resolve(__dirname, "../smart-wallets.json");
const SOURCE_TAG = "lpagent-top";
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";

function parseArgs() {
  const args = process.argv.slice(2);
  let topPools = Number(process.env.LPAGENT_TOP_POOLS) || 50;
  let minWinRate = Number(process.env.LPAGENT_MIN_WIN_RATE) || 70;
  let minRoi = Number(process.env.LPAGENT_MIN_ROI_PCT) || 10;
  let minPnlUsd = Number(process.env.LPAGENT_MIN_PNL_USD) || 100;
  let maxKeep = Number(process.env.LPAGENT_MAX_KEEP) || 200;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--top" && args[i + 1]) topPools = Number(args[++i]);
    else if (args[i] === "--min-win-rate" && args[i + 1]) minWinRate = Number(args[++i]);
    else if (args[i] === "--min-roi" && args[i + 1]) minRoi = Number(args[++i]);
    else if (args[i] === "--min-pnl-usd" && args[i + 1]) minPnlUsd = Number(args[++i]);
    else if (args[i] === "--max-keep" && args[i + 1]) maxKeep = Number(args[++i]);
    else if (args[i] === "--dry-run") dryRun = true;
  }
  return { topPools, minWinRate, minRoi, minPnlUsd, maxKeep, dryRun };
}

function loadWallets() {
  if (!fs.existsSync(WALLETS_PATH)) return { wallets: [] };
  try { return JSON.parse(fs.readFileSync(WALLETS_PATH, "utf8")); } catch { return { wallets: [] }; }
}

function saveWallets(data) {
  fs.writeFileSync(WALLETS_PATH, JSON.stringify(data, null, 2));
}

async function fetchTopPools(limit) {
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=${Math.max(limit, 50)}&timeframe=5m&category=trending`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Meteora API ${res.status}`);
  const data = await res.json();
  return (data?.data || []).slice(0, limit).map((p) => ({
    pool: p.pool_address,
    name: p.name,
  }));
}

async function fetchTopLpersForPool(poolAddress) {
  try {
    const data = await agentMeridianJson(`/top-lp/${poolAddress}`, {
      headers: getAgentMeridianHeaders(),
    });
    return Array.isArray(data?.topLpers) ? data.topLpers : [];
  } catch (err) {
    return null; // signal failure
  }
}

async function main() {
  const opts = parseArgs();

  console.log(`Fetching raw top ${opts.topPools} hot Meteora pools...`);
  const pools = await fetchTopPools(opts.topPools);
  if (pools.length === 0) {
    console.error("No pools returned. Aborting.");
    process.exit(1);
  }
  console.log(`Got ${pools.length} pools. Querying LPAgent /top-lp per pool...`);

  // Map of owner -> aggregate qualifying stats across pools
  const candidates = new Map();
  let polled = 0;
  let failed = 0;

  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i];
    const lpers = await fetchTopLpersForPool(pool.pool);
    if (lpers === null) {
      failed++;
      console.log(`  [${i + 1}/${pools.length}] ${pool.name?.padEnd(20) || pool.pool.slice(0, 12)} → LPAgent error, skipped`);
    } else {
      polled++;
      let added = 0;
      for (const lp of lpers) {
        const winRate = Number(lp.winRatePct ?? 0);
        const roi = Number(lp.roiPct ?? 0);
        const totalPnl = Number(lp.totalPnlUsd ?? 0);
        if (winRate < opts.minWinRate) continue;
        if (roi < opts.minRoi) continue;
        if (totalPnl < opts.minPnlUsd) continue;
        if (!lp.owner) continue;

        const prev = candidates.get(lp.owner) || {
          address: lp.owner,
          pool_count: 0,
          best_win_rate: 0,
          best_roi: 0,
          best_pnl_usd: 0,
        };
        prev.pool_count += 1;
        if (winRate > prev.best_win_rate) prev.best_win_rate = winRate;
        if (roi > prev.best_roi) prev.best_roi = roi;
        if (totalPnl > prev.best_pnl_usd) prev.best_pnl_usd = totalPnl;
        candidates.set(lp.owner, prev);
        added++;
      }
      console.log(`  [${i + 1}/${pools.length}] ${pool.name?.padEnd(20) || pool.pool.slice(0, 12)} → ${lpers.length} LPers, ${added} qualifying`);
    }
    if (i < pools.length - 1) await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`\nPolled ${polled} pools (${failed} failed). Found ${candidates.size} unique qualifying wallets.`);

  if (candidates.size === 0) {
    console.log("No wallets qualified. Lower thresholds and retry.");
    return;
  }

  // Sort by composite quality score, cap to maxKeep
  const ranked = [...candidates.values()]
    .map((c) => ({
      ...c,
      score: c.best_pnl_usd * (c.best_win_rate / 100) * Math.min(c.pool_count, 5),
    }))
    .sort((a, b) => b.score - a.score);

  // Merge with existing wallets file
  const existing = loadWallets();
  const byAddr = new Map((existing.wallets || []).map((w) => [w.address, w]));
  let added = 0;
  let refreshed = 0;

  for (const cand of ranked) {
    const incoming = {
      name: `lpa-${cand.address.slice(0, 6)}`,
      address: cand.address,
      category: "kol_alpha",
      type: "lp",
      source: SOURCE_TAG,
      best_win_rate: cand.best_win_rate,
      best_roi_pct: cand.best_roi,
      best_pnl_usd: Math.round(cand.best_pnl_usd),
      pool_count: cand.pool_count,
      score: Math.round(cand.score),
      addedAt: new Date().toISOString(),
    };
    if (byAddr.has(cand.address)) {
      const prev = byAddr.get(cand.address);
      if (prev.source === SOURCE_TAG) {
        byAddr.set(cand.address, { ...prev, ...incoming, addedAt: prev.addedAt });
        refreshed++;
      }
      // else: keep existing (manual/onchain takes precedence)
    } else {
      byAddr.set(cand.address, incoming);
      added++;
    }
  }

  // Cap total to maxKeep
  let finalWallets = [...byAddr.values()];
  if (finalWallets.length > opts.maxKeep) {
    // Keep all non-lpagent wallets + top-scored lpagent ones
    const nonLpa = finalWallets.filter((w) => w.source !== SOURCE_TAG);
    const lpa = finalWallets.filter((w) => w.source === SOURCE_TAG)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const room = Math.max(0, opts.maxKeep - nonLpa.length);
    finalWallets = [...nonLpa, ...lpa.slice(0, room)];
  }

  console.log(`\nMerge result:`);
  console.log(`  Added new:    ${added}`);
  console.log(`  Refreshed:    ${refreshed}`);
  console.log(`  Total in file: ${finalWallets.length} (cap: ${opts.maxKeep})`);

  if (opts.dryRun) {
    console.log("\n[DRY RUN] No file written.");
    console.log("Top 10 by score:");
    ranked.slice(0, 10).forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.address}  win=${c.best_win_rate}%  roi=${c.best_roi}%  pnl=$${Math.round(c.best_pnl_usd)}  pools=${c.pool_count}`);
    });
    return;
  }

  saveWallets({ ...existing, wallets: finalWallets });
  console.log(`\nWritten to ${WALLETS_PATH}`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
