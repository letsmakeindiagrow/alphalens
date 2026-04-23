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
// INVESTMENT MODEL
// ─────────────────────────────────────────────────────────────────
function getLotCap(model, fixedAmt, initialCap, prevBal) {
  if (model === 1) return fixedAmt;
  if (model === 2) return initialCap * 0.01;
  return Math.max(prevBal, 1000) * 0.01;
}

// ─────────────────────────────────────────────────────────────────
// YAHOO FINANCE FETCHER
// Tries 3 methods in order until one works:
//   1. Direct Yahoo Finance API (works when CORS allows)
//   2. allorigins CORS proxy
//   3. corsproxy.io
// ─────────────────────────────────────────────────────────────────
async function fetchYahooOHLCV(symbol, startDate, endDate) {
  const p1  = Math.floor(new Date(startDate).getTime() / 1000);
  const p2  = Math.floor(new Date(endDate).getTime()   / 1000) + 86400;
  const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${p1}&period2=${p2}&events=splits`;

  // Three URLs to try in order
  const attempts = [
    // Attempt 1: direct (works on some hosts / when Yahoo allows)
    { url: yUrl, direct: true },
    // Attempt 2: allorigins proxy (free, reliable)
    { url: `https://api.allorigins.win/get?url=${encodeURIComponent(yUrl)}`, proxy: "allorigins" },
    // Attempt 3: corsproxy.io
    { url: `https://corsproxy.io/?${encodeURIComponent(yUrl)}`, proxy: "corsproxy" },
  ];

  for (const attempt of attempts) {
    try {
      const res = await fetch(attempt.url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;

      let json;
      if (attempt.proxy === "allorigins") {
        const wrapper = await res.json();
        json = JSON.parse(wrapper.contents);
      } else {
        json = await res.json();
      }

      const result = json?.chart?.result?.[0];
      if (!result?.timestamp?.length) continue;

      const timestamps = result.timestamp;
      const q          = result.indicators.quote[0];
      const adjClose   = result.indicators.adjclose?.[0]?.adjclose || q.close;

      const rows = [];
      for (let i = 0; i < timestamps.length; i++) {
        const o = q.open[i], h = q.high[i], l = q.low[i];
        const c = q.close[i], ac = adjClose[i];
        if (o == null || h == null || l == null || c == null || !ac || c === 0) continue;
        const adj = ac / c;
        rows.push({
          date:  new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
          open:  +(o * adj).toFixed(2),
          high:  +(h * adj).toFixed(2),
          low:   +(l * adj).toFixed(2),
          close: +ac.toFixed(2),
        });
      }
      if (rows.length > 10) return rows;  // success
    } catch (e) {
      // try next
    }
  }
  return null;  // all failed
}

// ─────────────────────────────────────────────────────────────────
// BACKTEST ENGINE  (identical logic to Python version)
// ─────────────────────────────────────────────────────────────────
function runBacktest(ohlcv, model, fixedAmt, initialCap) {
  const trades = [];
  const lots   = [];
  let cycleOn = false, nextBuy = null, nextSell = null;
  let stopPx = null;
  let cash = initialCap;

  const lc = () => getLotCap(model, fixedAmt, initialCap, cash);

  const makeLot = (date, px) => {
    const cap = lc();
    return {
      entry_date: date, entry_price: px,
      quantity: Math.max(1, Math.floor(cap / px)),
      lot_capital: cap,
      exit_date: null, exit_price: null, exit_quantity: null,
      pnl: null, status: "open",
    };
  };

  const startCycle = (date, px) => {
    cycleOn = true;
    stopPx  = px * (1 - STOP_DROP);
    const l = makeLot(date, px);
    cash   -= l.lot_capital;
    lots.push(l);
    nextBuy  = px * (1 - STEP_DOWN);
    nextSell = px * (1 + FIRST_EXIT);
  };

  const addLot = (date, px) => {
    const l = makeLot(date, px);
    cash   -= l.lot_capital;
    lots.push(l);
    nextBuy  = px * (1 - STEP_DOWN);
    nextSell = px * (1 + FIRST_EXIT);
  };

  const closeAll = (date, px) => {
    lots.forEach(l => {
      cash += l.quantity * px;
      l.exit_date = date; l.exit_price = px;
      l.exit_quantity = l.quantity;
      l.pnl = l.quantity * (px - l.entry_price);
      l.status = "closed";
      trades.push(l);
    });
    lots.length = 0;
    cycleOn = false; nextBuy = nextSell = stopPx = null;
  };

  const sellTop = (date, px) => {
    const l = lots.pop();
    cash += l.quantity * px;
    l.exit_date = date; l.exit_price = px;
    l.exit_quantity = l.quantity;
    l.pnl = l.quantity * (px - l.entry_price);
    l.status = "closed";
    trades.push(l);
    if (!lots.length) {
      cycleOn = false; nextBuy = nextSell = stopPx = null;
    } else {
      nextSell = px * (1 + STEP_UP);
    }
  };

  const equity = [];

  for (const { date, open, high, low, close } of ohlcv) {
    const mtm = lots.reduce((s, l) => s + l.quantity * close, 0);
    equity.push({ date, equity: cash + mtm });

    if (!cycleOn)          { startCycle(date, open); continue; }
    if (low <= stopPx)     { closeAll(date, stopPx);  continue; }

    let g = 0;
    while (lots.length < MAX_LOTS && nextBuy !== null && low <= nextBuy && ++g < 20)
      addLot(date, nextBuy);

    g = 0;
    while (lots.length && nextSell !== null && high >= nextSell && ++g < 20) {
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
function calcStats(trades, equity, initCap) {
  const closed  = trades.filter(t => t.status === "closed");
  const open    = trades.filter(t => t.status === "open");
  const winners = closed.filter(t => t.pnl > 0);
  const losers  = closed.filter(t => t.pnl <= 0);
  const totalPnL     = closed.reduce((s, t) => s + t.pnl, 0);
  const winRate      = closed.length ? (winners.length / closed.length) * 100 : 0;
  const grossWin     = winners.reduce((s,t) => s+t.pnl, 0);
  const grossLoss    = Math.abs(losers.reduce((s,t) => s+t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : Infinity;

  let peak = initCap, maxDD = 0, maxDDPct = 0;
  for (const p of equity) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak - p.equity;
    if (dd > maxDD) { maxDD = dd; maxDDPct = peak > 0 ? (dd / peak) * 100 : 0; }
  }

  const finalEq = equity.length ? equity[equity.length - 1].equity : initCap;
  const years   = equity.length / 252;
  const cagr    = years > 0 && initCap > 0
    ? (Math.pow(Math.max(finalEq, 1) / initCap, 1 / years) - 1) * 100 : 0;

  const rets   = equity.map((p,i) => i===0 ? 0
    : (p.equity - equity[i-1].equity) / (equity[i-1].equity || 1)).slice(1);
  const meanR  = rets.reduce((s,r) => s+r, 0) / (rets.length||1);
  const stdR   = Math.sqrt(rets.reduce((s,r) => s+(r-meanR)**2, 0) / (rets.length||1));
  const sharpe = stdR > 0 ? (meanR / stdR) * Math.sqrt(252) : 0;

  const monthly = {};
  for (const t of closed) {
    const k = (t.exit_date || t.entry_date)?.slice(0,7);
    if (k) monthly[k] = (monthly[k]||0) + t.pnl;
  }

  return {
    totalPnL, winRate, profitFactor, maxDD, maxDDPct,
    cagr, sharpe, finalEq,
    totalTrades: closed.length, openTrades: open.length,
    winners: winners.length, losers: losers.length, monthly,
  };
}

// ─────────────────────────────────────────────────────────────────
// PRESETS  (Nifty 50 full list)
// ─────────────────────────────────────────────────────────────────
const PRESETS = {
  "Nifty 50": [
    {symbol:"RELIANCE.NS",   name:"Reliance",        sector:"Energy"},
    {symbol:"TCS.NS",        name:"TCS",             sector:"IT"},
    {symbol:"HDFCBANK.NS",   name:"HDFC Bank",       sector:"Banking"},
    {symbol:"BHARTIARTL.NS", name:"Bharti Airtel",   sector:"Telecom"},
    {symbol:"ICICIBANK.NS",  name:"ICICI Bank",      sector:"Banking"},
    {symbol:"INFOSYS.NS",    name:"Infosys",         sector:"IT"},
    {symbol:"SBIN.NS",       name:"SBI",             sector:"Banking"},
    {symbol:"INFY.NS",       name:"Infy",            sector:"IT"},
    {symbol:"HINDUNILVR.NS", name:"HUL",             sector:"FMCG"},
    {symbol:"LT.NS",         name:"L&T",             sector:"Infra"},
    {symbol:"BAJFINANCE.NS", name:"Bajaj Finance",   sector:"Finance"},
    {symbol:"KOTAKBANK.NS",  name:"Kotak Bank",      sector:"Banking"},
    {symbol:"AXISBANK.NS",   name:"Axis Bank",       sector:"Banking"},
    {symbol:"WIPRO.NS",      name:"Wipro",           sector:"IT"},
    {symbol:"HCLTECH.NS",    name:"HCL Tech",        sector:"IT"},
  ],
  "IT Sector": [
    {symbol:"TCS.NS",        name:"TCS",            sector:"IT"},
    {symbol:"INFY.NS",       name:"Infosys",        sector:"IT"},
    {symbol:"WIPRO.NS",      name:"Wipro",          sector:"IT"},
    {symbol:"HCLTECH.NS",    name:"HCL Tech",       sector:"IT"},
    {symbol:"TECHM.NS",      name:"Tech Mahindra",  sector:"IT"},
    {symbol:"LTIM.NS",       name:"LTIMindtree",    sector:"IT"},
  ],
  "Banking": [
    {symbol:"HDFCBANK.NS",   name:"HDFC Bank",   sector:"Banking"},
    {symbol:"ICICIBANK.NS",  name:"ICICI Bank",  sector:"Banking"},
    {symbol:"SBIN.NS",       name:"SBI",         sector:"Banking"},
    {symbol:"AXISBANK.NS",   name:"Axis Bank",   sector:"Banking"},
    {symbol:"KOTAKBANK.NS",  name:"Kotak Bank",  sector:"Banking"},
    {symbol:"INDUSINDBK.NS", name:"IndusInd",    sector:"Banking"},
  ],
  "Adani Group": [
    {symbol:"ADANIENT.NS",   name:"Adani Ent",    sector:"Conglomerate"},
    {symbol:"ADANIPORTS.NS", name:"Adani Ports",  sector:"Infra"},
    {symbol:"ADANIGREEN.NS", name:"Adani Green",  sector:"Energy"},
    {symbol:"ADANIPOWER.NS", name:"Adani Power",  sector:"Energy"},
  ],
};

// ─────────────────────────────────────────────────────────────────
// FORMATTERS
// ─────────────────────────────────────────────────────────────────
const fmtC = v => v==null ? "—"
  : `${v<0?"-":""}₹${Math.abs(v).toLocaleString("en-IN",{maximumFractionDigits:0})}`;
const fmtP = (v,d=1) => v==null ? "—" : `${v>=0?"+":""}${v.toFixed(d)}%`;
const fmtN = (v,d=2) => v==null ? "—"
  : v.toLocaleString("en-IN",{minimumFractionDigits:d,maximumFractionDigits:d});
const clr  = v => v >= 0 ? C.green : C.red;

// ─────────────────────────────────────────────────────────────────
// SMALL UI COMPONENTS
// ─────────────────────────────────────────────────────────────────
const Chip = ({label, active, onClick, color=C.accent}) => (
  <button onClick={onClick} style={{
    padding:"4px 12px", borderRadius:20, fontSize:11, fontWeight:600, cursor:"pointer",
    border:`1px solid ${active?color:C.border}`,
    background:active?`${color}20`:"transparent",
    color:active?color:C.textSoft, transition:"all .15s", whiteSpace:"nowrap",
  }}>{label}</button>
);

const KPI = ({label, value, color, sub}) => (
  <div style={{background:C.card, border:`1px solid ${C.border}`,
    borderRadius:10, padding:"14px 16px"}}>
    <div style={{color:C.textSoft, fontSize:10, fontFamily:"DM Mono,monospace",
      letterSpacing:1.2, textTransform:"uppercase", marginBottom:5}}>{label}</div>
    <div style={{color:color||C.text, fontSize:20, fontWeight:700,
      fontFamily:"Syne,sans-serif"}}>{value}</div>
    {sub && <div style={{color:C.muted, fontSize:10, marginTop:3}}>{sub}</div>}
  </div>
);

const CTip = ({active, payload, label}) => {
  if (!active||!payload?.length) return null;
  return (
    <div style={{background:C.surface, border:`1px solid ${C.border}`,
      borderRadius:8, padding:"8px 12px", fontSize:12}}>
      <div style={{color:C.textSoft, marginBottom:4, fontSize:11}}>{label}</div>
      {payload.map((p,i) => (
        <div key={i} style={{color:p.color||C.text, display:"flex", gap:8}}>
          <span style={{color:C.textSoft}}>{p.name}:</span>
          <span style={{fontWeight:700}}>
            {p.dataKey==="drawdown"
              ? `${p.value?.toFixed(2)}%`
              : `₹${Number(p.value).toLocaleString("en-IN",{maximumFractionDigits:0})}`}
          </span>
        </div>
      ))}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────
export default function AlphaLens() {
  const [startDate,    setStartDate]    = useState("2015-01-01");
  const [endDate,      setEndDate]      = useState(new Date().toISOString().slice(0,10));
  const [initCap,      setInitCap]      = useState(1000000);
  const [model,        setModel]        = useState(1);
  const [fixedAmt,     setFixedAmt]     = useState(10000);
  const [preset,       setPreset]       = useState("Nifty 50");
  const [sectors,      setSectors]      = useState([]);
  const [inputMode,    setInputMode]    = useState("preset");
  const [custom,       setCustom]       = useState("");
  const [running,      setRunning]      = useState(false);
  const [progress,     setProgress]     = useState({n:0,t:1,msg:"",failed:[]});
  const [results,      setResults]      = useState(null);
  const [activeSymbol, setActiveSymbol] = useState(null);
  const [tab,          setTab]          = useState("overview");
  const [tradeFilter,  setTradeFilter]  = useState("all");
  const [sortBy,       setSortBy]       = useState("date");

  // ── Stock list ──────────────────────────────────────────────
  const stockList = useMemo(() => {
    if (inputMode === "custom") {
      return custom.split("\n").map(s=>s.trim()).filter(Boolean).map(s=>({
        symbol: s.includes(".")?s:s+".NS",
        name: s.replace(/\.[A-Z]+$/,""),
        sector:"Custom",
      }));
    }
    const base = PRESETS[preset] || [];
    return sectors.length ? base.filter(s=>sectors.includes(s.sector)) : base;
  }, [inputMode, preset, custom, sectors]);

  const allSectors = useMemo(() =>
    [...new Set((PRESETS[preset]||[]).map(s=>s.sector))], [preset]);

  // ── RUN BACKTEST ────────────────────────────────────────────
  const run = useCallback(async () => {
    if (!stockList.length || running) return;
    setRunning(true);
    setResults(null);
    setProgress({n:0, t:stockList.length, msg:"Starting…", failed:[]});

    const stockRes = [];
    const failed   = [];
    const perStockCap = +initCap / stockList.length;

    for (let i = 0; i < stockList.length; i++) {
      const s = stockList[i];
      setProgress(p => ({...p, n:i, msg:`Fetching ${s.symbol}…`}));
      await new Promise(r => setTimeout(r, 0));  // yield to UI

      const ohlcv = await fetchYahooOHLCV(s.symbol, startDate, endDate);

      if (!ohlcv || ohlcv.length < 5) {
        failed.push(s.symbol);
        setProgress(p => ({...p, failed:[...p.failed, s.symbol],
          msg:`⚠ ${s.symbol} failed — skipping`}));
        continue;
      }

      setProgress(p => ({...p, msg:`Backtesting ${s.name} (${ohlcv.length} days)…`}));
      await new Promise(r => setTimeout(r, 0));

      const {trades, equity} = runBacktest(ohlcv, model, +fixedAmt, perStockCap);
      const st = calcStats(trades, equity, perStockCap);
      stockRes.push({...s, trades, equity, stats:st});
      setProgress(p => ({...p, n:i+1,
        msg:`✓ ${s.name}: ${trades.length} lots, P&L ${fmtC(st.totalPnL)}`}));
    }

    if (!stockRes.length) {
      setProgress(p => ({...p,
        msg:"❌ All stocks failed to fetch. Check internet connection or try again."}));
      setRunning(false);
      return;
    }

    // Build portfolio-level equity curve (sum across all stocks by date)
    const allDates = [...new Set(stockRes.flatMap(r=>r.equity.map(p=>p.date)))].sort();
    const portEq   = allDates.map(date => ({
      date,
      equity: stockRes.reduce((sum, r) => {
        const pt = r.equity.find(p=>p.date===date);
        return sum + (pt?.equity ?? r.equity[0]?.equity ?? perStockCap);
      }, 0),
    }));

    const allTrades   = stockRes.flatMap(r =>
      r.trades.map(t => ({...t, symbol:r.symbol, name:r.name})));
    const portInitCap = portEq[0]?.equity ?? +initCap;
    const portStats   = calcStats(allTrades, portEq, portInitCap);

    setResults({stockRes, portEq, portStats, allTrades, failed});
    setActiveSymbol(null);  // start on Portfolio view
    setProgress(p => ({...p, n:stockList.length,
      msg:`✅ Done — ${stockRes.length} stocks · ${allTrades.length} lots · ${failed.length} failed`}));
    setRunning(false);
  }, [stockList, startDate, endDate, initCap, model, fixedAmt, running]);

  // ── Derived data for display ─────────────────────────────────
  const active     = results?.stockRes?.find(r=>r.symbol===activeSymbol);
  const curveData  = active ? active.equity  : results?.portEq;
  const statsData  = active ? active.stats   : results?.portStats;
  const viewLabel  = active ? active.name    : "Portfolio";

  const ddSeries = useMemo(() => {
    if (!curveData?.length) return [];
    let peak = curveData[0].equity;
    return curveData.map(p => {
      if (p.equity > peak) peak = p.equity;
      return {date:p.date, drawdown:peak>0?+((p.equity-peak)/peak*100).toFixed(2):0};
    });
  }, [curveData]);

  const monthlyData = useMemo(() => {
    if (!statsData) return [];
    return Object.entries(statsData.monthly||{})
      .map(([m,pnl])=>({m,pnl}))
      .sort((a,b)=>a.m.localeCompare(b.m));
  }, [statsData]);

  const sectorData = useMemo(() => {
    if (!results) return [];
    const map = {};
    for (const r of results.stockRes) {
      if (!map[r.sector]) map[r.sector]={sector:r.sector,pnl:0,cagr:0,count:0};
      map[r.sector].pnl   += r.stats.totalPnL;
      map[r.sector].cagr  += r.stats.cagr;
      map[r.sector].count++;
    }
    return Object.values(map)
      .map(d=>({...d, cagr:d.cagr/d.count}))
      .sort((a,b)=>b.pnl-a.pnl);
  }, [results]);

  const displayTrades = useMemo(() => {
    if (!results) return [];
    const src = active
      ? active.trades.map(t=>({...t,symbol:active.symbol,name:active.name}))
      : results.allTrades;
    let f = tradeFilter==="open"   ? src.filter(t=>t.status==="open")
          : tradeFilter==="closed" ? src.filter(t=>t.status==="closed")
          : src;
    return sortBy==="pnl"
      ? [...f].sort((a,b)=>(b.pnl||0)-(a.pnl||0))
      : [...f].sort((a,b)=>a.entry_date?.localeCompare(b.entry_date));
  }, [results, active, tradeFilter, sortBy]);

  const compData = useMemo(() =>
    results ? [...results.stockRes].sort((a,b)=>b.stats.totalPnL-a.stats.totalPnL) : []
  , [results]);

  // ─────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────
  return (
    <div style={{minHeight:"100vh", background:C.bg, color:C.text,
      fontFamily:"'DM Sans',sans-serif"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px;height:5px}
        ::-webkit-scrollbar-track{background:${C.bg}}
        ::-webkit-scrollbar-thumb{background:${C.muted};border-radius:3px}
        button{transition:opacity .15s;font-family:inherit}
        button:hover{opacity:.8}
        input,textarea{outline:none;font-family:inherit}
      `}</style>

      {/* ══ HEADER ══ */}
      <div style={{height:54, background:`${C.surface}f0`, backdropFilter:"blur(16px)",
        borderBottom:`1px solid ${C.border}`, position:"sticky", top:0, zIndex:200,
        display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 24px"}}>
        <div style={{display:"flex", alignItems:"center", gap:10}}>
          <div style={{width:28,height:28,borderRadius:6,
            background:`linear-gradient(135deg,${C.accent},${C.accent2})`,
            display:"flex",alignItems:"center",justifyContent:"center",
            fontWeight:900,fontSize:14,color:"#000"}}>▲</div>
          <div>
            <div style={{fontFamily:"Syne",fontWeight:800,fontSize:15,letterSpacing:-.3}}>
              AlphaLens</div>
            <div style={{fontSize:9,color:C.textSoft,letterSpacing:2,textTransform:"uppercase"}}>
              PMS Strategy Backtester</div>
          </div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <span style={{fontSize:10,color:C.muted,fontFamily:"DM Mono,monospace"}}>
            Live data · Yahoo Finance · NSE/BSE
          </span>
          <span style={{padding:"2px 8px",borderRadius:20,fontSize:9,
            background:`${C.accent}18`,color:C.accent,border:`1px solid ${C.accent}33`,
            fontWeight:700}}>v4.1</span>
        </div>
      </div>

      <div style={{display:"flex", minHeight:"calc(100vh - 54px)"}}>

        {/* ══ SIDEBAR ══ */}
        <aside style={{width:272, background:C.surface, borderRight:`1px solid ${C.border}`,
          padding:16, display:"flex", flexDirection:"column", gap:14,
          overflowY:"auto", flexShrink:0}}>

          {/* Date Range */}
          <div style={{color:C.textSoft,fontSize:10,letterSpacing:1.5,fontFamily:"DM Mono,monospace",
            textTransform:"uppercase",fontWeight:700}}>Date Range</div>
          {[["FROM",startDate,setStartDate],["TO",endDate,setEndDate]].map(([l,v,s])=>(
            <div key={l} style={{display:"flex",flexDirection:"column",gap:3}}>
              <label style={{color:C.muted,fontSize:9,fontFamily:"DM Mono,monospace",
                letterSpacing:1}}>{l}</label>
              <input type="date" value={v} onChange={e=>s(e.target.value)} style={{
                background:C.card,border:`1px solid ${C.border}`,borderRadius:6,
                color:C.text,padding:"7px 10px",fontSize:13,
                fontFamily:"DM Mono,monospace",width:"100%"}}/>
            </div>
          ))}

          <div style={{borderTop:`1px solid ${C.border}`,margin:"2px 0"}}/>

          {/* Capital */}
          <div style={{color:C.textSoft,fontSize:10,letterSpacing:1.5,fontFamily:"DM Mono,monospace",
            textTransform:"uppercase",fontWeight:700}}>Capital & Model</div>
          <div style={{display:"flex",flexDirection:"column",gap:3}}>
            <label style={{color:C.muted,fontSize:9,fontFamily:"DM Mono,monospace",
              letterSpacing:1}}>INITIAL CAPITAL (₹)</label>
            <input type="number" value={initCap} min={10000} step={10000}
              onChange={e=>setInitCap(e.target.value)} style={{
                background:C.card,border:`1px solid ${C.border}`,borderRadius:6,
                color:C.text,padding:"7px 10px",fontSize:13,
                fontFamily:"DM Mono,monospace",width:"100%"}}/>
          </div>

          {/* Model selector */}
          {[
            {id:1,label:"Model 1 — Fixed ₹/lot",   desc:"Same amount every trade"},
            {id:2,label:"Model 2 — 1% of Capital",  desc:"1% of initial capital/lot"},
            {id:3,label:"Model 3 — 1% Dynamic",     desc:"1% of previous day balance"},
          ].map(m=>(
            <div key={m.id} onClick={()=>setModel(m.id)} style={{
              padding:"9px 11px",borderRadius:7,cursor:"pointer",
              border:`1px solid ${model===m.id?C.accent:C.border}`,
              background:model===m.id?`${C.accent}0d`:"transparent"}}>
              <div style={{fontSize:12,fontWeight:600,
                color:model===m.id?C.accent:C.text}}>{m.label}</div>
              <div style={{fontSize:10,color:C.muted,marginTop:1}}>{m.desc}</div>
            </div>
          ))}

          {model===1 && (
            <div style={{display:"flex",flexDirection:"column",gap:3}}>
              <label style={{color:C.muted,fontSize:9,fontFamily:"DM Mono,monospace",
                letterSpacing:1}}>AMOUNT PER LOT (₹)</label>
              <input type="number" value={fixedAmt} min={1000} step={1000}
                onChange={e=>setFixedAmt(e.target.value)} style={{
                  background:C.card,border:`1px solid ${C.border}`,borderRadius:6,
                  color:C.text,padding:"7px 10px",fontSize:13,
                  fontFamily:"DM Mono,monospace",width:"100%"}}/>
            </div>
          )}

          <div style={{borderTop:`1px solid ${C.border}`,margin:"2px 0"}}/>

          {/* Stock Universe */}
          <div style={{color:C.textSoft,fontSize:10,letterSpacing:1.5,fontFamily:"DM Mono,monospace",
            textTransform:"uppercase",fontWeight:700}}>Stock Universe</div>
          <div style={{display:"flex",gap:5}}>
            <Chip label="Preset" active={inputMode==="preset"} onClick={()=>setInputMode("preset")}/>
            <Chip label="Custom" active={inputMode==="custom"} onClick={()=>setInputMode("custom")}/>
          </div>

          {inputMode==="preset" ? (<>
            {Object.keys(PRESETS).map(p=>(
              <div key={p} onClick={()=>{setPreset(p);setSectors([]);}} style={{
                padding:"7px 10px",borderRadius:6,cursor:"pointer",
                border:`1px solid ${preset===p?C.accent2:"transparent"}`,
                background:preset===p?`${C.accent2}12`:C.card,
                fontSize:12,color:preset===p?C.accent2:C.textSoft,
                fontWeight:preset===p?600:400,
              }}>{p} <span style={{color:C.muted,fontSize:10}}>({PRESETS[p].length})</span></div>
            ))}
            {allSectors.length>1 && (
              <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:2}}>
                {allSectors.map(s=>(
                  <Chip key={s} label={s} color={C.accent3}
                    active={sectors.includes(s)}
                    onClick={()=>setSectors(p=>p.includes(s)?p.filter(x=>x!==s):[...p,s])}/>
                ))}
              </div>
            )}
          </>) : (
            <textarea value={custom} onChange={e=>setCustom(e.target.value)}
              placeholder={"ADANIENT\nRELIANCE.NS\nTCS"} rows={6} style={{
                background:C.card,border:`1px solid ${C.border}`,borderRadius:6,
                color:C.text,padding:"7px 10px",fontSize:12,
                fontFamily:"DM Mono,monospace",resize:"vertical",width:"100%"}}/>
          )}

          <div style={{color:C.muted,fontSize:11}}>
            {stockList.length} stock{stockList.length!==1?"s":""} selected
          </div>

          {/* RUN BUTTON */}
          <button onClick={run} disabled={running||!stockList.length} style={{
            padding:"12px",borderRadius:8,fontWeight:700,fontSize:14,
            fontFamily:"Syne",cursor:running?"not-allowed":"pointer",border:"none",
            background:running?C.border:`linear-gradient(135deg,${C.accent},${C.accent2})`,
            color:running?C.muted:"#000",marginTop:4}}>
            {running?`⟳  ${progress.n}/${progress.t}`:"▶  Run Backtest"}
          </button>

          {/* Progress bar + message */}
          <div style={{display:"flex",flexDirection:"column",gap:5}}>
            <div style={{background:C.border,borderRadius:3,height:3,overflow:"hidden"}}>
              <div style={{height:"100%",borderRadius:3,
                background:`linear-gradient(90deg,${C.accent},${C.accent2})`,
                width:`${progress.t>0?(progress.n/progress.t)*100:0}%`,
                transition:"width .4s"}}/>
            </div>
            {progress.msg && (
              <div style={{fontSize:10,color:C.textSoft,fontFamily:"DM Mono,monospace",
                lineHeight:1.4,wordBreak:"break-all"}}>{progress.msg}</div>
            )}
          </div>

          {/* Failed symbols */}
          {!running && results?.failed?.length>0 && (
            <div style={{background:`${C.red}0e`,border:`1px solid ${C.red}30`,
              borderRadius:7,padding:"8px 10px"}}>
              <div style={{color:C.red,fontWeight:700,fontSize:11,marginBottom:3}}>
                ⚠ Failed ({results.failed.length}):
              </div>
              <div style={{color:C.muted,fontSize:10,fontFamily:"DM Mono,monospace"}}>
                {results.failed.join(", ")}
              </div>
            </div>
          )}
        </aside>

        {/* ══ MAIN CONTENT ══ */}
        <main style={{flex:1,overflowY:"auto",padding:20}}>

          {/* ── EMPTY STATE ── */}
          {!results && !running && (
            <div style={{height:"100%",minHeight:500,display:"flex",
              flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16}}>
              <div style={{width:68,height:68,borderRadius:16,
                background:`linear-gradient(135deg,${C.accent}28,${C.accent2}28)`,
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:30}}>📊</div>
              <div style={{fontFamily:"Syne",fontSize:24,fontWeight:800,textAlign:"center"}}>
                PMS-Grade Strategy Analytics</div>
              <div style={{color:C.textSoft,fontSize:13,textAlign:"center",
                maxWidth:440,lineHeight:1.8}}>
                Pick stocks, set your capital &amp; model, choose dates —
                then click <b style={{color:C.accent}}>Run Backtest</b>.<br/>
                Real data fetched live from Yahoo Finance.
              </div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"center"}}>
                {["Live Yahoo Finance Data","Equity Curve","Drawdown","CAGR","Sharpe",
                  "Win Rate","Monthly P&L","Sector Breakdown","Trade Log"].map(f=>(
                  <span key={f} style={{padding:"3px 10px",borderRadius:20,fontSize:10,
                    background:`${C.accent}0d`,color:C.accent,
                    border:`1px solid ${C.accent}30`,fontWeight:600}}>{f}</span>
                ))}
              </div>
            </div>
          )}

          {/* ── LOADING STATE ── */}
          {running && (
            <div style={{height:"100%",minHeight:500,display:"flex",
              flexDirection:"column",alignItems:"center",justifyContent:"center",gap:20}}>
              <div style={{width:56,height:56,borderRadius:12,
                background:`linear-gradient(135deg,${C.accent}28,${C.accent2}28)`,
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:26}}>⟳</div>
              <div style={{fontFamily:"Syne",fontSize:18,fontWeight:700}}>
                Fetching &amp; Backtesting…</div>
              <div style={{color:C.textSoft,fontSize:12,fontFamily:"DM Mono,monospace",
                textAlign:"center",maxWidth:380}}>{progress.msg}</div>
              <div style={{background:C.border,borderRadius:4,height:4,width:280,overflow:"hidden"}}>
                <div style={{height:"100%",borderRadius:4,
                  background:`linear-gradient(90deg,${C.accent},${C.accent2})`,
                  width:`${progress.t>0?(progress.n/progress.t)*100:5}%`,
                  transition:"width .4s"}}/>
              </div>
              <div style={{color:C.muted,fontSize:11}}>
                {progress.n} / {progress.t} stocks complete
              </div>
            </div>
          )}

          {/* ── RESULTS ── */}
          {results && !running && (<>

            {/* Stock tabs */}
            <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:16}}>
              <Chip label="▣ Portfolio" active={!activeSymbol}
                onClick={()=>setActiveSymbol(null)}/>
              {results.stockRes.map(r=>(
                <button key={r.symbol} onClick={()=>setActiveSymbol(r.symbol)} style={{
                  padding:"4px 11px",borderRadius:20,fontSize:11,fontWeight:600,
                  cursor:"pointer",
                  border:`1px solid ${activeSymbol===r.symbol?C.accent2:C.border}`,
                  background:activeSymbol===r.symbol?`${C.accent2}18`:"transparent",
                  color:activeSymbol===r.symbol?C.accent2:C.textSoft,
                  display:"flex",alignItems:"center",gap:4}}>
                  <span style={{width:5,height:5,borderRadius:"50%",
                    background:r.stats.totalPnL>=0?C.green:C.red,flexShrink:0}}/>
                  {r.name}
                </button>
              ))}
            </div>

            {/* KPI row 1 */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:8}}>
              <KPI label="Total P&L" value={fmtC(statsData.totalPnL)}
                color={clr(statsData.totalPnL)}
                sub={statsData.totalPnL>=0?"Profitable":"Loss-making"}/>
              <KPI label="Final Equity" value={fmtC(statsData.finalEq)}
                sub={`Capital: ₹${(+initCap).toLocaleString("en-IN")}`}/>
              <KPI label="CAGR" value={fmtP(statsData.cagr)}
                color={clr(statsData.cagr)}/>
              <KPI label="Sharpe Ratio" value={fmtN(statsData.sharpe)}
                color={statsData.sharpe>=1?C.green:statsData.sharpe>=0.5?C.accent3:C.red}
                sub={statsData.sharpe>=1?"Excellent":statsData.sharpe>=0.5?"Good":"Poor"}/>
            </div>
            {/* KPI row 2 */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:16}}>
              <KPI label="Win Rate" value={`${statsData.winRate?.toFixed(1)}%`}
                color={clr(statsData.winRate-50)}
                sub={`${statsData.winners}W / ${statsData.losers}L`}/>
              <KPI label="Profit Factor"
                value={statsData.profitFactor===Infinity?"∞":fmtN(statsData.profitFactor)}
                color={clr(statsData.profitFactor-1)}/>
              <KPI label="Max Drawdown" value={`${statsData.maxDDPct?.toFixed(1)}%`}
                color={C.red} sub={fmtC(statsData.maxDD)}/>
              <KPI label="Trades" value={statsData.totalTrades}
                sub={`${statsData.openTrades} open`}/>
            </div>

            {/* Tabs */}
            <div style={{display:"flex",borderBottom:`1px solid ${C.border}`,marginBottom:16}}>
              {[["overview","Overview"],["trades","Trade Log"],
                ["sector","Sector"],["monthly","Monthly P&L"]].map(([id,lbl])=>(
                <button key={id} onClick={()=>setTab(id)} style={{
                  padding:"8px 16px",fontSize:13,fontWeight:600,border:"none",
                  background:"transparent",cursor:"pointer",
                  color:tab===id?C.accent:C.textSoft,
                  borderBottom:`2px solid ${tab===id?C.accent:"transparent"}`,
                  transition:"color .15s"}}>
                  {lbl}
                </button>
              ))}
            </div>

            {/* ── OVERVIEW TAB ── */}
            {tab==="overview" && (
              <div style={{display:"flex",flexDirection:"column",gap:12}}>

                {/* Equity Curve */}
                <div style={{background:C.card,border:`1px solid ${C.border}`,
                  borderRadius:11,padding:16}}>
                  <div style={{display:"flex",justifyContent:"space-between",
                    alignItems:"center",marginBottom:12}}>
                    <div style={{fontFamily:"Syne",fontWeight:700,fontSize:14}}>
                      Equity Curve — {viewLabel}</div>
                    <div style={{fontSize:10,color:C.textSoft,fontFamily:"DM Mono,monospace"}}>
                      {curveData?.[0]?.date} → {curveData?.[curveData.length-1]?.date}
                    </div>
                  </div>
                  <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={curveData}>
                      <defs>
                        <linearGradient id="ge" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor={C.accent} stopOpacity={.3}/>
                          <stop offset="95%" stopColor={C.accent} stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
                      <XAxis dataKey="date" tick={{fill:C.muted,fontSize:9}}
                        tickFormatter={d=>d?.slice(0,7)} interval="preserveStartEnd"/>
                      <YAxis tick={{fill:C.muted,fontSize:9}} width={64}
                        tickFormatter={v=>`₹${(v/1e5).toFixed(0)}L`}/>
                      <Tooltip content={<CTip/>}/>
                      <ReferenceLine y={active?active.perStockCap:portEq?.[0]?.equity}
                        stroke={C.muted} strokeDasharray="4 2"/>
                      <Area type="monotone" dataKey="equity" name="Equity"
                        stroke={C.accent} fill="url(#ge)" strokeWidth={2} dot={false}/>
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                {/* Drawdown */}
                <div style={{background:C.card,border:`1px solid ${C.border}`,
                  borderRadius:11,padding:16}}>
                  <div style={{fontFamily:"Syne",fontWeight:700,fontSize:13,marginBottom:10}}>
                    Drawdown%
                    <span style={{color:C.red,fontSize:12,marginLeft:8,fontWeight:400}}>
                      max −{statsData.maxDDPct?.toFixed(1)}%
                    </span>
                  </div>
                  <ResponsiveContainer width="100%" height={120}>
                    <AreaChart data={ddSeries}>
                      <defs>
                        <linearGradient id="gd" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor={C.red} stopOpacity={.35}/>
                          <stop offset="95%" stopColor={C.red} stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border}/>
                      <XAxis dataKey="date" tick={{fill:C.muted,fontSize:9}}
                        tickFormatter={d=>d?.slice(0,7)} interval="preserveStartEnd"/>
                      <YAxis tick={{fill:C.muted,fontSize:9}} width={42}
                        tickFormatter={v=>`${v.toFixed(0)}%`}/>
                      <Tooltip content={<CTip/>}/>
                      <Area type="monotone" dataKey="drawdown" name="Drawdown%"
                        stroke={C.red} fill="url(#gd)" strokeWidth={1.5} dot={false}/>
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                {/* Comparison table (portfolio view only) */}
                {!activeSymbol && compData.length>1 && (
                  <div style={{background:C.card,border:`1px solid ${C.border}`,
                    borderRadius:11,padding:16}}>
                    <div style={{fontFamily:"Syne",fontWeight:700,fontSize:14,marginBottom:12}}>
                      Stock Comparison</div>
                    <div style={{overflowX:"auto"}}>
                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                        <thead>
                          <tr style={{color:C.textSoft,borderBottom:`1px solid ${C.border}`}}>
                            {["Stock","Sector","CAGR","P&L","Win%","P.Factor","MaxDD%","Sharpe","Lots"]
                              .map(h=>(
                              <th key={h} style={{padding:"6px 8px",textAlign:"left",
                                fontFamily:"DM Mono,monospace",fontSize:9,
                                letterSpacing:1,textTransform:"uppercase"}}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {compData.map(r=>(
                            <tr key={r.symbol}
                              onClick={()=>setActiveSymbol(r.symbol)}
                              style={{borderBottom:`1px solid ${C.border}18`,cursor:"pointer"}}
                              onMouseEnter={e=>e.currentTarget.style.background=C.surface}
                              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                              <td style={{padding:"8px 8px"}}>
                                <div style={{fontWeight:600}}>{r.name}</div>
                                <div style={{color:C.muted,fontSize:10,
                                  fontFamily:"DM Mono,monospace"}}>{r.symbol}</div>
                              </td>
                              <td style={{padding:"8px 8px"}}>
                                <span style={{background:`${C.accent3}18`,color:C.accent3,
                                  padding:"1px 6px",borderRadius:8,fontSize:10}}>{r.sector}</span>
                              </td>
                              <td style={{padding:"8px 8px",color:clr(r.stats.cagr),fontWeight:700}}>
                                {fmtP(r.stats.cagr)}</td>
                              <td style={{padding:"8px 8px",color:clr(r.stats.totalPnL),fontWeight:700}}>
                                {fmtC(r.stats.totalPnL)}</td>
                              <td style={{padding:"8px 8px",color:clr(r.stats.winRate-50)}}>
                                {r.stats.winRate?.toFixed(1)}%</td>
                              <td style={{padding:"8px 8px",color:clr(r.stats.profitFactor-1)}}>
                                {r.stats.profitFactor===Infinity?"∞":r.stats.profitFactor?.toFixed(2)}</td>
                              <td style={{padding:"8px 8px",color:C.red}}>
                                {r.stats.maxDDPct?.toFixed(1)}%</td>
                              <td style={{padding:"8px 8px",color:clr(r.stats.sharpe)}}>
                                {r.stats.sharpe?.toFixed(2)}</td>
                              <td style={{padding:"8px 8px",color:C.textSoft}}>
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

            {/* ── TRADES TAB ── */}
            {tab==="trades" && (
              <div style={{background:C.card,border:`1px solid ${C.border}`,
                borderRadius:11,padding:16}}>
                <div style={{display:"flex",justifyContent:"space-between",
                  alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
                  <div style={{fontFamily:"Syne",fontWeight:700,fontSize:14}}>
                    Trade Log — {displayTrades.length} entries</div>
                  <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                    {[["all","All"],["open","Open"],["closed","Closed"]].map(([v,l])=>(
                      <Chip key={v} label={l} active={tradeFilter===v}
                        onClick={()=>setTradeFilter(v)}/>
                    ))}
                    <Chip label="↕ Date" active={sortBy==="date"}
                      onClick={()=>setSortBy("date")} color={C.accent3}/>
                    <Chip label="↕ P&L" active={sortBy==="pnl"}
                      onClick={()=>setSortBy("pnl")} color={C.accent3}/>
                  </div>
                </div>
                <div style={{overflowX:"auto",maxHeight:500,overflowY:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                    <thead style={{position:"sticky",top:0,background:C.card,zIndex:1}}>
                      <tr style={{color:C.textSoft,borderBottom:`1px solid ${C.border}`}}>
                        {(!active?["Symbol"]:[]).concat(
                          ["Entry Date","Entry ₹","Qty","Lot ₹",
                           "Exit Date","Exit ₹","P&L","Ret%","Status"]
                        ).map(h=>(
                          <th key={h} style={{padding:"6px 8px",textAlign:"left",
                            fontFamily:"DM Mono,monospace",fontSize:9,whiteSpace:"nowrap"}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {displayTrades.map((t,i)=>{
                        const ret = t.pnl!=null&&t.lot_capital
                          ? (t.pnl/t.lot_capital)*100 : null;
                        return (
                          <tr key={i}
                            style={{borderBottom:`1px solid ${C.border}12`}}
                            onMouseEnter={e=>e.currentTarget.style.background=C.surface}
                            onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                            {!active&&(
                              <td style={{padding:"6px 8px",color:C.accent2,fontSize:11,
                                fontFamily:"DM Mono,monospace",whiteSpace:"nowrap"}}>{t.symbol}</td>
                            )}
                            <td style={{padding:"6px 8px",color:C.textSoft,whiteSpace:"nowrap"}}>
                              {t.entry_date}</td>
                            <td style={{padding:"6px 8px",fontFamily:"DM Mono,monospace"}}>
                              ₹{t.entry_price?.toFixed(2)}</td>
                            <td style={{padding:"6px 8px"}}>{t.quantity}</td>
                            <td style={{padding:"6px 8px",color:C.muted,
                              fontFamily:"DM Mono,monospace"}}>
                              ₹{t.lot_capital?.toFixed(0)}</td>
                            <td style={{padding:"6px 8px",color:C.textSoft,whiteSpace:"nowrap"}}>
                              {t.exit_date||"—"}</td>
                            <td style={{padding:"6px 8px",fontFamily:"DM Mono,monospace"}}>
                              {t.exit_price?`₹${t.exit_price.toFixed(2)}`:"—"}</td>
                            <td style={{padding:"6px 8px",
                              color:t.pnl==null?C.muted:clr(t.pnl),fontWeight:600}}>
                              {t.pnl!=null?fmtC(t.pnl):"Open"}</td>
                            <td style={{padding:"6px 8px",
                              color:ret==null?C.muted:clr(ret)}}>
                              {ret!=null?fmtP(ret):"—"}</td>
                            <td style={{padding:"6px 8px"}}>
                              <span style={{padding:"1px 7px",borderRadius:8,fontSize:10,
                                fontWeight:600,
                                background:t.status==="open"
                                  ?`${C.accent3}18`:t.pnl>=0?`${C.green}18`:`${C.red}18`,
                                color:t.status==="open"
                                  ?C.accent3:t.pnl>=0?C.green:C.red}}>
                                {t.status}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── SECTOR TAB ── */}
            {tab==="sector" && (
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{background:C.card,border:`1px solid ${C.border}`,
                  borderRadius:11,padding:16}}>
                  <div style={{fontFamily:"Syne",fontWeight:700,fontSize:14,marginBottom:12}}>
                    Sector P&L</div>
                  <ResponsiveContainer width="100%"
                    height={Math.max(160,sectorData.length*54)}>
                    <BarChart data={sectorData} layout="vertical"
                      margin={{left:10,right:30,top:0,bottom:0}}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false}/>
                      <XAxis type="number" tick={{fill:C.muted,fontSize:9}}
                        tickFormatter={v=>`₹${(v/1000).toFixed(0)}K`}/>
                      <YAxis type="category" dataKey="sector"
                        tick={{fill:C.text,fontSize:12}} width={100}/>
                      <Tooltip content={<CTip/>}/>
                      <Bar dataKey="pnl" name="P&L" radius={[0,4,4,0]}>
                        {sectorData.map((d,i)=>(
                          <Cell key={i} fill={d.pnl>=0?C.green:C.red}/>
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div style={{display:"grid",
                  gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:8}}>
                  {sectorData.map(s=>(
                    <div key={s.sector} style={{background:C.card,
                      border:`1px solid ${C.border}`,borderRadius:9,padding:12}}>
                      <div style={{color:C.accent3,fontWeight:700,fontSize:11,marginBottom:3}}>
                        {s.sector}</div>
                      <div style={{color:clr(s.pnl),fontSize:18,fontWeight:700,
                        fontFamily:"Syne"}}>{fmtC(s.pnl)}</div>
                      <div style={{color:clr(s.cagr),fontSize:10,marginTop:2}}>
                        CAGR {fmtP(s.cagr)}</div>
                      <div style={{color:C.muted,fontSize:10,marginTop:1}}>
                        {s.count} stock{s.count!==1?"s":""}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── MONTHLY TAB ── */}
            {tab==="monthly" && (
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{background:C.card,border:`1px solid ${C.border}`,
                  borderRadius:11,padding:16}}>
                  <div style={{fontFamily:"Syne",fontWeight:700,fontSize:14,marginBottom:12}}>
                    Monthly P&L — {viewLabel}</div>
                  <ResponsiveContainer width="100%" height={230}>
                    <BarChart data={monthlyData}
                      margin={{left:0,right:8,top:0,bottom:0}}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false}/>
                      <XAxis dataKey="m" tick={{fill:C.muted,fontSize:9}} interval={2}
                        tickFormatter={v=>v?.slice(2)}/>
                      <YAxis tick={{fill:C.muted,fontSize:9}} width={56}
                        tickFormatter={v=>`₹${(v/1000).toFixed(0)}K`}/>
                      <Tooltip content={<CTip/>}/>
                      <ReferenceLine y={0} stroke={C.muted} strokeWidth={1}/>
                      <Bar dataKey="pnl" name="Monthly P&L" radius={[3,3,0,0]}>
                        {monthlyData.map((d,i)=>(
                          <Cell key={i} fill={d.pnl>=0?C.green:C.red}/>
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div style={{display:"grid",
                  gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:7}}>
                  {monthlyData.map((d,i)=>{
                    const mx = Math.max(...monthlyData.map(x=>Math.abs(x.pnl)),1);
                    return (
                      <div key={i} style={{background:C.surface,
                        border:`1px solid ${d.pnl>=0?C.green+"28":C.red+"28"}`,
                        borderRadius:7,padding:"9px 11px"}}>
                        <div style={{color:C.textSoft,fontSize:10,
                          fontFamily:"DM Mono,monospace",marginBottom:3}}>{d.m}</div>
                        <div style={{color:clr(d.pnl),fontWeight:700,fontSize:14,
                          fontFamily:"Syne"}}>{fmtC(d.pnl)}</div>
                        <div style={{marginTop:5,height:3,borderRadius:2,
                          background:C.border,overflow:"hidden"}}>
                          <div style={{height:"100%",borderRadius:2,
                            width:`${Math.abs(d.pnl)/mx*100}%`,
                            background:d.pnl>=0?C.green:C.red}}/>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Footer */}
            <div style={{marginTop:12,background:`${C.accent2}09`,
              border:`1px solid ${C.accent2}22`,borderRadius:8,
              padding:"9px 14px",fontSize:11,color:C.muted,
              display:"flex",flexWrap:"wrap",gap:6,alignItems:"center"}}>
              <span style={{color:C.accent2,fontWeight:700}}>Model:</span>
              {model===1&&<span>Fixed ₹{(+fixedAmt).toLocaleString("en-IN")}/lot</span>}
              {model===2&&<span>1% of ₹{(+initCap).toLocaleString("en-IN")} = ₹{(+initCap*0.01).toLocaleString("en-IN")}/lot</span>}
              {model===3&&<span>1% of rolling balance (dynamic)</span>}
              <span>· Max {MAX_LOTS} lots · {(STEP_DOWN*100).toFixed(0)}% step-down entries</span>
              <span>· {(FIRST_EXIT*100).toFixed(0)}% first exit · {(STOP_DROP*100).toFixed(0)}% stop-loss · LIFO</span>
            </div>
          </>)}
        </main>
      </div>
    </div>
  );
}
