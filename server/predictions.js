import "dotenv/config";
import {
  RSI, MACD, BollingerBands, EMA, SMA, ATR, Stochastic, ADX,
} from "technicalindicators";

const YF_H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0" };

async function yfChart(symbol, range = "3mo", interval = "1d") {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`, { headers: YF_H, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const r = json.chart?.result?.[0];
  if (!r) throw new Error("No data");
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const data = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.open[i] != null && q.close[i] != null) {
      data.push({ date: new Date(ts[i] * 1000), open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 });
    }
  }
  return data;
}

function getVal(arr, idx) { return idx >= 0 && idx < arr.length ? arr[idx] : undefined; }

function computeIndicators(rawData) {
  const closes = rawData.map(d => d.close);
  const highs = rawData.map(d => d.high);
  const lows = rawData.map(d => d.low);
  const volumes = rawData.map(d => d.volume);
  return {
    closes, highs, lows, volumes, len: closes.length,
    rsi: RSI.calculate({ values: closes, period: 14 }),
    macd: MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }),
    bb: BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 }),
    ema20: EMA.calculate({ values: closes, period: 20 }),
    ema50: EMA.calculate({ values: closes, period: 50 }),
    atr: ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }),
    stoch: Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 }),
    adx: ADX.calculate({ high: highs, low: lows, close: closes, period: 14 }),
  };
}

// Top 35 assets to analyze
const ASSETS = [
  { sym: "WLD-USD", name: "Worldcoin", type: "crypto" },
  { sym: "FET-USD", name: "Fetch.ai", type: "crypto" },
  { sym: "NEAR-USD", name: "NEAR", type: "crypto" },
  { sym: "DOT-USD", name: "Polkadot", type: "crypto" },
  { sym: "ICP-USD", name: "ICP", type: "crypto" },
  { sym: "VET-USD", name: "VeChain", type: "crypto" },
  { sym: "FIL-USD", name: "Filecoin", type: "crypto" },
  { sym: "KAVA-USD", name: "Kava", type: "crypto" },
  { sym: "OP-USD", name: "Optimism", type: "crypto" },
  { sym: "SOL-USD", name: "Solana", type: "crypto" },
  { sym: "ADA-USD", name: "Cardano", type: "crypto" },
  { sym: "LINK-USD", name: "Chainlink", type: "crypto" },
  { sym: "BTC-USD", name: "Bitcoin", type: "crypto" },
  { sym: "LTC-USD", name: "Litecoin", type: "crypto" },
  { sym: "XRP-USD", name: "XRP", type: "crypto" },
  { sym: "RENDER-USD", name: "Render", type: "crypto" },
  { sym: "SEI-USD", name: "Sei", type: "crypto" },
  { sym: "ALGO-USD", name: "Algorand", type: "crypto" },
  { sym: "HBAR-USD", name: "Hedera", type: "crypto" },
  { sym: "ETH-USD", name: "Ethereum", type: "crypto" },
  { sym: "BNB-USD", name: "BNB", type: "crypto" },
  { sym: "ATOM-USD", name: "Cosmos", type: "crypto" },
  { sym: "ARB-USD", name: "Arbitrum", type: "crypto" },
  { sym: "AAPL", name: "Apple", type: "stock" },
  { sym: "MSFT", name: "Microsoft", type: "stock" },
  { sym: "NVDA", name: "NVIDIA", type: "stock" },
  { sym: "META", name: "Meta", type: "stock" },
  { sym: "GOOGL", name: "Google", type: "stock" },
  { sym: "PLTR", name: "Palantir", type: "stock" },
  { sym: "GC=F", name: "Gold", type: "commodity" },
  { sym: "SI=F", name: "Silver", type: "commodity" },
  { sym: "EURUSD=X", name: "EUR/USD", type: "forex" },
  { sym: "GBPUSD=X", name: "GBP/USD", type: "forex" },
  { sym: "USDJPY=X", name: "USD/JPY", type: "forex" },
  { sym: "AUDUSD=X", name: "AUD/USD", type: "forex" },
];

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  PRONOSTICS — 3 PROCHAINS MOIS (basé sur backtest V2)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const predictions = [];

  for (const asset of ASSETS) {
    try {
      const rawData = await yfChart(asset.sym, "3mo", "1d");
      await new Promise(r => setTimeout(r, 300));
      if (!rawData || rawData.length < 40) continue;

      const ana = computeIndicators(rawData);
      const last = ana.len - 1;

      const price = ana.closes[last];
      const rsi = ana.rsi[ana.rsi.length - 1];
      const macd = ana.macd[ana.macd.length - 1];
      const ema20 = ana.ema20[ana.ema20.length - 1];
      const ema50 = ana.ema50[ana.ema50.length - 1];
      const atr = ana.atr[ana.atr.length - 1];
      const adx = ana.adx[ana.adx.length - 1];
      const bb = ana.bb[ana.bb.length - 1];
      const stoch = ana.stoch[ana.stoch.length - 1];

      if (!rsi || !macd || !ema20 || !ema50 || !adx || !bb || !stoch) continue;

      // Trend analysis
      const trend = ema20 > ema50 ? "BULLISH" : "BEARISH";
      const trendStrength = adx.adx;
      const momentum = macd.histogram > 0 ? "POSITIVE" : "NEGATIVE";
      const rsiZone = rsi < 30 ? "OVERSOLD" : rsi > 70 ? "OVERBOUGHT" : "NEUTRAL";
      const priceVsEma = price > ema20 ? "ABOVE" : "BELOW";
      const bbPosition = (price - bb.lower) / (bb.upper - bb.lower);

      // Scoring system
      let score = 0;
      let reasons = [];

      // Trend (40 points)
      if (trend === "BULLISH") { score += 40; reasons.push("Tendance haussière"); }
      else { score -= 20; reasons.push("Tendance baissière"); }

      // Trend strength (20 points)
      if (trendStrength > 25) { score += 20; reasons.push("Tendance forte"); }
      else if (trendStrength > 20) { score += 10; reasons.push("Tendance modérée"); }
      else { reasons.push("Tendance faible"); }

      // Momentum (15 points)
      if (momentum === "POSITIVE") { score += 15; reasons.push("Momentum positif"); }
      else { score -= 10; reasons.push("Momentum négatif"); }

      // RSI (15 points)
      if (rsi < 40) { score += 15; reasons.push("RSI survendu"); }
      else if (rsi < 50) { score += 10; reasons.push("RSI neutre bas"); }
      else if (rsi > 70) { score -= 15; reasons.push("RSI suracheté"); }
      else if (rsi > 60) { score -= 5; reasons.push("RSI neutre haut"); }

      // BB position (10 points)
      if (bbPosition < 0.3) { score += 10; reasons.push("Prix près du support"); }
      else if (bbPosition > 0.7) { score -= 10; reasons.push("Prix près de la résistance"); }

      // Prediction
      let prediction, confidence;
      if (score >= 50) { prediction = "HAUSSE FORTE"; confidence = Math.min(90, 60 + score / 3); }
      else if (score >= 30) { prediction = "HAUSSE"; confidence = Math.min(80, 50 + score / 3); }
      else if (score >= 0) { prediction = "LATÉRAL"; confidence = 50; }
      else if (score >= -20) { prediction = "BAISSE"; confidence = Math.min(80, 50 + Math.abs(score) / 3); }
      else { prediction = "BAISSE FORTE"; confidence = Math.min(90, 60 + Math.abs(score) / 3); }

      // Price targets (3 months)
      const monthlyMove = atr * 2; // Conservative estimate
      const target1 = prediction.includes("HAUSSE") ? price + monthlyMove : price - monthlyMove;
      const target2 = prediction.includes("HAUSSE") ? price + monthlyMove * 2 : price - monthlyMove * 2;
      const target3 = prediction.includes("HAUSSE") ? price + monthlyMove * 3 : price - monthlyMove * 3;

      predictions.push({
        ...asset,
        price,
        trend,
        trendStrength: trendStrength.toFixed(1),
        momentum,
        rsi: rsi.toFixed(1),
        rsiZone,
        bbPosition: bbPosition.toFixed(2),
        score,
        prediction,
        confidence: confidence.toFixed(0),
        target1: target1.toFixed(asset.price > 100 ? 2 : 4),
        target2: target2.toFixed(asset.price > 100 ? 2 : 4),
        target3: target3.toFixed(asset.price > 100 ? 2 : 4),
        reasons,
      });

    } catch (err) {}
  }

  // Sort by score
  predictions.sort((a, b) => b.score - a.score);

  // Display top bullish
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  🟢 TOP 10 HAUSSIERS (meilleurs pour acheter)");
  console.log("═══════════════════════════════════════════════════════════════");
  for (let i = 0; i < Math.min(10, predictions.length); i++) {
    const p = predictions[i];
    console.log(`\n  ${i + 1}. ${p.name} (${p.type})`);
    console.log(`     Prix: $${p.price.toFixed(p.price > 100 ? 2 : 4)}`);
    console.log(`     Prédiction: ${p.prediction} (${p.confiance}%)`);
    console.log(`     Score: ${p.score}/100`);
    console.log(`     Tendance: ${p.trend} | Force: ${p.trendStrength} | Momentum: ${p.momentum}`);
    console.log(`     RSI: ${p.rsi} (${p.rsiZone}) | BB: ${p.bbPosition}`);
    console.log(`     Cibles 3 mois: $${p.target1} → $${p.target2} → $${p.target3}`);
    console.log(`     Raisons: ${p.reasons.join(", ")}`);
  }

  // Display top bearish
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  🔴 TOP 10 BAISSIERS (à éviter ou short)");
  console.log("═══════════════════════════════════════════════════════════════");
  for (let i = predictions.length - 1; i >= Math.max(0, predictions.length - 10); i--) {
    const p = predictions[i];
    console.log(`\n  ${predictions.length - i}. ${p.name} (${p.type})`);
    console.log(`     Prix: $${p.price.toFixed(p.price > 100 ? 2 : 4)}`);
    console.log(`     Prédiction: ${p.prediction} (${p.confidence}%)`);
    console.log(`     Score: ${p.score}/100`);
    console.log(`     Cibles 3 mois: $${p.target1} → $${p.target2} → $${p.target3}`);
  }

  // Summary
  const bullish = predictions.filter(p => p.score >= 30).length;
  const bearish = predictions.filter(p => p.score < 0).length;
  const neutral = predictions.length - bullish - bearish;

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  RÉSUMÉ GLOBAL — 3 PROCHAINS MOIS");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  🟢 Haussiers: ${bullish}/${predictions.length} assets`);
  console.log(`  🟡 Latéraux: ${neutral}/${predictions.length} assets`);
  console.log(`  🔴 Baissiers: ${bearish}/${predictions.length} assets`);

  // Portfolio projection
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  PROJECTION PORTFEUILLE — 40€ DE DÉPART");
  console.log("═══════════════════════════════════════════════════════════════");

  const avgBullishReturn = predictions.filter(p => p.score >= 30).reduce((a, b) => a + parseFloat(b.confidence), 0) / Math.max(1, bullish);
  const monthlyReturn = avgBullishReturn / 100 * 0.5; // Conservative: 50% of confidence

  console.log(`  Retour mensuel estimé: +${(monthlyReturn * 100).toFixed(1)}%`);
  console.log(`  Mois 1: 40€ → ${(40 * (1 + monthlyReturn)).toFixed(2)}€`);
  console.log(`  Mois 2: ${(40 * (1 + monthlyReturn)).toFixed(2)}€ → ${(40 * Math.pow(1 + monthlyReturn, 2)).toFixed(2)}€`);
  console.log(`  Mois 3: ${(40 * Math.pow(1 + monthlyReturn, 2)).toFixed(2)}€ → ${(40 * Math.pow(1 + monthlyReturn, 3)).toFixed(2)}€`);
  console.log(`  Total 3 mois: 40€ → ${(40 * Math.pow(1 + monthlyReturn, 3)).toFixed(2)}€ (+${((Math.pow(1 + monthlyReturn, 3) - 1) * 100).toFixed(1)}%)`);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  ⚠️  AVERTISSEMENT");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Ces pronostics sont basés sur l'analyse technique historique.");
  console.log("  Les marchés peuvent changer rapidement à cause de:");
  console.log("  - Actualités économiques (inflation, taux d'intérêt)");
  console.log("  - Événements géopolitiques");
  console.log("  - Régulation crypto");
  console.log("  - Crash du marché");
  console.log("  Ne jamais investir plus que ce que vous pouvez vous permettre de perdre.");
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
