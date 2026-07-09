import "dotenv/config";
import { RSI, EMA, SMA, ATR } from "technicalindicators";

const OLLAMA_URL = "http://localhost:11434/api/generate";
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
  const volumes = rawData.map(d => d.volume);
  return {
    closes, highs, lows, volumes, len: closes.length,
    rsi: RSI.calculate({ values: closes, period: 14 }),
    ema5: EMA.calculate({ values: closes, period: 5 }),
    ema20: EMA.calculate({ values: closes, period: 20 }),
    atr: ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }),
    sma20: SMA.calculate({ values: closes, period: 20 }),
    volumeSma: SMA.calculate({ values: volumes, period: 20 }),
  };
}

function analyze(ana, idx) {
  const { closes, rsi, ema5, ema20, atr, sma20, volumeSma, volumes } = ana;
  if (idx < 20) return null;
  const price = closes[idx];
  const prevPrice = closes[idx - 1];
  const rsiVal = getVal(rsi, idx - (ana.len - rsi.length));
  const ema5Val = getVal(ema5, idx - (ana.len - ema5.length));
  const ema20Val = getVal(ema20, idx - (ana.len - ema20.length));
  const atrVal = getVal(atr, idx - (ana.len - atr.length));
  const sma20Val = getVal(sma20, idx - (ana.len - sma20.length));
  const volSmaVal = getVal(volumeSma, idx - (ana.len - volumeSma.length));
  const volVal = getVal(volumes, idx);
  if (!rsiVal || !ema5Val || !ema20Val || !atrVal || !sma20Val || !volSmaVal || !volVal) return null;

  const isBouncing = price > prevPrice;
  const isFalling = price < prevPrice;
  const volumeOK = volVal > volSmaVal * 0.8;
  const slDistance = atrVal * 1.5;
  const tpDistance = atrVal * 3;

  if (rsiVal < 35 && isBouncing && price > ema5Val && volumeOK) {
    return { side: "LONG", entry: price, sl: price - slDistance, tp: price + tpDistance, rr: (tpDistance / slDistance).toFixed(2), rsi: rsiVal, atr: atrVal };
  }
  if (rsiVal > 65 && isFalling && price < ema5Val && volumeOK) {
    return { side: "SHORT", entry: price, sl: price + slDistance, tp: price - tpDistance, rr: (tpDistance / slDistance).toFixed(2), rsi: rsiVal, atr: atrVal };
  }
  return null;
}

async function askLocalAI(signal, recentPrices) {
  try {
    const trend = recentPrices[recentPrices.length - 1] > recentPrices[0] ? "UPTREND" : "DOWNTREND";
    const momentum = ((recentPrices[recentPrices.length - 1] - recentPrices[0]) / recentPrices[0] * 100).toFixed(2);
    
    const prompt = `You are a professional trader. Analyze this trade and give confidence 0-100.

Signal: ${signal.side} at ${signal.entry.toFixed(2)}
RSI: ${signal.rsi.toFixed(1)} (oversold=${signal.rsi < 35}, overbought=${signal.rsi > 65})
Risk/Reward: ${signal.rr}
Recent prices: ${recentPrices.join(', ')}
Trend: ${trend} (${momentum}% change)

 Rules:
- RSI < 35 + UPTREND + bounce = HIGH confidence (70-90)
- RSI > 65 + DOWNTREND + fall = HIGH confidence (70-90)
- RSI near 50 = LOW confidence (20-40)
- Against trend = LOW confidence (10-30)

Reply with ONLY a number 0-100:`;

    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llama3.1", prompt, stream: false, options: { temperature: 0.1, num_predict: 5 } }),
      signal: AbortSignal.timeout(30000)
    });

    if (!res.ok) return 50;
    const data = await res.json();
    const text = (data.response || "").replace(/[^0-9]/g, "");
    const num = parseInt(text);
    return isNaN(num) ? 50 : Math.min(100, Math.max(0, num));
  } catch (err) {
    return 50;
  }
}

function buildContext(rawData, idx) {
  const start = Math.max(0, idx - 5);
  return rawData.slice(start, idx + 1).map(d => d.close.toFixed(2));
}

async function backtest(sym, rawData, capital, useAI) {
  if (!rawData || rawData.length < 20) return null;
  const ana = computeIndicators(rawData);
  let cash = capital, peak = capital, maxDrawdown = 0;
  let wins = 0, losses = 0, totalFees = 0, totalTrades = 0;
  let cooldown = 0, positions = [];
  let aiAccepted = 0, aiRejected = 0;

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
        if (cash > peak) peak = cash;
        const dd2 = (peak - cash) / peak;
        if (dd2 > maxDrawdown) maxDrawdown = dd2;
      }
    }

    if (positions.length === 0) {
      const signal = analyze(ana, i);
      if (signal) {
        if (useAI) {
          const prices = buildContext(rawData, i);
          const confidence = await askLocalAI(signal, prices);
          if (confidence < 60) { aiRejected++; continue; }
          aiAccepted++;
        }
        const maxCost = cash * 0.30;
        const qty = maxCost / signal.entry;
        const cost = qty * signal.entry;
        if (cost <= cash * 0.35) {
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
  return { totalTrades, wins, losses, winRate: +winRate, pnlPct: +pnlPct, finalBalance: cash, maxDrawdown: +(maxDrawdown * 100).toFixed(1), aiAccepted, aiRejected };
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
  console.log("  BACKTEST AVEC IA LOCALE (Ollama + Llama 3.1)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const capital = 250;
  const noAIResults = [];
  const withAIResults = [];

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

    const allData = {};
    for (const asset of ASSETS) {
      try {
        allData[asset.sym] = await yfChart(asset.sym, test.start, test.end, "1d");
        await new Promise(r => setTimeout(r, 200));
      } catch (err) {}
    }

    let noAIBalance = capital, withAIBalance = capital;
    let noAIWins = 0, noAILosses = 0, noAIDD = 0;
    let withAIWins = 0, withAILosses = 0, withAIDD = 0;
    let totalAIAccepted = 0, totalAIRejected = 0;

    for (const asset of ASSETS) {
      if (!allData[asset.sym]) continue;

      const noAI = await backtest(asset.sym, allData[asset.sym], noAIBalance, false);
      if (noAI && noAI.totalTrades > 0) {
        noAIWins += noAI.wins;
        noAILosses += noAI.losses;
        if (noAI.maxDrawdown > noAIDD) noAIDD = noAI.maxDrawdown;
        noAIBalance = noAI.finalBalance;
      }

      const withAI = await backtest(asset.sym, allData[asset.sym], withAIBalance, true);
      if (withAI && withAI.totalTrades > 0) {
        withAIWins += withAI.wins;
        withAILosses += withAI.losses;
        if (withAI.maxDrawdown > withAIDD) withAIDD = withAI.maxDrawdown;
        withAIBalance = withAI.finalBalance;
        totalAIAccepted += withAI.aiAccepted;
        totalAIRejected += withAI.aiRejected;
      }
    }

    const noAITrades = noAIWins + noAILosses;
    const noAIWR = noAITrades > 0 ? ((noAIWins / noAITrades) * 100).toFixed(1) : 0;
    const noAIPnl = ((noAIBalance - capital) / capital * 100).toFixed(1);

    const withAITrades = withAIWins + withAILosses;
    const withAIWR = withAITrades > 0 ? ((withAIWins / withAITrades) * 100).toFixed(1) : 0;
    const withAIPnl = ((withAIBalance - capital) / capital * 100).toFixed(1);

    noAIResults.push({ test: test.label, pnlPct: +noAIPnl, trades: noAITrades, winRate: +noAIWR, dd: noAIDD, final: noAIBalance });
    withAIResults.push({ test: test.label, pnlPct: +withAIPnl, trades: withAITrades, winRate: +withAIWR, dd: withAIDD, final: withAIBalance, accepted: totalAIAccepted, rejected: totalAIRejected });

    const noE = +noAIPnl >= 0 ? "🟢" : "🔴";
    const aiE = +withAIPnl >= 0 ? "🟢" : "🔴";
    console.log(`  ${noE} SANS IA: ${capital}€ → ${noAIBalance.toFixed(2)}€ (${noAIPnl >= 0 ? '+' : ''}${noAIPnl}%) | ${noAITrades} trades | ${noAIWR}% WR | DD: ${noAIDD}%`);
    console.log(`  ${aiE} AVEC IA: ${capital}€ → ${withAIBalance.toFixed(2)}€ (${withAIPnl >= 0 ? '+' : ''}${withAIPnl}%) | ${withAITrades} trades | ${withAIWR}% WR | DD: ${withAIDD}%`);
    console.log(`  🤖 IA: ${totalAIAccepted} acceptés, ${totalAIRejected} rejetés`);
  }

  console.log("\n\n═══════════════════════════════════════════════════════════════");
  console.log("  RÉSUMÉ — SANS IA vs AVEC IA LOCALE");
  console.log("═══════════════════════════════════════════════════════════════\n");
  console.log("  Test | SANS IA         | AVEC IA         | Différence");
  console.log("  -----|-----------------|-----------------|----------");
  for (let i = 0; i < noAIResults.length; i++) {
    const no = noAIResults[i];
    const ai = withAIResults[i];
    const diff = (ai.pnlPct - no.pnlPct).toFixed(1);
    const diffEmoji = +diff >= 0 ? "🟢" : "🔴";
    console.log(`  ${String(no.test).padEnd(4)} | ${(no.final.toFixed(2) + '€ (' + (no.pnlPct >= 0 ? '+' : '') + no.pnlPct + '%)').padEnd(16)} | ${(ai.final.toFixed(2) + '€ (' + (ai.pnlPct >= 0 ? '+' : '') + ai.pnlPct + '%)').padEnd(16)} | ${diffEmoji} ${diff >= 0 ? '+' : ''}${diff}%`);
  }

  const noAIAvg = noAIResults.reduce((a, b) => a + b.pnlPct, 0) / noAIResults.length;
  const withAIAvg = withAIResults.reduce((a, b) => a + b.pnlPct, 0) / withAIResults.length;
  const avgDiff = (withAIAvg - noAIAvg).toFixed(1);

  console.log(`\n  📊 MOYENNES:`);
  console.log(`  ├─ Sans IA: ${noAIAvg >= 0 ? '+' : ''}${noAIAvg.toFixed(1)}%`);
  console.log(`  ├─ Avec IA: ${withAIAvg >= 0 ? '+' : ''}${withAIAvg.toFixed(1)}%`);
  console.log(`  └─ Différence: ${+avgDiff >= 0 ? '+' : ''}${avgDiff}%`);
  console.log(`\n  💡 PROJECTIONS (250€, 1 an):`);
  console.log(`  ├─ Sans IA: 250€ → ${(250 * Math.pow(1 + noAIAvg/100, 12)).toFixed(0)}€`);
  console.log(`  ├─ Avec IA: 250€ → ${(250 * Math.pow(1 + withAIAvg/100, 12)).toFixed(0)}€`);
  console.log(`\n═══════════════════════════════════════════════════════════════\n`);
}

main().catch(console.error);
