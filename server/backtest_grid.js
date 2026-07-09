import "dotenv/config";

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

function gridBacktest(data, capital, gridSpacingPct, investPerGrid) {
  if (!data || data.length < 10) return null;

  const gridSpacing = gridSpacingPct / 100;
  let balance = capital;
  let cash = capital;
  let peak = capital;
  let maxDrawdown = 0;
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let totalFees = 0;

  let buyGrids = [];
  let sellGrids = [];
  let positions = [];

  const startPrice = data[0].close;
  const numGrids = 10;
  const gridLow = startPrice * (1 - gridSpacing * numGrids / 2);
  const gridHigh = startPrice * (1 + gridSpacing * numGrids / 2);

  for (let i = 0; i < numGrids; i++) {
    const price = gridLow + (gridHigh - gridLow) * (i / (numGrids - 1));
    buyGrids.push({ price, filled: false });
  }
  for (let i = 0; i < numGrids - 1; i++) {
    const price = gridLow + (gridHigh - gridLow) * ((i + 0.5) / (numGrids - 1));
    sellGrids.push({ price, filled: false, buyPrice: 0 });
  }

  for (let i = 0; i < data.length; i++) {
    const price = data[i].close;
    const high = data[i].high;
    const low = data[i].low;

    if (balance > peak) peak = balance;
    const dd = (peak - balance) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;

    for (const grid of buyGrids) {
      if (!grid.filled && low <= grid.price && cash >= investPerGrid) {
        const qty = investPerGrid / grid.price;
        const fee = investPerGrid * 0.001;
        cash -= (investPerGrid + fee);
        totalFees += fee;
        positions.push({ buyPrice: grid.price, qty, bars: 0 });
        grid.filled = true;
        totalTrades++;
      }
    }

    for (let p = positions.length - 1; p >= 0; p--) {
      const pos = positions[p];
      pos.bars++;
      const sellTarget = pos.buyPrice * (1 + gridSpacing);
      if (high >= sellTarget && cash >= 0) {
        const sellValue = pos.qty * sellTarget;
        const fee = sellValue * 0.001;
        const pnl = sellValue - (pos.qty * pos.buyPrice) - fee;
        cash += sellValue - fee;
        totalFees += fee;
        totalTrades++;
        if (pnl > 0) wins++; else losses++;
        positions.splice(p, 1);

        for (const grid of buyGrids) {
          if (Math.abs(grid.price - pos.buyPrice) < grid.price * 0.001) {
            grid.filled = false;
          }
        }
      }
    }

    balance = cash;
    for (const pos of positions) {
      balance += pos.qty * price;
    }
  }

  const lastPrice = data[data.length - 1].close;
  for (const pos of positions) {
    const sellValue = pos.qty * lastPrice;
    const fee = sellValue * 0.001;
    cash += sellValue - fee;
    totalFees += fee;
    totalTrades++;
    const pnl = (lastPrice - pos.buyPrice) * pos.qty - fee;
    if (pnl > 0) wins++; else losses++;
  }

  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
  const finalBalance = cash;
  const pnlPct = ((finalBalance - capital) / capital * 100).toFixed(1);

  return {
    totalTrades, wins, losses, winRate: +winRate,
    pnlPct: +pnlPct, finalBalance, maxDrawdown: +(maxDrawdown * 100).toFixed(1),
    totalFees: +totalFees.toFixed(2)
  };
}

function dcaBacktest(data, capital, buyInterval, investAmount) {
  if (!data || data.length < 10) return null;

  let cash = capital;
  let holdings = 0;
  let avgBuy = 0;
  let peak = capital;
  let maxDrawdown = 0;
  let totalTrades = 0;
  let totalFees = 0;
  let wins = 0;
  let losses = 0;
  let lastBuyBar = -buyInterval;

  const takeProfitPct = 0.08;
  const stopLossPct = 0.05;

  for (let i = 0; i < data.length; i++) {
    const price = data[i].close;

    if (holdings > 0) {
      const equity = cash + holdings * price;
      if (equity > peak) peak = equity;
      const dd = (peak - equity) / peak;
      if (dd > maxDrawdown) maxDrawdown = dd;

      const profitPct = (price - avgBuy) / avgBuy;
      if (profitPct >= takeProfitPct) {
        const sellValue = holdings * price;
        const fee = sellValue * 0.001;
        const pnl = holdings * (price - avgBuy) - fee;
        cash += sellValue - fee;
        totalFees += fee;
        totalTrades++;
        if (pnl > 0) wins++; else losses++;
        holdings = 0;
        avgBuy = 0;
        lastBuyBar = i;
      } else if (profitPct <= -stopLossPct) {
        const sellValue = holdings * price;
        const fee = sellValue * 0.001;
        const pnl = holdings * (price - avgBuy) - fee;
        cash += sellValue - fee;
        totalFees += fee;
        totalTrades++;
        if (pnl > 0) wins++; else losses++;
        holdings = 0;
        avgBuy = 0;
        lastBuyBar = i;
      }
    }

    if (holdings === 0 && (i - lastBuyBar) >= buyInterval && cash >= investAmount) {
      const qty = investAmount / price;
      const fee = investAmount * 0.001;
      cash -= (investAmount + fee);
      totalFees += fee;
      holdings += qty;
      avgBuy = price;
      totalTrades++;
      lastBuyBar = i;
    } else if (holdings > 0 && (i - lastBuyBar) >= buyInterval && cash >= investAmount) {
      const qty = investAmount / price;
      const totalCost = (holdings * avgBuy) + investAmount;
      const fee = investAmount * 0.001;
      cash -= (investAmount + fee);
      totalFees += fee;
      holdings += qty;
      avgBuy = totalCost / holdings;
      totalTrades++;
      lastBuyBar = i;
    }
  }

  const lastPrice = data[data.length - 1].close;
  if (holdings > 0) {
    const sellValue = holdings * lastPrice;
    const fee = sellValue * 0.001;
    cash += sellValue - fee;
    totalFees += fee;
    totalTrades++;
    const pnl = holdings * (lastPrice - avgBuy) - fee;
    if (pnl > 0) wins++; else losses++;
  }

  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
  const pnlPct = ((cash - capital) / capital * 100).toFixed(1);

  return {
    totalTrades, wins, losses, winRate: +winRate,
    pnlPct: +pnlPct, finalBalance: cash, maxDrawdown: +(maxDrawdown * 100).toFixed(1),
    totalFees: +totalFees.toFixed(2)
  };
}

const ASSETS = [
  { sym: "BTC-USD", name: "Bitcoin" },
  { sym: "ETH-USD", name: "Ethereum" },
  { sym: "SOL-USD", name: "Solana" },
];

async function main() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  GRID TRADING + DCA — 10 TESTS | 250€");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const capital = 250;
  const gridResults = [];
  const dcaResults = [];

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

    let gridBalance = capital;
    let dcaBalance = capital;
    let gridWins = 0, gridLosses = 0, gridDD = 0;
    let dcaWins = 0, dcaLosses = 0, dcaDD = 0;

    for (const asset of ASSETS) {
      if (!allData[asset.sym]) continue;

      const gridResult = gridBacktest(allData[asset.sym], gridBalance, 2, gridBalance * 0.10);
      if (gridResult && gridResult.totalTrades > 0) {
        gridWins += gridResult.wins;
        gridLosses += gridResult.losses;
        if (gridResult.maxDrawdown > gridDD) gridDD = gridResult.maxDrawdown;
        gridBalance = gridResult.finalBalance;
      }

      const dcaResult = dcaBacktest(allData[asset.sym], dcaBalance, 5, dcaBalance * 0.15);
      if (dcaResult && dcaResult.totalTrades > 0) {
        dcaWins += dcaResult.wins;
        dcaLosses += dcaResult.losses;
        if (dcaResult.maxDrawdown > dcaDD) dcaDD = dcaResult.maxDrawdown;
        dcaBalance = dcaResult.finalBalance;
      }
    }

    const gridTrades = gridWins + gridLosses;
    const gridWR = gridTrades > 0 ? ((gridWins / gridTrades) * 100).toFixed(1) : 0;
    const gridPnl = ((gridBalance - capital) / capital * 100).toFixed(1);

    const dcaTrades = dcaWins + dcaLosses;
    const dcaWR = dcaTrades > 0 ? ((dcaWins / dcaTrades) * 100).toFixed(1) : 0;
    const dcaPnl = ((dcaBalance - capital) / capital * 100).toFixed(1);

    gridResults.push({ test: test.label, start: capital, end: gridBalance, pnlPct: +gridPnl, trades: gridTrades, winRate: +gridWR, dd: gridDD });
    dcaResults.push({ test: test.label, start: capital, end: dcaBalance, pnlPct: +dcaPnl, trades: dcaTrades, winRate: +dcaWR, dd: dcaDD });

    const gEmoji = +gridPnl >= 0 ? "🟢" : "🔴";
    const dEmoji = +dcaPnl >= 0 ? "🟢" : "🔴";
    console.log(`  ${gEmoji} GRID:  ${capital}€ → ${gridBalance.toFixed(2)}€ (${gridPnl >= 0 ? '+' : ''}${gridPnl}%) | ${gridTrades} trades | ${gridWR}% WR | DD: ${gridDD}%`);
    console.log(`  ${dEmoji} DCA:   ${capital}€ → ${dcaBalance.toFixed(2)}€ (${dcaPnl >= 0 ? '+' : ''}${dcaPnl}%) | ${dcaTrades} trades | ${dcaWR}% WR | DD: ${dcaDD}%`);
  }

  console.log("\n\n═══════════════════════════════════════════════════════════════");
  console.log("  RÉSUMÉ — GRID TRADING");
  console.log("═══════════════════════════════════════════════════════════════\n");
  console.log("  Test | Départ | Final   | Profit | Trades | Win Rate | DD");
  console.log("  -----|--------|---------|--------|--------|----------|----");
  for (const r of gridResults) {
    const emoji = r.pnlPct >= 0 ? "🟢" : "🔴";
    console.log(`  ${emoji} ${String(r.test).padEnd(4)} | ${(r.start + '€').padEnd(6)} | ${(r.end.toFixed(2) + '€').padEnd(7)} | ${(r.pnlPct >= 0 ? '+' : '') + r.pnlPct + '%'} | ${String(r.trades).padEnd(6)} | ${(r.winRate + '%').padEnd(8)} | ${r.dd}%`);
  }

  const gAvgPnl = gridResults.reduce((a, b) => a + b.pnlPct, 0) / gridResults.length;
  const gAvgWR = gridResults.reduce((a, b) => a + b.winRate, 0) / gridResults.length;
  const gWins = gridResults.filter(r => r.pnlPct > 0).length;

  console.log(`\n  📊 STATISTIQUES GRID:`);
  console.log(`  ├─ Mois gagnants: ${gWins}/10`);
  console.log(`  ├─ Meilleur mois: +${Math.max(...gridResults.map(r => r.pnlPct))}%`);
  console.log(`  ├─ Pire mois: ${Math.min(...gridResults.map(r => r.pnlPct))}%`);
  console.log(`  ├─ Moyenne: ${gAvgPnl >= 0 ? '+' : ''}${gAvgPnl.toFixed(1)}%`);
  console.log(`  └─ Win Rate moyen: ${gAvgWR.toFixed(1)}%`);

  console.log("\n\n═══════════════════════════════════════════════════════════════");
  console.log("  RÉSUMÉ — DCA AUTOMATIQUE");
  console.log("═══════════════════════════════════════════════════════════════\n");
  console.log("  Test | Départ | Final   | Profit | Trades | Win Rate | DD");
  console.log("  -----|--------|---------|--------|--------|----------|----");
  for (const r of dcaResults) {
    const emoji = r.pnlPct >= 0 ? "🟢" : "🔴";
    console.log(`  ${emoji} ${String(r.test).padEnd(4)} | ${(r.start + '€').padEnd(6)} | ${(r.end.toFixed(2) + '€').padEnd(7)} | ${(r.pnlPct >= 0 ? '+' : '') + r.pnlPct + '%'} | ${String(r.trades).padEnd(6)} | ${(r.winRate + '%').padEnd(8)} | ${r.dd}%`);
  }

  const dAvgPnl = dcaResults.reduce((a, b) => a + b.pnlPct, 0) / dcaResults.length;
  const dAvgWR = dcaResults.reduce((a, b) => a + b.winRate, 0) / dcaResults.length;
  const dWins = dcaResults.filter(r => r.pnlPct > 0).length;

  console.log(`\n  📊 STATISTIQUES DCA:`);
  console.log(`  ├─ Mois gagnants: ${dWins}/10`);
  console.log(`  ├─ Meilleur mois: +${Math.max(...dcaResults.map(r => r.pnlPct))}%`);
  console.log(`  ├─ Pire mois: ${Math.min(...dcaResults.map(r => r.pnlPct))}%`);
  console.log(`  ├─ Moyenne: ${dAvgPnl >= 0 ? '+' : ''}${dAvgPnl.toFixed(1)}%`);
  console.log(`  └─ Win Rate moyen: ${dAvgWR.toFixed(1)}%`);

  console.log("\n\n═══════════════════════════════════════════════════════════════");
  console.log("  COMPARAISON FINALE");
  console.log("═══════════════════════════════════════════════════════════════\n");
  console.log(`  Stratégie   | Moyenne   | Win Rate | DD Max  | Trades`);
  console.log(`  ------------|-----------|----------|---------|--------`);
  console.log(`  Grid        | ${(gAvgPnl >= 0 ? '+' : '') + gAvgPnl.toFixed(1) + '%'}     | ${gAvgWR.toFixed(1)}%     | ${Math.max(...gridResults.map(r => r.dd))}%    | ${gridResults.reduce((a, b) => a + b.trades, 0)}`);
  console.log(`  DCA         | ${(dAvgPnl >= 0 ? '+' : '') + dAvgPnl.toFixed(1) + '%'}      | ${dAvgWR.toFixed(1)}%     | ${Math.max(...dcaResults.map(r => r.dd))}%    | ${dcaResults.reduce((a, b) => a + b.trades, 0)}`);

  const best = gAvgPnl > dAvgPnl ? "Grid Trading" : "DCA";
  console.log(`\n  🏆 MEILLEURE STRATÉGIE: ${best}`);
  console.log(`\n  💡 PROJECTIONS (250€, 1 an):`);
  console.log(`  ├─ Grid: 250€ → ${(250 * Math.pow(1 + gAvgPnl/100, 12)).toFixed(0)}€`);
  console.log(`  ├─ DCA:  250€ → ${(250 * Math.pow(1 + dAvgPnl/100, 12)).toFixed(0)}€`);
  console.log("\n═══════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
