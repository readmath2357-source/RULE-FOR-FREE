// netlify/functions/invite.js
// Manages invite codes: verify, create, delete, list, update
// Storage: Netlify environment variable INVITE_CODES_DB (JSON string)
// In production, use a proper DB. For MVP, we use in-memory + env fallback.

let codesDB = null;

function getDB() {
  if (codesDB) return codesDB;
  try {
    codesDB = JSON.parse(process.env.INVITE_CODES_DB || '{}');
  } catch {
    codesDB = {};
  }
  // Seed default codes if empty
  if (Object.keys(codesDB).length === 0) {
    codesDB = {
      "FREE-TRIAL-2025": {
        plan: "free",
        maxDaily: 5,
        expiresAt: "2026-12-31",
        usageToday: {},
        active: true
      },
      "STANDARD-DEMO": {
        plan: "standard",
        maxDaily: 20,
        expiresAt: "2026-12-31",
        usageToday: {},
        active: true
      },
      "PRO-UNLIMITED": {
        plan: "pro",
        maxDaily: -1,
        expiresAt: "2026-12-31",
        usageToday: {},
        active: true
      }
    };
  }
  return codesDB;
}

function todayKey() {
  return new Date().toISOString().split('T')[0];
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const body = JSON.parse(event.body || '{}');
  const action = body.action;
  const db = getDB();

  // --- VERIFY CODE ---
  if (action === 'verify') {
    const code = (body.code || '').trim().toUpperCase();
    const entry = db[code];
    if (!entry || !entry.active) {
      return { statusCode: 200, headers, body: JSON.stringify({ valid: false, error: '유효하지 않은 초대 코드입니다.' }) };
    }
    // Check expiry
    if (new Date(entry.expiresAt) < new Date()) {
      return { statusCode: 200, headers, body: JSON.stringify({ valid: false, error: '만료된 초대 코드입니다.' }) };
    }
    // Check daily usage
    const today = todayKey();
    const usedToday = entry.usageToday[today] || 0;
    if (entry.maxDaily > 0 && usedToday >= entry.maxDaily) {
      return { statusCode: 200, headers, body: JSON.stringify({ valid: false, error: `오늘 사용 횟수(${entry.maxDaily}회)를 초과했습니다.` }) };
    }
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        valid: true,
        plan: entry.plan,
        maxDaily: entry.maxDaily,
        usedToday: usedToday,
        remaining: entry.maxDaily > 0 ? entry.maxDaily - usedToday : '무제한'
      })
    };
  }

  // --- USE CODE (increment usage) ---
  if (action === 'use') {
    const code = (body.code || '').trim().toUpperCase();
    const entry = db[code];
    if (!entry || !entry.active) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: '유효하지 않은 코드' }) };
    }
    if (new Date(entry.expiresAt) < new Date()) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: '만료된 코드' }) };
    }
    const today = todayKey();
    const usedToday = entry.usageToday[today] || 0;
    if (entry.maxDaily > 0 && usedToday >= entry.maxDaily) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: '일일 사용 한도 초과' }) };
    }
    entry.usageToday[today] = usedToday + 1;
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        success: true,
        usedToday: entry.usageToday[today],
        remaining: entry.maxDaily > 0 ? entry.maxDaily - entry.usageToday[today] : '무제한'
      })
    };
  }

  // --- ADMIN: LIST ALL CODES ---
  if (action === 'admin_list') {
    if (body.password !== ADMIN_PASSWORD) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '관리자 인증 실패' }) };
    }
    const today = todayKey();
    const list = Object.entries(db).map(([code, info]) => ({
      code,
      plan: info.plan,
      maxDaily: info.maxDaily,
      expiresAt: info.expiresAt,
      active: info.active,
      usedToday: info.usageToday[today] || 0
    }));
    return { statusCode: 200, headers, body: JSON.stringify({ codes: list }) };
  }

  // --- ADMIN: CREATE CODE ---
  if (action === 'admin_create') {
    if (body.password !== ADMIN_PASSWORD) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '관리자 인증 실패' }) };
    }
    const newCode = (body.code || '').trim().toUpperCase();
    if (!newCode || newCode.length < 3) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '코드는 3자 이상이어야 합니다.' }) };
    }
    if (db[newCode]) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '이미 존재하는 코드입니다.' }) };
    }
    const plan = body.plan || 'standard';
    const maxDaily = plan === 'free' ? 5 : plan === 'standard' ? 20 : -1;
    db[newCode] = {
      plan,
      maxDaily: body.maxDaily !== undefined ? body.maxDaily : maxDaily,
      expiresAt: body.expiresAt || '2026-12-31',
      usageToday: {},
      active: true
    };
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, code: newCode }) };
  }

  // --- ADMIN: DELETE CODE ---
  if (action === 'admin_delete') {
    if (body.password !== ADMIN_PASSWORD) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '관리자 인증 실패' }) };
    }
    const code = (body.code || '').trim().toUpperCase();
    if (db[code]) {
      delete db[code];
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }
    return { statusCode: 404, headers, body: JSON.stringify({ error: '코드를 찾을 수 없습니다.' }) };
  }

  // --- ADMIN: UPDATE CODE ---
  if (action === 'admin_update') {
    if (body.password !== ADMIN_PASSWORD) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '관리자 인증 실패' }) };
    }
    const code = (body.code || '').trim().toUpperCase();
    if (!db[code]) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: '코드를 찾을 수 없습니다.' }) };
    }
    if (body.expiresAt) db[code].expiresAt = body.expiresAt;
    if (body.plan) {
      db[code].plan = body.plan;
      const maxDaily = body.plan === 'free' ? 5 : body.plan === 'standard' ? 20 : -1;
      db[code].maxDaily = body.maxDaily !== undefined ? body.maxDaily : maxDaily;
    }
    if (body.active !== undefined) db[code].active = body.active;
    if (body.maxDaily !== undefined) db[code].maxDaily = body.maxDaily;
    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
};
