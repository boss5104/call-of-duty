/**
 * Duty Call — Google Apps Script backend (เก็บข้อมูลใน Google Sheet)
 *
 * วิธีติดตั้ง (ดูรายละเอียดใน README.md):
 *  1) สร้าง Google Sheet ใหม่ → ส่วนขยาย (Extensions) → Apps Script
 *  2) วางโค้ดทั้งไฟล์นี้แทนที่โค้ดเดิม → บันทึก
 *  3) เลือกฟังก์ชัน setup → Run (อนุญาตสิทธิ์) เพื่อสร้างแท็บและหัวตาราง
 *  4) Deploy → New deployment → Web app
 *       Execute as: Me   |   Who has access: Anyone
 *  5) คัดลอก Web app URL (ลงท้าย /exec) ไปใส่ใน config.js (API_URL)
 */

const COMMANDER_USER = 'commander';
const COMMANDER_PIN  = '9999';
const CALL_MAX_AGE_MS = 12 * 60 * 60 * 1000; // การเรียกที่เก่ากว่า 12 ชม. จะไม่แจ้งเตือนแล้ว
const ONLINE_WINDOW_MS = 30 * 1000;

/* ----- แจ้งเตือนแบบ Push (เด้งขึ้นจอแม้ปิดแอป/ล็อกหน้าจอ) ----- */
const PUSH_SUBJECT     = 'https://boss5104.github.io/call-of-duty/'; // ลิงก์เว็บของระบบ (ใช้ระบุตัวตนกับบริการ push)
const REPUSH_EVERY_SEC = 20;  // ส่งแจ้งเตือนซ้ำทุก ๆ กี่วินาที จนกว่าจะกดตอบรับ
const REMIND_FOR_MIN   = 30;  // ส่งซ้ำนานสุดกี่นาทีต่อการเรียกหนึ่งครั้ง
const PUSH_TTL_SEC     = 1800; // ถ้าเครื่องไม่มีเน็ต บริการ push จะเก็บไว้ส่งให้เมื่อกลับมาออนไลน์ภายในกี่วินาที

// คอลัมน์ที่เป็นข้อความ (กันเลข 0 นำหน้าในไอดีไลน์/ชื่อหาย) — นับจาก 1
const TEXT_COLS = { Staff: [1, 3, 4, 5, 6, 7], Calls: [1, 3, 4, 5, 6, 7], Responses: [1, 2, 3, 4, 5, 6], Push: [1, 2, 4] };

const SHEET = { STAFF: 'Staff', CALLS: 'Calls', RESP: 'Responses', PUSH: 'Push' };
const HEADERS = {
  Staff:     ['StaffID', 'RegisteredAt', 'FirstName', 'LastName', 'Nickname', 'Team', 'LineID', 'LastSeen'],
  Calls:     ['CallID', 'CreatedAt', 'Message', 'Detail', 'Priority', 'Target', 'Status', 'ClosedAt'],
  Responses: ['CallID', 'StaffID', 'FullName', 'Nickname', 'Team', 'LineID', 'RespondedAt'],
  Push:      ['Endpoint', 'StaffID', 'UpdatedAt', 'Device']
};

/* ---------------- Entry points ---------------- */

function doGet(e) { return handle_(e && e.parameter ? e.parameter : {}); }

function doPost(e) {
  let p = {};
  try { p = JSON.parse(e.postData.contents); } catch (_) { p = (e && e.parameter) || {}; }
  return handle_(p);
}

function handle_(p) {
  let out;
  try {
    const fn = ROUTES[p.action];
    if (!fn) throw new Error('Unknown action');
    out = Object.assign({ ok: true }, fn(p) || {});
  } catch (err) {
    out = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

const ROUTES = {
  ping: () => ({ server: 'duty-call', time: Date.now() }),

  login: (p) => { requireCommander_(p); return {}; },

  register: (p) => {
    const f = {
      firstName: clean_(p.firstName), lastName: clean_(p.lastName), nickname: clean_(p.nickname),
      team: clean_(p.team), lineId: clean_(p.lineId)
    };
    Object.keys(f).forEach(k => { if (!f[k]) throw new Error('กรุณากรอกข้อมูลให้ครบทุกช่อง'); });
    return withLock_(() => {
      const sh = sheet_(SHEET.STAFF);
      const rows = table_(SHEET.STAFF);
      let id = clean_(p.staffId);
      const idx = id ? rows.findIndex(r => r.StaffID === id) : -1;
      const now = new Date();
      if (idx >= 0) {
        sh.getRange(idx + 2, 3, 1, 6).setValues([[f.firstName, f.lastName, f.nickname, f.team, f.lineId, now]]);
      } else {
        id = 'S' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1296).toString(36).toUpperCase();
        sh.appendRow([id, now, f.firstName, f.lastName, f.nickname, f.team, f.lineId, now]);
      }
      bust_(SHEET.STAFF);
      return { staffId: id };
    });
  },

  staffPoll: (p) => {
    const id = clean_(p.staffId);
    const me = table_(SHEET.STAFF).find(r => r.StaffID === id);
    if (!me) return { registered: false, calls: [] };
    touch_(id);
    return { registered: true, calls: pendingFor_(me).map(callOut_) };
  },

  ack: (p) => ackCall_(clean_(p.staffId), clean_(p.callId)),

  createCall: (p) => {
    requireCommander_(p);
    const msg = clean_(p.message);
    if (!msg) throw new Error('กรุณาระบุข้อความเรียก');
    const out = withLock_(() => {
      const id = 'C' + Date.now().toString(36).toUpperCase();
      sheet_(SHEET.CALLS).appendRow([id, new Date(), msg, clean_(p.detail), clean_(p.priority) || 'normal', clean_(p.target) || 'ALL', 'active', '']);
      bust_(SHEET.CALLS);
      return { callId: id };
    });
    // เด้งแจ้งเตือนไปทุกเครื่องทันที แล้วตั้งตัวส่งซ้ำทุก ~20 วินาทีจนกว่าจะตอบรับ
    let pushed = 0;
    try { pushed = pushPending_(); if (table_(SHEET.PUSH).length) ensureTicker_(); } catch (err) { console.error('push: ' + err); }
    return { callId: out.callId, pushed: pushed };
  },

  closeCall: (p) => {
    requireCommander_(p);
    return withLock_(() => {
      const rows = table_(SHEET.CALLS);
      const i = rows.findIndex(c => c.CallID === clean_(p.callId));
      if (i < 0) throw new Error('ไม่พบคำสั่งเรียก');
      sheet_(SHEET.CALLS).getRange(i + 2, 7, 1, 2).setValues([['closed', new Date()]]);
      bust_(SHEET.CALLS);
      return {};
    });
  },

  commanderPoll: (p) => {
    requireCommander_(p);
    const staffRows = table_(SHEET.STAFF);
    const seen = CacheService.getScriptCache().getAll(staffRows.map(r => 'seen_' + r.StaffID));
    const now = Date.now();
    const staff = staffRows.map(r => {
      const last = Number(seen['seen_' + r.StaffID]) || ms_(r.LastSeen);
      return {
        staffId: r.StaffID, firstName: r.FirstName, lastName: r.LastName, nickname: r.Nickname,
        team: r.Team, lineId: r.LineID, lastSeen: last, online: now - last < ONLINE_WINDOW_MS
      };
    });
    const resp = table_(SHEET.RESP);
    const calls = table_(SHEET.CALLS).slice(-30).reverse().map(c => {
      const o = callOut_(c);
      o.status = c.Status; o.closedAt = ms_(c.ClosedAt);
      o.responses = resp.filter(r => r.CallID === c.CallID).map(r => ({
        staffId: r.StaffID, fullName: r.FullName, nickname: r.Nickname, team: r.Team, lineId: r.LineID, at: ms_(r.RespondedAt)
      }));
      return o;
    });
    return { staff: staff, calls: calls, serverTime: now };
  },

  /* ----- Push ----- */
  pushKey: () => ({ key: vapid_().pub }),

  pushSub: (p) => {
    const id = clean_(p.staffId);
    let sub = p.sub;
    if (typeof sub === 'string') { try { sub = JSON.parse(sub); } catch (_) { sub = null; } }
    const ep = String((sub && sub.endpoint) || '').trim();
    if (!/^https:\/\/[^\s]+$/.test(ep) || ep.length > 1000) throw new Error('ข้อมูลการแจ้งเตือนไม่ถูกต้อง');
    if (!table_(SHEET.STAFF).some(r => r.StaffID === id)) throw new Error('ไม่พบข้อมูลผู้ลงทะเบียน');
    return withLock_(() => {
      const sh = sheet_(SHEET.PUSH);
      const rows = table_(SHEET.PUSH);
      const i = rows.findIndex(r => r.Endpoint === ep);
      const row = [ep, id, new Date(), clean_(p.device).slice(0, 120)];
      if (i >= 0) sh.getRange(i + 2, 1, 1, 4).setValues([row]); else sh.appendRow(row);
      bust_(SHEET.PUSH);
      return {};
    });
  },

  // service worker เรียกเมื่อได้รับ push: ขอรายการการเรียกที่ยังไม่ตอบรับของเครื่องนี้
  swPoll: (p) => {
    const me = staffByEndpoint_(p.endpoint);
    if (!me) return { registered: false, calls: [] };
    const cache = CacheService.getScriptCache(), tk = 'ptest_' + hash_(p.endpoint);
    const test = !!cache.get(tk);
    if (test) cache.remove(tk);
    return { registered: true, test: test, calls: pendingFor_(me).map(callOut_) };
  },

  // กด "รับทราบ" จากแจ้งเตือนบนหน้าจอโดยไม่ต้องเปิดแอป
  swAck: (p) => {
    const me = staffByEndpoint_(p.endpoint);
    if (!me) throw new Error('ไม่พบข้อมูลผู้ลงทะเบียน');
    return ackCall_(me.StaffID, clean_(p.callId));
  },

  // ทดสอบ: รอ 10 วินาที (ให้เวลาปิดแอป/ล็อกจอ) แล้วส่งแจ้งเตือนทดสอบไปเครื่องของคนนี้
  pushTest: (p) => {
    const id = clean_(p.staffId);
    const subs = table_(SHEET.PUSH).filter(r => r.StaffID === id);
    if (!subs.length) throw new Error('เครื่องนี้ยังไม่ได้เปิดการแจ้งเตือนแบบ push');
    const cache = CacheService.getScriptCache();
    subs.forEach(s => cache.put('ptest_' + hash_(s.Endpoint), '1', 120));
    Utilities.sleep(Math.min(15, Math.max(0, Number(p.delay) || 10)) * 1000);
    return { sent: sendPush_(subs.map(s => s.Endpoint)) };
  }
};

/* ---------------- Setup ---------------- */

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone('Asia/Bangkok');
  Object.keys(HEADERS).forEach(name => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    const h = HEADERS[name];
    sh.getRange(1, 1, 1, h.length).setValues([h])
      .setFontWeight('bold').setFontColor('#E8D29A').setBackground('#0B1020');
    sh.setFrozenRows(1);
    formatText_(sh, name);
    sh.autoResizeColumns(1, h.length);
  });
  const def = ss.getSheetByName('Sheet1') || ss.getSheetByName('ชีต1');
  if (def && ss.getSheets().length > 4 && def.getLastRow() === 0) ss.deleteSheet(def);
  vapid_(); // สร้างกุญแจสำหรับ push ครั้งแรก
  console.log('พร้อมใช้งาน · push public key: ' + vapid_().pub);
}

/* ---------------- Push: ส่งซ้ำจนกว่าจะตอบรับ ---------------- */

/** ทำงานทุก 1 นาทีขณะมีการเรียกที่ยังไม่มีคนตอบรับ: ส่ง push ซ้ำทุก REPUSH_EVERY_SEC วินาที */
function pushTick() {
  const start = Date.now();
  for (;;) {
    bust_(SHEET.CALLS); bust_(SHEET.RESP);
    const n = pushPending_();
    if (!n) { stopTicker_(); return; }
    if (Date.now() - start + REPUSH_EVERY_SEC * 1000 > 48000) return; // ต่อในรอบนาทีถัดไป
    Utilities.sleep(REPUSH_EVERY_SEC * 1000);
  }
}

/** ส่ง push ไปทุกเครื่องที่ยังมีการเรียกค้างตอบรับ (คืนจำนวนเครื่องที่ส่ง) */
function pushPending_() {
  const subs = table_(SHEET.PUSH);
  if (!subs.length) return 0;
  const staff = {};
  table_(SHEET.STAFF).forEach(r => { staff[r.StaffID] = r; });
  const calls = remindable_();
  if (!calls.length) return 0;
  const acked = ackedSet_();
  const eps = subs.filter(s => {
    const me = staff[s.StaffID];
    return me && calls.some(c => targets_(c, me) && !acked[c.CallID + '|' + me.StaffID]);
  }).map(s => s.Endpoint);
  return eps.length ? sendPush_(eps) : 0;
}

function ensureTicker_() {
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'pushTick')) {
    ScriptApp.newTrigger('pushTick').timeBased().everyMinutes(1).create();
  }
}

function stopTicker_() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'pushTick') ScriptApp.deleteTrigger(t); });
}

/** ส่ง Web Push แบบไม่มีเนื้อหา (service worker จะดึงรายละเอียดเอง) — ลบเครื่องที่ยกเลิกการแจ้งเตือนแล้วออก */
function sendPush_(endpoints) {
  const key = vapid_();
  const reqs = endpoints.map(ep => ({
    url: ep, method: 'post', muteHttpExceptions: true, followRedirects: false,
    headers: { TTL: String(PUSH_TTL_SEC), Urgency: 'high', Authorization: 'vapid t=' + vapidJwt_(ep, key) + ', k=' + key.pub }
  }));
  let res = [];
  try { res = UrlFetchApp.fetchAll(reqs); } catch (err) { console.error('push fetch: ' + err); return 0; }
  const gone = [];
  let ok = 0;
  res.forEach((r, i) => {
    const code = r.getResponseCode();
    if (code >= 200 && code < 300) ok++;
    else if (code === 404 || code === 410) gone.push(endpoints[i]);
    else console.warn('push ' + code + ': ' + r.getContentText().slice(0, 200));
  });
  if (gone.length) removeSubs_(gone);
  return ok;
}

function removeSubs_(eps) {
  withLock_(() => {
    const sh = sheet_(SHEET.PUSH);
    bust_(SHEET.PUSH);
    const rows = table_(SHEET.PUSH);
    for (let i = rows.length - 1; i >= 0; i--) if (eps.indexOf(rows[i].Endpoint) >= 0) sh.deleteRow(i + 2);
    bust_(SHEET.PUSH);
  });
}

/* ---------------- Helpers ---------------- */

function requireCommander_(p) {
  if (String(p.user || '').trim().toLowerCase() !== COMMANDER_USER || String(p.pin || '') !== COMMANDER_PIN) {
    throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }
}

function sheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    formatText_(sh, name);
  }
  return sh;
}

/** อ่านทั้งตารางเป็น array ของ object (แคช 3 วินาทีเพื่อลดภาระเมื่อมีการ poll ถี่) */
function table_(name) {
  const cache = CacheService.getScriptCache();
  const key = 'tbl_' + name;
  const hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (_) {} }
  const sh = sheet_(name);
  const h = HEADERS[name];
  const n = sh.getLastRow() - 1;
  const vals = n > 0 ? sh.getRange(2, 1, n, h.length).getValues() : [];
  const rows = vals.map(v => {
    const o = {};
    h.forEach((k, i) => { o[k] = v[i] instanceof Date ? v[i].getTime() : (typeof v[i] === 'string' ? v[i] : String(v[i])); });
    return o;
  });
  try { const s = JSON.stringify(rows); if (s.length < 90000) cache.put(key, s, 3); } catch (_) {}
  return rows;
}

function formatText_(sh, name) {
  (TEXT_COLS[name] || []).forEach(c => sh.getRange(2, c, sh.getMaxRows() - 1, 1).setNumberFormat('@'));
}

function bust_(name) { CacheService.getScriptCache().remove('tbl_' + name); }

function touch_(id) {
  const cache = CacheService.getScriptCache();
  const now = Date.now();
  cache.put('seen_' + id, String(now), 600);
  // บันทึก LastSeen ลงชีตทุก ๆ 5 นาที/คน เพื่อไม่ให้เขียนถี่เกินไป
  if (!cache.get('seenw_' + id)) {
    cache.put('seenw_' + id, '1', 300);
    const rows = table_(SHEET.STAFF);
    const i = rows.findIndex(r => r.StaffID === id);
    if (i >= 0) sheet_(SHEET.STAFF).getRange(i + 2, 8).setValue(new Date(now));
  }
}

function targets_(c, me) { return !c.Target || c.Target === 'ALL' || c.Target === me.Team; }

function ackedSet_() {
  const acked = {};
  table_(SHEET.RESP).forEach(r => { acked[r.CallID + '|' + r.StaffID] = true; });
  return acked;
}

/** การเรียกที่ยัง active และยังไม่ได้ตอบรับของคนนี้ */
function pendingFor_(me) {
  const acked = ackedSet_(), now = Date.now();
  return table_(SHEET.CALLS)
    .filter(c => c.Status === 'active' && !acked[c.CallID + '|' + me.StaffID] && now - ms_(c.CreatedAt) < CALL_MAX_AGE_MS)
    .filter(c => targets_(c, me));
}

/** การเรียกที่ยังอยู่ในช่วงส่งแจ้งเตือนซ้ำ */
function remindable_() {
  const now = Date.now();
  return table_(SHEET.CALLS).filter(c => c.Status === 'active' && now - ms_(c.CreatedAt) < REMIND_FOR_MIN * 60000);
}

function ackCall_(id, callId) {
  return withLock_(() => {
    const me = table_(SHEET.STAFF).find(r => r.StaffID === id);
    if (!me) throw new Error('ไม่พบข้อมูลผู้ลงทะเบียน');
    if (!table_(SHEET.CALLS).some(c => c.CallID === callId)) throw new Error('ไม่พบคำสั่งเรียก');
    if (!table_(SHEET.RESP).some(r => r.CallID === callId && r.StaffID === id)) {
      sheet_(SHEET.RESP).appendRow([callId, id, me.FirstName + ' ' + me.LastName, me.Nickname, me.Team, me.LineID, new Date()]);
      bust_(SHEET.RESP);
    }
    return {};
  });
}

function staffByEndpoint_(ep) {
  ep = String(ep || '').trim();
  if (!ep) return null;
  const sub = table_(SHEET.PUSH).find(r => r.Endpoint === ep);
  return sub ? table_(SHEET.STAFF).find(r => r.StaffID === sub.StaffID) || null : null;
}

function hash_(str) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(str), Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('').slice(0, 40);
}

function callOut_(c) {
  return { callId: c.CallID, createdAt: ms_(c.CreatedAt), message: c.Message, detail: c.Detail, priority: c.Priority, target: c.Target };
}

function ms_(v) {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  const t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}

function clean_(v) { return String(v == null ? '' : v).trim().slice(0, 300); }

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* =====================================================================
 * VAPID (RFC 8292): ลายเซ็น ES256 / ECDSA P-256 เขียนด้วย BigInt
 * (Apps Script ไม่มี ECDSA ในตัว) — กุญแจถูกสร้างครั้งเดียวและเก็บใน Script Properties
 * ===================================================================== */

const P256 = (() => {
  const H = s => BigInt('0x' + s);
  const P = H('ffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
  const N = H('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  const A = P - BigInt(3);
  const G = { x: H('6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'),
              y: H('4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5') };
  const ZERO = BigInt(0), ONE = BigInt(1), TWO = BigInt(2), THREE = BigInt(3), FOUR = BigInt(4), EIGHT = BigInt(8);
  const mod = (a, m) => { const r = a % m; return r < ZERO ? r + m : r; };
  const inv = (a, m) => {
    let r0 = mod(a, m), r1 = m, s0 = ONE, s1 = ZERO;
    while (r1 !== ZERO) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
    return mod(s0, m);
  };
  // พิกัดแบบ Jacobian เพื่อเลี่ยงการหาอินเวอร์สทุกขั้น
  const dbl = (p) => {
    if (!p || p.y === ZERO) return null;
    const { x, y, z } = p;
    const yy = mod(y * y, P), zz = mod(z * z, P);
    const s = mod(FOUR * x * yy, P);
    const m = mod(THREE * (x - zz) * (x + zz), P); // a = -3
    const x3 = mod(m * m - TWO * s, P);
    return { x: x3, y: mod(m * (s - x3) - EIGHT * yy * yy, P), z: mod(TWO * y * z, P) };
  };
  const add = (p, q) => {
    if (!p) return q; if (!q) return p;
    const z1z1 = mod(p.z * p.z, P), z2z2 = mod(q.z * q.z, P);
    const u1 = mod(p.x * z2z2, P), u2 = mod(q.x * z1z1, P);
    const s1 = mod(p.y * q.z * z2z2, P), s2 = mod(q.y * p.z * z1z1, P);
    if (u1 === u2) return s1 === s2 ? dbl(p) : null;
    const h = mod(u2 - u1, P), r = mod(s2 - s1, P);
    const hh = mod(h * h, P), hhh = mod(h * hh, P), v = mod(u1 * hh, P);
    const x3 = mod(r * r - hhh - TWO * v, P);
    return { x: x3, y: mod(r * (v - x3) - s1 * hhh, P), z: mod(p.z * q.z * h, P) };
  };
  const mul = (k) => {
    let R = null, Q = { x: G.x, y: G.y, z: ONE };
    while (k > ZERO) { if (k & ONE) R = add(R, Q); Q = dbl(Q); k >>= ONE; }
    if (!R) return null;
    const zi = inv(R.z, P), zi2 = mod(zi * zi, P);
    return { x: mod(R.x * zi2, P), y: mod(R.y * zi2 * zi, P) };
  };
  return { P, N, A, mod, inv, mul };
})();

function bytesToBig_(bytes) {
  return BigInt('0x' + (bytes.map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('') || '0'));
}

function bigToBytes_(x, len) {
  let h = x.toString(16);
  while (h.length < len * 2) h = '0' + h;
  const out = [];
  for (let i = 0; i < len; i++) { const v = parseInt(h.substr(i * 2, 2), 16); out.push(v > 127 ? v - 256 : v); }
  return out;
}

function b64u_(bytesOrString) { return Utilities.base64EncodeWebSafe(bytesOrString).replace(/=+$/, ''); }

/** สุ่มตัวเลข 1..N-1 จากแหล่งสุ่มของ Apps Script (+ ผูกกับข้อมูลที่ส่งมา) */
function randScalar_(seed) {
  const N = P256.N;
  for (let i = 0; i < 100; i++) {
    const noise = Utilities.newBlob(Utilities.getUuid() + Utilities.getUuid() + Date.now() + ':' + i + ':' + Math.random()).getBytes();
    const key = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, noise);
    const k = bytesToBig_(Utilities.computeHmacSha256Signature((seed || []).concat(noise), key));
    if (k > BigInt(0) && k < N) return k;
  }
  throw new Error('random failed');
}

/** กุญแจ VAPID ของระบบ: { d: BigInt, pub: base64url(65 bytes) } */
function vapid_() {
  if (vapid_.cached) return vapid_.cached;
  const props = PropertiesService.getScriptProperties();
  let d = props.getProperty('VAPID_D'), pub = props.getProperty('VAPID_PUB');
  if (!d || !pub) {
    const k = randScalar_([]);
    const Q = P256.mul(k);
    d = k.toString(16);
    pub = b64u_([4].concat(bigToBytes_(Q.x, 32), bigToBytes_(Q.y, 32)));
    props.setProperties({ VAPID_D: d, VAPID_PUB: pub });
  }
  vapid_.cached = { d: BigInt('0x' + d), pub: pub };
  return vapid_.cached;
}

function ecdsaSign_(msgBytes, d) {
  const N = P256.N;
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, msgBytes);
  const z = bytesToBig_(hash);
  for (;;) {
    const k = randScalar_(hash);
    const R = P256.mul(k);
    const r = P256.mod(R.x, N);
    if (r === BigInt(0)) continue;
    const s = P256.mod(P256.inv(k, N) * (z + r * d), N);
    if (s === BigInt(0)) continue;
    return bigToBytes_(r, 32).concat(bigToBytes_(s, 32));
  }
}

/** JWT สำหรับ origin ของบริการ push (แคชไว้ ~11 ชม.) */
function vapidJwt_(endpoint, key) {
  const aud = String(endpoint).match(/^https:\/\/[^/]+/)[0];
  vapidJwt_.mem = vapidJwt_.mem || {};
  if (vapidJwt_.mem[aud]) return vapidJwt_.mem[aud];
  const cache = CacheService.getScriptCache(), ck = 'vjwt_' + hash_(aud + key.pub);
  const hit = cache.get(ck);
  if (hit) return (vapidJwt_.mem[aud] = hit);
  const enc = o => b64u_(Utilities.newBlob(JSON.stringify(o)).getBytes());
  const input = enc({ typ: 'JWT', alg: 'ES256' }) + '.' +
    enc({ aud: aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: PUSH_SUBJECT });
  const jwt = input + '.' + b64u_(ecdsaSign_(Utilities.newBlob(input).getBytes(), key.d));
  cache.put(ck, jwt, 21600); // CacheService เก็บได้สูงสุด 6 ชม.
  return (vapidJwt_.mem[aud] = jwt);
}
