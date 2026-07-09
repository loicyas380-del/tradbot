// ═══════════════════════════════════════════════════════════════
// STRATÉGIE : Cassure de canal Donchian (style « Turtle », système 1).
// ENTRÉE : la clôture dépasse le plus haut des 20 bougies précédentes.
// SORTIE : la clôture casse le plus bas des 10 bougies précédentes,
//          ou stop 2×ATR.
// Paramètres 20/10 = les valeurs historiques des Turtles, non optimisées.
// ═══════════════════════════════════════════════════════════════

import { atr, rollingMax, rollingMin } from "../indicators.js";

export const id = "donchian";
export const label = "Cassure Donchian 20/10";
export const defaultParams = { entryPeriod: 20, exitPeriod: 10, atrPeriod: 14, stopAtrMult: 2 };
export const warmup = (p) => Math.max(p.entryPeriod, p.atrPeriod) + 2;

export function computeSeries(candles, params) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  return {
    closes,
    upper: rollingMax(highs, params.entryPeriod),
    lower: rollingMin(lows, params.exitPeriod),
    atr: atr(candles, params.atrPeriod),
  };
}

export function decide({ series, index: i, hasPosition, params }) {
  const { closes, upper, lower, atr: a } = series;
  if (upper[i] == null || lower[i] == null || a[i] == null) {
    return { action: "HOLD", reason: "warmup" };
  }
  if (!hasPosition && closes[i] > upper[i]) {
    return { action: "ENTER", stopDistance: params.stopAtrMult * a[i], reason: label };
  }
  if (hasPosition && closes[i] < lower[i]) {
    return { action: "EXIT", reason: "Cassure du plus bas 10 bougies" };
  }
  return { action: "HOLD", reason: "aucun signal" };
}
