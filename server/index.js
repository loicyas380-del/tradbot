import "dotenv/config";
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  RSI, MACD, BollingerBands, EMA, SMA, ATR, Stochastic,
} from "technicalindicators";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve built client in production
app.use(express.static(join(__dirname, "../client/dist")));

app.listen(PORT, () => console.log(`TradBot API on port ${PORT}`));

// ═══════════════════════════════════════════════════════════════
// BINANCE API
// ═══════════════════════════════════════════════════════════════
async function binanceTicker(symbols) {
  const res = await fetch("https://api.binance.com/api/v3/ticker/24hr", { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  const all = await res.json();
  const map = {};
  for (const t of all) map[t.symbol] = t;
  return symbols.map((s) => {
    const t = map[s.binance];
    if (!t) return null;
    return {
      symbol: s.id, name: s.name,
      price: parseFloat(t.lastPrice),
      change: parseFloat(t.priceChange),
      changePercent: parseFloat(t.priceChangePercent),
      volume: parseFloat(t.quoteVolume),
    };
  }).filter(Boolean);
}

async function binanceKlines(symbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Binance klines ${res.status}`);
  const raw = await res.json();
  return raw.map((k) => ({
    date: new Date(k[0]),
    open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── YAHOO FINANCE ──────────────────────────────────────────
const YF_H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0" };
async function yfChartFast(symbol, range, interval) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`, { headers: YF_H, signal: ctrl.signal });
    clearTimeout(t);
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
    return { data, meta: { price: r.meta?.regularMarketPrice, previousClose: r.meta?.chartPreviousClose } };
  } catch (err) { clearTimeout(t); throw err; }
}

// ─── SIMULATED DATA ─────────────────────────────────────────
function generateData(symbol, days, basePrice, vol) {
  const data = [];
  let price = basePrice;
  const now = new Date();
  for (let i = days; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const ch = (Math.random() - 0.48) * vol * price;
    const open = price;
    const close = price + ch;
    const high = Math.max(open, close) * (1 + Math.random() * vol * 0.3);
    const low = Math.min(open, close) * (1 - Math.random() * vol * 0.3);
    data.push({ date: new Date(d), open: +open.toFixed(2), high: +high.toFixed(2), low: +low.toFixed(2), close: +close.toFixed(2), volume: Math.floor(Math.random() * 50000000) + 5000000 });
    price = close;
  }
  return data;
}

const ASSETS = {
  // ── STOCKS ──
  "AAPL":  { name: "Apple",       base: 195,  vol: 0.015, type: "stock" },
  "MSFT":  { name: "Microsoft",   base: 420,  vol: 0.012, type: "stock" },
  "GOOGL": { name: "Alphabet",    base: 175,  vol: 0.014, type: "stock" },
  "AMZN":  { name: "Amazon",      base: 185,  vol: 0.016, type: "stock" },
  "TSLA":  { name: "Tesla",       base: 250,  vol: 0.025, type: "stock" },
  "NVDA":  { name: "NVIDIA",      base: 120,  vol: 0.022, type: "stock" },
  "META":  { name: "Meta",        base: 500,  vol: 0.018, type: "stock" },
  "NFLX":  { name: "Netflix",     base: 650,  vol: 0.02,  type: "stock" },
  "AMD":   { name: "AMD",         base: 160,  vol: 0.028, type: "stock" },
  "INTC":  { name: "Intel",       base: 30,   vol: 0.02,  type: "stock" },
  "BA":    { name: "Boeing",      base: 210,  vol: 0.022, type: "stock" },
  "DIS":   { name: "Disney",      base: 110,  vol: 0.018, type: "stock" },
  "PYPL":  { name: "PayPal",      base: 70,   vol: 0.025, type: "stock" },
  "UBER":  { name: "Uber",        base: 75,   vol: 0.024, type: "stock" },
  "SHOP":  { name: "Shopify",     base: 80,   vol: 0.03,  type: "stock" },
  "COIN":  { name: "Coinbase",    base: 230,  vol: 0.035, type: "stock" },
  "SQ":    { name: "Block",       base: 70,   vol: 0.028, type: "stock" },
  "SNAP":  { name: "Snap",        base: 15,   vol: 0.035, type: "stock" },
  "NIO":   { name: "NIO",         base: 5,    vol: 0.04,  type: "stock" },
  "PLTR":  { name: "Palantir",    base: 25,   vol: 0.035, type: "stock" },
  "CRWD":  { name: "CrowdStrike", base: 300,  vol: 0.025, type: "stock" },
  "NET":   { name: "Cloudflare",  base: 90,   vol: 0.025, type: "stock" },
  "ZM":    { name: "Zoom",        base: 75,   vol: 0.025, type: "stock" },
  "ABNB":  { name: "Airbnb",      base: 145,  vol: 0.025, type: "stock" },
  "RIVN":  { name: "Rivian",      base: 18,   vol: 0.04,  type: "stock" },
  // ── STOCKS VOLATILES (quick trades 1-2h) ──
  "GME":   { name: "GameStop",    base: 25,   vol: 0.06,  type: "stock_fast", maxHold: 120 },
  "AMC":   { name: "AMC",         base: 5,    vol: 0.07,  type: "stock_fast", maxHold: 120 },
  "MSTR":  { name: "MicroStrategy", base: 1800, vol: 0.05, type: "stock_fast", maxHold: 90 },
  "MARA":  { name: "Marathon",    base: 22,   vol: 0.055, type: "stock_fast", maxHold: 90 },
  "RIOT":  { name: "Riot Platforms", base: 11, vol: 0.055, type: "stock_fast", maxHold: 90 },
  "SOFI":  { name: "SoFi",        base: 8,    vol: 0.045, type: "stock_fast", maxHold: 120 },
  "HOOD":  { name: "Robinhood",   base: 22,   vol: 0.05,  type: "stock_fast", maxHold: 90 },
  "CVNA":  { name: "Carvana",     base: 130,  vol: 0.06,  type: "stock_fast", maxHold: 60 },
  "ROKU":  { name: "Roku",        base: 65,   vol: 0.045, type: "stock_fast", maxHold: 120 },
  "PLUG":  { name: "Plug Power",  base: 3,    vol: 0.07,  type: "stock_fast", maxHold: 120 },
  // ── CRYPTO (Binance) ──
  "BTC":   { name: "Bitcoin",     base: 62000, vol: 0.025, type: "crypto", binance: "BTCUSDT" },
  "ETH":   { name: "Ethereum",    base: 3400,  vol: 0.03,  type: "crypto", binance: "ETHUSDT" },
  "SOL":   { name: "Solana",      base: 150,   vol: 0.035, type: "crypto", binance: "SOLUSDT" },
  "BNB":   { name: "BNB",         base: 590,   vol: 0.02,  type: "crypto", binance: "BNBUSDT" },
  "XRP":   { name: "XRP",         base: 0.52,  vol: 0.03,  type: "crypto", binance: "XRPUSDT" },
  "DOGE":  { name: "Dogecoin",    base: 0.15,  vol: 0.04,  type: "crypto", binance: "DOGEUSDT" },
  "ADA":   { name: "Cardano",     base: 0.45,  vol: 0.035, type: "crypto", binance: "ADAUSDT" },
  "AVAX":  { name: "Avalanche",   base: 35,    vol: 0.035, type: "crypto", binance: "AVAXUSDT" },
  "DOT":   { name: "Polkadot",    base: 7,     vol: 0.035, type: "crypto", binance: "DOTUSDT" },
  "LINK":  { name: "Chainlink",   base: 14,    vol: 0.03,  type: "crypto", binance: "LINKUSDT" },
  "MATIC": { name: "Polygon",     base: 0.7,   vol: 0.035, type: "crypto", binance: "MATICUSDT" },
  "UNI":   { name: "Uniswap",     base: 7.5,   vol: 0.035, type: "crypto", binance: "UNIUSDT" },
  "ATOM":  { name: "Cosmos",      base: 8,     vol: 0.035, type: "crypto", binance: "ATOMUSDT" },
  "FIL":   { name: "Filecoin",    base: 5.5,   vol: 0.04,  type: "crypto", binance: "FILUSDT" },
  "APT":   { name: "Aptos",       base: 8,     vol: 0.04,  type: "crypto", binance: "APTUSDT" },
  "ARB":   { name: "Arbitrum",    base: 1.1,   vol: 0.04,  type: "crypto", binance: "ARBUSDT" },
  "OP":    { name: "Optimism",    base: 2.3,   vol: 0.04,  type: "crypto", binance: "OPUSDT" },
  "NEAR":  { name: "NEAR",        base: 5.5,   vol: 0.04,  type: "crypto", binance: "NEARUSDT" },
  "SUI":   { name: "Sui",         base: 3,     vol: 0.045, type: "crypto", binance: "SUIUSDT" },
  "SEI":   { name: "Sei",         base: 0.5,   vol: 0.05,  type: "crypto", binance: "SEIUSDT" },
  "PEPE":  { name: "Pepe",        base: 0.000012, vol: 0.06, type: "crypto", binance: "PEPEUSDT" },
  "WIF":   { name: "Dogwifhat",   base: 2.5,   vol: 0.05,  type: "crypto", binance: "WIFUSDT" },
  "INJ":   { name: "Injective",   base: 25,    vol: 0.04,  type: "crypto", binance: "INJUSDT" },
  "TIA":   { name: "Celestia",    base: 10,    vol: 0.045, type: "crypto", binance: "TIAUSDT" },
  "JUP":   { name: "Jupiter",     base: 1.2,   vol: 0.05,  type: "crypto", binance: "JUPUSDT" },
  "RENDER":{ name: "Render",      base: 8,     vol: 0.045, type: "crypto", binance: "RENDERUSDT" },
  "FET":   { name: "Fetch.ai",    base: 2.2,   vol: 0.05,  type: "crypto", binance: "FETUSDT" },
  "GALA":  { name: "Gala",        base: 0.04,  vol: 0.05,  type: "crypto", binance: "GALAUSDT" },
  "SAND":  { name: "Sandbox",     base: 0.5,   vol: 0.045, type: "crypto", binance: "SANDUSDT" },
  "MANA":  { name: "Decentraland",base: 0.5,   vol: 0.045, type: "crypto", binance: "MANAUSDT" },
  "CRV":   { name: "Curve",       base: 0.5,   vol: 0.045, type: "crypto", binance: "CRVUSDT" },
  "AAVE":  { name: "Aave",        base: 95,    vol: 0.035, type: "crypto", binance: "AAVEUSDT" },
  "MKR":   { name: "Maker",       base: 2800,  vol: 0.03,  type: "crypto", binance: "MKRUSDT" },
  "LTC":   { name: "Litecoin",    base: 85,    vol: 0.03,  type: "crypto", binance: "LTCUSDT" },
  "BCH":   { name: "Bitcoin Cash",base: 480,   vol: 0.03,  type: "crypto", binance: "BCHUSDT" },
  "ETC":   { name: "Ethereum Classic", base: 25, vol: 0.035, type: "crypto", binance: "ETCUSDT" },
};

function isStockMarketOpen() {
  const now = new Date();
  const etHour = parseInt(now.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }));
  const etMin = parseInt(now.toLocaleString("en-US", { timeZone: "America/New_York", minute: "numeric" }));
  const etDay = now.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short" });
  if (etDay === "Sat" || etDay === "Sun") return false;
  const mins = etHour * 60 + etMin;
  return mins >= 570 && mins < 960;
}

const rangeDays = { "1w": 7, "1mo": 30, "3mo": 90, "6mo": 180, "1y": 365, "2y": 730 };

// ═══════════════════════════════════════════════════════════════
// LIVE TRADING ENGINE
// ═══════════════════════════════════════════════════════════════
const MAX_POSITIONS = 20;
const MAX_CRYPTO = 7;
const MAX_STOCKS = 3;
const MAX_STOCK_FAST = 10;
const INITIAL_BALANCE = 1000;

const liveState = {
  balance: INITIAL_BALANCE,
  positions: {},    // { symbol: { side, entryPrice, entryTime, qty, cost, tp, sl } }
  tradeHistory: [], // all closed trades
  notifications: [], // recent notifications
  totalPnL: 0,
  wins: 0,
  losses: 0,
  currentPrices: {}, // { symbol: price } — cached from last trade check
};

function addNotification(type, title, message) {
  const notif = { id: Date.now(), type, title, message, time: new Date().toISOString() };
  liveState.notifications.unshift(notif);
  if (liveState.notifications.length > 100) liveState.notifications.pop();
  console.log(`[NOTIF] ${type}: ${title} - ${message}`);
}

function getPositionCount() {
  return Object.keys(liveState.positions).length;
}

function getCryptoCount() {
  return Object.keys(liveState.positions).filter(s => ASSETS[s]?.type === "crypto").length;
}

function getStockCount() {
  return Object.keys(liveState.positions).filter(s => ASSETS[s]?.type === "stock").length;
}

function getStockFastCount() {
  return Object.keys(liveState.positions).filter(s => ASSETS[s]?.type === "stock_fast").length;
}

// ─── INDICATORS ─────────────────────────────────────────────
function getVal(arr, idx) { return idx >= 0 && idx < arr.length ? arr[idx] : undefined; }

function computeIndicators(rawData) {
  const closes = rawData.map((d) => d.close);
  const highs = rawData.map((d) => d.high);
  const lows = rawData.map((d) => d.low);
  const volumes = rawData.map((d) => d.volume);
  const len = closes.length;
  return {
    closes, highs, lows, volumes, len,
    rsi: RSI.calculate({ values: closes, period: 14 }),
    macd: MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false }),
    bb: BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 }),
    ema20: EMA.calculate({ values: closes, period: 20 }),
    ema50: EMA.calculate({ values: closes, period: 50 }),
    sma200: SMA.calculate({ values: closes, period: 200 }),
    atr: ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }),
    stoch: Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 }),
    volSma20: SMA.calculate({ values: volumes, period: 20 }),
  };
}

function analyzeDay(ana, i) {
  const { closes, volumes, rsi, macd, bb, ema20, ema50, sma200, atr, stoch, volSma20, len } = ana;
  const price = closes[i];
  const rI = i - (len - rsi.length);
  const mI = i - (len - macd.length);
  const bI = i - (len - bb.length);
  const e20I = i - (len - ema20.length);
  const e50I = i - (len - ema50.length);
  const s200I = i - (len - sma200.length);
  const aI = i - (len - atr.length);
  const sI = i - (len - stoch.length);
  const vI = i - (len - volSma20.length);

  const rsiVal = getVal(rsi, rI);
  const macdCurr = getVal(macd, mI);
  const macdPrev = getVal(macd, mI - 1);
  const bbVal = getVal(bb, bI);
  const ema20Val = getVal(ema20, e20I);
  const ema50Val = getVal(ema50, e50I);
  const sma200Val = getVal(sma200, s200I);
  const atrVal = getVal(atr, aI);
  const stochVal = getVal(stoch, sI);

  if (rsiVal == null || !macdCurr || !bbVal || !ema20Val || !ema50Val || !atrVal || !stochVal) return null;

  const uptrend = ema20Val > ema50Val && (sma200Val == null || price > sma200Val);
  const downtrend = ema20Val < ema50Val && (sma200Val == null || price < sma200Val);
  const bbPct = (price - bbVal.lower) / (bbVal.upper - bbVal.lower);

  // LONG
  let longScore = 0, longReasons = [];
  if (uptrend) {
    longScore += 2; longReasons.push("Uptrend");
    if (rsiVal < 35) { longScore += 3; longReasons.push("RSI oversold"); }
    else if (rsiVal < 42) { longScore += 1; longReasons.push("RSI low"); }
    if (macdPrev && macdCurr) {
      if (macdPrev.MACD < macdPrev.signal && macdCurr.MACD > macdCurr.signal) { longScore += 3; longReasons.push("MACD cross up"); }
      else if (macdCurr.histogram > 0 && macdPrev.histogram <= 0) { longScore += 2; longReasons.push("MACD flip"); }
    }
    if (bbPct < 0.15) { longScore += 2; longReasons.push("BB lower"); }
    else if (bbPct < 0.3) { longScore += 1; longReasons.push("BB low zone"); }
    if (stochVal.k < 25) { longScore += 1; longReasons.push("Stoch low"); }
  }

  // SHORT
  let shortScore = 0, shortReasons = [];
  if (downtrend) {
    shortScore += 2; shortReasons.push("Downtrend");
    if (rsiVal > 65) { shortScore += 3; shortReasons.push("RSI overbought"); }
    else if (rsiVal > 58) { shortScore += 1; shortReasons.push("RSI high"); }
    if (macdPrev && macdCurr) {
      if (macdPrev.MACD > macdPrev.signal && macdCurr.MACD < macdCurr.signal) { shortScore += 3; shortReasons.push("MACD cross down"); }
      else if (macdCurr.histogram < 0 && macdPrev.histogram >= 0) { shortScore += 2; shortReasons.push("MACD flip down"); }
    }
    if (bbPct > 0.85) { shortScore += 2; shortReasons.push("BB upper"); }
    else if (bbPct > 0.7) { shortScore += 1; shortReasons.push("BB high zone"); }
    if (stochVal.k > 75) { shortScore += 1; shortReasons.push("Stoch high"); }
  } else if (rsiVal > 75 && bbPct > 0.9) {
    shortScore += 4; shortReasons.push("Counter-trend overbought");
  }

const tp = +(price + atrVal * 2).toFixed(4);
  const sl = +(price - atrVal * 2).toFixed(4);
  const shortTp = +(price - atrVal * 2).toFixed(4);
  const shortSl = +(price + atrVal * 2).toFixed(4);

  return { longScore, shortScore, longReasons, shortReasons, atr: atrVal, tp, sl, shortTp, shortSl, price };
}

// ─── LIVE TRADE CHECK (runs every 30s) ─────────────────────
async function liveTradeCheck() {
  const symbols = Object.keys(ASSETS);

  for (const sym of symbols) {
    try {
      const asset = ASSETS[sym];
      let rawData;
      if (asset?.type === "crypto" && asset.binance) {
        const yfSym = sym + "-USD";
        try { rawData = (await yfChartFast(yfSym, "3mo", "1d")).data; }
        catch { continue; }
      } else {
        try { rawData = (await yfChartFast(sym, "3mo", "1d")).data; }
        catch { continue; }
      }
      if (!rawData || rawData.length < 50) continue;

      const ana = computeIndicators(rawData);
      const result = analyzeDay(ana, ana.len - 1);
      const currentPrice = result ? result.price : rawData[rawData.length - 1].close;
      liveState.currentPrices[sym] = currentPrice;
      if (!result) continue;
      if (asset?.type === "crypto") console.log(`[SCORE] ${sym}: long=${result.longScore} short=${result.shortScore} (${[...result.longReasons, ...result.shortReasons].join(", ") || "no signals"})`);

      const pos = liveState.positions[sym];

      // ── EXIT CHECK ──
      if (pos) {
        let shouldExit = false;
        let exitPrice = currentPrice;
        let exitReason = "SIGNAL";

        const holdMinutes = (Date.now() - new Date(pos.entryTime).getTime()) / 60000;
        const maxHold = asset?.maxHold || 9999;
        if (holdMinutes >= maxHold) { shouldExit = true; exitReason = "TIME"; }

        if (pos.side === "LONG") {
          if (currentPrice <= pos.sl) { shouldExit = true; exitPrice = pos.sl; exitReason = "SL"; }
          else if (currentPrice >= pos.tp) { shouldExit = true; exitPrice = pos.tp; exitReason = "TP"; }
          else if (result.shortScore >= 2) { shouldExit = true; exitReason = "REVERSE"; }
        } else {
          if (currentPrice >= pos.sl) { shouldExit = true; exitPrice = pos.sl; exitReason = "SL"; }
          else if (currentPrice <= pos.tp) { shouldExit = true; exitPrice = pos.tp; exitReason = "TP"; }
          else if (result.longScore >= 2) { shouldExit = true; exitReason = "REVERSE"; }
        }

        if (shouldExit) {
          let pnl, pct;
          if (pos.side === "LONG") {
            pnl = pos.qty * (exitPrice - pos.entryPrice);
            pct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
          } else {
            pnl = pos.qty * (pos.entryPrice - exitPrice);
            pct = ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100;
          }
          liveState.balance += pos.cost + pnl;
          liveState.totalPnL += pnl;
          if (pnl > 0) liveState.wins++; else liveState.losses++;

          const trade = {
            id: Date.now(), symbol: sym, side: pos.side, exitReason,
            entryPrice: pos.entryPrice, exitPrice, qty: pos.qty,
            entryTime: pos.entryTime, exitTime: new Date().toISOString(),
            pnl: +pnl.toFixed(4), pnlPercent: +pct.toFixed(2),
            holdMinutes: Math.round((Date.now() - new Date(pos.entryTime).getTime()) / 60000),
          };
          liveState.tradeHistory.unshift(trade);
          delete liveState.positions[sym];

          const emoji = pnl >= 0 ? "✅" : "❌";
          const sideLabel = pos.side === "LONG" ? "LONG" : "SHORT";
          addNotification(
            pnl >= 0 ? "success" : "error",
            `${emoji} FERMETURE ${sideLabel} ${sym}`,
            `${exitReason} @ $${exitPrice.toFixed(2)} | PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`
          );
        }
      }

      // ── ENTRY CHECK ──
      const isCrypto = asset?.type === "crypto";
      const isStock = asset?.type === "stock";
      const isFast = asset?.type === "stock_fast";
      const atMax = getPositionCount() >= MAX_POSITIONS;
      const cryptoLimit = isCrypto && getCryptoCount() >= MAX_CRYPTO;
      const stockLimit = isStock && getStockCount() >= MAX_STOCKS;
      const fastLimit = isFast && getStockFastCount() >= MAX_STOCK_FAST;
      const marketClosed = (isStock || isFast) && !isStockMarketOpen();

      if (!pos && !atMax && !cryptoLimit && !stockLimit && !fastLimit && !marketClosed) {
        if (result.longScore >= 2 && liveState.balance > 5) {
          const spend = liveState.balance * 0.07;
          const qty = +(spend / currentPrice).toFixed(8);
          const cost = qty * currentPrice;

          let tpFinal, slFinal;
          if (isFast) { tpFinal = +(price + atrVal * 1.5).toFixed(4); slFinal = +(price - atrVal * 1.5).toFixed(4); }
          else if (isStock) { tpFinal = +(price + atrVal * 4).toFixed(4); slFinal = +(price - atrVal * 3).toFixed(4); }
          else { tpFinal = result.tp; slFinal = result.sl; }

          liveState.positions[sym] = {
            side: "LONG", entryTime: new Date().toISOString(),
            entryPrice: currentPrice, qty, cost,
            tp: tpFinal, sl: slFinal,
          };
          liveState.balance -= cost;

          const tag = isCrypto ? "₿" : isFast ? "⚡" : "📊";
          addNotification("info", `${tag} LONG ${sym}`, `Acheté $${currentPrice.toFixed(2)} | Qty: ${qty} | TP: $${tpFinal} | SL: $${slFinal} | Score: ${result.longScore}`);
        } else if (result.shortScore >= 2 && liveState.balance > 5) {
          const spend = liveState.balance * 0.07;
          const qty = +(spend / currentPrice).toFixed(8);
          const cost = qty * currentPrice;

          let shortTpFinal, shortSlFinal;
          if (isFast) { shortTpFinal = +(price - atrVal * 1.5).toFixed(4); shortSlFinal = +(price + atrVal * 1.5).toFixed(4); }
          else if (isStock) { shortTpFinal = +(price - atrVal * 4).toFixed(4); shortSlFinal = +(price + atrVal * 3).toFixed(4); }
          else { shortTpFinal = result.shortTp; shortSlFinal = result.shortSl; }

          liveState.positions[sym] = {
            side: "SHORT", entryTime: new Date().toISOString(),
            entryPrice: currentPrice, qty, cost,
            tp: shortTpFinal, sl: shortSlFinal,
          };
          liveState.balance -= cost;

          const tag = isCrypto ? "₿" : isFast ? "⚡" : "📊";
          addNotification("info", `${tag} SHORT ${sym}`, `Vendu $${currentPrice.toFixed(2)} | Qty: ${qty} | TP: $${shortTpFinal} | SL: $${shortSlFinal} | Score: ${result.shortScore}`);
        }
      }
    } catch (err) {
      console.log(`[SKIP] ${sym}: ${err.message}`);
    }
  }
  console.log(`[CYCLE] Positions: ${getPositionCount()}/${MAX_POSITIONS} | Crypto: ${getCryptoCount()}/${MAX_CRYPTO} | Stock: ${getStockCount()}/${MAX_STOCKS} | Balance: €${liveState.balance.toFixed(2)}`);
}

// Start live trading engine — check every 10 seconds
setInterval(liveTradeCheck, 10000);
setTimeout(liveTradeCheck, 3000); // first check after 3s

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════

app.get("/api/markets", async (req, res) => {
  try {
    const cryptoIds = Object.entries(ASSETS).filter(([, a]) => a.type === "crypto");
    const stockIds = Object.entries(ASSETS).filter(([, a]) => a.type === "stock");
    let cryptoResults = [];
    try {
      cryptoResults = await Promise.all(
        cryptoIds.map(async ([id, a]) => {
          const r = await yfChartFast(id + "-USD", "1d", "1d");
          const price = r.meta?.price || a.base;
          const prev = r.meta?.previousClose || a.base;
          return { symbol: id, name: a.name, price: +price.toFixed(2), change: +(price - prev).toFixed(2), changePercent: +(((price - prev) / prev) * 100).toFixed(2) };
        })
      );
    } catch {
      cryptoResults = cryptoIds.map(([id, a]) => ({
        symbol: id, name: a.name, price: a.base,
        change: +(a.base * (Math.random() - 0.5) * 0.02).toFixed(2),
        changePercent: +((Math.random() - 0.5) * 4).toFixed(2),
      }));
    }
    const stockResults = await Promise.allSettled(
      stockIds.map(async ([id, a]) => {
        try {
          const r = await yfChartFast(id, "1d", "1d");
          const price = r.meta?.price || a.base;
          const prev = r.meta?.previousClose || a.base;
          return { symbol: id, name: a.name, price: +price.toFixed(2), change: +(price - prev).toFixed(2), changePercent: +(((price - prev) / prev) * 100).toFixed(2), volume: 0 };
        } catch {
          return { symbol: id, name: a.name, price: a.base, change: 0, changePercent: 0, volume: 0 };
        }
      })
    );
    res.json([...cryptoResults, ...stockResults.filter((r) => r.status === "fulfilled").map((r) => r.value)]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/chart/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const { range = "3mo" } = req.query;
    const asset = ASSETS[symbol];
    let rawData;
    if (asset?.type === "crypto" && asset.binance) {
      try { rawData = await binanceKlines(asset.binance, "1d", rangeDays[range] || 90); }
      catch { rawData = generateData(symbol, rangeDays[range] || 90, asset.base, asset.vol); }
    } else {
      try { rawData = (await yfChartFast(symbol, range, "1d")).data; }
      catch { rawData = generateData(symbol, rangeDays[range] || 90, asset?.base || 100, asset?.vol || 0.02); }
    }
    if (!rawData || rawData.length === 0) return res.status(404).json({ error: "No data" });
    const closes = rawData.map((d) => d.close);
    const highs = rawData.map((d) => d.high);
    const lows = rawData.map((d) => d.low);
    const rsi = RSI.calculate({ values: closes, period: 14 });
    const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
    const bb = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
    const ema20 = EMA.calculate({ values: closes, period: 20 });
    const ema50 = EMA.calculate({ values: closes, period: 50 });
    const sma200 = SMA.calculate({ values: closes, period: 200 });
    const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const stoch = Stochastic.calculate({ high: highs, low: lows, close: closes, period: 14, signalPeriod: 3 });
    const len = rawData.length;
    res.json({
      symbol, interval: "1d", range,
      data: rawData.map((d, i) => ({
        time: d.date.toISOString().split("T")[0],
        open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume,
        rsi: rsi[i - (len - rsi.length)] ?? null,
        macd: macd[i - (len - macd.length)] ?? null,
        bb: bb[i - (len - bb.length)] ?? null,
        ema20: ema20[i - (len - ema20.length)] ?? null,
        ema50: ema50[i - (len - ema50.length)] ?? null,
        sma200: sma200[i - (len - sma200.length)] ?? null,
        atr: atr[i - (len - atr.length)] ?? null,
        stoch: stoch[i - (len - stoch.length)] ?? null,
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── LIVE STATE ─────────────────────────────────────────────
app.get("/api/live", (req, res) => {
  const positionCount = getPositionCount();
  const openTrades = Object.entries(liveState.positions).map(([sym, p]) => {
    const currentPrice = liveState.currentPrices[sym] || p.entryPrice;
    let unrealizedPnl = 0, unrealizedPnlPercent = 0;
    if (p.side === "LONG") {
      unrealizedPnl = p.qty * (currentPrice - p.entryPrice);
      unrealizedPnlPercent = ((currentPrice - p.entryPrice) / p.entryPrice) * 100;
    } else {
      unrealizedPnl = p.qty * (p.entryPrice - currentPrice);
      unrealizedPnlPercent = ((p.entryPrice - currentPrice) / p.entryPrice) * 100;
    }
    return {
      symbol: sym,
      name: ASSETS[sym]?.name || sym,
      side: p.side,
      entryPrice: p.entryPrice,
      currentPrice: +currentPrice.toFixed(4),
      entryTime: p.entryTime,
      qty: p.qty,
      tp: p.tp,
      sl: p.sl,
      cost: p.cost,
      unrealizedPnl: +unrealizedPnl.toFixed(4),
      unrealizedPnlPercent: +unrealizedPnlPercent.toFixed(2),
    };
  });

  const totalTrades = liveState.wins + liveState.losses;
  const winRate = totalTrades > 0 ? +((liveState.wins / totalTrades) * 100).toFixed(1) : 0;

  res.json({
    balance: +liveState.balance.toFixed(2),
    initialBalance: INITIAL_BALANCE,
    totalPnL: +liveState.totalPnL.toFixed(2),
    totalPnLPercent: +((liveState.totalPnL / INITIAL_BALANCE) * 100).toFixed(2),
    wins: liveState.wins,
    losses: liveState.losses,
    winRate,
    totalTrades,
    strike: `${liveState.wins}W/${liveState.losses}L`,
    positionCount,
    maxPositions: MAX_POSITIONS,
    openTrades,
    tradeHistory: liveState.tradeHistory.slice(0, 50),
    notifications: liveState.notifications.slice(0, 30),
  });
});

// ─── NOTIFICATIONS (polling) ────────────────────────────────
let lastNotifId = 0;
app.get("/api/notifications", (req, res) => {
  const since = parseInt(req.query.since || "0");
  const newNotifs = liveState.notifications.filter((n) => n.id > since);
  lastNotifId = Math.max(lastNotifId, ...liveState.notifications.map((n) => n.id), 0);
  res.json({ notifications: newNotifs, latestId: lastNotifId });
});

// ─── RESET ──────────────────────────────────────────────────
app.post("/api/reset", (req, res) => {
  liveState.balance = INITIAL_BALANCE;
  liveState.positions = {};
  liveState.tradeHistory = [];
  liveState.notifications = [];
  liveState.totalPnL = 0;
  liveState.wins = 0;
  liveState.losses = 0;
  addNotification("info", "🔄 RESET", "Compte réinitialisé à €1000");
  res.json({ ok: true });
});

// ─── MANUAL CHECK ───────────────────────────────────────────
app.post("/api/live/check", async (req, res) => {
  try {
    await liveTradeCheck();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── AI REPORTS ─────────────────────────────────────────────
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || "";
const aiReports = [];

app.get("/api/ai/reports", (req, res) => { res.json({ reports: aiReports }); });

app.post("/api/ai/generate", async (req, res) => {
  try {
    const live = {
      balance: liveState.balance,
      totalPnL: liveState.totalPnL,
      wins: liveState.wins,
      losses: liveState.losses,
      positions: Object.entries(liveState.positions).map(([s, p]) => ({
        symbol: s, side: p.side, entryPrice: p.entryPrice, tp: p.tp, sl: p.sl,
      })),
      recentTrades: liveState.tradeHistory.slice(0, 10),
    };
    const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3000",
      },
      body: JSON.stringify({
        model: "openrouter/free",
        messages: [
          { role: "system", content: "Tu es un analyste financier. Rapport court en français. Emojis. Max 200 mots. Markdown." },
          { role: "user", content: `État live du bot:\n${JSON.stringify(live, null, 2)}\n\nFais un résumé rapide.` },
        ],
        max_tokens: 500,
      }),
    });
    const data = await aiRes.json();
    const content = data.choices?.[0]?.message?.content || "Erreur";
    const report = { id: Date.now(), time: new Date().toISOString(), content };
    aiReports.unshift(report);
    if (aiReports.length > 30) aiReports.pop();
    res.json(report);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SPA catch-all — serve index.html for any non-API route
app.get("*", (req, res) => {
  res.sendFile(join(__dirname, "../client/dist/index.html"));
});
