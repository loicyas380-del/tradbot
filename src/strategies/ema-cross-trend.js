// ═══════════════════════════════════════════════════════════════
// STRATÉGIE : Croisement EMA + filtre de régime EMA200.
// Identique à ema-cross, mais n'achète QUE si le prix est au-dessus
// de l'EMA200 (on ne prend que les signaux dans le sens de la
// tendance de fond — filtre classique anti-marché baissier).
// ═══════════════════════════════════════════════════════════════

import { ema, atr } from "../indicators.js";

export const id = "ema-cross-trend";
export const label = "EMA20/50 + filtre tendance EMA200";
export const defaultParams = { fastPeriod: 20, slowPeriod: 50, trendPeriod: 200, atrPeriod: 14, stopAtrMult: 2 };
export const warmup = (p) => p.trendPeriod + 2;

export function computeSeries(candles, params) {
  const closes = candles.map((c) => c.close);
  return {
    closes,
    emaFast: ema(closes, params.fastPeriod),
    emaSlow: ema(closes, params.slowPeriod),
    emaTrend: ema(closes, params.trendPeriod),
    atr: atr(candles, params.atrPeriod),
  };
}

export function decide({ series, index: i, hasPosition, params }) {
  const { closes, emaFast: f, emaSlow: s, emaTrend: t, atr: a } = series;
  if (i < 1 || f[i] == null || s[i] == null || t[i] == null || f[i - 1] == null || s[i - 1] == null || a[i] == null) {
    return { action: "HOLD", reason: "warmup" };
  }
  const crossUp = f[i - 1] <= s[i - 1] && f[i] > s[i];
  const crossDown = f[i - 1] >= s[i - 1] && f[i] < s[i];
  const bullRegime = closes[i] > t[i];

  if (!hasPosition && crossUp && bullRegime) {
    return { action: "ENTER", stopDistance: params.stopAtrMult * a[i], reason: label };
  }
  if (hasPosition && crossDown) {
    return { action: "EXIT", reason: "Croisement EMA inverse" };
  }
  return { action: "HOLD", reason: "aucun signal" };
}
