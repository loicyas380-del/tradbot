// ═══════════════════════════════════════════════════════════════
// API + DASHBOARD — lecture seule sur l'état, plus pause/reprise.
// Pas de dépôt, pas de retrait, pas d'argent réel : paper only.
// ═══════════════════════════════════════════════════════════════

import express from "express";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { equityOf } from "./portfolio.js";
import { getStrategy } from "./strategies/index.js";

const r2 = (x) => Math.round(x * 100) / 100;

export function createServer(state, engine, config) {
  const app = express();
  app.use(express.json());

  const pub = join(dirname(fileURLToPath(import.meta.url)), "../public");
  app.use(express.static(pub));

  app.get("/api/status", (req, res) => {
    const s = engine.status();
    const positions = Object.entries(state.positions).map(([symbol, p]) => {
      const last = s.prices[symbol] ?? null;
      return {
        symbol,
        qty: p.qty,
        entryPrice: r2(p.entryPrice),
        stopPrice: r2(p.stopPrice),
        entryTime: p.entryTime,
        lastPrice: last != null ? r2(last) : null,
        uPnl: last != null ? r2((last - p.entryPrice) * p.qty) : null,
        uPnlPct: last != null ? r2((last / p.entryPrice - 1) * 100) : null,
      };
    });
    const wins = state.trades.filter((t) => t.pnl > 0).length;
    const totalPnl = state.trades.reduce((sum, t) => sum + t.pnl, 0);
    res.json({
      mode: "paper",
      equity: r2(equityOf(state, s.prices)),
      cash: r2(state.cash),
      initialCash: config.initialCash,
      paused: state.paused,
      pausedReason: state.pausedReason,
      day: state.day,
      lastTick: s.lastTick,
      dataStatus: s.dataStatus,
      prices: s.prices,
      positions,
      wins,
      losses: state.trades.length - wins,
      totalPnl: r2(totalPnl),
      universe: config.universe,
      interval: config.interval,
      strategy: {
        id: config.strategy.id,
        label: getStrategy(config.strategy.id).label,
        params: config.strategy.params,
      },
      risk: config.risk,
      fees: config.fees,
    });
  });

  app.get("/api/trades", (req, res) => {
    res.json({ trades: state.trades.slice(0, 100) });
  });

  app.get("/api/equity", (req, res) => {
    res.json({ points: state.equityHistory });
  });

  app.get("/api/backtest", (req, res) => {
    try {
      res.json(JSON.parse(fs.readFileSync(config.paths.backtestReport, "utf8")));
    } catch {
      res.json(null);
    }
  });

  app.post("/api/pause", (req, res) => {
    state.paused = true;
    state.pausedReason = "Pause manuelle";
    res.json({ ok: true });
  });

  app.post("/api/resume", (req, res) => {
    state.paused = false;
    state.pausedReason = null;
    res.json({ ok: true });
  });

  return app;
}
