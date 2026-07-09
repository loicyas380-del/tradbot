// ═══════════════════════════════════════════════════════════════
// BACKTEST — rejoue la MÊME stratégie (src/strategy.js) et le MÊME
// broker (src/broker.js) que le live, sur l'historique réel Binance.
//
// Règles d'honnêteté :
//  • Décision à la clôture de la bougie i → exécution à l'OPEN de i+1
//    (aucun look-ahead).
//  • Stop-loss intra-bougie conservateur : si le low touche le stop,
//    on considère le stop touché ; en cas de gap sous le stop, rempli
//    à l'open (pire).
//  • Frais + slippage appliqués au PnL sur chaque exécution.
//  • Comparaison systématique au buy-and-hold net de frais.
//  • Paramètres de stratégie NON optimisés sur cet historique.
// ═══════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG } from "./config.js";
import { fetchHistory, closedOnly } from "./data.js";
import { getStrategy } from "./strategies/index.js";
import { positionSize } from "./risk.js";
import { fillBuy, fillSell } from "./broker.js";

const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

// Cœur pur et testable : { symbol: candles[] } + config -> résultats.
// `override` permet de rejouer une AUTRE stratégie que la config (recherche).
export function simulate(candlesBySymbol, config, override = {}) {
  const strat = override.strategy ?? getStrategy(config.strategy.id);
  const params = override.params ?? config.strategy.params ?? strat.defaultParams;
  const symbols = Object.keys(candlesBySymbol);
  const series = {};
  const idxAt = {};
  for (const s of symbols) {
    series[s] = strat.computeSeries(candlesBySymbol[s], params);
    idxAt[s] = new Map(candlesBySymbol[s].map((c, i) => [c.openTime, i]));
  }
  const times = [...new Set(symbols.flatMap((s) => candlesBySymbol[s].map((c) => c.openTime)))].sort((a, b) => a - b);

  const state = { cash: config.initialCash, positions: {}, trades: [] };
  const pending = {};  // ordres décidés à la bougie précédente, exécutés à l'open suivant
  const lastPx = {};
  const equitySeries = [];
  const ts = (ms) => new Date(ms).toISOString();
  const mtm = () => {
    let eq = state.cash;
    for (const [s, p] of Object.entries(state.positions)) eq += p.qty * (lastPx[s] ?? p.entryPrice);
    return eq;
  };

  for (const t of times) {
    // ── Phase 1 : exécution à l'OPEN des ordres en attente ──
    for (const s of symbols) {
      const i = idxAt[s].get(t);
      if (i == null) continue;
      const c = candlesBySymbol[s][i];
      const ord = pending[s];
      if (!ord) continue;
      delete pending[s];

      if (ord.type === "EXIT" && state.positions[s]) {
        fillSell(state, { symbol: s, price: c.open, time: ts(c.openTime), reason: ord.reason, ...config.fees });
      } else if (ord.type === "ENTER" && !state.positions[s]) {
        if (Object.keys(state.positions).length >= config.risk.maxPositions) continue;
        const stopPrice = c.open - ord.stopDistance;
        const qty = positionSize({
          equity: mtm(), cash: state.cash, entryPrice: c.open, stopPrice,
          riskPct: config.risk.riskPerTradePct, maxNotionalPct: config.risk.maxNotionalPct,
          ...config.fees,
        });
        if (qty > 0) {
          fillBuy(state, { symbol: s, qty, price: c.open, time: ts(c.openTime), stopPrice, reason: ord.reason, ...config.fees });
        }
      }
    }

    // ── Phase 2 : stop-loss intra-bougie (conservateur) ──
    for (const s of symbols) {
      const i = idxAt[s].get(t);
      if (i == null) continue;
      const c = candlesBySymbol[s][i];
      const pos = state.positions[s];
      if (pos && c.low <= pos.stopPrice) {
        const px = Math.min(c.open, pos.stopPrice); // gap sous le stop => open (pire)
        fillSell(state, { symbol: s, price: px, time: ts(c.closeTime), reason: "STOP", ...config.fees });
      }
    }

    // ── Phase 3 : décision à la CLÔTURE → ordre pour la bougie suivante ──
    for (const s of symbols) {
      const i = idxAt[s].get(t);
      if (i == null) continue;
      const d = strat.decide({ series: series[s], index: i, hasPosition: !!state.positions[s], params });
      if (d.action === "ENTER") pending[s] = { type: "ENTER", stopDistance: d.stopDistance, reason: d.reason };
      else if (d.action === "EXIT") pending[s] = { type: "EXIT", reason: d.reason };
      lastPx[s] = candlesBySymbol[s][i].close;
    }

    // ── Phase 4 : équité mark-to-market ──
    equitySeries.push({ t, equity: mtm() });
  }

  return { state, equitySeries, metrics: computeMetrics(equitySeries, state, candlesBySymbol, config) };
}

function computeMetrics(equitySeries, state, candlesBySymbol, config) {
  const eq0 = config.initialCash;
  const eqN = equitySeries.length ? equitySeries[equitySeries.length - 1].equity : eq0;
  const totalReturnPct = (eqN / eq0 - 1) * 100;

  // Max drawdown sur la courbe d'équité
  let peak = -Infinity;
  let maxDD = 0;
  for (const p of equitySeries) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) maxDD = Math.max(maxDD, (peak - p.equity) / peak);
  }

  // Sharpe annualisé (rendements par bougie 1h)
  const rets = [];
  for (let i = 1; i < equitySeries.length; i++) {
    const a = equitySeries[i - 1].equity;
    if (a > 0) rets.push(equitySeries[i].equity / a - 1);
  }
  const mean = rets.reduce((x, y) => x + y, 0) / (rets.length || 1);
  const variance = rets.reduce((x, y) => x + (y - mean) ** 2, 0) / (rets.length > 1 ? rets.length - 1 : 1);
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(24 * 365) : 0;

  // Statistiques de trades
  const trades = state.trades;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalFees = trades.reduce((s, t) => s + t.fees, 0);

  // Benchmark : buy-and-hold équipondéré, net de frais + slippage
  const { feeRate, slippageRate } = config.fees;
  const symbols = Object.keys(candlesBySymbol);
  let bhSum = 0;
  for (const s of symbols) {
    const cs = candlesBySymbol[s];
    const buy = cs[0].open * (1 + slippageRate) * (1 + feeRate);
    const sell = cs[cs.length - 1].close * (1 - slippageRate) * (1 - feeRate);
    bhSum += sell / buy - 1;
  }
  const buyHoldPct = (bhSum / symbols.length) * 100;

  // Stabilité : rendement sur la 1ère période (70%) vs la 2ème (30%)
  const cut = Math.floor(equitySeries.length * 0.7);
  const eqCut = equitySeries[cut] ? equitySeries[cut].equity : eq0;
  const firstPeriodPct = (eqCut / eq0 - 1) * 100;
  const secondPeriodPct = eqCut > 0 ? (eqN / eqCut - 1) * 100 : 0;

  return {
    periodStart: equitySeries.length ? new Date(equitySeries[0].t).toISOString() : null,
    periodEnd: equitySeries.length ? new Date(equitySeries[equitySeries.length - 1].t).toISOString() : null,
    candles: equitySeries.length,
    initialCash: eq0,
    finalEquity: r2(eqN),
    totalReturnPct: r2(totalReturnPct),
    buyHoldPct: r2(buyHoldPct),
    beatsBuyHold: totalReturnPct > buyHoldPct,
    maxDrawdownPct: r2(maxDD * 100),
    sharpe: r2(sharpe),
    trades: trades.length,
    winRatePct: trades.length ? r2((wins.length / trades.length) * 100) : null,
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    avgWin: wins.length ? r2(grossWin / wins.length) : null,
    avgLoss: losses.length ? r2(-grossLoss / losses.length) : null,
    totalFees: r2(totalFees),
    openPositionsAtEnd: Object.keys(state.positions).length,
    firstPeriodPct: r2(firstPeriodPct),
    secondPeriodPct: r2(secondPeriodPct),
  };
}

// ─── CLI : npm run backtest [nbBougies] ─────────────────────────
async function main() {
  const total = Number(process.argv[2]) || 4000; // ~5,5 mois de bougies 1h
  console.log(`Téléchargement de ${total} bougies ${CONFIG.interval} × ${CONFIG.universe.length} paires (Binance)…`);
  const candlesBySymbol = {};
  for (const s of CONFIG.universe) {
    candlesBySymbol[s] = closedOnly(await fetchHistory(s, CONFIG.interval, total));
    console.log(`  ${s}: ${candlesBySymbol[s].length} bougies`);
  }

  const { state, metrics } = simulate(candlesBySymbol, CONFIG);

  console.log("\n════════ RAPPORT DE BACKTEST ════════");
  console.log(`Période        : ${metrics.periodStart}  →  ${metrics.periodEnd}`);
  console.log(`Capital        : ${metrics.initialCash} → ${metrics.finalEquity} USDT  (${fmtPct(metrics.totalReturnPct)})`);
  console.log(`Buy & hold     : ${fmtPct(metrics.buyHoldPct)}  (équipondéré, net de frais)`);
  console.log(`Max drawdown   : -${metrics.maxDrawdownPct}%`);
  console.log(`Sharpe (ann.)  : ${metrics.sharpe}`);
  console.log(`Trades         : ${metrics.trades}  |  Win rate: ${metrics.winRatePct}%  |  Profit factor: ${metrics.profitFactor}`);
  console.log(`Gain moyen     : ${metrics.avgWin} USDT  |  Perte moyenne: ${metrics.avgLoss} USDT`);
  console.log(`Frais totaux   : ${metrics.totalFees} USDT`);
  console.log(`Stabilité      : 1ère période (70%): ${fmtPct(metrics.firstPeriodPct)}  |  2ème (30%): ${fmtPct(metrics.secondPeriodPct)}`);
  console.log("─────────────────────────────────────");
  if (metrics.beatsBuyHold) {
    console.log("✔ La stratégie bat le buy-and-hold sur cette période.");
  } else {
    console.log("✘ VERDICT HONNÊTE : la stratégie ne bat PAS le buy-and-hold sur cette période.");
    console.log("  Cela ne veut pas dire qu'elle est « cassée » — mais ne t'attends pas à des miracles en live.");
  }
  console.log("⚠ Performance passée ≠ performance future. Paper trading uniquement.\n");

  const report = {
    generatedAt: new Date().toISOString(),
    universe: CONFIG.universe,
    interval: CONFIG.interval,
    strategy: CONFIG.strategy,
    risk: CONFIG.risk,
    fees: CONFIG.fees,
    metrics,
    trades: state.trades.slice(0, 200),
  };
  fs.mkdirSync(path.dirname(CONFIG.paths.backtestReport), { recursive: true });
  fs.writeFileSync(CONFIG.paths.backtestReport, JSON.stringify(report, null, 2));
  console.log(`Rapport sauvegardé : ${CONFIG.paths.backtestReport}`);
}

function fmtPct(x) { return `${x >= 0 ? "+" : ""}${x}%`; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
