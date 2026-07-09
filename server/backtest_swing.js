import "dotenv/config";
import { RSI, MACD, BollingerBands, EMA, SMA, ATR, ADX } from "technicalindicators";

const YF_H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0" };

async function yfChart(symbol, range = "6mo", interval = "1d") {
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
  return {
    closes, highs, lows, len: closes.length,
    rsi: RSI.calculate({ values: closes, period: 14 }),
    macd: MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }),
    bb: BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 }),
    ema9: EMA.calculate({ values: closes, period: 9 }),
    ema21: EMA.calculate({ values: closes, period: 21 }),
    ema50: EMA.calculate({ values: closes, period: 50 }),
    sma200: SMA.calculate({ values: closes, period: 200 }),
    atr: ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }),
    adx: ADX.calculate({ high: highs, low: lows, close: closes, period: 14 }),
  };
}

// Find support/resistance levels
function findLevels(rawData, lookback = 20) {
  const levels = [];
  for (let i = lookback; i < rawData.length - lookback; i++) {
    const high = rawData[i].high;
    const low = rawData[i].low;
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (rawData[i - j].high >= high || rawData[i + j].high >= high) isHigh = false;
      if (rawData[i - j].low <= low || rawData[i + j].low <= low) isLow = false;
    }
    if (isHigh) levels.push({ type: "RESISTANCE", price: high });
    if (isLow) levels.push({ type: "SUPPORT", price: low });
  }
  return levels;
}

// Check if price is near a level
function nearLevel(price, levels, tolerance = 0.02) {
  for (const l of levels) {
    if (Math.abs(price - l.price) / l.price < tolerance) return l;
  }
  return null;
}

// Calculate risk/reward ratio
function calculateRR(entry, sl, tp) {
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  return reward / risk;
}

// SWING TRADING STRATEGY - SIMPLE
function analyzeSwing(ana, idx, rawData) {
  const { closes, rsi, macd, ema9, ema21, ema50, sma200, atr, adx } = ana;
  const price = closes[idx];
  
  const rsiVal = getVal(rsi, idx - (ana.len - rsi.length));
  const macdCurr = getVal(macd, idx - (ana.len - macd.length));
  const macdPrev = getVal(macd, idx - (ana.len - macd.length) - 1);
  const ema9Val = getVal(ema9, idx - (ana.len - ema9.length));
  const ema21Val = getVal(ema21, idx - (ana.len - ema21.length));
  const ema50Val = getVal(ema50, idx - (ana.len - ema50.length));
  const sma200Val = getVal(sma200, idx - (ana.len - sma200.length));
  const atrVal = getVal(atr, idx - (ana.len - atr.length));
  const adxVal = getVal(adx, idx - (ana.len - adx.length));
  
  if (!rsiVal || !macdCurr || !ema9Val || !ema21Val || !atrVal || !adxVal) return null;
  
  const strongTrend = adxVal.adx > 15;
  
  // Previous values for crossover
  const ema9Prev = getVal(ema9, idx - (ana.len - ema9.length) - 1);
  const ema21Prev = getVal(ema21, idx - (ana.len - ema21.length) - 1);
  
  // MACD histogram direction
  const macdRising = macdPrev && macdCurr.histogram > macdPrev.histogram;
  const macdFalling = macdPrev && macdCurr.histogram < macdPrev.histogram;
  
  // === LONG: EMA9 > EMA21 + RSI < 50 + MACD rising ===
  if (ema9Val > ema21Val && rsiVal < 50 && rsiVal > 20 && macdRising) {
    const sl = price * 0.97; // 3% SL
    const tp = price * 1.06; // 6% TP (2:1 RR)
    const rr = calculateRR(price, sl, tp);
    
    if (rr >= 1.5) {
      const reasons = ["EMA9 > EMA21", "MACD rising"];
      if (strongTrend) reasons.push("ADX strong");
      return { side: "LONG", entry: price, sl, tp, rr, score: reasons.length, reasons };
    }
  }
  
  // === SHORT: EMA9 < EMA21 + RSI > 45 + MACD falling ===
  if (ema9Val < ema21Val && rsiVal > 45 && rsiVal < 80 && macdFalling) {
    const sl = price * 1.03; // 3% SL
    const tp = price * 0.94; // 6% TP (2:1 RR)
    const rr = calculateRR(price, sl, tp);
    
    if (rr >= 1.5) {
      const reasons = ["EMA9 < EMA21", "MACD falling"];
      if (strongTrend) reasons.push("ADX strong");
      return { side: "SHORT", entry: price, sl, tp, rr, score: reasons.length, reasons };
    }
  }
  
  return null;
}

// BACKTEST FUNCTION
function backtestSwing(sym, rawData, config, initialBalance) {
  if (!rawData || rawData.length < 50) return null;
  
  const ana = computeIndicators(rawData);
  const { riskPct, maxPositions, maxDrawdownPct } = config;
  
  let balance = initialBalance;
  let peak = initialBalance;
  let positions = [];
  let maxDrawdown = 0, wins = 0, losses = 0;
  let totalFees = 0;
  let totalTrades = 0;
  let cooldown = 0; // Cooldown after loss
  
  for (let i = 50; i < ana.len; i++) {
    const price = ana.closes[i];
    
    // Check drawdown limit
    if (maxDrawdown > 0.20) continue; // Stop trading if -20% drawdown
    
    // Cooldown after loss
    if (cooldown > 0) {
      cooldown--;
      continue;
    }
    
    // Debug: print indicators for first few candles
    if (i < 55) {
      const rsiVal = getVal(ana.rsi, i - (ana.len - ana.rsi.length));
      const ema9Val = getVal(ana.ema9, i - (ana.len - ana.ema9.length));
      const ema21Val = getVal(ana.ema21, i - (ana.len - ana.ema21.length));
      console.log(`  [${i}] Price: ${price.toFixed(2)} | RSI: ${rsiVal?.toFixed(1) || 'N/A'} | EMA9: ${ema9Val?.toFixed(2) || 'N/A'} | EMA21: ${ema21Val?.toFixed(2) || 'N/A'}`);
    }
    
    // Exit existing positions
    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      pos.bars++;
      
      // Update trailing stop
      if (pos.side === "LONG") {
        const newTrail = price * 0.98; // 2% below current price
        if (newTrail > pos.sl) pos.sl = newTrail; // Move SL up
      } else {
        const newTrail = price * 1.02; // 2% above current price
        if (newTrail < pos.sl) pos.sl = newTrail; // Move SL down
      }
      
      let shouldExit = false, exitPrice = price;
      
      if (pos.side === "LONG") {
        // Exit conditions for swing trade
        if (price <= pos.sl) { shouldExit = true; exitPrice = pos.sl; }
        else if (price >= pos.tp) { shouldExit = true; exitPrice = pos.tp; }
        else if (pos.bars >= 14) { shouldExit = true; } // Max 2 weeks hold
      } else {
        if (price >= pos.sl) { shouldExit = true; exitPrice = pos.sl; }
        else if (price <= pos.tp) { shouldExit = true; exitPrice = pos.tp; }
        else if (pos.bars >= 14) { shouldExit = true; }
      }
      
      if (shouldExit) {
        const fees = (pos.cost * 0.001); // 0.1% fees
        const pnl = pos.side === "LONG" 
          ? pos.qty * (exitPrice - pos.entry) 
          : pos.qty * (pos.entry - exitPrice);
        balance += pos.cost + pnl - fees;
        totalFees += fees;
        totalTrades++;
        if (pnl > 0) { wins++; } else { losses++; cooldown = 5; } // 5 days cooldown after loss
        positions.splice(p, 1);
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }
    }
    
  // Check for new entry
  if (positions.length < maxPositions) {
    const signal = analyzeSwing(ana, i, rawData.slice(0, i + 1));
    if (signal) {
      console.log(`  📊 Signal: ${signal.side} at ${signal.entry.toFixed(2)} | RR: ${signal.rr.toFixed(1)} | ${signal.reasons.join(', ')}`);
      
      // Simple position sizing: use max 50% of balance per trade
      const maxCost = balance * 0.50;
      const qty = maxCost / signal.entry;
      const cost = qty * signal.entry;
      
      console.log(`    MaxCost: ${maxCost.toFixed(2)}€ | Qty: ${qty.toFixed(4)} | Cost: ${cost.toFixed(2)}€ | Balance: ${balance.toFixed(2)}€`);
      
      if (cost <= balance * 0.95) { // Keep 5% cash buffer
        positions.push({
          side: signal.side,
          entry: signal.entry,
          sl: signal.sl,
          tp: signal.tp,
            qty,
            cost,
            bars: 0,
          });
          balance -= cost;
        }
      }
    }
  }
  
  // Close remaining positions at market price
  for (const pos of positions) {
    const lastPrice = ana.closes[ana.len - 1];
    const fees = (pos.cost * 0.001);
    const pnl = pos.side === "LONG" 
      ? pos.qty * (lastPrice - pos.entry) 
      : pos.qty * (pos.entry - lastPrice);
    balance += pos.cost + pnl - fees;
    totalFees += fees;
    totalTrades++;
    if (pnl > 0) wins++; else losses++;
  }
  
  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
  const pnlPct = ((balance - initialBalance) / initialBalance * 100).toFixed(1);
  
  return { 
    totalTrades, wins, losses, winRate: +winRate, pnlPct: +pnlPct, 
    finalBalance: balance, maxDrawdown: +(maxDrawdown * 100).toFixed(1), 
    totalFees: +totalFees.toFixed(2) 
  };
}

// CONFIGURATION - SWING TRADING PRO V2
const SWING_CONFIG = {
  riskPct: 0.02,        // 2% risk per trade (reduce drawdown)
  maxPositions: 2,      // Max 2 positions (diversify)
  maxDrawdownPct: 0.15, // Stop if -15% drawdown
};

// ASSETS - Top performers only
const ASSETS = [
  // Crypto (trendy, volatile)
  { sym: "BTC-USD", name: "Bitcoin" },
  { sym: "ETH-USD", name: "Ethereum" },
  { sym: "SOL-USD", name: "Solana" },
  { sym: "AVAX-USD", name: "Avalanche" },
  { sym: "LINK-USD", name: "Chainlink" },
  // Stocks (strong trends)
  { sym: "NVDA", name: "NVIDIA" },
  { sym: "AMD", name: "AMD" },
  { sym: "TSLA", name: "Tesla" },
  { sym: "META", name: "Meta" },
  { sym: "AMZN", name: "Amazon" },
  // Forex (stable trends)
  { sym: "EURUSD=X", name: "EUR/USD" },
  { sym: "GBPUSD=X", name: "GBP/USD" },
  // Commodities
  { sym: "GC=F", name: "Gold" },
  { sym: "SI=F", name: "Silver" },
];

// MAIN
async function main() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  SWING TRADING PRO — 3 MOIS | 250€ | Risk 5% | Daily Candles");
  console.log("═══════════════════════════════════════════════════════════════\n");
  
  console.log("Fetching 3 mois de données daily...\n");
  const allData = {};
  for (const asset of ASSETS) {
    try {
      allData[asset.sym] = await yfChart(asset.sym, "3mo", "1d");
      process.stdout.write(`  ✓ ${asset.name} (${allData[asset.sym].length} candles)\n`);
      await new Promise(r => setTimeout(r, 250));
    } catch (err) {
      process.stdout.write(`  ✗ ${asset.name}: ${err.message}\n`);
    }
  }
  
  console.log(`\nData: ${Object.keys(allData).length} assets.\n`);
  
  let balance = 250;
  let totalWins = 0, totalLosses = 0;
  let maxDD = 0;
  let totalFeesAll = 0;
  let allTrades = [];
  
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ÉVOLUTION DU SOLDE (compound)");
  console.log("═══════════════════════════════════════════════════════════════\n");
  
  for (const asset of ASSETS) {
    if (!allData[asset.sym]) continue;
    const result = backtestSwing(asset.sym, allData[asset.sym], SWING_CONFIG, balance);
    if (result && result.totalTrades > 0) {
      totalWins += result.wins;
      totalLosses += result.losses;
      if (result.maxDrawdown > maxDD) maxDD = result.maxDrawdown;
      totalFeesAll += result.totalFees;
      balance = result.finalBalance;
      const emoji = result.pnlPct >= 0 ? "🟢" : "🔴";
      console.log(`  ${emoji} ${asset.name.padEnd(14)} ${balance.toFixed(2)}€  (↑${result.pnlPct >= 0 ? "+" : ""}${result.pnlPct}% | ${result.totalTrades}t | ${result.winRate}% WR | DD:${result.maxDrawdown}% | Fees:${result.totalFees}€)`);
    }
  }
  
  const totalTrades = totalWins + totalLosses;
  const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : 0;
  const pnlPct = ((balance - 250) / 250 * 100).toFixed(1);
  const netProfit = balance - 250 - totalFeesAll;
  
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  RÉSUMÉ FINAL (Swing Trading Pro)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  💰 Départ: 250€ → Final: ${balance.toFixed(2)}€`);
  console.log(`  📈 Profit brut: +${(balance - 250).toFixed(2)}€ (+${pnlPct}%)`);
  console.log(`  💸 Total frais: -${totalFeesAll.toFixed(2)}€`);
  console.log(`  📊 Total Trades: ${totalTrades} (${totalWins}W / ${totalLosses}L)`);
  console.log(`  🎯 Win Rate: ${winRate}%`);
  console.log(`  🔻 Max Drawdown: ${maxDD}%`);
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
