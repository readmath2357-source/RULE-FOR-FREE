// netlify/functions/analyze.js
// Dual-mode analysis: simple (single entry) vs strategic (1st/2nd entries)
// TSI & RSI are PRIMARY indicators; Volume & ICT are SUPPLEMENTARY

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

// ── SYSTEM PROMPTS ──

const SYSTEM_BASE = `You are an expert technical analyst. You analyze price action using four indicators with CLEAR PRIORITY:

## PRIMARY INDICATORS (Entry Point Decision)

### 1. TSI (True Strength Index) — Parameters: (13, 8, 8) — PRIORITY 1
- TSI Line = 100 × EMA(EMA(price_change, 13), 8) / EMA(EMA(|price_change|, 13), 8)
- Signal Line = EMA(TSI, 8)
- TSI ABOVE signal → Bullish momentum | BELOW signal → Bearish
- TSI near +25 or above = strong bullish / near -25 or below = strong bearish
- TSI crossing zero = potential trend change
- TSI-Signal crossover is the PRIMARY entry trigger
- Divergence between TSI and price = high-probability reversal signal

### 2. RSI — Parameters: Length 21, SMA Length 21 — PRIORITY 2
- RSI(21) with SMA(RSI, 21) overlay
- RSI ABOVE SMA → Bullish | BELOW SMA → Bearish
- RSI > 70 = Overbought | RSI < 30 = Oversold
- RSI-SMA crossover confirms TSI signals
- RSI divergence adds conviction to entries

## SUPPLEMENTARY INDICATORS (Confirmation & Context)

### 3. VOLUME — SUPPLEMENTARY
- Rising volume with trend = continuation confirmation
- Declining volume = exhaustion warning
- Volume spikes at key levels = institutional activity
- Use volume to CONFIRM signals from TSI/RSI, not to generate them

### 4. ICT CONCEPTS — SUPPLEMENTARY
- Order Blocks (OB): institutional supply/demand zones
- Fair Value Gaps (FVG): imbalance zones price tends to fill
- Liquidity zones: stop-loss clusters (above swing highs, below swing lows)
- Break of Structure (BOS) / Change of Character (CHoCH)
- Premium/Discount zones (above/below 50% of swing range)
- Use ICT to REFINE entry/exit levels identified by TSI/RSI

## CONFLUENCE SCORING
Primary indicators (TSI + RSI) determine direction:
- Both agree = trade direction confirmed
- Only one signals = wait for confirmation or reduce size
Supplementary indicators (Volume + ICT) modify confidence:
- Both confirm = HIGH confidence
- One confirms = MODERATE confidence
- Neither confirms = LOW confidence

IMPORTANT:
- Entry, StopLoss, TakeProfit must be realistic based on actual data
- For LONG: entry < takeProfit, stopLoss < entry
- For SHORT: entry > takeProfit, stopLoss > entry
- All explanations in Korean
- Keep comments concise`;

const SIMPLE_PROMPT_SUFFIX = `

## OUTPUT FORMAT — SIMPLE MODE
Single entry/exit. Respond in valid JSON only, no markdown, no backticks:
{
  "mode": "simple",
  "direction": "LONG" or "SHORT" or "HOLD",
  "confidence": "HIGH" or "MODERATE" or "LOW",
  "entry": <number>,
  "stopLoss": <number>,
  "takeProfit": <number>,
  "riskReward": "<string like 1:2.5>",
  "comment": "<one-line Korean summary, under 80 chars>",
  "indicators": {
    "tsi": {"signal": "BULLISH"/"BEARISH"/"NEUTRAL", "value": <num>, "signalLine": <num>, "detail": "<Korean>"},
    "rsi": {"signal": "BULLISH"/"BEARISH"/"NEUTRAL", "value": <num>, "sma": <num>, "detail": "<Korean>"},
    "volume": {"signal": "BULLISH"/"BEARISH"/"NEUTRAL", "detail": "<Korean>"},
    "ict": {"signal": "BULLISH"/"BEARISH"/"NEUTRAL", "detail": "<Korean>", "patterns": ["OB","FVG","BOS"...]}
  },
  "ictOverlay": {
    "orderBlocks": [{"type":"bullish"/"bearish","high":<n>,"low":<n>,"index":<n>}],
    "fvg": [{"type":"bullish"/"bearish","high":<n>,"low":<n>,"index":<n>}],
    "liquidityZones": [{"price":<n>,"type":"buy_side"/"sell_side"}],
    "bos": [{"price":<n>,"type":"bullish"/"bearish","index":<n>}]
  }
}`;

const STRATEGIC_PROMPT_SUFFIX = `

## OUTPUT FORMAT — STRATEGIC MODE
Multi-stage entry (1st/2nd) based on indicator levels. Respond in valid JSON only:
{
  "mode": "strategic",
  "direction": "LONG" or "SHORT" or "HOLD",
  "confidence": "HIGH" or "MODERATE" or "LOW",
  "stages": [
    {
      "stage": 1,
      "label": "1차 진입",
      "trigger": "<Korean: what condition triggers this entry>",
      "entry": <number>,
      "stopLoss": <number>,
      "takeProfit": <number>,
      "positionSize": "50%",
      "riskReward": "<string>",
      "reason": "<Korean: why this level, referencing TSI/RSI primarily>"
    },
    {
      "stage": 2,
      "label": "2차 진입",
      "trigger": "<Korean: what condition triggers this entry>",
      "entry": <number>,
      "stopLoss": <number>,
      "takeProfit": <number>,
      "positionSize": "50%",
      "riskReward": "<string>",
      "reason": "<Korean: why this level>"
    }
  ],
  "exitStrategy": {
    "partialExit": "<Korean: when to take partial profit>",
    "fullExit": "<Korean: when to close entire position>",
    "trailingStop": "<Korean: trailing stop description if applicable>"
  },
  "comment": "<Korean summary of overall strategy, under 120 chars>",
  "indicators": {
    "tsi": {"signal":"BULLISH"/"BEARISH"/"NEUTRAL","value":<n>,"signalLine":<n>,"detail":"<Korean>"},
    "rsi": {"signal":"BULLISH"/"BEARISH"/"NEUTRAL","value":<n>,"sma":<n>,"detail":"<Korean>"},
    "volume": {"signal":"BULLISH"/"BEARISH"/"NEUTRAL","detail":"<Korean>"},
    "ict": {"signal":"BULLISH"/"BEARISH"/"NEUTRAL","detail":"<Korean>","patterns":["OB","FVG"...]}
  },
  "ictOverlay": {
    "orderBlocks": [{"type":"bullish"/"bearish","high":<n>,"low":<n>,"index":<n>}],
    "fvg": [{"type":"bullish"/"bearish","high":<n>,"low":<n>,"index":<n>}],
    "liquidityZones": [{"price":<n>,"type":"buy_side"/"sell_side"}],
    "bos": [{"price":<n>,"type":"bullish"/"bearish","index":<n>}]
  }
}

STRATEGIC MODE RULES:
- 1st entry: triggered by TSI signal line crossover or RSI-SMA crossover
- 2nd entry: triggered by price reaching ICT key level (OB, FVG, liquidity) with TSI/RSI confirmation
- If only 1 stage is appropriate (clear one-shot entry), still provide stage 2 as a "pullback re-entry" level
- Each stage's stopLoss should be based on ICT structure (below OB for long, above OB for short)
- Position sizing: 50% each stage (total = 100%)`;

// ── Indicator calculations ──
function calcRSI(closes, length = 21) {
  if (closes.length < length + 1) return [];
  const r = [];
  let gAvg = 0, lAvg = 0;
  for (let i = 1; i <= length; i++) {
    const ch = closes[i] - closes[i-1];
    if (ch > 0) gAvg += ch; else lAvg += Math.abs(ch);
  }
  gAvg /= length; lAvg /= length;
  for (let i = 0; i <= length; i++) r.push(null);
  r[length] = lAvg === 0 ? 100 : 100 - 100 / (1 + gAvg / lAvg);
  for (let i = length + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i-1];
    const g = ch > 0 ? ch : 0, l = ch < 0 ? Math.abs(ch) : 0;
    gAvg = (gAvg * (length-1) + g) / length;
    lAvg = (lAvg * (length-1) + l) / length;
    r.push(lAvg === 0 ? 100 : 100 - 100 / (1 + gAvg / lAvg));
  }
  return r;
}

function calcSMA(vals, len) {
  return vals.map((_, i) => {
    if (i < len - 1 || vals[i] === null) return null;
    let s = 0, c = 0;
    for (let j = i - len + 1; j <= i; j++) if (vals[j] !== null) { s += vals[j]; c++; }
    return c > 0 ? s / c : null;
  });
}

function calcEMA(vals, len) {
  const r = [], k = 2 / (len + 1);
  let prev = null;
  for (const v of vals) {
    if (v === null) { r.push(null); continue; }
    if (prev === null) { prev = v; r.push(v); continue; }
    prev = v * k + prev * (1 - k);
    r.push(prev);
  }
  return r;
}

function calcTSI(closes, long = 13, short = 8, sig = 8) {
  if (closes.length < long + short + 2) return { tsi: [], signal: [] };
  const ch = [null, ...closes.slice(1).map((c, i) => c - closes[i])];
  const absCh = ch.map(c => c === null ? null : Math.abs(c));
  const ds = calcEMA(calcEMA(ch, long), short);
  const ads = calcEMA(calcEMA(absCh, long), short);
  const tsi = ds.map((d, i) => d === null || ads[i] === null || ads[i] === 0 ? null : 100 * d / ads[i]);
  return { tsi, signal: calcEMA(tsi, sig) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
  if (!CLAUDE_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'API 키가 설정되지 않았습니다.' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    const { candles, symbol, timeframe, mode } = body;
    const isStrategic = mode === 'strategic';

    if (!candles || candles.length < 30) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '최소 30개 이상의 캔들이 필요합니다.' }) };
    }

    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const rsiValues = calcRSI(closes, 21);
    const rsiSMA = calcSMA(rsiValues, 21);
    const tsiData = calcTSI(closes, 13, 8, 8);
    const last = closes.length - 1;

    const recentCandles = candles.slice(-50).map((c, i) => ({
      idx: candles.length - 50 + i, t: c.time,
      o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume
    }));

    const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const recVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;

    const prompt = `Analyze this ${symbol} ${timeframe} chart. Mode: ${isStrategic ? 'STRATEGIC (multi-stage entry)' : 'SIMPLE (single entry)'}.

CURRENT PRIMARY INDICATORS:
- TSI(13,8,8): ${tsiData.tsi[last]?.toFixed(2) || 'N/A'}
- TSI Signal(8): ${tsiData.signal[last]?.toFixed(2) || 'N/A'}
- TSI vs Signal: ${tsiData.tsi[last] && tsiData.signal[last] ? (tsiData.tsi[last] > tsiData.signal[last] ? 'TSI ABOVE Signal (Bullish)' : 'TSI BELOW Signal (Bearish)') : 'N/A'}
- RSI(21): ${rsiValues[last]?.toFixed(2) || 'N/A'}
- RSI SMA(21): ${rsiSMA[last]?.toFixed(2) || 'N/A'}
- RSI vs SMA: ${rsiValues[last] && rsiSMA[last] ? (rsiValues[last] > rsiSMA[last] ? 'RSI ABOVE SMA (Bullish)' : 'RSI BELOW SMA (Bearish)') : 'N/A'}

SUPPLEMENTARY:
- Avg Volume(20): ${avgVol.toFixed(0)}
- Recent Volume(5): ${recVol.toFixed(0)}
- Volume Trend: ${recVol > avgVol * 1.2 ? 'INCREASING' : recVol < avgVol * 0.8 ? 'DECREASING' : 'STABLE'}

RECENT 50 CANDLES (OHLCV):
${JSON.stringify(recentCandles)}

Recent TSI (last 10): ${tsiData.tsi.slice(-10).map(v => v?.toFixed(2)).join(', ')}
Recent TSI Signal (last 10): ${tsiData.signal.slice(-10).map(v => v?.toFixed(2)).join(', ')}
Recent RSI (last 10): ${rsiValues.slice(-10).map(v => v?.toFixed(2)).join(', ')}

Respond as JSON only.`;

    const systemPrompt = SYSTEM_BASE + (isStrategic ? STRATEGIC_PROMPT_SUFFIX : SIMPLE_PROMPT_SUFFIX);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return { statusCode: 200, headers, body: JSON.stringify({ error: `AI 분석 오류: ${response.status}`, detail: errText.substring(0, 300) }) };
    }

    const aiData = await response.json();
    const textContent = aiData.content?.find(c => c.type === 'text')?.text || '';

    let analysis;
    try {
      const cleaned = textContent.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      analysis = JSON.parse(cleaned);
    } catch {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'AI 응답 파싱 실패', raw: textContent.substring(0, 500) }) };
    }

    analysis.calculatedIndicators = {
      rsi: rsiValues[last], rsiSMA: rsiSMA[last],
      tsi: tsiData.tsi[last], tsiSignal: tsiData.signal[last],
      avgVolume: avgVol, recentVolume: recVol
    };

    return { statusCode: 200, headers, body: JSON.stringify(analysis) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류: ' + err.message }) };
  }
};
