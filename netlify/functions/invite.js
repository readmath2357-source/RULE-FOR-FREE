// netlify/functions/invite.js
// Persistent invite code management
// Storage: Netlify Blobs (primary) → in-memory fallback
// Admin auth: HMAC session tokens
// Subscription model: feature-based (not just daily count)

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

// ── Plan feature definitions ──
const PLAN_FEATURES = {
  free: {
    label: '체험',
    maxDaily: 3,
    modes: ['simple'],                    // simple only
    timeframes: ['1d', '1wk'],            // daily & weekly only
    multiTF: false,
    priority: false
  },
  standard: {
    label: '스탠다드',
    maxDaily: -1,                         // unlimited
    modes: ['simple', 'strategic'],       // both modes
    timeframes: ['1m','5m','15m','1h','4h','1d','1wk'], // all
    multiTF: false,
    priority: false
  },
  pro: {
    label: '프로',
    maxDaily: -1,                         // unlimited
    modes: ['simple', 'strategic'],       // both modes
    timeframes: ['1m','5m','15m','1h','4h','1d','1wk'], // all
    multiTF: true,                        // multi-timeframe analysis
    priority: true                        // priority processing
  }
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
  "FREE-TRIAL-2025": { plan: "free", maxDaily: 3, expiresAt: "2026-12-31", active: true, createdAt: "2025-01-01" },
  "STANDARD-DEMO": { plan: "standard", maxDaily: -1, expiresAt: "2026-12-31", active: true, createdAt: "2025-01-01" },
  "PRO-UNLIMITED": { plan: "pro", maxDaily: -1, expiresAt: "2026-12-31", active: true, createdAt: "2025-01-01" }
};

// ── In-memory fallback ──
let memoryDB = null;
let memoryUsage = {};

// ── Storage abstraction with retry ──
function getStoreInstance() {
  if (!blobsAvailable) return null;
  try {
    return getStore({
      name: 'invite-codes',
      siteID: process.env.SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
      consistency: 'strong'
    });
  } catch (err) {
    console.error('[invite] getStore failed:', err.message);
    return null;
  }
}

async function loadCodes() {
  const store = getStoreInstance();
  if (store) {
    try {
      const raw = await store.get('all-codes', { type: 'text' });
      if (raw && typeof raw === 'string' && raw.length > 2) {
        const codes = JSON.parse(raw);
        memoryDB = codes; // sync memory cache
        console.log('[invite] Loaded from Blobs:', Object.keys(codes).length, 'codes');
        return codes;
      }
      // No data yet → seed defaults and persist
      console.log('[invite] No blob data, seeding defaults');
      await store.set('all-codes', JSON.stringify(DEFAULT_CODES));
      memoryDB = { ...DEFAULT_CODES };
      return memoryDB;
    } catch (err) {
      console.error('[invite] Blobs loadCodes error:', err.message || err);
      // Fall through to memory
    }
  }
  if (!memoryDB) {
    console.log('[invite] Using in-memory defaults');
    memoryDB = { ...DEFAULT_CODES };
  }
  return memoryDB;
}

async function saveCodes(codes) {
  memoryDB = codes; // always update memory
  const store = getStoreInstance();
  if (store) {
    try {
      const json = JSON.stringify(codes);
      await store.set('all-codes', json);
      // Verify write by reading back
      const verify = await store.get('all-codes', { type: 'text' });
      if (verify && verify.length > 2) {
        console.log('[invite] Saved & verified in Blobs:', Object.keys(codes).length, 'codes');
        return true;
      }
      console.warn('[invite] Blob write verification failed');
    } catch (err) {
      console.error('[invite] Blobs saveCodes error:', err.message || err);
    }
  }
  console.log('[invite] Saved to memory only');
  return false;
}

async function getUsage(day) {
  const store = getStoreInstance();
  if (store) {
    try {
      const raw = await store.get(`usage-${day}`, { type: 'text' });
      if (raw && typeof raw === 'string') {
        const usage = JSON.parse(raw);
        memoryUsage[day] = usage;
        return usage;
      }
    } catch (err) {
      console.error('[invite] Blobs getUsage error:', err.message || err);
    }
  }
  return memoryUsage[day] || {};
}

async function setUsage(day, usage) {
  memoryUsage[day] = usage;
  const store = getStoreInstance();
  if (store) {
    try {
      await store.set(`usage-${day}`, JSON.stringify(usage));
    } catch (err) {
      console.error('[invite] Blobs setUsage error:', err.message || err);
    }
  }
}

function todayKey() {
  return new Date().toISOString().split('T')[0];
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
      const maxDaily = entry.maxDaily > 0 ? entry.maxDaily : (PLAN_FEATURES[entry.plan]?.maxDaily || -1);
      if (maxDaily > 0 && usedToday >= maxDaily) {
        return { statusCode: 200, headers, body: JSON.stringify({ valid: false, error: `오늘 사용 횟수(${maxDaily}회)를 초과했습니다.` }) };
      }

      const features = PLAN_FEATURES[entry.plan] || PLAN_FEATURES.free;
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          valid: true,
          plan: entry.plan,
          maxDaily: maxDaily,
          usedToday,
          remaining: maxDaily > 0 ? maxDaily - usedToday : '무제한',
          features: {
            modes: features.modes,
            timeframes: features.timeframes,
            multiTF: features.multiTF,
            priority: features.priority
          }
        })
      };
    }

    // ── CHECK FEATURE ACCESS ──
    if (action === 'check_feature') {
      const code = (body.code || '').trim().toUpperCase();
      const codes = await loadCodes();
      const entry = codes[code];
      if (!entry || !entry.active) {
        return { statusCode: 200, headers, body: JSON.stringify({ allowed: false, error: '유효하지 않은 코드' }) };
      }
      const features = PLAN_FEATURES[entry.plan] || PLAN_FEATURES.free;
      const requestedMode = body.mode || 'simple';
      const requestedTF = body.timeframe || '1d';

      if (!features.modes.includes(requestedMode)) {
        return { statusCode: 200, headers, body: JSON.stringify({
          allowed: false,
          error: '이 기능은 스탠다드 이상 플랜에서 사용 가능합니다.',
          requiredPlan: 'standard'
        })};
      }
      if (!features.timeframes.includes(requestedTF)) {
        return { statusCode: 200, headers, body: JSON.stringify({
          allowed: false,
          error: `${requestedTF} 타임프레임은 스탠다드 이상 플랜에서 사용 가능합니다.`,
          requiredPlan: 'standard'
        })};
      }
      return { statusCode: 200, headers, body: JSON.stringify({ allowed: true }) };
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
      const maxDaily = entry.maxDaily > 0 ? entry.maxDaily : (PLAN_FEATURES[entry.plan]?.maxDaily || -1);
      if (maxDaily > 0 && usedToday >= maxDaily) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: '일일 사용 한도 초과' }) };
      }
      usage[code] = usedToday + 1;
      await setUsage(today, usage);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          success: true, usedToday: usage[code], maxDaily,
          remaining: maxDaily > 0 ? maxDaily - usage[code] : '무제한'
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
        usedToday: usage[code] || 0,
        createdAt: info.createdAt || '—'
      }));

      // Test blob connectivity
      let storageStatus = 'memory';
      const store = getStoreInstance();
      if (store) {
        try {
          await store.set('health-check', 'ok');
          const check = await store.get('health-check', { type: 'text' });
          if (check === 'ok') storageStatus = 'blobs';
        } catch { storageStatus = 'memory'; }
      }

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          codes: list,
          storage: storageStatus,
          totalCodes: list.length,
          planFeatures: PLAN_FEATURES
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
      const features = PLAN_FEATURES[plan] || PLAN_FEATURES.standard;
      codes[newCode] = {
        plan,
        maxDaily: body.maxDaily !== undefined ? body.maxDaily : features.maxDaily,
        expiresAt: body.expiresAt || '2026-12-31',
        active: true,
        createdAt: todayKey()
      };
      const saved = await saveCodes(codes);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ success: true, code: newCode, storage: saved ? 'blobs' : 'memory' })
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
        const features = PLAN_FEATURES[body.plan] || PLAN_FEATURES.standard;
        codes[code].maxDaily = body.maxDaily !== undefined ? body.maxDaily : features.maxDaily;
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
