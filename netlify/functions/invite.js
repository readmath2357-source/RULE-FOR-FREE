// netlify/functions/invite.js
// Persistent invite code management
// Storage: Netlify Blobs GLOBAL store (persists across deploys)
// Admin auth: HMAC session tokens

const crypto = require('crypto');

let blobsAvailable = true;
let getStore;
try {
  ({ getStore } = require('@netlify/blobs'));
} catch (e) {
  console.warn('[invite] @netlify/blobs not available, using in-memory only');
  blobsAvailable = false;
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
const TOKEN_SECRET = process.env.TOKEN_SECRET || ADMIN_PASSWORD + '_ts_secret';
const TOKEN_EXPIRY_MS = 12 * 60 * 60 * 1000;

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
  const serverHash = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex');
  return inputHash === serverHash;
}

// ── Default codes ──
const DEFAULT_CODES = {
  "FREE-TRIAL-2025": { plan: "free", maxDaily: 5, expiresAt: "2026-12-31", active: true },
  "STANDARD-DEMO": { plan: "standard", maxDaily: 20, expiresAt: "2026-12-31", active: true },
  "PRO-UNLIMITED": { plan: "pro", maxDaily: -1, expiresAt: "2026-12-31", active: true }
};

// ── In-memory fallback ──
let memoryDB = null;
let memoryUsage = {};

// ── Get GLOBAL blob store (persists across deploys) ──
function getGlobalStore() {
  const siteID = process.env.SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN;

  if (!siteID || !token) {
    console.warn('[invite] SITE_ID or NETLIFY_API_TOKEN missing — cannot use global Blobs');
    return null;
  }

  try {
    return getStore({
      name: 'invite-codes',
      siteID,
      token,
      consistency: 'strong'
    });
  } catch (err) {
    console.error('[invite] getStore error:', err.message);
    return null;
  }
}

// ── Storage abstraction ──
async function loadCodes() {
  if (blobsAvailable) {
    const store = getGlobalStore();
    if (store) {
      try {
        const raw = await store.get('all-codes', { type: 'text' });
        if (raw && typeof raw === 'string') {
          console.log('[invite] Loaded from global Blobs OK');
          const codes = JSON.parse(raw);
          memoryDB = codes;
          return codes;
        }
        // First run → seed defaults
        console.log('[invite] No blob data, seeding defaults to global store');
        await store.set('all-codes', JSON.stringify(DEFAULT_CODES));
        memoryDB = { ...DEFAULT_CODES };
        return memoryDB;
      } catch (err) {
        console.error('[invite] Blobs loadCodes error:', err.message || err);
      }
    }
  }
  // Fallback: in-memory
  if (!memoryDB) {
    console.log('[invite] Fallback to in-memory defaults');
    memoryDB = { ...DEFAULT_CODES };
  }
  return memoryDB;
}

async function saveCodes(codes) {
  memoryDB = codes;
  if (blobsAvailable) {
    const store = getGlobalStore();
    if (store) {
      try {
        await store.set('all-codes', JSON.stringify(codes));
        console.log('[invite] Saved to global Blobs OK');
        return 'blobs';
      } catch (err) {
        console.error('[invite] Blobs saveCodes error:', err.message || err);
      }
    }
  }
  return 'memory';
}

async function getUsage(day) {
  if (blobsAvailable) {
    const store = getGlobalStore();
    if (store) {
      try {
        const raw = await store.get(`usage:${day}`, { type: 'text' });
        if (raw && typeof raw === 'string') return JSON.parse(raw);
      } catch (err) {
        console.error('[invite] Blobs getUsage error:', err.message || err);
      }
    }
  }
  return memoryUsage[day] || {};
}

async function setUsage(day, usage) {
  memoryUsage[day] = usage;
  if (blobsAvailable) {
    const store = getGlobalStore();
    if (store) {
      try {
        await store.set(`usage:${day}`, JSON.stringify(usage));
      } catch (err) {
        console.error('[invite] Blobs setUsage error:', err.message || err);
      }
    }
  }
}

function todayKey() {
  return new Date().toISOString().split('T')[0];
}

function getStorageType() {
  if (!blobsAvailable) return 'memory';
  const siteID = process.env.SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN;
  if (!siteID || !token) return 'memory';
  return 'blobs';
}

// ── Handler ──
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const action = body.action;

  try {
    // ── VERIFY CODE ──
    if (action === 'verify') {
      const code = (body.code || '').trim().toUpperCase();
      const codes = await loadCodes();
      const entry = codes[code];
      if (!entry || !entry.active) {
        return { statusCode: 200, headers, body: JSON.stringify({ valid: false, error: '유효하지 않은 초대 코드입니다.' }) };
      }
      if (new Date(entry.expiresAt) < new Date()) {
        return { statusCode: 200, headers, body: JSON.stringify({ valid: false, error: '만료된 초대 코드입니다.' }) };
      }
      const today = todayKey();
      const usage = await getUsage(today);
      const usedToday = usage[code] || 0;
      if (entry.maxDaily > 0 && usedToday >= entry.maxDaily) {
        return { statusCode: 200, headers, body: JSON.stringify({ valid: false, error: `오늘 사용 횟수(${entry.maxDaily}회)를 초과했습니다.` }) };
      }
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          valid: true, plan: entry.plan, maxDaily: entry.maxDaily,
          usedToday, remaining: entry.maxDaily > 0 ? entry.maxDaily - usedToday : '무제한'
        })
      };
    }

    // ── USE CODE ──
    if (action === 'use') {
      const code = (body.code || '').trim().toUpperCase();
      const codes = await loadCodes();
      const entry = codes[code];
      if (!entry || !entry.active) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: '유효하지 않은 코드' }) };
      }
      if (new Date(entry.expiresAt) < new Date()) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: '만료된 코드' }) };
      }
      const today = todayKey();
      const usage = await getUsage(today);
      const usedToday = usage[code] || 0;
      if (entry.maxDaily > 0 && usedToday >= entry.maxDaily) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: '일일 사용 한도 초과' }) };
      }
      usage[code] = usedToday + 1;
      await setUsage(today, usage);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          success: true, usedToday: usage[code], maxDaily: entry.maxDaily,
          remaining: entry.maxDaily > 0 ? entry.maxDaily - usage[code] : '무제한'
        })
      };
    }

    // ── ADMIN LOGIN ──
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
      const codes = await loadCodes();
      const today = todayKey();
      const usage = await getUsage(today);
      const list = Object.entries(codes).map(([code, info]) => ({
        code, plan: info.plan, maxDaily: info.maxDaily,
        expiresAt: info.expiresAt, active: info.active,
        usedToday: usage[code] || 0
      }));
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          codes: list,
          storage: getStorageType(),
          totalCodes: list.length
        })
      };
    }

    // ── ADMIN CREATE ──
    if (action === 'admin_create') {
      if (!verifyToken(body.token)) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 만료' }) };
      }
      const codes = await loadCodes();
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
      const saved = await saveCodes(codes);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ success: true, code: newCode, storage: saved })
      };
    }

    // ── ADMIN DELETE ──
    if (action === 'admin_delete') {
      if (!verifyToken(body.token)) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 만료' }) };
      }
      const codes = await loadCodes();
      const code = (body.code || '').trim().toUpperCase();
      if (!codes[code]) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: '코드를 찾을 수 없습니다.' }) };
      }
      delete codes[code];
      await saveCodes(codes);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // ── ADMIN UPDATE ──
    if (action === 'admin_update') {
      if (!verifyToken(body.token)) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 만료' }) };
      }
      const codes = await loadCodes();
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
      await saveCodes(codes);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('[invite] Unhandled error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: '서버 오류: ' + err.message }) };
  }
};
