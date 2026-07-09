import "dotenv/config";
import {
  RSI, MACD, BollingerBands, EMA, SMA, ATR, Stochastic,
} from "technicalindicators";

const YF_H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0" };

async function yfChart(symbol, range = "3mo", interval = "1h") {
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
    volSma20: SMA.calculate({ values: volumes, period: 20 }),
  };
}

// Max positions open simultaneously
function backtestAsset(sym, rawData, config, initialBalance) {
  if (!rawData || rawData.length < 40) return null;
  const ana = computeIndicators(rawData);
  const { tpMultiplier, slMultiplier, trailMultiplier, riskPct, maxHoldBars, maxPositions } = config;
  let balance = initialBalance;
  let peak = initialBalance;
  let positions = [];
  let maxDrawdown = 0, wins = 0, losses = 0;
  const maxPos = maxPositions || 1;

  for (let i = 35; i < ana.len; i++) {
    const { closes, rsi, macd, ema20, ema50, atr, stoch, volSma20, volumes } = ana;
    const price = closes[i];
    const rI = i - (ana.len - rsi.length);
    const mI = i - (ana.len - macd.length);
    const e20I = i - (ana.len - ema20.length);
    const e50I = i - (ana.len - ema50.length);
    const aI = i - (ana.len - atr.length);
    const sI = i - (ana.len - stoch.length);
    const vI = i - (ana.len - volSma20.length);

    const rsiVal = getVal(rsi, rI);
    const macdCurr = getVal(macd, mI);
    const macdPrev = getVal(macd, mI - 1);
    const ema20Val = getVal(ema20, e20I);
    const ema50Val = getVal(ema50, e50I);
    const atrVal = getVal(atr, aI);
    const stochVal = getVal(stoch, sI);
    const volNow = getVal(volumes, i);
    const volAvg = getVal(volSma20, vI);

    if (!rsiVal || !macdCurr || !ema20Val || !ema50Val || !atrVal) continue;

    // EXIT existing positions
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
        const pnl = pos.side === "LONG" ? pos.qty * (exitPrice - pos.entryPrice) : pos.qty * (pos.entryPrice - exitPrice);
        balance += pos.cost + pnl;
        if (pnl > 0) wins++; else losses++;
        positions.splice(p, 1);
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }
    }

    // ENTRY — open new positions if room
    if (positions.length < maxPos && balance > 3) {
      const longTrend = ema20Val > ema50Val;
      const shortTrend = ema20Val < ema50Val;
      const rsiRising = rsiVal > (getVal(rsi, rI - 1) || rsiVal);
      const rsiFalling = rsiVal < (getVal(rsi, rI - 1) || rsiVal);
      const macdRising = macdCurr.histogram > (macdPrev?.histogram || 0);
      const macdFalling = macdCurr.histogram < (macdPrev?.histogram || 0);

      // LONG
      if (longTrend && rsiVal < 65 && rsiVal > 25 && macdCurr.histogram > 0 && (rsiRising || macdRising)) {
        const riskAmount = balance * riskPct;
        const slDist = atrVal * slMultiplier;
        let qty = +(riskAmount / slDist).toFixed(8);
        let cost = qty * price;
        // Cap to available balance
        if (cost > balance * 0.9) {
          qty = +((balance * 0.9) / price).toFixed(8);
          cost = qty * price;
        }
        if (cost > 0 && cost <= balance) {
          positions.push({ side: "LONG", entryPrice: price, qty, cost, tp: price + atrVal * tpMultiplier, sl: price - slDist, bestPrice: price, bars: 0 });
          balance -= cost;
        }
      }
      // SHORT
      else if (shortTrend && rsiVal > 35 && rsiVal < 75 && macdCurr.histogram < 0 && (rsiFalling || macdFalling)) {
        const riskAmount = balance * riskPct;
        const slDist = atrVal * slMultiplier;
        let qty = +(riskAmount / slDist).toFixed(8);
        let cost = qty * price;
        // Cap to available balance
        if (cost > balance * 0.9) {
          qty = +((balance * 0.9) / price).toFixed(8);
          cost = qty * price;
        }
        if (cost > 0 && cost <= balance) {
          positions.push({ side: "SHORT", entryPrice: price, qty, cost, tp: price - atrVal * tpMultiplier, sl: price + slDist, bestPrice: price, bars: 0 });
          balance -= cost;
        }
      }
    }
  }

  // Close remaining
  for (const pos of positions) {
    const lastPrice = ana.closes[ana.len - 1];
    const pnl = pos.side === "LONG" ? pos.qty * (lastPrice - pos.entryPrice) : pos.qty * (pos.entryPrice - lastPrice);
    balance += pos.cost + pnl;
    if (pnl > 0) wins++; else losses++;
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
  const pnlEur = +(balance - initialBalance).toFixed(2);
  const pnlPct = ((balance - initialBalance) / initialBalance * 100).toFixed(2);

  return { sym, totalTrades, wins, losses, winRate: +winRate, pnlPct: +pnlPct, pnlEur, finalBalance: balance, maxDrawdown: +(maxDrawdown * 100).toFixed(2) };
}

// ══════════════════════════════════════════════════════════════
// STRATEGIES AGRESSIVES — 40€ → 250€ (525% en 3 mois)
// ══════════════════════════════════════════════════════════════
const STRATEGIES = [
  // Final: focus on volatile assets only, aggressive sizing
  { name: "FOCUS-1: Top5_Risk15%", riskPct: 0.15, tpMultiplier: 0.6, slMultiplier: 1.2, trailMultiplier: 0.35, maxHoldBars: 8, maxPositions: 3, topOnly: true },
  { name: "FOCUS-2: Top5_Risk20%", riskPct: 0.20, tpMultiplier: 0.6, slMultiplier: 1.2, trailMultiplier: 0.35, maxHoldBars: 8, maxPositions: 3, topOnly: true },
  { name: "FOCUS-3: Top5_Risk25%", riskPct: 0.25, tpMultiplier: 0.5, slMultiplier: 1.0, trailMultiplier: 0.3, maxHoldBars: 6, maxPositions: 4, topOnly: true },
  { name: "FOCUS-4: All_Risk15%_TP0.6", riskPct: 0.15, tpMultiplier: 0.6, slMultiplier: 1.2, trailMultiplier: 0.35, maxHoldBars: 8, maxPositions: 3 },
  { name: "FOCUS-5: All_Risk20%_TP0.5", riskPct: 0.20, tpMultiplier: 0.5, slMultiplier: 1.0, trailMultiplier: 0.3, maxHoldBars: 6, maxPositions: 4 },
  { name: "FOCUS-6: All_Risk25%_TP0.4", riskPct: 0.25, tpMultiplier: 0.4, slMultiplier: 0.8, trailMultiplier: 0.25, maxHoldBars: 5, maxPositions: 5 },
  { name: "FOCUS-7: Risk30%_TP0.5_5pos", riskPct: 0.30, tpMultiplier: 0.5, slMultiplier: 1.0, trailMultiplier: 0.3, maxHoldBars: 6, maxPositions: 5 },
  { name: "FOCUS-8: Risk35%_TP0.4_5pos", riskPct: 0.35, tpMultiplier: 0.4, slMultiplier: 0.8, trailMultiplier: 0.25, maxHoldBars: 5, maxPositions: 5 },
  { name: "FOCUS-9: Risk40%_TP0.5_3pos", riskPct: 0.40, tpMultiplier: 0.5, slMultiplier: 1.0, trailMultiplier: 0.3, maxHoldBars: 6, maxPositions: 3 },
  { name: "FOCUS-10: Risk50%_TP0.3_3pos", riskPct: 0.50, tpMultiplier: 0.3, slMultiplier: 0.7, trailMultiplier: 0.2, maxHoldBars: 4, maxPositions: 3 },
];

const ASSETS_TO_TEST = [
  { sym: "BTC-USD", name: "Bitcoin", volatile: false },
  { sym: "ETH-USD", name: "Ethereum", volatile: false },
  { sym: "SOL-USD", name: "Solana", volatile: true },
  { sym: "DOGE-USD", name: "Dogecoin", volatile: true },
  { sym: "ADA-USD", name: "Cardano", volatile: true },
  { sym: "AVAX-USD", name: "Avalanche", volatile: true },
  { sym: "LINK-USD", name: "Chainlink", volatile: true },
  { sym: "DOT-USD", name: "Polkadot", volatile: true },
  { sym: "AAPL", name: "Apple", volatile: false },
  { sym: "MSFT", name: "Microsoft", volatile: false },
  { sym: "NVDA", name: "NVIDIA", volatile: true },
  { sym: "TSLA", name: "Tesla", volatile: true },
  { sym: "AMD", name: "AMD", volatile: true },
  { sym: "META", name: "Meta", volatile: false },
  { sym: "AMZN", name: "Amazon", volatile: false },
  { sym: "GOOGL", name: "Google", volatile: false },
  { sym: "EURUSD=X", name: "EUR/USD", volatile: false },
  { sym: "GBPUSD=X", name: "GBP/USD", volatile: false },
  { sym: "USDJPY=X", name: "USD/JPY", volatile: false },
  { sym: "GC=F", name: "Gold", volatile: false },
];

async function runBacktest() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  BACKTEST AGRESSIF: 40€ → 250€ en 3 Mois (525%)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  console.log("Fetching 3 months of 1h data...\n");
  const allData = {};
  for (const asset of ASSETS_TO_TEST) {
    try {
      allData[asset.sym] = await yfChart(asset.sym, "3mo", "1h");
      process.stdout.write(`  ✓ ${asset.name} (${allData[asset.sym].length} candles)\n`);
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      process.stdout.write(`  ✗ ${asset.name}: ${err.message}\n`);
    }
  }

  console.log(`\nData loaded for ${Object.keys(allData).length} assets.\n`);

  const results = [];
  for (const strat of STRATEGIES) {
    let balance = 40;
    let totalWins = 0, totalLosses = 0;
    const compoundHistory = [{ asset: "Start", balance: 40 }];

    const assetsToTrade = strat.topOnly ? ASSETS_TO_TEST.filter(a => a.volatile) : ASSETS_TO_TEST;
    for (const asset of assetsToTrade) {
      if (!allData[asset.sym]) continue;
      const result = backtestAsset(asset.sym, allData[asset.sym], strat, balance);
      if (result && result.totalTrades > 0) {
        totalWins += result.wins;
        totalLosses += result.losses;
        balance = result.finalBalance;
        compoundHistory.push({ asset: asset.name, balance, pnl: result.pnlEur, trades: result.totalTrades, wr: result.winRate });
      }
    }

    const totalTrades = totalWins + totalLosses;
    const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : 0;
    const finalPnlPct = ((balance - 40) / 40 * 100).toFixed(1);
    const target = balance >= 250;

    results.push({ name: strat.name, winRate: +winRate, totalTrades, finalBalance: balance, finalPnlPct: +finalPnlPct, compoundHistory, target });

    const emoji = target ? "🏆" : +finalPnlPct > 100 ? "🔥" : +finalPnlPct > 0 ? "✅" : "❌";
    console.log(`${emoji} ${strat.name}: WR=${winRate}% | ${totalTrades} trades | ${balance.toFixed(2)}€ (${finalPnlPct}%)${target ? " 🎯" : ""}`);
  }

  results.sort((a, b) => b.finalBalance - a.finalBalance);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  CLASSEMENT FINAL");
  console.log("═══════════════════════════════════════════════════════════════");
  results.forEach((r, i) => {
    const marker = r.target ? " 🎯 TARGET!" : r.finalBalance > 40 ? " 💰" : " ❌";
    console.log(`  ${i + 1}. ${r.name}: ${r.finalBalance.toFixed(2)}€ (${r.finalPnlPct}%) | WR=${r.winRate}% | ${r.totalTrades} trades${marker}`);
  });

  const best = results[0];
  console.log("\n═══════════════════════════════════════════════════════════════");
  if (best.target) {
    console.log(`  🏆 TARGET ATTEINT! "${best.name}" → ${best.finalBalance.toFixed(2)}€`);
  } else {
    console.log(`  ⚠️ Meilleur: "${best.name}" → ${best.finalBalance.toFixed(2)}€ (${best.finalPnlPct}%)`);
    console.log(`  Il manque ${(250 - best.finalBalance).toFixed(2)}€ pour atteindre 250€`);
  }
  console.log(`  📊 40€ → ${best.finalBalance.toFixed(2)}€ | WR: ${best.winRate}% | ${best.totalTrades} trades`);
  console.log("\n  Historique:");
  best.compoundHistory.forEach((h, i) => {
    if (i === 0) console.log(`    ${i}. ${h.asset}: ${h.balance.toFixed(2)}€`);
    else {
      const arrow = h.pnl >= 0 ? "↑" : "↓";
      console.log(`    ${i}. ${h.asset}: ${h.balance.toFixed(2)}€ (${arrow}${h.pnl.toFixed(2)}€, ${h.trades}t, ${h.wr}% WR)`);
    }
  });
  console.log("═══════════════════════════════════════════════════════════════\n");
}

runBacktest().catch(console.error);
