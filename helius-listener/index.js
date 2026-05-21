/**
 * meridian Helius webhook receiver
 *
 * Listens for Helius "enhanced" webhook POSTs. Filters transactions that touch
 * the Meteora DLMM program and were signed by a tracked smart wallet. Writes
 * matched signals to helius-signals.json — consumed by the screener.
 *
 * Env vars (from ../.env):
 *   HELIUS_WEBHOOK_PORT   optional, default 3001
 *   HELIUS_AUTH_HEADER    optional shared secret — payloads with missing/wrong
 *                         Authorization header are rejected
 *
 * Public URL:
 *   The Helius webhook must POST to a publicly reachable HTTPS URL. Expose via
 *   tunnel (cloudflared / ngrok) or VPS + reverse proxy. Configure that URL in
 *   the Helius webhook (see scripts/setup-helius-webhook.js).
 */
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const dotenv = require("dotenv");
dotenv.config({ path: path.join(ROOT, ".env") });

const PORT = Number(process.env.HELIUS_WEBHOOK_PORT) || 3001;
const AUTH_HEADER = process.env.HELIUS_AUTH_HEADER || null;
const SIGNALS_FILE = path.join(ROOT, "helius-signals.json");
const WALLETS_FILE = path.join(ROOT, "smart-wallets.json");
const METEORA_DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

function loadSmartWalletSet() {
  if (!fs.existsSync(WALLETS_FILE)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8"));
    return new Set((data.wallets || []).filter((w) => !w.type || w.type === "lp").map((w) => w.address));
  } catch {
    return new Set();
  }
}

function loadSignals() {
  if (!fs.existsSync(SIGNALS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(SIGNALS_FILE, "utf8")); } catch { return []; }
}

function saveSignal(record) {
  const signals = loadSignals();
  signals.unshift(record);
  fs.writeFileSync(SIGNALS_FILE, JSON.stringify(signals.slice(0, 200), null, 2));
}

function findMeteoraInstruction(tx) {
  const top = (tx.instructions || []).find((ix) => ix?.programId === METEORA_DLMM_PROGRAM);
  if (top) return top;
  for (const ix of tx.instructions || []) {
    const inner = (ix.innerInstructions || []).find((i) => i?.programId === METEORA_DLMM_PROGRAM);
    if (inner) return inner;
  }
  return null;
}

function extractPoolAddress(meteoraInstruction) {
  // Meteora DLMM position-related instructions place the lbPair (pool) early in accounts.
  // We grab the first 4 candidate accounts and let the screener resolve which is the real pool.
  const accounts = meteoraInstruction?.accounts || [];
  return accounts.slice(0, 4);
}

function processTransaction(tx, smartWallets) {
  const signer = tx.feePayer || tx.signers?.[0] || null;
  if (!signer || !smartWallets.has(signer)) return;
  const meteora = findMeteoraInstruction(tx);
  if (!meteora) return;

  const candidateAccounts = extractPoolAddress(meteora);
  const record = {
    id: `helius-${tx.signature?.slice(0, 12)}-${Date.now()}`,
    signal_source: "helius",
    signer,
    signature: tx.signature,
    timestamp: tx.timestamp ? new Date(tx.timestamp * 1000).toISOString() : new Date().toISOString(),
    description: tx.description || null,
    type: tx.type || null,
    candidate_pool_addresses: candidateAccounts,
    queued_at: new Date().toISOString(),
    status: "pending",
  };
  saveSignal(record);
  console.log(`[QUEUED] signer=${signer.slice(0, 8)} sig=${tx.signature?.slice(0, 12)} type=${tx.type}`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  if (AUTH_HEADER && req.headers.authorization !== AUTH_HEADER) {
    res.writeHead(401).end();
    return;
  }

  try {
    const raw = await readBody(req);
    const payload = JSON.parse(raw);
    const txs = Array.isArray(payload) ? payload : [payload];
    const smartWallets = loadSmartWalletSet();
    if (smartWallets.size === 0) {
      console.warn("[helius] smart-wallets.json empty — no transactions will match");
    }
    for (const tx of txs) processTransaction(tx, smartWallets);
    res.writeHead(200).end("ok");
  } catch (err) {
    console.error("[helius] payload error:", err.message);
    res.writeHead(400).end("bad payload");
  }
});

server.listen(PORT, () => {
  console.log(`[meridian helius-listener] Listening on :${PORT}  authHeader=${AUTH_HEADER ? "set" : "off"}`);
  const smartWallets = loadSmartWalletSet();
  console.log(`[helius] Tracking ${smartWallets.size} smart wallet(s) for Meteora DLMM activity`);
});
