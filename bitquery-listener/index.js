/**
 * meridian Bitquery listener — Meteora DLMM pool creation stream
 *
 * Subscribes to Bitquery streaming GraphQL for `initializeLbPair2` instructions
 * on the Meteora DLMM program. Each fresh pool address is queued to
 * bitquery-signals.json after a short delay (Meteora indexer needs ~30s).
 *
 * Env vars (from ../.env):
 *   BITQUERY_API_TOKEN  — OAuth token from https://account.bitquery.io/user/api_v2/access_tokens
 *   BITQUERY_MIN_DELAY_SEC  optional, default 30 (wait before pre-check to let Meteora index)
 */
import { WebSocket } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const dotenv = require("dotenv");
dotenv.config({ path: path.join(ROOT, ".env") });

import { runPreChecks } from "../discord-listener/pre-checks.js";

const SIGNALS_FILE = path.join(ROOT, "bitquery-signals.json");
const TOKEN = process.env.BITQUERY_API_TOKEN;
const PRECHECK_DELAY_MS = (Number(process.env.BITQUERY_MIN_DELAY_SEC) || 30) * 1000;
const METEORA_DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const WS_URL = `wss://streaming.bitquery.io/graphql?token=${TOKEN}`;
const SUB_ID = "meteora-pool-create";

if (!TOKEN) {
  console.error("ERROR: BITQUERY_API_TOKEN not set in ../.env");
  process.exit(1);
}

const SUBSCRIPTION = `
  subscription MeteoraNewPools {
    Solana {
      Instructions(
        where: {
          Transaction: { Result: { Success: true } },
          Instruction: {
            Program: {
              Method: { is: "initializeLbPair2" },
              Address: { is: "${METEORA_DLMM_PROGRAM}" }
            }
          }
        }
      ) {
        Block { Time }
        Transaction { Signature Signer }
        Instruction {
          Accounts { Address Token { Mint } }
        }
      }
    }
  }
`;

function loadSignals() {
  if (!fs.existsSync(SIGNALS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(SIGNALS_FILE, "utf8")); } catch { return []; }
}

function saveSignal(record) {
  const signals = loadSignals();
  signals.unshift(record);
  fs.writeFileSync(SIGNALS_FILE, JSON.stringify(signals.slice(0, 200), null, 2));
}

async function handlePoolCreate(event) {
  // Account index 0 = lbPair (the pool address) for initializeLbPair2
  const accounts = event?.Instruction?.Accounts || [];
  const poolAddr = accounts[0]?.Address;
  if (!poolAddr) return;

  const signature = event?.Transaction?.Signature;
  const signer = event?.Transaction?.Signer;
  const blockTime = event?.Block?.Time;

  console.log(`\n[NEW POOL] ${poolAddr} (sig ${signature?.slice(0, 12)})`);
  console.log(`  signer: ${signer}  time: ${blockTime}`);

  // Wait for Meteora indexer to ingest before pre-check
  setTimeout(async () => {
    try {
      const result = await runPreChecks(poolAddr);
      if (!result.pass) {
        console.log(`  pre-check failed: ${result.reason}`);
        return;
      }
      const record = {
        id: `${poolAddr.slice(0, 8)}-${Date.now()}`,
        pool_address: result.pool_address,
        base_mint: result.base_mint,
        base_symbol: result.symbol || "?",
        signal_source: "bitquery",
        signature,
        signer,
        block_time: blockTime,
        queued_at: new Date().toISOString(),
        rug_score: result.rug_score ?? null,
        total_fees_sol: result.total_fees_sol ?? null,
        token_age_minutes: result.token_age_minutes ?? null,
        status: "pending",
      };
      saveSignal(record);
      console.log(`  [QUEUED] ${record.base_symbol}`);
    } catch (err) {
      console.log(`  pre-check error: ${err.message}`);
    }
  }, PRECHECK_DELAY_MS);
}

function connect() {
  console.log(`[bitquery] Connecting to ${WS_URL.replace(TOKEN, "***")}`);
  const ws = new WebSocket(WS_URL, ["graphql-ws"]);
  let lastKeepalive = Date.now();
  let keepaliveTimer = null;

  ws.on("open", () => {
    console.log("[bitquery] Socket open, sending connection_init");
    ws.send(JSON.stringify({ type: "connection_init" }));
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.type) {
      case "connection_ack":
        console.log("[bitquery] Authenticated, subscribing to Meteora DLMM pool creation");
        ws.send(JSON.stringify({
          type: "start",
          id: SUB_ID,
          payload: { query: SUBSCRIPTION },
        }));
        break;
      case "data": {
        const events = msg.payload?.data?.Solana?.Instructions || [];
        for (const ev of events) handlePoolCreate(ev);
        break;
      }
      case "ka":
        lastKeepalive = Date.now();
        break;
      case "error":
        console.error("[bitquery] subscription error:", JSON.stringify(msg.payload));
        break;
      case "complete":
        console.log("[bitquery] subscription completed");
        break;
    }
  });

  ws.on("close", (code, reason) => {
    console.warn(`[bitquery] Socket closed code=${code} reason=${reason}. Reconnecting in 5s...`);
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    setTimeout(connect, 5000);
  });

  ws.on("error", (err) => {
    console.error("[bitquery] socket error:", err.message);
  });

  // Silent-disconnect watchdog — if no `ka` for 60s, force reconnect
  keepaliveTimer = setInterval(() => {
    if (Date.now() - lastKeepalive > 60_000 && ws.readyState === WebSocket.OPEN) {
      console.warn("[bitquery] No keepalive for 60s — forcing reconnect");
      ws.terminate();
    }
  }, 15_000);
}

connect();
