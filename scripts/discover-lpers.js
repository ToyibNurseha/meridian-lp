#!/usr/bin/env node
/**
 * discover-lpers.js
 *
 * Path D — on-chain aggregation. No external leaderboard needed.
 *
 * 1. Fetch top N hot Meteora DLMM pools from Meteora's public API.
 * 2. For each pool, query Meteora program for PositionV2 accounts with
 *    `lb_pair` matching the pool (memcmp filter via SDK helpers).
 * 3. Extract `owner` (the LPer wallet) from each position.
 * 4. Aggregate cross-pool: wallets active in ≥minPoolCount hot pools = smart LPers.
 * 5. Merge into smart-wallets.json with source="onchain-discovery".
 *
 * Env:
 *   RPC_URL           required — Solana RPC (Helius recommended for getProgramAccounts)
 *   DISCOVERY_TOP_POOLS   optional, default 30
 *   DISCOVERY_MIN_POOLS   optional, default 2 (min pools to qualify a wallet)
 *   DISCOVERY_MAX_KEEP    optional, default 100 (cap of wallets written)
 *
 * Usage:
 *   node scripts/discover-lpers.js
 *   node scripts/discover-lpers.js --dry-run
 *   node scripts/discover-lpers.js --top 20 --min-pools 3
 */

import "../envcrypt.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Connection, PublicKey } from "@solana/web3.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WALLETS_PATH = path.resolve(__dirname, "../smart-wallets.json");
const SOURCE_TAG = "onchain-discovery";

function parseArgs() {
  const args = process.argv.slice(2);
  let topPools = Number(process.env.DISCOVERY_TOP_POOLS) || 30;
  let minPools = Number(process.env.DISCOVERY_MIN_POOLS) || 2;
  let maxKeep = Number(process.env.DISCOVERY_MAX_KEEP) || 100;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--top" && args[i + 1]) topPools = Number(args[++i]);
    else if (args[i] === "--min-pools" && args[i + 1]) minPools = Number(args[++i]);
    else if (args[i] === "--max-keep" && args[i + 1]) maxKeep = Number(args[++i]);
    else if (args[i] === "--dry-run") dryRun = true;
  }
  return { topPools, minPools, maxKeep, dryRun };
}

function loadWallets() {
  if (!fs.existsSync(WALLETS_PATH)) return { wallets: [] };
  try { return JSON.parse(fs.readFileSync(WALLETS_PATH, "utf8")); } catch { return { wallets: [] }; }
}

function saveWallets(data) {
  fs.writeFileSync(WALLETS_PATH, JSON.stringify(data, null, 2));
}

function mergeWallets(existing, incoming) {
  const byAddr = new Map(existing.map((w) => [w.address, w]));
  let added = 0;
  let refreshed = 0;
  for (const entry of incoming) {
    if (byAddr.has(entry.address)) {
      const prev = byAddr.get(entry.address);
      if (prev.source === SOURCE_TAG) {
        byAddr.set(entry.address, { ...prev, ...entry, addedAt: prev.addedAt });
        refreshed++;
      }
    } else {
      byAddr.set(entry.address, { ...entry, addedAt: new Date().toISOString() });
      added++;
    }
  }
  return { wallets: Array.from(byAddr.values()), added, refreshed };
}

function pruneStale(wallets, freshAddrs) {
  const fresh = new Set(freshAddrs);
  const before = wallets.length;
  const kept = wallets.filter((w) => w.source !== SOURCE_TAG || fresh.has(w.address));
  return { wallets: kept, pruned: before - kept.length };
}

async function main() {
  const opts = parseArgs();
  if (!process.env.RPC_URL) {
    console.error("ERROR: RPC_URL not set in .env");
    process.exit(1);
  }

  const dlmm = await import("@meteora-ag/dlmm");
  const {
    createProgram,
    chunkedGetProgramAccounts,
    positionV2Filter,
    positionLbPairFilter,
    LBCLMM_PROGRAM_IDS,
    wrapPosition,
  } = dlmm;

  // Fetch RAW Meteora pool list directly — bypass screening filters so wallet
  // discovery is not constrained by deploy thresholds (mcap/vol/organic etc).
  console.log(`Fetching top ${opts.topPools} hot Meteora pools (raw, no screening filters)...`);
  const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
  const rawUrl = `${POOL_DISCOVERY_BASE}/pools?page_size=${Math.max(opts.topPools, 50)}&timeframe=5m&category=trending`;
  let pools = [];
  try {
    const res = await fetch(rawUrl);
    if (!res.ok) throw new Error(`Meteora API ${res.status}`);
    const data = await res.json();
    pools = (data?.data || []).map((p) => ({
      pool: p.pool_address,
      name: p.name,
      tvl: p.tvl,
      volume_window: p.volume_window,
    }));
  } catch (err) {
    console.error(`Raw pool fetch failed: ${err.message}`);
    process.exit(1);
  }
  const topPools = pools.slice(0, opts.topPools);
  if (topPools.length === 0) {
    console.error("No pools returned from discovery. Aborting.");
    process.exit(1);
  }
  console.log(`Got ${topPools.length} pools. Querying position holders per pool...`);

  const connection = new Connection(process.env.RPC_URL, "confirmed");
  const program = createProgram(connection);
  const programId = new PublicKey(LBCLMM_PROGRAM_IDS["mainnet-beta"]);

  // owner address -> { pools: Set<poolAddress>, totalPositions: number }
  const ownerStats = new Map();

  for (let i = 0; i < topPools.length; i++) {
    const pool = topPools[i];
    const lbPair = new PublicKey(pool.pool);
    try {
      const accounts = await chunkedGetProgramAccounts(
        connection,
        programId,
        [positionV2Filter(), positionLbPairFilter(lbPair)],
      );
      const ownersInPool = new Set();
      for (const { pubkey, account } of accounts) {
        try {
          const pos = wrapPosition(program, pubkey, account);
          const owner = pos.inner.owner.toBase58();
          ownersInPool.add(owner);
        } catch {
          // Skip malformed account
        }
      }
      for (const owner of ownersInPool) {
        if (!ownerStats.has(owner)) ownerStats.set(owner, { pools: new Set(), totalPositions: 0 });
        ownerStats.get(owner).pools.add(pool.pool);
        ownerStats.get(owner).totalPositions += 1;
      }
      console.log(`  [${i + 1}/${topPools.length}] ${pool.name?.padEnd(20) || pool.pool.slice(0, 12)} → ${ownersInPool.size} unique LPers (${accounts.length} positions)`);
    } catch (err) {
      console.log(`  [${i + 1}/${topPools.length}] ${pool.name || pool.pool.slice(0, 12)} → skip (${err.message})`);
    }
    // Gentle pacing — getProgramAccounts is RPC-heavy
    if (i < topPools.length - 1) await new Promise((r) => setTimeout(r, 150));
  }

  const ranked = [...ownerStats.entries()]
    .map(([address, stats]) => ({
      address,
      pool_count: stats.pools.size,
      position_count: stats.totalPositions,
    }))
    .filter((w) => w.pool_count >= opts.minPools)
    .sort((a, b) => b.pool_count - a.pool_count || b.position_count - a.position_count)
    .slice(0, opts.maxKeep);

  console.log(`\nFound ${ownerStats.size} unique LPers total. ${ranked.length} qualify (≥${opts.minPools} pools, top ${opts.maxKeep}).`);

  if (ranked.length === 0) {
    console.warn("No wallets qualified. Lower --min-pools or widen --top.");
    return;
  }

  const incoming = ranked.map((w, i) => ({
    name: `onchain-lp-${String(i + 1).padStart(3, "0")}`,
    address: w.address,
    category: "onchain_lp",
    type: "lp",
    source: SOURCE_TAG,
    pool_count: w.pool_count,
    position_count: w.position_count,
    refreshed_at: new Date().toISOString(),
  }));

  if (opts.dryRun) {
    console.log("\nDRY RUN — first 10:");
    incoming.slice(0, 10).forEach((w) => console.log(`  ${w.name}  ${w.address}  pools=${w.pool_count}  positions=${w.position_count}`));
    return;
  }

  const current = loadWallets();
  const merged = mergeWallets(current.wallets, incoming);
  const pruned = pruneStale(merged.wallets, incoming.map((w) => w.address));
  saveWallets({ wallets: pruned.wallets });

  console.log(`Done. Added ${merged.added}, refreshed ${merged.refreshed}, pruned ${pruned.pruned} stale. Total tracked: ${pruned.wallets.length}.`);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  console.error(err.stack);
  process.exit(1);
});
