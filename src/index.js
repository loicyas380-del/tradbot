// ═══════════════════════════════════════════════════════════════
// POINT D'ENTRÉE — charge l'état persisté, démarre moteur + API.
// PAPER TRADING UNIQUEMENT : aucun argent réel ne transite ici.
// ═══════════════════════════════════════════════════════════════

import { CONFIG } from "./config.js";
import { loadState } from "./portfolio.js";
import { createEngine } from "./engine.js";
import { createServer } from "./server.js";

const PORT = process.env.PORT || 3001;

const state = loadState(CONFIG.paths.state, CONFIG);
const engine = createEngine(state, CONFIG);

createServer(state, engine, CONFIG).listen(PORT, () => {
  console.log(`TradBot v2 (PAPER) — dashboard : http://localhost:${PORT}`);
});

engine.start();

// ── Keep-alive Render (plan gratuit) ─────────────────────────
// Render endort les services gratuits après ~15 min sans trafic entrant.
// RENDER_EXTERNAL_URL est défini automatiquement par Render : on s'auto-ping
// toutes les 10 min pour rester éveillé et trader 24/7.
const external = process.env.RENDER_EXTERNAL_URL;
if (external) {
  console.log(`[KEEPALIVE] auto-ping ${external} toutes les 10 min`);
  setInterval(() => {
    fetch(`${external}/api/status`, { signal: AbortSignal.timeout(10_000) }).catch(() => {});
  }, 10 * 60 * 1000);
}
