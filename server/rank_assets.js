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

function calculateVWAP(rawData) {
  const vwap = [];
  let cumVolumePrice = 0;
  let cumVolume = 0;
  for (let i = 0; i < rawData.length; i++) {
    const typicalPrice = (rawData[i].high + rawData[i].low + rawData[i].close) / 3;
    cumVolumePrice += typicalPrice * rawData[i].volume;
    cumVolume += rawData[i].volume;
    vwap.push(cumVolume > 0 ? cumVolumePrice / cumVolume : rawData[i].close);
  }
  return vwap;
}

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
    volSma20: SMA.calculate({ values: volumes, period: 20 }),
    adx: ADX.calculate({ high: highs, low: lows, close: closes, period: 14 }),
    vwap: calculateVWAP(rawData),
  };
}

function applySlippage(price, side) {
  return side === "BUY" ? price * 1.0005 : price * 0.9995;
}

function calculateFees(amount) {
  return amount * 0.0005;
}

function getKellyCriterion(wins, losses, recentPnL) {
  const totalTrades = wins + losses;
  if (totalTrades < 10) return 0.5;
  const winRate = wins / totalTrades;
  const avgWin = recentPnL.filter(p => p > 0).length > 0 
    ? recentPnL.filter(p => p > 0).reduce((a, b) => a + b, 0) / recentPnL.filter(p => p > 0).length 
    : 1;
  const avgLoss = recentPnL.filter(p => p < 0).length > 0 
    ? Math.abs(recentPnL.filter(p => p < 0).reduce((a, b) => a + b, 0) / recentPnL.filter(p => p < 0).length) 
    : 1;
  const winLossRatio = avgWin / avgLoss;
  const kelly = ((winLossRatio * winRate) - (1 - winRate)) / winLossRatio;
  return Math.max(0.1, Math.min(0.5, kelly));
}

function backtestAsset(sym, rawData, config) {
  if (!rawData || rawData.length < 40) return null;
  const ana = computeIndicators(rawData);
  const { tpMultiplier, slMultiplier, trailMultiplier, riskPct, maxHoldBars, maxPositions } = config;
  let balance = 500;
  let peak = 500;
  let positions = [];
  let maxDrawdown = 0, wins = 0, losses = 0;
  let consecutiveLosses = 0;
  let cooldown = 0;
  let recentPnL = [];
  let totalFees = 0;

  for (let i = 35; i < ana.len; i++) {
    const { closes, rsi, macd, ema20, ema50, atr, adx, vwap } = ana;
    const price = closes[i];
    const rI = i - (ana.len - rsi.length);
    const mI = i - (ana.len - macd.length);
    const e20I = i - (ana.len - ema20.length);
    const e50I = i - (ana.len - ema50.length);
    const aI = i - (ana.len - atr.length);
    const adxI = i - (ana.len - adx.length);
    const vwapI = i - (ana.len - vwap.length);

    const rsiVal = getVal(rsi, rI);
    const macdCurr = getVal(macd, mI);
    const macdPrev = getVal(macd, mI - 1);
    const ema20Val = getVal(ema20, e20I);
    const ema50Val = getVal(ema50, e50I);
    const atrVal = getVal(atr, aI);
    const adxVal = getVal(adx, adxI);
    const vwapVal = getVal(vwap, vwapI);

    if (!rsiVal || !macdCurr || !ema20Val || !ema50Val || !atrVal || !adxVal || !vwapVal) continue;

    const kellyMult = getKellyCriterion(wins, losses, recentPnL);

    // Exit
    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      pos.bars++;
      let shouldExit = false, exitPrice = price;
      
      if (pos.side === "LONG") {
        if (price > pos.bestPrice) pos.bestPrice = price;
        const trailSl = pos.bestPrice - atrVal * trailMultiplier;
        if (trailSl > pos.sl) pos.sl = trailSl;
        if (price <= pos.sl) { shouldExit = true; exitPrice = pos.sl; }
        else if (price >= pos.tp) { shouldExit = true; exitPrice = pos.tp; }
        else if (pos.bars >= maxHoldBars) { shouldExit = true; }
        else if (ema20Val < ema50Val) { shouldExit = true; }
      } else {
        if (price < pos.bestPrice) pos.bestPrice = price;
        const trailSl = pos.bestPrice + atrVal * trailMultiplier;
        if (trailSl < pos.sl) pos.sl = trailSl;
        if (price >= pos.sl) { shouldExit = true; exitPrice = pos.sl; }
        else if (price <= pos.tp) { shouldExit = true; exitPrice = pos.tp; }
        else if (pos.bars >= maxHoldBars) { shouldExit = true; }
        else if (ema20Val > ema50Val) { shouldExit = true; }
      }
      
      if (shouldExit) {
        const exitSlippage = applySlippage(exitPrice, pos.side === "LONG" ? "SELL" : "BUY");
        const pnl = pos.side === "LONG" ? pos.qty * (exitSlippage - pos.entryPrice) : pos.qty * (pos.entryPrice - exitSlippage);
        const fees = calculateFees(pos.cost + pnl);
        balance += pos.cost + pnl - fees;
        totalFees += fees;
        recentPnL.push(pnl);
        if (recentPnL.length > 20) recentPnL.shift();
        if (pnl > 0) { wins++; consecutiveLosses = 0; } else { losses++; consecutiveLosses++; cooldown = 3; }
        positions.splice(p, 1);
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }
    }

    if (cooldown > 0) { cooldown--; continue; }
    if (consecutiveLosses >= 5) { cooldown = 10; continue; }

    const longTrend = ema20Val > ema50Val;
    const shortTrend = ema20Val < ema50Val;
    const rsiRising = rsiVal > (getVal(rsi, rI - 1) || rsiVal);
    const rsiFalling = rsiVal < (getVal(rsi, rI - 1) || rsiVal);
    const macdRising = macdCurr.histogram > (macdPrev?.histogram || 0);
    const macdFalling = macdCurr.histogram < (macdPrev?.histogram || 0);

    if (positions.length < maxPositions && balance > 5) {
      if (longTrend && rsiVal < 65 && rsiVal > 25 && macdCurr.histogram > 0 && (rsiRising || macdRising)) {
        const riskAmount = balance * riskPct * kellyMult;
        const slDist = atrVal * slMultiplier;
        let qty = +(riskAmount / slDist).toFixed(8);
        let cost = qty * price;
        if (cost > balance * 0.9) { qty = +((balance * 0.9) / price).toFixed(8); cost = qty * price; }
        const entrySlippage = applySlippage(price, "BUY");
        const fees = calculateFees(cost);
        if (cost > 0 && cost + fees <= balance) {
          positions.push({ side: "LONG", entryPrice: entrySlippage, qty, cost: cost + fees, tp: entrySlippage + atrVal * tpMultiplier, sl: entrySlippage - slDist, bestPrice: entrySlippage, bars: 0 });
          balance -= cost + fees;
          totalFees += fees;
        }
      }
      else if (shortTrend && rsiVal > 35 && rsiVal < 75 && macdCurr.histogram < 0 && (rsiFalling || macdFalling)) {
        const riskAmount = balance * riskPct * kellyMult;
        const slDist = atrVal * slMultiplier;
        let qty = +(riskAmount / slDist).toFixed(8);
        let cost = qty * price;
        if (cost > balance * 0.9) { qty = +((balance * 0.9) / price).toFixed(8); cost = qty * price; }
        const entrySlippage = applySlippage(price, "SELL");
        const fees = calculateFees(cost);
        if (cost > 0 && cost + fees <= balance) {
          positions.push({ side: "SHORT", entryPrice: entrySlippage, qty, cost: cost + fees, tp: entrySlippage - atrVal * tpMultiplier, sl: entrySlippage + slDist, bestPrice: entrySlippage, bars: 0 });
          balance -= cost + fees;
          totalFees += fees;
        }
      }
    }
  }

  for (const pos of positions) {
    const lastPrice = ana.closes[ana.len - 1];
    const exitSlippage = applySlippage(lastPrice, pos.side === "LONG" ? "SELL" : "BUY");
    const pnl = pos.side === "LONG" ? pos.qty * (exitSlippage - pos.entryPrice) : pos.qty * (pos.entryPrice - exitSlippage);
    const fees = calculateFees(pos.cost + pnl);
    balance += pos.cost + pnl - fees;
    totalFees += fees;
    if (pnl > 0) wins++; else losses++;
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
  const pnlPct = ((balance - 500) / 500 * 100).toFixed(1);

  return { totalTrades, wins, losses, winRate: +winRate, pnlPct: +pnlPct, finalBalance: balance, maxDrawdown: +(maxDrawdown * 100).toFixed(1), totalFees: +totalFees.toFixed(2) };
}

const STRAT = { riskPct: 0.30, tpMultiplier: 2.0, slMultiplier: 0.6, trailMultiplier: 0.3, maxHoldBars: 15, maxPositions: 3 };

// ALL assets to test
const ALL_ASSETS = [
  // Crypto
  { sym: "BTC-USD", name: "Bitcoin", type: "crypto" },
  { sym: "ETH-USD", name: "Ethereum", type: "crypto" },
  { sym: "SOL-USD", name: "Solana", type: "crypto" },
  { sym: "DOGE-USD", name: "Dogecoin", type: "crypto" },
  { sym: "ADA-USD", name: "Cardano", type: "crypto" },
  { sym: "AVAX-USD", name: "Avalanche", type: "crypto" },
  { sym: "LINK-USD", name: "Chainlink", type: "crypto" },
  { sym: "DOT-USD", name: "Polkadot", type: "crypto" },
  { sym: "XRP-USD", name: "XRP", type: "crypto" },
  { sym: "MATIC-USD", name: "Polygon", type: "crypto" },
  { sym: "UNI-USD", name: "Uniswap", type: "crypto" },
  { sym: "ATOM-USD", name: "Cosmos", type: "crypto" },
  { sym: "NEAR-USD", name: "NEAR", type: "crypto" },
  { sym: "APT-USD", name: "Aptos", type: "crypto" },
  { sym: "SUI-USD", name: "Sui", type: "crypto" },
  { sym: "ARB-USD", name: "Arbitrum", type: "crypto" },
  { sym: "OP-USD", name: "Optimism", type: "crypto" },
  { sym: "FIL-USD", name: "Filecoin", type: "crypto" },
  { sym: "RENDER-USD", name: "Render", type: "crypto" },
  { sym: "FET-USD", name: "Fetch.ai", type: "crypto" },
  { sym: "INJ-USD", name: "Injective", type: "crypto" },
  { sym: "TIA-USD", name: "Celestia", type: "crypto" },
  { sym: "SEI-USD", name: "Sei", type: "crypto" },
  { sym: "BNB-USD", name: "BNB", type: "crypto" },
  { sym: "LTC-USD", name: "Litecoin", type: "crypto" },
  { sym: "SHIB-USD", name: "Shiba Inu", type: "crypto" },
  { sym: "TRX-USD", name: "Tron", type: "crypto" },
  { sym: "HBAR-USD", name: "Hedera", type: "crypto" },
  { sym: "ICP-USD", name: "ICP", type: "crypto" },
  { sym: "PEPE-USD", name: "Pepe", type: "crypto" },
  { sym: "WLD-USD", name: "Worldcoin", type: "crypto" },
  { sym: "TAO-USD", name: "Bittensor", type: "crypto" },
  { sym: "GRT-USD", name: "Graph", type: "crypto" },
  { sym: "STX-USD", name: "Stacks", type: "crypto" },
  { sym: "KAVA-USD", name: "Kava", type: "crypto" },
  { sym: "ALGO-USD", name: "Algorand", type: "crypto" },
  { sym: "VET-USD", name: "VeChain", type: "crypto" },
  { sym: "FTM-USD", name: "Fantom", type: "crypto" },
  // Stocks
  { sym: "AAPL", name: "Apple", type: "stock" },
  { sym: "MSFT", name: "Microsoft", type: "stock" },
  { sym: "GOOGL", name: "Google", type: "stock" },
  { sym: "AMZN", name: "Amazon", type: "stock" },
  { sym: "TSLA", name: "Tesla", type: "stock" },
  { sym: "NVDA", name: "NVIDIA", type: "stock" },
  { sym: "META", name: "Meta", type: "stock" },
  { sym: "AMD", name: "AMD", type: "stock" },
  { sym: "NFLX", name: "Netflix", type: "stock" },
  { sym: "COIN", name: "Coinbase", type: "stock" },
  { sym: "PLTR", name: "Palantir", type: "stock" },
  { sym: "SQ", name: "Block", type: "stock" },
  { sym: "SHOP", name: "Shopify", type: "stock" },
  { sym: "ABNB", name: "Airbnb", type: "stock" },
  { sym: "CRM", name: "Salesforce", type: "stock" },
  { sym: "SNOW", name: "Snowflake", type: "stock" },
  // Forex
  { sym: "EURUSD=X", name: "EUR/USD", type: "forex" },
  { sym: "GBPUSD=X", name: "GBP/USD", type: "forex" },
  { sym: "USDJPY=X", name: "USD/JPY", type: "forex" },
  { sym: "AUDUSD=X", name: "AUD/USD", type: "forex" },
  { sym: "USDCAD=X", name: "USD/CAD", type: "forex" },
  { sym: "EURJPY=X", name: "EUR/JPY", type: "forex" },
  { sym: "GBPJPY=X", name: "GBP/JPY", type: "forex" },
  // Commodities
  { sym: "GC=F", name: "Gold", type: "commodity" },
  { sym: "SI=F", name: "Silver", type: "commodity" },
  { sym: "CL=F", name: "Oil WTI", type: "commodity" },
  { sym: "NG=F", name: "Gas", type: "commodity" },
  { sym: "HG=F", name: "Copper", type: "commodity" },
  // Indices
  { sym: "^GSPC", name: "S&P 500", type: "index" },
  { sym: "^NDX", name: "Nasdaq 100", type: "index" },
  { sym: "^DJI", name: "Dow Jones", type: "index" },
];

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  RANKING DES MEILLEURS ASSETS — 500€ | 3 mois | daily");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const results = [];

  for (const asset of ALL_ASSETS) {
    try {
      const rawData = await yfChart(asset.sym, "3mo", "1d");
      await new Promise(r => setTimeout(r, 300));
      if (!rawData || rawData.length < 40) continue;
      const result = backtestAsset(asset.sym, rawData, STRAT);
      if (result && result.totalTrades > 0) {
        results.push({ ...asset, ...result });
        const emoji = result.pnlPct >= 0 ? "🟢" : "🔴";
        process.stdout.write(`  ${emoji} ${asset.name.padEnd(14)} ${result.pnlPct >= 0 ? "+" : ""}${result.pnlPct}% | WR:${result.winRate}% | ${result.totalTrades}t | DD:${result.maxDrawdown}% | Fees:${result.totalFees}€\n`);
      }
    } catch (err) {
      // Skip failed assets
    }
  }

  // Sort by profit
  results.sort((a, b) => b.pnlPct - a.pnlPct);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  TOP 20 MEILLEURS ASSETS");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  ${"#".padStart(3)} | ${"Asset".padEnd(14)} | ${"Type".padEnd(10)} | ${"Profit".padStart(8)} | ${"WR".padStart(6)} | ${"Trades".padStart(6)} | ${"MaxDD".padStart(6)} | ${"Fees".padStart(8)}`);
  console.log(`  ${"─".repeat(3)}─┼─${"─".repeat(14)}─┼─${"─".repeat(10)}─┼─${"─".repeat(8)}─┼─${"─".repeat(6)}─┼─${"─".repeat(6)}─┼─${"─".repeat(6)}─┼─${"─".repeat(8)}`);

  for (let i = 0; i < Math.min(20, results.length); i++) {
    const r = results[i];
    const emoji = r.pnlPct >= 0 ? "🟢" : "🔴";
    console.log(`  ${String(i + 1).padStart(3)} | ${r.name.padEnd(14)} | ${r.type.padEnd(10)} | ${emoji}${r.pnlPct >= 0 ? "+" : ""}${String(r.pnlPct).padStart(5)}% | ${(r.winRate + "%").padStart(6)} | ${String(r.totalTrades).padStart(6)} | ${(r.maxDrawdown + "%").padStart(6)} | ${(r.totalFees + "€").padStart(8)}`);
  }

  // Bottom 10
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  10 PIRES ASSETS (à éviter)");
  console.log("═══════════════════════════════════════════════════════════════");
  for (let i = Math.max(0, results.length - 10); i < results.length; i++) {
    const r = results[i];
    console.log(`  🔴 ${r.name.padEnd(14)} ${r.pnlPct}% | WR:${r.winRate}% | ${r.totalTrades}t`);
  }

  // Summary by type
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  RÉSUMÉ PAR TYPE");
  console.log("═══════════════════════════════════════════════════════════════");
  const types = ["crypto", "stock", "forex", "commodity", "index"];
  for (const type of types) {
    const typeResults = results.filter(r => r.type === type);
    if (typeResults.length === 0) continue;
    const avgProfit = (typeResults.reduce((a, b) => a + b.pnlPct, 0) / typeResults.length).toFixed(1);
    const winners = typeResults.filter(r => r.pnlPct > 0).length;
    console.log(`  ${type.padEnd(10)}: ${winners}/${typeResults.length} gagnants | Moyenne: ${avgProfit >= 0 ? "+" : ""}${avgProfit}%`);
  }

  // Best assets to keep
  const bestAssets = results.filter(r => r.pnlPct > 0).slice(0, 30);
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`  TOP ${bestAssets.length} ASSETS À GARDER DANS LE BOT`);
  console.log("═══════════════════════════════════════════════════════════════");
  for (const r of bestAssets) {
    console.log(`  ✅ ${r.name.padEnd(14)} (${r.type}) — +${r.pnlPct}%`);
  }
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
