import "dotenv/config";
import { RSI, EMA, SMA, ATR, ADX } from "technicalindicators";

const YF_H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0" };

async function yfChart(symbol, period1, period2, interval = "1d") {
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
  return {
    closes, highs, lows, len: closes.length,
    rsi: RSI.calculate({ values: closes, period: 14 }),
    ema5: EMA.calculate({ values: closes, period: 5 }),
    ema20: EMA.calculate({ values: closes, period: 20 }),
    atr: ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }),
    adx: ADX.calculate({ high: highs, low: lows, close: closes, period: 14 }),
  };
}

function analyze(ana, idx) {
  const { closes, rsi, ema5, ema20, atr, adx } = ana;
  if (idx < 20) return null;
  const price = closes[idx];
  const prevPrice = closes[idx - 1];
  const rsiVal = getVal(rsi, idx - (ana.len - rsi.length));
  const ema5Val = getVal(ema5, idx - (ana.len - ema5.length));
  const ema20Val = getVal(ema20, idx - (ana.len - ema20.length));
  const atrVal = getVal(atr, idx - (ana.len - atr.length));
  const adxVal = getVal(adx, idx - (ana.len - adx.length));
  if (!rsiVal || !ema5Val || !ema20Val || !atrVal) return null;
  const adxNum = adxVal && typeof adxVal === 'object' ? adxVal.adx : adxVal;
  if (!adxNum) return null;

  const isBouncing = price > prevPrice;
  const isFalling = price < prevPrice;

  if (rsiVal < 40 && isBouncing && price > ema5Val && adxNum > 20) {
    return { side: "LONG", entry: price, sl: price * 0.95, tp: price * 1.10 };
  }
  if (rsiVal > 60 && isFalling && price < ema5Val && adxNum > 20) {
    return { side: "SHORT", entry: price, sl: price * 1.05, tp: price * 0.90 };
  }
  return null;
}

function backtest(sym, rawData, initialBalance) {
  if (!rawData || rawData.length < 20) return null;
  const ana = computeIndicators(rawData);
  let cash = initialBalance;
  let peak = initialBalance;
  let positions = [];
  let maxDrawdown = 0, wins = 0, losses = 0;
  let totalFees = 0, totalTrades = 0, cooldown = 0;

  function getEquity(price) {
    let equity = cash;
    for (const pos of positions) {
      equity += pos.side === "LONG" ? pos.qty * price : pos.qty * (2 * pos.entry - price);
    }
    return equity;
  }

  for (let i = 20; i < ana.len; i++) {
    const price = ana.closes[i];
    const equity = getEquity(price);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (dd > 0.15) continue;
    if (cooldown > 0) { cooldown--; continue; }

    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      pos.bars++;
      if (pos.side === "LONG") {
        const profit = (price - pos.entry) / pos.entry;
        if (profit > 0.03 && pos.sl < pos.entry * 1.01) pos.sl = pos.entry * 1.01;
      } else {
        const profit = (pos.entry - price) / pos.entry;
        if (profit > 0.03 && pos.sl > pos.entry * 0.99) pos.sl = pos.entry * 0.99;
      }
      let shouldExit = false, exitPrice = price;
      if (pos.side === "LONG") {
        if (price <= pos.sl) { shouldExit = true; exitPrice = pos.sl; }
        else if (price >= pos.tp) { shouldExit = true; exitPrice = pos.tp; }
        else if (pos.bars >= 5) { shouldExit = true; }
      } else {
        if (price >= pos.sl) { shouldExit = true; exitPrice = pos.sl; }
        else if (price <= pos.tp) { shouldExit = true; exitPrice = pos.tp; }
        else if (pos.bars >= 5) { shouldExit = true; }
      }
      if (shouldExit) {
        const fees = pos.cost * 0.001;
        const pnl = pos.side === "LONG" ? pos.qty * (exitPrice - pos.entry) : pos.qty * (pos.entry - exitPrice);
        cash += pos.cost + pnl - fees;
        totalFees += fees; totalTrades++;
        if (pnl > 0) { wins++; } else { losses++; cooldown = 2; }
        positions.splice(p, 1);
        const eq = getEquity(exitPrice);
        if (eq > peak) peak = eq;
        const dd2 = (peak - eq) / peak;
        if (dd2 > maxDrawdown) maxDrawdown = dd2;
      }
    }

    if (positions.length === 0) {
      const signal = analyze(ana, i);
      if (signal) {
        const maxCost = cash * 0.90;
        const qty = maxCost / signal.entry;
        const cost = qty * signal.entry;
        if (cost <= cash * 0.95) {
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
  const pnlPct = ((cash - initialBalance) / initialBalance * 100).toFixed(1);
  return { totalTrades, wins, losses, winRate: +winRate, pnlPct: +pnlPct, finalBalance: cash, maxDrawdown: +(maxDrawdown * 100).toFixed(1), totalFees: +totalFees.toFixed(2) };
}

const ASSETS = [
  { sym: "BTC-USD", name: "Bitcoin" },
  { sym: "ETH-USD", name: "Ethereum" },
  { sym: "SOL-USD", name: "Solana" },
  { sym: "NVDA", name: "NVIDIA" },
  { sym: "META", name: "Meta" },
  { sym: "AMZN", name: "Amazon" },
  { sym: "GC=F", name: "Gold" },
];

async function main() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  BOT ULTIME — 10 TESTS | 250€ | Mean Reversion");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const results = [];
  const capital = 250;

  const now = new Date();
  const tests = [];
  for (let i = 0; i < 10; i++) {
    const endDate = new Date(now);
    endDate.setMonth(endDate.getMonth() - i);
    const startDate = new Date(endDate);
    startDate.setMonth(startDate.getMonth() - 3);
    tests.push({ start: startDate.toISOString().split('T')[0], end: endDate.toISOString().split('T')[0], label: `${i + 1}` });
  }

  for (const test of tests) {
    console.log(`\n═══ TEST ${test.label}/10 (${test.start} → ${test.end}) ═══\n`);
    const allData = {};
    for (const asset of ASSETS) {
      try {
        allData[asset.sym] = await yfChart(asset.sym, test.start, test.end, "1d");
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {}
    }
    let balance = capital;
    let totalWins = 0, totalLosses = 0, maxDD = 0, totalFeesAll = 0;
    for (const asset of ASSETS) {
      if (!allData[asset.sym]) continue;
      const result = backtest(asset.sym, allData[asset.sym], balance);
      if (result && result.totalTrades > 0) {
        totalWins += result.wins;
        totalLosses += result.losses;
        if (result.maxDrawdown > maxDD) maxDD = result.maxDrawdown;
        totalFeesAll += result.totalFees;
        balance = result.finalBalance;
      }
    }
    const totalTrades = totalWins + totalLosses;
    const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : 0;
    const pnlPct = ((balance - capital) / capital * 100).toFixed(1);
    results.push({ month: test.label, start: capital, end: balance, pnlPct: +pnlPct, trades: totalTrades, winRate: +winRate, dd: maxDD });
    const emoji = +pnlPct >= 0 ? "🟢" : "🔴";
    console.log(`  ${emoji} Test ${test.label}: ${capital}€ → ${balance.toFixed(2)}€ (${pnlPct >= 0 ? '+' : ''}${pnlPct}%) | ${totalTrades} trades | ${winRate}% WR | DD: ${maxDD}%`);
  }

  console.log("\n\n═══════════════════════════════════════════════════════════════");
  console.log("  RÉSUMÉ FINAL — 10 TESTS (3 mois chacun, dates différentes)");
  console.log("═══════════════════════════════════════════════════════════════\n");
  console.log("  Test | Départ | Final   | Profit | Trades | Win Rate | DD");
  console.log("  -----|--------|---------|--------|--------|----------|----");
  for (const r of results) {
    const emoji = r.pnlPct >= 0 ? "🟢" : "🔴";
    console.log(`  ${emoji} ${String(r.month).padEnd(4)} | ${(r.start + '€').padEnd(6)} | ${(r.end.toFixed(2) + '€').padEnd(7)} | ${(r.pnlPct >= 0 ? '+' : '') + r.pnlPct + '%'} | ${String(r.trades).padEnd(6)} | ${(r.winRate + '%').padEnd(8)} | ${r.dd}%`);
  }

  const avgPnl = results.reduce((a, b) => a + b.pnlPct, 0) / results.length;
  const avgWinRate = results.reduce((a, b) => a + b.winRate, 0) / results.length;
  const avgTrades = results.reduce((a, b) => a + b.trades, 0) / results.length;
  const winMonths = results.filter(r => r.pnlPct > 0).length;
  const bestMonth = Math.max(...results.map(r => r.pnlPct));
  const worstMonth = Math.min(...results.map(r => r.pnlPct));

  console.log(`\n  📊 STATISTIQUES:`);
  console.log(`  ├─ Mois gagnants: ${winMonths}/10`);
  console.log(`  ├─ Meilleur mois: +${bestMonth}%`);
  console.log(`  ├─ Pire mois: ${worstMonth}%`);
  console.log(`  ├─ Moyenne: ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(1)}%`);
  console.log(`  ├─ Win Rate moyen: ${avgWinRate.toFixed(1)}%`);
  console.log(`  └─ Trades moyens: ${avgTrades.toFixed(0)}`);
  console.log(`\n  💡 PROJECTIONS (250€):`);
  console.log(`  ├─ 1 mois: 250€ → ${(250 * (1 + avgPnl/100)).toFixed(0)}€`);
  console.log(`  ├─ 6 mois: 250€ → ${(250 * Math.pow(1 + avgPnl/100, 6)).toFixed(0)}€`);
  console.log(`  └─ 1 an:   250€ → ${(250 * Math.pow(1 + avgPnl/100, 12)).toFixed(0)}€`);
  console.log("\n═══════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
