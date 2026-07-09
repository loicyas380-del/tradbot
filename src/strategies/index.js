// ═══════════════════════════════════════════════════════════════
// REGISTRE DES STRATÉGIES — toutes partagent la même interface :
//   { id, label, defaultParams, warmup(params),
//     computeSeries(candles, params), decide({series, index, hasPosition, params}) }
// Toutes sont des fonctions PURES : mêmes données => mêmes décisions.
// ═══════════════════════════════════════════════════════════════

import * as emaCross from "./ema-cross.js";
import * as emaCrossTrend from "./ema-cross-trend.js";
import * as donchian from "./donchian.js";
import * as rsiRebound from "./rsi-rebound.js";

export const STRATEGIES = [emaCross, emaCrossTrend, donchian, rsiRebound];

export function getStrategy(id) {
  const s = STRATEGIES.find((s) => s.id === id);
  if (!s) throw new Error(`Stratégie inconnue : ${id} (disponibles : ${STRATEGIES.map((x) => x.id).join(", ")})`);
  return s;
}
