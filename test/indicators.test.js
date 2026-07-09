import test from "node:test";
import assert from "node:assert/strict";
import { ema, atr } from "../src/indicators.js";

test("ema : null pendant le warmup, puis valeurs exactes", () => {
  const e = ema([1, 2, 3, 4, 5], 3);
  assert.equal(e.length, 5);
  assert.equal(e[0], null);
  assert.equal(e[1], null);
  assert.equal(e[2], 2);   // SMA(1,2,3)
  assert.equal(e[3], 3);   // 4×0.5 + 2×0.5
  assert.equal(e[4], 4);   // 5×0.5 + 3×0.5
});

test("ema : série plus courte que la période => tout null", () => {
  assert.deepEqual(ema([1, 2], 5), [null, null]);
});

test("atr : bougies d'amplitude constante => ATR = amplitude", () => {
  const candles = Array.from({ length: 20 }, () => ({ high: 11, low: 9, close: 10 }));
  const a = atr(candles, 14);
  assert.equal(a[13], null);
  assert.ok(Math.abs(a[14] - 2) < 1e-9);
  assert.ok(Math.abs(a[19] - 2) < 1e-9);
});

test("atr : ne regarde jamais le futur (préfixe identique)", () => {
  const candles = Array.from({ length: 60 }, (_, i) => {
    const p = 100 + Math.sin(i / 5) * 10;
    return { high: p + 1, low: p - 1, close: p };
  });
  const full = atr(candles, 14);
  const partial = atr(candles.slice(0, 30), 14);
  for (let i = 0; i < 30; i++) {
    if (partial[i] == null) assert.equal(full[i], null);
    else assert.ok(Math.abs(full[i] - partial[i]) < 1e-12, `divergence à i=${i}`);
  }
});
