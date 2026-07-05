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
  "CRM":   { name: "Salesforce",  base: 270,  vol: 0.018, type: "stock" },
  "PANW":  { name: "Palo Alto",   base: 340,  vol: 0.022, type: "stock" },
  "SNOW":  { name: "Snowflake",   base: 170,  vol: 0.03,  type: "stock" },
  "DASH":  { name: "DoorDash",    base: 140,  vol: 0.03,  type: "stock" },
  "RBLX":  { name: "Roblox",      base: 45,   vol: 0.04,  type: "stock" },
  "SPOT":  { name: "Spotify",     base: 310,  vol: 0.025, type: "stock" },
  "DKNG":  { name: "DraftKings",  base: 38,   vol: 0.035, type: "stock" },
  "AI":    { name: "C3.ai",       base: 25,   vol: 0.05,  type: "stock" },
  "ZS":    { name: "Zscaler",     base: 200,  vol: 0.025, type: "stock" },
  "MDB":   { name: "MongoDB",     base: 260,  vol: 0.028, type: "stock" },
  "UPST":  { name: "Upstart",     base: 55,   vol: 0.05,  type: "stock" },
  "LCID":  { name: "Lucid",       base: 3.5,  vol: 0.06,  type: "stock" },
  "W":     { name: "Wayfair",     base: 55,   vol: 0.04,  type: "stock" },
  "TOST":  { name: "Toast",       base: 30,   vol: 0.035, type: "stock" },
  "BILL":  { name: "Bill.com",    base: 65,   vol: 0.035, type: "stock" },
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
  "BYND":  { name: "Beyond Meat", base: 8,    vol: 0.07,  type: "stock_fast", maxHold: 120 },
  "U":     { name: "Unity",       base: 22,   vol: 0.05,  type: "stock_fast", maxHold: 120 },
  "ARM":   { name: "ARM",         base: 170,  vol: 0.04,  type: "stock_fast", maxHold: 90 },
  "IONQ":  { name: "IonQ",        base: 35,   vol: 0.06,  type: "stock_fast", maxHold: 90 },
  "SMCI":  { name: "SuperMicro",  base: 500,  vol: 0.055, type: "stock_fast", maxHold: 90 },
  // ── CRYPTO (verified on Yahoo Finance) ──
  "BTC":   { name: "Bitcoin",     base: 62000, vol: 0.025, type: "crypto" },
  "ETH":   { name: "Ethereum",    base: 3400,  vol: 0.03,  type: "crypto" },
  "SOL":   { name: "Solana",      base: 150,   vol: 0.035, type: "crypto" },
  "XRP":   { name: "XRP",         base: 0.52,  vol: 0.03,  type: "crypto" },
  "DOGE":  { name: "Dogecoin",    base: 0.15,  vol: 0.04,  type: "crypto" },
  "ADA":   { name: "Cardano",     base: 0.45,  vol: 0.035, type: "crypto" },
  "AVAX":  { name: "Avalanche",   base: 35,    vol: 0.035, type: "crypto" },
  "LINK":  { name: "Chainlink",   base: 14,    vol: 0.03,  type: "crypto" },
  "UNI":   { name: "Uniswap",     base: 7.5,   vol: 0.035, type: "crypto" },
  "AAVE":  { name: "Aave",        base: 95,    vol: 0.035, type: "crypto" },
  "LTC":   { name: "Litecoin",    base: 85,    vol: 0.03,  type: "crypto" },
  "SHIB":  { name: "Shiba Inu",   base: 0.000025, vol: 0.07, type: "crypto" },
  "TRX":   { name: "Tron",        base: 0.12,  vol: 0.03,  type: "crypto" },
  "HBAR":  { name: "Hedera",      base: 0.08,  vol: 0.04,  type: "crypto" },
  "ICP":   { name: "ICP",         base: 12,    vol: 0.045, type: "crypto" },
  "APT":   { name: "Aptos",       base: 8,     vol: 0.045, type: "crypto" },
  "SUI":   { name: "Sui",         base: 3,     vol: 0.05,  type: "crypto" },
  "NEAR":  { name: "NEAR",        base: 5.5,   vol: 0.045, type: "crypto" },
  "PEPE":  { name: "Pepe",        base: 0.000012, vol: 0.06, type: "crypto" },
  "FIL":   { name: "Filecoin",    base: 5.5,   vol: 0.045, type: "crypto" },
  "RENDER":{ name: "Render",      base: 8,     vol: 0.045, type: "crypto" },
  "FET":   { name: "Fetch.ai",    base: 2.2,   vol: 0.05,  type: "crypto" },
  "INJ":   { name: "Injective",   base: 25,    vol: 0.045, type: "crypto" },
  "TIA":   { name: "Celestia",    base: 10,    vol: 0.05,  type: "crypto" },
  "SEI":   { name: "Sei",         base: 0.5,   vol: 0.055, type: "crypto" },
  "OP":    { name: "Optimism",    base: 2.3,   vol: 0.045, type: "crypto" },
  "GALA":  { name: "Gala",        base: 0.04,  vol: 0.055, type: "crypto" },
  "SAND":  { name: "Sandbox",     base: 0.5,   vol: 0.05,  type: "crypto" },
  "MANA":  { name: "Decentraland",base: 0.5,   vol: 0.05,  type: "crypto" },
  "CRV":   { name: "Curve",       base: 0.5,   vol: 0.045, type: "crypto" },
  "MKR":   { name: "Maker",       base: 2800,  vol: 0.03,  type: "crypto" },
  "BCH":   { name: "Bitcoin Cash",base: 480,   vol: 0.03,  type: "crypto" },
  "ETC":   { name: "Ethereum Classic", base: 25, vol: 0.035, type: "crypto" },
  "ATOM":  { name: "Cosmos",      base: 8,     vol: 0.04,  type: "crypto" },
  "DOT":   { name: "Polkadot",    base: 7,     vol: 0.04,  type: "crypto" },
  "MATIC": { name: "Polygon",     base: 0.7,   vol: 0.045, type: "crypto" },
  "BNB":   { name: "BNB",         base: 590,   vol: 0.02,  type: "crypto" },
  // ── FOREX ──
  "EURUSD": { name: "EUR/USD",    base: 1.09,  vol: 0.005, type: "forex", yfSym: "EURUSD=X" },
  "GBPUSD": { name: "GBP/USD",    base: 1.27,  vol: 0.006, type: "forex", yfSym: "GBPUSD=X" },
  "USDJPY": { name: "USD/JPY",    base: 161,   vol: 0.006, type: "forex", yfSym: "USDJPY=X" },
  "AUDUSD": { name: "AUD/USD",    base: 0.65,  vol: 0.007, type: "forex", yfSym: "AUDUSD=X" },
  "USDCAD": { name: "USD/CAD",    base: 1.37,  vol: 0.005, type: "forex", yfSym: "USDCAD=X" },
  "USDCHF": { name: "USD/CHF",    base: 0.89,  vol: 0.005, type: "forex", yfSym: "USDCHF=X" },
  "NZDUSD": { name: "NZD/USD",    base: 0.60,  vol: 0.007, type: "forex", yfSym: "NZDUSD=X" },
  "EURGBP": { name: "EUR/GBP",    base: 0.86,  vol: 0.004, type: "forex", yfSym: "EURGBP=X" },
  "EURJPY": { name: "EUR/JPY",    base: 175,   vol: 0.006, type: "forex", yfSym: "EURJPY=X" },
  "GBPJPY": { name: "GBP/JPY",    base: 205,   vol: 0.008, type: "forex", yfSym: "GBPJPY=X" },
  // ── MATIERES PREMIERES ──
  "GOLD":   { name: "Or",         base: 2400,  vol: 0.012, type: "commodity", yfSym: "GC=F" },
  "SILVER": { name: "Argent",     base: 30,    vol: 0.02,  type: "commodity", yfSym: "SI=F" },
  "OIL":    { name: "Pétrole WTI", base: 80,   vol: 0.025, type: "commodity", yfSym: "CL=F" },
  "GAS":    { name: "Gaz Naturel", base: 2.5,  vol: 0.04,  type: "commodity", yfSym: "NG=F" },
  "COPPER": { name: "Cuivre",     base: 4.5,   vol: 0.018, type: "commodity", yfSym: "HG=F" },
  "PLAT":   { name: "Platine",    base: 1000,  vol: 0.02,  type: "commodity", yfSym: "PL=F" },
  // ── INDICES ──
  "SPX":    { name: "S&P 500",    base: 5500,  vol: 0.008, type: "index", yfSym: "^GSPC" },
  "NDX":    { name: "Nasdaq 100", base: 20000, vol: 0.012, type: "index", yfSym: "^NDX" },
  "DJI":    { name: "Dow Jones",  base: 40000, vol: 0.008, type: "index", yfSym: "^DJI" },
  "RUT":    { name: "Russell 2000", base: 2200, vol: 0.014, type: "index", yfSym: "^RUT" },
  "VIX":    { name: "VIX",        base: 14,    vol: 0.06,  type: "index", yfSym: "^VIX" },
  "FTSE":   { name: "FTSE 100",   base: 8200,  vol: 0.008, type: "index", yfSym: "^FTSE" },
  "DAX":    { name: "DAX",        base: 18500, vol: 0.009, type: "index", yfSym: "^GDAXI" },
  "NIKKEI": { name: "Nikkei 225", base: 39500, vol: 0.01,  type: "index", yfSym: "^N225" },
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
const MAX_POSITIONS = 25;
const MAX_CRYPTO = 8;
const MAX_STOCKS = 3;
const MAX_STOCK_FAST = 4;
const INITIAL_BALANCE = 10000;

const liveState = {
  balance: INITIAL_BALANCE,
  positions: {},
  tradeHistory: [],
  notifications: [],
  totalPnL: 0,
  wins: 0,
  losses: 0,
  currentPrices: {},
  lastExitTime: {},
  peakBalance: INITIAL_BALANCE,
  recentPnL: [],
};

// ── CORRELATION GROUPS (max 2 per group) ──
const CORR_GROUPS = {
  BTC_ECO: ["BTC", "MSTR", "MARA", "RIOT", "BCH", "ETC"],
  ETH_ECO: ["ETH", "UNI", "AAVE", "MKR", "LINK", "OP", "ARB"],
  L1_ALTS: ["SOL", "AVAX", "ADA", "DOT", "ATOM", "NEAR", "APT", "SUI", "SEI", "INJ", "TIA", "FIL"],
  MEME: ["DOGE", "SHIB", "PEPE", "GALA", "SAND", "MANA", "CRV"],
  RENDER_AI: ["RENDER", "FET", "ICP", "HBAR", "TRX"],
  US_TECH: ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "AMD"],
  US_GROWTH: ["TSLA", "NFLX", "CRM", "PANW", "SNOW", "ZS", "MDB", "PLTR", "CRWD", "NET"],
  US_CONSUMER: ["DIS", "UBER", "SHOP", "COIN", "SQ", "ABNB", "SPOT", "DKNG"],
  US_SPECUL: ["GME", "AMC", "SOFI", "HOOD", "CVNA", "PLUG", "BYND", "U", "NIO", "LCID", "W", "RIVN", "SNAP", "ZM", "TOST", "BILL", "UPST", "INTC", "BA", "PYPL", "AI", "RBLX", "DASH", "ARM", "IONQ", "SMCI", "ROKU"],
  FOREX_MAJOR: ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD"],
  FOREX_CROSS: ["EURGBP", "EURJPY", "GBPJPY"],
  US_INDICES: ["SPX", "NDX", "DJI", "RUT"],
  EU_INDICES: ["FTSE", "DAX"],
  COMMODITY_METALS: ["GOLD", "SILVER", "COPPER", "PLAT"],
  COMMODITY_ENERGY: ["OIL", "GAS"],
};

function getCorrelationGroup(sym) {
  for (const [group, syms] of Object.entries(CORR_GROUPS)) {
    if (syms.includes(sym)) return group;
  }
  return null;
}

function getGroupCount(group) {
  return Object.keys(liveState.positions).filter(s => getCorrelationGroup(s) === group).length;
}

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
  const volNow = getVal(volumes, i);
  const volAvg = getVal(volSma20, vI);

  if (rsiVal == null || !macdCurr || !bbVal || !ema20Val || !ema50Val || !atrVal || !stochVal) return null;

  const uptrend = ema20Val > ema50Val && (sma200Val == null || price > sma200Val);
  const downtrend = ema20Val < ema50Val && (sma200Val == null || price < sma200Val);
  const bbPct = (price - bbVal.lower) / (bbVal.upper - bbVal.lower);
  const volumeConfirm = volNow && volAvg ? volNow > volAvg * 0.8 : true;

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

  if (!uptrend && rsiVal < 25 && bbPct < 0.05) {
    longScore += 3; longReasons.push("Extreme oversold bounce");
  }
  if (!downtrend && rsiVal > 80 && bbPct > 0.95) {
    shortScore += 3; shortReasons.push("Extreme overbought rejection");
  }

  const tp = +(price + atrVal * 1.5).toFixed(4);
  const sl = +(price - atrVal * 1.5).toFixed(4);
  const shortTp = +(price - atrVal * 1.5).toFixed(4);
  const shortSl = +(price + atrVal * 1.5).toFixed(4);

  return { longScore, shortScore, longReasons, shortReasons, atr: atrVal, tp, sl, shortTp, shortSl, price, volumeConfirm };
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
  const recent = liveState.recentPnL.slice(-10);
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

// ─── LIVE TRADE CHECK (runs every 10s) ──────────────────────
async function liveTradeCheck() {
  const symbols = Object.keys(ASSETS);

  for (const sym of symbols) {
    try {
      const asset = ASSETS[sym];
      let rawData;
      const yfSymbol = asset?.yfSym || (asset?.type === "crypto" ? sym + "-USD" : sym);
      try { rawData = (await yfChartFast(yfSymbol, "3mo", "1d")).data; }
      catch { continue; }
      if (!rawData || rawData.length < 50) continue;

      const ana = computeIndicators(rawData);
      const result = analyzeDay(ana, ana.len - 1);
      const currentPrice = result ? result.price : rawData[rawData.length - 1].close;
      liveState.currentPrices[sym] = currentPrice;
      if (!result) continue;

      const pos = liveState.positions[sym];
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
          if (currentPrice > bestPrice) { liveState.positions[sym].bestPrice = currentPrice; }
          const newBest = Math.max(bestPrice, currentPrice);
          const trailDistance = atrVal * 1.5;
          if (newBest > pos.entryPrice + atrVal * 0.75) {
            const newTrailSl = +(newBest - trailDistance).toFixed(4);
            if (newTrailSl > pos.sl) { liveState.positions[sym].sl = newTrailSl; }
          }
          // partial TP: sell 50% at 0.75× ATR profit
          if (!pos.partialTaken && currentPrice >= pos.entryPrice + atrVal * 0.75) {
            partialExit = true;
            const halfQty = +(pos.qty / 2).toFixed(8);
            const pnl = halfQty * (currentPrice - pos.entryPrice);
            const costReturned = halfQty * pos.entryPrice;
            liveState.balance += costReturned + pnl;
            liveState.totalPnL += pnl;
            liveState.recentPnL.push(pnl);
            if (pnl > 0) liveState.wins++; else liveState.losses++;
            liveState.positions[sym].qty = pos.qty - halfQty;
            liveState.positions[sym].cost = (pos.qty - halfQty) * pos.entryPrice;
            liveState.positions[sym].partialTaken = true;
            liveState.positions[sym].sl = pos.entryPrice;
            liveState.tradeHistory.unshift({
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
          if (currentPrice < bestPrice) { liveState.positions[sym].bestPrice = currentPrice; }
          const newBest = Math.min(bestPrice, currentPrice);
          const trailDistance = atrVal * 1.5;
          if (newBest < pos.entryPrice - atrVal * 0.75) {
            const newTrailSl = +(newBest + trailDistance).toFixed(4);
            if (newTrailSl < pos.sl) { liveState.positions[sym].sl = newTrailSl; }
          }
          if (!pos.partialTaken && currentPrice <= pos.entryPrice - atrVal * 0.75) {
            partialExit = true;
            const halfQty = +(pos.qty / 2).toFixed(8);
            const pnl = halfQty * (pos.entryPrice - currentPrice);
            const costReturned = halfQty * pos.entryPrice;
            liveState.balance += costReturned + pnl;
            liveState.totalPnL += pnl;
            liveState.recentPnL.push(pnl);
            if (pnl > 0) liveState.wins++; else liveState.losses++;
            liveState.positions[sym].qty = pos.qty - halfQty;
            liveState.positions[sym].cost = (pos.qty - halfQty) * pos.entryPrice;
            liveState.positions[sym].partialTaken = true;
            liveState.positions[sym].sl = pos.entryPrice;
            liveState.tradeHistory.unshift({
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
          const posNow = liveState.positions[sym];
          if (posNow) {
            if (posNow.side === "LONG") {
              if (currentPrice <= posNow.sl) { shouldExit = true; exitPrice = posNow.sl; exitReason = "SL"; }
              else if (currentPrice >= posNow.tp) { shouldExit = true; exitPrice = posNow.tp; exitReason = "TP"; }
              else if (result.shortScore >= 4 && holdMinutes >= 10) { shouldExit = true; exitReason = "REVERSE"; }
            } else {
              if (currentPrice >= posNow.sl) { shouldExit = true; exitPrice = posNow.sl; exitReason = "SL"; }
              else if (currentPrice <= posNow.tp) { shouldExit = true; exitPrice = posNow.tp; exitReason = "TP"; }
              else if (result.longScore >= 4 && holdMinutes >= 10) { shouldExit = true; exitReason = "REVERSE"; }
            }
          }
        }

        if (shouldExit) {
          const posFinal = liveState.positions[sym];
          if (!posFinal) continue;
          let pnl, pct;
          if (posFinal.side === "LONG") {
            pnl = posFinal.qty * (exitPrice - posFinal.entryPrice);
            pct = ((exitPrice - posFinal.entryPrice) / posFinal.entryPrice) * 100;
          } else {
            pnl = posFinal.qty * (posFinal.entryPrice - exitPrice);
            pct = ((posFinal.entryPrice - exitPrice) / posFinal.entryPrice) * 100;
          }
          liveState.balance += posFinal.cost + pnl;
          liveState.totalPnL += pnl;
          liveState.recentPnL.push(pnl);
          if (liveState.recentPnL.length > 20) liveState.recentPnL.shift();
          if (pnl > 0) liveState.wins++; else liveState.losses++;

          const trade = {
            id: Date.now(), symbol: sym, side: posFinal.side, exitReason,
            entryPrice: posFinal.entryPrice, exitPrice, qty: posFinal.qty,
            entryTime: posFinal.entryTime, exitTime: new Date().toISOString(),
            pnl: +pnl.toFixed(4), pnlPercent: +pct.toFixed(2),
            holdMinutes: Math.round((Date.now() - new Date(posFinal.entryTime).getTime()) / 60000),
          };
          liveState.tradeHistory.unshift(trade);
          delete liveState.positions[sym];
          liveState.lastExitTime[sym] = Date.now();

          if (liveState.balance > liveState.peakBalance) liveState.peakBalance = liveState.balance;

          const emoji = pnl >= 0 ? "✅" : "❌";
          const sideLabel = posFinal.side === "LONG" ? "LONG" : "SHORT";
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
      const isForex = asset?.type === "forex";
      const isCommodity = asset?.type === "commodity";
      const isIndex = asset?.type === "index";

      // ── DRAWDOWN ADAPTIVE LIMITS ──
      const drawdown = (liveState.peakBalance - liveState.balance) / liveState.peakBalance;
      const tradingPaused = drawdown > 0.15;
      const inDrawdown = drawdown > 0.10;
      const maxPos = inDrawdown ? Math.max(8, Math.floor(MAX_POSITIONS * 0.5)) : MAX_POSITIONS;
      const maxCr = inDrawdown ? Math.max(3, Math.floor(MAX_CRYPTO * 0.5)) : MAX_CRYPTO;

      const atMax = getPositionCount() >= maxPos;
      const cryptoLimit = isCrypto && getCryptoCount() >= maxCr;
      const stockLimit = isStock && getStockCount() >= MAX_STOCKS;
      const fastLimit = isFast && getStockFastCount() >= MAX_STOCK_FAST;
      const marketClosed = (isStock || isFast || isCommodity || isIndex) && !isStockMarketOpen();
      const forexClosed = isForex && !isForexOpen();
      const cooldownActive = liveState.lastExitTime[sym] && (Date.now() - liveState.lastExitTime[sym]) < 30 * 60 * 1000;

      // ── CORRELATION FILTER ──
      const corrGroup = getCorrelationGroup(sym);
      const corrLimit = corrGroup ? getGroupCount(corrGroup) >= 2 : false;

      // ── MIN SCORE BY TYPE ──
      const baseMinScore = isCrypto ? 4 : 3;
      const minScore = drawdown > 0.10 ? baseMinScore + 2 : baseMinScore;

      // ── VOLUME CONFIRMATION ──
      const volumeOk = result.volumeConfirm;

      // ── RISK/REWARD CHECK ──
      let rrOk = true;
      if (result.longScore >= minScore) {
        const risk = currentPrice - result.sl;
        const reward = result.tp - currentPrice;
        rrOk = risk > 0 && (reward / risk) >= 1.3;
      }
      if (result.shortScore >= minScore && rrOk) {
        const risk = result.shortSl - currentPrice;
        const reward = currentPrice - result.shortTp;
        rrOk = risk > 0 && (reward / risk) >= 1.3;
      }

      // ── EQUITY CURVE MULTIPLIER ──
      const equityMult = getEquityMultiplier();

      if (!pos && !atMax && !cryptoLimit && !stockLimit && !fastLimit && !marketClosed && !forexClosed && !cooldownActive && !corrLimit && !tradingPaused) {
        if (result.longScore >= minScore && volumeOk && rrOk && liveState.balance > 50) {
          const confidence = Math.min(result.longScore, 10);
          const baseRatio = 0.04 + (confidence - minScore) * 0.02;
          const spendRatio = Math.min(baseRatio, 0.15) * equityMult;
          const spend = liveState.balance * spendRatio;
          const qty = +(spend / currentPrice).toFixed(8);
          const cost = qty * currentPrice;

          let tpFinal, slFinal;
          if (isFast) { tpFinal = +(currentPrice + atrVal * 1.5).toFixed(4); slFinal = +(currentPrice - atrVal * 1.2).toFixed(4); }
          else if (isStock) { tpFinal = +(currentPrice + atrVal * 2).toFixed(4); slFinal = +(currentPrice - atrVal * 1.5).toFixed(4); }
          else { tpFinal = result.tp; slFinal = result.sl; }

          liveState.positions[sym] = {
            side: "LONG", entryTime: new Date().toISOString(),
            entryPrice: currentPrice, qty, cost,
            tp: tpFinal, sl: slFinal,
            bestPrice: currentPrice, partialTaken: false, initialQty: qty,
          };
          liveState.balance -= cost;

          const tag = isCrypto ? "₿" : isFast ? "⚡" : asset?.type === "forex" ? "💱" : asset?.type === "commodity" ? "🥇" : asset?.type === "index" ? "📈" : "📊";
          addNotification("info", `${tag} LONG ${sym}`, `Acheté $${currentPrice.toFixed(2)} | Qty: ${qty} | TP: $${tpFinal} | SL: $${slFinal} | Score: ${result.longScore}`);
        } else if (result.shortScore >= minScore && volumeOk && rrOk && liveState.balance > 50) {
          const confidence = Math.min(result.shortScore, 10);
          const baseRatio = 0.04 + (confidence - minScore) * 0.02;
          const spendRatio = Math.min(baseRatio, 0.15) * equityMult;
          const spend = liveState.balance * spendRatio;
          const qty = +(spend / currentPrice).toFixed(8);
          const cost = qty * currentPrice;

          let shortTpFinal, shortSlFinal;
          if (isFast) { shortTpFinal = +(currentPrice - atrVal * 1.5).toFixed(4); shortSlFinal = +(currentPrice + atrVal * 1.2).toFixed(4); }
          else if (isStock) { shortTpFinal = +(currentPrice - atrVal * 2).toFixed(4); shortSlFinal = +(currentPrice + atrVal * 1.5).toFixed(4); }
          else { shortTpFinal = result.shortTp; shortSlFinal = result.shortSl; }

          liveState.positions[sym] = {
            side: "SHORT", entryTime: new Date().toISOString(),
            entryPrice: currentPrice, qty, cost,
            tp: shortTpFinal, sl: shortSlFinal,
            bestPrice: currentPrice, partialTaken: false, initialQty: qty,
          };
          liveState.balance -= cost;

          const tag = isCrypto ? "₿" : isFast ? "⚡" : asset?.type === "forex" ? "💱" : asset?.type === "commodity" ? "🥇" : asset?.type === "index" ? "📈" : "📊";
          addNotification("info", `${tag} SHORT ${sym}`, `Vendu $${currentPrice.toFixed(2)} | Qty: ${qty} | TP: $${shortTpFinal} | SL: $${shortSlFinal} | Score: ${result.shortScore}`);
        }
      }
    } catch (err) {
      console.log(`[SKIP] ${sym}: ${err.message}`);
    }
  }
  console.log(`[CYCLE] Pos: ${getPositionCount()}/${MAX_POSITIONS} | Bal: €${liveState.balance.toFixed(2)} | PnL: €${liveState.totalPnL.toFixed(2)} | WinRate: ${liveState.wins + liveState.losses > 0 ? ((liveState.wins / (liveState.wins + liveState.losses)) * 100).toFixed(0) : 0}% | EqMult: ${getEquityMultiplier().toFixed(2)}x`);
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
          return { symbol: id, name: a.name, type: a.type, price: +price.toFixed(4), change: +(price - prev).toFixed(4), changePercent: +(((price - prev) / prev) * 100).toFixed(2), volume: 0 };
        } catch {
          return { symbol: id, name: a.name, type: a.type, price: a.base, change: 0, changePercent: 0, volume: 0 };
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
      type: ASSETS[sym]?.type || "unknown",
      side: p.side,
      entryPrice: p.entryPrice,
      currentPrice: +currentPrice.toFixed(4),
      entryTime: p.entryTime,
      qty: p.qty,
      initialQty: p.initialQty || p.qty,
      tp: p.tp,
      sl: p.sl,
      cost: p.cost,
      partialTaken: p.partialTaken || false,
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
    drawdown: +(((liveState.peakBalance - liveState.balance) / liveState.peakBalance) * 100).toFixed(2),
    equityMult: +getEquityMultiplier().toFixed(2),
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
  liveState.recentPnL = [];
  liveState.peakBalance = INITIAL_BALANCE;
  addNotification("info", "🔄 RESET", `Compte réinitialisé à €${INITIAL_BALANCE}`);
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
