// netlify/functions/yahoo.js
// Proxy for Yahoo Finance API - fetches OHLCV data

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

// Map timeframe to Yahoo Finance interval and range
function getYahooParams(timeframe, symbol) {
  const map = {
    '1m':  { interval: '1m',  range: '7d' },
    '5m':  { interval: '5m',  range: '60d' },
    '15m': { interval: '15m', range: '60d' },
    '1h':  { interval: '60m', range: '730d' },
    '4h':  { interval: '60m', range: '730d' },  // we'll aggregate 4h from 1h
    '1d':  { interval: '1d',  range: '2y' },
    '1wk': { interval: '1wk', range: '5y' }
  };
  return map[timeframe] || map['1d'];
}

// Convert Korean stock codes
function normalizeSymbol(symbol, market) {
  symbol = symbol.trim().toUpperCase();
  if (market === 'kr_stock') {
    // Korean stock: append .KS (KOSPI) or .KQ (KOSDAQ)
    if (!symbol.includes('.')) {
      symbol = symbol + '.KS';
    }
  } else if (market === 'crypto') {
    if (!symbol.includes('-')) {
      symbol = symbol + '-USD';
    }
  } else if (market === 'forex') {
    if (!symbol.includes('=')) {
      symbol = symbol + '=X';
    }
  }
  return symbol;
}

// Aggregate 1h candles into 4h
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
    let { symbol, market, timeframe } = body;

    if (!symbol) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '심볼을 입력해주세요.' }) };
    }

    symbol = normalizeSymbol(symbol, market);
    const params = getYahooParams(timeframe || '1d', symbol);
    const is4H = timeframe === '4h';
    const actualInterval = is4H ? '60m' : params.interval;
    const actualRange = is4H ? '730d' : params.range;

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${actualInterval}&range=${actualRange}&includePrePost=false`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
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

    if (is4H) {
      candles = aggregateTo4H(candles);
    }

    const meta = result.meta || {};

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        symbol: meta.symbol || symbol,
        currency: meta.currency || 'USD',
        exchange: meta.exchangeName || '',
        candles: candles,
        totalCandles: candles.length
      })
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류: ' + err.message }) };
  }
};
