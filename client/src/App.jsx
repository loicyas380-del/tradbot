import { useState, useEffect, useRef, useCallback } from "react";
import { createChart, ColorType, CrosshairMode, CandlestickSeries, LineSeries, HistogramSeries, createSeriesMarkers } from "lightweight-charts";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search, Activity, BarChart3, Zap, ArrowUpRight, ArrowDownRight,
  RefreshCw, Wifi, WifiOff, TrendingUp, TrendingDown,
  Brain, Sparkles, Clock, X, ChevronDown, ChevronUp, Bell, RotateCcw, Pause, Play,
} from "lucide-react";
import "./index.css";

const API = window.location.port === "3000" ? "http://localhost:3001/api" : "/api";

function App() {
  const [markets, setMarkets] = useState([]);
  const [selectedSymbol, setSelectedSymbol] = useState("BTC");
  const [chartData, setChartData] = useState(null);
  const [liveData, setLiveData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState("3mo");
  const [search, setSearch] = useState("");
  const [connected, setConnected] = useState(true);
  const [aiReports, setAiReports] = useState([]);
  const [showReports, setShowReports] = useState(false);
  const [generatingReport, setGeneratingReport] = useState(false);
  const [expandedReport, setExpandedReport] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [lastNotifId, setLastNotifId] = useState(0);
  const [page, setPage] = useState("dashboard"); // "dashboard" | "bot"
  const chartRef = useRef(null);
  const chartInstance = useRef(null);
  const liveDataRef = useRef(null);
  const candleSeriesRef = useRef(null);

  // Fetch markets
  useEffect(() => {
    fetch(`${API}/markets`).then((r) => r.json()).then(setMarkets).catch(() => setConnected(false));
  }, []);

  // Fetch chart
  useEffect(() => {
    setLoading(true);
    fetch(`${API}/chart/${selectedSymbol}?range=${range}`)
      .then((r) => r.json())
      .then((d) => { setChartData(d); setLoading(false); setConnected(true); })
      .catch(() => { setLoading(false); setConnected(false); });
  }, [selectedSymbol, range]);

  // Fetch live state
  const fetchLive = useCallback(() => {
    fetch(`${API}/live`).then((r) => r.json()).then(setLiveData).catch(() => {});
  }, []);

  useEffect(() => { fetchLive(); }, [fetchLive]);
  useEffect(() => {
    const interval = setInterval(fetchLive, 5000);
    return () => clearInterval(interval);
  }, [fetchLive]);

  // Keep liveDataRef in sync
  useEffect(() => { liveDataRef.current = liveData; }, [liveData]);

  // Poll notifications
  useEffect(() => {
    const poll = () => {
      fetch(`${API}/notifications?since=${lastNotifId}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.notifications?.length > 0) {
            data.notifications.forEach((n) => {
              setToasts((prev) => [...prev, { ...n, show: true }].slice(-5));
              setTimeout(() => {
                setToasts((prev) => prev.filter((t) => t.id !== n.id));
              }, 6000);
            });
            setLastNotifId(data.latestId);
          }
        })
        .catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [lastNotifId]);

  // Fetch AI reports
  useEffect(() => {
    fetch(`${API}/ai/reports`).then((r) => r.json()).then((d) => setAiReports(d.reports || [])).catch(() => {});
  }, []);

  // Chart
  useEffect(() => {
    if (!chartData || !chartRef.current) return;
    if (chartInstance.current) { chartInstance.current.remove(); chartInstance.current = null; }

    const chart = createChart(chartRef.current, {
      width: chartRef.current.clientWidth, height: 380,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#94a3b8", fontFamily: "'JetBrains Mono', monospace", fontSize: 11 },
      grid: { vertLines: { color: "rgba(42, 48, 66, 0.5)" }, horzLines: { color: "rgba(42, 48, 66, 0.5)" } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "rgba(59, 130, 246, 0.3)", width: 1, style: 2 }, horzLine: { color: "rgba(59, 130, 246, 0.3)", width: 1, style: 2 } },
      rightPriceScale: { borderColor: "rgba(42, 48, 66, 0.5)", scaleMargins: { top: 0.1, bottom: 0.25 } },
      timeScale: { borderColor: "rgba(42, 48, 66, 0.5)", timeVisible: true },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981", downColor: "#ef4444", borderDownColor: "#ef4444", borderUpColor: "#10b981", wickDownColor: "#ef4444", wickUpColor: "#10b981",
    });
    candleSeries.setData(chartData.data.map((d) => ({ time: d.time, open: d.open, high: d.high, low: d.low, close: d.close })));

    const volumeSeries = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume" });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    volumeSeries.setData(chartData.data.map((d) => ({ time: d.time, value: d.volume, color: d.close >= d.open ? "rgba(16,185,129,0.2)" : "rgba(239,68,68,0.2)" })));

    const ema20Data = chartData.data.filter((d) => d.ema20 != null).map((d) => ({ time: d.time, value: d.ema20 }));
    if (ema20Data.length > 0) { const s = chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 2, priceLineVisible: false, lastValueVisible: false }); s.setData(ema20Data); }
    const ema50Data = chartData.data.filter((d) => d.ema50 != null).map((d) => ({ time: d.time, value: d.ema50 }));
    if (ema50Data.length > 0) { const s = chart.addSeries(LineSeries, { color: "#f59e0b", lineWidth: 2, priceLineVisible: false, lastValueVisible: false }); s.setData(ema50Data); }

    const ld = liveDataRef.current;

    // TP/SL for open position
    const openPos = ld?.openTrades?.find((t) => t.symbol === selectedSymbol);
    if (openPos) {
      const tpLine = chart.addSeries(LineSeries, { color: "#10b981", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: true });
      const slLine = chart.addSeries(LineSeries, { color: "#ef4444", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: true });
      const entryLine = chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: true });
      tpLine.setData(chartData.data.map((d) => ({ time: d.time, value: openPos.tp })));
      slLine.setData(chartData.data.map((d) => ({ time: d.time, value: openPos.sl })));
      entryLine.setData(chartData.data.map((d) => ({ time: d.time, value: openPos.entryPrice })));
    }

    // Markers from trade history + open position entry
    const relevantTrades = ld?.tradeHistory?.filter((t) => t.symbol === selectedSymbol) || [];
    const allMarkers = relevantTrades.flatMap((t) => [
      { time: t.entryTime.split("T")[0], position: t.side === "LONG" ? "belowBar" : "aboveBar", color: t.side === "LONG" ? "#10b981" : "#f59e0b", shape: t.side === "LONG" ? "arrowUp" : "arrowDown", text: `${t.side} $${t.entryPrice.toFixed(2)}` },
      { time: t.exitTime.split("T")[0], position: t.side === "LONG" ? "aboveBar" : "belowBar", color: t.pnl >= 0 ? "#10b981" : "#ef4444", shape: t.side === "LONG" ? "arrowDown" : "arrowUp", text: `${t.exitReason} ${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}` },
    ]);
    if (openPos) {
      allMarkers.push({
        time: openPos.entryTime.split("T")[0],
        position: openPos.side === "LONG" ? "belowBar" : "aboveBar",
        color: openPos.side === "LONG" ? "#10b981" : "#f59e0b",
        shape: openPos.side === "LONG" ? "arrowUp" : "arrowDown",
        text: `ENTRY ${openPos.side} $${openPos.entryPrice.toFixed(2)}`,
      });
    }
    if (allMarkers.length > 0) {
      allMarkers.sort((a, b) => new Date(a.time) - new Date(b.time));
      createSeriesMarkers(candleSeries, allMarkers);
    }

    chart.timeScale().fitContent();
    chartInstance.current = chart;
    candleSeriesRef.current = candleSeries;

    const handleResize = () => { if (chartRef.current && chartInstance.current) chartInstance.current.applyOptions({ width: chartRef.current.clientWidth }); };
    window.addEventListener("resize", handleResize);
    return () => { window.removeEventListener("resize", handleResize); if (chartInstance.current) { chartInstance.current.remove(); chartInstance.current = null; } };
  }, [chartData, selectedSymbol]);

  const filteredMarkets = markets.filter((m) => m.symbol.toLowerCase().includes(search.toLowerCase()) || m.name.toLowerCase().includes(search.toLowerCase()));
  const currentMarket = markets.find((m) => m.symbol === selectedSymbol);

  const generateReport = async () => {
    setGeneratingReport(true);
    try {
      const res = await fetch(`${API}/ai/generate`, { method: "POST" });
      const report = await res.json();
      if (report.id) { setAiReports((prev) => [report, ...prev].slice(0, 30)); setShowReports(true); }
    } catch {}
    setGeneratingReport(false);
  };

  const resetAccount = async () => {
    if (!confirm("Reset le compte à €1000 ?")) return;
    await fetch(`${API}/reset`, { method: "POST" });
    fetchLive();
  };

  const positionCount = liveData?.positionCount || 0;

  return (
    <div className="app-layout">
      {/* TOAST NOTIFICATIONS */}
      <div className="toast-container">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div key={t.id} className={`toast toast-${t.type}`} initial={{ opacity: 0, x: 300 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 300 }}>
              <div className="toast-content">
                <div className="toast-title">{t.title}</div>
                <div className="toast-message">{t.message}</div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* SIDEBAR */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="logo">
            <div className="logo-icon">TB</div>
            <div>
              <div className="logo-text">TradBot</div>
              <div className="logo-sub">Trading Intelligence</div>
            </div>
          </div>
          <div className="search-box">
            <Search className="search-icon" />
            <input placeholder="Search markets..." value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="market-list">
          <AnimatePresence>
            {filteredMarkets.map((m, i) => {
              const type = m.type || "stock";
              const isOpen = liveData?.openTrades?.some((t) => t.symbol === m.symbol);
              return (
                <motion.div key={m.symbol} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.03 }}
                  className={`market-item ${selectedSymbol === m.symbol ? "active" : ""} ${isOpen ? "has-position" : ""}`}
                  onClick={() => setSelectedSymbol(m.symbol)}>
                  <div className="market-item-left">
                    <div className={`market-icon ${type}`}>
                      {type === "crypto" ? <Zap size={14} /> : type === "forex" ? <Activity size={14} /> : <BarChart3 size={14} />}
                      {isOpen && <div className="position-dot" />}
                    </div>
                    <div>
                      <div className="market-name">{m.name}</div>
                      <div className="market-symbol">{m.symbol}</div>
                    </div>
                  </div>
                  <div className="market-item-right">
                    <div className="market-price">${m.price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || "—"}</div>
                    <div className={`market-change ${m.changePercent >= 0 ? "positive" : "negative"}`}>{m.changePercent >= 0 ? "+" : ""}{m.changePercent?.toFixed(2)}%</div>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
        {/* BOTTOM BUTTONS */}
        <div className="sidebar-bottom">
          {/* POSITIONS COUNTER */}
          <div className="positions-counter">
            <div className="pos-count-bar">
                {Array.from({ length: 20 }).map((_, i) => (
                <div key={i} className={`pos-slot ${i < positionCount ? "filled" : ""}`} />
              ))}
            </div>
            <span className="pos-count-text">{positionCount}/{liveData?.maxPositions || 10} positions</span>
          </div>

          <button className="btn-reset" onClick={resetAccount}>
            <RotateCcw size={14} />
            Reset €1000
          </button>

          <div className="nav-buttons">
            <button className={`nav-btn ${page === "dashboard" ? "active" : ""}`} onClick={() => setPage("dashboard")}>
              <BarChart3 size={14} />
              Dashboard
            </button>
            <button className={`nav-btn bot ${page === "bot" ? "active" : ""}`} onClick={() => setPage("bot")}>
              <Zap size={14} />
              BOT
            </button>
          </div>

          <button className="btn-ai-report" onClick={generateReport} disabled={generatingReport}>
            {generatingReport ? <RefreshCw size={16} className="spinning" /> : <Brain size={16} />}
            {generatingReport ? "Analyse..." : "Rapport IA"}
          </button>

          {aiReports.length > 0 && (
            <button className="btn-reports-toggle" onClick={() => setShowReports(!showReports)}>
              <Sparkles size={14} />
              {aiReports.length} rapport{aiReports.length > 1 ? "s" : ""}
              {showReports ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
            </button>
          )}
        </div>
      </div>

      {/* MAIN */}
      <div className="main-content">
        {page === "dashboard" ? (
          <>
        <div className="top-bar">
          <div className="symbol-info">
            <motion.div className="symbol-title" key={selectedSymbol} initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
              {currentMarket?.name || selectedSymbol}
            </motion.div>
            {currentMarket && (
              <>
                <motion.div className="symbol-price-live" style={{ color: currentMarket.changePercent >= 0 ? "#10b981" : "#ef4444" }}
                  key={`price-${selectedSymbol}`} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}>
                  ${currentMarket.price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </motion.div>
                <div className={`symbol-change-live ${currentMarket.changePercent >= 0 ? "positive" : "negative"}`}>
                  {currentMarket.changePercent >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                  {" "}{currentMarket.changePercent >= 0 ? "+" : ""}{currentMarket.changePercent?.toFixed(2)}%
                </div>
              </>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {connected ? <Wifi size={14} style={{ color: "var(--accent-green)" }} /> : <WifiOff size={14} style={{ color: "var(--accent-red)" }} />}
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{connected ? "Live" : "Offline"}</span>
            </div>
          </div>
          <div className="range-buttons">
            {["1w", "1mo", "3mo", "6mo", "1y", "2y"].map((r) => (
              <button key={r} className={`range-btn ${range === r ? "active" : ""}`} onClick={() => setRange(r)}>{r.toUpperCase()}</button>
            ))}
          </div>
        </div>

        <div className="chart-area">
          {loading ? (
            <div className="loading"><div className="loading-spinner" /><div className="loading-text">Loading market data...</div></div>
          ) : (
            <>
              <div className="chart-container">
                <div className="chart-header">
                  <div className="chart-title">{selectedSymbol} — {range.toUpperCase()} Chart</div>
                  <div className="legend">
                    <div className="legend-item"><div className="legend-dot" style={{ background: "#3b82f6" }} />EMA 20</div>
                    <div className="legend-item"><div className="legend-dot" style={{ background: "#f59e0b" }} />EMA 50</div>
                  </div>
                </div>
                <div ref={chartRef} style={{ width: "100%", borderRadius: 8 }} />
              </div>

              {/* LIVE POSITIONS */}
              {liveData?.openTrades?.length > 0 && (
                <motion.div className="live-positions" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
                  <div className="live-positions-title">
                    <Activity size={16} /> Positions Ouvertes ({liveData.openTrades.length}/{liveData.maxPositions})
                  </div>
                  <div className="live-positions-grid">
                    {liveData.openTrades.map((p) => (
                      <div key={p.symbol} className={`live-pos-card ${p.side.toLowerCase()}`} onClick={() => setSelectedSymbol(p.symbol)}>
                        <div className="lpc-header">
                          <span className={`lpc-side ${p.side.toLowerCase()}`}>{p.side === "LONG" ? <TrendingUp size={14} /> : <TrendingDown size={14} />}{p.side}</span>
                          <span className="lpc-symbol">{p.symbol}</span>
                        </div>
                        <div className="lpc-details">
                          <span>Entry: ${p.entryPrice.toFixed(2)}</span>
                          <span>Now: ${p.currentPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || p.entryPrice.toFixed(2)}</span>
                        </div>
                        <div className="lpc-details">
                          <span>TP: ${p.tp.toFixed(2)}</span>
                          <span>SL: ${p.sl.toFixed(2)}</span>
                          <span className={`lpc-pnl ${(p.unrealizedPnl || 0) >= 0 ? "positive" : "negative"}`}>
                            {(p.unrealizedPnl || 0) >= 0 ? "+" : ""}€{(p.unrealizedPnl || 0).toFixed(2)} ({(p.unrealizedPnlPercent || 0) >= 0 ? "+" : ""}{(p.unrealizedPnlPercent || 0).toFixed(1)}%)
                          </span>
                        </div>
                        <div className="lpc-since">{new Date(p.entryTime).toLocaleTimeString("fr-FR")}</div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}

              {/* STATS */}
              {liveData && (
                <motion.div className="stats-grid" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
                  <div className="stat-card green">
                    <div className="stat-label">Balance</div>
                    <div className="stat-value neutral">€{liveData.balance.toLocaleString()}</div>
                    <div className="stat-sub">Initial: €{liveData.initialBalance}</div>
                  </div>
                  <div className={`stat-card ${liveData.totalPnL >= 0 ? "green" : "red"}`}>
                    <div className="stat-label">Total P&L</div>
                    <div className={`stat-value ${liveData.totalPnL >= 0 ? "positive" : "negative"}`}>{liveData.totalPnL >= 0 ? "+" : ""}€{liveData.totalPnL.toFixed(2)}</div>
                    <div className="stat-sub">{liveData.totalPnLPercent >= 0 ? "+" : ""}{liveData.totalPnLPercent}%</div>
                  </div>
                  <div className="stat-card blue">
                    <div className="stat-label">Win Rate</div>
                    <div className="stat-value" style={{ color: "var(--accent-blue)" }}>{liveData.winRate}%</div>
                    <div className="stat-sub">{liveData.totalTrades} trades</div>
                  </div>
                  <div className="stat-card purple">
                    <div className="stat-label">Strike</div>
                    <div className="stat-value" style={{ color: "var(--accent-purple)" }}>{liveData.strike}</div>
                    <div className="stat-sub">{positionCount}/{liveData.maxPositions} positions</div>
                  </div>
                </motion.div>
              )}

              {/* TRADE HISTORY */}
              {liveData?.tradeHistory?.length > 0 && (
                <motion.div className="trades-section" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}>
                  <div className="trades-header">
                    <div className="trades-title"><Activity size={16} />Trade History<span className="trades-count">{liveData.tradeHistory.length}</span></div>
                  </div>
                  <div className="trades-list">
                    {liveData.tradeHistory.map((t, i) => (
                      <motion.div key={t.id || i} className="trade-item" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.02 }}>
                        <div className="trade-left">
                          <span className={`trade-type ${t.side.toLowerCase()}`}>{t.side === "LONG" ? "LONG" : "SHORT"}</span>
                          <span className="trade-date">{t.symbol}</span>
                          <span className="trade-price" style={{ color: "var(--text-secondary)" }}>Entry ${t.entryPrice.toFixed(2)} → Exit ${t.exitPrice.toFixed(2)}</span>
                          <span className={`trade-exit-reason ${t.exitReason.toLowerCase()}`}>{t.exitReason}</span>
                        </div>
                        <div className="trade-right">
                          <span className={`trade-pnl ${t.pnl >= 0 ? "positive" : "negative"}`}>
                            {t.pnl >= 0 ? "+" : ""}€{t.pnl.toFixed(2)} ({t.pnlPercent >= 0 ? "+" : ""}{t.pnlPercent}%)
                          </span>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </motion.div>
              )}
            </>
          )}
        </div>

        {/* INDICATORS */}
        {chartData?.data?.length > 0 && (() => {
          const latest = chartData.data[chartData.data.length - 1];
          return (
            <div className="indicators-bar">
              <div className="indicator-pill"><span className="indicator-label">RSI</span><span className={`indicator-value ${latest.rsi < 30 ? "bullish" : latest.rsi > 70 ? "bearish" : "neutral"}`}>{latest.rsi?.toFixed(1) || "—"}</span></div>
              {latest.macd && <div className="indicator-pill"><span className="indicator-label">MACD</span><span className={`indicator-value ${latest.macd.histogram > 0 ? "bullish" : "bearish"}`}>{latest.macd.MACD?.toFixed(3)}</span></div>}
              {latest.bb && <><div className="indicator-pill"><span className="indicator-label">BB Up</span><span className="indicator-value neutral">${latest.bb.upper?.toFixed(2)}</span></div><div className="indicator-pill"><span className="indicator-label">BB Low</span><span className="indicator-value neutral">${latest.bb.lower?.toFixed(2)}</span></div></>}
              {latest.stoch && <div className="indicator-pill"><span className="indicator-label">Stoch</span><span className={`indicator-value ${latest.stoch.k < 20 ? "bullish" : latest.stoch.k > 80 ? "bearish" : "neutral"}`}>{latest.stoch.k?.toFixed(1)}</span></div>}
              {latest.atr && <div className="indicator-pill"><span className="indicator-label">ATR</span><span className="indicator-value neutral">{latest.atr?.toFixed(2)}</span></div>}
            </div>
          );
        })()}
          </>
        ) : (
          /* ═══════ BOT PAGE ═══════ */
          <div className="bot-page">
            <div className="bot-header">
              <Zap size={28} />
              <h1>Bot Activity</h1>
              <div className="bot-status">
                <div className={`bot-status-dot ${connected ? "live" : "off"}`} />
                {connected ? "ONLINE" : "OFFLINE"}
              </div>
            </div>

            {/* BIG BALANCE */}
            <motion.div className="bot-balance-card" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}>
              <div className="bot-balance-label">Balance</div>
              <div className="bot-balance-amount">€{liveData?.balance?.toLocaleString() || "1000"}</div>
              <div className={`bot-balance-pnl ${(liveData?.totalPnL || 0) >= 0 ? "positive" : "negative"}`}>
                {(liveData?.totalPnL || 0) >= 0 ? "+" : ""}€{(liveData?.totalPnL || 0).toFixed(2)} ({(liveData?.totalPnLPercent || 0).toFixed(1)}%)
              </div>
            </motion.div>

            {/* QUICK STATS ROW */}
            <div className="bot-stats-row">
              <div className="bot-stat">
                <div className="bot-stat-value" style={{ color: "var(--accent-blue)" }}>{liveData?.winRate || 0}%</div>
                <div className="bot-stat-label">Win Rate</div>
              </div>
              <div className="bot-stat">
                <div className="bot-stat-value" style={{ color: "var(--accent-purple)" }}>{liveData?.strike || "0W/0L"}</div>
                <div className="bot-stat-label">Strike</div>
              </div>
              <div className="bot-stat">
                <div className="bot-stat-value" style={{ color: "var(--accent-cyan)" }}>{liveData?.positionCount || 0}/{liveData?.maxPositions || 3}</div>
                <div className="bot-stat-label">Positions</div>
              </div>
              <div className="bot-stat">
                <div className="bot-stat-value" style={{ color: "var(--accent-yellow)" }}>{liveData?.totalTrades || 0}</div>
                <div className="bot-stat-label">Trades</div>
              </div>
            </div>

            {/* OPEN POSITIONS — BIG CARDS */}
            {liveData?.openTrades?.length > 0 && (
              <div className="bot-section">
                <h2 className="bot-section-title">Positions Ouvertes</h2>
                <div className="bot-positions-grid">
                  {liveData.openTrades.map((p) => (
                    <motion.div key={p.symbol} className={`bot-pos-card ${p.side.toLowerCase()}`} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                      onClick={() => { setSelectedSymbol(p.symbol); setPage("dashboard"); }}>
                      <div className="bpc-top">
                        <span className={`bpc-side ${p.side.toLowerCase()}`}>{p.side === "LONG" ? "🟢 LONG" : "🔴 SHORT"}</span>
                        <span className="bpc-symbol">{p.symbol}</span>
                      </div>
                      <div className="bpc-prices">
                        <div className="bpc-price">Entry ${p.entryPrice.toFixed(2)}</div>
                        <div className="bpc-price live">Live ${p.currentPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || p.entryPrice.toFixed(2)}</div>
                      </div>
                      <div className={`bpc-pnl ${(p.unrealizedPnl || 0) >= 0 ? "positive" : "negative"}`}>
                        {(p.unrealizedPnl || 0) >= 0 ? "+" : ""}€{(p.unrealizedPnl || 0).toFixed(2)} ({(p.unrealizedPnlPercent || 0) >= 0 ? "+" : ""}{(p.unrealizedPnlPercent || 0).toFixed(1)}%)
                      </div>
                      <div className="bpc-targets">
                        <div className="bpc-target tp">TP ${p.tp.toFixed(2)}</div>
                        <div className="bpc-target sl">SL ${p.sl.toFixed(2)}</div>
                      </div>
                      <div className="bpc-since">Depuis {new Date(p.entryTime).toLocaleTimeString("fr-FR")}</div>
                    </motion.div>
                  ))}
                </div>
              </div>
            )}

            {liveData?.openTrades?.length === 0 && (
              <div className="bot-empty">
                <Pause size={40} style={{ opacity: 0.3 }} />
                <p>Aucune position ouverte</p>
                <p className="bot-empty-sub">Le bot analyse le marché...</p>
              </div>
            )}

            {/* RECENT TRADES — SIMPLE LIST */}
            {liveData?.tradeHistory?.length > 0 && (
              <div className="bot-section">
                <h2 className="bot-section-title">Derniers Trades</h2>
                <div className="bot-trades-list">
                  {liveData.tradeHistory.slice(0, 10).map((t, i) => (
                    <motion.div key={t.id || i} className={`bot-trade ${t.pnl >= 0 ? "win" : "loss"}`} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}>
                      <div className="bt-left">
                        <span className={`bt-side ${t.side.toLowerCase()}`}>{t.side === "LONG" ? "🟢" : "🔴"} {t.symbol}</span>
                        <span className="bt-exit">{t.exitReason}</span>
                      </div>
                      <div className="bt-right">
                        <span className={`bt-pnl ${t.pnl >= 0 ? "positive" : "negative"}`}>
                          {t.pnl >= 0 ? "+" : ""}€{t.pnl.toFixed(2)}
                        </span>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>
            )}

            {/* NOTIFICATIONS FEED */}
            {liveData?.notifications?.length > 0 && (
              <div className="bot-section">
                <h2 className="bot-section-title"><Bell size={16} /> Notifications</h2>
                <div className="bot-notif-list">
                  {liveData.notifications.slice(0, 8).map((n) => (
                    <div key={n.id} className={`bot-notif ${n.type}`}>
                      <div className="bn-time">{new Date(n.time).toLocaleTimeString("fr-FR")}</div>
                      <div className="bn-title">{n.title}</div>
                      <div className="bn-message">{n.message}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

      </div>

      {/* AI REPORTS PANEL */}
      <AnimatePresence>
        {showReports && (
          <motion.div className="ai-reports-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowReports(false)}>
            <motion.div className="ai-reports-panel" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ type: "spring", damping: 25, stiffness: 200 }} onClick={(e) => e.stopPropagation()}>
              <div className="ai-reports-header">
                <div className="ai-reports-title"><Brain size={20} />Rapports IA<span className="trades-count">{aiReports.length}</span></div>
                <button className="ai-reports-close" onClick={() => setShowReports(false)}><X size={18} /></button>
              </div>
              <div className="ai-reports-list">
                {aiReports.length === 0 ? (
                  <div className="empty-state"><Sparkles size={40} style={{ opacity: 0.3 }} /><div className="empty-text">Aucun rapport</div></div>
                ) : (
                  aiReports.map((report) => (
                    <motion.div key={report.id} className="ai-report-card" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
                      <div className="ai-report-header" onClick={() => setExpandedReport(expandedReport === report.id ? null : report.id)}>
                        <div className="ai-report-time"><Clock size={12} />{new Date(report.time).toLocaleTimeString("fr-FR")} — {new Date(report.time).toLocaleDateString("fr-FR")}</div>
                        {expandedReport === report.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </div>
                      {expandedReport === report.id && (
                        <motion.div className="ai-report-content" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}>
                          <div className="ai-report-text">{report.content}</div>
                        </motion.div>
                      )}
                    </motion.div>
                  ))
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default App;
