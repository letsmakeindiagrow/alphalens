// api/ohlcv.js
// Vercel Serverless Function — runs on Node.js server side.
// Fetches Yahoo Finance OHLCV data and returns it as JSON.
// Called by the frontend as: GET /api/ohlcv?symbol=ADANIENT.NS&start=2015-01-01&end=2025-01-01
// No CORS issues because this runs on the SAME domain as the frontend.

export default async function handler(req, res) {
  // Allow frontend to call this endpoint
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const { symbol, start, end } = req.query;

  if (!symbol || !start || !end) {
    return res.status(400).json({ error: "Missing symbol, start, or end parameter" });
  }

  const p1  = Math.floor(new Date(start).getTime() / 1000);
  const p2  = Math.floor(new Date(end).getTime()   / 1000) + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
            + `?interval=1d&period1=${p1}&period2=${p2}&events=splits`;

  try {
    const response = await fetch(url, {
      headers: {
        // Mimic a browser request so Yahoo doesn't block us
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Yahoo Finance returned ${response.status} for ${symbol}`,
      });
    }

    const json   = await response.json();
    const result = json?.chart?.result?.[0];

    if (!result?.timestamp?.length) {
      return res.status(404).json({ error: `No data found for ${symbol}` });
    }

    const timestamps = result.timestamp;
    const q          = result.indicators.quote[0];
    const adjClose   = result.indicators.adjclose?.[0]?.adjclose || q.close;

    const rows = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = q.open[i], h = q.high[i], l = q.low[i];
      const c = q.close[i], ac = adjClose[i];

      // Skip null/zero candles (exchange holidays that sneak into data)
      if (o == null || h == null || l == null || c == null || !ac || c === 0) continue;

      // Adjust OHLC for splits & dividends (same as yfinance auto_adjust=True)
      const adj = ac / c;
      rows.push({
        date:  new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        open:  +(o * adj).toFixed(2),
        high:  +(h * adj).toFixed(2),
        low:   +(l * adj).toFixed(2),
        close: +ac.toFixed(2),
      });
    }

    if (rows.length === 0) {
      return res.status(404).json({ error: `No valid candles for ${symbol}` });
    }

    // Cache for 1 hour (Yahoo data doesn't change for historical dates)
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json({ symbol, rows });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

