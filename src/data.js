// ═══════════════════════════════════════════════════════════════
// DONNÉES DE MARCHÉ — API publique Binance (pas de clé requise).
// Règle absolue : si les données échouent ou sont périmées,
// on NE TRADE PAS. Jamais de données inventées.
// ═══════════════════════════════════════════════════════════════

// data-api.binance.vision = endpoint public officiel « market data only » :
// mêmes données, accessible aussi depuis les régions où api.binance.com est
// géo-bloqué (serveurs US type Render/Heroku). api.binance.com en secours.
const BASES = ["https://data-api.binance.vision", "https://api.binance.com"];

// Bougies OHLCV. Binance renvoie la bougie EN FORMATION en dernier.
export async function fetchKlines(symbol, interval, { limit = 200, endTime } = {}) {
  const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
  if (endTime) params.set("endTime", String(endTime));
  let lastErr;
  for (const base of BASES) {
    try {
      const res = await fetch(`${base}/api/v3/klines?${params}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Binance ${symbol} HTTP ${res.status}`);
      const raw = await res.json();
      return raw.map((k) => ({
        openTime: k[0],
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
        volume: +k[5],
        closeTime: k[6],
      }));
    } catch (err) {
      lastErr = err; // on tente l'hôte suivant
    }
  }
  throw lastErr;
}

// Historique long, paginé en remontant le temps (max 1000 bougies/requête).
export async function fetchHistory(symbol, interval, total) {
  let all = [];
  let endTime;
  while (all.length < total) {
    const batch = await fetchKlines(symbol, interval, {
      limit: Math.min(1000, total - all.length),
      endTime,
    });
    if (batch.length === 0) break;
    all = batch.concat(all);
    endTime = batch[0].openTime - 1;
    if (batch.length < 1000) break; // début de l'historique atteint
  }
  return all;
}

// Ne garde que les bougies CLÔTURÉES (écarte la bougie en formation).
export function closedOnly(candles, now = Date.now()) {
  return candles.filter((c) => c.closeTime <= now);
}

// Une bougie clôturée est "fraîche" si elle date de moins de maxAgeMs.
export function isFresh(lastClosed, maxAgeMs, now = Date.now()) {
  return !!lastClosed && now - lastClosed.closeTime <= maxAgeMs;
}
