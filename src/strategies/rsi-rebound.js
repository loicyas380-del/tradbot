// ═══════════════════════════════════════════════════════════════
// STRATÉGIE : Rebond RSI en tendance haussière (mean-reversion filtrée).
// ENTRÉE : le RSI remonte au-dessus de 30 (sortie de survente)
//          ET le prix est au-dessus de l'EMA200 (jamais contre la tendance).
// SORTIE : RSI atteint 60 (retour à la normale), ou stop 2×ATR.
// Seuils 30/60 classiques, non optimisés.
// ═══════════════════════════════════════════════════════════════

import { ema, rsi, atr } from "../indicators.js";

export const id = "rsi-rebound";
export const label = "Rebond RSI30 + filtre EMA200";
export const defaultParams = { rsiPeriod: 14, entryLevel: 30, exitLevel: 60, trendPeriod: 200, atrPeriod: 14, stopAtrMult: 2 };
export const warmup = (p) => p.trendPeriod + 2;

export function computeSeries(candles, params) {
  const closes = candles.map((c) => c.close);
  return {
    closes,
    rsi: rsi(closes, params.rsiPeriod),
    emaTrend: ema(closes, params.trendPeriod),
    atr: atr(candles, params.atrPeriod),
  };
}

export function decide({ series, index: i, hasPosition, params }) {
  const { closes, rsi: r, emaTrend: t, atr: a } = series;
  if (i < 1 || r[i] == null || r[i - 1] == null || t[i] == null || a[i] == null) {
    return { action: "HOLD", reason: "warmup" };
  }
  const rebound = r[i - 1] <= params.entryLevel && r[i] > params.entryLevel;
  const bullRegime = closes[i] > t[i];

  if (!hasPosition && rebound && bullRegime) {
    return { action: "ENTER", stopDistance: params.stopAtrMult * a[i], reason: label };
  }
  if (hasPosition && r[i] >= params.exitLevel) {
    return { action: "EXIT", reason: `RSI ≥ ${params.exitLevel}` };
  }
  return { action: "HOLD", reason: "aucun signal" };
}
