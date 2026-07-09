import "dotenv/config";
import {
  RSI, MACD, BollingerBands, EMA, SMA, ATR, Stochastic, ADX,
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

function calculateVWAP(rawData) {
  const vwap = [];
  let cumVolumePrice = 0;
  let cumVolume = 0;
  for (let i = 0; i < rawData.length; i++) {
    const typicalPrice = (rawData[i].high + rawData[i].low + rawData[i].close) / 3;
    cumVolumePrice += typicalPrice * rawData[i].volume;
    cumVolume += rawData[i].volume;
    vwap.push(cumVolume > 0 ? cumVolumePrice / cumVolume : rawData[i].close);
  }
  return vwap;
}

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
    adx: ADX.calculate({ high: highs, low: lows, close: closes, period: 14 }),
    vwap: calculateVWAP(rawData),
  };
}

function applySlippage(price, side, assetType) {
  const slippageRates = { crypto: 0.0005, stock: 0.0003, stock_fast: 0.0003, forex: 0.0001, commodity: 0.0005, index: 0.0003 };
  const rate = slippageRates[assetType] || 0.0003;
  const slippage = price * rate;
  return side === "BUY" ? price + slippage : price - slippage;
}

function calculateFees(amount) {
  return amount * 0.0005;
}

function getKellyCriterion(wins, losses, recentPnL) {
  const totalTrades = wins + losses;
  if (totalTrades < 10) return 0.5;
  const winRate = wins / totalTrades;
  const avgWin = recentPnL.filter(p => p > 0).length > 0 
    ? recentPnL.filter(p => p > 0).reduce((a, b) => a + b, 0) / recentPnL.filter(p => p > 0).length 
    : 1;
  const avgLoss = recentPnL.filter(p => p < 0).length > 0 
    ? Math.abs(recentPnL.filter(p => p < 0).reduce((a, b) => a + b, 0) / recentPnL.filter(p => p < 0).length) 
    : 1;
  const winLossRatio = avgWin / avgLoss;
  const kelly = ((winLossRatio * winRate) - (1 - winRate)) / winLossRatio;
  return Math.max(0.1, Math.min(0.5, kelly));
}

function backtestAsset(sym, rawData, config, initialBalance, startIdx, endIdx) {
  if (!rawData || rawData.length < 40) return null;
  const sliced = rawData.slice(startIdx, endIdx);
  if (sliced.length < 40) return null;
  const ana = computeIndicators(sliced);
  const { tpMultiplier, slMultiplier, trailMultiplier, riskPct, maxHoldBars, maxPositions, maxDrawdownPct, cooldownBars } = config;
  let balance = initialBalance;
  let peak = initialBalance;
  let positions = [];
  let maxDrawdown = 0, wins = 0, losses = 0;
  let consecutiveLosses = 0;
  let cooldown = 0;
  const maxPos = maxPositions || 5;
  let recentPnL = [];
  let dailyPnL = 0;
  let lastDailyReset = 0;
  let totalFees = 0;
  const maxDailyLossPct = 0.15;

  for (let i = 35; i < ana.len; i++) {
    const { closes, rsi, macd, ema20, ema50, atr, adx, vwap } = ana;
    const price = closes[i];
    const rI = i - (ana.len - rsi.length);
    const mI = i - (ana.len - macd.length);
    const e20I = i - (ana.len - ema20.length);
    const e50I = i - (ana.len - ema50.length);
    const aI = i - (ana.len - atr.length);
    const adxI = i - (ana.len - adx.length);
    const vwapI = i - (ana.len - vwap.length);

    const rsiVal = getVal(rsi, rI);
    const macdCurr = getVal(macd, mI);
    const macdPrev = getVal(macd, mI - 1);
    const ema20Val = getVal(ema20, e20I);
    const ema50Val = getVal(ema50, e50I);
    const atrVal = getVal(atr, aI);
    const adxVal = getVal(adx, adxI);
    const vwapVal = getVal(vwap, vwapI);

    if (!rsiVal || !macdCurr || !ema20Val || !ema50Val || !atrVal || !adxVal || !vwapVal) continue;

    if (i - lastDailyReset >= 24) {
      dailyPnL = 0;
      lastDailyReset = i;
    }
    if (dailyPnL < 0 && Math.abs(dailyPnL) / balance > maxDailyLossPct) continue;

    const kellyMult = getKellyCriterion(wins, losses, recentPnL);

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
        const exitPriceSlippage = applySlippage(exitPrice, pos.side === "LONG" ? "SELL" : "BUY", "crypto");
        const pnl = pos.side === "LONG" ? pos.qty * (exitPriceSlippage - pos.entryPrice) : pos.qty * (pos.entryPrice - exitPriceSlippage);
        const fees = calculateFees(pos.cost + pnl);
        balance += pos.cost + pnl - fees;
        totalFees += fees;
        dailyPnL += pnl;
        recentPnL.push(pnl);
        if (recentPnL.length > 20) recentPnL.shift();
        if (pnl > 0) { wins++; consecutiveLosses = 0; } else { losses++; consecutiveLosses++; cooldown = cooldownBars || 5; }
        positions.splice(p, 1);
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }
    }

    if (cooldown > 0) { cooldown--; continue; }
    if (maxDrawdownPct && (peak - balance) / peak > maxDrawdownPct) continue;
    if (consecutiveLosses >= 5) { cooldown = 10; continue; }

    const longTrend = ema20Val > ema50Val;
    const shortTrend = ema20Val < ema50Val;
    const rsiRising = rsiVal > (getVal(rsi, rI - 1) || rsiVal);
    const rsiFalling = rsiVal < (getVal(rsi, rI - 1) || rsiVal);
    const macdRising = macdCurr.histogram > (macdPrev?.histogram || 0);
    const macdFalling = macdCurr.histogram < (macdPrev?.histogram || 0);

    if (positions.length < maxPos && balance > 5) {
      if (longTrend && rsiVal < 65 && rsiVal > 25 && macdCurr.histogram > 0 && (rsiRising || macdRising)) {
        const riskAmount = balance * riskPct * kellyMult;
        const slDist = atrVal * slMultiplier;
        let qty = +(riskAmount / slDist).toFixed(8);
        let cost = qty * price;
        if (cost > balance * 0.9) { qty = +((balance * 0.9) / price).toFixed(8); cost = qty * price; }
        const entryPriceSlippage = applySlippage(price, "BUY", "crypto");
        const fees = calculateFees(cost);
        if (cost > 0 && cost + fees <= balance) {
          positions.push({ side: "LONG", entryPrice: entryPriceSlippage, qty, cost: cost + fees, tp: entryPriceSlippage + atrVal * tpMultiplier, sl: entryPriceSlippage - slDist, bestPrice: entryPriceSlippage, bars: 0 });
          balance -= cost + fees;
          totalFees += fees;
        }
      }
      else if (shortTrend && rsiVal > 35 && rsiVal < 75 && macdCurr.histogram < 0 && (rsiFalling || macdFalling)) {
        const riskAmount = balance * riskPct * kellyMult;
        const slDist = atrVal * slMultiplier;
        let qty = +(riskAmount / slDist).toFixed(8);
        let cost = qty * price;
        if (cost > balance * 0.9) { qty = +((balance * 0.9) / price).toFixed(8); cost = qty * price; }
        const entryPriceSlippage = applySlippage(price, "SELL", "crypto");
        const fees = calculateFees(cost);
        if (cost > 0 && cost + fees <= balance) {
          positions.push({ side: "SHORT", entryPrice: entryPriceSlippage, qty, cost: cost + fees, tp: entryPriceSlippage - atrVal * tpMultiplier, sl: entryPriceSlippage + slDist, bestPrice: entryPriceSlippage, bars: 0 });
          balance -= cost + fees;
          totalFees += fees;
        }
      }
    }
  }

  for (const pos of positions) {
    const lastPrice = ana.closes[ana.len - 1];
    const exitPriceSlippage = applySlippage(lastPrice, pos.side === "LONG" ? "SELL" : "BUY", "crypto");
    const pnl = pos.side === "LONG" ? pos.qty * (exitPriceSlippage - pos.entryPrice) : pos.qty * (pos.entryPrice - exitPriceSlippage);
    const fees = calculateFees(pos.cost + pnl);
    balance += pos.cost + pnl - fees;
    totalFees += fees;
    if (pnl > 0) wins++; else losses++;
  }

  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
  const pnlPct = ((balance - initialBalance) / initialBalance * 100).toFixed(1);

  return { totalTrades, wins, losses, winRate: +winRate, pnlPct: +pnlPct, finalBalance: balance, maxDrawdown: +(maxDrawdown * 100).toFixed(1), totalFees: +totalFees.toFixed(2) };
}

const STRAT = { riskPct: 0.30, tpMultiplier: 2.0, slMultiplier: 0.6, trailMultiplier: 0.3, maxHoldBars: 15, maxPositions: 5, maxDrawdownPct: 0.50, cooldownBars: 3 };

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

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  10 BACKTESTS — V2 avec frais | TP 2.0× | SL 0.6× | 500€");
  console.log("═══════════════════════════════════════════════════════════════\n");

  console.log("Fetching 3 mois de données 1h...\n");
  const allData = {};
  for (const asset of ASSETS) {
    try {
      allData[asset.sym] = await yfChart(asset.sym, "3mo", "1h");
      process.stdout.write(`  ✓ ${asset.name} (${allData[asset.sym].length} candles)\n`);
      await new Promise(r => setTimeout(r, 250));
    } catch (err) {
      process.stdout.write(`  ✗ ${asset.name}: ${err.message}\n`);
    }
  }

  console.log(`\nData: ${Object.keys(allData).length} assets.\n`);

  const WINDOWS = [
    { name: "Période 1", start: 0, end: 720 },
    { name: "Période 2", start: 100, end: 820 },
    { name: "Période 3", start: 200, end: 920 },
    { name: "Période 4", start: 300, end: 1020 },
    { name: "Période 5", start: 400, end: 1120 },
    { name: "Période 6", start: 500, end: 1220 },
    { name: "Période 7", start: 600, end: 1320 },
    { name: "Période 8", start: 700, end: 1420 },
    { name: "Période 9", start: 800, end: 1520 },
    { name: "Période 10", start: 900, end: 1620 },
  ];

  const results = [];

  for (const window of WINDOWS) {
    let balance = 500;
    let totalWins = 0, totalLosses = 0;
    let maxDD = 0;
    let totalFees = 0;

    for (const asset of ASSETS) {
      if (!allData[asset.sym]) continue;
      const result = backtestAsset(asset.sym, allData[asset.sym], STRAT, balance, window.start, window.end);
      if (result && result.totalTrades > 0) {
        totalWins += result.wins;
        totalLosses += result.losses;
        if (result.maxDrawdown > maxDD) maxDD = result.maxDrawdown;
        totalFees += result.totalFees;
        balance = result.finalBalance;
      }
    }

    const totalTrades = totalWins + totalLosses;
    const winRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : 0;
    const pnlPct = ((balance - 500) / 500 * 100).toFixed(1);
    const pnlEur = (balance - 500).toFixed(2);

    results.push({ name: window.name, finalBalance: balance, pnlPct: +pnlPct, pnlEur: +pnlEur, winRate: +winRate, totalTrades, maxDD: +maxDD, totalFees: +totalFees.toFixed(2) });
  }

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  RÉSULTATS — 10 PÉRIODES (avec frais/slippage)")
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  ${"Période".padEnd(12)} | ${"Final".padStart(10)} | ${"Profit".padStart(10)} | ${"WR".padStart(6)} | ${"Trades".padStart(6)} | ${"MaxDD".padStart(6)} | ${"Fees".padStart(8)}`);
  console.log(`  ${"─".repeat(12)}─┼─${"─".repeat(10)}─┼─${"─".repeat(10)}─┼─${"─".repeat(6)}─┼─${"─".repeat(6)}─┼─${"─".repeat(6)}─┼─${"─".repeat(8)}`);

  let totalProfit = 0;
  let maxDDAll = 0;
  let totalFeesAll = 0;

  for (const r of results) {
    const emoji = r.pnlPct >= 0 ? "🟢" : "🔴";
    console.log(`  ${r.name.padEnd(12)} | ${(r.finalBalance.toFixed(2) + "€").padStart(10)} | ${emoji}${r.pnlEur >= 0 ? "+" : ""}${r.pnlEur.toFixed(2).padStart(7)}€ | ${(r.winRate + "%").padStart(6)} | ${String(r.totalTrades).padStart(6)} | ${(r.maxDD + "%").padStart(6)} | ${(r.totalFees + "€").padStart(8)}`);
    totalProfit += r.pnlPct;
    if (r.maxDD > maxDDAll) maxDDAll = r.maxDD;
    totalFeesAll += r.totalFees;
  }

  const avgProfit = (totalProfit / 10).toFixed(1);
  const winningPeriods = results.filter(r => r.pnlPct > 0).length;

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  STATISTIQUES GLOBALES");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  📊 Profit moyen: +${avgProfit}% par période`);
  console.log(`  🟢 Périodes gagnantes: ${winningPeriods}/10`);
  console.log(`  🔴 Périodes perdantes: ${10 - winningPeriods}/10`);
  console.log(`  🔻 Max DD observé: ${maxDDAll}%`);
  console.log(`  💸 Total frais: ${totalFeesAll.toFixed(2)}€`);
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
