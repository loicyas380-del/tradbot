// ═══════════════════════════════════════════════════════════════
// BROKER PAPIER — exécution simulée.
// Slippage et frais sont appliqués AU PnL (pas juste à l'affichage).
// Utilisé à l'identique par le moteur live et par le backtest.
// ═══════════════════════════════════════════════════════════════

const round = (x) => Math.round(x * 1e4) / 1e4;

// Achat au marché. Retourne le fill, ou null si cash insuffisant.
export function fillBuy(state, { symbol, qty, price, time, stopPrice, reason, feeRate, slippageRate }) {
  const fillPrice = price * (1 + slippageRate);
  const notional = qty * fillPrice;
  const fee = notional * feeRate;
  if (notional + fee > state.cash + 1e-9) return null;

  state.cash -= notional + fee;
  state.positions[symbol] = {
    qty,
    entryPrice: fillPrice,
    entryFee: fee,
    stopPrice,
    entryTime: time,
    reason,
  };
  return { fillPrice: round(fillPrice), fee: round(fee), notional: round(notional) };
}

// Vente au marché de TOUTE la position. Retourne le trade clôturé, ou null.
export function fillSell(state, { symbol, price, time, reason, feeRate, slippageRate }) {
  const pos = state.positions[symbol];
  if (!pos) return null;

  const fillPrice = price * (1 - slippageRate);
  const proceeds = pos.qty * fillPrice;
  const fee = proceeds * feeRate;
  state.cash += proceeds - fee;

  const cost = pos.qty * pos.entryPrice;
  const pnl = proceeds - fee - cost - pos.entryFee;
  const trade = {
    symbol,
    side: "LONG",
    qty: pos.qty,
    entryPrice: round(pos.entryPrice),
    exitPrice: round(fillPrice),
    entryTime: pos.entryTime,
    exitTime: time,
    pnl: round(pnl),
    pnlPct: round((pnl / (cost + pos.entryFee)) * 100),
    fees: round(fee + pos.entryFee),
    reason,
  };
  state.trades.unshift(trade);
  if (state.trades.length > 1000) state.trades.pop();
  delete state.positions[symbol];
  return trade;
}
