import "dotenv/config";
import { RSI, EMA, SMA, ATR } from "technicalindicators";

const YF_H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0" };

async function yfChart(symbol, period1, period2, interval = "1h") {
  const p1 = Math.floor(new Date(period1).getTime() / 1000);
  const p2 = Math.floor(new Date(period2).getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${p1}&period2=${p2}&interval=${interval}`;
  const res = await fetch(url, { headers: YF_H, signal: AbortSignal.timeout(15000) });
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
    ema5: EMA.calculate({ values: closes, period: 5 }),
    ema12: EMA.calculate({ values: closes, period: 12 }),
    ema26: EMA.calculate({ values: closes, period: 26 }),
    atr: ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }),
    sma20: SMA.calculate({ values: closes, period: 20 }),
    volumeSma: SMA.calculate({ values: volumes, period: 20 }),
  };
}

function analyze(ana, idx) {
  const { closes, rsi, ema5, ema12, ema26, atr, sma20, volumeSma, volumes } = ana;
  if (idx < 30) return null;
  const price = closes[idx];
  const prevPrice = closes[idx - 1];
  const prevPrevPrice = closes[idx - 2];
  const rsiVal = getVal(rsi, idx - (ana.len - rsi.length));
  const ema5Val = getVal(ema5, idx - (ana.len - ema5.length));
  const ema12Val = getVal(ema12, idx - (ana.len - ema12.length));
  const ema26Val = getVal(ema26, idx - (ana.len - ema26.length));
  const atrVal = getVal(atr, idx - (ana.len - atr.length));
  const sma20Val = getVal(sma20, idx - (ana.len - sma20.length));
  const volSmaVal = getVal(volumeSma, idx - (ana.len - volumeSma.length));
  const volVal = getVal(volumes, idx);
  if (!rsiVal || !ema5Val || !ema12Val || !ema26Val || !atrVal || !sma20Val || !volSmaVal || !volVal) return null;

  const isBouncing = price > prevPrice && prevPrice > prevPrevPrice;
  const isFalling = price < prevPrice && prevPrice < prevPrevPrice;
  const volumeOK = volVal > volSmaVal * 0.7;
  const trendUp = ema12Val > ema26Val;
  const trendDown = ema12Val < ema26Val;
  const slDistance = atrVal * 1.2;
  const tpDistance = atrVal * 2.5;

  if (rsiVal < 40 && isBouncing && price > ema5Val && volumeOK && trendUp) {
    return { side: "LONG", entry: price, sl: price - slDistance, tp: price + tpDistance, rr: (tpDistance / slDistance).toFixed(2), rsi: rsiVal, confidence: 70 };
  }
  if (rsiVal > 60 && isFalling && price < ema5Val && volumeOK && trendDown) {
    return { side: "SHORT", entry: price, sl: price + slDistance, tp: price - tpDistance, rr: (tpDistance / slDistance).toFixed(2), rsi: rsiVal, confidence: 70 };
  }
  if (rsiVal < 30 && isBouncing && price > sma20Val && volumeOK) {
    return { side: "LONG", entry: price, sl: price - slDistance * 1.5, tp: price + tpDistance * 1.5, rr: ((tpDistance * 1.5) / (slDistance * 1.5)).toFixed(2), rsi: rsiVal, confidence: 80 };
  }
  if (rsiVal > 70 && isFalling && price < sma20Val && volumeOK) {
    return { side: "SHORT", entry: price, sl: price + slDistance * 1.5, tp: price - tpDistance * 1.5, rr: ((tpDistance * 1.5) / (slDistance * 1.5)).toFixed(2), rsi: rsiVal, confidence: 80 };
  }
  return null;
}

function backtest(sym, rawData, capital) {
  if (!rawData || rawData.length < 30) return null;
  const ana = computeIndicators(rawData);
  let cash = capital, peak = capital, maxDrawdown = 0;
  let wins = 0, losses = 0, totalFees = 0, totalTrades = 0;
  let cooldown = 0, positions = [];

  for (let i = 30; i < ana.len; i++) {
    const price = ana.closes[i];
    let equity = cash;
    for (const pos of positions) {
      equity += pos.side === "LONG" ? pos.qty * price : pos.qty * (2 * pos.entry - price);
    }
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (dd > 0.15) continue;
    if (cooldown > 0) { cooldown--; continue; }

    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      pos.bars++;
      const pnlPct = pos.side === "LONG" ? (price - pos.entry) / pos.entry : (pos.entry - price) / pos.entry;
      if (pnlPct > 0.015) {
        if (pos.side === "LONG" && pos.sl < pos.entry * 1.003) pos.sl = pos.entry * 1.003;
        if (pos.side === "SHORT" && pos.sl > pos.entry * 0.997) pos.sl = pos.entry * 0.997;
      }
      let shouldExit = false, exitPrice = price;
      if (pos.side === "LONG") {
        if (price <= pos.sl) { shouldExit = true; exitPrice = pos.sl; }
        else if (price >= pos.tp) { shouldExit = true; exitPrice = pos.tp; }
        else if (pos.bars >= 12) { shouldExit = true; }
      } else {
        if (price >= pos.sl) { shouldExit = true; exitPrice = pos.sl; }
        else if (price <= pos.tp) { shouldExit = true; exitPrice = pos.tp; }
        else if (pos.bars >= 12) { shouldExit = true; }
      }
      if (shouldExit) {
        const fees = pos.cost * 0.001;
        const pnl = pos.side === "LONG" ? pos.qty * (exitPrice - pos.entry) : pos.qty * (pos.entry - exitPrice);
        cash += pos.cost + pnl - fees;
        totalFees += fees; totalTrades++;
        if (pnl > 0) { wins++; } else { losses++; cooldown = 3; }
        positions.splice(p, 1);
        if (cash > peak) peak = cash;
        const dd2 = (peak - cash) / peak;
        if (dd2 > maxDrawdown) maxDrawdown = dd2;
      }
    }

    if (positions.length === 0) {
      const signal = analyze(ana, i);
      if (signal) {
        const maxCost = cash * 0.25;
        const qty = maxCost / signal.entry;
        const cost = qty * signal.entry;
        if (cost <= cash * 0.30) {
          positions.push({ side: signal.side, entry: signal.entry, sl: signal.sl, tp: signal.tp, qty, cost, bars: 0 });
          cash -= cost;
        }
      }
    }
  }

  const lastPrice = ana.closes[ana.len - 1];
  for (const pos of positions) {
    const fees = pos.cost * 0.001;
    const pnl = pos.side === "LONG" ? pos.qty * (lastPrice - pos.entry) : pos.qty * (pos.entry - lastPrice);
    cash += pos.cost + pnl - fees;
    totalFees += fees; totalTrades++;
    if (pnl > 0) wins++; else losses++;
  }

  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
  const pnlPct = ((cash - capital) / capital * 100).toFixed(1);
  return { totalTrades, wins, losses, winRate: +winRate, pnlPct: +pnlPct, finalBalance: cash, maxDrawdown: +(maxDrawdown * 100).toFixed(1) };
}

const ASSETS_4H = [
  { sym: "BTC-USD", name: "Bitcoin" },
  { sym: "ETH-USD", name: "Ethereum" },
  { sym: "SOL-USD", name: "Solana" },
  { sym: "DOGE-USD", name: "Dogecoin" },
  { sym: "ADA-USD", name: "Cardano" },
  { sym: "XRP-USD", name: "Ripple" },
  { sym: "AVAX-USD", name: "Avalanche" },
  { sym: "DOT-USD", name: "Polkadot" },
  { sym: "LINK-USD", name: "Chainlink" },
  { sym: "MATIC-USD", name: "Polygon" },
  { sym: "NVDA", name: "NVIDIA" },
  { sym: "TSLA", name: "Tesla" },
  { sym: "AAPL", name: "Apple" },
  { sym: "MSFT", name: "Microsoft" },
  { sym: "AMZN", name: "Amazon" },
  { sym: "META", name: "Meta" },
  { sym: "GOOGL", name: "Google" },
  { sym: "GC=F", name: "Gold" },
  { sym: "SI=F", name: "Silver" },
  { sym: "CL=F", name: "Oil" },
  { sym: "EURUSD=X", name: "EUR/USD" },
  { sym: "GBPUSD=X", name: "GBP/USD" },
  { sym: "USDJPY=X", name: "USD/JPY" },
  { sym: "BTC-EUR", name: "BTC/EUR" },
  { sym: "ETH-EUR", name: "ETH/EUR" },
];

async function main() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  BOT V4 — TIMEFRAME 4H + 25 ACTIFS");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const capital = 250;
  const results = [];

  const now = new Date();
  const tests = [];
  for (let i = 0; i < 5; i++) {
    const endDate = new Date(now);
    endDate.setMonth(endDate.getMonth() - i);
    const startDate = new Date(endDate);
    startDate.setMonth(startDate.getMonth() - 3);
    tests.push({ start: startDate.toISOString().split('T')[0], end: endDate.toISOString().split('T')[0], label: `${i + 1}` });
  }

  for (const test of tests) {
    console.log(`\n═══ TEST ${test.label}/5 (${test.start} → ${test.end}) ═══\n`);

    let balance = capital;
    let totalWins = 0, totalLosses = 0, maxDD = 0;
    let assetResults = [];

    for (const asset of ASSETS_4H) {
      try {
        const data = await yfChart(asset.sym, test.start, test.end, "1h");
        await new Promise(r => setTimeout(r, 300));

        if (!data || data.length < 30) continue;

        const result = backtest(asset.sym, data, balance);
        if (result && result.totalTrades > 0) {
          totalWins += result.wins;
          totalLosses += result.losses;
          if (result.maxDrawdown > maxDD) maxDD = result.maxDrawdown;
          balance = result.finalBalance;
          assetResults.push({ name: asset.name, trades: result.totalTrades, wr: result.winRate, pnl: result.pnlPct });
        }
      } catch (err) {}
    }

    const totalTrades = totalWins + totalLosses;
    const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : 0;
    const pnlPct = ((balance - capital) / capital * 100).toFixed(1);

    results.push({ test: test.label, pnlPct: +pnlPct, trades: totalTrades, winRate: +winRate, dd: maxDD, final: balance });

    const emoji = +pnlPct >= 0 ? "🟢" : "🔴";
    console.log(`  ${emoji} Test ${test.label}: ${capital}€ → ${balance.toFixed(2)}€ (${pnlPct >= 0 ? '+' : ''}${pnlPct}%) | ${totalTrades} trades | ${winRate}% WR | DD: ${maxDD}%`);

    if (assetResults.length > 0) {
      console.log(`\n  Top actifs:`);
      const sorted = assetResults.sort((a, b) => b.pnl - a.pnl).slice(0, 5);
      for (const a of sorted) {
        const e = a.pnl >= 0 ? "🟢" : "🔴";
        console.log(`    ${e} ${a.name}: ${a.trades} trades, ${a.wr}% WR, ${a.pnl >= 0 ? '+' : ''}${a.pnl}%`);
      }
    }
  }

  console.log("\n\n═══════════════════════════════════════════════════════════════");
  console.log("  RÉSUMÉ — BOT V4 (4H + 25 ACTIFS)");
  console.log("═══════════════════════════════════════════════════════════════\n");
  console.log("  Test | Final   | Profit | Trades | Win Rate | DD");
  console.log("  -----|---------|--------|--------|----------|----");
  for (const r of results) {
    const emoji = r.pnlPct >= 0 ? "🟢" : "🔴";
    console.log(`  ${emoji} ${String(r.test).padEnd(4)} | ${(r.final.toFixed(2) + '€').padEnd(7)} | ${(r.pnlPct >= 0 ? '+' : '') + r.pnlPct + '%'} | ${String(r.trades).padEnd(6)} | ${(r.winRate + '%').padEnd(8)} | ${r.dd}%`);
  }

  const avgPnl = results.reduce((a, b) => a + b.pnlPct, 0) / results.length;
  const avgWR = results.reduce((a, b) => a + b.winRate, 0) / results.length;
  const avgTrades = results.reduce((a, b) => a + b.trades, 0) / results.length;
  const winTests = results.filter(r => r.pnlPct > 0).length;

  console.log(`\n  📊 STATISTIQUES:`);
  console.log(`  ├─ Tests gagnants: ${winTests}/5`);
  console.log(`  ├─ Meilleur test: +${Math.max(...results.map(r => r.pnlPct))}%`);
  console.log(`  ├─ Pire test: ${Math.min(...results.map(r => r.pnlPct))}%`);
  console.log(`  ├─ Moyenne: ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(1)}%`);
  console.log(`  ├─ Win Rate moyen: ${avgWR.toFixed(1)}%`);
  console.log(`  └─ Trades moyens: ${avgTrades.toFixed(0)}`);
  console.log(`\n  💡 PROJECTIONS (250€):`);
  console.log(`  ├─ 1 mois: 250€ → ${(250 * (1 + avgPnl/100)).toFixed(0)}€`);
  console.log(`  ├─ 6 mois: 250€ → ${(250 * Math.pow(1 + avgPnl/100, 6)).toFixed(0)}€`);
  console.log(`  └─ 1 an:   250€ → ${(250 * Math.pow(1 + avgPnl/100, 12)).toFixed(0)}€`);
  console.log("\n═══════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
