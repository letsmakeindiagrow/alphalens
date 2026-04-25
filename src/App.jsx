import { useState, useCallback, useMemo, Component } from "react";
import {
  AreaChart, Area, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";

// ─────────────────────────────────────────────────────────────────
// DESIGN TOKENS — matches landing page (www.lmig.in) exactly
// ─────────────────────────────────────────────────────────────────
const C = {
  bg:          "#F8FAFF",
  white:       "#FFFFFF",
  surface:     "#F1F5FF",
  card:        "#FFFFFF",
  border:      "#E2E8F0",
  blue:        "#1A56DB",
  blueDark:    "#1341B3",
  blueLight:   "#EEF2FF",
  green:       "#059669",
  greenLight:  "#F0FDF4",
  teal:        "#0891B2",
  tealLight:   "#ECFEFF",
  red:         "#DC2626",
  redLight:    "#FEF2F2",
  amber:       "#D97706",
  amberLight:  "#FFFBEB",
  text:        "#0F172A",
  soft:        "#475569",
  muted:       "#94A3B8",
  shadowSm:    "0 1px 3px rgba(0,0,0,.06)",
  shadowMd:    "0 4px 16px rgba(15,23,42,.08)",
  shadowLg:    "0 8px 32px rgba(15,23,42,.10)",
};

// ─────────────────────────────────────────────────────────────────
// STRATEGY CONSTANTS  (unchanged)
// ─────────────────────────────────────────────────────────────────
const MAX_LOTS   = 7;
const STEP_DOWN  = 0.05;
const STOP_DROP  = 0.40;
const FIRST_EXIT = 0.15;
const STEP_UP    = 0.05;

// ─────────────────────────────────────────────────────────────────
// INVESTMENT MODEL  (unchanged)
// ─────────────────────────────────────────────────────────────────
function getLotCap(model, fixedAmt, initialCap, prevBal) {
  if (model === 1) return fixedAmt;
  if (model === 2) return initialCap * 0.01;
  return Math.max(prevBal, 1000) * 0.01;
}

// ─────────────────────────────────────────────────────────────────
// DATA FETCHER  (unchanged)
// ─────────────────────────────────────────────────────────────────
async function fetchOHLCV(symbol, startDate, endDate) {
  try {
    const params = new URLSearchParams({ symbol, start: startDate, end: endDate });
    const res    = await fetch(`/api/ohlcv?${params}`, {
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn(`/api/ohlcv failed for ${symbol}:`, err.error || res.status);
      return null;
    }
    const data = await res.json();
    if (!data.rows?.length) return null;
    return { rows: data.rows, source: data.source || "unknown", count: data.count };
  } catch (e) {
    console.warn(`Fetch error for ${symbol}:`, e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// BACKTEST ENGINE  (unchanged — identical to Python version)
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
    cycleOn = true; stopPx = px * (1 - STOP_DROP);
    const l = makeLot(date, px);
    cash -= l.lot_capital; lots.push(l);
    nextBuy = px * (1 - STEP_DOWN); nextSell = px * (1 + FIRST_EXIT);
  };

  const addLot = (date, px) => {
    const l = makeLot(date, px);
    cash -= l.lot_capital; lots.push(l);
    nextBuy = px * (1 - STEP_DOWN); nextSell = px * (1 + FIRST_EXIT);
  };

  const closeAll = (date, px) => {
    lots.forEach(l => {
      cash += l.quantity * px;
      l.exit_date = date; l.exit_price = px;
      l.exit_quantity = l.quantity;
      l.pnl = l.quantity * (px - l.entry_price);
      l.status = "closed"; trades.push(l);
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
    l.status = "closed"; trades.push(l);
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
    if (!cycleOn)      { startCycle(date, open); continue; }
    if (low <= stopPx) { closeAll(date, stopPx);  continue; }
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
// ANALYTICS  (unchanged)
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
// PRESETS  (unchanged)
// ─────────────────────────────────────────────────────────────────
const PRESETS = {
  "Nifty 50": [
    {symbol:"RELIANCE.NS",   name:"Reliance",       sector:"Energy"},
    {symbol:"TCS.NS",        name:"TCS",            sector:"IT"},
    {symbol:"HDFCBANK.NS",   name:"HDFC Bank",      sector:"Banking"},
    {symbol:"BHARTIARTL.NS", name:"Bharti Airtel",  sector:"Telecom"},
    {symbol:"ICICIBANK.NS",  name:"ICICI Bank",     sector:"Banking"},
    {symbol:"INFOSYS.NS",    name:"Infosys",        sector:"IT"},
    {symbol:"SBIN.NS",       name:"SBI",            sector:"Banking"},
    {symbol:"INFY.NS",       name:"Infy",           sector:"IT"},
    {symbol:"HINDUNILVR.NS", name:"HUL",            sector:"FMCG"},
    {symbol:"LT.NS",         name:"L&T",            sector:"Infra"},
    {symbol:"BAJFINANCE.NS", name:"Bajaj Finance",  sector:"Finance"},
    {symbol:"KOTAKBANK.NS",  name:"Kotak Bank",     sector:"Banking"},
    {symbol:"AXISBANK.NS",   name:"Axis Bank",      sector:"Banking"},
    {symbol:"WIPRO.NS",      name:"Wipro",          sector:"IT"},
    {symbol:"HCLTECH.NS",    name:"HCL Tech",       sector:"IT"},
  ],
  "IT Sector": [
    {symbol:"TCS.NS",     name:"TCS",           sector:"IT"},
    {symbol:"INFY.NS",    name:"Infosys",       sector:"IT"},
    {symbol:"WIPRO.NS",   name:"Wipro",         sector:"IT"},
    {symbol:"HCLTECH.NS", name:"HCL Tech",      sector:"IT"},
    {symbol:"TECHM.NS",   name:"Tech Mahindra", sector:"IT"},
    {symbol:"LTIM.NS",    name:"LTIMindtree",   sector:"IT"},
  ],
  "Banking": [
    {symbol:"HDFCBANK.NS",   name:"HDFC Bank",  sector:"Banking"},
    {symbol:"ICICIBANK.NS",  name:"ICICI Bank", sector:"Banking"},
    {symbol:"SBIN.NS",       name:"SBI",        sector:"Banking"},
    {symbol:"AXISBANK.NS",   name:"Axis Bank",  sector:"Banking"},
    {symbol:"KOTAKBANK.NS",  name:"Kotak Bank", sector:"Banking"},
    {symbol:"INDUSINDBK.NS", name:"IndusInd",   sector:"Banking"},
  ],
  "Adani Group": [
    {symbol:"ADANIENT.NS",   name:"Adani Ent",   sector:"Conglomerate"},
    {symbol:"ADANIPORTS.NS", name:"Adani Ports", sector:"Infra"},
    {symbol:"ADANIGREEN.NS", name:"Adani Green", sector:"Energy"},
    {symbol:"ADANIPOWER.NS", name:"Adani Power", sector:"Energy"},
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
// UI COMPONENTS — landing page style
// ─────────────────────────────────────────────────────────────────

// Pill/tag chip — matches landing page .tag
const Chip = ({ label, active, onClick, color = C.blue }) => (
  <button onClick={onClick} style={{
    padding:"5px 14px", borderRadius:100, fontSize:12, fontWeight:600,
    cursor:"pointer", whiteSpace:"nowrap", transition:"all .15s", border:"none",
    background: active ? color : C.surface,
    color:      active ? "#fff" : C.soft,
    boxShadow:  active ? `0 2px 8px ${color}44` : "none",
  }}>{label}</button>
);

// Sidebar section label — matches landing page section-title style
const SideLabel = ({ children }) => (
  <div style={{
    fontFamily:"'Plus Jakarta Sans',sans-serif",
    fontSize:10, fontWeight:700, letterSpacing:1.5,
    textTransform:"uppercase", color:C.muted,
    paddingBottom:4, borderBottom:`1px solid ${C.border}`,
  }}>{children}</div>
);

// KPI card — matches landing page white card with soft shadow
const KPI = ({ label, value, color, sub, icon }) => (
  <div style={{
    background:C.white, border:`1px solid ${C.border}`,
    borderRadius:12, padding:"16px 18px",
    boxShadow: C.shadowSm, transition:"box-shadow .2s",
  }}
    onMouseEnter={e=>e.currentTarget.style.boxShadow=C.shadowMd}
    onMouseLeave={e=>e.currentTarget.style.boxShadow=C.shadowSm}
  >
    <div style={{
      fontSize:10, fontWeight:600, letterSpacing:1.2,
      textTransform:"uppercase", color:C.muted, marginBottom:6,
      fontFamily:"'Plus Jakarta Sans',sans-serif",
    }}>{icon && <span style={{marginRight:4}}>{icon}</span>}{label}</div>
    <div style={{
      color: color||C.text, fontSize:22, fontWeight:800,
      fontFamily:"'Plus Jakarta Sans',sans-serif", lineHeight:1,
    }}>{value}</div>
    {sub && <div style={{color:C.muted, fontSize:11, marginTop:5}}>{sub}</div>}
  </div>
);

// Chart tooltip — light theme
const CTip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background:C.white, border:`1px solid ${C.border}`,
      borderRadius:10, padding:"10px 14px",
      boxShadow:C.shadowMd, fontSize:12,
    }}>
      <div style={{color:C.muted, marginBottom:5, fontSize:11}}>{label}</div>
      {payload.map((p,i) => (
        <div key={i} style={{display:"flex", gap:8, alignItems:"center"}}>
          <span style={{
            width:8, height:8, borderRadius:"50%",
            background:p.color, flexShrink:0,
          }}/>
          <span style={{color:C.soft}}>{p.name}:</span>
          <span style={{fontWeight:700, color:C.text}}>
            {p.dataKey==="drawdown"
              ? `${p.value?.toFixed(2)}%`
              : `₹${Number(p.value).toLocaleString("en-IN",{maximumFractionDigits:0})}`}
          </span>
        </div>
      ))}
    </div>
  );
};

// Input field — landing page style
const Field = ({ label, type="text", value, onChange, min, max, step, placeholder, rows }) => (
  <div style={{display:"flex", flexDirection:"column", gap:4}}>
    <label style={{
      fontSize:11, fontWeight:600, color:C.soft,
      letterSpacing:.5, textTransform:"uppercase",
      fontFamily:"'Plus Jakarta Sans',sans-serif",
    }}>{label}</label>
    {rows ? (
      <textarea rows={rows} value={value} onChange={e=>onChange(e.target.value)}
        placeholder={placeholder} style={{
          background:C.white, border:`1.5px solid ${C.border}`,
          borderRadius:8, color:C.text, padding:"9px 11px",
          fontSize:13, fontFamily:"'DM Mono',monospace",
          resize:"vertical", outline:"none", transition:"border-color .2s",
        }}
        onFocus={e=>e.target.style.borderColor=C.blue}
        onBlur={e=>e.target.style.borderColor=C.border}
      />
    ) : (
      <input type={type} value={value} min={min} max={max} step={step}
        placeholder={placeholder} onChange={e=>onChange(e.target.value)} style={{
          background:C.white, border:`1.5px solid ${C.border}`,
          borderRadius:8, color:C.text, padding:"9px 11px",
          fontSize:13, fontFamily:"'DM Mono',monospace",
          outline:"none", width:"100%", transition:"border-color .2s",
        }}
        onFocus={e=>e.target.style.borderColor=C.blue}
        onBlur={e=>e.target.style.borderColor=C.border}
      />
    )}
  </div>
);

// ─────────────────────────────────────────────────────────────────
// ERROR BOUNDARY
// ─────────────────────────────────────────────────────────────────
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) return (
      <div style={{
        minHeight:"100vh", background:C.bg,
        display:"flex", flexDirection:"column", alignItems:"center",
        justifyContent:"center", gap:16, padding:32,
        fontFamily:"'DM Sans',sans-serif",
      }}>
        <div style={{fontSize:36}}>⚠️</div>
        <div style={{
          fontFamily:"'Plus Jakarta Sans',sans-serif",
          fontSize:22, fontWeight:800, color:C.text,
        }}>Something went wrong</div>
        <div style={{color:C.soft, fontSize:14, textAlign:"center", maxWidth:480}}>
          Open browser DevTools (F12) → Console to see the exact error.
        </div>
        <pre style={{
          background:C.redLight, border:`1px solid ${C.red}33`,
          borderRadius:8, padding:"12px 16px", fontSize:11, color:C.red,
          maxWidth:600, overflow:"auto", whiteSpace:"pre-wrap",
        }}>{this.state.error?.message}</pre>
        <button onClick={()=>this.setState({error:null})} style={{
          padding:"10px 28px", borderRadius:100, border:"none", cursor:"pointer",
          background:C.blue, color:"#fff", fontWeight:700, fontSize:14,
          fontFamily:"'Plus Jakarta Sans',sans-serif",
        }}>Try Again</button>
      </div>
    );
    return this.props.children;
  }
}

// ─────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────
function AlphaLens() {
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
  const [progress,     setProgress]     = useState({n:0, t:1, msg:"", failed:[]});
  const [results,      setResults]      = useState(null);
  const [activeSymbol, setActiveSymbol] = useState(null);
  const [tab,          setTab]          = useState("overview");
  const [tradeFilter,  setTradeFilter]  = useState("all");
  const [sortBy,       setSortBy]       = useState("date");

  const stockList = useMemo(() => {
    if (inputMode === "custom") {
      return custom.split("\n").map(s=>s.trim()).filter(Boolean).map(s=>({
        symbol: s.includes(".")?s:s+".NS",
        name: s.replace(/\.[A-Z]+$/,""), sector:"Custom",
      }));
    }
    const base = PRESETS[preset] || [];
    return sectors.length ? base.filter(s=>sectors.includes(s.sector)) : base;
  }, [inputMode, preset, custom, sectors]);

  const allSectors = useMemo(() =>
    [...new Set((PRESETS[preset]||[]).map(s=>s.sector))], [preset]);

  // ── RUN  (unchanged logic) ──────────────────────────────────────
  const run = useCallback(async () => {
    if (!stockList.length || running) return;
    setRunning(true); setResults(null);
    setProgress({n:0, t:stockList.length, msg:"Starting…", failed:[]});

    const stockRes = [], failed = [];
    const perStockCap = +initCap / stockList.length;

    for (let i=0; i<stockList.length; i++) {
      const s = stockList[i];
      setProgress(p=>({...p, n:i, msg:`Fetching ${s.symbol}…`}));
      await new Promise(r=>setTimeout(r,0));

      const result = await fetchOHLCV(s.symbol, startDate, endDate);
      if (!result || result.rows.length < 5) {
        failed.push(s.symbol);
        setProgress(p=>({...p, failed:[...p.failed,s.symbol],
          msg:`⚠ ${s.symbol} failed — skipping`}));
        continue;
      }

      const { rows: ohlcv, source } = result;
      const srcLabel = source==="cache" ? "⚡ cached" : "🌐 fetched";
      setProgress(p=>({...p, msg:`Running ${s.name} (${ohlcv.length} days · ${srcLabel})…`}));
      await new Promise(r=>setTimeout(r,0));

      const { trades, equity } = runBacktest(ohlcv, model, +fixedAmt, perStockCap);
      const st = calcStats(trades, equity, perStockCap);
      stockRes.push({...s, trades, equity, stats:st, perStockCap});
      setProgress(p=>({...p, n:i+1,
        msg:`✓ ${s.name} (${srcLabel}): ${trades.length} lots · ${fmtC(st.totalPnL)}`}));
    }

    if (!stockRes.length) {
      setProgress(p=>({...p, msg:"❌ All stocks failed. Check internet or try again."}));
      setRunning(false); return;
    }

    const allDates = [...new Set(stockRes.flatMap(r=>r.equity.map(p=>p.date)))].sort();
    const portEq   = allDates.map(date=>({
      date,
      equity: stockRes.reduce((sum,r)=>{
        const pt = r.equity.find(p=>p.date===date);
        return sum + (pt?.equity ?? r.equity[0]?.equity ?? perStockCap);
      },0),
    }));

    const allTrades   = stockRes.flatMap(r=>r.trades.map(t=>({...t,symbol:r.symbol,name:r.name})));
    const portInitCap = portEq[0]?.equity ?? +initCap;
    const portStats   = calcStats(allTrades, portEq, portInitCap);

    setResults({stockRes, portEq, portStats, allTrades, failed});
    setActiveSymbol(null);
    setProgress(p=>({...p, n:stockList.length,
      msg:`✅ Done — ${stockRes.length} stocks · ${allTrades.length} lots`}));
    setRunning(false);
  }, [stockList, startDate, endDate, initCap, model, fixedAmt, running]);

  // ── Derived ──────────────────────────────────────────────────────
  const active    = results?.stockRes?.find(r=>r.symbol===activeSymbol) || null;
  const curveData = (active ? active.equity : results?.portEq) || [];
  const statsData = (active ? active.stats  : results?.portStats) || null;
  const viewLabel = active ? active.name : "Portfolio";

  const ddSeries = useMemo(()=>{
    if (!curveData?.length) return [];
    let peak = curveData[0].equity;
    return curveData.map(p=>{
      if (p.equity>peak) peak=p.equity;
      return {date:p.date, drawdown:peak>0?+((p.equity-peak)/peak*100).toFixed(2):0};
    });
  },[curveData]);

  const monthlyData = useMemo(()=>{
    if (!statsData) return [];
    return Object.entries(statsData.monthly||{}).map(([m,pnl])=>({m,pnl}))
      .sort((a,b)=>a.m.localeCompare(b.m));
  },[statsData]);

  const sectorData = useMemo(()=>{
    if (!results) return [];
    const map={};
    for (const r of results.stockRes){
      if(!map[r.sector]) map[r.sector]={sector:r.sector,pnl:0,cagr:0,count:0};
      map[r.sector].pnl+=r.stats.totalPnL;
      map[r.sector].cagr+=r.stats.cagr;
      map[r.sector].count++;
    }
    return Object.values(map).map(d=>({...d,cagr:d.cagr/d.count}))
      .sort((a,b)=>b.pnl-a.pnl);
  },[results]);

  const displayTrades = useMemo(()=>{
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
  },[results,active,tradeFilter,sortBy]);

  const compData = useMemo(()=>
    results ? [...results.stockRes].sort((a,b)=>b.stats.totalPnL-a.stats.totalPnL) : []
  ,[results]);

  // ─────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────
  return (
    <div style={{
      minHeight:"100vh", background:C.bg, color:C.text,
      fontFamily:"'DM Sans',sans-serif",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;600&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px;height:5px}
        ::-webkit-scrollbar-track{background:${C.bg}}
        ::-webkit-scrollbar-thumb{background:${C.border};border-radius:3px}
        button{transition:all .15s;font-family:inherit;cursor:pointer}
        input,textarea{outline:none;font-family:inherit}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
      `}</style>

      {/* ══ HEADER — identical brand to landing page ══════════════ */}
      <header style={{
        position:"sticky", top:0, zIndex:200,
        background:"rgba(248,250,255,.95)",
        backdropFilter:"blur(16px)",
        borderBottom:`1px solid ${C.border}`,
        boxShadow:C.shadowSm,
      }}>
        <div style={{
          maxWidth:1200, margin:"0 auto", padding:"0 24px",
          display:"flex", alignItems:"center",
          justifyContent:"space-between", height:56,
        }}>
          {/* Brand — same as landing page */}
          <a href="https://www.lmig.in" style={{textDecoration:"none"}}>
            <div style={{
              fontFamily:"'Plus Jakarta Sans',sans-serif",
              fontSize:15, fontWeight:800, color:C.blue, letterSpacing:-.2,
            }}>
              Let's Make India Grow
              <span style={{color:C.green}}> ●</span>
            </div>
            <div style={{
              fontFamily:"'Plus Jakarta Sans',sans-serif",
              fontSize:10, fontWeight:600, color:C.muted,
              letterSpacing:.8, textTransform:"uppercase",
            }}>AlphaLense · Strategy Backtester</div>
          </a>

          {/* Right side */}
          <div style={{display:"flex", alignItems:"center", gap:10}}>
            <div style={{
              display:"flex", alignItems:"center", gap:5,
              fontSize:11, color:C.muted,
              fontFamily:"'DM Mono',monospace",
            }}>
              <span style={{
                width:6, height:6, borderRadius:"50%",
                background:C.green, display:"inline-block",
                animation:"pulse 2s infinite",
              }}/>
              Live data · NSE/BSE
            </div>
            <a href="https://www.lmig.in#support"
              style={{
                padding:"7px 16px", borderRadius:100,
                background:C.green, color:"#fff",
                fontFamily:"'Plus Jakarta Sans',sans-serif",
                fontSize:12, fontWeight:700, textDecoration:"none",
                boxShadow:`0 2px 8px ${C.green}44`,
              }}>☕ Support</a>
            <a href="https://www.lmig.in"
              style={{
                padding:"7px 16px", borderRadius:100,
                background:C.blueLight, color:C.blue,
                fontFamily:"'Plus Jakarta Sans',sans-serif",
                fontSize:12, fontWeight:700, textDecoration:"none",
              }}>← Home</a>
          </div>
        </div>
      </header>

      <div style={{display:"flex", minHeight:"calc(100vh - 56px)"}}>

        {/* ══ SIDEBAR ══════════════════════════════════════════════ */}
        <aside style={{
          width:276, background:C.white,
          borderRight:`1px solid ${C.border}`,
          padding:"20px 16px",
          display:"flex", flexDirection:"column", gap:16,
          overflowY:"auto", flexShrink:0,
          boxShadow:`2px 0 8px rgba(15,23,42,.04)`,
        }}>

          <SideLabel>Date Range</SideLabel>
          <Field label="From" type="date" value={startDate} onChange={setStartDate} />
          <Field label="To"   type="date" value={endDate}   onChange={setEndDate}   />

          <SideLabel>Capital</SideLabel>
          <Field label="Initial Capital (₹)" type="number"
            value={initCap} onChange={setInitCap} min={10000} step={10000} />

          <SideLabel>Investment Model</SideLabel>
          {[
            {id:1, label:"Model 1 — Fixed ₹/lot",  desc:"Same amount every trade"},
            {id:2, label:"Model 2 — 1% of Capital", desc:"Fixed 1% of initial capital"},
            {id:3, label:"Model 3 — 1% Dynamic",    desc:"1% of rolling balance"},
          ].map(m=>(
            <div key={m.id} onClick={()=>setModel(m.id)} style={{
              padding:"10px 12px", borderRadius:10,
              border:`1.5px solid ${model===m.id ? C.blue : C.border}`,
              background: model===m.id ? C.blueLight : C.bg,
              cursor:"pointer", transition:"all .15s",
            }}>
              <div style={{
                fontSize:12, fontWeight:700,
                color: model===m.id ? C.blue : C.text,
                fontFamily:"'Plus Jakarta Sans',sans-serif",
              }}>{m.label}</div>
              <div style={{fontSize:11, color:C.muted, marginTop:2}}>{m.desc}</div>
            </div>
          ))}

          {model===1 && (
            <Field label="Amount per Lot (₹)" type="number"
              value={fixedAmt} onChange={setFixedAmt} min={1000} step={1000} />
          )}

          <SideLabel>Stock Universe</SideLabel>
          <div style={{display:"flex", gap:6}}>
            <Chip label="Preset" active={inputMode==="preset"}
              onClick={()=>setInputMode("preset")} />
            <Chip label="Custom" active={inputMode==="custom"}
              onClick={()=>setInputMode("custom")} />
          </div>

          {inputMode==="preset" ? (<>
            {Object.keys(PRESETS).map(p=>(
              <div key={p} onClick={()=>{setPreset(p);setSectors([]);}} style={{
                padding:"8px 12px", borderRadius:8,
                border:`1.5px solid ${preset===p ? C.teal : "transparent"}`,
                background: preset===p ? C.tealLight : C.bg,
                cursor:"pointer", fontSize:13, fontWeight: preset===p ? 700 : 400,
                color: preset===p ? C.teal : C.soft,
                fontFamily:"'Plus Jakarta Sans',sans-serif",
                transition:"all .15s",
              }}>
                {p}
                <span style={{color:C.muted, fontWeight:400, fontSize:11,
                  marginLeft:6}}>({PRESETS[p].length})</span>
              </div>
            ))}
            {allSectors.length>1 && (
              <div style={{display:"flex", flexWrap:"wrap", gap:5}}>
                {allSectors.map(s=>(
                  <Chip key={s} label={s} color={C.teal}
                    active={sectors.includes(s)}
                    onClick={()=>setSectors(prev=>
                      prev.includes(s)?prev.filter(x=>x!==s):[...prev,s]
                    )} />
                ))}
              </div>
            )}
          </>) : (
            <Field label="One symbol per line (.NS auto-added)"
              rows={6} value={custom} onChange={setCustom}
              placeholder={"ADANIENT\nRELIANCE.NS\nTCS"} />
          )}

          <div style={{fontSize:11, color:C.muted}}>
            {stockList.length} stock{stockList.length!==1?"s":""} selected
          </div>

          {/* RUN BUTTON — landing page btn-primary style */}
          <button onClick={run} disabled={running||!stockList.length} style={{
            padding:"13px", borderRadius:100,
            background: running ? C.border
              : `linear-gradient(135deg,${C.blue},${C.teal})`,
            color: running ? C.muted : "#fff",
            fontFamily:"'Plus Jakarta Sans',sans-serif",
            fontWeight:700, fontSize:14, border:"none",
            boxShadow: running ? "none" : `0 4px 14px ${C.blue}44`,
            cursor: running ? "not-allowed" : "pointer",
          }}>
            {running ? `⟳ ${progress.n}/${progress.t}` : "▶  Run Backtest"}
          </button>

          {/* Progress */}
          <div>
            <div style={{
              background:C.border, borderRadius:4, height:4, overflow:"hidden",
            }}>
              <div style={{
                height:"100%", borderRadius:4,
                background:`linear-gradient(90deg,${C.blue},${C.teal})`,
                width:`${progress.t>0?(progress.n/progress.t)*100:0}%`,
                transition:"width .4s",
              }}/>
            </div>
            {progress.msg && (
              <div style={{
                fontSize:10, color:C.muted, marginTop:6, lineHeight:1.5,
                fontFamily:"'DM Mono',monospace", wordBreak:"break-all",
              }}>{progress.msg}</div>
            )}
          </div>

          {/* Failed symbols */}
          {!running && results?.failed?.length>0 && (
            <div style={{
              background:C.redLight, border:`1px solid ${C.red}30`,
              borderRadius:8, padding:"10px 12px",
            }}>
              <div style={{
                color:C.red, fontWeight:700, fontSize:11, marginBottom:3,
                fontFamily:"'Plus Jakarta Sans',sans-serif",
              }}>⚠ Failed ({results.failed.length})</div>
              <div style={{color:C.muted, fontSize:10, fontFamily:"'DM Mono',monospace"}}>
                {results.failed.join(", ")}
              </div>
            </div>
          )}
        </aside>

        {/* ══ MAIN CONTENT ══════════════════════════════════════════ */}
        <main style={{flex:1, overflowY:"auto", padding:24, background:C.bg}}>

          {/* Empty state */}
          {!results && !running && (
            <div style={{
              height:"100%", minHeight:500,
              display:"flex", flexDirection:"column",
              alignItems:"center", justifyContent:"center", gap:20,
            }}>
              <div style={{
                width:72, height:72, borderRadius:20,
                background:`linear-gradient(135deg,${C.blueLight},${C.tealLight})`,
                display:"flex", alignItems:"center", justifyContent:"center",
                fontSize:32, boxShadow:C.shadowMd,
              }}>📊</div>
              <div style={{
                fontFamily:"'Plus Jakarta Sans',sans-serif",
                fontSize:26, fontWeight:800, color:C.text, textAlign:"center",
              }}>PMS-Grade Strategy Analytics</div>
              <div style={{
                color:C.soft, fontSize:14, textAlign:"center",
                maxWidth:440, lineHeight:1.8,
              }}>
                Pick stocks, set your capital & model, choose dates —
                then click <b style={{color:C.blue}}>Run Backtest</b>.
                Real data fetched live from Yahoo Finance.
              </div>
              <div style={{display:"flex", gap:8, flexWrap:"wrap", justifyContent:"center"}}>
                {["Live Yahoo Finance","Equity Curve","Drawdown","CAGR",
                  "Sharpe Ratio","Win Rate","Monthly P&L","Sector Breakdown","Trade Log"
                ].map(f=>(
                  <span key={f} style={{
                    padding:"4px 12px", borderRadius:100, fontSize:11,
                    background:C.blueLight, color:C.blue,
                    fontWeight:600, fontFamily:"'Plus Jakarta Sans',sans-serif",
                  }}>{f}</span>
                ))}
              </div>
            </div>
          )}

          {/* Loading state */}
          {running && (
            <div style={{
              height:"100%", minHeight:500,
              display:"flex", flexDirection:"column",
              alignItems:"center", justifyContent:"center", gap:20,
            }}>
              <div style={{
                width:64, height:64, borderRadius:16,
                background:`linear-gradient(135deg,${C.blueLight},${C.tealLight})`,
                display:"flex", alignItems:"center", justifyContent:"center",
                fontSize:28, boxShadow:C.shadowMd,
              }}>⟳</div>
              <div style={{
                fontFamily:"'Plus Jakarta Sans',sans-serif",
                fontSize:20, fontWeight:800, color:C.text,
              }}>Fetching & Backtesting…</div>
              <div style={{
                color:C.soft, fontSize:13, textAlign:"center",
                maxWidth:360, fontFamily:"'DM Mono',monospace",
              }}>{progress.msg}</div>
              <div style={{
                background:C.border, borderRadius:4,
                height:4, width:280, overflow:"hidden",
              }}>
                <div style={{
                  height:"100%", borderRadius:4,
                  background:`linear-gradient(90deg,${C.blue},${C.teal})`,
                  width:`${progress.t>0?(progress.n/progress.t)*100:5}%`,
                  transition:"width .4s",
                }}/>
              </div>
              <div style={{color:C.muted, fontSize:12}}>
                {progress.n} / {progress.t} stocks complete
              </div>
            </div>
          )}

          {/* Results */}
          {results && !running && statsData && (<>

            {/* Stock selector tabs */}
            <div style={{
              display:"flex", gap:6, flexWrap:"wrap", marginBottom:18,
              paddingBottom:16, borderBottom:`1px solid ${C.border}`,
            }}>
              <button onClick={()=>setActiveSymbol(null)} style={{
                padding:"6px 14px", borderRadius:100, fontSize:12, fontWeight:700,
                border:`1.5px solid ${!activeSymbol ? C.blue : C.border}`,
                background:!activeSymbol ? C.blue : C.white,
                color:!activeSymbol ? "#fff" : C.soft,
              }}>▣ Portfolio</button>
              {results.stockRes.map(r=>(
                <button key={r.symbol} onClick={()=>setActiveSymbol(r.symbol)} style={{
                  padding:"6px 14px", borderRadius:100, fontSize:12, fontWeight:600,
                  border:`1.5px solid ${activeSymbol===r.symbol ? C.teal : C.border}`,
                  background:activeSymbol===r.symbol ? C.tealLight : C.white,
                  color:activeSymbol===r.symbol ? C.teal : C.soft,
                  display:"flex", alignItems:"center", gap:5,
                }}>
                  <span style={{
                    width:6, height:6, borderRadius:"50%", flexShrink:0,
                    background:r.stats.totalPnL>=0 ? C.green : C.red,
                  }}/>
                  {r.name}
                </button>
              ))}
            </div>

            {/* KPI Row 1 */}
            <div style={{
              display:"grid", gridTemplateColumns:"repeat(4,1fr)",
              gap:10, marginBottom:10,
            }}>
              <KPI icon="💰" label="Total P&L" value={fmtC(statsData.totalPnL)}
                color={clr(statsData.totalPnL)}
                sub={statsData.totalPnL>=0?"Profitable period":"Loss period"} />
              <KPI icon="📈" label="Final Equity" value={fmtC(statsData.finalEq)}
                sub={`Capital: ₹${(+initCap).toLocaleString("en-IN")}`} />
              <KPI icon="🚀" label="CAGR" value={fmtP(statsData.cagr)}
                color={clr(statsData.cagr)} />
              <KPI icon="⚡" label="Sharpe Ratio" value={fmtN(statsData.sharpe)}
                color={statsData.sharpe>=1?C.green:statsData.sharpe>=0.5?C.amber:C.red}
                sub={statsData.sharpe>=1?"Excellent":statsData.sharpe>=0.5?"Good":"Poor"} />
            </div>

            {/* KPI Row 2 */}
            <div style={{
              display:"grid", gridTemplateColumns:"repeat(4,1fr)",
              gap:10, marginBottom:20,
            }}>
              <KPI icon="🎯" label="Win Rate"
                value={`${statsData.winRate?.toFixed(1)}%`}
                color={clr(statsData.winRate-50)}
                sub={`${statsData.winners}W / ${statsData.losers}L`} />
              <KPI icon="⚖️" label="Profit Factor"
                value={statsData.profitFactor===Infinity?"∞":fmtN(statsData.profitFactor)}
                color={clr(statsData.profitFactor-1)} />
              <KPI icon="📉" label="Max Drawdown"
                value={`${statsData.maxDDPct?.toFixed(1)}%`}
                color={C.red} sub={fmtC(statsData.maxDD)} />
              <KPI icon="🔢" label="Trades"
                value={statsData.totalTrades}
                sub={`${statsData.openTrades} open positions`} />
            </div>

            {/* Tabs — landing page style */}
            <div style={{
              display:"flex", borderBottom:`1px solid ${C.border}`,
              marginBottom:20, gap:0,
            }}>
              {[["overview","Overview"],["trades","Trade Log"],
                ["sector","Sector"],["monthly","Monthly P&L"]].map(([id,lbl])=>(
                <button key={id} onClick={()=>setTab(id)} style={{
                  padding:"10px 20px", fontSize:13, fontWeight:600,
                  border:"none", background:"transparent",
                  color: tab===id ? C.blue : C.soft,
                  borderBottom:`2px solid ${tab===id ? C.blue : "transparent"}`,
                  fontFamily:"'Plus Jakarta Sans',sans-serif",
                }}>{lbl}</button>
              ))}
            </div>

            {/* ── OVERVIEW ── */}
            {tab==="overview" && (
              <div style={{display:"flex", flexDirection:"column", gap:14}}>

                {/* Equity Curve */}
                <div style={{
                  background:C.white, border:`1px solid ${C.border}`,
                  borderRadius:14, padding:20, boxShadow:C.shadowSm,
                }}>
                  <div style={{
                    display:"flex", justifyContent:"space-between",
                    alignItems:"center", marginBottom:14,
                  }}>
                    <div style={{
                      fontFamily:"'Plus Jakarta Sans',sans-serif",
                      fontWeight:800, fontSize:15, color:C.text,
                    }}>Equity Curve — {viewLabel}</div>
                    <div style={{
                      fontSize:11, color:C.muted,
                      fontFamily:"'DM Mono',monospace",
                    }}>
                      {curveData?.[0]?.date} → {curveData?.[curveData.length-1]?.date}
                    </div>
                  </div>
                  <ResponsiveContainer width="100%" height={210}>
                    <AreaChart data={curveData}>
                      <defs>
                        <linearGradient id="ge" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor={C.blue} stopOpacity={.15}/>
                          <stop offset="95%" stopColor={C.blue} stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false}/>
                      <XAxis dataKey="date" tick={{fill:C.muted,fontSize:10}}
                        tickFormatter={d=>d?.slice(0,7)} interval="preserveStartEnd"
                        axisLine={false} tickLine={false}/>
                      <YAxis tick={{fill:C.muted,fontSize:10}} width={68}
                        tickFormatter={v=>`₹${(v/1e5).toFixed(0)}L`}
                        axisLine={false} tickLine={false}/>
                      <Tooltip content={<CTip/>}/>
                      <ReferenceLine
                        y={active?active.perStockCap:(results?.portEq?.[0]?.equity||0)}
                        stroke={C.muted} strokeDasharray="4 2" strokeWidth={1}/>
                      <Area type="monotone" dataKey="equity" name="Equity"
                        stroke={C.blue} fill="url(#ge)" strokeWidth={2.5} dot={false}/>
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                {/* Drawdown */}
                <div style={{
                  background:C.white, border:`1px solid ${C.border}`,
                  borderRadius:14, padding:20, boxShadow:C.shadowSm,
                }}>
                  <div style={{
                    fontFamily:"'Plus Jakarta Sans',sans-serif",
                    fontWeight:800, fontSize:14, marginBottom:12, color:C.text,
                  }}>
                    Drawdown %
                    <span style={{
                      color:C.red, fontSize:12, fontWeight:500, marginLeft:10,
                    }}>Peak −{statsData.maxDDPct?.toFixed(1)}%</span>
                  </div>
                  <ResponsiveContainer width="100%" height={130}>
                    <AreaChart data={ddSeries}>
                      <defs>
                        <linearGradient id="gd" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor={C.red} stopOpacity={.15}/>
                          <stop offset="95%" stopColor={C.red} stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false}/>
                      <XAxis dataKey="date" tick={{fill:C.muted,fontSize:9}}
                        tickFormatter={d=>d?.slice(0,7)} interval="preserveStartEnd"
                        axisLine={false} tickLine={false}/>
                      <YAxis tick={{fill:C.muted,fontSize:9}} width={42}
                        tickFormatter={v=>`${v.toFixed(0)}%`}
                        axisLine={false} tickLine={false}/>
                      <Tooltip content={<CTip/>}/>
                      <Area type="monotone" dataKey="drawdown" name="Drawdown%"
                        stroke={C.red} fill="url(#gd)" strokeWidth={2} dot={false}/>
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                {/* Stock comparison table */}
                {!activeSymbol && compData.length>1 && (
                  <div style={{
                    background:C.white, border:`1px solid ${C.border}`,
                    borderRadius:14, padding:20, boxShadow:C.shadowSm,
                  }}>
                    <div style={{
                      fontFamily:"'Plus Jakarta Sans',sans-serif",
                      fontWeight:800, fontSize:15, marginBottom:14, color:C.text,
                    }}>Stock Comparison</div>
                    <div style={{overflowX:"auto"}}>
                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
                        <thead>
                          <tr style={{borderBottom:`1px solid ${C.border}`}}>
                            {["Stock","Sector","CAGR","P&L","Win%","Max DD","Sharpe","Lots"]
                              .map(h=>(
                              <th key={h} style={{
                                padding:"8px 10px", textAlign:"left",
                                fontSize:10, fontWeight:700, letterSpacing:1,
                                textTransform:"uppercase", color:C.muted,
                                fontFamily:"'Plus Jakarta Sans',sans-serif",
                              }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {compData.map(r=>(
                            <tr key={r.symbol}
                              onClick={()=>setActiveSymbol(r.symbol)}
                              style={{
                                borderBottom:`1px solid ${C.border}`,
                                cursor:"pointer", transition:"background .1s",
                              }}
                              onMouseEnter={e=>e.currentTarget.style.background=C.bg}
                              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                              <td style={{padding:"10px 10px"}}>
                                <div style={{
                                  fontWeight:700, fontSize:13,
                                  fontFamily:"'Plus Jakarta Sans',sans-serif",
                                }}>{r.name}</div>
                                <div style={{
                                  color:C.muted, fontSize:10,
                                  fontFamily:"'DM Mono',monospace",
                                }}>{r.symbol}</div>
                              </td>
                              <td style={{padding:"10px"}}>
                                <span style={{
                                  background:C.tealLight, color:C.teal,
                                  padding:"2px 8px", borderRadius:100,
                                  fontSize:10, fontWeight:600,
                                }}>{r.sector}</span>
                              </td>
                              <td style={{padding:"10px",color:clr(r.stats.cagr),fontWeight:700}}>
                                {fmtP(r.stats.cagr)}</td>
                              <td style={{padding:"10px",color:clr(r.stats.totalPnL),fontWeight:700}}>
                                {fmtC(r.stats.totalPnL)}</td>
                              <td style={{padding:"10px",color:clr(r.stats.winRate-50)}}>
                                {r.stats.winRate?.toFixed(1)}%</td>
                              <td style={{padding:"10px",color:C.red}}>
                                {r.stats.maxDDPct?.toFixed(1)}%</td>
                              <td style={{padding:"10px",color:clr(r.stats.sharpe)}}>
                                {r.stats.sharpe?.toFixed(2)}</td>
                              <td style={{padding:"10px",color:C.soft}}>
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

            {/* ── TRADE LOG ── */}
            {tab==="trades" && (
              <div style={{
                background:C.white, border:`1px solid ${C.border}`,
                borderRadius:14, padding:20, boxShadow:C.shadowSm,
              }}>
                <div style={{
                  display:"flex", justifyContent:"space-between",
                  alignItems:"center", marginBottom:14, flexWrap:"wrap", gap:8,
                }}>
                  <div style={{
                    fontFamily:"'Plus Jakarta Sans',sans-serif",
                    fontWeight:800, fontSize:15, color:C.text,
                  }}>Trade Log — {displayTrades.length} entries</div>
                  <div style={{display:"flex", gap:6, flexWrap:"wrap"}}>
                    {[["all","All"],["open","Open"],["closed","Closed"]].map(([v,l])=>(
                      <Chip key={v} label={l} active={tradeFilter===v}
                        onClick={()=>setTradeFilter(v)} />
                    ))}
                    <Chip label="↕ Date" active={sortBy==="date"} color={C.teal}
                      onClick={()=>setSortBy("date")} />
                    <Chip label="↕ P&L" active={sortBy==="pnl"} color={C.teal}
                      onClick={()=>setSortBy("pnl")} />
                  </div>
                </div>
                <div style={{overflowX:"auto", maxHeight:500, overflowY:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                    <thead style={{position:"sticky",top:0,background:C.white,zIndex:1}}>
                      <tr style={{borderBottom:`1px solid ${C.border}`}}>
                        {(!active?["Symbol"]:[]).concat([
                          "Entry Date","Entry ₹","Qty","Lot ₹",
                          "Exit Date","Exit ₹","P&L","Ret%","Status"
                        ]).map(h=>(
                          <th key={h} style={{
                            padding:"8px 10px", textAlign:"left",
                            fontSize:10, fontWeight:700, letterSpacing:1,
                            textTransform:"uppercase", color:C.muted,
                            fontFamily:"'Plus Jakarta Sans',sans-serif",
                            whiteSpace:"nowrap",
                          }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {displayTrades.map((t,i)=>{
                        const ret = t.pnl!=null&&t.lot_capital
                          ? (t.pnl/t.lot_capital)*100 : null;
                        return (
                          <tr key={i}
                            style={{borderBottom:`1px solid ${C.border}`}}
                            onMouseEnter={e=>e.currentTarget.style.background=C.bg}
                            onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                            {!active&&(
                              <td style={{
                                padding:"8px 10px",color:C.blue,
                                fontSize:11,fontFamily:"'DM Mono',monospace",
                                whiteSpace:"nowrap",fontWeight:600,
                              }}>{t.symbol}</td>
                            )}
                            <td style={{padding:"8px 10px",color:C.soft,whiteSpace:"nowrap"}}>
                              {t.entry_date}</td>
                            <td style={{padding:"8px 10px",fontFamily:"'DM Mono',monospace",fontWeight:600}}>
                              ₹{t.entry_price?.toFixed(2)}</td>
                            <td style={{padding:"8px 10px"}}>{t.quantity}</td>
                            <td style={{padding:"8px 10px",color:C.muted,fontFamily:"'DM Mono',monospace"}}>
                              ₹{t.lot_capital?.toFixed(0)}</td>
                            <td style={{padding:"8px 10px",color:C.soft,whiteSpace:"nowrap"}}>
                              {t.exit_date||"—"}</td>
                            <td style={{padding:"8px 10px",fontFamily:"'DM Mono',monospace"}}>
                              {t.exit_price?`₹${t.exit_price.toFixed(2)}`:"—"}</td>
                            <td style={{
                              padding:"8px 10px", fontWeight:700,
                              color:t.pnl==null?C.muted:clr(t.pnl),
                            }}>{t.pnl!=null?fmtC(t.pnl):"Open"}</td>
                            <td style={{padding:"8px 10px",color:ret==null?C.muted:clr(ret)}}>
                              {ret!=null?fmtP(ret):"—"}</td>
                            <td style={{padding:"8px 10px"}}>
                              <span style={{
                                padding:"2px 8px", borderRadius:100,
                                fontSize:10, fontWeight:600,
                                background:t.status==="open"
                                  ? C.amberLight
                                  : t.pnl>=0 ? C.greenLight : C.redLight,
                                color:t.status==="open"
                                  ? C.amber
                                  : t.pnl>=0 ? C.green : C.red,
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

            {/* ── SECTOR ── */}
            {tab==="sector" && (
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{
                  background:C.white,border:`1px solid ${C.border}`,
                  borderRadius:14,padding:20,boxShadow:C.shadowSm,
                }}>
                  <div style={{
                    fontFamily:"'Plus Jakarta Sans',sans-serif",
                    fontWeight:800,fontSize:15,marginBottom:14,color:C.text,
                  }}>Sector P&L</div>
                  <ResponsiveContainer width="100%"
                    height={Math.max(160,sectorData.length*56)}>
                    <BarChart data={sectorData} layout="vertical"
                      margin={{left:10,right:30,top:0,bottom:0}}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false}/>
                      <XAxis type="number" tick={{fill:C.muted,fontSize:10}}
                        tickFormatter={v=>`₹${(v/1000).toFixed(0)}K`}
                        axisLine={false} tickLine={false}/>
                      <YAxis type="category" dataKey="sector"
                        tick={{fill:C.text,fontSize:12,fontWeight:600}} width={110}
                        axisLine={false} tickLine={false}/>
                      <Tooltip content={<CTip/>}/>
                      <Bar dataKey="pnl" name="P&L" radius={[0,6,6,0]}>
                        {sectorData.map((d,i)=>(
                          <Cell key={i} fill={d.pnl>=0?C.green:C.red}/>
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div style={{
                  display:"grid",
                  gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",
                  gap:10,
                }}>
                  {sectorData.map(s=>(
                    <div key={s.sector} style={{
                      background:C.white,border:`1px solid ${C.border}`,
                      borderRadius:12,padding:16,boxShadow:C.shadowSm,
                    }}>
                      <div style={{
                        color:C.teal,fontWeight:700,fontSize:11,marginBottom:6,
                        fontFamily:"'Plus Jakarta Sans',sans-serif",
                        textTransform:"uppercase",letterSpacing:.5,
                      }}>{s.sector}</div>
                      <div style={{
                        color:clr(s.pnl),fontSize:20,fontWeight:800,
                        fontFamily:"'Plus Jakarta Sans',sans-serif",
                      }}>{fmtC(s.pnl)}</div>
                      <div style={{color:clr(s.cagr),fontSize:11,marginTop:4}}>
                        CAGR {fmtP(s.cagr)}</div>
                      <div style={{color:C.muted,fontSize:10,marginTop:2}}>
                        {s.count} stock{s.count!==1?"s":""}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── MONTHLY ── */}
            {tab==="monthly" && (
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{
                  background:C.white,border:`1px solid ${C.border}`,
                  borderRadius:14,padding:20,boxShadow:C.shadowSm,
                }}>
                  <div style={{
                    fontFamily:"'Plus Jakarta Sans',sans-serif",
                    fontWeight:800,fontSize:15,marginBottom:14,color:C.text,
                  }}>Monthly P&L — {viewLabel}</div>
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={monthlyData} margin={{left:0,right:8}}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false}/>
                      <XAxis dataKey="m" tick={{fill:C.muted,fontSize:10}} interval={2}
                        tickFormatter={v=>v?.slice(2)}
                        axisLine={false} tickLine={false}/>
                      <YAxis tick={{fill:C.muted,fontSize:10}} width={58}
                        tickFormatter={v=>`₹${(v/1000).toFixed(0)}K`}
                        axisLine={false} tickLine={false}/>
                      <Tooltip content={<CTip/>}/>
                      <ReferenceLine y={0} stroke={C.border} strokeWidth={1}/>
                      <Bar dataKey="pnl" name="Monthly P&L" radius={[4,4,0,0]}>
                        {monthlyData.map((d,i)=>(
                          <Cell key={i} fill={d.pnl>=0?C.green:C.red}/>
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div style={{
                  display:"grid",
                  gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",
                  gap:8,
                }}>
                  {monthlyData.map((d,i)=>{
                    const mx=Math.max(...monthlyData.map(x=>Math.abs(x.pnl)),1);
                    return(
                      <div key={i} style={{
                        background:C.white,
                        border:`1px solid ${d.pnl>=0?C.green+"33":C.red+"33"}`,
                        borderRadius:10,padding:"10px 12px",boxShadow:C.shadowSm,
                      }}>
                        <div style={{
                          color:C.muted,fontSize:10,marginBottom:4,
                          fontFamily:"'DM Mono',monospace",
                        }}>{d.m}</div>
                        <div style={{
                          color:clr(d.pnl),fontWeight:800,fontSize:15,
                          fontFamily:"'Plus Jakarta Sans',sans-serif",
                        }}>{fmtC(d.pnl)}</div>
                        <div style={{
                          marginTop:6,height:3,borderRadius:2,
                          background:C.border,overflow:"hidden",
                        }}>
                          <div style={{
                            height:"100%",borderRadius:2,
                            width:`${Math.abs(d.pnl)/mx*100}%`,
                            background:d.pnl>=0?C.green:C.red,
                          }}/>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Strategy footer — matches landing page disclaimer style */}
            <div style={{
              marginTop:16,
              background:C.amberLight,
              border:`1px solid #FDE68A`,
              borderRadius:10,
              padding:"10px 16px",
              display:"flex", gap:10, alignItems:"flex-start",
            }}>
              <span style={{fontSize:14, flexShrink:0}}>⚠️</span>
              <div style={{fontSize:11, color:"#92400E", lineHeight:1.6}}>
                <b>Model:</b>&nbsp;
                {model===1&&`Fixed ₹${(+fixedAmt).toLocaleString("en-IN")}/lot`}
                {model===2&&`1% of ₹${(+initCap).toLocaleString("en-IN")} = ₹${(+initCap*0.01).toLocaleString("en-IN")}/lot`}
                {model===3&&"1% of rolling balance (dynamic)"}
                &nbsp;·&nbsp;Max {MAX_LOTS} lots · {(STEP_DOWN*100).toFixed(0)}% step-down ·&nbsp;
                {(FIRST_EXIT*100).toFixed(0)}% first exit · {(STOP_DROP*100).toFixed(0)}% stop-loss · LIFO exits.
                &nbsp;<b>Past performance does not guarantee future results. Not investment advice.</b>
              </div>
            </div>
          </>)}
        </main>
      </div>
    </div>
  );
}

const AlphaLensWithBoundary = () => (
  <ErrorBoundary><AlphaLens /></ErrorBoundary>
);
export default AlphaLensWithBoundary;
