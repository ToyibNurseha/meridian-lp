import { config } from "../config.js";
import { log } from "../logger.js";
import { agentMeridianJson, getAgentMeridianHeaders } from "./agent-meridian.js";
import { safeNumber } from "../utils/number.js";

// RSI + MACD rebound exit.
//
// The Agent Meridian chart-indicators API returns RSI but NOT MACD, so we pull the raw
// candle series (close prices) and compute MACD locally (EMA fast/slow, signal, histogram).
// "MACD green" = histogram > 0 (bullish momentum). Combined with an overbought-ish RSI this
// times the top of a rebound after a dump — the moment to exit an LP position.
//
// Called from the 3s PnL poller, so every fetch is cached per mint (rsiMacdExitCacheSec) to
// avoid rate-limiting the API. Default OFF (config.management.rsiMacdExitEnabled).

const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;

// mint -> { at: epochMs, payload }
const _cache = new Map();

function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  let prev = values[0];
  const out = [prev];
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Standard MACD on a close series. Returns latest {macd, signal, histogram} or null. */
export function computeMacd(closes, fast = MACD_FAST, slow = MACD_SLOW, signalP = MACD_SIGNAL) {
  const series = closes.filter((c) => typeof c === "number" && isFinite(c));
  if (series.length < slow + signalP) return null;
  const emaFast = ema(series, fast);
  const emaSlow = ema(series, slow);
  const macdLine = series.map((_, i) => emaFast[i] - emaSlow[i]);
  const signalLine = ema(macdLine, signalP);
  const i = series.length - 1;
  const macd = macdLine[i];
  const signal = signalLine[i];
  return { macd, signal, histogram: macd - signal };
}

async function fetchIndicators(mint, interval) {
  const ttlMs = Math.max(1, Number(config.management.rsiMacdExitCacheSec ?? 60)) * 1000;
  const hit = _cache.get(mint);
  if (hit && Date.now() - hit.at < ttlMs) return hit.payload;

  const search = new URLSearchParams({
    interval: String(interval || "5_MINUTE").trim().toUpperCase(),
    candles: String(config.indicators?.candles ?? 298),
    rsiLength: String(config.indicators?.rsiLength ?? 2),
  });
  const payload = await agentMeridianJson(`/chart-indicators/${mint}?${search.toString()}`, {
    headers: getAgentMeridianHeaders(),
  });
  _cache.set(mint, { at: Date.now(), payload });
  return payload;
}

/**
 * Check the RSI+MACD rebound exit for a single mint.
 * Returns { exit: boolean, reason, rsi, histogram } — exit is true only when both conditions hold.
 * Network/parse failures return { exit: false } (never block other rules on a bad tick).
 */
export async function checkRsiMacdExit({ mint }) {
  const m = config.management;
  if (!mint) return { exit: false };
  try {
    const payload = await fetchIndicators(mint, m.rsiMacdExitInterval);
    const rsi = safeNumber(payload?.latest?.rsi?.value, null);
    const closes = (payload?.candles || []).map((c) => safeNumber(c?.close, null));
    const macd = computeMacd(closes);
    if (rsi == null || !macd) return { exit: false, rsi, histogram: macd?.histogram ?? null };

    const rsiThresh = Number(m.rsiMacdExitRsi ?? 70);
    const green = macd.histogram > 0;
    const exit = rsi >= rsiThresh && green;
    return {
      exit,
      rsi,
      histogram: macd.histogram,
      reason: exit
        ? `RSI/MACD: RSI ${rsi.toFixed(1)} >= ${rsiThresh} + MACD green (hist ${macd.histogram.toExponential(2)})`
        : null,
    };
  } catch (e) {
    log("state", `RSI/MACD exit check failed for ${mint}: ${e.message}`);
    return { exit: false };
  }
}
