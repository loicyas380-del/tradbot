import "dotenv/config";
import {
  RSI, MACD, BollingerBands, EMA, SMA, ATR, Stochastic,
} from "technicalindicators";

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
  const volumes = rawData.map(d => d.volume);
  return {
    closes, highs, lows, volumes, len: closes.length,
    rsi: RSI.calculate({ values: closes, period: 14 }),
    macd: MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }),
    bb: BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 }),
    ema20: EMA.calculate({ values: closes, period: 20 }),
    ema30: EMA.calculate({ values: closes, period: 30 }),
    atr: ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }),
    stoch: Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 }),
    volSma20: SMA.calculate({ values: volumes, period: 20 }),
  };
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY: TREND + PULLBACK + TRAILING STOP avec COMPOUND
// Proven approach: trade with trend, enter on dips, let winners run
// ═══════════════════════════════════════════════════════════════
function backtestAsset(sym, rawData, config, initialBalance) {
  if (!rawData || rawData.length < 30) return null;
  const ana = computeIndicators(rawData);
  
  const { tpMultiplier, slMultiplier, trailMultiplier, riskPct, maxHoldBars, breakeven, tripleConfirm, volFilter, useStoch } = config;
  
  let balance = initialBalance;
  let peak = initialBalance;
  let position = null;
  const trades = [];
  let maxDrawdown = 0;
  let wins = 0, losses = 0;

  for (let i = 25; i < ana.len; i++) {
    const { closes, rsi, macd, bb, ema20, ema30, atr, stoch, volSma20, volumes } = ana;
    const price = closes[i];
    const rI = i - (ana.len - rsi.length);
    const mI = i - (ana.len - macd.length);
    const bI = i - (ana.len - bb.length);
    const e20I = i - (ana.len - ema20.length);
    const e30I = i - (ana.len - ema30.length);
    const aI = i - (ana.len - atr.length);
    const sI = i - (ana.len - stoch.length);
    const vI = i - (ana.len - volSma20.length);

    const rsiVal = getVal(rsi, rI);
    const macdCurr = getVal(macd, mI);
    const macdPrev = getVal(macd, mI - 1);
    const bbVal = getVal(bb, bI);
    const ema20Val = getVal(ema20, e20I);
    const ema30Val = getVal(ema30, e30I);
    const atrVal = getVal(atr, aI);
    const stochVal = getVal(stoch, sI);
    const stochK = stochVal ? stochVal.k : undefined;
    const volNow = getVal(volumes, i);
    const volAvg = getVal(volSma20, vI);

    if (!rsiVal || !macdCurr || !ema20Val || !ema30Val || !atrVal) continue;
    const volumeOk = volNow && volAvg ? volNow > volAvg * 0.6 : true;
    const volumeSpike = volNow && volAvg ? volNow > volAvg * 1.5 : false;

    // ── CHECK EXIT FIRST ──
    if (position) {
      position.bars++;
      let shouldExit = false;
      let exitPrice = price;
      let exitReason = "";

      if (position.side === "LONG") {
        if (price > position.bestPrice) position.bestPrice = price;
        const trailSl = position.bestPrice - atrVal * trailMultiplier;
        if (trailSl > position.sl) position.sl = trailSl;
        // Breakeven: move SL to entry + small buffer
        if (breakeven && price >= position.entryPrice + atrVal * breakeven && position.sl < position.entryPrice) {
          position.sl = position.entryPrice + atrVal * 0.05;
        }

        if (price <= position.sl) { shouldExit = true; exitPrice = position.sl; exitReason = "SL"; }
        else if (price >= position.tp) { shouldExit = true; exitPrice = position.tp; exitReason = "TP"; }
        else if (position.bars >= maxHoldBars) { shouldExit = true; exitReason = "TIME"; }
        // Trend reversal exit
        else if (ema20Val < ema30Val) { shouldExit = true; exitReason = "TREND"; }
      } else {
        if (price < position.bestPrice) position.bestPrice = price;
        const trailSl = position.bestPrice + atrVal * trailMultiplier;
        if (trailSl < position.sl) position.sl = trailSl;
        // Breakeven: move SL to entry - small buffer
        if (breakeven && price <= position.entryPrice - atrVal * breakeven && position.sl > position.entryPrice) {
          position.sl = position.entryPrice - atrVal * 0.05;
        }

        if (price >= position.sl) { shouldExit = true; exitPrice = position.sl; exitReason = "SL"; }
        else if (price <= position.tp) { shouldExit = true; exitPrice = position.tp; exitReason = "TP"; }
        else if (position.bars >= maxHoldBars) { shouldExit = true; exitReason = "TIME"; }
        else if (ema20Val > ema30Val) { shouldExit = true; exitReason = "TREND"; }
      }

      if (shouldExit) {
        let pnl;
        if (position.side === "LONG") pnl = position.qty * (exitPrice - position.entryPrice);
        else pnl = position.qty * (position.entryPrice - exitPrice);
        balance += position.cost + pnl;
        if (pnl > 0) wins++; else losses++;
        trades.push({ side: position.side, entry: position.entryPrice, exit: exitPrice, pnl, reason: exitReason, bars: position.bars });
        position = null;
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }
    }

    // ── CHECK ENTRY ──
    if (!position && balance > 10) {
      const longTrend = ema20Val > ema30Val;
      const shortTrend = ema20Val < ema30Val;

      // Helper: check if entry conditions are met
      const stochOK_long = useStoch ? (stochK !== undefined && stochK < 30) : true;
      const stochOK_short = useStoch ? (stochK !== undefined && stochK > 70) : true;
      const tripleOK_long = tripleConfirm ? (macdCurr.histogram > macdPrev.histogram && rsiVal < 50 && price > ema20Val) : true;
      const tripleOK_short = tripleConfirm ? (macdCurr.histogram < macdPrev.histogram && rsiVal > 50 && price < ema20Val) : true;

      // LONG: uptrend + RSI pullback + MACD positive + optional filters
      if (longTrend && rsiVal < 60 && rsiVal > 25 && macdCurr.histogram > 0 && volumeOk) {
        if (volFilter && !volumeSpike) continue;
        const riskAmount = balance * riskPct;
        const slDist = atrVal * slMultiplier;
        const qty = +(riskAmount / slDist).toFixed(8);
        const cost = qty * price;
        if (cost < balance * 0.8) {
          position = { side: "LONG", entryPrice: price, qty, cost, tp: price + atrVal * tpMultiplier, sl: price - slDist, bestPrice: price, bars: 0 };
          balance -= cost;
        }
      }
      // SHORT: downtrend + RSI bounce + MACD negative + optional filters
      else if (shortTrend && rsiVal > 40 && rsiVal < 75 && macdCurr.histogram < 0 && volumeOk) {
        if (volFilter && !volumeSpike) continue;
        const riskAmount = balance * riskPct;
        const slDist = atrVal * slMultiplier;
        const qty = +(riskAmount / slDist).toFixed(8);
        const cost = qty * price;
        if (cost < balance * 0.8) {
          position = { side: "SHORT", entryPrice: price, qty, cost, tp: price - atrVal * tpMultiplier, sl: price + slDist, bestPrice: price, bars: 0 };
          balance -= cost;
        }
      }
    }
  }

  // Close remaining
  if (position) {
    const lastPrice = ana.closes[ana.len - 1];
    let pnl = position.side === "LONG" ? position.qty * (lastPrice - position.entryPrice) : position.qty * (position.entryPrice - lastPrice);
    balance += position.cost + pnl;
    if (pnl > 0) wins++; else losses++;
    trades.push({ side: position.side, entry: position.entryPrice, exit: lastPrice, pnl, reason: "END", bars: position.bars });
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
  const pnlPct = ((balance - initialBalance) / initialBalance * 100).toFixed(2);
  const pnlEur = +(balance - initialBalance).toFixed(2);
  const finalBalance = balance;

  return { sym, totalTrades, wins, losses, winRate: +winRate, pnlPct: +pnlPct, pnlEur, finalBalance, maxDrawdown: +(maxDrawdown * 100).toFixed(2) };
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY VARIATIONS TO TEST - ULTRA AGGRESSIF POUR 40€ → 250€
// ═══════════════════════════════════════════════════════════════
const STRATEGIES = [
  // Final: Best proven strategies with compound from 40€
  { name: "Best-Q: TinyTP+Trail", tpMultiplier: 0.5, slMultiplier: 1.0, trailMultiplier: 0.4, riskPct: 0.02, maxHoldBars: 10 },
  { name: "Best-D: TightSL", tpMultiplier: 1.5, slMultiplier: 1.0, trailMultiplier: 0.8, riskPct: 0.02, maxHoldBars: 20 },
  { name: "Best-V: MicroTP0.4", tpMultiplier: 0.4, slMultiplier: 1.0, trailMultiplier: 0.35, riskPct: 0.02, maxHoldBars: 8 },
  { name: "Balanced-Q+BE", tpMultiplier: 0.5, slMultiplier: 1.0, trailMultiplier: 0.4, riskPct: 0.02, maxHoldBars: 10, breakeven: 0.3 },
  { name: "Aggressive: Risk3%", tpMultiplier: 0.5, slMultiplier: 1.0, trailMultiplier: 0.4, riskPct: 0.03, maxHoldBars: 10 },
  { name: "Conservative: Risk1%", tpMultiplier: 0.5, slMultiplier: 1.0, trailMultiplier: 0.4, riskPct: 0.01, maxHoldBars: 10 },
  { name: "QuickWin: TP0.3", tpMultiplier: 0.3, slMultiplier: 1.0, trailMultiplier: 0.25, riskPct: 0.02, maxHoldBars: 6 },
  { name: "WideTrail: Trail0.6", tpMultiplier: 0.5, slMultiplier: 1.0, trailMultiplier: 0.6, riskPct: 0.02, maxHoldBars: 12 },
  { name: "SnapBack: TP0.6", tpMultiplier: 0.6, slMultiplier: 0.8, trailMultiplier: 0.4, riskPct: 0.02, maxHoldBars: 8 },
  { name: "Risk4%: MaxGrowth", tpMultiplier: 0.5, slMultiplier: 1.0, trailMultiplier: 0.4, riskPct: 0.04, maxHoldBars: 10 },
];

const ASSETS_TO_TEST = [
  { sym: "BTC-USD", name: "Bitcoin" },
  { sym: "ETH-USD", name: "Ethereum" },
  { sym: "SOL-USD", name: "Solana" },
  { sym: "DOGE-USD", name: "Dogecoin" },
  { sym: "ADA-USD", name: "Cardano" },
  { sym: "AVAX-USD", name: "Avalanche" },
  { sym: "LINK-USD", name: "Chainlink" },
  { sym: "DOT-USD", name: "Polkadot" },
  { sym: "AAPL", name: "Apple" },
  { sym: "MSFT", name: "Microsoft" },
  { sym: "NVDA", name: "NVIDIA" },
  { sym: "TSLA", name: "Tesla" },
  { sym: "AMD", name: "AMD" },
  { sym: "META", name: "Meta" },
  { sym: "AMZN", name: "Amazon" },
  { sym: "GOOGL", name: "Google" },
  { sym: "EURUSD=X", name: "EUR/USD" },
  { sym: "GBPUSD=X", name: "GBP/USD" },
  { sym: "USDJPY=X", name: "USD/JPY" },
  { sym: "GC=F", name: "Gold" },
];

async function runBacktest() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  BACKTEST ROUTINE: 40€ → 250€ Target (3 Months, Compound)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Fetch all data once
  console.log("Fetching 6 months of data for all assets...\n");
  const allData = {};
  for (const asset of ASSETS_TO_TEST) {
    try {
      allData[asset.sym] = await yfChart(asset.sym, "6mo", "1d");
      process.stdout.write(`  ✓ ${asset.name}\n`);
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      process.stdout.write(`  ✗ ${asset.name}: ${err.message}\n`);
    }
  }

  console.log(`\nData loaded for ${Object.keys(allData).length} assets.\n`);

  // Test each strategy with compound interest
  const results = [];
  for (const strat of STRATEGIES) {
    let balance = 40; // Capital initial
    let totalWins = 0, totalLosses = 0;
    const assetResults = [];
    const compoundHistory = [{ asset: "Start", balance: 40, pnl: 0 }];

    for (const asset of ASSETS_TO_TEST) {
      if (!allData[asset.sym]) continue;
      const result = backtestAsset(asset.sym, allData[asset.sym], strat, balance);
      if (result && result.totalTrades > 0) {
        totalWins += result.wins;
        totalLosses += result.losses;
        assetResults.push(result);
        // Compound: le nouveau balance devient le balance final de cet asset
        balance = result.finalBalance;
        compoundHistory.push({ 
          asset: asset.name, 
          balance: balance, 
          pnl: result.pnlEur,
          trades: result.totalTrades,
          winRate: result.winRate
        });
      }
    }

    const totalTrades = totalWins + totalLosses;
    const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : 0;
    const avgPnl = assetResults.length > 0 ? (assetResults.reduce((a, r) => a + r.pnlPct, 0) / assetResults.length).toFixed(2) : 0;
    const finalPnlEur = balance - 40;
    const finalPnlPct = ((balance - 40) / 40 * 100).toFixed(2);
    const profitableAssets = assetResults.filter(r => r.pnlPct > 0).length;
    const targetReached = balance >= 250;

    results.push({ 
      name: strat.name, 
      winRate: +winRate, 
      totalTrades, 
      totalWins, 
      totalLosses, 
      avgPnl: +avgPnl, 
      finalPnlEur,
      finalPnlPct: +finalPnlPct,
      finalBalance: balance,
      compoundHistory,
      profitableAssets, 
      totalAssets: assetResults.length,
      targetReached
    });
    
    const emoji = targetReached ? "�" : +winRate >= 60 ? "✅" : +winRate >= 50 ? "⚠️" : "❌";
    console.log(`${emoji} ${strat.name}: WR=${winRate}% | ${totalTrades} trades | Final: ${balance.toFixed(2)}€ (${finalPnlPct}%) | Target: ${targetReached ? "✓" : "✗"} | Profitable=${profitableAssets}/${assetResults.length}`);
  }

  // Sort by final balance
  results.sort((a, b) => b.finalBalance - a.finalBalance);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  RANKED RESULTS (COMPOUND INTEREST)");
  console.log("═══════════════════════════════════════════════════════════════");
  results.forEach((r, i) => {
    const marker = r.targetReached ? " 🎯 TARGET REACHED!" : r.finalPnlEur > 0 ? " 💰 PROFIT" : " ❌ LOSS";
    console.log(`  ${i + 1}. ${r.name}: WR=${r.winRate}% | Final=${r.finalBalance.toFixed(2)}€ (${r.finalPnlPct}%) | ${r.totalTrades} trades${marker}`);
  });

  const best = results[0];
  console.log("\n═══════════════════════════════════════════════════════════════");
  if (best.targetReached) {
    console.log(`  � TARGET REACHED! "${best.name}" achieved 250€`);
  } else {
    console.log(`  ⚠️ Target NOT reached. Best: ${best.finalBalance.toFixed(2)}€ (need ${250 - best.finalBalance.toFixed(2)}€ more)`);
  }
  console.log(`  📊 Starting: 40€ → Final: ${best.finalBalance.toFixed(2)}€`);
  console.log(`  💵 Profit: ${best.finalPnlEur.toFixed(2)}€ (${best.finalPnlPct}%)`);
  console.log(`  📈 Win Rate: ${best.winRate}% | Total Trades: ${best.totalTrades}`);
  console.log("\n  Compound History:");
  best.compoundHistory.forEach((h, i) => {
    if (i === 0) {
      console.log(`    ${i}. ${h.asset}: ${h.balance.toFixed(2)}€`);
    } else {
      const arrow = h.pnl >= 0 ? "↑" : "↓";
      console.log(`    ${i}. ${h.asset}: ${h.balance.toFixed(2)}€ (${arrow}${h.pnl.toFixed(2)}€, ${h.trades} trades, ${h.winRate}% WR)`);
    }
  });
  console.log("═══════════════════════════════════════════════════════════════\n");
}

runBacktest().catch(console.error);
