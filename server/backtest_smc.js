import "dotenv/config";
import { RSI, MACD, EMA, SMA, ATR, ADX, Stochastic } from "technicalindicators";

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
    ema9: EMA.calculate({ values: closes, period: 9 }),
    ema21: EMA.calculate({ values: closes, period: 21 }),
    sma50: SMA.calculate({ values: closes, period: 50 }),
    sma200: SMA.calculate({ values: closes, period: 200 }),
    atr: ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }),
    adx: ADX.calculate({ high: highs, low: lows, close: closes, period: 14 }),
    stoch: Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 }),
  };
}

// Find Order Blocks (last opposite candle before strong move)
function findOrderBlocks(rawData, lookback = 20) {
  const obs = [];
  for (let i = lookback; i < rawData.length - 3; i++) {
    const curr = rawData[i];
    const next = rawData[i + 1];
    const next2 = rawData[i + 2];
    
    // Bullish OB: bearish candle followed by strong bullish move
    if (curr.close < curr.open && next.close > next.open && next2.close > next2.open) {
      const moveSize = (next.close - curr.open) / curr.open;
      if (moveSize > 0.02) { // 2%+ move
        obs.push({ type: "BULL_OB", high: curr.high, low: curr.low, idx: i });
      }
    }
    
    // Bearish OB: bullish candle followed by strong bearish move
    if (curr.close > curr.open && next.close < next.open && next2.close < next2.open) {
      const moveSize = (curr.open - next.close) / curr.open;
      if (moveSize > 0.02) {
        obs.push({ type: "BEAR_OB", high: curr.high, low: curr.low, idx: i });
      }
    }
  }
  return obs;
}

// Find Fair Value Gaps
function findFVGs(rawData) {
  const fvgs = [];
  for (let i = 2; i < rawData.length; i++) {
    const c1 = rawData[i - 2];
    const c3 = rawData[i];
    
    // Bullish FVG: gap between c1 high and c3 low
    if (c3.low > c1.high) {
      fvgs.push({ type: "BULL_FVG", high: c3.low, low: c1.high, idx: i });
    }
    
    // Bearish FVG: gap between c1 low and c3 high
    if (c3.high < c1.low) {
      fvgs.push({ type: "BEAR_FVG", high: c1.low, low: c3.high, idx: i });
    }
  }
  return fvgs;
}

// SMC STRATEGY
function analyzeSMC(ana, idx, rawData, orderBlocks, fvgs) {
  const { closes, rsi, macd, ema9, ema21, sma50, sma200, atr, adx, stoch } = ana;
  const price = closes[idx];
  
  const rsiVal = getVal(rsi, idx - (ana.len - rsi.length));
  const macdCurr = getVal(macd, idx - (ana.len - macd.length));
  const ema9Val = getVal(ema9, idx - (ana.len - ema9.length));
  const ema21Val = getVal(ema21, idx - (ana.len - ema21.length));
  const sma50Val = getVal(sma50, idx - (ana.len - sma50.length));
  const sma200Val = getVal(sma200, idx - (ana.len - sma200.length));
  const atrVal = getVal(atr, idx - (ana.len - atr.length));
  const adxVal = getVal(adx, idx - (ana.len - adx.length));
  const stochVal = getVal(stoch, idx - (ana.len - stoch.length));
  
  if (!rsiVal || !macdCurr || !ema9Val || !ema21Val || !sma50Val || !sma200Val || !atrVal || !adxVal || !stochVal) return null;
  
  // HTF Bias
  const bullish = price > sma200Val && ema9Val > ema21Val;
  const bearish = price < sma200Val && ema9Val < ema21Val;
  
  // Check if price is near an Order Block
  let nearBullOB = false, nearBearOB = false;
  for (const ob of orderBlocks) {
    if (ob.idx < idx && price >= ob.low * 0.99 && price <= ob.high * 1.01) {
      if (ob.type === "BULL_OB") nearBullOB = true;
      if (ob.type === "BEAR_OB") nearBearOB = true;
    }
  }
  
  // Check if price is near an FVG
  let nearBullFVG = false, nearBearFVG = false;
  for (const fvg of fvgs) {
    if (fvg.idx < idx && price >= fvg.low * 0.99 && price <= fvg.high * 1.01) {
      if (fvg.type === "BULL_FVG") nearBullFVG = true;
      if (fvg.type === "BEAR_FVG") nearBearFVG = true;
    }
  }
  
  // Liquidity sweep detection (price moved below recent low then reversed)
  const recentLow = Math.min(...rawData.slice(Math.max(0, idx - 10), idx).map(d => d.low));
  const recentHigh = Math.max(...rawData.slice(Math.max(0, idx - 10), idx).map(d => d.high));
  const sweptLow = price < recentLow && closes[idx - 1] > recentLow;
  const sweptHigh = price > recentHigh && closes[idx - 1] < recentHigh;
  
  // === LONG CONDITIONS (SMC) ===
  // 1. Bullish HTF bias
  // 2. Price near Bullish OB or FVG
  // 3. RSI oversold or Stoch oversold
  // 4. MACD turning up
  if (bullish && (nearBullOB || nearBullFVG) && (rsiVal < 40 || stochVal.k < 20)) {
    const sl = price - atrVal * 1.5;
    const tp = price + atrVal * 4.5; // 3:1 RR
    return { side: "LONG", entry: price, sl, tp, rr: 3.0, reasons: ["Bullish bias", nearBullOB ? "Near OB" : "Near FVG", "Oversold"] };
  }
  
  // === SHORT CONDITIONS (SMC) ===
  if (bearish && (nearBearOB || nearBearFVG) && (rsiVal > 60 || stochVal.k > 80)) {
    const sl = price + atrVal * 1.5;
    const tp = price - atrVal * 4.5; // 3:1 RR
    return { side: "SHORT", entry: price, sl, tp, rr: 3.0, reasons: ["Bearish bias", nearBearOB ? "Near OB" : "Near FVG", "Overbought"] };
  }
  
  // === LIQUIDITY SWAP ENTRIES ===
  if (bullish && sweptLow && rsiVal < 45) {
    const sl = price - atrVal * 1.5;
    const tp = price + atrVal * 4.5;
    return { side: "LONG", entry: price, sl, tp, rr: 3.0, reasons: ["Bullish bias", "Liquidity sweep", "Oversold"] };
  }
  
  if (bearish && sweptHigh && rsiVal > 55) {
    const sl = price + atrVal * 1.5;
    const tp = price - atrVal * 4.5;
    return { side: "SHORT", entry: price, sl, tp, rr: 3.0, reasons: ["Bearish bias", "Liquidity sweep", "Overbought"] };
  }
  
  return null;
}

// BACKTEST
function backtestSMC(sym, rawData, config, initialBalance) {
  if (!rawData || rawData.length < 50) return null;
  
  const ana = computeIndicators(rawData);
  const orderBlocks = findOrderBlocks(rawData);
  const fvgs = findFVGs(rawData);
  const { riskPct, maxPositions, maxDrawdownPct } = config;
  
  let balance = initialBalance;
  let peak = initialBalance;
  let positions = [];
  let maxDrawdown = 0, wins = 0, losses = 0;
  let totalFees = 0;
  let totalTrades = 0;
  let cooldown = 0;
  
  for (let i = 50; i < ana.len; i++) {
    const price = ana.closes[i];
    
    // Stop if drawdown too high
    if ((peak - balance) / peak > maxDrawdownPct) continue;
    
    // Cooldown after loss
    if (cooldown > 0) { cooldown--; continue; }
    
    // Exit positions
    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      pos.bars++;
      
      // Trailing stop: move to breakeven after 5 days
      if (pos.bars >= 5) {
        if (pos.side === "LONG" && pos.sl < pos.entry * 1.005) {
          pos.sl = pos.entry * 1.005;
        }
        if (pos.side === "SHORT" && pos.sl > pos.entry * 0.995) {
          pos.sl = pos.entry * 0.995;
        }
      }
      
      let shouldExit = false, exitPrice = price;
      
      if (pos.side === "LONG") {
        if (price <= pos.sl) { shouldExit = true; exitPrice = pos.sl; }
        else if (price >= pos.tp) { shouldExit = true; exitPrice = pos.tp; }
        else if (pos.bars >= 21) { shouldExit = true; } // Max 3 weeks
      } else {
        if (price >= pos.sl) { shouldExit = true; exitPrice = pos.sl; }
        else if (price <= pos.tp) { shouldExit = true; exitPrice = pos.tp; }
        else if (pos.bars >= 21) { shouldExit = true; }
      }
      
      if (shouldExit) {
        const fees = pos.cost * 0.001;
        const pnl = pos.side === "LONG" 
          ? pos.qty * (exitPrice - pos.entry) 
          : pos.qty * (pos.entry - exitPrice);
        balance += pos.cost + pnl - fees;
        totalFees += fees;
        totalTrades++;
        if (pnl > 0) { wins++; } else { losses++; cooldown = 5; }
        positions.splice(p, 1);
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }
    }
    
    // Entry
    if (positions.length < maxPositions) {
      const signal = analyzeSMC(ana, i, rawData.slice(0, i + 1), orderBlocks, fvgs);
      if (signal) {
        const maxCost = balance * 0.35;
        const qty = maxCost / signal.entry;
        const cost = qty * signal.entry;
        
        if (cost <= balance * 0.90) {
          positions.push({
            side: signal.side,
            entry: signal.entry,
            sl: signal.sl,
            tp: signal.tp,
            qty, cost, bars: 0,
          });
          balance -= cost;
        }
      }
    }
  }
  
  // Close remaining
  for (const pos of positions) {
    const lastPrice = ana.closes[ana.len - 1];
    const fees = pos.cost * 0.001;
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

// CONFIG - SMC PRO
const CONFIG = {
  riskPct: 0.02,
  maxPositions: 2,
  maxDrawdownPct: 0.15,
};

// ASSETS
const ASSETS = [
  { sym: "BTC-USD", name: "Bitcoin" },
  { sym: "ETH-USD", name: "Ethereum" },
  { sym: "SOL-USD", name: "Solana" },
  { sym: "NVDA", name: "NVIDIA" },
  { sym: "AMD", name: "AMD" },
  { sym: "TSLA", name: "Tesla" },
  { sym: "META", name: "Meta" },
  { sym: "AMZN", name: "Amazon" },
  { sym: "GC=F", name: "Gold" },
];

// MAIN
async function main() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  BOT SMC — 3 MOIS | 250€ | Smart Money Concepts");
  console.log("═══════════════════════════════════════════════════════════════\n");
  
  console.log("Fetching données daily...\n");
  const allData = {};
  for (const asset of ASSETS) {
    try {
      allData[asset.sym] = await yfChart(asset.sym, "3mo", "1d");
      console.log(`  ✓ ${asset.name} (${allData[asset.sym].length} candles)`);
      await new Promise(r => setTimeout(r, 250));
    } catch (err) {
      console.log(`  ✗ ${asset.name}: ${err.message}`);
    }
  }
  
  console.log(`\nData: ${Object.keys(allData).length} assets.\n`);
  
  let balance = 250;
  let totalWins = 0, totalLosses = 0;
  let maxDD = 0;
  let totalFeesAll = 0;
  
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ÉVOLUTION DU SOLDE");
  console.log("═══════════════════════════════════════════════════════════════\n");
  
  for (const asset of ASSETS) {
    if (!allData[asset.sym]) continue;
    const result = backtestSMC(asset.sym, allData[asset.sym], CONFIG, balance);
    if (result && result.totalTrades > 0) {
      totalWins += result.wins;
      totalLosses += result.losses;
      if (result.maxDrawdown > maxDD) maxDD = result.maxDrawdown;
      totalFeesAll += result.totalFees;
      balance = result.finalBalance;
      const emoji = result.pnlPct >= 0 ? "🟢" : "🔴";
      console.log(`  ${emoji} ${asset.name.padEnd(14)} ${balance.toFixed(2)}€  (↑${result.pnlPct >= 0 ? "+" : ""}${result.pnlPct}% | ${result.totalTrades}t | ${result.winRate}% WR | DD:${result.maxDrawdown}%)`);
    }
  }
  
  const totalTrades = totalWins + totalLosses;
  const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : 0;
  const pnlPct = ((balance - 250) / 250 * 100).toFixed(1);
  
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  RÉSUMÉ FINAL (SMC Strategy)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  💰 Départ: 250€ → Final: ${balance.toFixed(2)}€`);
  console.log(`  📈 Profit: +${(balance - 250).toFixed(2)}€ (+${pnlPct}%)`);
  console.log(`  💸 Frais: -${totalFeesAll.toFixed(2)}€`);
  console.log(`  📊 Trades: ${totalTrades} (${totalWins}W / ${totalLosses}L)`);
  console.log(`  🎯 Win Rate: ${winRate}%`);
  console.log(`  🔻 Max DD: ${maxDD}%`);
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
