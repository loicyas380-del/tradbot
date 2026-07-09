// ═══════════════════════════════════════════════════════════════
// MOTEUR LIVE (paper) — boucle toutes les 30s, mais ne DÉCIDE
// qu'à la clôture d'une nouvelle bougie 1h (idempotent au restart
// grâce à state.lastProcessed persisté).
// Le stop-loss, lui, est vérifié à chaque tick sur le dernier prix.
// ═══════════════════════════════════════════════════════════════

import { fetchKlines, closedOnly, isFresh } from "./data.js";
import { getStrategy } from "./strategies/index.js";
import { positionSize, dayKey } from "./risk.js";
import { fillBuy, fillSell } from "./broker.js";
import { saveState, equityOf } from "./portfolio.js";

const r2 = (x) => Math.round(x * 100) / 100;

export function createEngine(state, config) {
  const strat = getStrategy(config.strategy.id);
  const sparams = config.strategy.params ?? strat.defaultParams;
  const prices = {};      // dernier prix connu par symbole (bougie en formation)
  const dataStatus = {};  // "ok" | "stale" | "error" par symbole
  let ticking = false;
  let lastTick = null;

  const log = (tag, msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
  const equity = () => equityOf(state, prices);

  function rolloverDay(now) {
    const key = dayKey(now);
    if (state.day.key !== key) {
      state.day = { key, startEquity: equity() };
      if (state.paused && state.pausedReason?.startsWith("Perte journalière")) {
        state.paused = false;
        state.pausedReason = null;
        log("DAY", "Nouveau jour UTC — kill-switch réarmé");
      }
    }
  }

  function checkKillSwitch() {
    if (state.paused) return;
    const eq = equity();
    const floor = state.day.startEquity * (1 - config.risk.dailyLossLimitPct);
    if (eq <= floor) {
      state.paused = true;
      state.pausedReason = `Perte journalière max atteinte (-${(config.risk.dailyLossLimitPct * 100).toFixed(0)}%)`;
      log("KILL", `${state.pausedReason} — plus d'entrées jusqu'à demain (sorties toujours actives)`);
    }
  }

  async function processSymbol(sym) {
    const raw = await fetchKlines(sym, config.interval, { limit: config.candleHistory });
    const now = Date.now();
    const closed = closedOnly(raw, now);
    const last = closed[closed.length - 1];

    // Prix courant = close de la bougie en formation (le plus récent dispo)
    prices[sym] = raw[raw.length - 1].close;

    // Données périmées => on ne touche à rien
    if (!isFresh(last, config.staleAfterMs, now)) {
      dataStatus[sym] = "stale";
      log("DATA", `${sym} données périmées — aucun trade`);
      return;
    }
    dataStatus[sym] = "ok";

    const pos = state.positions[sym];

    // ── 1) STOP-LOSS : vérifié à chaque tick sur le prix courant ──
    if (pos && prices[sym] <= pos.stopPrice) {
      const trade = fillSell(state, {
        symbol: sym, price: prices[sym], time: new Date(now).toISOString(),
        reason: "STOP", ...config.fees,
      });
      if (trade) log("EXIT", `${sym} STOP @ ${trade.exitPrice} | PnL ${trade.pnl >= 0 ? "+" : ""}${trade.pnl} USDT`);
      return;
    }

    // ── 2) DÉCISION : uniquement sur nouvelle bougie clôturée ──
    if (state.lastProcessed[sym] === last.openTime) return;
    state.lastProcessed[sym] = last.openTime;
    if (closed.length < strat.warmup(sparams)) return;

    const series = strat.computeSeries(closed, sparams);
    const d = strat.decide({ series, index: closed.length - 1, hasPosition: !!pos, params: sparams });

    if (d.action === "EXIT" && pos) {
      const trade = fillSell(state, {
        symbol: sym, price: prices[sym], time: new Date(now).toISOString(),
        reason: d.reason, ...config.fees,
      });
      if (trade) log("EXIT", `${sym} ${d.reason} @ ${trade.exitPrice} | PnL ${trade.pnl >= 0 ? "+" : ""}${trade.pnl} USDT`);
      return;
    }

    if (d.action === "ENTER" && !pos) {
      if (state.paused) { log("SKIP", `${sym} signal d'entrée ignoré (${state.pausedReason})`); return; }
      if (Object.keys(state.positions).length >= config.risk.maxPositions) {
        log("SKIP", `${sym} signal ignoré (max ${config.risk.maxPositions} positions)`);
        return;
      }
      const entry = prices[sym];
      const stopPrice = entry - d.stopDistance;
      const qty = positionSize({
        equity: equity(), cash: state.cash, entryPrice: entry, stopPrice,
        riskPct: config.risk.riskPerTradePct, maxNotionalPct: config.risk.maxNotionalPct,
        ...config.fees,
      });
      if (qty <= 0) { log("SKIP", `${sym} taille de position nulle (cash insuffisant ?)`); return; }
      const fill = fillBuy(state, {
        symbol: sym, qty, price: entry, time: new Date(now).toISOString(),
        stopPrice, reason: d.reason, ...config.fees,
      });
      if (fill) log("ENTER", `${sym} LONG ${qty} @ ${fill.fillPrice} | stop ${r2(stopPrice)} | ${d.reason}`);
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      rolloverDay(now);

      const results = await Promise.allSettled(config.universe.map(processSymbol));
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          dataStatus[config.universe[i]] = "error";
          log("DATA", `${config.universe[i]}: ${r.reason?.message ?? r.reason}`);
        }
      });

      checkKillSwitch();

      // Snapshot d'équité (1 point/minute max, historique plafonné)
      const lastPoint = state.equityHistory[state.equityHistory.length - 1];
      if (!lastPoint || now - lastPoint.t >= 60_000) {
        state.equityHistory.push({ t: now, equity: r2(equity()) });
        if (state.equityHistory.length > 20_000) {
          state.equityHistory.splice(0, state.equityHistory.length - 20_000);
        }
      }

      lastTick = now;
      saveState(config.paths.state, state);
    } catch (err) {
      log("ERROR", err.stack || err.message);
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    start() {
      log("BOOT", `Paper trading — ${config.universe.join(", ")} en ${config.interval} | stratégie : ${strat.label} | équité ${r2(equity())} USDT`);
      tick();
      return setInterval(tick, config.pollMs);
    },
    status() {
      return { prices: { ...prices }, dataStatus: { ...dataStatus }, lastTick, equity: r2(equity()) };
    },
  };
}
