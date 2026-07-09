import "dotenv/config";
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  RSI, MACD, BollingerBands, EMA, SMA, ATR, Stochastic, ADX,
} from "technicalindicators";
import Stripe from "stripe";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// ─── STRIPE ──────────────────────────────────────────────────
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// ─── ALPACA ──────────────────────────────────────────────────
let alpaca = null;
if (process.env.ALPACA_KEY_ID && process.env.ALPACA_SECRET_KEY) {
  const Alpaca = (await import("@alpacahq/alpaca-trade-api")).default;
  alpaca = new Alpaca({
    keyId: process.env.ALPACA_KEY_ID,
    secretKey: process.env.ALPACA_SECRET_KEY,
    paper: process.env.ALPACA_PAPER !== "false",
    baseUrl: process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets",
    dataBaseUrl: "https://data.alpaca.markets",
  });
  console.log(`[ALPACA] Connected (${process.env.ALPACA_PAPER !== "false" ? "PAPER" : "LIVE"} mode)`);
} else {
  console.log("[ALPACA] Not configured (no API keys)");
}

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
  // ═══ CRYPTO MAJEURS ═══
  "BTC":   { name: "Bitcoin",     base: 62000,  vol: 0.025, type: "crypto", yfSym: "BTC-USD" },
  "ETH":   { name: "Ethereum",    base: 3400,   vol: 0.03, type: "crypto", yfSym: "ETH-USD" },
  "SOL":   { name: "Solana",      base: 150,    vol: 0.035, type: "crypto", yfSym: "SOL-USD" },
  "XRP":   { name: "XRP",         base: 0.52,   vol: 0.03, type: "crypto", yfSym: "XRP-USD" },
  "ADA":   { name: "Cardano",     base: 0.45,   vol: 0.035, type: "crypto", yfSym: "ADA-USD" },
  "DOGE":  { name: "Dogecoin",    base: 0.15,   vol: 0.04, type: "crypto", yfSym: "DOGE-USD" },
  "AVAX":  { name: "Avalanche",   base: 35,     vol: 0.04, type: "crypto", yfSym: "AVAX-USD" },
  "DOT":   { name: "Polkadot",    base: 7,      vol: 0.04, type: "crypto", yfSym: "DOT-USD" },
  "LINK":  { name: "Chainlink",   base: 14,     vol: 0.03, type: "crypto", yfSym: "LINK-USD" },
  "LTC":   { name: "Litecoin",    base: 85,     vol: 0.03, type: "crypto", yfSym: "LTC-USD" },
  "ATOM":  { name: "Cosmos",      base: 8,      vol: 0.04, type: "crypto", yfSym: "ATOM-USD" },
  "FIL":   { name: "Filecoin",    base: 5.5,    vol: 0.045, type: "crypto", yfSym: "FIL-USD" },
  "NEAR":  { name: "NEAR",        base: 5.5,    vol: 0.045, type: "crypto", yfSym: "NEAR-USD" },
  "ARB":   { name: "Arbitrum",    base: 1.1,    vol: 0.045, type: "crypto", yfSym: "ARB-USD" },
  "OP":    { name: "Optimism",    base: 2.3,    vol: 0.045, type: "crypto", yfSym: "OP-USD" },
  "SUI":   { name: "Sui",         base: 1.5,    vol: 0.05, type: "crypto", yfSym: "SUI-USD" },
  "SEI":   { name: "Sei",         base: 0.5,    vol: 0.055, type: "crypto", yfSym: "SEI-USD" },
  "INJ":   { name: "Injective",   base: 25,     vol: 0.05, type: "crypto", yfSym: "INJ-USD" },
  "FET":   { name: "Fetch.ai",    base: 2.2,    vol: 0.05, type: "crypto", yfSym: "FET-USD" },
  "RENDER":{ name: "Render",      base: 8,      vol: 0.045, type: "crypto", yfSym: "RENDER-USD" },
  "TIA":   { name: "Celestia",    base: 10,     vol: 0.05, type: "crypto", yfSym: "TIA-USD" },
  "WLD":   { name: "Worldcoin",   base: 2,      vol: 0.07, type: "crypto", yfSym: "WLD-USD" },
  "ONDO":  { name: "Ondo",        base: 1.2,    vol: 0.05, type: "crypto", yfSym: "ONDO-USD" },
  "SHIB":  { name: "Shiba Inu",   base: 0.000025, vol: 0.06, type: "crypto", yfSym: "SHIB-USD" },
  "BONK":  { name: "Bonk",        base: 0.00002, vol: 0.07, type: "crypto", yfSym: "BONK-USD" },
  // ═══ CRYPTO DEFI ═══
  "ENA":   { name: "Ethena",      base: 0.8,    vol: 0.06, type: "crypto", yfSym: "ENA-USD" },
  "AAVE":  { name: "Aave",        base: 100,    vol: 0.04, type: "crypto", yfSym: "AAVE-USD" },
  "MKR":   { name: "Maker",       base: 1500,   vol: 0.035, type: "crypto", yfSym: "MKR-USD" },
  "CRV":   { name: "Curve",       base: 0.5,    vol: 0.05, type: "crypto", yfSym: "CRV-USD" },
  "LDO":   { name: "Lido",        base: 2,      vol: 0.05, type: "crypto", yfSym: "LDO-USD" },
  "PENDLE":{ name: "Pendle",      base: 5,      vol: 0.06, type: "crypto", yfSym: "PENDLE-USD" },
  "DYDX":  { name: "dYdX",        base: 2,      vol: 0.05, type: "crypto", yfSym: "DYDX-USD" },
  "SUSHI": { name: "SushiSwap",   base: 1.2,    vol: 0.05, type: "crypto", yfSym: "SUSHI-USD" },
  "KNC":   { name: "Kyber",       base: 0.7,    vol: 0.05, type: "crypto", yfSym: "KNC-USD" },
  // ═══ CRYPTO LAYER 1 ═══
  "HBAR":  { name: "Hedera",      base: 0.08,   vol: 0.04, type: "crypto", yfSym: "HBAR-USD" },
  "XLM":   { name: "Stellar",     base: 0.11,   vol: 0.04, type: "crypto", yfSym: "XLM-USD" },
  "ALGO":  { name: "Algorand",    base: 0.18,   vol: 0.05, type: "crypto", yfSym: "ALGO-USD" },
  "FLOW":  { name: "Flow",        base: 0.8,    vol: 0.05, type: "crypto", yfSym: "FLOW-USD" },
  "ICP":   { name: "ICP",         base: 12,     vol: 0.045, type: "crypto", yfSym: "ICP-USD" },
  "MINA":  { name: "Mina",        base: 0.5,    vol: 0.05, type: "crypto", yfSym: "MINA-USD" },
  "EGLD":  { name: "MultiversX",  base: 40,     vol: 0.04, type: "crypto", yfSym: "EGLD-USD" },
  "BSV":   { name: "Bitcoin SV",  base: 50,     vol: 0.04, type: "crypto", yfSym: "BSV-USD" },
  "BCH":   { name: "Bitcoin Cash", base: 400,    vol: 0.035, type: "crypto", yfSym: "BCH-USD" },
  "ETC":   { name: "Ethereum C",  base: 25,     vol: 0.04, type: "crypto", yfSym: "ETC-USD" },
  "DASH":  { name: "Dash",        base: 25,     vol: 0.04, type: "crypto", yfSym: "DASH-USD" },
  "XMR":   { name: "Monero",      base: 160,    vol: 0.03, type: "crypto", yfSym: "XMR-USD" },
  "ZEC":   { name: "Zcash",       base: 25,     vol: 0.04, type: "crypto", yfSym: "ZEC-USD" },
  "RUNE":  { name: "THORChain",   base: 5,      vol: 0.05, type: "crypto", yfSym: "RUNE-USD" },
  "FTM":   { name: "Fantom",      base: 0.7,    vol: 0.05, type: "crypto", yfSym: "FTM-USD" },
  "VET":   { name: "VeChain",     base: 0.035,  vol: 0.05, type: "crypto", yfSym: "VET-USD" },
  "KAVA":  { name: "Kava",        base: 0.7,    vol: 0.05, type: "crypto", yfSym: "KAVA-USD" },
  "BAND":  { name: "Band Protocol", base: 1.5,  vol: 0.05, type: "crypto", yfSym: "BAND-USD" },
  "SCRT":  { name: "Secret",      base: 0.5,    vol: 0.05, type: "crypto", yfSym: "SCRT-USD" },
  "THETA": { name: "Theta",       base: 1.5,    vol: 0.05, type: "crypto", yfSym: "THETA-USD" },
  // ═══ STOCKS TECH ═══
  "NVDA":  { name: "NVIDIA",      base: 120,    vol: 0.022, type: "stock", yfSym: "NVDA" },
  "TSLA":  { name: "Tesla",       base: 180,    vol: 0.03, type: "stock", yfSym: "TSLA" },
  "AAPL":  { name: "Apple",       base: 195,    vol: 0.015, type: "stock", yfSym: "AAPL" },
  "MSFT":  { name: "Microsoft",   base: 420,    vol: 0.012, type: "stock", yfSym: "MSFT" },
  "AMZN":  { name: "Amazon",      base: 185,    vol: 0.018, type: "stock", yfSym: "AMZN" },
  "META":  { name: "Meta",        base: 500,    vol: 0.018, type: "stock", yfSym: "META" },
  "GOOGL": { name: "Alphabet",    base: 175,    vol: 0.014, type: "stock", yfSym: "GOOGL" },
  "AMD":   { name: "AMD",         base: 150,    vol: 0.025, type: "stock", yfSym: "AMD" },
  "PLTR":  { name: "Palantir",    base: 25,     vol: 0.035, type: "stock", yfSym: "PLTR" },
  "COIN":  { name: "Coinbase",    base: 220,    vol: 0.035, type: "stock", yfSym: "COIN" },
  "MSTR":  { name: "MicroStrategy", base: 1500, vol: 0.04, type: "stock", yfSym: "MSTR" },
  "SOFI":  { name: "SoFi",        base: 8,      vol: 0.03, type: "stock", yfSym: "SOFI" },
  "SNAP":  { name: "Snapchat",    base: 12,     vol: 0.03, type: "stock", yfSym: "SNAP" },
  "PINS":  { name: "Pinterest",   base: 35,     vol: 0.025, type: "stock", yfSym: "PINS" },
  "UBER":  { name: "Uber",        base: 75,     vol: 0.02, type: "stock", yfSym: "UBER" },
  "ABNB":  { name: "Airbnb",      base: 150,    vol: 0.02, type: "stock", yfSym: "ABNB" },
  "DDOG":  { name: "Datadog",     base: 120,    vol: 0.025, type: "stock", yfSym: "DDOG" },
  "NET":   { name: "Cloudflare",  base: 90,     vol: 0.025, type: "stock", yfSym: "NET" },
  "CRWD":  { name: "CrowdStrike", base: 300,    vol: 0.02, type: "stock", yfSym: "CRWD" },
  "AVGO":  { name: "Broadcom",    base: 1500,   vol: 0.02, type: "stock", yfSym: "AVGO" },
  "MRVL":  { name: "Marvell",     base: 75,     vol: 0.03, type: "stock", yfSym: "MRVL" },
  "NFLX":  { name: "Netflix",     base: 650,    vol: 0.018, type: "stock", yfSym: "NFLX" },
  "DIS":   { name: "Disney",      base: 100,    vol: 0.018, type: "stock", yfSym: "DIS" },
  "INTC":  { name: "Intel",       base: 30,     vol: 0.025, type: "stock", yfSym: "INTC" },
  // ═══ STOCKS FINANCE ═══
  "JPM":   { name: "JP Morgan",   base: 200,    vol: 0.012, type: "stock", yfSym: "JPM" },
  "V":     { name: "Visa",        base: 280,    vol: 0.01, type: "stock", yfSym: "V" },
  "MA":    { name: "Mastercard",  base: 460,    vol: 0.01, type: "stock", yfSym: "MA" },
  "BAC":   { name: "BofA",        base: 38,     vol: 0.015, type: "stock", yfSym: "BAC" },
  "GS":    { name: "Goldman",     base: 450,    vol: 0.015, type: "stock", yfSym: "GS" },
  "MS":    { name: "Morgan Stanley", base: 90,  vol: 0.015, type: "stock", yfSym: "MS" },
  // ═══ STOCKS SANTÉ ═══
  "LLY":   { name: "Eli Lilly",   base: 800,    vol: 0.015, type: "stock", yfSym: "LLY" },
  "NVO":   { name: "Novo Nordisk", base: 130,   vol: 0.018, type: "stock", yfSym: "NVO" },
  "PFE":   { name: "Pfizer",      base: 28,     vol: 0.015, type: "stock", yfSym: "PFE" },
  "ABBV":  { name: "AbbVie",      base: 170,    vol: 0.012, type: "stock", yfSym: "ABBV" },
  "AMGN":  { name: "Amgen",       base: 280,    vol: 0.015, type: "stock", yfSym: "AMGN" },
  // ═══ STOCKS CONSO ═══
  "WMT":   { name: "Walmart",     base: 65,     vol: 0.01, type: "stock", yfSym: "WMT" },
  "NKE":   { name: "Nike",        base: 95,     vol: 0.02, type: "stock", yfSym: "NKE" },
  "SBUX":  { name: "Starbucks",   base: 80,     vol: 0.018, type: "stock", yfSym: "SBUX" },
  // ═══ STOCKS ÉNERGIE ═══
  "XOM":   { name: "Exxon",       base: 110,    vol: 0.012, type: "stock", yfSym: "XOM" },
  "CVX":   { name: "Chevron",     base: 155,    vol: 0.012, type: "stock", yfSym: "CVX" },
  "VLO":   { name: "Valero",      base: 150,    vol: 0.02, type: "stock", yfSym: "VLO" },
  // ═══ FOREX ═══
  "EURUSD":{ name: "EUR/USD",     base: 1.09,   vol: 0.005, type: "forex", yfSym: "EURUSD=X" },
  "GBPUSD":{ name: "GBP/USD",     base: 1.27,   vol: 0.006, type: "forex", yfSym: "GBPUSD=X" },
  "USDJPY":{ name: "USD/JPY",     base: 161,    vol: 0.006, type: "forex", yfSym: "USDJPY=X" },
  "AUDUSD":{ name: "AUD/USD",     base: 0.65,   vol: 0.007, type: "forex", yfSym: "AUDUSD=X" },
  "USDCAD":{ name: "USD/CAD",     base: 1.36,   vol: 0.005, type: "forex", yfSym: "USDCAD=X" },
  "USDCHF":{ name: "USD/CHF",     base: 0.88,   vol: 0.005, type: "forex", yfSym: "USDCHF=X" },
  "NZDUSD":{ name: "NZD/USD",     base: 0.6,    vol: 0.007, type: "forex", yfSym: "NZDUSD=X" },
  "EURGBP":{ name: "EUR/GBP",     base: 0.86,   vol: 0.004, type: "forex", yfSym: "EURGBP=X" },
  "EURJPY":{ name: "EUR/JPY",     base: 175,    vol: 0.006, type: "forex", yfSym: "EURJPY=X" },
  "GBPJPY":{ name: "GBP/JPY",     base: 205,    vol: 0.007, type: "forex", yfSym: "GBPJPY=X" },
  // ═══ MATIÈRES PREMIÈRES ═══
  "GOLD":  { name: "Or",          base: 2400,   vol: 0.012, type: "commodity", yfSym: "GC=F" },
  "SILVER":{ name: "Argent",      base: 30,     vol: 0.02, type: "commodity", yfSym: "SI=F" },
  "OIL":   { name: "Pétrole",     base: 75,     vol: 0.025, type: "commodity", yfSym: "CL=F" },
  "GAS":   { name: "Gaz",         base: 2.5,    vol: 0.04, type: "commodity", yfSym: "NG=F" },
  "COPPER":{ name: "Cuivre",      base: 4.2,    vol: 0.015, type: "commodity", yfSym: "HG=F" },
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

function isForexOpen() {
  const now = new Date();
  const etDay = now.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short" });
  return etDay !== "Sat" && etDay !== "Sun";
}

const rangeDays = { "1w": 7, "1mo": 30, "3mo": 90, "6mo": 180, "1y": 365, "2y": 730 };

// ═══════════════════════════════════════════════════════════════
// LIVE TRADING ENGINE
// ═══════════════════════════════════════════════════════════════
const INITIAL_VIRTUAL = 40;

const liveState = {
  realBalance: 0,
  virtualBalance: INITIAL_VIRTUAL,
  activeMode: "virtual",
  realPositions: {},
  virtualPositions: {},
  realTradeHistory: [],
  virtualTradeHistory: [],
  realNotifications: [],
  virtualNotifications: [],
  realTotalPnL: 0,
  virtualTotalPnL: 0,
  realWins: 0,
  virtualWins: 0,
  realLosses: 0,
  virtualLosses: 0,
  currentPrices: {},
  lastExitTime: {},
  realPeakBalance: 0,
  virtualPeakBalance: INITIAL_VIRTUAL,
  realRecentPnL: [],
  virtualRecentPnL: [],
  realDepositHistory: [],
  virtualDepositHistory: [],
  // NEW: Daily loss tracking
  realDailyPnL: 0,
  virtualDailyPnL: 0,
  realDailyTrades: 0,
  virtualDailyTrades: 0,
  lastDailyReset: Date.now(),
  // NEW: Kelly Criterion stats
  realTotalTrades: 0,
  virtualTotalTrades: 0,
  realWinStreak: 0,
  virtualWinStreak: 0,
  realLossStreak: 0,
  virtualLossStreak: 0,
  // NEW: Daily loss limit
  maxDailyLossPct: 0.15, // 15% max daily loss
  dailyTradingPaused: false,
};

function getState() {
  return liveState.activeMode === "real" ? {
    balance: liveState.realBalance,
    positions: liveState.realPositions,
    tradeHistory: liveState.realTradeHistory,
    notifications: liveState.realNotifications,
    totalPnL: liveState.realTotalPnL,
    wins: liveState.realWins,
    losses: liveState.realLosses,
    peakBalance: liveState.realPeakBalance,
    recentPnL: liveState.realRecentPnL,
    depositHistory: liveState.realDepositHistory,
  } : {
    balance: liveState.virtualBalance,
    positions: liveState.virtualPositions,
    tradeHistory: liveState.virtualTradeHistory,
    notifications: liveState.virtualNotifications,
    totalPnL: liveState.virtualTotalPnL,
    wins: liveState.virtualWins,
    losses: liveState.virtualLosses,
    peakBalance: liveState.virtualPeakBalance,
    recentPnL: liveState.virtualRecentPnL,
    depositHistory: liveState.virtualDepositHistory,
  };
}

function setBalance(val) {
  if (liveState.activeMode === "real") liveState.realBalance = val;
  else liveState.virtualBalance = val;
}

function setPeakBalance(val) {
  if (liveState.activeMode === "real") liveState.realPeakBalance = val;
  else liveState.virtualPeakBalance = val;
}

function addPnL(pnl) {
  if (liveState.activeMode === "real") {
    liveState.realTotalPnL += pnl;
    liveState.realRecentPnL.push(pnl);
    if (liveState.realRecentPnL.length > 20) liveState.realRecentPnL.shift();
    if (pnl > 0) liveState.realWins++; else liveState.realLosses++;
  } else {
    liveState.virtualTotalPnL += pnl;
    liveState.virtualRecentPnL.push(pnl);
    if (liveState.virtualRecentPnL.length > 20) liveState.virtualRecentPnL.shift();
    if (pnl > 0) liveState.virtualWins++; else liveState.virtualLosses++;
  }
}

// ─── ADAPTIVE RISK SYSTEM ───
function getRiskProfile(equity) {
  if (equity <= 50) return { name: "micro", maxRiskPct: 0.30, maxPos: 5, maxPerGroup: 2, maxHoldMin: 480, maxDrawdownPct: 0.50, cooldownMin: 30 };
  if (equity <= 200) return { name: "small", maxRiskPct: 0.25, maxPos: 5, maxPerGroup: 3, maxHoldMin: 360, maxDrawdownPct: 0.45, cooldownMin: 25 };
  if (equity <= 500) return { name: "medium", maxRiskPct: 0.20, maxPos: 5, maxPerGroup: 3, maxHoldMin: 240, maxDrawdownPct: 0.40, cooldownMin: 20 };
  if (equity <= 2000) return { name: "large", maxRiskPct: 0.15, maxPos: 6, maxPerGroup: 3, maxHoldMin: 180, maxDrawdownPct: 0.35, cooldownMin: 15 };
  return { name: "big", maxRiskPct: 0.10, maxPos: 8, maxPerGroup: 4, maxHoldMin: 120, maxDrawdownPct: 0.30, cooldownMin: 10 };
}

// ── CORRELATION GROUPS (max 2 per group) ──
const CORR_GROUPS = {
  BTC_ECO: ["BTC", "MSTR", "BCH", "ETC", "STX", "RUNE"],
  ETH_ECO: ["ETH", "UNI", "AAVE", "MKR", "LINK", "OP", "ARB", "LDO", "RPL", "COMP"],
  L1_ALTS: ["SOL", "AVAX", "ADA", "DOT", "ATOM", "NEAR", "APT", "SUI", "SEI", "INJ", "TIA", "FIL", "KAVA", "ALGO", "FTM", "EOS", "XLM"],
  MEME: ["DOGE", "SHIB", "PEPE", "GALA", "SAND", "MANA", "CRV", "BONK", "FLOKI", "TURBO", "BRETT", "WIF", "NEIRO", "CHZ", "ENJ", "AXS", "IMX", "BLUR"],
  AI_DEPIN: ["RENDER", "FET", "ICP", "HBAR", "TRX", "TAO", "AKT", "OCEAN", "GRT", "WLD", "THETA", "BAT"],
  US_TECH: ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "AMD", "AVGO", "QCOM", "TXN", "MU", "LRCX", "AMAT", "KLAC", "SNPS", "CDNS", "ANET", "DELL", "IBM", "ORCL", "NOW", "TEAM", "DDOG", "HUBS", "OKTA"],
  US_GROWTH: ["TSLA", "NFLX", "CRM", "PANW", "SNOW", "ZS", "MDB", "PLTR", "CRWD", "NET", "FTNT", "CYBR", "TTD", "WDAY", "VEEV", "DOCU", "SE", "GRAB"],
  US_CONSUMER: ["DIS", "UBER", "SHOP", "COIN", "SQ", "ABNB", "SPOT", "DKNG", "CCL", "AAL", "CMG", "SBUX", "NKE", "TGT", "COST", "WMT", "BBY", "ROST", "LULU"],
  US_FINANCE: ["GS", "JPM", "V", "MA", "PYPL", "COIN", "HOOD", "SOFI"],
  US_PHARMA: ["PFE", "ABBV", "LLY", "UNH", "GILD", "VRTX", "MRNA"],
  US_ENERGY: ["CVX", "XOM"],
  US_TELECOM: ["T", "VZ"],
  US_AUTO: ["F", "GM", "TSLA", "NIO", "RIVN", "LCID", "XPEV", "LI"],
  US_SPECUL: ["U", "ROKU", "ARM", "UPST", "W", "RBLX", "DASH", "SNAP", "ZM", "TOST", "BILL", "AI", "INTC", "BA", "WBD"],
  CHINA: ["BABA", "JD", "PDD", "XPEV", "LI", "NIO"],
  FOREX_MAJOR: ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD"],
  FOREX_CROSS: ["EURGBP", "EURJPY", "GBPJPY", "EURAUD", "EURCHF", "EURNZD", "GBPAUD", "GBPCAD", "AUDJPY", "CADJPY"],
  FOREX_EXOTIC: ["USDTRY", "USDMXN", "USDZAR", "USDPLN", "USDSEK", "USDNOK", "USDCNH", "USDINR"],
  US_INDICES: ["SPX", "NDX", "DJI", "RUT", "STOXX", "CAC", "IBEX", "SMI"],
  EU_INDICES: ["FTSE", "DAX", "STOXX"],
  ASIA_INDICES: ["NIKKEI", "HANG", "KOSPI", "SENSEX", "ASX", "TSX"],
  COMMODITY_METALS: ["GOLD", "SILVER", "COPPER", "PLAT", "PALADIUM"],
  COMMODITY_ENERGY: ["OIL", "GAS", "LUMBER"],
  COMMODITY_AGRI: ["WHEAT", "CORN", "SOYBEAN", "COCOA", "SUGAR"],
};

function getCorrelationGroup(sym) {
  for (const [group, syms] of Object.entries(CORR_GROUPS)) {
    if (syms.includes(sym)) return group;
  }
  return null;
}

function getGroupCount(group) {
  const st = getState();
  return Object.keys(st.positions).filter(s => getCorrelationGroup(s) === group).length;
}

function addNotification(type, title, message) {
  const notif = { id: Date.now(), type, title, message, time: new Date().toISOString() };
  if (liveState.activeMode === "real") {
    liveState.realNotifications.unshift(notif);
    if (liveState.realNotifications.length > 100) liveState.realNotifications.pop();
  } else {
    liveState.virtualNotifications.unshift(notif);
    if (liveState.virtualNotifications.length > 100) liveState.virtualNotifications.pop();
  }
  console.log(`[NOTIF] ${type}: ${title} - ${message}`);
}

// ═══════════════════════════════════════════════════════════════
// NEW: ADVANCED RISK MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// Kelly Criterion: optimal position size based on win rate
function getKellyCriterion() {
  const st = getState();
  const totalTrades = st.wins + st.losses;
  if (totalTrades < 10) return 0.5; // Conservative default
  const winRate = st.wins / totalTrades;
  const avgWin = st.recentPnL.filter(p => p > 0).length > 0 
    ? st.recentPnL.filter(p => p > 0).reduce((a, b) => a + b, 0) / st.recentPnL.filter(p => p > 0).length 
    : 1;
  const avgLoss = st.recentPnL.filter(p => p < 0).length > 0 
    ? Math.abs(st.recentPnL.filter(p => p < 0).reduce((a, b) => a + b, 0) / st.recentPnL.filter(p => p < 0).length) 
    : 1;
  const winLossRatio = avgWin / avgLoss;
  
  // Kelly formula: f* = (bp - q) / b
  // where b = win/loss ratio, p = win rate, q = loss rate
  const kelly = ((winLossRatio * winRate) - (1 - winRate)) / winLossRatio;
  
  // Clamp between 0.1 and 0.5 (conservative)
  return Math.max(0.1, Math.min(0.5, kelly));
}

// Daily loss limit check
function checkDailyLossLimit() {
  const now = Date.now();
  const st = getState();
  
  // Reset daily stats every 24 hours
  if (now - liveState.lastDailyReset > 24 * 60 * 60 * 1000) {
    liveState.realDailyPnL = 0;
    liveState.virtualDailyPnL = 0;
    liveState.realDailyTrades = 0;
    liveState.virtualDailyTrades = 0;
    liveState.dailyTradingPaused = false;
    liveState.lastDailyReset = now;
    console.log("[DAILY] Reset daily stats");
  }
  
  const dailyPnL = liveState.activeMode === "real" ? liveState.realDailyPnL : liveState.virtualDailyPnL;
  const totalEquity = getTotalEquity();
  const dailyLossPct = totalEquity > 0 ? Math.abs(dailyPnL) / totalEquity : 0;
  
  if (dailyPnL < 0 && dailyLossPct > liveState.maxDailyLossPct) {
    liveState.dailyTradingPaused = true;
    console.log(`[DAILY] Trading paused! Daily loss: ${(dailyLossPct * 100).toFixed(1)}% > ${(liveState.maxDailyLossPct * 100)}%`);
    addNotification("error", "🛑 DAILY LOSS LIMIT", `Perte journalière: ${(dailyLossPct * 100).toFixed(1)}% > ${(liveState.maxDailyLossPct * 100)}% — Trading suspendu`);
    return true;
  }
  return false;
}

// Slippage simulation (realistic)
function applySlippage(price, side, assetType) {
  const slippageRates = {
    crypto: 0.0005,    // 0.05%
    stock: 0.0003,     // 0.03%
    stock_fast: 0.0003,
    forex: 0.0001,     // 0.01%
    commodity: 0.0005,
    index: 0.0003,
  };
  const rate = slippageRates[assetType] || 0.0003;
  const slippage = price * rate;
  return side === "BUY" ? price + slippage : price - slippage;
}

// Trading fees simulation (0.05% per trade)
function calculateFees(amount) {
  return amount * 0.0005; // 0.05% fee
}

// VWAP calculation
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

// Support/Resistance levels
function findSupportResistance(rawData, lookback = 20) {
  const levels = [];
  const closes = rawData.map(d => d.close);
  
  for (let i = lookback; i < closes.length - lookback; i++) {
    const window = closes.slice(i - lookback, i + lookback);
    const high = Math.max(...window);
    const low = Math.min(...window);
    
    // Resistance: local high
    if (closes[i] === high) {
      levels.push({ type: "RESISTANCE", price: closes[i], strength: 1 });
    }
    // Support: local low
    if (closes[i] === low) {
      levels.push({ type: "SUPPORT", price: closes[i], strength: 1 });
    }
  }
  
  // Round to psychological levels
  const psychologicalLevels = [];
  for (let i = 0; i < levels.length; i++) {
    const price = levels[i].price;
    const rounded = Math.round(price / 10) * 10;
    psychologicalLevels.push({ ...levels[i], price: rounded });
  }
  
  return psychologicalLevels;
}

// Check if price is near support/resistance
function isNearLevel(price, levels, threshold = 0.02) {
  for (const level of levels) {
    const distance = Math.abs(price - level.price) / price;
    if (distance < threshold) {
      return level;
    }
  }
  return null;
}

function getPositionCount() {
  const st = getState();
  return Object.keys(st.positions).length;
}

function getTotalEquity() {
  const st = getState();
  let equity = st.balance;
  for (const sym of Object.keys(st.positions)) {
    equity += st.positions[sym].cost;
  }
  return equity;
}

function getCryptoCount() {
  const st = getState();
  return Object.keys(st.positions).filter(s => ASSETS[s]?.type === "crypto").length;
}

function getStockCount() {
  const st = getState();
  return Object.keys(st.positions).filter(s => ASSETS[s]?.type === "stock").length;
}

function getStockFastCount() {
  const st = getState();
  return Object.keys(st.positions).filter(s => ASSETS[s]?.type === "stock_fast").length;
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
    ema5: EMA.calculate({ values: closes, period: 5 }),
    ema20: EMA.calculate({ values: closes, period: 20 }),
    ema50: EMA.calculate({ values: closes, period: 50 }),
    atr: ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }),
    volSma20: SMA.calculate({ values: volumes, period: 20 }),
  };
}

function analyzeDay(ana, i) {
  const { closes, volumes, rsi, ema5, ema20, ema50, atr, volSma20, len } = ana;
  const price = closes[i];
  const prevPrice = closes[i - 1];
  if (!prevPrice) return null;

  const rI = i - (len - rsi.length);
  const e5I = i - (len - ema5.length);
  const e20I = i - (len - ema20.length);
  const e50I = i - (len - ema50.length);
  const aI = i - (len - atr.length);
  const vI = i - (len - volSma20.length);

  const rsiVal = getVal(rsi, rI);
  const ema5Val = getVal(ema5, e5I);
  const ema20Val = getVal(ema20, e20I);
  const ema50Val = getVal(ema50, e50I);
  const atrVal = getVal(atr, aI);
  const volAvg = getVal(volSma20, vI);
  const volNow = getVal(volumes, i);

  if (rsiVal == null || !atrVal || !volAvg || !ema5Val) return null;

  const isBouncing = price > prevPrice;
  const isFalling = price < prevPrice;
  const volumeOK = volNow > volAvg * 0.4;

  // FILTRE VOLATILITÉ: ATR/price ratio
  const atrRatio = atrVal / price;
  if (atrRatio > 0.08) return null; // Trop volatile = skip
  const volMultiplier = atrRatio > 0.05 ? 0.5 : 1.0;

  // MARKET REGIME: utilisation EMA20/50
  const trendUp = ema20Val > ema50Val;
  const trendDown = ema20Val < ema50Val;
  const priceAboveEMA = price > ema5Val;

  // LONG: RSI < 40 + bounce + volume + trend up
  if (rsiVal < 40 && isBouncing && volumeOK && trendUp && priceAboveEMA) {
    const slDist = atrVal * 1.0;
    const tpDist = atrVal * 2.0;
    return {
      longSignal: true, shortSignal: false,
      atr: atrVal,
      tp: +(price + tpDist).toFixed(4),
      sl: +(price - slDist).toFixed(4),
      shortTp: 0, shortSl: 0,
      price, volumeConfirm: true, volumeSpike: false,
      rsi: rsiVal, bbPct: 0, stochK: 0,
      ema20: ema20Val, ema50: ema50Val,
      adx: 0, strongTrend: trendUp, weakTrend: false,
      vwap: 0, aboveVWAP: true, belowVWAP: false,
      longConfidence: 70, shortConfidence: 0,
      longReasons: [`RSI${rsiVal.toFixed(0)}`, "Bounce", "Vol", "Trend↑"],
      shortReasons: [],
      longPassed: 4, shortPassed: 0,
      volMultiplier,
    };
  }

  // SHORT: RSI > 60 + fall + volume + trend down
  if (rsiVal > 60 && isFalling && volumeOK && trendDown && !priceAboveEMA) {
    const slDist = atrVal * 1.0;
    const tpDist = atrVal * 2.0;
    return {
      longSignal: false, shortSignal: true,
      atr: atrVal,
      tp: 0, sl: 0,
      shortTp: +(price - tpDist).toFixed(4),
      shortSl: +(price + slDist).toFixed(4),
      price, volumeConfirm: true, volumeSpike: false,
      rsi: rsiVal, bbPct: 0, stochK: 0,
      ema20: ema20Val, ema50: ema50Val,
      adx: 0, strongTrend: trendDown, weakTrend: false,
      vwap: 0, aboveVWAP: false, belowVWAP: true,
      longConfidence: 0, shortConfidence: 70,
      longReasons: [],
      shortReasons: [`RSI${rsiVal.toFixed(0)}`, "Fall", "Vol", "Trend↓"],
      longPassed: 0, shortPassed: 4,
      volMultiplier,
    };
  }

  return null;
}

// ─── MULTI-TIMEFRAME TREND (weekly) ─────────────────────────
async function getWeeklyTrend(yfSymbol) {
  try {
    const weeklyData = (await yfChartFast(yfSymbol, "6mo", "1wk")).data;
    if (!weeklyData || weeklyData.length < 20) return "neutral";
    const closes = weeklyData.map(d => d.close);
    const ema20w = EMA.calculate({ values: closes, period: 20 });
    const ema50w = EMA.calculate({ values: closes, period: 50 });
    const lastEma20 = ema20w[ema20w.length - 1];
    const lastEma50 = ema50w[ema50w.length - 1];
    const lastPrice = closes[closes.length - 1];
    if (lastEma20 && lastEma50) {
      if (lastEma20 > lastEma50 && lastPrice > lastEma20) return "bullish";
      if (lastEma20 < lastEma50 && lastPrice < lastEma20) return "bearish";
    }
    return "neutral";
  } catch { return "neutral"; }
}

// ─── EQUITY CURVE: position sizing multiplier ────────────────
function getEquityMultiplier() {
  const st = getState();
  const recent = st.recentPnL.slice(-10);
  if (recent.length < 3) return 1.0;
  const last3 = recent.slice(-3);
  const last3AllLoss = last3.every(p => p < 0);
  const last3AllWin = last3.every(p => p > 0);
  if (last3AllLoss) return 0.5;
  if (last3AllWin) return 1.3;
  const last5 = recent.slice(-5);
  const recentWinRate = last5.filter(p => p > 0).length / last5.length;
  if (recentWinRate < 0.3) return 0.6;
  if (recentWinRate > 0.6) return 1.2;
  return 1.0;
}

// ─── LIVE TRADE CHECK (runs every 30s) ──────────────────────
async function processAsset(sym) {
  try {
  const asset = ASSETS[sym];
  let rawData;
  const yfSymbol = asset?.yfSym || (asset?.type === "crypto" ? sym + "-USD" : sym);
  try { rawData = (await yfChartFast(yfSymbol, "3mo", "1d")).data; }
  catch {
    // Fallback: use simulated data based on asset config
    rawData = generateData(sym, 90, asset.base, asset.vol);
  }
  if (!rawData || rawData.length < 50) return;

  const ana = computeIndicators(rawData);
  const result = analyzeDay(ana, ana.len - 1);
  const currentPrice = result ? result.price : rawData[rawData.length - 1].close;
  liveState.currentPrices[sym] = currentPrice;
  if (!result) return;

  const st = getState();
  const totalEquity = getTotalEquity();
  const risk = getRiskProfile(totalEquity);

      const pos = st.positions[sym];
      const atrVal = result.atr;

      // ── EXIT CHECK ──
      if (pos) {
        let shouldExit = false;
        let exitPrice = currentPrice;
        let exitReason = "SIGNAL";
        let partialExit = false;

        const holdMinutes = (Date.now() - new Date(pos.entryTime).getTime()) / 60000;
        const maxHold = asset?.maxHold || (asset?.type === "stock_fast" ? 120 : asset?.type === "crypto" ? 480 : asset?.type === "stock" ? 480 : 360);
        if (holdMinutes >= maxHold) { shouldExit = true; exitReason = "TIME"; }

        // ── TRAILING STOP ──
        if (pos.side === "LONG" && !shouldExit) {
          const bestPrice = pos.bestPrice || pos.entryPrice;
          if (currentPrice > bestPrice) { st.positions[sym].bestPrice = currentPrice; }
          const newBest = Math.max(bestPrice, currentPrice);
          const trailDistance = atrVal * 0.35;
          if (newBest > pos.entryPrice + atrVal * 0.35) {
            const newTrailSl = +(newBest - trailDistance).toFixed(4);
            if (newTrailSl > pos.sl) { st.positions[sym].sl = newTrailSl; }
          }
          if (!pos.partialTaken && currentPrice >= pos.entryPrice + atrVal * 0.4) {
            partialExit = true;
            const halfQty = +(pos.qty / 2).toFixed(8);
            const pnl = halfQty * (currentPrice - pos.entryPrice);
            const costReturned = halfQty * pos.entryPrice;
            setBalance(st.balance + costReturned + pnl);
            addPnL(pnl);
            st.positions[sym].qty = pos.qty - halfQty;
            st.positions[sym].cost = (pos.qty - halfQty) * pos.entryPrice;
            st.positions[sym].partialTaken = true;
            st.positions[sym].sl = pos.entryPrice;
            st.tradeHistory.unshift({
              id: Date.now(), symbol: sym, side: "LONG", exitReason: "TP1_PARTIAL",
              entryPrice: pos.entryPrice, exitPrice: currentPrice, qty: halfQty,
              entryTime: pos.entryTime, exitTime: new Date().toISOString(),
              pnl: +pnl.toFixed(4), pnlPercent: +(((currentPrice - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2),
              holdMinutes: Math.round(holdMinutes),
            });
            addNotification("success", `✅ PARTIAL TP LONG ${sym}`, `50% vendu @ $${currentPrice.toFixed(2)} | PnL: +$${pnl.toFixed(2)} | SL → breakeven`);
          }
        }

        if (pos.side === "SHORT" && !shouldExit) {
          const bestPrice = pos.bestPrice || pos.entryPrice;
          if (currentPrice < bestPrice) { st.positions[sym].bestPrice = currentPrice; }
          const newBest = Math.min(bestPrice, currentPrice);
          const trailDistance = atrVal * 0.35;
          if (newBest < pos.entryPrice - atrVal * 0.35) {
            const newTrailSl = +(newBest + trailDistance).toFixed(4);
            if (newTrailSl < pos.sl) { st.positions[sym].sl = newTrailSl; }
          }
          if (!pos.partialTaken && currentPrice <= pos.entryPrice - atrVal * 0.4) {
            partialExit = true;
            const halfQty = +(pos.qty / 2).toFixed(8);
            const pnl = halfQty * (pos.entryPrice - currentPrice);
            const costReturned = halfQty * pos.entryPrice;
            setBalance(st.balance + costReturned + pnl);
            addPnL(pnl);
            st.positions[sym].qty = pos.qty - halfQty;
            st.positions[sym].cost = (pos.qty - halfQty) * pos.entryPrice;
            st.positions[sym].partialTaken = true;
            st.positions[sym].sl = pos.entryPrice;
            st.tradeHistory.unshift({
              id: Date.now(), symbol: sym, side: "SHORT", exitReason: "TP1_PARTIAL",
              entryPrice: pos.entryPrice, exitPrice: currentPrice, qty: halfQty,
              entryTime: pos.entryTime, exitTime: new Date().toISOString(),
              pnl: +pnl.toFixed(4), pnlPercent: +(((pos.entryPrice - currentPrice) / pos.entryPrice) * 100).toFixed(2),
              holdMinutes: Math.round(holdMinutes),
            });
            addNotification("success", `✅ PARTIAL TP SHORT ${sym}`, `50% vendu @ $${currentPrice.toFixed(2)} | PnL: +$${pnl.toFixed(2)} | SL → breakeven`);
          }
        }

        // ── FULL EXIT (SL/TP/REVERSE) ──
        if (!partialExit) {
          const posNow = st.positions[sym];
          if (posNow) {
            if (posNow.side === "LONG") {
              if (currentPrice <= posNow.sl) { shouldExit = true; exitPrice = posNow.sl; exitReason = "SL"; }
              else if (currentPrice >= posNow.tp) { shouldExit = true; exitPrice = posNow.tp; exitReason = "TP"; }
              else if (result.shortSignal && holdMinutes >= 15) { shouldExit = true; exitReason = "REVERSE"; }
            } else {
              if (currentPrice >= posNow.sl) { shouldExit = true; exitPrice = posNow.sl; exitReason = "SL"; }
              else if (currentPrice <= posNow.tp) { shouldExit = true; exitPrice = posNow.tp; exitReason = "TP"; }
              else if (result.longSignal && holdMinutes >= 15) { shouldExit = true; exitReason = "REVERSE"; }
            }
          }
        }

        if (shouldExit) {
          const posFinal = st.positions[sym];
          if (!posFinal) return;
          let pnl, pct;
          if (posFinal.side === "LONG") {
            pnl = posFinal.qty * (exitPrice - posFinal.entryPrice);
            pct = ((exitPrice - posFinal.entryPrice) / posFinal.entryPrice) * 100;
          } else {
            pnl = posFinal.qty * (posFinal.entryPrice - exitPrice);
            pct = ((posFinal.entryPrice - exitPrice) / posFinal.entryPrice) * 100;
          }
          // NEW: Apply exit slippage
          const exitSlippage = applySlippage(exitPrice, posFinal.side === "LONG" ? "SELL" : "BUY", asset.type);
          const exitFees = calculateFees(posFinal.cost + pnl);
          setBalance(st.balance + posFinal.cost + pnl - exitFees);
          addPnL(pnl);
          // NEW: Update daily PnL
          if (liveState.activeMode === "real") liveState.realDailyPnL += pnl;
          else liveState.virtualDailyPnL += pnl;

          const trade = {
            id: Date.now(), symbol: sym, side: posFinal.side, exitReason,
            entryPrice: posFinal.entryPrice, exitPrice: exitSlippage, qty: posFinal.qty,
            entryTime: posFinal.entryTime, exitTime: new Date().toISOString(),
            pnl: +pnl.toFixed(4), pnlPercent: +pct.toFixed(2),
            holdMinutes: Math.round((Date.now() - new Date(posFinal.entryTime).getTime()) / 60000),
            // NEW: Track fees and slippage
            fees: +exitFees.toFixed(4), slippage: +(Math.abs(exitSlippage - exitPrice)).toFixed(4),
          };
          st.tradeHistory.unshift(trade);
          delete st.positions[sym];
          liveState.lastExitTime[sym] = Date.now();

          const newEquity = getTotalEquity();
          if (newEquity > st.peakBalance) setPeakBalance(newEquity);

          const emoji = pnl >= 0 ? "✅" : "❌";
          const sideLabel = posFinal.side === "LONG" ? "LONG" : "SHORT";
          addNotification(
            pnl >= 0 ? "success" : "error",
            `${emoji} FERMETURE ${sideLabel} ${sym}`,
            `${exitReason} @ $${exitSlippage.toFixed(2)} | PnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%) | Fees: $${exitFees.toFixed(4)}`
          );
        }
      }

      // ── ENTRY CHECK ──
      const isCrypto = asset?.type === "crypto";
      const isStock = asset?.type === "stock";
      const isFast = asset?.type === "stock_fast";
      const isForex = asset?.type === "forex";
      const isCommodity = asset?.type === "commodity";
      const isIndex = asset?.type === "index";

      // ── ADAPTIVE LIMITS ──
      const drawdown = st.peakBalance > 0 ? (st.peakBalance - totalEquity) / st.peakBalance : 0;
      const maxDD = risk.maxDrawdownPct || 0.30;
      const tradingPaused = drawdown > maxDD;

      // ── CONSECUTIVE LOSS COOLDOWN ──
      const recentTrades = st.tradeHistory.slice(0, 10);
      const recentLosses = recentTrades.filter(t => t.pnl < 0).length;
      const consecutiveLossCooldown = recentTrades.length >= 3 && recentTrades.slice(0, 3).every(t => t.pnl < 0);

      // NEW: Daily loss limit
      const dailyPaused = checkDailyLossLimit();

      const atMax = getPositionCount() >= risk.maxPos;
      const cryptoLimit = isCrypto && getCryptoCount() >= Math.max(5, Math.floor(risk.maxPos * 0.4));
      const stockLimit = isStock && getStockCount() >= Math.max(5, Math.floor(risk.maxPos * 0.35));
      const fastLimit = isFast && getStockFastCount() >= Math.max(3, Math.floor(risk.maxPos * 0.25));
      const marketClosed = (isStock || isFast || isCommodity || isIndex) && !isStockMarketOpen();
      const forexClosed = isForex && !isForexOpen();
      const cooldownActive = liveState.lastExitTime[sym] && (Date.now() - liveState.lastExitTime[sym]) < 10 * 60 * 1000;

      // ── CORRELATION FILTER ──
      const corrGroup = getCorrelationGroup(sym);
      const corrLimit = corrGroup ? getGroupCount(corrGroup) >= risk.maxPerGroup : false;

      const isVolatile = asset?.volatile === true;
      const equityMult = getEquityMultiplier();
      
      // NEW: Kelly Criterion for position sizing
      const kellyMultiplier = getKellyCriterion();

      // Debug: log signals
      if (result.longSignal || result.shortSignal) {
        const blocks = [];
        if (atMax) blocks.push("maxPos");
        if (cryptoLimit) blocks.push("cryptoLim");
        if (stockLimit) blocks.push("stockLim");
        if (fastLimit) blocks.push("fastLim");
        if (marketClosed) blocks.push("mktClosed");
        if (forexClosed) blocks.push("fxClosed");
        if (cooldownActive) blocks.push("cooldown");
        if (corrLimit) blocks.push("corr");
        if (tradingPaused) blocks.push("paused");
        if (consecutiveLossCooldown) blocks.push("lossCooldown");
        if (dailyPaused) blocks.push("dailyLimit");
        if (!result.volumeConfirm) blocks.push("vol");
        if (blocks.length > 0) console.log(`[BLOCKED] ${sym}: L=${result.longConfidence}% S=${result.shortConfidence}% → ${blocks.join(", ")}`);
        else console.log(`[SIGNAL] ${sym}: L=${result.longSignal ? result.longConfidence + "%" : "—"} S=${result.shortSignal ? result.shortConfidence + "%" : "—"} ${result.longSignal ? result.longReasons.join(",") : ""}${result.shortSignal ? result.shortReasons.join(",") : ""}`);
      }

      if (!pos && !atMax && !cryptoLimit && !stockLimit && !fastLimit && !marketClosed && !forexClosed && !cooldownActive && !corrLimit && !tradingPaused && !consecutiveLossCooldown && !dailyPaused && st.balance > 1) {
        // ── LONG ENTRY ──
        if (result.longSignal) {
          const confidence = result.longConfidence / 100;
          // NEW: Kelly Criterion for optimal sizing
          const spendRatio = risk.maxRiskPct * confidence * equityMult * kellyMultiplier;
          const spend = st.balance * spendRatio;
          const qty = +(spend / currentPrice).toFixed(8);
          const cost = qty * currentPrice;

          // NEW: Apply slippage to entry price
          const entryPriceWithSlippage = applySlippage(currentPrice, "BUY", asset.type);
          const fees = calculateFees(cost);

          let tpFinal, slFinal;
          if (isFast) { tpFinal = +(entryPriceWithSlippage + atrVal * 2.0).toFixed(4); slFinal = +(entryPriceWithSlippage - atrVal * 1.2).toFixed(4); }
          else if (isStock) { tpFinal = +(entryPriceWithSlippage + atrVal * 2.5).toFixed(4); slFinal = +(entryPriceWithSlippage - atrVal * 1.5).toFixed(4); }
          else { tpFinal = result.tp; slFinal = result.sl; }

          st.positions[sym] = {
            side: "LONG", entryTime: new Date().toISOString(),
            entryPrice: entryPriceWithSlippage, qty, cost: cost + fees,
            tp: tpFinal, sl: slFinal,
            bestPrice: entryPriceWithSlippage, partialTaken: false, initialQty: qty,
          };
          setBalance(st.balance - cost - fees);
          // NEW: Update daily stats
          if (liveState.activeMode === "real") liveState.realDailyTrades++;
          else liveState.virtualDailyTrades++;

          const tag = isCrypto ? "₿" : isFast ? "⚡" : asset?.type === "forex" ? "💱" : asset?.type === "commodity" ? "🥇" : asset?.type === "index" ? "📈" : "📊";
          const volTag = isVolatile ? "🔥" : "";
          addNotification("info", `${tag}${volTag} LONG ${sym}`, `Achat $${entryPriceWithSlippage.toFixed(2)} | TP: $${tpFinal} | SL: $${slFinal} | Confiance: ${result.longConfidence}% | Kelly: ${(kellyMultiplier * 100).toFixed(0)}% | ${result.longReasons.join(", ")}`);
        }
        // ── SHORT ENTRY ──
        else if (result.shortSignal) {
          const confidence = result.shortConfidence / 100;
          // NEW: Kelly Criterion for optimal sizing
          const spendRatio = risk.maxRiskPct * confidence * equityMult * kellyMultiplier;
          const spend = st.balance * spendRatio;
          const qty = +(spend / currentPrice).toFixed(8);
          const cost = qty * currentPrice;

          // NEW: Apply slippage to entry price
          const entryPriceWithSlippage = applySlippage(currentPrice, "SELL", asset.type);
          const fees = calculateFees(cost);

          let shortTpFinal, shortSlFinal;
          if (isFast) { shortTpFinal = +(entryPriceWithSlippage - atrVal * 2.0).toFixed(4); shortSlFinal = +(entryPriceWithSlippage + atrVal * 1.2).toFixed(4); }
          else if (isStock) { shortTpFinal = +(entryPriceWithSlippage - atrVal * 2.5).toFixed(4); shortSlFinal = +(entryPriceWithSlippage + atrVal * 1.5).toFixed(4); }
          else { shortTpFinal = result.shortTp; shortSlFinal = result.shortSl; }

          st.positions[sym] = {
            side: "SHORT", entryTime: new Date().toISOString(),
            entryPrice: entryPriceWithSlippage, qty, cost: cost + fees,
            tp: shortTpFinal, sl: shortSlFinal,
            bestPrice: entryPriceWithSlippage, partialTaken: false, initialQty: qty,
          };
          setBalance(st.balance - cost - fees);
          // NEW: Update daily stats
          if (liveState.activeMode === "real") liveState.realDailyTrades++;
          else liveState.virtualDailyTrades++;

          const tag = isCrypto ? "₿" : isFast ? "⚡" : asset?.type === "forex" ? "💱" : asset?.type === "commodity" ? "🥇" : asset?.type === "index" ? "📈" : "📊";
          const volTag = isVolatile ? "🔥" : "";
          addNotification("info", `${tag}${volTag} SHORT ${sym}`, `Vente $${entryPriceWithSlippage.toFixed(2)} | TP: $${shortTpFinal} | SL: $${shortSlFinal} | Confiance: ${result.shortConfidence}% | Kelly: ${(kellyMultiplier * 100).toFixed(0)}% | ${result.shortReasons.join(", ")}`);
        }
      }
    } catch (err) {
      console.log(`[SKIP] ${sym}: ${err.stack || err.message}`);
    }
}

// Process in parallel batches of 10
let cycleRunning = false;
async function liveTradeCheck() {
  if (cycleRunning) return;
  cycleRunning = true;
  const symbols = Object.keys(ASSETS);
  const BATCH = 10;
  let yfOk = 0, yfFail = 0;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(sym => processAsset(sym)));
  }
  cycleRunning = false;
  const st = getState();
  const eq = getTotalEquity();
  const risk = getRiskProfile(eq);
  const wr = st.wins + st.losses > 0 ? ((st.wins / (st.wins + st.losses)) * 100).toFixed(0) : 0;
  const kelly = getKellyCriterion();
  const dailyPnL = liveState.activeMode === "real" ? liveState.realDailyPnL : liveState.virtualDailyPnL;
  const dailyTrades = liveState.activeMode === "real" ? liveState.realDailyTrades : liveState.virtualDailyTrades;
  console.log(`[CYCLE] Mode:${liveState.activeMode} Risk:${risk.name} | Pos:${getPositionCount()}/${risk.maxPos} | Bal:€${st.balance.toFixed(2)} | Eq:€${eq.toFixed(2)} | PnL:€${st.totalPnL.toFixed(2)} | WR:${wr}% | Kelly:${(kelly * 100).toFixed(0)}% | Daily:€${dailyPnL.toFixed(2)} (${dailyTrades}t)${liveState.dailyTradingPaused ? " 🛑PAUSED" : ""}`);
}

// Start live trading engine — check every 30 seconds
setInterval(liveTradeCheck, 30000);
setTimeout(liveTradeCheck, 3000);

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════

app.get("/api/markets", async (req, res) => {
  try {
    const cryptoIds = Object.entries(ASSETS).filter(([, a]) => a.type === "crypto");
    const stockIds = Object.entries(ASSETS).filter(([, a]) => a.type === "stock" || a.type === "stock_fast");
    const forexIds = Object.entries(ASSETS).filter(([, a]) => a.type === "forex");
    const commodityIds = Object.entries(ASSETS).filter(([, a]) => a.type === "commodity");
    const indexIds = Object.entries(ASSETS).filter(([, a]) => a.type === "index");

    const fetchBatch = (entries, yfSymFn) => Promise.allSettled(
      entries.map(async ([id, a]) => {
        try {
          const r = await yfChartFast(yfSymFn(id, a), "1d", "1d");
          const price = r.meta?.price || a.base;
          const prev = r.meta?.previousClose || a.base;
          return { symbol: id, name: a.name, type: a.type, volatile: a.volatile || false, price: +price.toFixed(4), change: +(price - prev).toFixed(4), changePercent: +(((price - prev) / prev) * 100).toFixed(2), volume: 0 };
        } catch {
          return { symbol: id, name: a.name, type: a.type, volatile: a.volatile || false, price: a.base, change: 0, changePercent: 0, volume: 0 };
        }
      })
    );

    const [cryptoR, stockR, forexR, commR, idxR] = await Promise.all([
      fetchBatch(cryptoIds, (id) => id + "-USD"),
      fetchBatch(stockIds, (id) => id),
      fetchBatch(forexIds, (id, a) => a.yfSym || id),
      fetchBatch(commodityIds, (id, a) => a.yfSym || id),
      fetchBatch(indexIds, (id, a) => a.yfSym || id),
    ]);

    const pick = (r) => r.filter((x) => x.status === "fulfilled").map((x) => x.value);
    res.json([...pick(cryptoR), ...pick(stockR), ...pick(forexR), ...pick(commR), ...pick(idxR)]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/chart/:symbol", async (req, res) => {
  try {
    const { symbol } = req.params;
    const { range = "3mo" } = req.query;
    const asset = ASSETS[symbol];
    let rawData;
    const yfSymbol = asset?.yfSym || (asset?.type === "crypto" ? symbol + "-USD" : symbol);
    try { rawData = (await yfChartFast(yfSymbol, range, "1d")).data; }
    catch { rawData = generateData(symbol, rangeDays[range] || 90, asset?.base || 100, asset?.vol || 0.02); }
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
  const st = getState();
  const totalEquity = getTotalEquity();
  const risk = getRiskProfile(totalEquity);
  const positionCount = getPositionCount();
  const openTrades = Object.entries(st.positions).map(([sym, p]) => {
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
      symbol: sym, name: ASSETS[sym]?.name || sym, type: ASSETS[sym]?.type || "unknown",
      volatile: ASSETS[sym]?.volatile || false,
      side: p.side, entryPrice: p.entryPrice, currentPrice: +currentPrice.toFixed(4),
      entryTime: p.entryTime, qty: p.qty, initialQty: p.initialQty || p.qty,
      tp: p.tp, sl: p.sl, cost: p.cost, partialTaken: p.partialTaken || false,
      unrealizedPnl: +unrealizedPnl.toFixed(4), unrealizedPnlPercent: +unrealizedPnlPercent.toFixed(2),
    };
  });

  const totalTrades = st.wins + st.losses;
  const winRate = totalTrades > 0 ? +((st.wins / totalTrades) * 100).toFixed(1) : 0;
  
  // NEW: Advanced metrics
  const kelly = getKellyCriterion();
  const dailyPnL = liveState.activeMode === "real" ? liveState.realDailyPnL : liveState.virtualDailyPnL;
  const dailyTrades = liveState.activeMode === "real" ? liveState.realDailyTrades : liveState.virtualDailyTrades;

  res.json({
    mode: liveState.activeMode,
    realBalance: +liveState.realBalance.toFixed(2),
    virtualBalance: +liveState.virtualBalance.toFixed(2),
    balance: +st.balance.toFixed(2),
    totalEquity: +totalEquity.toFixed(2),
    riskProfile: risk.name,
    totalPnL: +st.totalPnL.toFixed(2),
    totalPnLPercent: +((st.totalPnL / (totalEquity - st.totalPnL)) * 100).toFixed(2) || 0,
    wins: st.wins, losses: st.losses, winRate, totalTrades,
    strike: `${st.wins}W/${st.losses}L`,
    positionCount, maxPositions: risk.maxPos,
    openTrades,
    tradeHistory: st.tradeHistory.slice(0, 50),
    notifications: st.notifications.slice(0, 30),
    drawdown: +(st.peakBalance > 0 ? ((st.peakBalance - totalEquity) / st.peakBalance * 100) : 0).toFixed(2),
    equityMult: +getEquityMultiplier().toFixed(2),
    // NEW: Advanced metrics
    kelly: +(kelly * 100).toFixed(1),
    dailyPnL: +dailyPnL.toFixed(2),
    dailyTrades,
    dailyTradingPaused: liveState.dailyTradingPaused,
    maxDailyLoss: +(liveState.maxDailyLossPct * 100).toFixed(0),
  });
});

// ─── SWITCH MODE ─────────────────────────────────────────────
app.post("/api/switch-mode", (req, res) => {
  const { mode } = req.body;
  if (mode !== "real" && mode !== "virtual") return res.status(400).json({ error: "Invalid mode" });
  liveState.activeMode = mode;
  addNotification("info", "🔄 MODE", `Passage en mode ${mode === "real" ? "ARGENT RÉEL" : "ARGENT FICTIF"}`);
  res.json({ mode, realBalance: liveState.realBalance, virtualBalance: liveState.virtualBalance });
});

// ─── DEPOSIT / WITHDRAW ──────────────────────────────────────
app.post("/api/deposit", (req, res) => {
  const { mode, amount } = req.body;
  const a = parseFloat(amount);
  if (!a || a <= 0) return res.status(400).json({ error: "Invalid amount" });
  if (mode === "real") {
    liveState.realBalance += a;
    liveState.realDepositHistory.unshift({ id: Date.now(), type: "deposit", amount: a, balance: liveState.realBalance, time: new Date().toISOString() });
    addNotification("success", "💰 DÉPÔT RÉEL", `+€${a.toFixed(2)} → Solde: €${liveState.realBalance.toFixed(2)}`);
  } else {
    liveState.virtualBalance += a;
    liveState.virtualDepositHistory.unshift({ id: Date.now(), type: "deposit", amount: a, balance: liveState.virtualBalance, time: new Date().toISOString() });
    addNotification("success", "💰 DÉPÔT VIRTUEL", `+€${a.toFixed(2)} → Solde: €${liveState.virtualBalance.toFixed(2)}`);
  }
  res.json({ realBalance: liveState.realBalance, virtualBalance: liveState.virtualBalance });
});

app.post("/api/withdraw", (req, res) => {
  const { mode, amount } = req.body;
  const a = parseFloat(amount);
  if (!a || a <= 0) return res.status(400).json({ error: "Invalid amount" });
  if (mode === "real") {
    if (a > liveState.realBalance) return res.status(400).json({ error: "Insufficient balance" });
    liveState.realBalance -= a;
    liveState.realDepositHistory.unshift({ id: Date.now(), type: "withdraw", amount: -a, balance: liveState.realBalance, time: new Date().toISOString() });
    addNotification("info", "💸 RETRAIT RÉEL", `-$${a.toFixed(2)} → Solde: €${liveState.realBalance.toFixed(2)}`);
  } else {
    if (a > liveState.virtualBalance) return res.status(400).json({ error: "Insufficient balance" });
    liveState.virtualBalance -= a;
    liveState.virtualDepositHistory.unshift({ id: Date.now(), type: "withdraw", amount: -a, balance: liveState.virtualBalance, time: new Date().toISOString() });
    addNotification("info", "💸 RETRAIT VIRTUEL", `-$${a.toFixed(2)} → Solde: €${liveState.virtualBalance.toFixed(2)}`);
  }
  res.json({ realBalance: liveState.realBalance, virtualBalance: liveState.virtualBalance });
});

// ─── NOTIFICATIONS (polling) ────────────────────────────────
app.get("/api/notifications", (req, res) => {
  const since = parseInt(req.query.since || "0");
  const st = getState();
  const newNotifs = st.notifications.filter((n) => n.id > since);
  const latestId = st.notifications.length > 0 ? st.notifications[0].id : 0;
  res.json({ notifications: newNotifs, latestId });
});

// ─── RESET ──────────────────────────────────────────────────
app.post("/api/reset", (req, res) => {
  const mode = liveState.activeMode;
  if (mode === "real") {
    liveState.realBalance = 0;
    liveState.realPositions = {};
    liveState.realTradeHistory = [];
    liveState.realNotifications = [];
    liveState.realTotalPnL = 0;
    liveState.realWins = 0;
    liveState.realLosses = 0;
    liveState.realRecentPnL = [];
    liveState.realPeakBalance = 0;
    liveState.realDepositHistory = [];
    addNotification("info", "🔄 RESET RÉEL", `Argent réel réinitialisé à €0`);
  } else {
    liveState.virtualBalance = INITIAL_VIRTUAL;
    liveState.virtualPositions = {};
    liveState.virtualTradeHistory = [];
    liveState.virtualNotifications = [];
    liveState.virtualTotalPnL = 0;
    liveState.virtualWins = 0;
    liveState.virtualLosses = 0;
    liveState.virtualRecentPnL = [];
    liveState.virtualPeakBalance = INITIAL_VIRTUAL;
    liveState.virtualDepositHistory = [];
    addNotification("info", "🔄 RESET VIRTUEL", `Argent fictif réinitialisé à €${INITIAL_VIRTUAL}`);
  }
  res.json({ ok: true });
});

// ─── DEBUG ASSET ───────────────────────────────────────────
app.get("/api/debug/:symbol", async (req, res) => {
  const sym = req.params.symbol;
  const asset = ASSETS[sym];
  if (!asset) return res.json({ error: "Unknown symbol", available: Object.keys(ASSETS).slice(0, 20) });
  const yfSymbol = asset.yfSym || (asset.type === "crypto" ? sym + "-USD" : sym);
  let dataSource = "yf";
  let rawData;
  try {
    rawData = (await yfChartFast(yfSymbol, "3mo", "1d")).data;
  } catch (e) {
    dataSource = "simulated";
    rawData = generateData(sym, 90, asset.base, asset.vol);
  }
  if (!rawData || rawData.length < 50) return res.json({ error: "Not enough data", len: rawData?.length });
  const ana = computeIndicators(rawData);
  const result = analyzeDay(ana, ana.len - 1);
  res.json({
    sym, type: asset.type, dataSource,
    price: rawData[rawData.length - 1].close,
    dataLen: rawData.length,
    indicators: {
      atr: result?.atr,
    },
    longScore: result?.longScore, shortScore: result?.shortScore,
    tp: result?.tp, sl: result?.sl,
    shortTp: result?.shortTp, shortSl: result?.shortSl,
    volumeConfirm: result?.volumeConfirm,
    volNow: result?.volNow, volAvg: result?.volAvg,
    rsi: result?.rsi, bbPct: result?.bbPct, stochK: result?.stochK,
    longReasons: result?.longReasons, shortReasons: result?.shortReasons,
  });
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
    const st = getState();
    const live = {
      balance: st.balance,
      totalPnL: st.totalPnL,
      wins: st.wins,
      losses: st.losses,
      positions: Object.entries(st.positions).map(([s, p]) => ({
        symbol: s, side: p.side, entryPrice: p.entryPrice, tp: p.tp, sl: p.sl,
      })),
      recentTrades: st.tradeHistory.slice(0, 10),
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

// ═══════════════════════════════════════════════════════════════
// STRIPE: Credit Card Deposits
// ═══════════════════════════════════════════════════════════════
app.post("/api/stripe/checkout", async (req, res) => {
  if (!stripe) return res.status(500).json({ error: "Stripe not configured" });
  try {
    const { amount, mode } = req.body;
    const a = parseFloat(amount);
    if (!a || a < 5) return res.status(400).json({ error: "Minimum dépôt: €5" });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price_data: {
        currency: "eur",
        product_data: { name: `Dépôt TradBot (${mode === "real" ? "Argent Réel" : "Argent Virtuel"})`, description: `Dépôt de €${a.toFixed(2)} dans le mode ${mode}` },
        unit_amount: Math.round(a * 100),
      }, quantity: 1 }],
      mode: "payment",
      success_url: `${req.headers.origin || "https://tradbot-4fuj.onrender.com"}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin || "https://tradbot-4fuj.onrender.com"}?payment=cancelled`,
      metadata: { mode: mode || "virtual", amount: a },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Stripe webhook — confirm payment
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe) return res.status(200).send("No Stripe");
  try {
    const sig = req.headers["stripe-signature"];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;
    if (endpointSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } else {
      event = JSON.parse(req.body);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const mode = session.metadata?.mode || "virtual";
      const amount = parseFloat(session.metadata?.amount) || 0;

      if (mode === "real") {
        liveState.realBalance += amount;
        liveState.realDepositHistory.unshift({ id: Date.now(), type: "stripe_deposit", amount, balance: liveState.realBalance, time: new Date().toISOString() });
        addNotification("success", "💳 DÉPÔT STRIPE RÉEL", `+€${amount.toFixed(2)} via carte bancaire → Solde: €${liveState.realBalance.toFixed(2)}`);
      } else {
        liveState.virtualBalance += amount;
        liveState.virtualDepositHistory.unshift({ id: Date.now(), type: "stripe_deposit", amount, balance: liveState.virtualBalance, time: new Date().toISOString() });
        addNotification("success", "💳 DÉPÔT STRIPE VIRTUEL", `+€${amount.toFixed(2)} via carte bancaire → Solde: €${liveState.virtualBalance.toFixed(2)}`);
      }
    }
    res.json({ received: true });
  } catch (err) { res.json({ received: true }); }
});

// ═══════════════════════════════════════════════════════════════
// ALPACA: Real Trading
// ═══════════════════════════════════════════════════════════════
app.get("/api/alpaca/status", async (req, res) => {
  if (!alpaca) return res.json({ connected: false, message: "Alpaca not configured" });
  try {
    const account = await alpaca.getAccount();
    const positions = await alpaca.getPositions();
    const orders = await alpaca.getOrders({ status: "open" });
    res.json({
      connected: true,
      paper: process.env.ALPACA_PAPER !== "false",
      accountId: account.id,
      status: account.status,
      equity: parseFloat(account.equity),
      cash: parseFloat(account.cash),
      buyingPower: parseFloat(account.buying_power),
      dayPnL: parseFloat(account.equity) - parseFloat(account.last_equity),
      dayPnLPercent: ((parseFloat(account.equity) - parseFloat(account.last_equity)) / parseFloat(account.last_equity) * 100).toFixed(2),
      positionsCount: positions.length,
      openOrdersCount: orders.length,
      positions: positions.map(p => ({
        symbol: p.symbol, side: p.side, qty: p.qty,
        avgEntry: parseFloat(p.avg_entry_price),
        currentPrice: parseFloat(p.current_price),
        pnl: parseFloat(p.unrealized_pl),
        pnlPercent: parseFloat(p.unrealized_plpc) * 100,
      })),
    });
  } catch (err) { res.json({ connected: false, error: err.message }); }
});

app.post("/api/alpaca/buy", async (req, res) => {
  if (!alpaca) return res.status(500).json({ error: "Alpaca not configured" });
  try {
    const { symbol, notional } = req.body;
    const order = await alpaca.createOrder({
      symbol, notional: parseFloat(notional),
      side: "buy", type: "market", time_in_force: "day",
    });
    addNotification("success", `🟢 ALPACA BUY ${symbol}`, `Ordre passé: $${notional}`);
    res.json({ orderId: order.id, status: order.status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/alpaca/sell", async (req, res) => {
  if (!alpaca) return res.status(500).json({ error: "Alpaca not configured" });
  try {
    const { symbol, qty } = req.body;
    const order = await alpaca.createOrder({
      symbol, qty: qty.toString(),
      side: "sell", type: "market", time_in_force: "day",
    });
    addNotification("info", `🔴 ALPACA SELL ${symbol}`, `Ordre passé: ${qty} actions`);
    res.json({ orderId: order.id, status: order.status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SPA catch-all — serve index.html for any non-API route
app.get("*", (req, res) => {
  res.sendFile(join(__dirname, "../client/dist/index.html"));
});
