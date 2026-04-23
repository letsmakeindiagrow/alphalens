import { useState, useCallback, useMemo } from "react";
import {
  AreaChart, Area, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";

// ─────────────────────────────────────────────────────────────────
// DESIGN TOKENS
// ─────────────────────────────────────────────────────────────────
const C = {
  bg: "#080b12", surface: "#0f1420", card: "#141929",
  border: "#1a2236", accent: "#00e5b0", accent2: "#4d8ef0",
  accent3: "#f0c94d", red: "#f05f4d", green: "#00e5b0",
  muted: "#3d4f6a", text: "#dde4f0", textSoft: "#7a8ba0",
};

// ─────────────────────────────────────────────────────────────────
// STRATEGY CONSTANTS
// ─────────────────────────────────────────────────────────────────
const MAX_LOTS   = 7;
const STEP_DOWN  = 0.05;
const STOP_DROP  = 0.40;
const FIRST_EXIT = 0.15;
const STEP_UP    = 0.05;

// ─────────────────────────────────────────────────────────────────
// INVESTMENT MODEL → lot capital
// model 1: fixed amount    model 2: 1% initial    model 3: 1% prev balance
// ─────────────────────────────────────────────────────────────────
function getLotCap(model, fixedAmt, initialCap, prevBal) {
  if (model === 1) return fixedAmt;
  if (model === 2) return initialCap * 0.01;
  return prevBal * 0.01;
}

// ─────────────────────────────────────────────────────────────────
// BACKTEST ENGINE
// ─────────────────────────────────────────────────────────────────
function runBacktest(ohlcv, model, fixedAmt, initialCap) {
  const trades = [];
  const lots   = [];             // LIFO stack
  let cycleOn = false, nextBuy = null, nextSell = null;
  let stopPx = null, firstEntryPx = null;
  let cash = initialCap;         // free cash (tracks for model 3)

  const makeLot = (date, px, lc) => ({
    entry_date: date, entry_price: px,
    quantity: Math.max(1, Math.floor(lc / px)),
    lot_capital: lc,
    exit_date: null, exit_price: null, exit_quantity: null,
    pnl: null, status: "open",
  });

  const lc = () => getLotCap(model, fixedAmt, initialCap, Math.max(cash, 1000));

  const startCycle = (date, px) => {
    cycleOn = true; firstEntryPx = px;
    stopPx   = px * (1 - STOP_DROP);
    const l  = makeLot(date, px, lc());
    cash    -= l.lot_capital;
    lots.push(l);
    nextBuy  = px * (1 - STEP_DOWN);
    nextSell = px * (1 + FIRST_EXIT);
  };

  const addLot = (date, px) => {
    const l = makeLot(date, px, lc());
    cash   -= l.lot_capital;
    lots.push(l);
    nextBuy  = px * (1 - STEP_DOWN);
    nextSell = px * (1 + FIRST_EXIT);
  };

  const closeAll = (date, px) => {
    lots.forEach(l => {
      const proceeds = l.quantity * px;
      cash += proceeds;
      l.exit_date = date; l.exit_price = px;
      l.exit_quantity = l.quantity;
      l.pnl = proceeds - l.quantity * l.entry_price;
      l.status = "closed";
      trades.push(l);
    });
    lots.length = 0;
    cycleOn = false; nextBuy = nextSell = stopPx = firstEntryPx = null;
  };

  const sellTop = (date, px) => {
    const l = lots.pop();
    const proceeds = l.quantity * px;
    cash += proceeds;
    l.exit_date = date; l.exit_price = px;
    l.exit_quantity = l.quantity;
    l.pnl = proceeds - l.quantity * l.entry_price;
    l.status = "closed";
    trades.push(l);
    if (!lots.length) {
      cycleOn = false; nextBuy = nextSell = stopPx = firstEntryPx = null;
    } else {
      nextSell = px * (1 + STEP_UP);
    }
  };

  const equity = [];

  for (const { date, open, high, low, close } of ohlcv) {
    const mtm = lots.reduce((s, l) => s + l.quantity * close, 0);
    equity.push({ date, equity: cash + mtm });

    if (!cycleOn)               { startCycle(date, open); continue; }
    if (low <= stopPx)          { closeAll(date, stopPx);  continue; }

    let guard = 0;
    while (lots.length < MAX_LOTS && nextBuy !== null && low <= nextBuy && ++guard < 15)
      addLot(date, nextBuy);

    guard = 0;
    while (lots.length && nextSell !== null && high >= nextSell && ++guard < 15) {
      sellTop(date, nextSell);
      if (!cycleOn) break;
    }
  }

  lots.forEach(l => { l.status = "open"; trades.push(l); });
  return { trades, equity, finalCash: cash };
}

// ─────────────────────────────────────────────────────────────────
// ANALYTICS
// ─────────────────────────────────────────────────────────────────
function stats(trades, equity, initCap) {
  const closed  = trades.filter(t => t.status === "closed");
  const open    = trades.filter(t => t.status === "open");
  const winners = closed.filter(t => t.pnl > 0);
  const losers  = closed.filter(t => t.pnl <= 0);
  const totalPnL     = closed.reduce((s, t) => s + t.pnl, 0);
  const winRate      = closed.length ? (winners.length / closed.length) * 100 : 0;
  const avgWin       = winners.length ? winners.reduce((s,t) => s+t.pnl, 0) / winners.length : 0;
  const avgLoss      = losers.length  ? losers.reduce((s,t) => s+t.pnl, 0) / losers.length  : 0;
  const grossWin     = winners.reduce((s,t) => s+t.pnl, 0);
  const grossLoss    = Math.abs(losers.reduce((s,t) => s+t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : Infinity;

  let peak = initCap, maxDD = 0, maxDDPct = 0;
  for (const p of equity) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak - p.equity;
    if (dd > maxDD) { maxDD = dd; maxDDPct = (dd / peak) * 100; }
  }

  const finalEq = equity.length ? equity[equity.length - 1].equity : initCap;
  const years   = equity.length / 252;
  const cagr    = years > 0 ? (Math.pow(Math.max(finalEq,1) / Math.max(initCap,1), 1/years) - 1) * 100 : 0;

  const rets  = equity.map((p, i) => i === 0 ? 0 : (p.equity - equity[i-1].equity) / (equity[i-1].equity || 1)).slice(1);
  const meanR = rets.reduce((s,r) => s+r, 0) / (rets.length || 1);
  const stdR  = Math.sqrt(rets.reduce((s,r) => s+(r-meanR)**2, 0) / (rets.length||1));
  const sharpe = stdR > 0 ? (meanR / stdR) * Math.sqrt(252) : 0;

  const monthly = {};
  for (const t of closed) {
    const k = (t.exit_date || t.entry_date)?.slice(0,7);
    if (k) monthly[k] = (monthly[k] || 0) + t.pnl;
  }

  return {
    totalPnL, winRate, avgWin, avgLoss, profitFactor,
    maxDD, maxDDPct, cagr, sharpe, finalEq,
    totalTrades: closed.length, openTrades: open.length,
    winners: winners.length, losers: losers.length, monthly,
  };
}

// ─────────────────────────────────────────────────────────────────
// REAL DATA FETCHER — Yahoo Finance v8 API (no API key needed)
// Works directly from browser. Same adjusted data as yfinance.
// ─────────────────────────────────────────────────────────────────
async function fetchYahooOHLCV(symbol, startDate, endDate) {
  const p1 = Math.floor(new Date(startDate).getTime() / 1000);
  const p2 = Math.floor(new Date(endDate).getTime()   / 1000) + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`
            + `?interval=1d&period1=${p1}&period2=${p2}&events=splits`;

  try {
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error("No data in response");

    const timestamps = result.timestamp || [];
    const q          = result.indicators.quote[0];
    const adjClose   = result.indicators.adjclose?.[0]?.adjclose || q.close;

    const rows = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = q.open[i], h = q.high[i], l = q.low[i];
      const c = q.close[i], ac = adjClose[i];
      // Skip days with null/zero values (holidays sometimes sneak in)
      if (!o || !h || !l || !c || !ac) continue;

      // Adjust OHLC for splits & dividends using the adjclose ratio
      const adj = ac / c;
      rows.push({
        date:  new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        open:  +(o * adj).toFixed(2),
        high:  +(h * adj).toFixed(2),
        low:   +(l * adj).toFixed(2),
        close: +ac.toFixed(2),
      });
    }
    return rows.length > 0 ? rows : null;
  } catch (e) {
    console.warn(`Yahoo fetch failed for ${symbol}:`, e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// PRESETS
// ─────────────────────────────────────────────────────────────────

const PRESETS = {
  "Nifty 50 Sample": [
    { symbol:"RELIANCE.NS",   name:"Reliance Industries", sector:"Energy"    },
    { symbol:"TCS.NS",        name:"Tata Consultancy",    sector:"IT"        },
    { symbol:"INFY.NS",       name:"Infosys",             sector:"IT"        },
    { symbol:"HDFCBANK.NS",   name:"HDFC Bank",           sector:"Banking"   },
    { symbol:"ICICIBANK.NS",  name:"ICICI Bank",          sector:"Banking"   },
    { symbol:"LT.NS",         name:"Larsen & Toubro",     sector:"Infra"     },
    { symbol:"SBIN.NS",       name:"State Bank of India", sector:"Banking"   },
    { symbol:"BAJFINANCE.NS", name:"Bajaj Finance",       sector:"Finance"   },
    { symbol:"HINDUNILVR.NS", name:"HUL",                 sector:"FMCG"      },
    { symbol:"WIPRO.NS",      name:"Wipro",               sector:"IT"        },
  ],
  "IT Sector": [
    { symbol:"TCS.NS",     name:"TCS",            sector:"IT" },
    { symbol:"INFY.NS",    name:"Infosys",        sector:"IT" },
    { symbol:"WIPRO.NS",   name:"Wipro",          sector:"IT" },
    { symbol:"HCLTECH.NS", name:"HCL Tech",       sector:"IT" },
    { symbol:"TECHM.NS",   name:"Tech Mahindra",  sector:"IT" },
  ],
  "Banking": [
    { symbol:"HDFCBANK.NS",  name:"HDFC Bank",  sector:"Banking" },
    { symbol:"ICICIBANK.NS", name:"ICICI Bank", sector:"Banking" },
    { symbol:"SBIN.NS",      name:"SBI",        sector:"Banking" },
    { symbol:"AXISBANK.NS",  name:"Axis Bank",  sector:"Banking" },
    { symbol:"KOTAKBANK.NS", name:"Kotak Bank", sector:"Banking" },
  ],
  "Auto & Consumer": [
    { symbol:"MARUTI.NS",    name:"Maruti Suzuki",  sector:"Auto"     },
    { symbol:"TATAMOTORS.NS",name:"Tata Motors",    sector:"Auto"     },
    { symbol:"NESTLEIND.NS", name:"Nestle India",   sector:"FMCG"     },
    { symbol:"HINDUNILVR.NS",name:"HUL",            sector:"FMCG"     },
    { symbol:"TITAN.NS",     name:"Titan Company",  sector:"Consumer" },
  ],
};

// ─────────────────────────────────────────────────────────────────
// FORMATTERS
// ─────────────────────────────────────────────────────────────────
const fmtC = v => v == null ? "—" : `₹${Math.abs(v).toLocaleString("en-IN",{maximumFractionDigits:0})}`;
const fmtP = (v,d=1) => v == null ? "—" : `${v>=0?"+":""}${v.toFixed(d)}%`;
const fmtN = (v,d=2) => v == null ? "—" : v.toLocaleString("en-IN",{minimumFractionDigits:d,maximumFractionDigits:d});
const clr  = v => v >= 0 ? C.green : C.red;

// ─────────────────────────────────────────────────────────────────
// SMALL COMPONENTS
// ─────────────────────────────────────────────────────────────────
const Chip = ({label, active, onClick, color=C.accent}) => (
  <button onClick={onClick} style={{
    padding:"5px 13px", borderRadius:20, fontSize:11, fontWeight:600, cursor:"pointer",
    border:`1px solid ${active ? color : C.border}`,
    background: active ? `${color}20` : "transparent",
    color: active ? color : C.textSoft, transition:"all .15s", whiteSpace:"nowrap",
  }}>{label}</button>
);

const Field = ({label, value, big, color, sub}) => (
  <div style={{ background:C.card, border:`1px solid ${C.border}`,
    borderRadius:10, padding:"15px 17px" }}>
    <div style={{ color:C.textSoft, fontSize:10, fontFamily:"DM Mono,monospace",
      letterSpacing:1.2, textTransform:"uppercase", marginBottom:5 }}>{label}</div>
    <div style={{ color: color||C.text, fontSize: big?24:20, fontWeight:700,
      fontFamily:"Syne,sans-serif" }}>{value}</div>
    {sub && <div style={{ color:C.muted, fontSize:10, marginTop:4 }}>{sub}</div>}
  </div>
);

const CTip = ({active, payload, label}) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:C.surface, border:`1px solid ${C.border}`,
      borderRadius:8, padding:"9px 13px", fontSize:12 }}>
      <div style={{ color:C.textSoft, marginBottom:5, fontSize:11 }}>{label}</div>
      {payload.map((p,i) => (
        <div key={i} style={{ color:p.color||C.text, display:"flex", gap:8 }}>
          <span style={{color:C.textSoft}}>{p.name}:</span>
          <span style={{fontWeight:700}}>
            {typeof p.value==="number"
              ? p.dataKey==="drawdown" ? `${p.value.toFixed(2)}%`
                : `₹${p.value.toLocaleString("en-IN",{maximumFractionDigits:0})}`
              : p.value}
          </span>
        </div>
      ))}
    </div>
  );
};

const SLabel = ({s}) => (
  <div style={{ fontFamily:"Syne,sans-serif", fontWeight:800, fontSize:13,
    color:C.textSoft, letterSpacing:2, textTransform:"uppercase", marginBottom:2 }}>{s}</div>
);

// ─────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────
export default function AlphaLens() {
  const [startDate,    setStartDate]    = useState("2020-01-01");
  const [endDate,      setEndDate]      = useState("2024-12-31");
  const [initCap,      setInitCap]      = useState(1000000);
  const [model,        setModel]        = useState(1);
  const [fixedAmt,     setFixedAmt]     = useState(10000);
  const [preset,       setPreset]       = useState("Nifty 50 Sample");
  const [sectors,      setSectors]      = useState([]);
  const [inputMode,    setInputMode]    = useState("preset");
  const [custom,       setCustom]       = useState("");
  const [running,      setRunning]      = useState(false);
  const [progress,     setProgress]     = useState({n:0,t:0,status:"",failed:[]});
  const [results,      setResults]      = useState(null);
  const [activeSymbol, setActiveSymbol] = useState(null);
  const [tab,          setTab]          = useState("overview");
  const [tradeFilter,  setTradeFilter]  = useState("all");
  const [sortCol,      setSortCol]      = useState("date");

  // ── Stock list ──────────────────────────────────────────────
  const stockList = useMemo(() => {
    if (inputMode === "custom") {
      return custom.split("\n").map(s=>s.trim()).filter(Boolean).map(s=>({
        symbol: s.includes(".")?s:s+".NS", name:s.replace(/\.[A-Z]+$/,""), sector:"Custom",
      }));
    }
    const base = PRESETS[preset] || [];
    return sectors.length ? base.filter(s => sectors.includes(s.sector)) : base;
  }, [inputMode, preset, custom, sectors]);

  const allSectors = useMemo(() =>
    [...new Set((PRESETS[preset]||[]).map(s=>s.sector))], [preset]);

  // ── Run ─────────────────────────────────────────────────────
  const run = useCallback(async () => {
    if (!stockList.length) return;
    setRunning(true); setResults(null);
    setProgress({n:0, t:stockList.length, status:"", failed:[]});

    const stockRes = [];
    const failed   = [];
    // Split capital equally across stocks
    const perStockCap = +initCap / stockList.length;

    for (let i = 0; i < stockList.length; i++) {
      const s = stockList[i];
      setProgress(p => ({...p, n:i, status:`Fetching ${s.symbol}…`}));

      // ── Fetch REAL data from Yahoo Finance ──────────────────
      let ohlcv = await fetchYahooOHLCV(s.symbol, startDate, endDate);

      if (!ohlcv || ohlcv.length < 5) {
        failed.push(s.symbol);
        setProgress(p => ({...p, failed:[...p.failed, s.symbol]}));
        continue;
      }

      setProgress(p => ({...p, status:`Running ${s.symbol} (${ohlcv.length} days)…`}));
      await new Promise(r => setTimeout(r, 0)); // yield to UI

      const { trades, equity } = runBacktest(ohlcv, model, +fixedAmt, perStockCap);
      const st = stats(trades, equity, perStockCap);
      stockRes.push({ ...s, trades, equity, stats:st, ohlcv, perStockCap });
      setProgress(p => ({...p, n:i+1, status:`Done ${s.name} — ${trades.length} lots`}));
    }

    if (!stockRes.length) {
      setRunning(false);
      setProgress(p => ({...p, status:"❌ All fetches failed. Check symbols or internet."}));
      return;
    }

    setProgress(p => ({...p, status:"Building portfolio…"}));
    await new Promise(r => setTimeout(r, 0));

    const allDates = [...new Set(stockRes.flatMap(r => r.equity.map(p => p.date)))].sort();
    const portEq   = allDates.map(date => ({
      date,
      equity: stockRes.reduce((sum, r) => {
        const pt = r.equity.find(p => p.date === date);
        return sum + (pt ? pt.equity : r.equity[0]?.equity || perStockCap);
      }, 0),
    }));

    const allTrades = stockRes.flatMap(r =>
      r.trades.map(t => ({...t, symbol:r.symbol, name:r.name}))
    );
    const portInitCap = portEq.length > 0 ? portEq[0].equity : +initCap;
    const portStats   = stats(allTrades, portEq, portInitCap);

    setResults({ stockRes, portEq, portStats, allTrades, failed });
    setActiveSymbol(stockRes[0]?.symbol || null);
    setProgress(p => ({...p, n:stockList.length,
      status:`✅ Complete — ${stockRes.length} stocks, ${allTrades.length} lots`}));
    setRunning(false);
  }, [stockList, startDate, endDate, initCap, model, fixedAmt]);

  const active = results?.stockRes?.find(r=>r.symbol===activeSymbol);
  const curveData = active ? active.equity : results?.portEq;
  const statsData = active ? active.stats  : results?.portStats;
  const label     = active ? active.name   : "Portfolio";

  // ── Drawdown series ─────────────────────────────────────────
  const ddSeries = useMemo(() => {
    if (!curveData) return [];
    let peak = curveData[0]?.equity || 0;
    return curveData.map(p => {
      if (p.equity > peak) peak = p.equity;
      return { date:p.date, drawdown: peak>0 ? +((p.equity-peak)/peak*100).toFixed(2) : 0 };
    });
  }, [curveData]);

  // ── Monthly P&L ─────────────────────────────────────────────
  const monthlyData = useMemo(() => {
    if (!statsData) return [];
    return Object.entries(statsData.monthly||{})
      .map(([m,pnl]) => ({m, pnl}))
      .sort((a,b) => a.m.localeCompare(b.m));
  }, [statsData]);

  // ── Sector data ─────────────────────────────────────────────
  const sectorData = useMemo(() => {
    if (!results) return [];
    const map = {};
    for (const r of results.stockRes) {
      const s = r.sector;
      if (!map[s]) map[s]={sector:s,pnl:0,cagr:0,count:0};
      map[s].pnl   += r.stats.totalPnL;
      map[s].cagr  += r.stats.cagr;
      map[s].count += 1;
    }
    return Object.values(map).map(d=>({...d,cagr:d.cagr/d.count}))
      .sort((a,b)=>b.pnl-a.pnl);
  }, [results]);

  // ── Trade log ───────────────────────────────────────────────
  const displayTrades = useMemo(() => {
    if (!results) return [];
    const src = active
      ? active.trades.map(t=>({...t,symbol:active.symbol,name:active.name}))
      : results.allTrades;
    let f = tradeFilter==="open"   ? src.filter(t=>t.status==="open")
           : tradeFilter==="closed" ? src.filter(t=>t.status==="closed")
           : src;
    if (sortCol==="pnl") f = [...f].sort((a,b)=>(b.pnl||0)-(a.pnl||0));
    else f = [...f].sort((a,b)=>a.entry_date?.localeCompare(b.entry_date));
    return f;
  }, [results, active, tradeFilter, sortCol]);

  // ── Stock comparison ────────────────────────────────────────
  const compData = useMemo(() => {
    if (!results) return [];
    return [...results.stockRes].sort((a,b)=>b.stats.totalPnL-a.stats.totalPnL);
  }, [results]);

  // ─────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.text,
      fontFamily:"'DM Sans',sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px;height:5px}
        ::-webkit-scrollbar-track{background:${C.bg}}
        ::-webkit-scrollbar-thumb{background:${C.muted};border-radius:3px}
        button{transition:opacity .15s}
        button:hover{opacity:.8}
        input,textarea{outline:none}
      `}</style>

      {/* ══ TOPBAR ══════════════════════════════════════════════ */}
      <div style={{ height:56, background:`${C.surface}ee`, backdropFilter:"blur(16px)",
        borderBottom:`1px solid ${C.border}`, position:"sticky", top:0, zIndex:200,
        display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 28px" }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <div style={{ width:30, height:30, borderRadius:7,
            background:`linear-gradient(135deg,${C.accent},${C.accent2})`,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontWeight:900, fontSize:15, color:"#000" }}>▲</div>
          <div>
            <div style={{ fontFamily:"Syne", fontWeight:800, fontSize:16, letterSpacing:-.4 }}>
              AlphaLens</div>
            <div style={{ fontSize:9, color:C.textSoft, letterSpacing:2,
              textTransform:"uppercase" }}>PMS Strategy Backtester</div>
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:10, color:C.muted, fontFamily:"DM Mono,monospace" }}>
            Live data via Yahoo Finance · NSE/BSE supported
          </span>
          <div style={{ padding:"3px 10px", borderRadius:20, fontSize:10,
            background:`${C.accent}18`, color:C.accent, border:`1px solid ${C.accent}33`,
            fontWeight:600 }}>v4.0</div>
        </div>
      </div>

      <div style={{ display:"flex", minHeight:"calc(100vh - 56px)" }}>

        {/* ══ SIDEBAR ═════════════════════════════════════════════ */}
        <aside style={{ width:288, background:C.surface,
          borderRight:`1px solid ${C.border}`, padding:18,
          display:"flex", flexDirection:"column", gap:18,
          overflowY:"auto", flexShrink:0 }}>

          <SLabel s="Date Range" />
          {[["From", startDate, setStartDate], ["To", endDate, setEndDate]].map(([l,v,s]) => (
            <div key={l} style={{ display:"flex", flexDirection:"column", gap:4 }}>
              <label style={{ color:C.muted, fontSize:10, fontFamily:"DM Mono,monospace",
                letterSpacing:1, textTransform:"uppercase" }}>{l}</label>
              <input type="date" value={v} onChange={e=>s(e.target.value)} style={{
                background:C.card, border:`1px solid ${C.border}`, borderRadius:7,
                color:C.text, padding:"8px 10px", fontSize:13,
                fontFamily:"DM Mono,monospace", width:"100%" }} />
            </div>
          ))}

          <div style={{ borderTop:`1px solid ${C.border}` }} />
          <SLabel s="Capital & Model" />

          <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
            <label style={{ color:C.muted, fontSize:10, fontFamily:"DM Mono,monospace",
              letterSpacing:1 }}>INITIAL CAPITAL (₹)</label>
            <input type="number" value={initCap} min={10000} step={10000}
              onChange={e=>setInitCap(e.target.value)} style={{
                background:C.card, border:`1px solid ${C.border}`, borderRadius:7,
                color:C.text, padding:"8px 10px", fontSize:13,
                fontFamily:"DM Mono,monospace", width:"100%" }} />
          </div>

          {/* Investment Model Selector */}
          {[
            {id:1, label:"Model 1 — Fixed ₹/trade",  desc:"Same rupee amount every lot"},
            {id:2, label:"Model 2 — 1% of Capital",   desc:"1% of initial capital/lot"},
            {id:3, label:"Model 3 — 1% Dynamic",      desc:"1% of prev day balance/lot"},
          ].map(m => (
            <div key={m.id} onClick={()=>setModel(m.id)} style={{
              padding:"10px 12px", borderRadius:8, cursor:"pointer",
              border:`1px solid ${model===m.id ? C.accent : C.border}`,
              background: model===m.id ? `${C.accent}0e` : "transparent",
            }}>
              <div style={{ fontSize:12, fontWeight:600,
                color:model===m.id ? C.accent : C.text }}>{m.label}</div>
              <div style={{ fontSize:10, color:C.muted, marginTop:2 }}>{m.desc}</div>
            </div>
          ))}

          {model===1 && (
            <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
              <label style={{ color:C.muted, fontSize:10, fontFamily:"DM Mono,monospace",
                letterSpacing:1 }}>FIXED AMOUNT / LOT (₹)</label>
              <input type="number" value={fixedAmt} min={1000} step={1000}
                onChange={e=>setFixedAmt(e.target.value)} style={{
                  background:C.card, border:`1px solid ${C.border}`, borderRadius:7,
                  color:C.text, padding:"8px 10px", fontSize:13,
                  fontFamily:"DM Mono,monospace", width:"100%" }} />
            </div>
          )}

          <div style={{ borderTop:`1px solid ${C.border}` }} />
          <SLabel s="Stock Universe" />

          <div style={{ display:"flex", gap:6 }}>
            <Chip label="Preset"  active={inputMode==="preset"} onClick={()=>setInputMode("preset")} />
            <Chip label="Custom"  active={inputMode==="custom"} onClick={()=>setInputMode("custom")} />
          </div>

          {inputMode==="preset" ? (<>
            {Object.keys(PRESETS).map(p => (
              <div key={p} onClick={()=>{setPreset(p);setSectors([]);}} style={{
                padding:"8px 11px", borderRadius:7, cursor:"pointer",
                border:`1px solid ${preset===p ? C.accent2 : "transparent"}`,
                background: preset===p ? `${C.accent2}12` : `${C.card}`,
                fontSize:12, color: preset===p ? C.accent2 : C.textSoft,
                fontWeight: preset===p ? 600 : 400,
              }}>{p} <span style={{color:C.muted}}>({PRESETS[p].length})</span></div>
            ))}
            {allSectors.length > 1 && (<>
              <div style={{ color:C.muted, fontSize:10, letterSpacing:1 }}>FILTER BY SECTOR</div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
                {allSectors.map(s => (
                  <Chip key={s} label={s} color={C.accent3}
                    active={sectors.includes(s)}
                    onClick={()=>setSectors(prev => prev.includes(s)
                      ? prev.filter(x=>x!==s) : [...prev,s])} />
                ))}
              </div>
            </>)}
          </>) : (
            <textarea value={custom} onChange={e=>setCustom(e.target.value)}
              placeholder={"RELIANCE\nTCS.NS\nINFY"} rows={7} style={{
                background:C.card, border:`1px solid ${C.border}`, borderRadius:7,
                color:C.text, padding:"8px 10px", fontSize:12,
                fontFamily:"DM Mono,monospace", resize:"vertical", width:"100%" }} />
          )}

          <div style={{ color:C.muted, fontSize:11 }}>
            {stockList.length} stock{stockList.length!==1?"s":""} selected
          </div>

          <button onClick={run} disabled={running||!stockList.length} style={{
            padding:"13px", borderRadius:9, fontWeight:700, fontSize:14,
            fontFamily:"Syne", cursor:running?"not-allowed":"pointer", border:"none",
            background: running ? C.border
              : `linear-gradient(135deg,${C.accent} 0%,${C.accent2} 100%)`,
            color: running ? C.muted : "#000", marginTop:"auto",
          }}>
            {running ? `⟳  ${progress.n} / ${progress.t}` : "▶  Run Backtest"}
          </button>

          {running && (
            <div style={{display:"flex", flexDirection:"column", gap:6}}>
              <div style={{ background:C.border, borderRadius:3, height:3, overflow:"hidden" }}>
                <div style={{ height:"100%", borderRadius:3,
                  background:`linear-gradient(90deg,${C.accent},${C.accent2})`,
                  width:`${progress.t ? (progress.n/progress.t)*100 : 0}%`,
                  transition:"width .3s" }} />
              </div>
              <div style={{fontSize:10, color:C.textSoft, fontFamily:"DM Mono,monospace",
                wordBreak:"break-all"}}>{progress.status}</div>
            </div>
          )}

          {/* Failed symbols warning */}
          {!running && results?.failed?.length > 0 && (
            <div style={{background:`${C.red}11`, border:`1px solid ${C.red}33`,
              borderRadius:7, padding:"8px 10px", fontSize:11}}>
              <div style={{color:C.red, fontWeight:700, marginBottom:4}}>
                ⚠ {results.failed.length} symbol(s) failed to fetch:
              </div>
              <div style={{color:C.muted, fontFamily:"DM Mono,monospace", fontSize:10}}>
                {results.failed.join(", ")}
              </div>
              <div style={{color:C.muted, fontSize:10, marginTop:4}}>
                Check symbol names — use .NS for NSE, .BO for BSE
              </div>
            </div>
          )}
        </aside>

        {/* ══ CONTENT ═════════════════════════════════════════════ */}
        <main style={{ flex:1, overflowY:"auto", padding:24 }}>
          {!results ? (
            /* ── SPLASH ── */
            <div style={{ height:"100%", minHeight:500, display:"flex",
              flexDirection:"column", alignItems:"center", justifyContent:"center", gap:18 }}>
              <div style={{ width:72, height:72, borderRadius:18,
                background:`linear-gradient(135deg,${C.accent}30,${C.accent2}30)`,
                display:"flex", alignItems:"center", justifyContent:"center", fontSize:32 }}>📊</div>
              <div style={{ fontFamily:"Syne", fontSize:26, fontWeight:800, textAlign:"center" }}>
                PMS-Grade Strategy Analytics</div>
              <div style={{ color:C.textSoft, fontSize:14, textAlign:"center", maxWidth:460, lineHeight:1.7 }}>
                Configure your universe, capital, investment model and date range on the left —
                then click <b style={{color:C.accent}}>Run Backtest</b>.
                Real historical data is fetched live from Yahoo Finance.
              </div>
              <div style={{ display:"flex", gap:16, flexWrap:"wrap", justifyContent:"center", marginTop:4 }}>
                {["Equity Curve","Max Drawdown","Sharpe Ratio","CAGR","Win Rate",
                  "Monthly P&L","Sector Breakdown","Trade Log","3 Allocation Models"].map(f => (
                  <div key={f} style={{ padding:"4px 12px", borderRadius:20,
                    background:`${C.accent}0e`, color:C.accent, border:`1px solid ${C.accent}33`,
                    fontSize:11, fontWeight:600 }}>{f}</div>
                ))}
              </div>
            </div>
          ) : (<>

            {/* ── STOCK SELECTOR TABS ── */}
            <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginBottom:18 }}>
              <Chip label="▣ Portfolio" active={!activeSymbol}
                onClick={()=>setActiveSymbol(null)} />
              {results.stockRes.map(r => (
                <button key={r.symbol} onClick={()=>setActiveSymbol(r.symbol)} style={{
                  padding:"5px 12px", borderRadius:20, fontSize:11, fontWeight:600,
                  cursor:"pointer", border:`1px solid ${activeSymbol===r.symbol ? C.accent2 : C.border}`,
                  background: activeSymbol===r.symbol ? `${C.accent2}18` : "transparent",
                  color: activeSymbol===r.symbol ? C.accent2 : C.textSoft,
                  display:"flex", alignItems:"center", gap:5,
                }}>
                  <span style={{ width:5, height:5, borderRadius:"50%", flexShrink:0,
                    background: r.stats.totalPnL>=0 ? C.green : C.red }} />
                  {r.name}
                </button>
              ))}
            </div>

            {/* ── KPI GRID ── */}
            <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10, marginBottom:10 }}>
              <Field label="Total P&L" value={fmtC(statsData.totalPnL)}
                color={clr(statsData.totalPnL)}
                sub={statsData.totalPnL>=0 ? "Profitable" : "Loss-making"} big />
              <Field label="Final Equity" value={fmtC(statsData.finalEq)}
                sub={`Invested: ₹${(+initCap).toLocaleString("en-IN")}`} />
              <Field label="CAGR" value={fmtP(statsData.cagr)}
                color={clr(statsData.cagr)} />
              <Field label="Sharpe Ratio" value={fmtN(statsData.sharpe)}
                color={statsData.sharpe>=1 ? C.green : statsData.sharpe>=0 ? C.accent3 : C.red}
                sub={statsData.sharpe>=1?"Excellent":statsData.sharpe>=0.5?"Good":"Poor"} />
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10, marginBottom:18 }}>
              <Field label="Win Rate" value={`${statsData.winRate?.toFixed(1)}%`}
                color={clr(statsData.winRate-50)}
                sub={`${statsData.winners}W  /  ${statsData.losers}L`} />
              <Field label="Profit Factor" value={statsData.profitFactor===Infinity?"∞"
                : fmtN(statsData.profitFactor)} color={clr(statsData.profitFactor-1)} />
              <Field label="Max Drawdown" value={`${statsData.maxDDPct?.toFixed(1)}%`}
                color={C.red} sub={fmtC(statsData.maxDD)} />
              <Field label="Trades" value={statsData.totalTrades}
                sub={`${statsData.openTrades} open positions`} />
            </div>

            {/* ── TABS ── */}
            <div style={{ display:"flex", borderBottom:`1px solid ${C.border}`, marginBottom:18 }}>
              {[["overview","Overview"],["trades","Trade Log"],
                ["sector","Sector Analysis"],["monthly","Monthly P&L"]].map(([id,lbl]) => (
                <button key={id} onClick={()=>setTab(id)} style={{
                  padding:"9px 18px", fontSize:13, fontWeight:600, border:"none",
                  background:"transparent", cursor:"pointer",
                  color: tab===id ? C.accent : C.textSoft,
                  borderBottom:`2px solid ${tab===id ? C.accent : "transparent"}`,
                  transition:"all .15s",
                }}>{lbl}</button>
              ))}
            </div>

            {/* ════ TAB: OVERVIEW ════ */}
            {tab==="overview" && (
              <div style={{ display:"flex", flexDirection:"column", gap:14 }}>

                {/* Equity Curve */}
                <div style={{ background:C.card, border:`1px solid ${C.border}`,
                  borderRadius:12, padding:18 }}>
                  <div style={{ fontFamily:"Syne", fontWeight:700, fontSize:14, marginBottom:14,
                    display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <span>Equity Curve — {label}</span>
                    <span style={{ fontSize:11, color:C.textSoft, fontFamily:"DM Mono,monospace" }}>
                      {curveData?.[0]?.date} → {curveData?.[curveData.length-1]?.date}
                    </span>
                  </div>
                  <ResponsiveContainer width="100%" height={210}>
                    <AreaChart data={curveData}>
                      <defs>
                        <linearGradient id="ge" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor={C.accent} stopOpacity={.35} />
                          <stop offset="95%" stopColor={C.accent} stopOpacity={0}   />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                      <XAxis dataKey="date" tick={{fill:C.muted,fontSize:9}}
                        tickFormatter={d=>d?.slice(0,7)} interval="preserveStartEnd" />
                      <YAxis tick={{fill:C.muted,fontSize:9}} width={68}
                        tickFormatter={v=>`₹${(v/1e5).toFixed(1)}L`} />
                      <Tooltip content={<CTip />} />
                      <ReferenceLine y={+initCap*(active?1:results.stockRes.length)}
                        stroke={C.muted} strokeDasharray="4 2" strokeWidth={1} />
                      <Area type="monotone" dataKey="equity" name="Equity"
                        stroke={C.accent} fill="url(#ge)" strokeWidth={2} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                {/* Drawdown */}
                <div style={{ background:C.card, border:`1px solid ${C.border}`,
                  borderRadius:12, padding:18 }}>
                  <div style={{ fontFamily:"Syne", fontWeight:700, fontSize:13, marginBottom:12 }}>
                    Drawdown %  <span style={{ color:C.red, fontSize:12 }}>
                      (Peak: −{statsData.maxDDPct?.toFixed(1)}%)</span>
                  </div>
                  <ResponsiveContainer width="100%" height={130}>
                    <AreaChart data={ddSeries}>
                      <defs>
                        <linearGradient id="gd" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor={C.red} stopOpacity={.4}  />
                          <stop offset="95%" stopColor={C.red} stopOpacity={0}   />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                      <XAxis dataKey="date" tick={{fill:C.muted,fontSize:9}}
                        tickFormatter={d=>d?.slice(0,7)} interval="preserveStartEnd" />
                      <YAxis tick={{fill:C.muted,fontSize:9}} width={45}
                        tickFormatter={v=>`${v.toFixed(0)}%`} />
                      <Tooltip content={<CTip />} />
                      <Area type="monotone" dataKey="drawdown" name="Drawdown%"
                        stroke={C.red} fill="url(#gd)" strokeWidth={1.5} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                {/* Stock Comparison (portfolio view only) */}
                {!activeSymbol && (
                  <div style={{ background:C.card, border:`1px solid ${C.border}`,
                    borderRadius:12, padding:18 }}>
                    <div style={{ fontFamily:"Syne", fontWeight:700, fontSize:14, marginBottom:14 }}>
                      Stock Comparison</div>
                    <div style={{ overflowX:"auto" }}>
                      <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                        <thead>
                          <tr style={{ color:C.textSoft, borderBottom:`1px solid ${C.border}` }}>
                            {["Stock","Sector","CAGR","P&L","Win%","Profit Factor","MaxDD%","Sharpe","Trades"]
                              .map(h=>(
                              <th key={h} style={{ padding:"7px 10px", textAlign:"left",
                                fontFamily:"DM Mono,monospace", fontSize:9, letterSpacing:1,
                                textTransform:"uppercase" }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {compData.map(r=>(
                            <tr key={r.symbol} onClick={()=>setActiveSymbol(r.symbol)}
                              style={{ borderBottom:`1px solid ${C.border}22`, cursor:"pointer" }}
                              onMouseEnter={e=>e.currentTarget.style.background=C.surface}
                              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                              <td style={{ padding:"9px 10px" }}>
                                <div style={{fontWeight:600,fontSize:13}}>{r.name}</div>
                                <div style={{color:C.muted,fontSize:10,fontFamily:"DM Mono,monospace"}}>{r.symbol}</div>
                              </td>
                              <td style={{padding:"9px 10px"}}>
                                <span style={{background:`${C.accent3}18`,color:C.accent3,
                                  padding:"2px 7px",borderRadius:10,fontSize:10}}>{r.sector}</span>
                              </td>
                              <td style={{padding:"9px 10px",color:clr(r.stats.cagr),fontWeight:700}}>
                                {fmtP(r.stats.cagr)}</td>
                              <td style={{padding:"9px 10px",color:clr(r.stats.totalPnL),fontWeight:700}}>
                                {fmtC(r.stats.totalPnL)}</td>
                              <td style={{padding:"9px 10px",color:clr(r.stats.winRate-50)}}>
                                {r.stats.winRate?.toFixed(1)}%</td>
                              <td style={{padding:"9px 10px",color:clr(r.stats.profitFactor-1)}}>
                                {r.stats.profitFactor===Infinity?"∞":r.stats.profitFactor?.toFixed(2)}</td>
                              <td style={{padding:"9px 10px",color:C.red}}>
                                {r.stats.maxDDPct?.toFixed(1)}%</td>
                              <td style={{padding:"9px 10px",color:clr(r.stats.sharpe)}}>
                                {r.stats.sharpe?.toFixed(2)}</td>
                              <td style={{padding:"9px 10px",color:C.textSoft}}>
                                {r.stats.totalTrades}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ════ TAB: TRADES ════ */}
            {tab==="trades" && (
              <div style={{ background:C.card, border:`1px solid ${C.border}`,
                borderRadius:12, padding:18 }}>
                <div style={{ display:"flex", justifyContent:"space-between",
                  alignItems:"center", marginBottom:14, flexWrap:"wrap", gap:8 }}>
                  <div style={{ fontFamily:"Syne", fontWeight:700, fontSize:14 }}>
                    Trade Log — {displayTrades.length} entries
                  </div>
                  <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                    {[["all","All"],["open","Open"],["closed","Closed"]].map(([v,l])=>(
                      <Chip key={v} label={l} active={tradeFilter===v}
                        onClick={()=>setTradeFilter(v)} />
                    ))}
                    <Chip label="Sort: Date" active={sortCol==="date"}
                      onClick={()=>setSortCol("date")} color={C.accent3} />
                    <Chip label="Sort: P&L"  active={sortCol==="pnl"}
                      onClick={()=>setSortCol("pnl")} color={C.accent3} />
                  </div>
                </div>
                <div style={{ overflowX:"auto", maxHeight:500, overflowY:"auto" }}>
                  <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                    <thead style={{ position:"sticky", top:0, background:C.card, zIndex:1 }}>
                      <tr style={{ color:C.textSoft, borderBottom:`1px solid ${C.border}` }}>
                        {(!active?["Symbol"]:[])}
                        {["Entry Date","Entry ₹","Qty","Lot ₹",
                          "Exit Date","Exit ₹","P&L","Return%","Status"].map(h=>(
                          <th key={h} style={{ padding:"7px 10px", textAlign:"left",
                            fontFamily:"DM Mono,monospace", fontSize:9, whiteSpace:"nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {displayTrades.map((t,i)=>{
                        const ret = t.pnl!==null && t.lot_capital
                          ? (t.pnl / t.lot_capital)*100 : null;
                        return (
                          <tr key={i} style={{ borderBottom:`1px solid ${C.border}14` }}
                            onMouseEnter={e=>e.currentTarget.style.background=C.surface}
                            onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                            {!active && (
                              <td style={{padding:"7px 10px",color:C.accent2,fontSize:11,
                                fontFamily:"DM Mono,monospace",whiteSpace:"nowrap"}}>{t.symbol}</td>
                            )}
                            <td style={{padding:"7px 10px",color:C.textSoft,whiteSpace:"nowrap"}}>
                              {t.entry_date}</td>
                            <td style={{padding:"7px 10px",fontFamily:"DM Mono,monospace"}}>
                              ₹{t.entry_price?.toFixed(2)}</td>
                            <td style={{padding:"7px 10px"}}>{t.quantity}</td>
                            <td style={{padding:"7px 10px",color:C.muted,fontFamily:"DM Mono,monospace"}}>
                              ₹{t.lot_capital?.toFixed(0)}</td>
                            <td style={{padding:"7px 10px",color:C.textSoft,whiteSpace:"nowrap"}}>
                              {t.exit_date||"—"}</td>
                            <td style={{padding:"7px 10px",fontFamily:"DM Mono,monospace"}}>
                              {t.exit_price?`₹${t.exit_price.toFixed(2)}`:"—"}</td>
                            <td style={{padding:"7px 10px",color:t.pnl==null?C.muted:clr(t.pnl),
                              fontWeight:600}}>
                              {t.pnl!=null?fmtC(t.pnl):"Open"}</td>
                            <td style={{padding:"7px 10px",color:ret==null?C.muted:clr(ret)}}>
                              {ret!=null?fmtP(ret):"—"}</td>
                            <td style={{padding:"7px 10px"}}>
                              <span style={{
                                padding:"2px 8px", borderRadius:10, fontSize:10, fontWeight:600,
                                background: t.status==="open"
                                  ? `${C.accent3}18` : t.pnl>=0 ? `${C.green}18` : `${C.red}18`,
                                color: t.status==="open"
                                  ? C.accent3 : t.pnl>=0 ? C.green : C.red,
                              }}>{t.status}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ════ TAB: SECTOR ════ */}
            {tab==="sector" && (
              <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
                <div style={{ background:C.card, border:`1px solid ${C.border}`,
                  borderRadius:12, padding:18 }}>
                  <div style={{ fontFamily:"Syne", fontWeight:700, fontSize:14, marginBottom:14 }}>
                    Sector P&L</div>
                  <ResponsiveContainer width="100%" height={Math.max(160, sectorData.length*52)}>
                    <BarChart data={sectorData} layout="vertical"
                      margin={{left:10,right:30,top:0,bottom:0}}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false} />
                      <XAxis type="number" tick={{fill:C.muted,fontSize:9}}
                        tickFormatter={v=>`₹${(v/1000).toFixed(0)}K`} />
                      <YAxis type="category" dataKey="sector"
                        tick={{fill:C.text,fontSize:12}} width={100} />
                      <Tooltip content={<CTip />} />
                      <Bar dataKey="pnl" name="P&L" radius={[0,4,4,0]}>
                        {sectorData.map((d,i)=>(
                          <Cell key={i} fill={d.pnl>=0?C.green:C.red} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))", gap:10 }}>
                  {sectorData.map(s=>(
                    <div key={s.sector} style={{ background:C.card,
                      border:`1px solid ${C.border}`, borderRadius:10, padding:14 }}>
                      <div style={{ color:C.accent3, fontWeight:700, fontSize:12,
                        marginBottom:4 }}>{s.sector}</div>
                      <div style={{ color:clr(s.pnl), fontSize:20, fontWeight:700,
                        fontFamily:"Syne" }}>{fmtC(s.pnl)}</div>
                      <div style={{ color:clr(s.cagr), fontSize:11, marginTop:3 }}>
                        CAGR {fmtP(s.cagr)}</div>
                      <div style={{ color:C.muted, fontSize:10, marginTop:2 }}>
                        {s.count} stock{s.count!==1?"s":""}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ════ TAB: MONTHLY ════ */}
            {tab==="monthly" && (
              <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
                <div style={{ background:C.card, border:`1px solid ${C.border}`,
                  borderRadius:12, padding:18 }}>
                  <div style={{ fontFamily:"Syne", fontWeight:700, fontSize:14, marginBottom:14 }}>
                    Monthly P&L — {label}</div>
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={monthlyData} margin={{left:0,right:10,top:0,bottom:0}}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                      <XAxis dataKey="m" tick={{fill:C.muted,fontSize:9}} interval={2}
                        tickFormatter={v=>v?.slice(2)} />
                      <YAxis tick={{fill:C.muted,fontSize:9}} width={58}
                        tickFormatter={v=>`₹${(v/1000).toFixed(0)}K`} />
                      <Tooltip content={<CTip />} />
                      <ReferenceLine y={0} stroke={C.muted} strokeWidth={1} />
                      <Bar dataKey="pnl" name="Monthly P&L" radius={[3,3,0,0]}>
                        {monthlyData.map((d,i)=>(
                          <Cell key={i} fill={d.pnl>=0?C.green:C.red} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Monthly table */}
                <div style={{ background:C.card, border:`1px solid ${C.border}`,
                  borderRadius:12, padding:18 }}>
                  <div style={{ fontFamily:"Syne", fontWeight:700, fontSize:13, marginBottom:12 }}>
                    Monthly Performance Table</div>
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))", gap:8 }}>
                    {monthlyData.map((d,i)=>{
                      const maxAbs = Math.max(...monthlyData.map(x=>Math.abs(x.pnl)),1);
                      const pct = Math.abs(d.pnl)/maxAbs*100;
                      return (
                        <div key={i} style={{ background:C.surface,
                          border:`1px solid ${d.pnl>=0?C.green+"33":C.red+"33"}`,
                          borderRadius:8, padding:"10px 12px" }}>
                          <div style={{ color:C.textSoft, fontSize:10,
                            fontFamily:"DM Mono,monospace", marginBottom:4 }}>{d.m}</div>
                          <div style={{ color:clr(d.pnl), fontWeight:700, fontSize:15,
                            fontFamily:"Syne" }}>{fmtC(d.pnl)}</div>
                          <div style={{ marginTop:6, height:4, borderRadius:2,
                            background:C.border, overflow:"hidden" }}>
                            <div style={{ height:"100%", borderRadius:2,
                              width:`${pct}%`, background:d.pnl>=0?C.green:C.red }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* ── MODEL FOOTER ── */}
            <div style={{ marginTop:14, background:`${C.accent2}0c`,
              border:`1px solid ${C.accent2}28`, borderRadius:9,
              padding:"10px 16px", fontSize:11, color:C.textSoft, display:"flex",
              flexWrap:"wrap", gap:8, alignItems:"center" }}>
              <span style={{color:C.accent2,fontWeight:700}}>Active Model:</span>
              {model===1&&<span>Model 1 — Fixed ₹{(+fixedAmt).toLocaleString("en-IN")} per lot</span>}
              {model===2&&<span>Model 2 — 1% of initial capital (₹{(+initCap*0.01).toLocaleString("en-IN")}) per lot</span>}
              {model===3&&<span>Model 3 — 1% of previous day's balance (dynamic sizing)</span>}
              <span style={{color:C.muted}}>·</span>
              <span style={{color:C.muted}}>Max 7 lots  ·  5% step-down entries  ·  15% first exit  ·  40% stop-loss  ·  LIFO exits</span>
            </div>
          </>)}
        </main>
      </div>
    </div>
  );
}
