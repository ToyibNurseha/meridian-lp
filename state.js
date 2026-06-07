/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";

const STATE_FILE = "./state.json";

const MAX_RECENT_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 280;

function sanitizeStoredText(text, maxLen = MAX_INSTRUCTION_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], lastUpdated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return { positions: {}, lastUpdated: null };
  }
}

function save(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
  entry_tvl = null,
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
    bin_range,
    amount_sol,
    amount_x,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    entry_tvl: entry_tvl || null,
    signal_snapshot: signal_snapshot || null,
    deployed_at: new Date().toISOString(),
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    closed: false,
    closed_at: null,
    notes: [],
    peak_pnl_pct: 0,
    pending_peak_pnl_pct: null,
    pending_peak_started_at: null,
    pending_trailing_current_pnl_pct: null,
    pending_trailing_peak_pnl_pct: null,
    pending_trailing_drop_pct: null,
    pending_trailing_started_at: null,
    confirmed_trailing_exit_reason: null,
    confirmed_trailing_exit_until: null,
    trailing_active: false,
    pnl_history: [], // rolling samples [{ ts, pnl_pct }] used by flash-dump detector
  };
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
  save(state);
  log("state", `Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

/**
 * Mark a position as closed and remove it from active state.
 * Audit trail preserved via pushEvent → recentEvents.
 */
export function recordClose(position_address, reason) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  const closedAt = new Date().toISOString();
  pushEvent(state, {
    action: "close",
    position: position_address,
    pool: pos.pool || null,
    pool_name: pos.pool_name || pos.pool,
    pair: pos.pair || null,
    amount_sol: pos.amount_sol ?? null,
    deployed_at: pos.deployed_at || null,
    closed_at: closedAt,
    reason,
  });
  delete state.positions[position_address];
  save(state);
  log("state", `Position ${position_address} closed + pruned: ${reason}`);
}

/**
 * Prune any leftover positions that are marked closed but still sitting
 * in state.positions. Run once at startup to clean up stale entries from
 * before recordClose started deleting.
 */
export function pruneClosedPositions() {
  const state = load();
  const initial = Object.keys(state.positions || {}).length;
  let removed = 0;
  for (const [posId, pos] of Object.entries(state.positions || {})) {
    if (pos?.closed) {
      delete state.positions[posId];
      removed++;
    }
  }
  if (removed > 0) {
    save(state);
    log("state", `Startup prune: removed ${removed} closed positions (was ${initial}, now ${initial - removed})`);
  }
  return { initial, removed, remaining: initial - removed };
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = sanitizeStoredText(instruction);
  save(state);
  log("state", `Position ${position_address} instruction set: ${pos.instruction}`);
  return true;
}

export function queuePeakConfirmation(position_address, candidatePnlPct, options = {}) {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const currentPeak = pos.peak_pnl_pct ?? 0;
  if (candidatePnlPct <= currentPeak) return false;

  if (options.immediate) {
    pos.peak_pnl_pct = candidatePnlPct;
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_started_at = null;
    save(state);
    log("state", `Position ${position_address} peak PnL accepted at ${candidatePnlPct.toFixed(2)}% from relay poll`);
    return true;
  }

  const changed =
    pos.pending_peak_pnl_pct == null ||
    candidatePnlPct > pos.pending_peak_pnl_pct;

  if (!changed) return false;

  pos.pending_peak_pnl_pct = candidatePnlPct;
  pos.pending_peak_started_at = new Date().toISOString();
  save(state);
  log("state", `Position ${position_address} peak candidate ${candidatePnlPct.toFixed(2)}% queued for 15s confirmation`);
  return true;
}

export function resolvePendingPeak(position_address, currentPnlPct, toleranceRatio = 0.85) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || pos.pending_peak_pnl_pct == null) return { confirmed: false, pending: false };

  const pendingPeak = pos.pending_peak_pnl_pct;
  pos.pending_peak_pnl_pct = null;
  pos.pending_peak_started_at = null;

  if (currentPnlPct != null && currentPnlPct >= pendingPeak * toleranceRatio) {
    pos.peak_pnl_pct = Math.max(pos.peak_pnl_pct ?? 0, pendingPeak, currentPnlPct);
    save(state);
    log("state", `Position ${position_address} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}% after recheck`);
    return { confirmed: true, peak: pos.peak_pnl_pct };
  }

  save(state);
  log("state", `Position ${position_address} rejected pending peak ${pendingPeak.toFixed(2)}% after 15s recheck (current: ${currentPnlPct ?? "?"}%)`);
  return { confirmed: false, rejected: true, pendingPeak };
}

export function queueTrailingDropConfirmation(position_address, peakPnlPct, currentPnlPct, trailingDropPct) {
  if (peakPnlPct == null || currentPnlPct == null || trailingDropPct == null) return false;
  const dropFromPeak = peakPnlPct - currentPnlPct;
  if (dropFromPeak < trailingDropPct) return false;

  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const changed =
    pos.pending_trailing_current_pnl_pct == null ||
    currentPnlPct < pos.pending_trailing_current_pnl_pct ||
    dropFromPeak > (pos.pending_trailing_drop_pct ?? -Infinity);

  if (!changed) return false;

  pos.pending_trailing_peak_pnl_pct = peakPnlPct;
  pos.pending_trailing_current_pnl_pct = currentPnlPct;
  pos.pending_trailing_drop_pct = dropFromPeak;
  pos.pending_trailing_started_at = new Date().toISOString();
  save(state);
  log("state", `Position ${position_address} trailing drop candidate queued: peak ${peakPnlPct.toFixed(2)}% -> current ${currentPnlPct.toFixed(2)}%`);
  return true;
}

export function resolvePendingTrailingDrop(position_address, currentPnlPct, trailingDropPct, tolerancePct = 1.0) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || pos.pending_trailing_current_pnl_pct == null || pos.pending_trailing_peak_pnl_pct == null) {
    return { confirmed: false, pending: false };
  }

  const pendingCurrent = pos.pending_trailing_current_pnl_pct;
  const pendingPeak = pos.pending_trailing_peak_pnl_pct;
  const pendingDrop = pos.pending_trailing_drop_pct ?? (pendingPeak - pendingCurrent);

  pos.pending_trailing_current_pnl_pct = null;
  pos.pending_trailing_peak_pnl_pct = null;
  pos.pending_trailing_drop_pct = null;
  pos.pending_trailing_started_at = null;

  const stillNearCrash = currentPnlPct != null && currentPnlPct <= pendingCurrent + tolerancePct;
  const stillDroppedEnough = currentPnlPct != null && (pendingPeak - currentPnlPct) >= trailingDropPct;

  if (stillNearCrash && stillDroppedEnough) {
    const reason = `Trailing TP: peak ${pendingPeak.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${(pendingPeak - currentPnlPct).toFixed(2)}% >= ${trailingDropPct}%)`;
    pos.confirmed_trailing_exit_reason = reason;
    pos.confirmed_trailing_exit_until = new Date(Date.now() + 30_000).toISOString();
    save(state);
    log("state", `Position ${position_address} trailing drop confirmed after recheck: pending drop ${pendingDrop.toFixed(2)}%, current ${currentPnlPct.toFixed(2)}%`);
    return { confirmed: true, reason };
  }

  save(state);
  log("state", `Position ${position_address} rejected trailing drop after 15s recheck (pending current: ${pendingCurrent.toFixed(2)}%, current: ${currentPnlPct ?? "?"}%)`);
  return { confirmed: false, rejected: true };
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 * @param {string} position_address
 * @param {object} positionData - fields from getMyPositions: pnl_pct, in_range, fee_per_tvl_24h
 * @param {object} mgmtConfig
 * Returns { action, reason } or null if no exit needed.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, pnl_usd, in_range, fee_per_tvl_24h, current_tvl } = positionData;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  // Append rolling PnL sample for flash-dump detection (only when value is trustworthy)
  if (!pnl_pct_suspicious && currentPnlPct != null) {
    if (!Array.isArray(pos.pnl_history)) pos.pnl_history = [];
    const nowMs = Date.now();
    const windowMin = Math.max(1, Number(mgmtConfig.flashDumpWindowMin ?? 5));
    const cutoff = nowMs - windowMin * 60 * 1000;
    pos.pnl_history.push({ ts: nowMs, pnl_pct: currentPnlPct });
    pos.pnl_history = pos.pnl_history.filter((s) => s.ts >= cutoff).slice(-60);
  }

  if (pos.confirmed_trailing_exit_until) {
    if (new Date(pos.confirmed_trailing_exit_until).getTime() > Date.now() && pos.confirmed_trailing_exit_reason) {
      const reason = pos.confirmed_trailing_exit_reason;
      pos.confirmed_trailing_exit_reason = null;
      pos.confirmed_trailing_exit_until = null;
      save(state);
      return { action: "TRAILING_TP", reason, confirmed_recheck: true };
    }
    pos.confirmed_trailing_exit_reason = null;
    pos.confirmed_trailing_exit_until = null;
  }

  let changed = false;

  // Activate trailing TP once trigger threshold is reached
  if (mgmtConfig.trailingTakeProfit && !pos.trailing_active && (pos.peak_pnl_pct ?? 0) >= mgmtConfig.trailingTriggerPct) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%)`);
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    changed = true;
    log("state", `Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    changed = true;
    log("state", `Position ${position_address} back in range`);
  }

  if (changed) save(state);

  // ── Flash dump (rapid PnL drop within rolling window) ─────────
  if (
    mgmtConfig.flashDumpEnabled &&
    !pnl_pct_suspicious &&
    currentPnlPct != null &&
    Array.isArray(pos.pnl_history) &&
    pos.pnl_history.length >= 2
  ) {
    const dropPct = Number(mgmtConfig.flashDumpDropPct ?? 5);
    const windowMin = Math.max(1, Number(mgmtConfig.flashDumpWindowMin ?? 5));
    const recentMax = pos.pnl_history.reduce((m, s) => (s.pnl_pct > m ? s.pnl_pct : m), -Infinity);
    const drop = recentMax - currentPnlPct;
    if (drop >= dropPct) {
      return {
        action: "FLASH_DUMP",
        reason: `Flash dump: PnL ${recentMax.toFixed(2)}% → ${currentPnlPct.toFixed(2)}% (dropped ${drop.toFixed(2)}% within ${windowMin}m)`,
      };
    }
  }

  // ── Stop loss ──────────────────────────────────────────────────
  if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.stopLossPct != null) {
    if (currentPnlPct <= mgmtConfig.stopLossPct) {
      return {
        action: "STOP_LOSS",
        reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%`,
      };
    }
  }

  // ── Trailing TP ────────────────────────────────────────────────
  if (!pnl_pct_suspicious && pos.trailing_active) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= mgmtConfig.trailingDropPct) {
      // Severe drop (≥2x trailingDrop) bypasses confirmation — price is cratering, exit now.
      // ZINC pattern: peak 3.48% → confirmation 15s delay → final -6.11% (-9.59% drop).
      const severeDropMultiplier = Number(mgmtConfig.trailingSevereDropMultiplier ?? 2);
      const isSevere = dropFromPeak >= mgmtConfig.trailingDropPct * severeDropMultiplier;
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%${isSevere ? ", SEVERE — no recheck" : ""})`,
        needs_confirmation: !isSevere,
        peak_pnl_pct: pos.peak_pnl_pct,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
      };
    }
  }

  // ── Out of range too long ──────────────────────────────────────
  if (pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    // Scale OOR wait by volatility — low-vol pools need more time for price to drift back
    // (today: 4 OOR-20m exits at near-flat PnL; longer wait would let fees compound).
    const posVol = Number(pos.volatility);
    const lowVolThresh = Number(mgmtConfig.oorWaitLowVolThreshold ?? 2);
    const midVolThresh = Number(mgmtConfig.oorWaitMidVolThreshold ?? 3);
    const lowVolWait = Number(mgmtConfig.oorWaitLowVolMin ?? 40);
    const midVolWait = Number(mgmtConfig.oorWaitMidVolMin ?? 30);
    let oorLimit = mgmtConfig.outOfRangeWaitMinutes;
    if (Number.isFinite(posVol) && posVol > 0) {
      if (posVol < lowVolThresh) oorLimit = Math.max(oorLimit, lowVolWait);
      else if (posVol < midVolThresh) oorLimit = Math.max(oorLimit, midVolWait);
    }
    if (minutesOOR >= oorLimit) {
      // Profit-guard: if position is in profit, skip OOR close — let trailing TP / Rule 3 catch the peak.
      // Prevents killing small winners that drifted out of range (today: MAGA+1.41%, SPCX+0.54% murdered by OOR-20m).
      const oorProfitGuard = Number(mgmtConfig.oorProfitGuardPct ?? 1);
      if (
        oorProfitGuard > 0 &&
        !pnl_pct_suspicious &&
        currentPnlPct != null &&
        currentPnlPct >= oorProfitGuard
      ) {
        log("state", `Position ${position_address} OOR ${minutesOOR}m but PnL ${currentPnlPct.toFixed(2)}% >= guard ${oorProfitGuard}% — letting trailer handle exit`);
      } else {
        return {
          action: "OUT_OF_RANGE",
          reason: `Out of range for ${minutesOOR}m (limit: ${oorLimit}m${oorLimit !== mgmtConfig.outOfRangeWaitMinutes ? `, vol-scaled from ${mgmtConfig.outOfRangeWaitMinutes}m, vol=${posVol}` : ""})`,
        };
      }
    }
  }

  // ── Time-decay no-fee exit — confirmed zero fees after deadDeployMinutes = dead deploy
  // BUT only close when PnL >= deadDeployMinPnlPct (default 0). Otherwise wait for green
  // to avoid locking in small losses. Time-stop Rule 6 acts as backstop for stale negatives.
  const { age_minutes, unclaimed_fees_usd } = positionData;
  const deadDeployMin = Number(mgmtConfig.deadDeployMinutes ?? 40);
  const deadDeployMinPnl = Number(mgmtConfig.deadDeployMinPnlPct ?? 0);
  const deadFeeThreshold = 0.05; // < $0.05 unclaimed = effectively dead
  if (
    age_minutes != null &&
    age_minutes >= deadDeployMin &&
    unclaimed_fees_usd != null && unclaimed_fees_usd < deadFeeThreshold
  ) {
    if (
      !pnl_pct_suspicious &&
      currentPnlPct != null &&
      currentPnlPct < deadDeployMinPnl
    ) {
      log("state", `Position ${position_address} dead-deploy hold: PnL ${currentPnlPct.toFixed(2)}% < ${deadDeployMinPnl}%, fees $${unclaimed_fees_usd?.toFixed(3) ?? 0} — waiting for green (time-stop Rule 6 is backstop)`);
    } else {
      return {
        action: "NO_FEES",
        reason: `Dead deploy: fees $${unclaimed_fees_usd?.toFixed(3) ?? 0} < $${deadFeeThreshold} after ${age_minutes}m, PnL ${currentPnlPct != null ? currentPnlPct.toFixed(2) + "%" : "n/a"}`,
      };
    }
  }

  // ── Low yield (only after position has had time to accumulate fees) ───
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck)
  ) {
    const minCloseAbs = Number(mgmtConfig.minClosePnlUsd ?? 0);
    if (minCloseAbs > 0 && pnl_usd != null && Math.abs(pnl_usd) < minCloseAbs) {
      log("state", `Position ${position_address} LOW_YIELD exit deferred: |pnl_usd $${pnl_usd.toFixed(3)}| < min $${minCloseAbs.toFixed(2)}`);
    } else {
      return {
        action: "LOW_YIELD",
        reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
      };
    }
  }

  // ── Rule 7: Whale exit — TVL collapsed since entry ─────────────
  const whaleTvlDropPct = mgmtConfig.whaleTvlDropPct;
  const whaleTvlMinAge = mgmtConfig.whaleTvlMinAgeMinutes ?? 15;
  if (
    whaleTvlDropPct != null &&
    current_tvl != null &&
    pos.entry_tvl != null &&
    pos.entry_tvl > 0 &&
    (age_minutes == null || age_minutes >= whaleTvlMinAge)
  ) {
    const tvlDropPct = ((pos.entry_tvl - current_tvl) / pos.entry_tvl) * 100;
    if (tvlDropPct >= whaleTvlDropPct) {
      return {
        action: "WHALE_EXIT",
        reason: `Rule 7: Whale exit: TVL -${tvlDropPct.toFixed(0)}% since entry ($${pos.entry_tvl.toFixed(0)}→$${current_tvl.toFixed(0)})`,
      };
    }
  }

  return null;
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
const SYNC_GRACE_MS = 5 * 60_000; // don't auto-close positions deployed < 5 min ago

export function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;
  const autoClosed = [];

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
    autoClosed.push({ position: posId, ...pos });
  }

  if (changed) save(state);
  return autoClosed;
}
