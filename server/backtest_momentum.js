import "dotenv/config";
import { RSI, EMA, SMA, ATR } from "technicalindicators";

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
    ema20: EMA.calculate({ values: closes, period: 20 }),
    sma50: SMA.calculate({ values: closes, period: 50 }),
    sma200: SMA.calculate({ values: closes, period: 200 }),
    atr: ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }),
  };
}

// STRATÉGIE SIMPLE: Momentum + Dip Buy
function analyzeSimple(ana, idx) {
  const { closes, rsi, ema20, sma50, sma200, atr } = ana;
  const price = closes[idx];
  
  const rsiVal = getVal(rsi, idx - (ana.len - rsi.length));
  const ema20Val = getVal(ema20, idx - (ana.len - ema20.length));
  const sma50Val = getVal(sma50, idx - (ana.len - sma50.length));
  const sma200Val = getVal(sma200, idx - (ana.len - sma200.length));
  const atrVal = getVal(atr, idx - (ana.len - atr.length));
  
  if (!rsiVal || !ema20Val || !sma50Val || !sma200Val || !atrVal) return null;
  
  // Trend filter - use SMA50 instead of SMA200 (not enough data)
  const inUptrend = price > sma50Val;
  const inDowntrend = price < sma50Val;
  
  // === LONG: Uptrend + RSI oversold (dip buy) ===
  if (inUptrend && rsiVal < 45) {
    const sl = price * 0.97; // 3% SL
    const tp = price * 1.15; // 15% TP (5:1 RR)
    return { side: "LONG", entry: price, sl, tp, rr: 5.0, reasons: ["Uptrend", "RSI oversold (dip)"] };
  }
  
  // === LONG: Strong uptrend + price above EMA20 ===
  if (inUptrend && price > ema20Val && rsiVal > 45 && rsiVal < 70) {
    const sl = price * 0.97;
    const tp = price * 1.12; // 12% TP (4:1 RR)
    return { side: "LONG", entry: price, sl, tp, rr: 4.0, reasons: ["Uptrend", "Above EMA20", "Momentum"] };
  }
  
  // === SHORT: Downtrend + RSI overbought (bounce sell) ===
  if (inDowntrend && rsiVal > 55) {
    const sl = price * 1.03;
    const tp = price * 0.88; // 12% TP
    return { side: "SHORT", entry: price, sl, tp, rr: 4.0, reasons: ["Downtrend", "RSI overbought"] };
  }
  
  return null;
}

// BACKTEST
function backtestSimple(sym, rawData, initialBalance) {
  if (!rawData || rawData.length < 50) return null;
  
  const ana = computeIndicators(rawData);
  let balance = initialBalance;
  let peak = initialBalance;
  let positions = [];
  let maxDrawdown = 0, wins = 0, losses = 0;
  let totalFees = 0;
  let totalTrades = 0;
  let cooldown = 0;
  
  for (let i = 50; i < ana.len; i++) {
    const price = ana.closes[i];
    
    // Debug: print indicators for first asset
    if (i < 60) {
      const rsiVal = getVal(ana.rsi, i - (ana.len - ana.rsi.length));
      const sma50V = getVal(ana.sma50, i - (ana.len - ana.sma50.length));
      const inUptrend = price > sma50V;
      console.log(`  [${i}] Price: ${price.toFixed(2)} | SMA50: ${sma50V?.toFixed(2) || 'N/A'} | Uptrend: ${inUptrend} | RSI: ${rsiVal?.toFixed(1) || 'N/A'}`);
    }
    
    // Stop if drawdown > 15%
    if ((peak - balance) / peak > 0.15) continue;
    
    // Cooldown
    if (cooldown > 0) { cooldown--; continue; }
    
    // Exit positions
    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      pos.bars++;
      
      // Trailing stop: lock profit after 5%
      if (pos.side === "LONG") {
        const profit = (price - pos.entry) / pos.entry;
        if (profit > 0.05 && pos.sl < pos.entry * 1.02) {
          pos.sl = pos.entry * 1.02; // Lock 2% profit
        }
      } else {
        const profit = (pos.entry - price) / pos.entry;
        if (profit > 0.05 && pos.sl > pos.entry * 0.98) {
          pos.sl = pos.entry * 0.98;
        }
      }
      
      let shouldExit = false, exitPrice = price;
      
      if (pos.side === "LONG") {
        if (price <= pos.sl) { shouldExit = true; exitPrice = pos.sl; }
        else if (price >= pos.tp) { shouldExit = true; exitPrice = pos.tp; }
        else if (pos.bars >= 21) { shouldExit = true; }
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
        if (pnl > 0) { wins++; } else { losses++; cooldown = 3; }
        positions.splice(p, 1);
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }
    }
    
    // Entry - max 1 position at a time
    if (positions.length === 0) {
      const signal = analyzeSimple(ana, i);
      if (signal) {
        const maxCost = balance * 0.90; // Use 90% of balance
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

// ASSETS - Top only
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
  console.log("  BOT MOMENTUM — 3 MOIS | 250€ | Simple Strategy");
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
    const result = backtestSimple(asset.sym, allData[asset.sym], balance);
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
  console.log("  RÉSUMÉ FINAL (Momentum Strategy)");
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
