// netlify/functions/yahoo.js
// Proxy for Yahoo Finance API — supports date range via period1/period2

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

function getYahooInterval(timeframe) {
  const map = {
    '1m': '1m', '5m': '5m', '15m': '15m',
    '1h': '60m', '4h': '60m', '1d': '1d', '1wk': '1wk'
  };
  return map[timeframe] || '1d';
}

// Fallback range when no dates provided
function getDefaultRange(timeframe) {
  const map = {
    '1m': '7d', '5m': '60d', '15m': '60d',
    '1h': '730d', '4h': '730d', '1d': '2y', '1wk': '5y'
  };
  return map[timeframe] || '2y';
}

function normalizeSymbol(symbol, market) {
  symbol = symbol.trim().toUpperCase();
  if (market === 'kr_stock') {
    if (!symbol.includes('.')) symbol += '.KS';
  } else if (market === 'crypto') {
    if (!symbol.includes('-')) symbol += '-USD';
  } else if (market === 'forex') {
    if (!symbol.includes('=')) symbol += '=X';
  }
  return symbol;
}

function aggregateTo4H(candles) {
  if (!candles || candles.length === 0) return candles;
  const result = [];
  for (let i = 0; i < candles.length; i += 4) {
    const chunk = candles.slice(i, i + 4);
    if (chunk.length === 0) continue;
    result.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((sum, c) => sum + (c.volume || 0), 0)
    });
  }
  return result;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    let { symbol, market, timeframe, startDate, endDate } = body;

    if (!symbol) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '심볼을 입력해주세요.' }) };
    }

    symbol = normalizeSymbol(symbol, market);
    const is4H = timeframe === '4h';
    const interval = is4H ? '60m' : getYahooInterval(timeframe || '1d');

    // Build URL — use period1/period2 if dates provided, else use range
    let url;
    if (startDate && endDate) {
      const p1 = Math.floor(new Date(startDate).getTime() / 1000);
      const p2 = Math.floor(new Date(endDate + 'T23:59:59').getTime() / 1000);
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&period1=${p1}&period2=${p2}&includePrePost=false`;
    } else {
      const range = is4H ? '730d' : getDefaultRange(timeframe || '1d');
      url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
    }

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    if (!response.ok) {
      const text = await response.text();
      return { statusCode: 200, headers, body: JSON.stringify({ error: `Yahoo Finance 오류: ${response.status}. 심볼을 확인해주세요.`, detail: text.substring(0, 200) }) };
    }

    const data = await response.json();
    const result = data?.chart?.result?.[0];
    if (!result) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: '데이터를 찾을 수 없습니다. 심볼을 확인해주세요.' }) };
    }

    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const opens = quote.open || [];
    const highs = quote.high || [];
    const lows = quote.low || [];
    const closes = quote.close || [];
    const volumes = quote.volume || [];

    let candles = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (opens[i] != null && closes[i] != null && highs[i] != null && lows[i] != null) {
        candles.push({
          time: timestamps[i],
          open: parseFloat(opens[i].toFixed(6)),
          high: parseFloat(highs[i].toFixed(6)),
          low: parseFloat(lows[i].toFixed(6)),
          close: parseFloat(closes[i].toFixed(6)),
          volume: volumes[i] || 0
        });
      }
    }

    if (is4H) candles = aggregateTo4H(candles);

    const meta = result.meta || {};
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        symbol: meta.symbol || symbol,
        currency: meta.currency || 'USD',
        exchange: meta.exchangeName || '',
        candles,
        totalCandles: candles.length
      })
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류: ' + err.message }) };
  }
};
