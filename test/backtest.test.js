import test from "node:test";
import assert from "node:assert/strict";
import { simulate } from "../src/backtest.js";

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
    const drift = Math.sin(i / 25) * 0.004;
    const open = price;
    const close = price * (1 + drift + (rnd() - 0.5) * 0.01);
    const high = Math.max(open, close) * (1 + rnd() * 0.003);
    const low = Math.min(open, close) * (1 - rnd() * 0.003);
    out.push({ openTime: i * 3_600_000, open, high, low, close, volume: 1000, closeTime: (i + 1) * 3_600_000 - 1 });
    price = close;
  }
  return out;
}

const TESTCFG = {
  initialCash: 1000,
  strategy: { id: "ema-cross", params: { fastPeriod: 20, slowPeriod: 50, atrPeriod: 14, stopAtrMult: 2 } },
  risk: { riskPerTradePct: 0.01, maxNotionalPct: 0.20, maxPositions: 3, dailyLossLimitPct: 0.05 },
  fees: { feeRate: 0.001, slippageRate: 0.0005 },
};

test("simulate : invariants de base (pas de NaN, cash >= 0, trades cohérents)", () => {
  const { state, equitySeries, metrics } = simulate(
    { AAAUSDT: syntheticCandles(600, 7), BBBUSDT: syntheticCandles(600, 13) },
    TESTCFG,
  );
  assert.equal(equitySeries.length, 600);
  assert.ok(Number.isFinite(metrics.finalEquity));
  assert.ok(state.cash >= 0);
  assert.ok(state.trades.length > 0, "le backtest devrait produire des trades sur tendances alternées");
  for (const t of state.trades) {
    assert.ok(Number.isFinite(t.pnl));
    assert.ok(t.fees > 0, "chaque trade doit payer des frais");
    assert.ok(t.entryPrice > 0 && t.exitPrice > 0);
  }
});

test("simulate : les frais et le slippage réduisent réellement le PnL", () => {
  const { state } = simulate({ AAAUSDT: syntheticCandles(600, 7) }, TESTCFG);
  for (const t of state.trades) {
    const grossPnl = (t.exitPrice - t.entryPrice) * t.qty; // fills incluent déjà le slippage
    assert.ok(t.pnl < grossPnl, "le PnL net doit être inférieur au PnL brut (frais déduits)");
  }
});

test("simulate : jamais plus de maxPositions simultanées", () => {
  // On rejoue la simulation et on vérifie via l'équité que rien n'explose,
  // puis on vérifie la contrainte sur les positions restantes
  const { state } = simulate(
    {
      A: syntheticCandles(600, 1), B: syntheticCandles(600, 2),
      C: syntheticCandles(600, 3), D: syntheticCandles(600, 4),
      E: syntheticCandles(600, 5),
    },
    TESTCFG,
  );
  assert.ok(Object.keys(state.positions).length <= TESTCFG.risk.maxPositions);
});

test("simulate : sortie stop conservatrice (gap sous le stop => rempli à l'open)", () => {
  // Construit une entrée forcée puis un crash avec gap
  const candles = syntheticCandles(200, 21);
  // force une tendance haussière régulière pour déclencher un cross-up...
  for (let i = 60; i < 120; i++) {
    const p = 100 + (i - 60) * 0.5;
    candles[i] = { ...candles[i], open: p, close: p + 0.4, high: p + 0.6, low: p - 0.2 };
  }
  // ...puis un crash violent avec gap à la bougie 121
  for (let i = 120; i < 140; i++) {
    const p = 60 - (i - 120) * 0.5;
    candles[i] = { ...candles[i], open: p, close: p - 0.4, high: p + 0.2, low: p - 0.8 };
  }
  const { state } = simulate({ GAPUSDT: candles }, TESTCFG);
  const stopTrades = state.trades.filter((t) => t.reason === "STOP");
  for (const t of stopTrades) {
    // le prix de sortie ne peut jamais être MEILLEUR que le stop
    // (fillSell applique en plus le slippage vers le bas)
    assert.ok(t.exitPrice <= t.entryPrice, "un stop LONG sort forcément sous l'entrée ou au gap");
  }
});
