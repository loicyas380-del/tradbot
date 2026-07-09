// ═══════════════════════════════════════════════════════════════
// GESTION DU RISQUE — sizing basé sur la distance au stop.
// risque réel = quantité × (entrée - stop) = equity × riskPerTradePct
// ═══════════════════════════════════════════════════════════════

export function positionSize({ equity, cash, entryPrice, stopPrice, riskPct, maxNotionalPct, feeRate, slippageRate }) {
  const stopDist = entryPrice - stopPrice;
  if (!(stopDist > 0) || !(equity > 0) || !(entryPrice > 0)) return 0;

  // Quantité telle que la perte au stop = riskPct du capital
  let qty = (equity * riskPct) / stopDist;

  // Plafond : la position ne dépasse pas maxNotionalPct du capital
  qty = Math.min(qty, (equity * maxNotionalPct) / entryPrice);

  // Plafond : ne jamais dépenser plus que le cash disponible (frais+slippage inclus)
  const unitCost = entryPrice * (1 + slippageRate) * (1 + feeRate);
  qty = Math.min(qty, (cash * 0.99) / unitCost);

  qty = Math.floor(qty * 1e6) / 1e6; // arrondi à 6 décimales
  return qty > 0 ? qty : 0;
}

export function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10); // jour UTC
}
