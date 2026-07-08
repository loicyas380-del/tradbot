import "dotenv/config";
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  RSI, MACD, BollingerBands, EMA, SMA, ATR, Stochastic,
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
  "AI":    { name: "C3.ai",       base: 25,   vol: 0.05,  type: "stock", volatile: true },
  "ZS":    { name: "Zscaler",     base: 200,  vol: 0.025, type: "stock" },
  "MDB":   { name: "MongoDB",     base: 260,  vol: 0.028, type: "stock" },
  "UPST":  { name: "Upstart",     base: 55,   vol: 0.05,  type: "stock", volatile: true },
  "LCID":  { name: "Lucid",       base: 3.5,  vol: 0.06,  type: "stock", volatile: true },
  "W":     { name: "Wayfair",     base: 55,   vol: 0.04,  type: "stock" },
  "TOST":  { name: "Toast",       base: 30,   vol: 0.035, type: "stock" },
  "BILL":  { name: "Bill.com",    base: 65,   vol: 0.035, type: "stock" },
  // ── STOCKS VOLATILES (quick trades 1-2h) ──
  "MSTR":  { name: "MicroStrategy", base: 1800, vol: 0.05, type: "stock_fast", maxHold: 90, volatile: true },
  "SOFI":  { name: "SoFi",        base: 8,    vol: 0.045, type: "stock_fast", maxHold: 120, volatile: true },
  "HOOD":  { name: "Robinhood",   base: 22,   vol: 0.05,  type: "stock_fast", maxHold: 90, volatile: true },
  "ROKU":  { name: "Roku",        base: 65,   vol: 0.045, type: "stock_fast", maxHold: 120, volatile: true },
  "U":     { name: "Unity",       base: 22,   vol: 0.05,  type: "stock_fast", maxHold: 120, volatile: true },
  "ARM":   { name: "ARM",         base: 170,  vol: 0.04,  type: "stock_fast", maxHold: 90, volatile: true },
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
  "SHIB":  { name: "Shiba Inu",   base: 0.000025, vol: 0.07, type: "crypto", volatile: true },
  "TRX":   { name: "Tron",        base: 0.12,  vol: 0.03,  type: "crypto" },
  "HBAR":  { name: "Hedera",      base: 0.08,  vol: 0.04,  type: "crypto" },
  "ICP":   { name: "ICP",         base: 12,    vol: 0.045, type: "crypto" },
  "APT":   { name: "Aptos",       base: 8,     vol: 0.045, type: "crypto" },
  "SUI":   { name: "Sui",         base: 3,     vol: 0.05,  type: "crypto", volatile: true },
  "NEAR":  { name: "NEAR",        base: 5.5,   vol: 0.045, type: "crypto" },
  "PEPE":  { name: "Pepe",        base: 0.000012, vol: 0.06, type: "crypto", volatile: true },
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
  // ── CRYPTO SUPPLEMENTAIRES ──
  "BONK":  { name: "Bonk",        base: 0.00002, vol: 0.08, type: "crypto", volatile: true },
  "FLOKI": { name: "Floki",       base: 0.00018, vol: 0.07, type: "crypto", volatile: true },
  "TURBO": { name: "Turbo",       base: 0.005,  vol: 0.09, type: "crypto", volatile: true },
  "BRETT": { name: "Brett",       base: 0.15,   vol: 0.08, type: "crypto", volatile: true },
  "ARB":   { name: "Arbitrum",    base: 1.1,    vol: 0.045, type: "crypto" },
  "PYTH":  { name: "Pyth Network",base: 0.4,    vol: 0.06, type: "crypto", volatile: true },
  "JUP":   { name: "Jupiter",     base: 0.8,    vol: 0.065, type: "crypto", volatile: true },
  "WORM":  { name: "Wormhole",     base: 0.5,    vol: 0.07, type: "crypto", volatile: true },
  "THETA": { name: "Theta",       base: 2,      vol: 0.055, type: "crypto", volatile: true },
  "ENJ":   { name: "Enjin",       base: 0.35,   vol: 0.06, type: "crypto", volatile: true },
  "AXS":   { name: "Axie",        base: 7,      vol: 0.055, type: "crypto", volatile: true },
  "CHZ":   { name: "Chiliz",      base: 0.12,   vol: 0.06, type: "crypto", volatile: true },
  "BAT":   { name: "Basic Attention", base: 0.2, vol: 0.055, type: "crypto", volatile: true },
  "COMP":  { name: "Compound",    base: 55,     vol: 0.045, type: "crypto" },
  "EOS":   { name: "EOS",         base: 0.7,    vol: 0.045, type: "crypto" },
  "XLM":   { name: "Stellar",     base: 0.12,   vol: 0.045, type: "crypto" },
  "XMR":   { name: "Monero",      base: 165,    vol: 0.035, type: "crypto" },
  "DASH":  { name: "Dash",        base: 28,     vol: 0.045, type: "crypto" },
  "LDO":   { name: "Lido",        base: 2,      vol: 0.055, type: "crypto" },
  "RPL":   { name: "Rocket Pool", base: 22,     vol: 0.055, type: "crypto" },
  "WIF":   { name: "dogwifhat",   base: 2,      vol: 0.09, type: "crypto" },
  "NEIRO": { name: "Neiro",       base: 0.0002, vol: 0.10, type: "crypto" },
  "STX":   { name: "Stacks",      base: 2,      vol: 0.055, type: "crypto" },
  "RUNE":  { name: "THORChain",   base: 5,      vol: 0.055, type: "crypto" },
  "KAVA":  { name: "Kava",        base: 0.7,    vol: 0.05, type: "crypto" },
  "ALGO":  { name: "Algorand",    base: 0.18,   vol: 0.05, type: "crypto" },
  "VET":   { name: "VeChain",     base: 0.035,  vol: 0.05, type: "crypto" },
  "FTM":   { name: "Fantom",      base: 0.4,    vol: 0.06, type: "crypto", volatile: true },
  "SAND":  { name: "Sandbox",     base: 0.5,    vol: 0.05,  type: "crypto" },
  "IMX":   { name: "Immutable",   base: 1.5,    vol: 0.06, type: "crypto", volatile: true },
  "BLUR":  { name: "Blur",        base: 0.3,    vol: 0.07, type: "crypto", volatile: true },
  "ZRO":   { name: "LayerZero",   base: 4,      vol: 0.065, type: "crypto", volatile: true },
  "STRK":  { name: "Starknet",    base: 0.6,    vol: 0.065, type: "crypto", volatile: true },
  "SAGA":  { name: "Saga",        base: 1.5,    vol: 0.07, type: "crypto", volatile: true },
  "WLD":   { name: "Worldcoin",   base: 2,      vol: 0.07, type: "crypto", volatile: true },
  "TAO":   { name: "Bittensor",   base: 300,    vol: 0.06, type: "crypto", volatile: true },
  "AKT":   { name: "Akash",       base: 3.5,    vol: 0.065, type: "crypto", volatile: true },
  "OCEAN": { name: "Ocean",       base: 0.6,    vol: 0.06, type: "crypto", volatile: true },
  "GRT":   { name: "Graph",       base: 0.25,   vol: 0.055, type: "crypto", volatile: true },
  // ── ACTIONS SUPPLEMENTAIRES ──
  "BABA":  { name: "Alibaba",     base: 85,    vol: 0.03,  type: "stock" },
  "JD":    { name: "JD.com",      base: 28,    vol: 0.035, type: "stock" },
  "PDD":   { name: "PDD Holdings",base: 130,   vol: 0.04,  type: "stock" },
  "XPEV":  { name: "XPeng",       base: 10,    vol: 0.05,  type: "stock" },
  "LI":    { name: "Li Auto",     base: 30,    vol: 0.045, type: "stock" },
  "MRNA":  { name: "Moderna",     base: 110,   vol: 0.035, type: "stock" },
  "GILD":  { name: "Gilead",      base: 80,    vol: 0.018, type: "stock" },
  "VRTX":  { name: "Vertex",      base: 420,   vol: 0.022, type: "stock" },
  "SE":    { name: "Sea Limited", base: 75,    vol: 0.04,  type: "stock" },
  "MELI":  { name: "MercadoLibre",base: 1800,  vol: 0.025, type: "stock" },
  "GRAB":  { name: "Grab",        base: 4.5,   vol: 0.035, type: "stock" },
  "WBD":   { name: "Warner Bros", base: 8,     vol: 0.04,  type: "stock" },
  "F":     { name: "Ford",        base: 12,    vol: 0.025, type: "stock" },
  "GM":    { name: "GM",          base: 45,    vol: 0.025, type: "stock" },
  "CCL":   { name: "Carnival",    base: 18,    vol: 0.035, type: "stock" },
  "AAL":   { name: "American Air",base: 14,    vol: 0.04,  type: "stock" },
  "TTD":   { name: "Trade Desk",  base: 90,    vol: 0.035, type: "stock" },
  "DDOG":  { name: "Datadog",     base: 120,   vol: 0.03,  type: "stock" },
  "HUBS":  { name: "HubSpot",     base: 600,   vol: 0.028, type: "stock" },
  "OKTA":  { name: "Okta",        base: 80,    vol: 0.035, type: "stock" },
  "DOCU":  { name: "DocuSign",    base: 60,    vol: 0.035, type: "stock" },
  "ROST":  { name: "Ross Stores", base: 140,   vol: 0.02,  type: "stock" },
  "LULU":  { name: "Lululemon",   base: 300,   vol: 0.028, type: "stock" },
  "BBY":   { name: "Best Buy",    base: 75,    vol: 0.025, type: "stock" },
  "WMT":   { name: "Walmart",     base: 170,   vol: 0.012, type: "stock" },
  "GS":    { name: "Goldman Sachs",base: 450,  vol: 0.02,  type: "stock" },
  "JPM":   { name: "JPMorgan",    base: 200,   vol: 0.015, type: "stock" },
  "V":     { name: "Visa",        base: 280,   vol: 0.012, type: "stock" },
  "MA":    { name: "Mastercard",  base: 460,   vol: 0.013, type: "stock" },
  "DIS":   { name: "Disney",      base: 110,   vol: 0.018, type: "stock" },
  "CMG":   { name: "Chipotle",    base: 55,    vol: 0.03,  type: "stock" },
  "SBUX":  { name: "Starbucks",   base: 80,    vol: 0.02,  type: "stock" },
  "NKE":   { name: "Nike",        base: 75,    vol: 0.02,  type: "stock" },
  "TGT":   { name: "Target",      base: 145,   vol: 0.025, type: "stock" },
  "COST":  { name: "Costco",      base: 850,   vol: 0.015, type: "stock" },
  "PG":    { name: "P&G",         base: 165,   vol: 0.01,  type: "stock" },
  "KO":    { name: "Coca-Cola",   base: 62,    vol: 0.01,  type: "stock" },
  "PEP":   { name: "PepsiCo",     base: 175,   vol: 0.01,  type: "stock" },
  "MO":    { name: "Altria",      base: 45,    vol: 0.015, type: "stock" },
  "CVX":   { name: "Chevron",     base: 155,   vol: 0.015, type: "stock" },
  "XOM":   { name: "ExxonMobil",  base: 110,   vol: 0.018, type: "stock" },
  "T":     { name: "AT&T",        base: 18,    vol: 0.015, type: "stock" },
  "VZ":    { name: "Verizon",     base: 41,    vol: 0.012, type: "stock" },
  "PFE":   { name: "Pfizer",      base: 28,    vol: 0.02,  type: "stock" },
  "ABBV":  { name: "AbbVie",      base: 170,   vol: 0.018, type: "stock" },
  "LLY":   { name: "Eli Lilly",   base: 800,   vol: 0.022, type: "stock" },
  "UNH":   { name: "UnitedHealth", base: 520,  vol: 0.018, type: "stock" },
  "NOW":   { name: "ServiceNow",  base: 780,   vol: 0.025, type: "stock" },
  "TEAM":  { name: "Atlassian",   base: 200,   vol: 0.03,  type: "stock" },
  "WDAY":  { name: "Workday",     base: 220,   vol: 0.025, type: "stock" },
  "VEEV":  { name: "Veeva",       base: 200,   vol: 0.025, type: "stock" },
  "ANET":  { name: "Arista",      base: 300,   vol: 0.028, type: "stock" },
  "DELL":  { name: "Dell",        base: 130,   vol: 0.03,  type: "stock" },
  "HPE":   { name: "HPE",         base: 20,    vol: 0.025, type: "stock" },
  "IBM":   { name: "IBM",         base: 190,   vol: 0.018, type: "stock" },
  "ORCL":  { name: "Oracle",      base: 140,   vol: 0.02,  type: "stock" },
  "SAP":   { name: "SAP",         base: 200,   vol: 0.018, type: "stock" },
  "QCOM":  { name: "Qualcomm",    base: 170,   vol: 0.025, type: "stock" },
  "AVGO":  { name: "Broadcom",    base: 1600,  vol: 0.025, type: "stock" },
  "TXN":   { name: "Texas Instr.", base: 170,   vol: 0.018, type: "stock" },
  "MU":    { name: "Micron",      base: 130,   vol: 0.032, type: "stock" },
  "LRCX":  { name: "Lam Research",base: 800,   vol: 0.025, type: "stock" },
  "AMAT":  { name: "Applied Mat.", base: 200,   vol: 0.025, type: "stock" },
  "KLAC":  { name: "KLA Corp",    base: 700,   vol: 0.025, type: "stock" },
  "SNPS":  { name: "Synopsys",    base: 550,   vol: 0.022, type: "stock" },
  "CDNS":  { name: "Cadence",     base: 300,   vol: 0.025, type: "stock" },
  "PANW":  { name: "Palo Alto",   base: 340,   vol: 0.022, type: "stock" },
  "FTNT":  { name: "Fortinet",    base: 80,    vol: 0.028, type: "stock" },
  "CYBR":  { name: "CyberArk",    base: 300,   vol: 0.03,  type: "stock" },
  // ── FOREX SUPPLEMENTAIRES ──
  "USDSEK": { name: "USD/SEK",    base: 10.5,  vol: 0.006, type: "forex", yfSym: "USDSEK=X" },
  "USDNOK": { name: "USD/NOK",    base: 10.8,  vol: 0.007, type: "forex", yfSym: "USDNOK=X" },
  "USDTRY": { name: "USD/TRY",    base: 33,    vol: 0.01,  type: "forex", yfSym: "USDTRY=X" },
  "USDMXN": { name: "USD/MXN",    base: 17,    vol: 0.008, type: "forex", yfSym: "USDMXN=X" },
  "USDZAR": { name: "USD/ZAR",    base: 18.5,  vol: 0.01,  type: "forex", yfSym: "USDZAR=X" },
  "USDCNH": { name: "USD/CNH",    base: 7.25,  vol: 0.005, type: "forex", yfSym: "USDCNH=X" },
  "USDINR": { name: "USD/INR",    base: 83.5,  vol: 0.004, type: "forex", yfSym: "USDINR=X" },
  "USDPLN": { name: "USD/PLN",    base: 4.0,   vol: 0.006, type: "forex", yfSym: "USDPLN=X" },
  "EURAUD": { name: "EUR/AUD",    base: 1.65,  vol: 0.006, type: "forex", yfSym: "EURAUD=X" },
  "EURCHF": { name: "EUR/CHF",    base: 0.97,  vol: 0.004, type: "forex", yfSym: "EURCHF=X" },
  "EURNZD": { name: "EUR/NZD",    base: 1.80,  vol: 0.007, type: "forex", yfSym: "EURNZD=X" },
  "GBPAUD": { name: "GBP/AUD",    base: 1.93,  vol: 0.007, type: "forex", yfSym: "GBPAUD=X" },
  "GBPCAD": { name: "GBP/CAD",    base: 1.74,  vol: 0.006, type: "forex", yfSym: "GBPCAD=X" },
  "AUDJPY": { name: "AUD/JPY",    base: 105,   vol: 0.007, type: "forex", yfSym: "AUDJPY=X" },
  "CADJPY": { name: "CAD/JPY",    base: 118,   vol: 0.007, type: "forex", yfSym: "CADJPY=X" },
  // ── MATIERES PREMIERES SUPPLEMENTAIRES ──
  "WHEAT":  { name: "Ble",        base: 550,   vol: 0.025, type: "commodity", yfSym: "ZW=F" },
  "CORN":   { name: "Maïs",       base: 450,   vol: 0.022, type: "commodity", yfSym: "ZC=F" },
  "SOYBEAN":{ name: "Soja",       base: 1200,  vol: 0.02,  type: "commodity", yfSym: "ZS=F" },
  "COCOA":  { name: "Cacao",      base: 8000,  vol: 0.04,  type: "commodity", yfSym: "CC=F" },
  "SUGAR":  { name: "Sucre",      base: 20,    vol: 0.025, type: "commodity", yfSym: "SB=F" },
  "LUMBER": { name: "Bois",       base: 500,   vol: 0.04,  type: "commodity", yfSym: "LBS=F" },
  "PALADIUM":{ name: "Palladium", base: 950,   vol: 0.03,  type: "commodity", yfSym: "PA=F" },
  // ── INDICES SUPPLEMENTAIRES ──
  "STOXX":  { name: "Euro Stoxx",  base: 4900,  vol: 0.01,  type: "index", yfSym: "^STOXX50E" },
  "ASX":    { name: "ASX 200",     base: 7800,  vol: 0.008, type: "index", yfSym: "^AORD" },
  "TSX":    { name: "TSX Canada",  base: 22000, vol: 0.008, type: "index", yfSym: "^GSPTSE" },
  "KOSPI":  { name: "Kospi",       base: 2700,  vol: 0.012, type: "index", yfSym: "^KS11" },
  "SENSEX": { name: "Sensex India", base: 75000, vol: 0.01, type: "index", yfSym: "^BSESENSE" },
  "HANG":   { name: "Hang Seng",   base: 18000, vol: 0.014, type: "index", yfSym: "^HSI" },
  "CAC":    { name: "CAC 40",      base: 7600,  vol: 0.01,  type: "index", yfSym: "^FCHI" },
  "IBEX":   { name: "IBEX 35",     base: 11000, vol: 0.012, type: "index", yfSym: "^IBEX" },
  "SMI":    { name: "SMI Swiss",   base: 12000, vol: 0.008, type: "index", yfSym: "^SSMI" },
  "AALL":   { name: "All Ordin.",  base: 8200,  vol: 0.008, type: "index", yfSym: "^AORD" },
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
  if (equity <= 50) return { name: "micro", maxRiskPct: 0.05, minScore: 5, maxPos: 2, maxPerGroup: 1, rr: 1.5, maxHoldMin: 120 };
  if (equity <= 200) return { name: "small", maxRiskPct: 0.06, minScore: 4, maxPos: 4, maxPerGroup: 1, rr: 1.5, maxHoldMin: 180 };
  if (equity <= 500) return { name: "medium", maxRiskPct: 0.08, minScore: 4, maxPos: 6, maxPerGroup: 2, rr: 1.2, maxHoldMin: 240 };
  if (equity <= 2000) return { name: "large", maxRiskPct: 0.10, minScore: 3, maxPos: 8, maxPerGroup: 2, rr: 1.0, maxHoldMin: 360 };
  return { name: "big", maxRiskPct: 0.12, minScore: 3, maxPos: 10, maxPerGroup: 2, rr: 1.0, maxHoldMin: 480 };
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
  const volPrev = getVal(volumes, i - 1);
  const volAvg = getVal(volSma20, vI);

  if (rsiVal == null || !macdCurr || !bbVal || !ema20Val || !ema50Val || !atrVal || !stochVal) return null;

  const uptrend = ema20Val > ema50Val && (sma200Val == null || price > sma200Val);
  const downtrend = ema20Val < ema50Val && (sma200Val == null || price < sma200Val);
  const bbPct = (price - bbVal.lower) / (bbVal.upper - bbVal.lower);
  const volumeConfirm = volPrev && volAvg ? volPrev > volAvg * 0.8 : true;

  // ── ATR EXPANSION (simple check) ──
  const atrExpanding = false;

  // ── RSI MOMENTUM ──
  const rsiPrev = getVal(rsi, rI - 1);
  const rsiRising = rsiPrev != null && rsiVal > rsiPrev;
  const rsiFalling = rsiPrev != null && rsiVal < rsiPrev;

  // ── VOLUME SPIKE ──
  const volumeSpike = volNow && volAvg ? volNow > volAvg * 2.0 : false;

  // ── STOCHASTIC CONFIRMATION ──
  const stochD = stochVal.d;
  const stochConfirmLong = stochVal.k < 25 && stochD < 25;
  const stochConfirmShort = stochVal.k > 75 && stochD > 75;

  // ── BB SQUEEZE (narrow bands = volatility expansion imminent) ──
  const bbWidth = bbVal ? (bbVal.upper - bbVal.lower) / ((bbVal.upper + bbVal.lower) / 2) : 0;
  const bbSqueeze = bbWidth < 0.03;

  // ── STRONG TREND (price above EMA20 AND EMA50 for long) ──
  const strongUptrend = ema20Val > ema50Val && price > ema20Val && price > ema50Val;
  const strongDowntrend = ema20Val < ema50Val && price < ema20Val && price < ema50Val;

  // LONG
  let longScore = 0, longReasons = [];
  if (uptrend) {
    longScore += 2; longReasons.push("Uptrend");
    if (rsiVal < 35) { longScore += 3; longReasons.push("RSI oversold"); }
    else if (rsiVal < 42) { longScore += 1; longReasons.push("RSI low"); }
    if (rsiRising) { longScore += 1; longReasons.push("RSI rising"); }
    if (macdPrev && macdCurr) {
      if (macdPrev.MACD < macdPrev.signal && macdCurr.MACD > macdCurr.signal) { longScore += 3; longReasons.push("MACD cross up"); }
      else if (macdCurr.histogram > 0 && macdPrev.histogram <= 0) { longScore += 2; longReasons.push("MACD flip"); }
      else if (macdCurr.histogram > macdPrev.histogram) { longScore += 1; longReasons.push("MACD rising"); }
    }
    if (bbPct < 0.15) { longScore += 2; longReasons.push("BB lower"); }
    else if (bbPct < 0.3) { longScore += 1; longReasons.push("BB low zone"); }
    if (stochVal.k < 25) { longScore += 1; longReasons.push("Stoch low"); }
    if (price > ema20Val) { longScore += 1; longReasons.push("Above EMA20"); }
    // NEW: HIGH-CONFIDENCE SIGNALS
    if (volumeSpike) { longScore += 1; longReasons.push("Volume spike"); }
    if (stochConfirmLong) { longScore += 1; longReasons.push("Stoch confirm"); }
    if (bbSqueeze) { longScore += 1; longReasons.push("BB squeeze"); }
    if (strongUptrend) { longScore += 1; longReasons.push("Strong trend"); }
  }

  // SHORT
  let shortScore = 0, shortReasons = [];
  if (downtrend) {
    shortScore += 2; shortReasons.push("Downtrend");
    if (rsiVal > 65) { shortScore += 3; shortReasons.push("RSI overbought"); }
    else if (rsiVal > 58) { shortScore += 1; shortReasons.push("RSI high"); }
    if (rsiFalling) { shortScore += 1; shortReasons.push("RSI falling"); }
    if (macdPrev && macdCurr) {
      if (macdPrev.MACD > macdPrev.signal && macdCurr.MACD < macdCurr.signal) { shortScore += 3; shortReasons.push("MACD cross down"); }
      else if (macdCurr.histogram < 0 && macdPrev.histogram >= 0) { shortScore += 2; shortReasons.push("MACD flip down"); }
      else if (macdCurr.histogram < macdPrev.histogram) { shortScore += 1; shortReasons.push("MACD falling"); }
    }
    if (bbPct > 0.85) { shortScore += 2; shortReasons.push("BB upper"); }
    else if (bbPct > 0.7) { shortScore += 1; shortReasons.push("BB high zone"); }
    if (stochVal.k > 75) { shortScore += 1; shortReasons.push("Stoch high"); }
    if (price < ema20Val) { shortScore += 1; shortReasons.push("Below EMA20"); }
    // NEW: HIGH-CONFIDENCE SIGNALS
    if (volumeSpike) { shortScore += 1; shortReasons.push("Volume spike"); }
    if (stochConfirmShort) { shortScore += 1; shortReasons.push("Stoch confirm"); }
    if (bbSqueeze) { shortScore += 1; shortReasons.push("BB squeeze"); }
    if (strongDowntrend) { shortScore += 1; shortReasons.push("Strong trend"); }
  } else if (rsiVal > 75 && bbPct > 0.9) {
    shortScore += 4; shortReasons.push("Counter-trend overbought");
  }

  if (!uptrend && rsiVal < 25 && bbPct < 0.05) {
    longScore += 3; longReasons.push("Extreme oversold bounce");
  }
  if (!downtrend && rsiVal > 80 && bbPct > 0.95) {
    shortScore += 3; shortReasons.push("Extreme overbought rejection");
  }

  const tp = +(price + atrVal * 2.5).toFixed(4);
  const sl = +(price - atrVal * 1.5).toFixed(4);
  const shortTp = +(price - atrVal * 2.5).toFixed(4);
  const shortSl = +(price + atrVal * 1.5).toFixed(4);

  return { longScore, shortScore, longReasons, shortReasons, atr: atrVal, tp, sl, shortTp, shortSl, price, volumeConfirm, atrExpanding, rsiRising, rsiFalling, volNow, volAvg, rsi: rsiVal, bbPct, stochK: stochVal.k };
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
          const trailDistance = atrVal * 1;
          if (newBest > pos.entryPrice + atrVal * 1) {
            const newTrailSl = +(newBest - trailDistance).toFixed(4);
            if (newTrailSl > pos.sl) { st.positions[sym].sl = newTrailSl; }
          }
          if (!pos.partialTaken && currentPrice >= pos.entryPrice + atrVal * 1.5) {
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
          const trailDistance = atrVal * 1;
          if (newBest < pos.entryPrice - atrVal * 1) {
            const newTrailSl = +(newBest + trailDistance).toFixed(4);
            if (newTrailSl < pos.sl) { st.positions[sym].sl = newTrailSl; }
          }
          if (!pos.partialTaken && currentPrice <= pos.entryPrice - atrVal * 1.5) {
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
              else if (result.shortScore >= effectiveMinScore && holdMinutes >= 10) { shouldExit = true; exitReason = "REVERSE"; }
            } else {
              if (currentPrice >= posNow.sl) { shouldExit = true; exitPrice = posNow.sl; exitReason = "SL"; }
              else if (currentPrice <= posNow.tp) { shouldExit = true; exitPrice = posNow.tp; exitReason = "TP"; }
              else if (result.longScore >= effectiveMinScore && holdMinutes >= 10) { shouldExit = true; exitReason = "REVERSE"; }
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
          setBalance(st.balance + posFinal.cost + pnl);
          addPnL(pnl);

          const trade = {
            id: Date.now(), symbol: sym, side: posFinal.side, exitReason,
            entryPrice: posFinal.entryPrice, exitPrice, qty: posFinal.qty,
            entryTime: posFinal.entryTime, exitTime: new Date().toISOString(),
            pnl: +pnl.toFixed(4), pnlPercent: +pct.toFixed(2),
            holdMinutes: Math.round((Date.now() - new Date(posFinal.entryTime).getTime()) / 60000),
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

      // ── ADAPTIVE LIMITS ──
      const drawdown = st.peakBalance > 0 ? (st.peakBalance - totalEquity) / st.peakBalance : 0;
      const tradingPaused = drawdown > 0.12;
      const inDrawdown = drawdown > 0.07;

      const atMax = getPositionCount() >= risk.maxPos;
      const cryptoLimit = isCrypto && getCryptoCount() >= Math.max(2, Math.floor(risk.maxPos * 0.4));
      const stockLimit = isStock && getStockCount() >= Math.max(2, Math.floor(risk.maxPos * 0.35));
      const fastLimit = isFast && getStockFastCount() >= Math.max(1, Math.floor(risk.maxPos * 0.25));
      const marketClosed = (isStock || isFast || isCommodity || isIndex) && !isStockMarketOpen();
      const forexClosed = isForex && !isForexOpen();
      const cooldownActive = liveState.lastExitTime[sym] && (Date.now() - liveState.lastExitTime[sym]) < 15 * 60 * 1000;

      // ── CORRELATION FILTER ──
      const corrGroup = getCorrelationGroup(sym);
      const corrLimit = corrGroup ? getGroupCount(corrGroup) >= risk.maxPerGroup : false;

      const minScore = inDrawdown ? risk.minScore + 1 : risk.minScore;

      // ── VOLATILE ASSET: HIGHER MINSCORE (90% confidence required) ──
      const isVolatile = asset?.volatile === true;
      const effectiveMinScore = isVolatile ? Math.max(minScore, 8) : minScore;

      const volumeOk = result.volumeConfirm;

      let rrOk = true;
      if (result.longScore >= effectiveMinScore) {
        const riskCalc = currentPrice - result.sl;
        const reward = result.tp - currentPrice;
        rrOk = riskCalc > 0 && (reward / riskCalc) >= risk.rr;
      }
      if (result.shortScore >= effectiveMinScore && rrOk) {
        const riskCalc = result.shortSl - currentPrice;
        const reward = currentPrice - result.shortTp;
        rrOk = riskCalc > 0 && (reward / riskCalc) >= risk.rr;
      }

      // ── EQUITY CURVE MULTIPLIER ──
      const equityMult = getEquityMultiplier();

      // Debug: log top scored assets
      if (result.longScore >= 2 || result.shortScore >= 2) {
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
        if (!volumeOk) blocks.push("vol");
        if (!rrOk) blocks.push("rr");
        if (result.longScore < minScore && result.shortScore < minScore) blocks.push(`score<${minScore}`);
        if (isVolatile && result.longScore < 8 && result.shortScore < 8) blocks.push("volatile<8");
        if (blocks.length > 0) console.log(`[BLOCKED] ${sym}: L=${result.longScore} S=${result.shortScore} → ${blocks.join(", ")}`);
      }

      if (!pos && !atMax && !cryptoLimit && !stockLimit && !fastLimit && !marketClosed && !forexClosed && !cooldownActive && !corrLimit && !tradingPaused) {
        if (result.longScore >= effectiveMinScore && volumeOk && rrOk && st.balance > 1) {
          const confidence = Math.min(result.longScore, 10);
          const baseRatio = risk.maxRiskPct * 0.6 + (confidence - effectiveMinScore) * risk.maxRiskPct * 0.08;
          const spendRatio = Math.min(baseRatio, risk.maxRiskPct) * equityMult;
          const spend = st.balance * spendRatio;
          const qty = +(spend / currentPrice).toFixed(8);
          const cost = qty * currentPrice;

          let tpFinal, slFinal;
          if (isFast) { tpFinal = +(currentPrice + atrVal * 2.0).toFixed(4); slFinal = +(currentPrice - atrVal * 1.2).toFixed(4); }
          else if (isStock) { tpFinal = +(currentPrice + atrVal * 2.5).toFixed(4); slFinal = +(currentPrice - atrVal * 1.5).toFixed(4); }
          else { tpFinal = result.tp; slFinal = result.sl; }

          st.positions[sym] = {
            side: "LONG", entryTime: new Date().toISOString(),
            entryPrice: currentPrice, qty, cost,
            tp: tpFinal, sl: slFinal,
            bestPrice: currentPrice, partialTaken: false, initialQty: qty,
          };
          setBalance(st.balance - cost);

          const tag = isCrypto ? "₿" : isFast ? "⚡" : asset?.type === "forex" ? "💱" : asset?.type === "commodity" ? "🥇" : asset?.type === "index" ? "📈" : "📊";
          const volatileTag = isVolatile ? "🔥" : "";
          addNotification("info", `${tag}${volatileTag} LONG ${sym}`, `Acheté $${currentPrice.toFixed(2)} | Qty: ${qty} | TP: $${tpFinal} | SL: $${slFinal} | Score: ${result.longScore} | Risk: ${risk.name}${isVolatile ? " | ⚡VOLATILE" : ""}`);
        } else if (result.shortScore >= effectiveMinScore && volumeOk && rrOk && st.balance > 1) {
          const confidence = Math.min(result.shortScore, 10);
          const baseRatio = risk.maxRiskPct * 0.6 + (confidence - effectiveMinScore) * risk.maxRiskPct * 0.08;
          const spendRatio = Math.min(baseRatio, risk.maxRiskPct) * equityMult;
          const spend = st.balance * spendRatio;
          const qty = +(spend / currentPrice).toFixed(8);
          const cost = qty * currentPrice;

          let shortTpFinal, shortSlFinal;
          if (isFast) { shortTpFinal = +(currentPrice - atrVal * 2.0).toFixed(4); shortSlFinal = +(currentPrice + atrVal * 1.2).toFixed(4); }
          else if (isStock) { shortTpFinal = +(currentPrice - atrVal * 2.5).toFixed(4); shortSlFinal = +(currentPrice + atrVal * 1.5).toFixed(4); }
          else { shortTpFinal = result.shortTp; shortSlFinal = result.shortSl; }

          st.positions[sym] = {
            side: "SHORT", entryTime: new Date().toISOString(),
            entryPrice: currentPrice, qty, cost,
            tp: shortTpFinal, sl: shortSlFinal,
            bestPrice: currentPrice, partialTaken: false, initialQty: qty,
          };
          setBalance(st.balance - cost);

          const tag = isCrypto ? "₿" : isFast ? "⚡" : asset?.type === "forex" ? "💱" : asset?.type === "commodity" ? "🥇" : asset?.type === "index" ? "📈" : "📊";
          const volatileTag = isVolatile ? "🔥" : "";
          addNotification("info", `${tag}${volatileTag} SHORT ${sym}`, `Vendu $${currentPrice.toFixed(2)} | Qty: ${qty} | TP: $${shortTpFinal} | SL: $${shortSlFinal} | Score: ${result.shortScore} | Risk: ${risk.name}${isVolatile ? " | ⚡VOLATILE" : ""}`);
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
  console.log(`[CYCLE] Mode:${liveState.activeMode} Risk:${risk.name} | Pos:${getPositionCount()}/${risk.maxPos} | Bal:€${st.balance.toFixed(2)} | Eq:€${eq.toFixed(2)} | PnL:€${st.totalPnL.toFixed(2)} | WR:${wr}%`);
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
