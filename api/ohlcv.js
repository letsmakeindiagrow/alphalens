// api/ohlcv.js
// Vercel Serverless Function
// Flow:
//   1. Check Aiven PostgreSQL cache for this symbol + date range
//   2. If cached → return instantly (< 100ms)
//   3. If not → fetch Yahoo Finance → store in DB → return
//
// Environment variable required (set in Vercel dashboard):
//   DATABASE_URL = postgres://...  (your Aiven PostgreSQL Service URI)

import { Pool } from "pg";

// ─────────────────────────────────────────────────────────────────
// DB CONNECTION POOL
// Reused across warm serverless invocations for speed
// ─────────────────────────────────────────────────────────────────
let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },   // required for Aiven
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

// ─────────────────────────────────────────────────────────────────
// ENSURE TABLE EXISTS  (runs once, safe to repeat)
// ─────────────────────────────────────────────────────────────────
async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ohlcv_cache (
      id         SERIAL PRIMARY KEY,
      symbol     TEXT          NOT NULL,
      date       DATE          NOT NULL,
      open       NUMERIC(12,4) NOT NULL,
      high       NUMERIC(12,4) NOT NULL,
      low        NUMERIC(12,4) NOT NULL,
      close      NUMERIC(12,4) NOT NULL,
      fetched_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      UNIQUE(symbol, date)
    );
    CREATE INDEX IF NOT EXISTS idx_ohlcv_symbol_date
      ON ohlcv_cache(symbol, date);
  `);
}

// ─────────────────────────────────────────────────────────────────
// FETCH FROM YAHOO FINANCE
// ─────────────────────────────────────────────────────────────────
async function fetchFromYahoo(symbol, p1, p2) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&period1=${p1}&period2=${p2}&events=splits`;

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) throw new Error(`Yahoo returned HTTP ${res.status} for ${symbol}`);

  const json   = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error(`No data from Yahoo for ${symbol}`);

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
      open:  +(o  * adj).toFixed(4),
      high:  +(h  * adj).toFixed(4),
      low:   +(l  * adj).toFixed(4),
      close: +ac.toFixed(4),
    });
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────
// SAVE ROWS TO DB  (bulk upsert, 500 rows per batch)
// ─────────────────────────────────────────────────────────────────
async function saveToDb(client, symbol, rows) {
  if (!rows.length) return;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk  = rows.slice(i, i + BATCH);
    const values = [];
    const params = [];
    let   n      = 1;
    for (const r of chunk) {
      values.push(`($${n++},$${n++},$${n++},$${n++},$${n++},$${n++})`);
      params.push(symbol, r.date, r.open, r.high, r.low, r.close);
    }
    await client.query(
      `INSERT INTO ohlcv_cache(symbol,date,open,high,low,close)
       VALUES ${values.join(",")}
       ON CONFLICT(symbol,date) DO UPDATE SET
         open=EXCLUDED.open, high=EXCLUDED.high,
         low=EXCLUDED.low,   close=EXCLUDED.close,
         fetched_at=NOW()`,
      params
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const { symbol, start, end } = req.query;
  if (!symbol || !start || !end) {
    return res.status(400).json({ error: "Missing symbol, start, or end" });
  }

  const p1 = Math.floor(new Date(start).getTime() / 1000);
  const p2 = Math.floor(new Date(end).getTime()   / 1000) + 86400;

  // ── No DB configured → direct Yahoo (works without Aiven) ──
  if (!process.env.DATABASE_URL) {
    try {
      const rows = await fetchFromYahoo(symbol, p1, p2);
      return res.status(200).json({ symbol, rows, source: "yahoo_direct" });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── With DB → cache-first strategy ──
  const db = getPool();
  let client;
  try {
    client = await db.connect();
    await ensureTable(client);

    // Step 1: query cache
    const { rows: cached } = await client.query(
      `SELECT date::text, open::float, high::float, low::float, close::float
         FROM ohlcv_cache
        WHERE symbol=$1 AND date>=$2 AND date<=$3
        ORDER BY date`,
      [symbol, start, end]
    );

    // Step 2: decide if cache is fresh enough
    // Expected ~252 trading days per year; require 80% of that
    const daySpan      = (new Date(end) - new Date(start)) / 86400000;
    const expectedDays = Math.round(daySpan * (5/7) * 0.95);
    const isFresh      = cached.length >= Math.max(expectedDays * 0.80, 5);

    let rows, source;
    if (isFresh) {
      // Serve from cache
      rows   = cached.map(r => ({date:r.date, open:+r.open, high:+r.high, low:+r.low, close:+r.close}));
      source = "cache";
    } else {
      // Fetch fresh from Yahoo and persist
      const fresh = await fetchFromYahoo(symbol, p1, p2);
      await saveToDb(client, symbol, fresh);
      rows   = fresh;
      source = "yahoo_saved";
    }

    // Cache headers: historical data cached longer than recent
    const isHistorical = new Date(end) < new Date(Date.now() - 86400000);
    res.setHeader("Cache-Control",
      isHistorical ? "public, s-maxage=86400, stale-while-revalidate=604800"
                   : "public, s-maxage=3600");

    return res.status(200).json({ symbol, rows, source, count: rows.length });

  } catch (err) {
    // DB error → fall back to Yahoo directly
    console.error(`DB error for ${symbol}:`, err.message);
    try {
      const rows = await fetchFromYahoo(symbol, p1, p2);
      return res.status(200).json({ symbol, rows, source: "yahoo_fallback" });
    } catch (e2) {
      return res.status(500).json({ error: e2.message });
    }
  } finally {
    if (client) client.release();
  }
}
