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

// คอลัมน์ที่เป็นข้อความ (กันเลข 0 นำหน้าในไอดีไลน์/ชื่อหาย) — นับจาก 1
const TEXT_COLS = { Staff: [1, 3, 4, 5, 6, 7], Calls: [1, 3, 4, 5, 6, 7], Responses: [1, 2, 3, 4, 5, 6] };

const SHEET = { STAFF: 'Staff', CALLS: 'Calls', RESP: 'Responses' };
const HEADERS = {
  Staff:     ['StaffID', 'RegisteredAt', 'FirstName', 'LastName', 'Nickname', 'Team', 'LineID', 'LastSeen'],
  Calls:     ['CallID', 'CreatedAt', 'Message', 'Detail', 'Priority', 'Target', 'Status', 'ClosedAt'],
  Responses: ['CallID', 'StaffID', 'FullName', 'Nickname', 'Team', 'LineID', 'RespondedAt']
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
    const acked = {};
    table_(SHEET.RESP).forEach(r => { if (r.StaffID === id) acked[r.CallID] = true; });
    const now = Date.now();
    const calls = table_(SHEET.CALLS)
      .filter(c => c.Status === 'active' && !acked[c.CallID] && now - ms_(c.CreatedAt) < CALL_MAX_AGE_MS)
      .filter(c => !c.Target || c.Target === 'ALL' || c.Target === me.Team)
      .map(callOut_);
    return { registered: true, calls: calls };
  },

  ack: (p) => {
    const id = clean_(p.staffId), callId = clean_(p.callId);
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
  },

  createCall: (p) => {
    requireCommander_(p);
    const msg = clean_(p.message);
    if (!msg) throw new Error('กรุณาระบุข้อความเรียก');
    return withLock_(() => {
      const id = 'C' + Date.now().toString(36).toUpperCase();
      sheet_(SHEET.CALLS).appendRow([id, new Date(), msg, clean_(p.detail), clean_(p.priority) || 'normal', clean_(p.target) || 'ALL', 'active', '']);
      bust_(SHEET.CALLS);
      return { callId: id };
    });
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
  if (def && ss.getSheets().length > 3 && def.getLastRow() === 0) ss.deleteSheet(def);
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
