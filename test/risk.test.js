import test from "node:test";
import assert from "node:assert/strict";
import { positionSize } from "../src/risk.js";

const FEES = { feeRate: 0.001, slippageRate: 0.0005 };

test("sizing : la perte au stop vaut riskPct de l'équité", () => {
  const qty = positionSize({
    equity: 1000, cash: 1000, entryPrice: 100, stopPrice: 95,
    riskPct: 0.01, maxNotionalPct: 0.20, ...FEES,
  });
  // risque cible 10 USDT / distance 5 => qty 2 (le cap notional 20% tombe pile à 2)
  assert.ok(Math.abs(qty - 2) < 1e-6);
  assert.ok(Math.abs(qty * (100 - 95) - 1000 * 0.01) < 1e-6);
});

test("sizing : plafonné par le notional max", () => {
  const qty = positionSize({
    equity: 1000, cash: 1000, entryPrice: 100, stopPrice: 99.9, // stop très serré
    riskPct: 0.01, maxNotionalPct: 0.20, ...FEES,
  });
  assert.ok(qty * 100 <= 1000 * 0.20 + 1e-6);
});

test("sizing : jamais plus que le cash disponible", () => {
  const qty = positionSize({
    equity: 10_000, cash: 100, entryPrice: 100, stopPrice: 90,
    riskPct: 0.01, maxNotionalPct: 0.50, ...FEES,
  });
  const cost = qty * 100 * (1 + FEES.slippageRate) * (1 + FEES.feeRate);
  assert.ok(cost <= 100);
});

test("sizing : stop invalide ou équité nulle => 0", () => {
  const base = { equity: 1000, cash: 1000, entryPrice: 100, riskPct: 0.01, maxNotionalPct: 0.2, ...FEES };
  assert.equal(positionSize({ ...base, stopPrice: 100 }), 0);  // distance nulle
  assert.equal(positionSize({ ...base, stopPrice: 105 }), 0);  // stop au-dessus de l'entrée
  assert.equal(positionSize({ ...base, equity: 0, stopPrice: 95 }), 0);
});
