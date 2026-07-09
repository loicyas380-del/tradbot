import "dotenv/config";
import {
  RSI, MACD, BollingerBands, EMA, SMA, ATR, Stochastic,
} from "technicalindicators";

const YF_H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0" };

async function yfChart(symbol, range, interval = "1h") {
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

function backtestAsset(sym, rawData, config, initialBalance) {
  if (!rawData || rawData.length < 40) return null;
  const ana = computeIndicators(rawData);
  const { tpMultiplier, slMultiplier, trailMultiplier, riskPct, maxHoldBars, maxPositions, maxDrawdownPct, cooldownBars } = config;
  let balance = initialBalance;
  let peak = initialBalance;
  let positions = [];
  let maxDrawdown = 0, wins = 0, losses = 0;
  let consecutiveLosses = 0;
  let cooldown = 0;
  const maxPos = maxPositions || 3;

  for (let i = 35; i < ana.len; i++) {
    const { closes, rsi, macd, ema20, ema50, atr } = ana;
    const price = closes[i];
    const rI = i - (ana.len - rsi.length);
    const mI = i - (ana.len - macd.length);
    const e20I = i - (ana.len - ema20.length);
    const e50I = i - (ana.len - ema50.length);
    const aI = i - (ana.len - atr.length);

    const rsiVal = getVal(rsi, rI);
    const macdCurr = getVal(macd, mI);
    const macdPrev = getVal(macd, mI - 1);
    const ema20Val = getVal(ema20, e20I);
    const ema50Val = getVal(ema50, e50I);
    const atrVal = getVal(atr, aI);

    if (!rsiVal || !macdCurr || !ema20Val || !ema50Val || !atrVal) continue;

    // EXIT
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
        if (pnl > 0) { wins++; consecutiveLosses = 0; }
        else { losses++; consecutiveLosses++; cooldown = cooldownBars || 5; }
        positions.splice(p, 1);
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }
    }

    // COOLDOWN
    if (cooldown > 0) { cooldown--; continue; }

    // MAX DRAWDOWN STOP — pause if drawdown too high
    const currentDD = (peak - balance) / peak;
    if (currentDD > (maxDrawdownPct || 0.20)) continue;

    // CONSECUTIVE LOSS STOP — pause after 5 losses in a row
    if (consecutiveLosses >= 5) { cooldown = 10; continue; }

    // ENTRY
    if (positions.length < maxPos && balance > 3) {
      const longTrend = ema20Val > ema50Val;
      const shortTrend = ema20Val < ema50Val;
      const rsiRising = rsiVal > (getVal(rsi, rI - 1) || rsiVal);
      const rsiFalling = rsiVal < (getVal(rsi, rI - 1) || rsiVal);
      const macdRising = macdCurr.histogram > (macdPrev?.histogram || 0);
      const macdFalling = macdCurr.histogram < (macdPrev?.histogram || 0);

      if (longTrend && rsiVal < 65 && rsiVal > 25 && macdCurr.histogram > 0 && (rsiRising || macdRising)) {
        const riskAmount = balance * riskPct;
        const slDist = atrVal * slMultiplier;
        let qty = +(riskAmount / slDist).toFixed(8);
        let cost = qty * price;
        if (cost > balance * 0.9) { qty = +((balance * 0.9) / price).toFixed(8); cost = qty * price; }
        if (cost > 0 && cost <= balance) {
          positions.push({ side: "LONG", entryPrice: price, qty, cost, tp: price + atrVal * tpMultiplier, sl: price - slDist, bestPrice: price, bars: 0 });
          balance -= cost;
        }
      } else if (shortTrend && rsiVal > 35 && rsiVal < 75 && macdCurr.histogram < 0 && (rsiFalling || macdFalling)) {
        const riskAmount = balance * riskPct;
        const slDist = atrVal * slMultiplier;
        let qty = +(riskAmount / slDist).toFixed(8);
        let cost = qty * price;
        if (cost > balance * 0.9) { qty = +((balance * 0.9) / price).toFixed(8); cost = qty * price; }
        if (cost > 0 && cost <= balance) {
          positions.push({ side: "SHORT", entryPrice: price, qty, cost, tp: price - atrVal * tpMultiplier, sl: price + slDist, bestPrice: price, bars: 0 });
          balance -= cost;
        }
      }
    }
  }

  for (const pos of positions) {
    const lastPrice = ana.closes[ana.len - 1];
    const pnl = pos.side === "LONG" ? pos.qty * (lastPrice - pos.entryPrice) : pos.qty * (pos.entryPrice - lastPrice);
    balance += pos.cost + pnl;
    if (pnl > 0) wins++; else losses++;
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
  const pnlPct = ((balance - initialBalance) / initialBalance * 100).toFixed(1);
  const pnlEur = +(balance - initialBalance).toFixed(2);

  return { sym, totalTrades, wins, losses, winRate: +winRate, pnlPct: +pnlPct, pnlEur, finalBalance: balance, maxDrawdown: +(maxDrawdown * 100).toFixed(1) };
}

// ══════════════════════════════════════════════════════════════
// STRATÉGIES AVEC PROTECTION DRAWDOWN
// ══════════════════════════════════════════════════════════════
const STRATEGIES = [
  { name: "Sélectif: DD20%", riskPct: 0.10, tpMultiplier: 0.6, slMultiplier: 1.2, trailMultiplier: 0.35, maxHoldBars: 8, maxPositions: 3, maxDrawdownPct: 0.20, cooldownBars: 8 },
  { name: "Sélectif: DD30%", riskPct: 0.10, tpMultiplier: 0.6, slMultiplier: 1.2, trailMultiplier: 0.35, maxHoldBars: 8, maxPositions: 3, maxDrawdownPct: 0.30, cooldownBars: 5 },
  { name: "Sélectif: DD25%", riskPct: 0.12, tpMultiplier: 0.6, slMultiplier: 1.2, trailMultiplier: 0.35, maxHoldBars: 8, maxPositions: 3, maxDrawdownPct: 0.25, cooldownBars: 6 },
  { name: "Sélectif: DD15%", riskPct: 0.08, tpMultiplier: 0.6, slMultiplier: 1.2, trailMultiplier: 0.35, maxHoldBars: 8, maxPositions: 2, maxDrawdownPct: 0.15, cooldownBars: 10 },
  { name: "Sélectif: Risk8_DD20", riskPct: 0.08, tpMultiplier: 0.6, slMultiplier: 1.2, trailMultiplier: 0.35, maxHoldBars: 8, maxPositions: 3, maxDrawdownPct: 0.20, cooldownBars: 8 },
  { name: "Sélectif: Risk6_DD20", riskPct: 0.06, tpMultiplier: 0.6, slMultiplier: 1.2, trailMultiplier: 0.35, maxHoldBars: 8, maxPositions: 3, maxDrawdownPct: 0.20, cooldownBars: 8 },
  { name: "Sélectif: Risk5_DD15", riskPct: 0.05, tpMultiplier: 0.6, slMultiplier: 1.2, trailMultiplier: 0.35, maxHoldBars: 8, maxPositions: 2, maxDrawdownPct: 0.15, cooldownBars: 10 },
  { name: "Agro: Risk15_DD30", riskPct: 0.15, tpMultiplier: 0.6, slMultiplier: 1.2, trailMultiplier: 0.35, maxHoldBars: 8, maxPositions: 3, maxDrawdownPct: 0.30, cooldownBars: 5 },
  { name: "Agro: Risk12_DD25", riskPct: 0.12, tpMultiplier: 0.6, slMultiplier: 1.2, trailMultiplier: 0.35, maxHoldBars: 8, maxPositions: 3, maxDrawdownPct: 0.25, cooldownBars: 6 },
  { name: "Safe: Risk3_DD10", riskPct: 0.03, tpMultiplier: 0.6, slMultiplier: 1.2, trailMultiplier: 0.35, maxHoldBars: 8, maxPositions: 2, maxDrawdownPct: 0.10, cooldownBars: 15 },
];

const ASSETS = [
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

async function runYear(yearName, range) {
  console.log(`\n━━━━━━ ${yearName} (${range}) ━━━━━━`);

  const allData = {};
  for (const asset of ASSETS) {
    try {
      allData[asset.sym] = await yfChart(asset.sym, range, "1h");
      await new Promise(r => setTimeout(r, 250));
    } catch (err) {}
  }

  const results = [];
  for (const strat of STRATEGIES) {
    let balance = 40;
    let totalWins = 0, totalLosses = 0;
    let maxDD = 0;

    for (const asset of ASSETS) {
      if (!allData[asset.sym]) continue;
      const result = backtestAsset(asset.sym, allData[asset.sym], strat, balance);
      if (result && result.totalTrades > 0) {
        totalWins += result.wins;
        totalLosses += result.losses;
        if (result.maxDrawdown > maxDD) maxDD = result.maxDrawdown;
        balance = result.finalBalance;
      }
    }

    const totalTrades = totalWins + totalLosses;
    const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : 0;
    const pnlPct = ((balance - 40) / 40 * 100).toFixed(1);

    results.push({ name: strat.name, finalBalance: balance, pnlPct: +pnlPct, winRate: +winRate, totalTrades, maxDD: +maxDD });
  }

  results.sort((a, b) => b.finalBalance - a.finalBalance);

  console.log(`  ${"Stratégie".padEnd(22)} | ${"Final".padStart(10)} | ${"Profit".padStart(8)} | ${"WR".padStart(6)} | ${"Trades".padStart(6)} | ${"MaxDD".padStart(6)}`);
  console.log(`  ${"─".repeat(22)}─┼─${"─".repeat(10)}─┼─${"─".repeat(8)}─┼─${"─".repeat(6)}─┼─${"─".repeat(6)}─┼─${"─".repeat(6)}`);
  for (const r of results) {
    const ddEmoji = r.maxDD <= 15 ? "🟢" : r.maxDD <= 25 ? "🟡" : r.maxDD <= 35 ? "🟠" : "🔴";
    console.log(`  ${r.name.padEnd(22)} | ${r.finalBalance.toFixed(2).padStart(10)}€ | ${("+" + r.pnlPct + "%").padStart(8)} | ${(r.winRate + "%").padStart(6)} | ${String(r.totalTrades).padStart(6)} | ${ddEmoji}${r.maxDD}%`);
  }

  return { year: yearName, results };
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  BACKTEST 3 ANNÉES — STRATÉGIES AVEC PROTECTION DRAWDOWN");
  console.log("  TP 0.6×ATR | SL 1.2×ATR | Trail 0.35×ATR | 40€ → ???");
  console.log("═══════════════════════════════════════════════════════════════");

  const r1 = await runYear("6 Mois", "6mo");
  const r2 = await runYear("1 An", "1y");
  const r3 = await runYear("2 Ans", "2y");

  // Find best overall (highest profit with DD < 25%)
  const allResults = [...r1.results, ...r2.results, ...r3.results];
  const safe = allResults.filter(r => r.maxDD <= 25);
  const bestSafe = safe.sort((a, b) => b.pnlPct - a.pnlPct)[0];

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  🏆 MEILLEURE STRATÉGIE SÉCURISÉE (DD ≤ 25%)");
  console.log("═══════════════════════════════════════════════════════════════");
  if (bestSafe) {
    console.log(`  Nom: ${bestSafe.name}`);
    console.log(`  Profit moyen: +${bestSafe.pnlPct}%`);
    console.log(`  Max Drawdown: ${bestSafe.maxDD}%`);
    console.log(`  Win Rate: ${bestSafe.winRate}%`);
  } else {
    console.log("  Aucune stratégie avec DD ≤ 25% trouvée");
  }
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
