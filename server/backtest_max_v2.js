import "dotenv/config";
import { RSI, EMA, SMA, ATR } from "technicalindicators";

const YF_H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0" };

async function yfChart(symbol, period1, period2) {
  const p1 = Math.floor(new Date(period1).getTime() / 1000);
  const p2 = Math.floor(new Date(period2).getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${p1}&period2=${p2}&interval=1d`;
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
    ema20: EMA.calculate({ values: closes, period: 20 }),
    ema50: EMA.calculate({ values: closes, period: 50 }),
    atr: ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }),
    volumeSma: SMA.calculate({ values: volumes, period: 20 }),
  };
}

// Vérifie si le marché global est en hausse ou baisse
function getMarketRegime(marketData) {
  if (!marketData || marketData.length < 50) return "unknown";
  const ana = computeIndicators(marketData);
  const len = ana.len;
  const ema20Val = getVal(ana.ema20, len - (ana.len - ana.ema20.length));
  const ema50Val = getVal(ana.ema50, len - (ana.len - ana.ema50.length));
  const rsiVal = getVal(ana.rsi, len - (ana.len - ana.rsi.length));
  const price = ana.closes[len - 1];

  if (!ema20Val || !ema50Val || !rsiVal) return "unknown";

  // Marché haussier: prix > EMA20 > EMA50, RSI > 45
  if (price > ema20Val && ema20Val > ema50Val && rsiVal > 45) return "bull";
  // Marché baissier: prix < EMA20 < EMA50, RSI < 55
  if (price < ema20Val && ema20Val < ema50Val && rsiVal < 55) return "bear";
  return "neutral";
}

function analyze(ana, idx, marketRegime) {
  const { closes, rsi, atr, volumeSma, volumes } = ana;
  if (idx < 20) return null;
  const price = closes[idx];
  const prevPrice = closes[idx - 1];
  const rsiVal = getVal(rsi, idx - (ana.len - rsi.length));
  const atrVal = getVal(atr, idx - (ana.len - atr.length));
  const volSmaVal = getVal(volumeSma, idx - (ana.len - volumeSma.length));
  const volVal = getVal(volumes, idx);
  if (!rsiVal || !atrVal || !volSmaVal || !volVal) return null;

  const isBouncing = price > prevPrice;
  const isFalling = price < prevPrice;
  const volumeOK = volVal > volSmaVal * 0.4;
  const slDistance = atrVal * 1.0;
  const tpDistance = atrVal * 2.0;

  // FILTRE MARCHÉ: Si marché baissier, on réduit les trades
  if (marketRegime === "bear") {
    // En bear market: RSI plus extrême pour entrer
    if (rsiVal < 30 && isBouncing && volumeOK) {
      return { side: "LONG", entry: price, sl: price - slDistance, tp: price + tpDistance, rr: (tpDistance / slDistance).toFixed(2), size: 0.08 };
    }
    if (rsiVal > 70 && isFalling && volumeOK) {
      return { side: "SHORT", entry: price, sl: price + slDistance, tp: price - tpDistance, rr: (tpDistance / slDistance).toFixed(2), size: 0.08 };
    }
    return null;
  }

  // Marché neutre: taille réduite
  if (marketRegime === "neutral") {
    if (rsiVal < 38 && isBouncing && volumeOK) {
      return { side: "LONG", entry: price, sl: price - slDistance, tp: price + tpDistance, rr: (tpDistance / slDistance).toFixed(2), size: 0.12 };
    }
    if (rsiVal > 62 && isFalling && volumeOK) {
      return { side: "SHORT", entry: price, sl: price + slDistance, tp: price - tpDistance, rr: (tpDistance / slDistance).toFixed(2), size: 0.12 };
    }
    return null;
  }

  // Marché haussier: taille normale
  if (rsiVal < 40 && isBouncing && volumeOK) {
    return { side: "LONG", entry: price, sl: price - slDistance, tp: price + tpDistance, rr: (tpDistance / slDistance).toFixed(2), size: 0.15 };
  }
  if (rsiVal > 60 && isFalling && volumeOK) {
    return { side: "SHORT", entry: price, sl: price + slDistance, tp: price - tpDistance, rr: (tpDistance / slDistance).toFixed(2), size: 0.15 };
  }
  return null;
}

function backtest(sym, rawData, capital, marketRegime) {
  if (!rawData || rawData.length < 30) return null;
  const ana = computeIndicators(rawData);
  let cash = capital, peak = capital, maxDrawdown = 0;
  let wins = 0, losses = 0, totalFees = 0, totalTrades = 0;
  let cooldown = 0, positions = [];

  for (let i = 20; i < ana.len; i++) {
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
      if (pnlPct > 0.02) {
        if (pos.side === "LONG" && pos.sl < pos.entry * 1.005) pos.sl = pos.entry * 1.005;
        if (pos.side === "SHORT" && pos.sl > pos.entry * 0.995) pos.sl = pos.entry * 0.995;
      }
      let shouldExit = false, exitPrice = price;
      if (pos.side === "LONG") {
        if (price <= pos.sl) { shouldExit = true; exitPrice = pos.sl; }
        else if (price >= pos.tp) { shouldExit = true; exitPrice = pos.tp; }
        else if (pos.bars >= 7) { shouldExit = true; }
      } else {
        if (price >= pos.sl) { shouldExit = true; exitPrice = pos.sl; }
        else if (price <= pos.tp) { shouldExit = true; exitPrice = pos.tp; }
        else if (pos.bars >= 7) { shouldExit = true; }
      }
      if (shouldExit) {
        const fees = pos.cost * 0.001;
        const pnl = pos.side === "LONG" ? pos.qty * (exitPrice - pos.entry) : pos.qty * (pos.entry - exitPrice);
        cash += pos.cost + pnl - fees;
        totalFees += fees; totalTrades++;
        if (pnl > 0) { wins++; } else { losses++; cooldown = 2; }
        positions.splice(p, 1);
        if (cash > peak) peak = cash;
        const dd2 = (peak - cash) / peak;
        if (dd2 > maxDrawdown) maxDrawdown = dd2;
      }
    }

    if (positions.length === 0) {
      const signal = analyze(ana, i, marketRegime);
      if (signal) {
        const maxCost = cash * (signal.size || 0.15);
        const qty = maxCost / signal.entry;
        const cost = qty * signal.entry;
        if (cost <= cash * 0.20) {
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

const ALL_ASSETS = [
  "BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "ADA-USD", "DOGE-USD",
  "AVAX-USD", "DOT-USD", "LINK-USD", "UNI-USD", "LTC-USD", "ATOM-USD",
  "FIL-USD", "NEAR-USD", "APT21141-USD", "ARB-USD", "OP-USD", "SUI-USD",
  "SEI-USD", "INJ-USD", "FET-USD", "RENDER-USD", "TIA-USD", "JUP-USD",
  "WLD-USD", "ONDO-USD", "PEPE24478-USD", "SHIB-USD", "BONK-USD", "WIF-USD",
  "FLOKI-USD", "BRETT-USD", "GROK-USD", "MOG-USD", "POPCAT-USD", "MEW-USD",
  "BOME-USD", "ENA-USD", "ETHFI-USD", "AAVE-USD", "MKR-USD", "CRV-USD",
  "SNX-USD", "COMP-USD", "DYDX-USD", "PENDLE-USD", "ENS-USD", "LDO-USD",
  "RPL-USD", "GMX-USD", "GNS-USD", "VELA-USD", "CANTO-USD", "OSMO-USD",
  "JUNO-USD", "STARS-USD", "AKASH-USD", "SCRT-USD", "KAVA-USD", "BAND-USD",
  "SUSHI-USD", "1INCH-USD", "BAL-USD", "YFI-USD", "SNX22965-USD", "ALGO-USD",
  "ZRX-USD", "KNC-USD", "RUNE-USD", "FTM-USD", "HARMONY-USD", "WAVES-USD",
  "ZIL-USD", "ICX-USD", "VET-USD", "HOT12348-USD", "CHZ-USD", "SAND-USD",
  "MANA-USD", "AXS-USD",
  "HBAR-USD", "XLM-USD", "FLOW-USD", "ICP-USD", "MINA-USD",
  "CELO-USD", "KUSAMA-USD", "IMX-USD",
  "EGLD-USD", "THETA-USD", "BSV-USD", "BCH-USD", "ETC-USD", "DASH-USD",
  "XMR-USD", "ZEC-USD",
  "NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "GOOG",
  "AMD", "INTC", "CRM", "ORCL", "NFLX", "DIS", "PYPL", "SNAP", "PINS",
  "UBER", "ABNB", "COIN", "MSTR", "PLTR", "SOFI", "HOOD", "RBLX",
  "ROKU", "TTD", "DDOG", "NET", "ZS", "CRWD", "PANW", "NOW",
  "ADBE", "INTU", "AMAT", "LRCX", "KLAC", "MRVL", "AVGO",
  "JPM", "V", "MA", "BAC", "WFC", "GS", "MS", "C", "BLK", "SCHW",
  "AXP", "USB", "PNC", "TFC", "COF", "DFS", "FIS", "FISV", "ADP", "PAYX",
  "JNJ", "PFE", "ABBV", "MRK", "LLY", "NVO", "AZN", "BMY", "GILD", "AMGN",
  "TMO", "ABT", "MDT", "ISRG", "SYK", "BSX", "EW", "HOLX", "XRAY", "ZTS",
  "WMT", "PG", "KO", "PEP", "COST", "HD", "MCD", "NKE", "SBUX", "TGT",
  "LOW", "TJX", "ROST", "DG", "DLTR", "CL", "EL", "KMB", "GIS", "K",
  "XOM", "CVX", "COP", "EOG", "SLB", "PSX", "VLO", "MPC", "OXY", "HAL",
  "EURUSD=X", "GBPUSD=X", "USDJPY=X", "AUDUSD=X", "USDCAD=X", "USDCHF=X",
  "NZDUSD=X", "EURGBP=X", "EURJPY=X", "GBPJPY=X", "AUDJPY=X", "EURAUD=X",
  "EURCAD=X", "EURCHF=X", "GBPCAD=X", "GBPCHF=X", "AUDCAD=X", "AUDNZD=X",
  "USDSGD=X", "USDHKD=X",
  "GC=F", "SI=F", "CL=F", "NG=F", "HG=F", "PL=F", "PA=F", "BZ=F", "HO=F", "RB=F",
  "^GSPC", "^NDX", "^DJI", "^VIX", "^FTSE", "^GDAXI", "^N225", "^RUT", "^SOX", "^IXIC",
];

async function main() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`  BOT MAX V2 — ${ALL_ASSETS.length} ACTIFS + FILTRE MARCHÉ`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  const capital = 250;
  const results = [];

  const now = new Date();
  const tests = [];
  for (let i = 0; i < 10; i++) {
    const endDate = new Date(now);
    endDate.setMonth(endDate.getMonth() - i);
    const startDate = new Date(endDate);
    startDate.setMonth(startDate.getMonth() - 3);
    tests.push({ start: startDate.toISOString().split('T')[0], end: endDate.toISOString().split('T')[0], label: `${i + 1}` });
  }

  // Pré-charger les données de marché (BTC + S&P500)
  console.log("  Chargement données marché global...");
  const btcData = await yfChart("BTC-USD", tests[tests.length - 1].start, tests[0].end);
  const sp500Data = await yfChart("^GSPC", tests[tests.length - 1].start, tests[0].end);
  console.log("  Données marché chargées.\n");

  for (const test of tests) {
    console.log(`\n═══ TEST ${test.label}/10 (${test.start} → ${test.end}) ═══\n`);

    // Déterminer le régime de marché pour cette période
    const btcPeriod = btcData.filter(d => d.date >= new Date(test.start) && d.date <= new Date(test.end));
    const spPeriod = sp500Data.filter(d => d.date >= new Date(test.start) && d.date <= new Date(test.end));
    const btcRegime = getMarketRegime(btcPeriod);
    const spRegime = getMarketRegime(spPeriod);
    
    // Régime final: si les deux sont bear → bear, si les deux sont bull → bull, sinon neutral
    let finalRegime = "neutral";
    if (btcRegime === "bear" && spRegime === "bear") finalRegime = "bear";
    else if (btcRegime === "bull" && spRegime === "bull") finalRegime = "bull";
    
    const regimeEmoji = finalRegime === "bull" ? "🟢" : finalRegime === "bear" ? "🔴" : "🟡";
    console.log(`  ${regimeEmoji} Marché: BTC=${btcRegime}, S&P500=${spRegime} → ${finalRegime.toUpperCase()}\n`);

    let balance = capital;
    let totalWins = 0, totalLosses = 0, maxDD = 0;
    let assetResults = [];
    let assetCount = 0;

    for (const sym of ALL_ASSETS) {
      try {
        const data = await yfChart(sym, test.start, test.end);
        await new Promise(r => setTimeout(r, 150));

        if (!data || data.length < 30) continue;

        const result = backtest(sym, data, balance, finalRegime);
        if (result && result.totalTrades > 0) {
          totalWins += result.wins;
          totalLosses += result.losses;
          if (result.maxDrawdown > maxDD) maxDD = result.maxDrawdown;
          balance = result.finalBalance;
          assetResults.push({ sym, trades: result.totalTrades, wr: result.winRate, pnl: result.pnlPct });
          assetCount++;
        }
      } catch (err) {}
    }

    const totalTrades = totalWins + totalLosses;
    const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : 0;
    const pnlPct = ((balance - capital) / capital * 100).toFixed(1);

    results.push({ test: test.label, pnlPct: +pnlPct, trades: totalTrades, winRate: +winRate, dd: maxDD, final: balance, assetCount, regime: finalRegime });

    const emoji = +pnlPct >= 0 ? "🟢" : "🔴";
    console.log(`  ${emoji} Test ${test.label}: ${capital}€ → ${balance.toFixed(2)}€ (${pnlPct >= 0 ? '+' : ''}${pnlPct}%) | ${totalTrades} trades | ${winRate}% WR | DD: ${maxDD}% | ${assetCount} actifs`);

    if (assetResults.length > 0) {
      console.log(`\n  Top 5 actifs:`);
      const sorted = assetResults.sort((a, b) => b.pnl - a.pnl).slice(0, 5);
      for (const a of sorted) {
        const e = a.pnl >= 0 ? "🟢" : "🔴";
        console.log(`    ${e} ${a.sym}: ${a.trades} trades, ${a.wr}% WR, ${a.pnl >= 0 ? '+' : ''}${a.pnl}%`);
      }
    }
  }

  console.log("\n\n═══════════════════════════════════════════════════════════════");
  console.log(`  RÉSUMÉ — BOT MAX V2 (${ALL_ASSETS.length} ACTIFS + FILTRE)`);
  console.log("═══════════════════════════════════════════════════════════════\n");
  console.log("  Test | Final   | Profit | Trades | Win Rate | DD    | Actifs | Marché");
  console.log("  -----|---------|--------|--------|----------|-------|--------|-------");
  for (const r of results) {
    const emoji = r.pnlPct >= 0 ? "🟢" : "🔴";
    const reg = r.regime === "bull" ? "🟢Bull" : r.regime === "bear" ? "🔴Bear" : "🟡Neut";
    console.log(`  ${emoji} ${String(r.test).padEnd(4)} | ${(r.final.toFixed(2) + '€').padEnd(7)} | ${(r.pnlPct >= 0 ? '+' : '') + r.pnlPct + '%'} | ${String(r.trades).padEnd(6)} | ${(r.winRate + '%').padEnd(8)} | ${(r.dd + '%').padEnd(6)} | ${String(r.assetCount).padEnd(6)} | ${reg}`);
  }

  const avgPnl = results.reduce((a, b) => a + b.pnlPct, 0) / results.length;
  const avgWR = results.reduce((a, b) => a + b.winRate, 0) / results.length;
  const avgTrades = results.reduce((a, b) => a + b.trades, 0) / results.length;
  const winTests = results.filter(r => r.pnlPct > 0).length;
  const avgAssets = results.reduce((a, b) => a + b.assetCount, 0) / results.length;

  // Séparer les résultats par régime
  const bullResults = results.filter(r => r.regime === "bull");
  const bearResults = results.filter(r => r.regime === "bear");
  const neutralResults = results.filter(r => r.regime === "neutral");

  console.log(`\n  📊 STATISTIQUES:`);
  console.log(`  ├─ Tests gagnants: ${winTests}/10`);
  console.log(`  ├─ Meilleur test: +${Math.max(...results.map(r => r.pnlPct))}%`);
  console.log(`  ├─ Pire test: ${Math.min(...results.map(r => r.pnlPct))}%`);
  console.log(`  ├─ Moyenne: ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(1)}%`);
  console.log(`  ├─ Win Rate moyen: ${avgWR.toFixed(1)}%`);
  console.log(`  ├─ Trades moyens: ${avgTrades.toFixed(0)}`);
  console.log(`  └─ Actifs actifs moyens: ${avgAssets.toFixed(0)}`);

  if (bullResults.length > 0) {
    const avgBull = bullResults.reduce((a, b) => a + b.pnlPct, 0) / bullResults.length;
    console.log(`\n  📊 PAR RÉGIME:`);
    console.log(`  ├─ 🟢 Bull (${bullResults.length} tests): ${avgBull >= 0 ? '+' : ''}${avgBull.toFixed(1)}%`);
  }
  if (bearResults.length > 0) {
    const avgBear = bearResults.reduce((a, b) => a + b.pnlPct, 0) / bearResults.length;
    console.log(`  ├─ 🔴 Bear (${bearResults.length} tests): ${avgBear >= 0 ? '+' : ''}${avgBear.toFixed(1)}%`);
  }
  if (neutralResults.length > 0) {
    const avgNeut = neutralResults.reduce((a, b) => a + b.pnlPct, 0) / neutralResults.length;
    console.log(`  └─ 🟡 Neutral (${neutralResults.length} tests): ${avgNeut >= 0 ? '+' : ''}${avgNeut.toFixed(1)}%`);
  }

  console.log(`\n  💡 PROJECTIONS (250€):`);
  console.log(`  ├─ 1 mois: 250€ → ${(250 * (1 + avgPnl/100)).toFixed(0)}€`);
  console.log(`  ├─ 6 mois: 250€ → ${(250 * Math.pow(1 + avgPnl/100, 6)).toFixed(0)}€`);
  console.log(`  └─ 1 an:   250€ → ${(250 * Math.pow(1 + avgPnl/100, 12)).toFixed(0)}€`);
  console.log("\n═══════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
