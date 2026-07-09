// ═══════════════════════════════════════════════════════════════
// RECHERCHE — compare TOUTES les stratégies du registre avec le
// même moteur, les mêmes frais, le même risque.
//
// Protocole anti-surapprentissage :
//  • Paramètres standards par stratégie (aucun grid-search).
//  • Sélection sur la période IN-SAMPLE (premiers 70%).
//  • Validation sur la période OUT-OF-SAMPLE (derniers 30%),
//    regardée UNE fois, jamais utilisée pour choisir.
//  • Distribution des rendements sur fenêtres glissantes de 30 jours :
//    c'est LA réponse honnête à « combien ça fait par mois ? ».
//
// Usage : npm run research [nbBougies]   (défaut 12000 ≈ 16 mois)
// ═══════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG } from "./config.js";
import { fetchHistory, closedOnly } from "./data.js";
import { STRATEGIES } from "./strategies/index.js";
import { simulate } from "./backtest.js";

const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

// Rendements sur fenêtres glissantes de 30 jours (720 bougies 1h, pas de 24h)
export function rollingMonthlyReturns(equitySeries, windowPts = 720, stepPts = 24) {
  const rets = [];
  for (let i = 0; i + windowPts < equitySeries.length; i += stepPts) {
    const a = equitySeries[i].equity;
    const b = equitySeries[i + windowPts].equity;
    if (a > 0) rets.push((b / a - 1) * 100);
  }
  rets.sort((x, y) => x - y);
  if (rets.length === 0) return null;
  const q = (p) => rets[Math.min(rets.length - 1, Math.floor(p * rets.length))];
  return {
    windows: rets.length,
    min: r2(rets[0]),
    p25: r2(q(0.25)),
    median: r2(q(0.5)),
    p75: r2(q(0.75)),
    max: r2(rets[rets.length - 1]),
    pctPositive: r2((rets.filter((x) => x > 0).length / rets.length) * 100),
    pctInTarget20to50: r2((rets.filter((x) => x >= 20 && x <= 50).length / rets.length) * 100),
  };
}

function sliceBySymbol(candlesBySymbol, from, to) {
  const out = {};
  for (const [s, cs] of Object.entries(candlesBySymbol)) out[s] = cs.slice(Math.floor(cs.length * from), Math.floor(cs.length * to));
  return out;
}

async function main() {
  const total = Number(process.argv[2]) || 12000;
  console.log(`Téléchargement de ${total} bougies ${CONFIG.interval} × ${CONFIG.universe.length} paires…`);
  const candlesBySymbol = {};
  for (const s of CONFIG.universe) {
    candlesBySymbol[s] = closedOnly(await fetchHistory(s, CONFIG.interval, total));
    console.log(`  ${s}: ${candlesBySymbol[s].length} bougies`);
  }

  const IS = sliceBySymbol(candlesBySymbol, 0, 0.7);    // sélection
  const OOS = sliceBySymbol(candlesBySymbol, 0.7, 1);   // validation (jamais pour choisir)

  const results = [];
  for (const strat of STRATEGIES) {
    const is = simulate(IS, CONFIG, { strategy: strat, params: strat.defaultParams });
    const oos = simulate(OOS, CONFIG, { strategy: strat, params: strat.defaultParams });
    const full = simulate(candlesBySymbol, CONFIG, { strategy: strat, params: strat.defaultParams });
    results.push({
      id: strat.id,
      label: strat.label,
      params: strat.defaultParams,
      inSample: pick(is.metrics),
      outOfSample: pick(oos.metrics),
      full: pick(full.metrics),
      monthly: rollingMonthlyReturns(full.equitySeries),
    });
  }

  // Sélection : meilleur Sharpe IN-SAMPLE (critère standard ; le ratio
  // rendement/drawdown est trompeur quand les rendements sont négatifs)
  const score = (r) => r.inSample.sharpe;
  results.sort((a, b) => score(b) - score(a));
  const winner = results[0];

  // ── Affichage ──
  console.log("\n══════════ COMPARAISON DES STRATÉGIES ══════════");
  console.log("(sélection sur in-sample 70%, validation out-of-sample 30%)\n");
  for (const r of results) {
    console.log(`■ ${r.label}  [${r.id}]`);
    console.log(`   In-sample  : ${fmt(r.inSample)}`);
    console.log(`   Out-sample : ${fmt(r.outOfSample)}`);
    console.log(`   Mois glissants (16 mois) : min ${r.monthly.min}% | médiane ${r.monthly.median}% | max ${r.monthly.max}% | positifs ${r.monthly.pctPositive}%`);
    console.log(`   Fenêtres de 30j dans la cible +20→50% : ${r.monthly.pctInTarget20to50}%\n`);
  }
  console.log(`➤ Sélection (meilleur Sharpe in-sample) : ${winner.label}`);
  console.log(`  Validation out-of-sample : ${fmt(winner.outOfSample)}`);
  console.log("\n⚠ Ces chiffres incluent frais + slippage. Performance passée ≠ future.");

  const report = {
    generatedAt: new Date().toISOString(),
    universe: CONFIG.universe,
    interval: CONFIG.interval,
    protocol: "in-sample 70% (sélection) / out-of-sample 30% (validation), paramètres standards non optimisés",
    results,
    winner: { id: winner.id, label: winner.label, params: winner.params },
  };
  fs.mkdirSync(path.dirname(CONFIG.paths.backtestReport), { recursive: true });
  fs.writeFileSync("data/research-report.json", JSON.stringify(report, null, 2));
  console.log("Rapport sauvegardé : data/research-report.json");
}

function pick(m) {
  return {
    totalReturnPct: m.totalReturnPct,
    buyHoldPct: m.buyHoldPct,
    maxDrawdownPct: m.maxDrawdownPct,
    sharpe: m.sharpe,
    trades: m.trades,
    winRatePct: m.winRatePct,
    profitFactor: m.profitFactor,
  };
}

function fmt(m) {
  return `${m.totalReturnPct >= 0 ? "+" : ""}${m.totalReturnPct}% (B&H ${m.buyHoldPct >= 0 ? "+" : ""}${m.buyHoldPct}%) | DD -${m.maxDrawdownPct}% | Sharpe ${m.sharpe} | ${m.trades} trades | WR ${m.winRatePct}%`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
