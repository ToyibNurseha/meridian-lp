import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const WALLETS_PATH = repoPath("smart-wallets.json");

function loadWallets() {
  if (!fs.existsSync(WALLETS_PATH)) return { wallets: [] };
  try {
    return JSON.parse(fs.readFileSync(WALLETS_PATH, "utf8"));
  } catch {
    return { wallets: [] };
  }
}

function saveWallets(data) {
  fs.writeFileSync(WALLETS_PATH, JSON.stringify(data, null, 2));
}

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function addSmartWallet({ name, address, category = "alpha", type = "lp" }) {
  if (!SOLANA_PUBKEY_RE.test(address)) {
    return { success: false, error: "Invalid Solana address format" };
  }
  const data = loadWallets();
  const existing = data.wallets.find((w) => w.address === address);
  if (existing) {
    return { success: false, error: `Already tracked as "${existing.name}"` };
  }
  data.wallets.push({ name, address, category, type, addedAt: new Date().toISOString() });
  saveWallets(data);
  log("smart_wallets", `Added wallet: ${name} (${category}, type=${type})`);
  return { success: true, wallet: { name, address, category, type } };
}

export function removeSmartWallet({ address }) {
  const data = loadWallets();
  const wallet = data.wallets.find((w) => w.address === address);
  if (!wallet) return { success: false, error: "Wallet not found" };
  data.wallets = data.wallets.filter((w) => w.address !== address);
  saveWallets(data);
  log("smart_wallets", `Removed wallet: ${wallet.name}`);
  return { success: true, removed: wallet.name };
}

export function listSmartWallets() {
  const { wallets } = loadWallets();
  return { total: wallets.length, wallets };
}

// Cache wallet positions for 30 minutes to avoid hammering RPC
const _cache = new Map(); // address -> { positions, fetchedAt }
const CACHE_TTL = 30 * 60 * 1000;
const FETCH_CONCURRENCY = 5;
const FETCH_BATCH_DELAY_MS = 300;

/**
 * Lightweight pool-list lookup using Meteora portfolio API (no Solana RPC).
 * Returns array of { pool: poolAddress } — enough for smart wallet confluence check.
 * Avoids the heavy getProgramAccounts RPC call used by getWalletPositions.
 */
async function fetchWalletPoolList(walletAddress) {
  const url = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletAddress}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Portfolio API ${res.status}`);
  const data = await res.json();
  const pools = data?.pools || [];
  return pools.map((p) => ({ pool: p.poolAddress }));
}

export async function checkSmartWalletsOnPool({ pool_address }) {
  const { wallets: allWallets } = loadWallets();
  // Only check LP-type wallets — holder wallets don't have positions
  const wallets = allWallets.filter((w) => !w.type || w.type === "lp");
  if (wallets.length === 0) {
    return {
      pool: pool_address,
      tracked_wallets: 0,
      in_pool: [],
      confidence_boost: false,
      signal: "No smart wallets tracked yet — neutral signal",
    };
  }

  // Split into cached vs cold — only fetch cold ones
  const cachedResults = [];
  const coldWallets = [];
  for (const wallet of wallets) {
    const cached = _cache.get(wallet.address);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
      cachedResults.push({ wallet, positions: cached.positions });
    } else {
      coldWallets.push(wallet);
    }
  }

  // Batch cold fetches via Meteora portfolio API (no Solana RPC = no 429).
  const coldResults = [];
  for (let i = 0; i < coldWallets.length; i += FETCH_CONCURRENCY) {
    const batch = coldWallets.slice(i, i + FETCH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (wallet) => {
        try {
          const positions = await fetchWalletPoolList(wallet.address);
          _cache.set(wallet.address, { positions, fetchedAt: Date.now() });
          return { wallet, positions };
        } catch {
          return { wallet, positions: [] };
        }
      })
    );
    coldResults.push(...batchResults);
    if (i + FETCH_CONCURRENCY < coldWallets.length) {
      await new Promise((r) => setTimeout(r, FETCH_BATCH_DELAY_MS));
    }
  }

  const results = [...cachedResults, ...coldResults];

  const inPool = results
    .filter((r) => r.positions.some((p) => p.pool === pool_address))
    .map((r) => ({ name: r.wallet.name, category: r.wallet.category, address: r.wallet.address }));

  return {
    pool: pool_address,
    tracked_wallets: wallets.length,
    in_pool: inPool,
    confidence_boost: inPool.length > 0,
    signal: inPool.length > 0
      ? `${inPool.length}/${wallets.length} smart wallet(s) are in this pool: ${inPool.map((w) => w.name).join(", ")} — STRONG signal`
      : `0/${wallets.length} smart wallets in this pool — neutral, rely on fundamentals`,
  };
}
