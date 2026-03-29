// netlify/functions/invite.js
// Persistent invite code management using Netlify Blobs
// Admin auth via HMAC session tokens (password never stored client-side after login)

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const TOKEN_SECRET = process.env.TOKEN_SECRET || ADMIN_PASSWORD + '_ts_secret';
const TOKEN_EXPIRY_MS = 12 * 60 * 60 * 1000; // 12 hours

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

// ── Token helpers ──
function generateToken() {
  const payload = JSON.stringify({
    exp: Date.now() + TOKEN_EXPIRY_MS,
    nonce: crypto.randomBytes(16).toString('hex')
  });
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64') + '.' + sig;
}

function verifyToken(token) {
  if (!token) return false;
  try {
    const [b64, sig] = token.split('.');
    const payload = Buffer.from(b64, 'base64').toString();
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
    if (sig !== expected) return false;
    const { exp } = JSON.parse(payload);
    return Date.now() < exp;
  } catch { return false; }
}

function verifyPassword(inputHash) {
  // Client sends SHA-256 hash of password; server compares
  const serverHash = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex');
  return inputHash === serverHash;
}

// ── Blob storage helpers ──
function getCodesStore() {
  return getStore({ name: 'invite-codes', consistency: 'strong' });
}

const DEFAULT_CODES = {
  "FREE-TRIAL-2025": { plan: "free", maxDaily: 5, expiresAt: "2026-12-31", active: true },
  "STANDARD-DEMO": { plan: "standard", maxDaily: 20, expiresAt: "2026-12-31", active: true },
  "PRO-UNLIMITED": { plan: "pro", maxDaily: -1, expiresAt: "2026-12-31", active: true }
};

async function loadCodes(store) {
  try {
    const raw = await store.get('all-codes');
    if (raw) return JSON.parse(raw);
  } catch {}
  // First run — seed defaults
  await store.set('all-codes', JSON.stringify(DEFAULT_CODES));
  return { ...DEFAULT_CODES };
}

async function saveCodes(store, codes) {
  await store.set('all-codes', JSON.stringify(codes));
}

// ── Usage tracking (separate blob per day) ──
async function getUsage(store, day) {
  try {
    const raw = await store.get(`usage:${day}`);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

async function setUsage(store, day, usage) {
  await store.set(`usage:${day}`, JSON.stringify(usage));
}

function todayKey() {
  return new Date().toISOString().split('T')[0];
}

// ── Handler ──
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const body = JSON.parse(event.body || '{}');
  const action = body.action;
  const store = getCodesStore();

  // ── VERIFY CODE ──
  if (action === 'verify') {
    const code = (body.code || '').trim().toUpperCase();
    const codes = await loadCodes(store);
    const entry = codes[code];
    if (!entry || !entry.active) {
      return { statusCode: 200, headers, body: JSON.stringify({ valid: false, error: '유효하지 않은 초대 코드입니다.' }) };
    }
    if (new Date(entry.expiresAt) < new Date()) {
      return { statusCode: 200, headers, body: JSON.stringify({ valid: false, error: '만료된 초대 코드입니다.' }) };
    }
    const today = todayKey();
    const usage = await getUsage(store, today);
    const usedToday = usage[code] || 0;
    if (entry.maxDaily > 0 && usedToday >= entry.maxDaily) {
      return { statusCode: 200, headers, body: JSON.stringify({ valid: false, error: `오늘 사용 횟수(${entry.maxDaily}회)를 초과했습니다.` }) };
    }
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        valid: true, plan: entry.plan,
        maxDaily: entry.maxDaily,
        usedToday,
        remaining: entry.maxDaily > 0 ? entry.maxDaily - usedToday : '무제한'
      })
    };
  }

  // ── USE CODE ──
  if (action === 'use') {
    const code = (body.code || '').trim().toUpperCase();
    const codes = await loadCodes(store);
    const entry = codes[code];
    if (!entry || !entry.active) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: '유효하지 않은 코드' }) };
    }
    if (new Date(entry.expiresAt) < new Date()) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: '만료된 코드' }) };
    }
    const today = todayKey();
    const usage = await getUsage(store, today);
    const usedToday = usage[code] || 0;
    if (entry.maxDaily > 0 && usedToday >= entry.maxDaily) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: '일일 사용 한도 초과' }) };
    }
    usage[code] = usedToday + 1;
    await setUsage(store, today, usage);
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        success: true,
        usedToday: usage[code],
        maxDaily: entry.maxDaily,
        remaining: entry.maxDaily > 0 ? entry.maxDaily - usage[code] : '무제한'
      })
    };
  }

  // ── ADMIN LOGIN (password → token exchange) ──
  if (action === 'admin_login') {
    const pwHash = body.passwordHash;
    if (!pwHash || !verifyPassword(pwHash)) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '관리자 인증 실패' }) };
    }
    const token = generateToken();
    return { statusCode: 200, headers, body: JSON.stringify({ token }) };
  }

  // ── ADMIN LIST ──
  if (action === 'admin_list') {
    if (!verifyToken(body.token)) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 만료 또는 실패. 다시 로그인하세요.' }) };
    }
    const codes = await loadCodes(store);
    const today = todayKey();
    const usage = await getUsage(store, today);
    const list = Object.entries(codes).map(([code, info]) => ({
      code, plan: info.plan, maxDaily: info.maxDaily,
      expiresAt: info.expiresAt, active: info.active,
      usedToday: usage[code] || 0
    }));
    return { statusCode: 200, headers, body: JSON.stringify({ codes: list }) };
  }

  // ── ADMIN CREATE ──
  if (action === 'admin_create') {
    if (!verifyToken(body.token)) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 만료' }) };
    }
    const codes = await loadCodes(store);
    const newCode = (body.code || '').trim().toUpperCase();
    if (!newCode || newCode.length < 3) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '코드는 3자 이상이어야 합니다.' }) };
    }
    if (codes[newCode]) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '이미 존재하는 코드입니다.' }) };
    }
    const plan = body.plan || 'standard';
    const defaultMax = plan === 'free' ? 5 : plan === 'standard' ? 20 : -1;
    codes[newCode] = {
      plan,
      maxDaily: body.maxDaily !== undefined ? body.maxDaily : defaultMax,
      expiresAt: body.expiresAt || '2026-12-31',
      active: true
    };
    await saveCodes(store, codes);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, code: newCode }) };
  }

  // ── ADMIN DELETE ──
  if (action === 'admin_delete') {
    if (!verifyToken(body.token)) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 만료' }) };
    }
    const codes = await loadCodes(store);
    const code = (body.code || '').trim().toUpperCase();
    if (!codes[code]) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: '코드를 찾을 수 없습니다.' }) };
    }
    delete codes[code];
    await saveCodes(store, codes);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  // ── ADMIN UPDATE ──
  if (action === 'admin_update') {
    if (!verifyToken(body.token)) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 만료' }) };
    }
    const codes = await loadCodes(store);
    const code = (body.code || '').trim().toUpperCase();
    if (!codes[code]) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: '코드를 찾을 수 없습니다.' }) };
    }
    if (body.expiresAt) codes[code].expiresAt = body.expiresAt;
    if (body.plan) {
      codes[code].plan = body.plan;
      const defaultMax = body.plan === 'free' ? 5 : body.plan === 'standard' ? 20 : -1;
      codes[code].maxDaily = body.maxDaily !== undefined ? body.maxDaily : defaultMax;
    }
    if (body.active !== undefined) codes[code].active = body.active;
    if (body.maxDaily !== undefined) codes[code].maxDaily = body.maxDaily;
    await saveCodes(store, codes);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
};
