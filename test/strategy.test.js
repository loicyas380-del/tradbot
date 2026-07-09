import test from "node:test";
import assert from "node:assert/strict";
import { STRATEGIES } from "../src/strategies/index.js";

// PRNG déterministe : les tests sont reproductibles
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function syntheticCandles(n, seed = 42) {
  const rnd = mulberry32(seed);
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 25) * 0.004; // tendances alternées => signaux
    const open = price;
    const close = price * (1 + drift + (rnd() - 0.5) * 0.01);
    const high = Math.max(open, close) * (1 + rnd() * 0.003);
    const low = Math.min(open, close) * (1 - rnd() * 0.003);
    out.push({ openTime: i * 3_600_000, open, high, low, close, volume: 1000, closeTime: (i + 1) * 3_600_000 - 1 });
    price = close;
  }
  return out;
}

// ── Chaque stratégie du registre passe les MÊMES tests de pureté ──
for (const strat of STRATEGIES) {
  const params = strat.defaultParams;

  test(`[${strat.id}] AUCUN look-ahead : décision identique avec ou sans le futur`, () => {
    const candles = syntheticCandles(800);
    const full = strat.computeSeries(candles, params);
    for (let i = strat.warmup(params) + 5; i < 799; i += 13) {
      const partial = strat.computeSeries(candles.slice(0, i + 1), params);
      for (const hasPosition of [false, true]) {
        const a = strat.decide({ series: full, index: i, hasPosition, params });
        const b = strat.decide({ series: partial, index: i, hasPosition, params });
        assert.equal(a.action, b.action, `[${strat.id}] divergence à i=${i} (hasPosition=${hasPosition})`);
      }
    }
  });

  test(`[${strat.id}] déterminisme : mêmes données => mêmes décisions`, () => {
    const candles = syntheticCandles(400, 7);
    const run = () => {
      const series = strat.computeSeries(candles, params);
      return candles.map((_, i) => strat.decide({ series, index: i, hasPosition: false, params }).action);
    };
    assert.deepEqual(run(), run());
  });

  test(`[${strat.id}] ENTER fournit toujours une distance de stop positive`, () => {
    const candles = syntheticCandles(800, 99);
    const series = strat.computeSeries(candles, params);
    for (let i = 0; i < candles.length; i++) {
      const d = strat.decide({ series, index: i, hasPosition: false, params });
      if (d.action === "ENTER") assert.ok(d.stopDistance > 0, `[${strat.id}] stopDistance invalide à i=${i}`);
    }
  });

  test(`[${strat.id}] warmup : HOLD tant que les indicateurs ne sont pas prêts`, () => {
    const candles = syntheticCandles(strat.warmup(params) + 50, 5);
    const series = strat.computeSeries(candles, params);
    for (let i = 0; i < Math.min(10, candles.length); i++) {
      const d = strat.decide({ series, index: i, hasPosition: false, params });
      assert.equal(d.action, "HOLD", `[${strat.id}] devrait être en warmup à i=${i}`);
    }
  });
}

test("le registre contient les 4 stratégies attendues", () => {
  const ids = STRATEGIES.map((s) => s.id);
  assert.deepEqual(ids.sort(), ["donchian", "ema-cross", "ema-cross-trend", "rsi-rebound"]);
});

test("[ema-cross] génère des signaux sur des tendances alternées", () => {
  const strat = STRATEGIES.find((s) => s.id === "ema-cross");
  const candles = syntheticCandles(800);
  const series = strat.computeSeries(candles, strat.defaultParams);
  let enters = 0;
  let exits = 0;
  for (let i = 0; i < candles.length; i++) {
    if (strat.decide({ series, index: i, hasPosition: false, params: strat.defaultParams }).action === "ENTER") enters++;
    if (strat.decide({ series, index: i, hasPosition: true, params: strat.defaultParams }).action === "EXIT") exits++;
  }
  assert.ok(enters > 0, "aucun signal d'entrée généré");
  assert.ok(exits > 0, "aucun signal de sortie généré");
});
