// ═══════════════════════════════════════════════════════════════
// STRATÉGIE : Croisement EMA (suivi de tendance) — la baseline v2.
// ENTRÉE : EMA rapide croise au-dessus de l'EMA lente.
// SORTIE : croisement inverse, ou stop 2×ATR (géré par le moteur).
// Paramètres standards (20/50), non optimisés.
// ═══════════════════════════════════════════════════════════════

import { ema, atr } from "../indicators.js";

export const id = "ema-cross";
export const label = "Croisement EMA20/EMA50";
export const defaultParams = { fastPeriod: 20, slowPeriod: 50, atrPeriod: 14, stopAtrMult: 2 };
export const warmup = (p) => p.slowPeriod + 2;

export function computeSeries(candles, params) {
  const closes = candles.map((c) => c.close);
  return {
    emaFast: ema(closes, params.fastPeriod),
    emaSlow: ema(closes, params.slowPeriod),
    atr: atr(candles, params.atrPeriod),
  };
}

export function decide({ series, index: i, hasPosition, params }) {
  const { emaFast: f, emaSlow: s, atr: a } = series;
  if (i < 1 || f[i] == null || s[i] == null || f[i - 1] == null || s[i - 1] == null || a[i] == null) {
    return { action: "HOLD", reason: "warmup" };
  }
  const crossUp = f[i - 1] <= s[i - 1] && f[i] > s[i];
  const crossDown = f[i - 1] >= s[i - 1] && f[i] < s[i];

  if (!hasPosition && crossUp) {
    return { action: "ENTER", stopDistance: params.stopAtrMult * a[i], reason: label };
  }
  if (hasPosition && crossDown) {
    return { action: "EXIT", reason: "Croisement EMA inverse" };
  }
  return { action: "HOLD", reason: "aucun signal" };
}
