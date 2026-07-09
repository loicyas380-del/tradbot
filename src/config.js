// ═══════════════════════════════════════════════════════════════
// CONFIGURATION CENTRALE
// Tout paramètre du bot vit ici. Aucune valeur magique ailleurs.
// ═══════════════════════════════════════════════════════════════

export const CONFIG = {
  // ── Univers : petites paires liquides, spot Binance ──
  universe: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "LINKUSDT"],

  // ── Timeframe : les décisions se prennent à la CLÔTURE d'une bougie 1h.
  // La boucle vérifie toutes les 30s si une nouvelle bougie a clôturé,
  // mais ne décide qu'une fois par bougie (cohérence données/fréquence).
  interval: "1h",
  intervalMs: 3_600_000,
  pollMs: 30_000,
  candleHistory: 300,           // bougies chargées pour le calcul des signaux (EMA200 => ≥ 250)
  staleAfterMs: 2 * 3_600_000,  // données plus vieilles que 2 bougies => on ne trade PAS

  // ── Capital papier (fictif) ──
  initialCash: 1000,

  // ── Stratégie active (voir src/strategies/) ──
  // Sélectionnée par `npm run research` : comparaison in-sample,
  // validation out-of-sample. Paramètres standards, PAS optimisés
  // sur l'historique — c'est ce qui évite le surapprentissage.
  strategy: {
    id: "donchian",
    params: { entryPeriod: 20, exitPeriod: 10, atrPeriod: 14, stopAtrMult: 2 },
  },

  // ── Risque ──
  risk: {
    riskPerTradePct: 0.01,   // 1% du capital risqué par trade (distance au stop)
    maxNotionalPct: 0.20,    // une position ne dépasse jamais 20% du capital
    maxPositions: 3,         // positions simultanées max
    dailyLossLimitPct: 0.05, // -5% sur la journée => kill-switch jusqu'au lendemain
  },

  // ── Frais et slippage (appliqués au PnL, pas juste à l'affichage) ──
  fees: {
    feeRate: 0.001,       // 0.10% par exécution (taker Binance)
    slippageRate: 0.0005, // 0.05% de slippage par exécution
  },

  // ── Persistance ──
  paths: {
    state: "data/state.json",
    backtestReport: "data/backtest-report.json",
  },
};
