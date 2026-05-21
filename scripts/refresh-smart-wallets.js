#!/usr/bin/env node
/**
 * refresh-smart-wallets.js
 *
 * Fetch top Meteora DLMM LPers from a public Dune query and merge into
 * smart-wallets.json. Uses Dune's cached-results endpoint — no execution
 * triggered, only consumes a small credit per call.
 *
 * Env:
 *   DUNE_API_KEY        required
 *   DUNE_QUERY_ID       optional, default 4655892 (DLMM PnL v4 leaderboard)
 *   DUNE_TOP_N          optional, default 50
 *
 * Usage:
 *   node scripts/refresh-smart-wallets.js
 *   node scripts/refresh-smart-wallets.js --dry-run
 *   node scripts/refresh-smart-wallets.js --query 4655892 --top 30
 */

import "../envcrypt.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WALLETS_PATH = path.resolve(__dirname, "../smart-wallets.json");

const DUNE_API = "https://api.dune.com/api/v1";
const DEFAULT_QUERY_ID = 4655892;
const DEFAULT_TOP_N = 50;
const SOURCE_TAG = "dune";

function parseArgs() {
  const args = process.argv.slice(2);
  let queryId = Number(process.env.DUNE_QUERY_ID ?? DEFAULT_QUERY_ID);
  let topN = Number(process.env.DUNE_TOP_N ?? DEFAULT_TOP_N);
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--query" && args[i + 1]) queryId = Number(args[++i]);
    else if (args[i] === "--top" && args[i + 1]) topN = Number(args[++i]);
    else if (args[i] === "--dry-run") dryRun = true;
  }
  return { queryId, topN, dryRun };
}

async function fetchDuneResults(queryId, apiKey) {
  const url = `${DUNE_API}/query/${queryId}/results`;
  const res = await fetch(url, { headers: { "X-DUNE-API-KEY": apiKey } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dune ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const rows = json?.result?.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("Dune returned no rows");
  return rows;
}

// Detect column names heuristically — Dune queries vary.
function detectColumns(row) {
  const keys = Object.keys(row);
  const walletKey = keys.find((k) => /wallet|address|owner|account/i.test(k));
  const pnlKey = keys.find((k) => /net.?pnl|total.?pnl|profit.?usd|pnl.?usd|^pnl$|^profit$/i.test(k))
    || keys.find((k) => /pnl|profit/i.test(k));
  return { walletKey, pnlKey };
}

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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
    if (!SOLANA_PUBKEY_RE.test(entry.address)) continue;
    if (byAddr.has(entry.address)) {
      // Refresh stats but keep manual category if not from dune
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

function pruneStaleDune(wallets, freshAddrs) {
  const fresh = new Set(freshAddrs);
  const before = wallets.length;
  const kept = wallets.filter((w) => w.source !== SOURCE_TAG || fresh.has(w.address));
  return { wallets: kept, pruned: before - kept.length };
}

async function main() {
  const { queryId, topN, dryRun } = parseArgs();
  const apiKey = process.env.DUNE_API_KEY;
  if (!apiKey) {
    console.error("ERROR: DUNE_API_KEY not set in .env");
    process.exit(1);
  }

  console.log(`Fetching Dune query ${queryId} (top ${topN})${dryRun ? " [DRY RUN]" : ""}...`);
  const rows = await fetchDuneResults(queryId, apiKey);
  const { walletKey, pnlKey } = detectColumns(rows[0]);
  if (!walletKey) {
    console.error("Could not detect wallet column. Sample row keys:", Object.keys(rows[0]));
    process.exit(1);
  }
  console.log(`Detected: wallet="${walletKey}"${pnlKey ? `, pnl="${pnlKey}"` : " (no PnL col found — using row order)"}`);

  const ranked = pnlKey
    ? [...rows].sort((a, b) => Number(b[pnlKey] || 0) - Number(a[pnlKey] || 0))
    : rows;

  const top = ranked.slice(0, topN);
  const incoming = top.map((row, i) => ({
    name: `dune-lp-${String(i + 1).padStart(2, "0")}`,
    address: String(row[walletKey] || "").trim(),
    category: "dune_lp",
    type: "lp",
    source: SOURCE_TAG,
    source_query_id: queryId,
    pnl: pnlKey ? Number(row[pnlKey] || 0) : null,
    refreshed_at: new Date().toISOString(),
  })).filter((w) => SOLANA_PUBKEY_RE.test(w.address));

  console.log(`Top ${incoming.length} valid Solana addresses extracted.`);

  if (dryRun) {
    console.log("Sample (first 5):");
    incoming.slice(0, 5).forEach((w) => console.log(` ${w.name}  ${w.address}  pnl=${w.pnl}`));
    return;
  }

  const current = loadWallets();
  const merged = mergeWallets(current.wallets, incoming);
  const pruned = pruneStaleDune(merged.wallets, incoming.map((w) => w.address));
  saveWallets({ wallets: pruned.wallets });

  console.log(`Done. Added ${merged.added}, refreshed ${merged.refreshed}, pruned ${pruned.pruned} stale dune entries. Total tracked: ${pruned.wallets.length}.`);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
