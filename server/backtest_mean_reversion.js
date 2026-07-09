import "dotenv/config";
import { RSI, EMA, SMA, ATR } from "technicalindicators";

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
  return {
    closes, highs, lows, len: closes.length,
    rsi: RSI.calculate({ values: closes, period: 14 }),
    ema5: EMA.calculate({ values: closes, period: 5 }),
    ema10: EMA.calculate({ values: closes, period: 10 }),
    ema20: EMA.calculate({ values: closes, period: 20 }),
    sma50: SMA.calculate({ values: closes, period: 50 }),
    atr: ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }),
  };
}

// STRATÉGIE MEAN REVERSION: Acheter les soldes
function analyzeMeanReversion(ana, idx) {
  const { closes, rsi, ema5, ema10, ema20, sma50, atr } = ana;
  const price = closes[idx];
  
  const rsiVal = getVal(rsi, idx - (ana.len - rsi.length));
  const ema5Val = getVal(ema5, idx - (ana.len - ema5.length));
  const ema10Val = getVal(ema10, idx - (ana.len - ema10.length));
  const ema20Val = getVal(ema20, idx - (ana.len - ema20.length));
  const sma50Val = getVal(sma50, idx - (ana.len - sma50.length));
  const atrVal = getVal(atr, idx - (ana.len - atr.length));
  
  if (!rsiVal || !ema5Val || !ema10Val || !ema20Val || !sma50Val || !atrVal) return null;
  
  // === LONG: RSI oversold + price bouncing ===
  // Buy when RSI < 30 and price starts to recover
  if (rsiVal < 35 && price > ema5Val && closes[idx] > closes[idx - 1]) {
    const sl = price * 0.95; // 5% SL (wider for mean reversion)
    const tp = price * 1.10; // 10% TP (2:1 RR)
    return { side: "LONG", entry: price, sl, tp, rr: 2.0, reasons: ["RSI oversold", "Bouncing"] };
  }
  
  // === SHORT: RSI overbought + price falling ===
  // Sell when RSI > 70 and price starts to drop
  if (rsiVal > 65 && price < ema5Val && closes[idx] < closes[idx - 1]) {
    const sl = price * 1.05;
    const tp = price * 0.90; // 10% TP
    return { side: "SHORT", entry: price, sl, tp, rr: 2.0, reasons: ["RSI overbought", "Falling"] };
  }
  
  return null;
}

// BACKTEST
function backtestMeanReversion(sym, rawData, initialBalance) {
  if (!rawData || rawData.length < 30) return null;
  
  const ana = computeIndicators(rawData);
  let balance = initialBalance;
  let peak = initialBalance;
  let positions = [];
  let maxDrawdown = 0, wins = 0, losses = 0;
  let totalFees = 0;
  let totalTrades = 0;
  let cooldown = 0;
  
  for (let i = 20; i < ana.len; i++) {
    const price = ana.closes[i];
    
    // Stop if drawdown > 15%
    if ((peak - balance) / peak > 0.15) continue;
    
    // Cooldown
    if (cooldown > 0) { cooldown--; continue; }
    
    // Exit positions
    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      pos.bars++;
      
      let shouldExit = false, exitPrice = price;
      
      if (pos.side === "LONG") {
        if (price <= pos.sl) { shouldExit = true; exitPrice = pos.sl; }
        else if (price >= pos.tp) { shouldExit = true; exitPrice = pos.tp; }
        else if (pos.bars >= 7) { shouldExit = true; } // Max 1 week
      } else {
        if (price >= pos.sl) { shouldExit = true; exitPrice = pos.sl; }
        else if (price <= pos.tp) { shouldExit = true; exitPrice = pos.tp; }
        else if (pos.bars >= 7) { shouldExit = true; }
      }
      
      if (shouldExit) {
        const fees = pos.cost * 0.001;
        const pnl = pos.side === "LONG" 
          ? pos.qty * (exitPrice - pos.entry) 
          : pos.qty * (pos.entry - exitPrice);
        balance += pos.cost + pnl - fees;
        totalFees += fees;
        totalTrades++;
        if (pnl > 0) { wins++; } else { losses++; cooldown = 2; }
        positions.splice(p, 1);
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }
    }
    
    // Entry - max 1 position
    if (positions.length === 0) {
      const signal = analyzeMeanReversion(ana, i);
      if (signal) {
        const maxCost = balance * 0.90;
        const qty = maxCost / signal.entry;
        const cost = qty * signal.entry;
        
        if (cost <= balance * 0.95) {
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
  console.log("  BOT MEAN REVERSION — 3 MOIS | 250€ | Contre le Marché");
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
    const result = backtestMeanReversion(asset.sym, allData[asset.sym], balance);
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
  console.log("  RÉSUMÉ FINAL (Mean Reversion)");
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
