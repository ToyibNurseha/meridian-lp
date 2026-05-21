#!/usr/bin/env node
/**
 * setup-helius-webhook.js
 *
 * Create or update a Helius enhanced webhook that watches every smart wallet
 * in smart-wallets.json and POSTs matching transactions to your public URL.
 *
 * Env:
 *   HELIUS_API_KEY        required
 *   HELIUS_WEBHOOK_URL    required — public HTTPS URL of helius-listener
 *   HELIUS_AUTH_HEADER    optional — shared secret echoed back as Authorization
 *   HELIUS_WEBHOOK_ID     optional — if set, updates that webhook instead of creating
 *
 * Usage:
 *   node scripts/setup-helius-webhook.js
 *   node scripts/setup-helius-webhook.js --list
 *   node scripts/setup-helius-webhook.js --delete <webhookID>
 */

import "../envcrypt.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WALLETS_PATH = path.resolve(__dirname, "../smart-wallets.json");

const API_BASE = "https://api-mainnet.helius-rpc.com/v0/webhooks";

function loadWalletAddresses() {
  if (!fs.existsSync(WALLETS_PATH)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(WALLETS_PATH, "utf8"));
    return (data.wallets || [])
      .filter((w) => !w.type || w.type === "lp")
      .map((w) => w.address);
  } catch {
    return [];
  }
}

async function listWebhooks(apiKey) {
  const res = await fetch(`${API_BASE}?api-key=${apiKey}`);
  if (!res.ok) throw new Error(`list ${res.status}: ${await res.text()}`);
  return res.json();
}

async function createWebhook(apiKey, body) {
  const res = await fetch(`${API_BASE}?api-key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create ${res.status}: ${await res.text()}`);
  return res.json();
}

async function updateWebhook(apiKey, id, body) {
  const res = await fetch(`${API_BASE}/${id}?api-key=${apiKey}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`update ${res.status}: ${await res.text()}`);
  return res.json();
}

async function deleteWebhook(apiKey, id) {
  const res = await fetch(`${API_BASE}/${id}?api-key=${apiKey}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete ${res.status}: ${await res.text()}`);
  return { deleted: id };
}

async function main() {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) { console.error("ERROR: HELIUS_API_KEY not set"); process.exit(1); }

  const args = process.argv.slice(2);
  if (args[0] === "--list") {
    const hooks = await listWebhooks(apiKey);
    console.log(JSON.stringify(hooks, null, 2));
    return;
  }
  if (args[0] === "--delete" && args[1]) {
    console.log(await deleteWebhook(apiKey, args[1]));
    return;
  }

  const webhookURL = process.env.HELIUS_WEBHOOK_URL;
  if (!webhookURL) { console.error("ERROR: HELIUS_WEBHOOK_URL not set"); process.exit(1); }

  const addresses = loadWalletAddresses();
  if (addresses.length === 0) {
    console.error("ERROR: smart-wallets.json has no LP wallets. Run `npm run refresh:smart-wallets` first.");
    process.exit(1);
  }
  if (addresses.length > 100_000) {
    console.error(`ERROR: ${addresses.length} addresses exceeds Helius limit (100,000).`);
    process.exit(1);
  }

  const body = {
    webhookURL,
    transactionTypes: ["ANY"],
    accountAddresses: addresses,
    webhookType: "enhanced",
    ...(process.env.HELIUS_AUTH_HEADER ? { authHeader: process.env.HELIUS_AUTH_HEADER } : {}),
  };

  const existingId = process.env.HELIUS_WEBHOOK_ID;
  if (existingId) {
    console.log(`Updating webhook ${existingId} → ${addresses.length} addresses → ${webhookURL}`);
    const result = await updateWebhook(apiKey, existingId, body);
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Creating webhook → ${addresses.length} addresses → ${webhookURL}`);
    const result = await createWebhook(apiKey, body);
    console.log(JSON.stringify(result, null, 2));
    console.log(`\nSAVE THIS ID — set HELIUS_WEBHOOK_ID=${result.webhookID} in .env to update later.`);
  }
}

main().catch((err) => { console.error("ERROR:", err.message); process.exit(1); });
