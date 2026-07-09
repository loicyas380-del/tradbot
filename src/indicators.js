// ═══════════════════════════════════════════════════════════════
// INDICATEURS — fonctions pures, déterministes, sans I/O.
// Chaque fonction retourne un tableau ALIGNÉ sur l'entrée
// (même longueur, `null` pendant la période de chauffe).
// L'indice i n'utilise QUE les données 0..i : pas de look-ahead.
// ═══════════════════════════════════════════════════════════════

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let sma = 0;
  for (let i = 0; i < period; i++) sma += values[i];
  out[period - 1] = sma / period;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

// RSI avec lissage de Wilder.
export function rsi(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

// Plus haut des `period` valeurs PRÉCÉDENTES (exclut i — pour les cassures).
export function rollingMax(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    let m = -Infinity;
    for (let j = i - period; j < i; j++) if (values[j] > m) m = values[j];
    out[i] = m;
  }
  return out;
}

// Plus bas des `period` valeurs PRÉCÉDENTES (exclut i).
export function rollingMin(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    let m = Infinity;
    for (let j = i - period; j < i; j++) if (values[j] < m) m = values[j];
    out[i] = m;
  }
  return out;
}

// ATR avec lissage de Wilder. candles = [{high, low, close}, ...]
export function atr(candles, period) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  const trs = new Array(candles.length - 1);
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    trs[i - 1] = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
  }
  let a = 0;
  for (let i = 0; i < period; i++) a += trs[i];
  a /= period;
  out[period] = a;
  for (let i = period + 1; i < candles.length; i++) {
    a = (a * (period - 1) + trs[i - 1]) / period;
    out[i] = a;
  }
  return out;
}
