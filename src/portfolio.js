// ═══════════════════════════════════════════════════════════════
// ÉTAT & PERSISTANCE — l'état complet est sauvegardé sur disque
// à chaque mutation (écriture atomique : tmp + rename).
// Un crash/redémarrage ne perd RIEN.
// ═══════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";

export function defaultState(config) {
  return {
    version: 2,
    createdAt: new Date().toISOString(),
    cash: config.initialCash,
    positions: {},        // { [symbol]: { qty, entryPrice, entryFee, stopPrice, entryTime, reason } }
    trades: [],           // historique des trades clôturés (plus récent en premier)
    equityHistory: [],    // [{ t, equity }]
    lastProcessed: {},    // { [symbol]: openTime de la dernière bougie traitée } — idempotence au restart
    day: { key: null, startEquity: config.initialCash },
    paused: false,
    pausedReason: null,
  };
}

export function loadState(file, config) {
  try {
    const st = JSON.parse(fs.readFileSync(file, "utf8"));
    if (st && st.version === 2) return st;
    console.warn(`[STATE] ${file} version inattendue — état neuf.`);
  } catch {
    // premier lancement : pas de fichier, c'est normal
  }
  return defaultState(config);
}

export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file); // atomique : jamais de fichier à moitié écrit
}

// Équité = cash + valorisation mark-to-market des positions ouvertes
export function equityOf(state, prices) {
  let eq = state.cash;
  for (const [sym, pos] of Object.entries(state.positions)) {
    const p = prices[sym];
    eq += pos.qty * (p ?? pos.entryPrice);
  }
  return eq;
}
