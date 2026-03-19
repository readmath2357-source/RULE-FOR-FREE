// netlify/functions/analyze.js
// Sends OHLCV data to Claude AI for analysis
// System prompt is SERVER-SIDE ONLY — never exposed to frontend

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

// ============================================================
// SYSTEM PROMPT — SERVER ONLY, NEVER SENT TO CLIENT
// ============================================================
const SYSTEM_PROMPT = `You are an expert technical analyst specializing in multi-indicator confluence analysis. You analyze price action using four core methodologies simultaneously:

## 1. VOLUME ANALYSIS
- Analyze volume trends relative to price movement
- Rising volume with price trend = trend continuation likely
- Declining volume with price trend = trend exhaustion possible  
- Volume spikes at key levels indicate institutional activity
- Use volume to gauge the PROBABILITY of trend continuation (high/medium/low)

## 2. ICT (Inner Circle Trader) CONCEPTS
- Identify Order Blocks (OB): last bullish candle before a bearish move / last bearish candle before a bullish move
- Identify Fair Value Gaps (FVG): 3-candle patterns where middle candle's range doesn't overlap with outer candles
- Identify liquidity zones: areas where stop losses cluster (above swing highs, below swing lows)
- Identify Break of Structure (BOS) and Change of Character (CHoCH)
- Identify premium/discount zones using recent swing high/low (above 50% = premium, below 50% = discount)
- Use ICT concepts to determine Entry, Stop Loss, and Take Profit levels
- ICT patterns should be described for visual overlay on the chart

## 3. TSI (True Strength Index) — Parameters: (13, 8, 8)
- TSI Line = 100 × EMA(EMA(price_change, 13), 8) / EMA(EMA(|price_change|, 13), 8)
- Signal Line = EMA(TSI, 8)
- When TSI line is ABOVE signal line → Bullish momentum
- When TSI line is BELOW signal line → Bearish momentum
- TSI near +25 or above = strong bullish / near -25 or below = strong bearish
- TSI crossing zero line = potential trend change
- Assess momentum strength based on TSI position relative to zero and signal line

## 4. RSI — Parameters: RSI Length 21, RSI SMA Length 21
- RSI calculated with length 21
- RSI Moving Average = SMA(RSI, 21)
- When RSI is ABOVE RSI SMA → Bullish strength
- When RSI is BELOW RSI SMA → Bearish strength
- RSI > 70 = Overbought zone (potential reversal or continuation in strong trend)
- RSI < 30 = Oversold zone (potential reversal or continuation in strong downtrend)
- RSI between 40-60 with flat SMA = consolidation/ranging
- Assess probability based on RSI level AND its relationship to the SMA

## CONFLUENCE SCORING
Combine all four indicators:
- 4/4 agree = HIGH confidence signal
- 3/4 agree = MODERATE confidence signal  
- 2/4 agree or less = LOW confidence / HOLD (관망)

## OUTPUT FORMAT
You MUST respond in valid JSON only, no markdown, no backticks. Use this exact structure:
{
  "direction": "LONG" or "SHORT" or "HOLD",
  "confidence": "HIGH" or "MODERATE" or "LOW",
  "entry": <number - entry price>,
  "stopLoss": <number - stop loss price>,
  "takeProfit": <number - take profit price>,
  "riskReward": "<string like 1:2.5>",
  "comment": "<one-line Korean summary of analysis reasoning>",
  "indicators": {
    "volume": {"signal": "BULLISH" or "BEARISH" or "NEUTRAL", "detail": "<brief Korean explanation>"},
    "ict": {"signal": "BULLISH" or "BEARISH" or "NEUTRAL", "detail": "<brief Korean explanation>", "patterns": ["OB", "FVG", "BOS", etc]},
    "tsi": {"signal": "BULLISH" or "BEARISH" or "NEUTRAL", "value": <number>, "signalLine": <number>, "detail": "<brief Korean explanation>"},
    "rsi": {"signal": "BULLISH" or "BEARISH" or "NEUTRAL", "value": <number>, "sma": <number>, "detail": "<brief Korean explanation>"}
  },
  "ictOverlay": {
    "orderBlocks": [{"type": "bullish" or "bearish", "high": <num>, "low": <num>, "index": <candle_index>}],
    "fvg": [{"type": "bullish" or "bearish", "high": <num>, "low": <num>, "index": <candle_index>}],
    "liquidityZones": [{"price": <num>, "type": "buy_side" or "sell_side"}],
    "bos": [{"price": <num>, "type": "bullish" or "bearish", "index": <candle_index>}]
  }
}

IMPORTANT:
- Entry, StopLoss, TakeProfit must be realistic price levels based on the actual data
- For LONG: entry < takeProfit, stopLoss < entry
- For SHORT: entry > takeProfit, stopLoss > entry
- For HOLD: still provide suggested levels but mark as "HOLD"
- All explanations in Korean
- Keep comment concise (under 80 characters)`;

// Calculate RSI with custom length
function calcRSI(closes, length = 21) {
  if (closes.length < length + 1) return [];
  const rsiValues = [];
  let gainAvg = 0;
  let lossAvg = 0;

  // Initial average
  for (let i = 1; i <= length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gainAvg += change;
    else lossAvg += Math.abs(change);
  }
  gainAvg /= length;
  lossAvg /= length;

  for (let i = 0; i <= length; i++) rsiValues.push(null);

  const rs = lossAvg === 0 ? 100 : gainAvg / lossAvg;
  rsiValues[length] = lossAvg === 0 ? 100 : 100 - 100 / (1 + rs);

  for (let i = length + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    gainAvg = (gainAvg * (length - 1) + gain) / length;
    lossAvg = (lossAvg * (length - 1) + loss) / length;
    const rs2 = lossAvg === 0 ? 100 : gainAvg / lossAvg;
    rsiValues.push(lossAvg === 0 ? 100 : 100 - 100 / (1 + rs2));
  }
  return rsiValues;
}

// Calculate SMA
function calcSMA(values, length) {
  const result = [];
  for (let i = 0; i < values.length; i++) {
    if (i < length - 1 || values[i] === null) {
      result.push(null);
      continue;
    }
    let sum = 0;
    let count = 0;
    for (let j = i - length + 1; j <= i; j++) {
      if (values[j] !== null) { sum += values[j]; count++; }
    }
    result.push(count > 0 ? sum / count : null);
  }
  return result;
}

// Calculate EMA
function calcEMA(values, length) {
  const result = [];
  const k = 2 / (length + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === null) { result.push(null); continue; }
    if (prev === null) { prev = values[i]; result.push(prev); continue; }
    prev = values[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

// Calculate TSI (13, 8, 8)
function calcTSI(closes, longLen = 13, shortLen = 8, sigLen = 8) {
  if (closes.length < longLen + shortLen + 2) return { tsi: [], signal: [] };
  const changes = [null];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }
  const absChanges = changes.map(c => c === null ? null : Math.abs(c));

  const emaLong = calcEMA(changes, longLen);
  const doubleSmooth = calcEMA(emaLong, shortLen);
  const absEmaLong = calcEMA(absChanges, longLen);
  const absDoubleSmooth = calcEMA(absEmaLong, shortLen);

  const tsiValues = [];
  for (let i = 0; i < closes.length; i++) {
    if (doubleSmooth[i] === null || absDoubleSmooth[i] === null || absDoubleSmooth[i] === 0) {
      tsiValues.push(null);
    } else {
      tsiValues.push(100 * doubleSmooth[i] / absDoubleSmooth[i]);
    }
  }
  const signalLine = calcEMA(tsiValues, sigLen);
  return { tsi: tsiValues, signal: signalLine };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'API 키가 설정되지 않았습니다.' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { candles, symbol, timeframe } = body;

    if (!candles || candles.length < 30) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '최소 30개 이상의 캔들이 필요합니다.' }) };
    }

    // Pre-calculate indicators server-side to feed Claude
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);

    const rsiValues = calcRSI(closes, 21);
    const rsiSMA = calcSMA(rsiValues, 21);
    const tsiData = calcTSI(closes, 13, 8, 8);

    const lastIdx = closes.length - 1;
    const currentRSI = rsiValues[lastIdx];
    const currentRSI_SMA = rsiSMA[lastIdx];
    const currentTSI = tsiData.tsi[lastIdx];
    const currentTSI_Signal = tsiData.signal[lastIdx];

    // Prepare data summary for Claude
    const recentCandles = candles.slice(-50).map((c, i) => ({
      idx: candles.length - 50 + i,
      t: c.time,
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
      v: c.volume
    }));

    const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const recentVolume = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;

    const prompt = `Analyze this ${symbol} ${timeframe} chart data.

CURRENT INDICATOR VALUES:
- RSI(21): ${currentRSI?.toFixed(2) || 'N/A'}
- RSI SMA(21): ${currentRSI_SMA?.toFixed(2) || 'N/A'}
- RSI vs SMA: ${currentRSI && currentRSI_SMA ? (currentRSI > currentRSI_SMA ? 'RSI ABOVE SMA (Bullish)' : 'RSI BELOW SMA (Bearish)') : 'N/A'}
- TSI(13,8,8): ${currentTSI?.toFixed(2) || 'N/A'}
- TSI Signal(8): ${currentTSI_Signal?.toFixed(2) || 'N/A'}
- TSI vs Signal: ${currentTSI && currentTSI_Signal ? (currentTSI > currentTSI_Signal ? 'TSI ABOVE Signal (Bullish)' : 'TSI BELOW Signal (Bearish)') : 'N/A'}
- Avg Volume(20): ${avgVolume.toFixed(0)}
- Recent Volume(5): ${recentVolume.toFixed(0)}
- Volume Trend: ${recentVolume > avgVolume * 1.2 ? 'INCREASING' : recentVolume < avgVolume * 0.8 ? 'DECREASING' : 'STABLE'}

RECENT 50 CANDLES (OHLCV):
${JSON.stringify(recentCandles)}

Recent RSI(21) values (last 10): ${rsiValues.slice(-10).map(v => v?.toFixed(2)).join(', ')}
Recent TSI values (last 10): ${tsiData.tsi.slice(-10).map(v => v?.toFixed(2)).join(', ')}
Recent TSI Signal (last 10): ${tsiData.signal.slice(-10).map(v => v?.toFixed(2)).join(', ')}

Provide your analysis as JSON only.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return { statusCode: 200, headers, body: JSON.stringify({ error: `AI 분석 오류: ${response.status}`, detail: errText.substring(0, 300) }) };
    }

    const aiData = await response.json();
    const textContent = aiData.content?.find(c => c.type === 'text')?.text || '';

    // Parse JSON from response
    let analysis;
    try {
      const cleaned = textContent.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      analysis = JSON.parse(cleaned);
    } catch (parseErr) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'AI 응답 파싱 실패', raw: textContent.substring(0, 500) }) };
    }

    // Add pre-calculated indicator values
    analysis.calculatedIndicators = {
      rsi: currentRSI,
      rsiSMA: currentRSI_SMA,
      tsi: currentTSI,
      tsiSignal: currentTSI_Signal,
      avgVolume: avgVolume,
      recentVolume: recentVolume
    };

    return { statusCode: 200, headers, body: JSON.stringify(analysis) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류: ' + err.message }) };
  }
};
