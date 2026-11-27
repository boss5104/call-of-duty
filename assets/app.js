/* Call Of Duty Modern Warfare — ระบบเรียกปฏิบัติหน้าที่ (client) */
(() => {
  'use strict';

  const APP_VERSION = '2026.11.27-1531'; // ต้องตรงกับ version.json — อัปเดตด้วย tools/bump-version.sh
  const APP_CHANGES = 'เสียงเตือนดังขึ้น · สั่นแรงต่อเนื่อง · แจ้งเตือนดัง+สั่นใหม่ทุกครั้งที่ส่งซ้ำ (รวม iPhone)';
  const CFG = Object.assign({ API_URL: '', TEAMS: [], STAFF_POLL_MS: 4000, COMMANDER_POLL_MS: 3000 }, window.DUTY_CONFIG || {});
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} }
  };
  const sstore = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch (_) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
    del(k) { try { sessionStorage.removeItem(k); } catch (_) {} }
  };
  const params = new URLSearchParams(location.search);
  const UA = navigator.userAgent || '';

  /* ---------- เปิดจาก LINE → เด้งไปเบราว์เซอร์หลัก (ติดตั้งแอป/เสียงเตือนทำงานได้ดีกว่า) ---------- */
  if (/\bLine\//i.test(UA) && !params.has('openExternalBrowser')) {
    params.set('openExternalBrowser', '1');
    location.replace(location.pathname + '?' + params.toString() + location.hash);
    return;
  }

  /* ---------- API URL ---------- */
  if (params.get('api')) store.set('dc_api', params.get('api').trim());
  const API_URL = (store.get('dc_api') || CFG.API_URL || '').trim();
  const LIVE = /^https:\/\/script\.google(usercontent)?\.com\//.test(API_URL);

  /* ---------- Time helpers ---------- */
  const fmtTime = ms => ms ? new Date(ms).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–';
  const fmtDateTime = ms => ms ? new Date(ms).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–';
  const ago = ms => {
    if (!ms) return 'ยังไม่เคยออนไลน์';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + ' วินาทีที่แล้ว';
    if (s < 3600) return Math.floor(s / 60) + ' นาทีที่แล้ว';
    if (s < 86400) return Math.floor(s / 3600) + ' ชม.ที่แล้ว';
    return fmtDateTime(ms);
  };

  /* =====================================================================
   * Backend: Google Apps Script (live) หรือ localStorage (โหมดทดลอง)
   * ===================================================================== */
  const Remote = {
    async call(action, p = {}) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20000);
      try {
        const res = await fetch(API_URL, { method: 'POST', body: JSON.stringify(Object.assign({}, p, { action })), signal: ctl.signal, redirect: 'follow' });
        const j = await res.json();
        if (!j.ok) throw Object.assign(new Error(j.error || 'เกิดข้อผิดพลาด'), { server: true });
        return j;
      } catch (e) {
        if (e.server) throw e;
        if (e.name === 'AbortError') throw new Error('การเชื่อมต่อหมดเวลา กรุณาลองใหม่');
        throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ต');
      } finally { clearTimeout(t); }
    }
  };

  const Local = {
    key: 'dc_demo_db',
    db() { return store.get(this.key) || { staff: [], calls: [], resp: [], seen: {} }; },
    async call(action, p = {}) {
      await sleep(150);
      const d = this.db(), now = Date.now();
      const cmd = () => {
        if (String(p.user || '').trim().toLowerCase() !== 'commander' || String(p.pin || '') !== '9999') throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
      };
      const save = () => store.set(this.key, d);
      const callOut = c => ({ callId: c.callId, createdAt: c.createdAt, message: c.message, detail: c.detail, priority: c.priority, target: c.target });
      switch (action) {
        case 'login': cmd(); return { ok: true };
        case 'register': {
          const f = ['firstName', 'lastName', 'nickname', 'team', 'lineId'].reduce((o, k) => (o[k] = String(p[k] || '').trim(), o), {});
          if (Object.values(f).some(v => !v)) throw new Error('กรุณากรอกข้อมูลให้ครบทุกช่อง');
          let s = d.staff.find(x => x.staffId === p.staffId);
          if (s) Object.assign(s, f);
          else { s = Object.assign({ staffId: 'S' + now.toString(36).toUpperCase(), registeredAt: now }, f); d.staff.push(s); }
          d.seen[s.staffId] = now; save();
          return { ok: true, staffId: s.staffId };
        }
        case 'staffPoll': {
          const me = d.staff.find(x => x.staffId === p.staffId);
          if (!me) return { ok: true, registered: false, calls: [] };
          d.seen[me.staffId] = now; save();
          const acked = new Set(d.resp.filter(r => r.staffId === me.staffId).map(r => r.callId));
          const calls = d.calls.filter(c => c.status === 'active' && !acked.has(c.callId) && now - c.createdAt < 12 * 3600e3 &&
            (!c.target || c.target === 'ALL' || c.target === me.team)).map(callOut);
          return { ok: true, registered: true, calls };
        }
        case 'ack': {
          const me = d.staff.find(x => x.staffId === p.staffId);
          if (!me) throw new Error('ไม่พบข้อมูลผู้ลงทะเบียน');
          if (!d.resp.some(r => r.callId === p.callId && r.staffId === me.staffId)) {
            d.resp.push({ callId: p.callId, staffId: me.staffId, fullName: me.firstName + ' ' + me.lastName, nickname: me.nickname, team: me.team, lineId: me.lineId, at: now });
            save();
          }
          return { ok: true };
        }
        case 'createCall': {
          cmd();
          const c = { callId: 'C' + now.toString(36).toUpperCase(), createdAt: now, message: p.message, detail: p.detail || '', priority: p.priority || 'normal', target: p.target || 'ALL', status: 'active', closedAt: 0 };
          d.calls.push(c); save();
          return { ok: true, callId: c.callId };
        }
        case 'removeAllStaff': { cmd(); const n = d.staff.length; d.staff = []; save(); return { ok: true, removed: n }; }
        case 'closeAllCalls': { cmd(); let n = 0; d.calls.forEach(c => { if (c.status === 'active') { c.status = 'closed'; c.closedAt = now; n++; } }); save(); return { ok: true, closed: n }; }
        case 'clearHistory': {
          cmd();
          const keep = new Set(d.calls.filter(c => c.status === 'active').map(c => c.callId));
          const n = d.calls.length - keep.size;
          d.calls = d.calls.filter(c => keep.has(c.callId)); d.resp = d.resp.filter(r => keep.has(r.callId)); save();
          return { ok: true, removed: n };
        }
        case 'removeStaff': {
          cmd();
          d.staff = d.staff.filter(x => x.staffId !== p.staffId); save();
          return { ok: true };
        }
        case 'closeCall': {
          cmd();
          const c = d.calls.find(x => x.callId === p.callId);
          if (c) { c.status = 'closed'; c.closedAt = now; save(); }
          return { ok: true };
        }
        case 'commanderPoll': {
          cmd();
          const staff = d.staff.map(s => Object.assign({}, s, { lastSeen: d.seen[s.staffId] || 0, online: now - (d.seen[s.staffId] || 0) < 30000 }));
          const calls = d.calls.slice(-30).reverse().map(c => Object.assign(callOut(c), {
            status: c.status, closedAt: c.closedAt, responses: d.resp.filter(r => r.callId === c.callId)
          }));
          return { ok: true, staff, calls, serverTime: now };
        }
      }
      throw new Error('Unknown action');
    }
  };

  const API = LIVE ? Remote : Local;

  /* =====================================================================
   * Sound / vibration / notifications / wake lock
   * ===================================================================== */
  /* ---------- รายการเสียงเตือน (สังเคราะห์ในเครื่อง ยกเว้น Hell March 2 ที่เป็นไฟล์) ---------- */
  const TONES = [
    { id: 'hellmarch', icon: '🎖️', name: 'Hell March 2', desc: 'เพลงมาร์ชสุดโหด' },
    { id: 'mega', icon: '💥', name: 'ปลุกตายยาก', desc: 'ไซเรน + บี๊บ + แตร + กลอง รวมกัน' },
    { id: 'airraid', icon: '🚨', name: 'ไซเรนภัยทางอากาศ', desc: 'หวอยาว ดังลั่น' },
    { id: 'yelp', icon: '🚓', name: 'ไซเรนรถฉุกเฉิน', desc: 'หวีดถี่ เร่งเร้า' },
    { id: 'klaxon', icon: '⚓', name: 'แตรสถานีรบ', desc: 'อู้ก้า! แบบเรือรบ' },
    { id: 'smoke', icon: '🔥', name: 'สัญญาณไฟไหม้', desc: 'บี๊บแหลม 3 จังหวะ' },
    { id: 'digital', icon: '⏰', name: 'นาฬิกาปลุกดิจิทัล', desc: 'บี๊บ ๆ ถี่ แหลมสูง' },
    { id: 'bell', icon: '🔔', name: 'กระดิ่งนาฬิกาปลุก', desc: 'กริ๊งรัวแบบโบราณ' },
    { id: 'bugle', icon: '🎺', name: 'แตรเรียกพล', desc: 'แตรทหาร ปลุกเข้าแถว' },
    { id: 'march', icon: '🥁', name: 'มาร์ชทหาร', desc: 'กลองศึก + ไซเรน' }
  ];

  /* priority เก็บเสียงที่ผู้บังคับบัญชาเลือกไว้ด้วย เช่น "critical;sound=airraid" (ไม่ต้องแก้ Google Sheet) */
  const parsePrio = s => {
    const [level, ...kv] = String(s || '').split(';');
    const o = { level: level || 'normal', sound: '' };
    kv.forEach(x => { const i = x.indexOf('='); if (i > 0) o[x.slice(0, i)] = x.slice(i + 1); });
    if (!TONES.some(t => t.id === o.sound)) o.sound = '';
    return o;
  };
  const toneName = id => (TONES.find(t => t.id === id) || {}).name || '';

  const Sound = {
    ctx: null, out: null, boost: null, timer: null, vibTimer: null, src: null, noise: null,
    playing: null, nextAt: 0, pvTimer: null,
    fileBuf: null, fileState: 'idle', // idle | loading | ok | none

    selected: 'hellmarch', // เสียงตั้งต้น เมื่อการเรียกไม่ได้ระบุเสียง

    unlock() {
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) {} // iOS: ดังแม้เปิดโหมดเงียบ
      try {
        // iOS รุ่นเก่า: เล่นเสียงเงียบผ่าน <audio> ให้ระบบใช้ช่องเสียง "สื่อ" (ไม่ถูกสวิตช์ปิดเสียงตัด)
        if (!this.keepAlive && /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document) {
          const a = this.keepAlive = new Audio('data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA');
          a.loop = true; a.setAttribute('playsinline', ''); a.volume = 0.01;
        }
        const pr = this.keepAlive && this.keepAlive.play(); if (pr && pr.catch) pr.catch(() => {});
      } catch (_) {}
      try {
        if (!this.ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return false;
          this.ctx = new AC();
          this.buildChain();
        }
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const b = this.ctx.createBuffer(1, 1, 22050), s = this.ctx.createBufferSource();
        s.buffer = b; s.connect(this.ctx.destination); s.start(0);
        this.loadFile();
        return true;
      } catch (_) { return false; }
    },

    /* ขยายเสียง → ลิมิตเตอร์ → soft clip: ดังที่สุดเท่าที่เบราว์เซอร์ส่งออกได้ */
    buildChain() {
      const c = this.ctx;
      this.boost = c.createGain();
      this.boost.gain.value = Math.min(8, Math.max(1, Number(CFG.ALARM_BOOST) || 6));
      const lim = c.createDynamicsCompressor();
      lim.threshold.value = -24; lim.knee.value = 0; lim.ratio.value = 20;
      lim.attack.value = 0.001; lim.release.value = 0.05;
      const makeup = c.createGain();
      makeup.gain.value = 3.2; // ดันเสียงเฉลี่ยให้ชนเพดาน → ดังเต็มที่ตลอดเวลา
      const clip = c.createWaveShaper();
      const n = 2048, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; curve[i] = Math.tanh(2.2 * x) / Math.tanh(2.2); }
      clip.curve = curve;
      this.boost.connect(lim); lim.connect(makeup); makeup.connect(clip); clip.connect(c.destination);
      this.out = this.boost;
    },

    loadFile() {
      if (this.fileState !== 'idle' || !CFG.ALARM_URL || !this.ctx) return;
      this.fileState = 'loading';
      fetch(CFG.ALARM_URL, { cache: 'no-cache' })
        .then(r => { if (!r.ok) throw 0; return r.arrayBuffer(); })
        .then(ab => new Promise((res, rej) => { const p = this.ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); }))
        .then(buf => {
          this.fileBuf = buf; this.fileState = 'ok';
          if (this.playing === 'hellmarch') { this.stopLoops(); this.play('hellmarch'); } // สลับจากเสียงสำรองเป็นเพลงทันที
        })
        .catch(() => { this.fileState = 'none'; });
    },

    get ready() { return !!this.ctx && this.ctx.state === 'running'; },

    /* ---------- building blocks ---------- */
    env(g, at, dur, vol, attack = .01) {
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(vol, at + attack);
      g.gain.setValueAtTime(vol, Math.max(at + attack, at + dur - .02));
      g.gain.linearRampToValueAtTime(0, at + dur);
    },
    tone(freq, at, dur, type = 'sine', vol = .2) {
      const c = this.ctx; if (!c) return;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, at);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(vol, at + .01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g); g.connect(this.out || c.destination);
      o.start(at); o.stop(at + dur + .05);
    },
    beep(freq, at, dur, vol = .45, type = 'square') {
      const c = this.ctx, o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, at);
      this.env(g, at, dur, vol, .004);
      o.connect(g); g.connect(this.out); o.start(at); o.stop(at + dur + .02);
    },
    /* osc ที่ไล่ความถี่ตามจุด [[เวลา, ความถี่], ...] */
    sweep(points, at, vol, types = ['sawtooth', 'square'], detune = 1.006) {
      const c = this.ctx, end = points[points.length - 1][0];
      types.forEach((type, k) => {
        const o = c.createOscillator(), g = c.createGain(), m = k ? detune : 1;
        o.type = type;
        o.frequency.setValueAtTime(points[0][1] * m, at);
        for (let i = 1; i < points.length; i++) o.frequency.linearRampToValueAtTime(points[i][1] * m, at + points[i][0]);
        this.env(g, at, end, vol / (k + 1), .02);
        o.connect(g); g.connect(this.out); o.start(at); o.stop(at + end + .02);
      });
    },
    kick(at, vol = 1) {
      const c = this.ctx, o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(160, at); o.frequency.exponentialRampToValueAtTime(42, at + .18);
      g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.001, at + .32);
      o.connect(g); g.connect(this.out); o.start(at); o.stop(at + .35);
    },
    snare(at, vol = .8) {
      const c = this.ctx;
      if (!this.noise) {
        this.noise = c.createBuffer(1, c.sampleRate * .3, c.sampleRate);
        const d = this.noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      const s = c.createBufferSource(), hp = c.createBiquadFilter(), g = c.createGain();
      s.buffer = this.noise; hp.type = 'highpass'; hp.frequency.value = 1400;
      g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.001, at + .16);
      s.connect(hp); hp.connect(g); g.connect(this.out); s.start(at); s.stop(at + .2);
      this.tone(190, at, .08, 'triangle', .5);
    },
    strike(at, partials, vol, decay = .09) {
      const c = this.ctx;
      partials.forEach(([f, a]) => {
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'sine'; o.frequency.setValueAtTime(f, at);
        g.gain.setValueAtTime(vol * a, at); g.gain.exponentialRampToValueAtTime(0.0005, at + decay);
        o.connect(g); g.connect(this.out); o.start(at); o.stop(at + decay + .02);
      });
    },
    horn(freq, at, dur, vol = .45) {
      const c = this.ctx, lp = c.createBiquadFilter(), lfo = c.createOscillator(), lg = c.createGain();
      lp.type = 'lowpass'; lp.frequency.value = 3200; lp.connect(this.out);
      lfo.frequency.value = 5.5; lg.gain.value = freq * .008; lfo.connect(lg);
      ['sawtooth', 'square'].forEach((type, k) => {
        const o = c.createOscillator(), g = c.createGain();
        o.type = type; o.frequency.setValueAtTime(freq, at); lg.connect(o.frequency);
        this.env(g, at, dur, vol / (k + 1.5), .03);
        o.connect(g); g.connect(lp); o.start(at); o.stop(at + dur + .02);
      });
      lfo.start(at); lfo.stop(at + dur + .02);
    },

    /* ---------- patterns: แต่ละอันเล่น 1 รอบเริ่มที่เวลา t แล้วคืนความยาว (วินาที) ---------- */
    patterns: {
      airraid(t) { this.sweep([[0, 280], [1.4, 1080], [2.0, 1080], [3.4, 280]], t, .5); return 3.4; },
      yelp(t) { for (let i = 0; i < 12; i++) this.sweep([[0, 650], [.15, 1550], [.16, 1550]], t + i * .16, .45); return 1.92; },
      klaxon(t) {
        for (let k = 0; k < 2; k++) {
          const a = t + k * .7;
          this.sweep([[0, 140], [.12, 320], [.5, 320]], a, .55, ['sawtooth', 'square', 'sawtooth'], 1.012);
          this.sweep([[0, 70], [.12, 160], [.5, 160]], a, .4, ['sawtooth']);
        }
        return 1.4;
      },
      smoke(t) { for (let i = 0; i < 3; i++) { this.beep(3150, t + i * 1, .5, .55); this.beep(3165, t + i * 1, .5, .25, 'sawtooth'); } return 3.5; },
      digital(t) {
        for (let g = 0; g < 2; g++) for (let i = 0; i < 4; i++) this.beep(2900, t + g * .78 + i * .13, .075, .6);
        return 1.56;
      },
      bell(t) {
        const P = [[2350, 1], [3420, .6], [5020, .4], [1180, .35]];
        for (let i = 0; i < 40; i++) this.strike(t + i / 22, P, .55);
        return 2.2;
      },
      bugle(t) {
        const G4 = 392, C5 = 523.25, E5 = 659.25, G5 = 783.99;
        const tune = [[G4, .18], [G4, .18], [C5, .36], [E5, .36], [G5, .18], [E5, .18], [C5, .36], [G4, .36],
          [C5, .18], [E5, .18], [G5, .54], [G5, .18], [G5, .72]];
        let a = t;
        tune.forEach(([f, d]) => { this.horn(f, a, d - .03, .55); a += d; });
        return a - t + .35;
      },
      march(t) {
        const q = 60 / 132;
        const Dm = [146.8, 174.6, 220], Bb = [116.5, 146.8, 174.6], C = [130.8, 164.8, 196], A = [110, 138.6, 164.8];
        const stab = (n, at, d = .22) => n.forEach(f => { this.tone(f, at, d, 'sawtooth', .32); this.tone(f * 1.006, at, d, 'square', .16); });
        for (let i = 0; i < 4; i++) this.kick(t + i * q);
        this.kick(t + 3.5 * q);
        this.snare(t + q); this.snare(t + 3 * q);
        [3.25, 3.5, 3.75].forEach(b => this.snare(t + b * q, .5));
        stab(Dm, t); stab(Dm, t + .75 * q, .14); stab(Bb, t + 1.5 * q);
        stab(C, t + 2 * q); stab(A, t + 2.75 * q, .14); stab(Dm, t + 3 * q, .4);
        for (let i = 0; i < 8; i++) this.tone(i % 2 ? 880 : 1174.7, t + i * q / 2, q / 2 - .03, 'square', .22);
        return q * 4;
      },
      mega(t) {
        for (let i = 0; i < 8; i++) this.sweep([[0, 700], [.15, 1600], [.16, 1600]], t + i * .16, .35);
        this.sweep([[0, 140], [.12, 320], [.55, 320]], t + 1.35, .5, ['sawtooth', 'square', 'sawtooth'], 1.012);
        this.sweep([[0, 140], [.12, 320], [.55, 320]], t + 2.05, .5, ['sawtooth', 'square', 'sawtooth'], 1.012);
        for (let i = 0; i < 6; i++) this.kick(t + i * .45, 1);
        for (let i = 0; i < 12; i++) this.beep(3000, t + i * .23, .08, .35);
        return 2.7;
      }
    },

    /* ---------- playback ---------- */
    play(id) {
      this.unlock();
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this.playing = id;
      if (id === 'hellmarch' && this.fileBuf) {
        const s = this.ctx.createBufferSource();
        s.buffer = this.fileBuf; s.loop = true; s.connect(this.out); s.start();
        this.src = s;
        this.timer = setInterval(() => { if (this.ctx.state === 'suspended') this.ctx.resume(); }, 1000);
        return;
      }
      // Hell March ยังโหลดไม่เสร็จ/ไม่มีไฟล์ → ใช้มาร์ชสังเคราะห์ระหว่างรอ
      const fn = this.patterns[id] || this.patterns.march;
      this.nextAt = this.ctx.currentTime + .05;
      const tick = () => {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        if (this.nextAt < this.ctx.currentTime) this.nextAt = this.ctx.currentTime + .05;
        while (this.nextAt < this.ctx.currentTime + 1.5) this.nextAt += fn.call(this, this.nextAt);
      };
      tick();
      this.timer = setInterval(tick, 250);
    },

    startAlarm(id) {
      if (!this.timer && !this.src) this.play(id || this.selected);
      if (!this.vibTimer && 'vibrate' in navigator) {
        // สั่นแรงต่อเนื่องจนกว่าจะกดตอบรับ (Android) — iPhone ไม่รองรับการสั่นผ่านเว็บ
        const v = () => { try { navigator.vibrate([1800, 120, 1800, 120]); } catch (_) {} };
        v(); this.vibTimer = setInterval(v, 3800);
      }
    },

    /* ฟังตัวอย่าง 4 วินาที (ถ้ามีการเรียกค้างอยู่ จะกลับไปเล่นเสียงเตือนต่อ) */
    preview(id, onEnd) {
      clearTimeout(this.pvTimer);
      this.stopLoops();
      this.play(id);
      this.previewing = true;
      this.pvTimer = setTimeout(() => { this.previewing = false; this.stopLoops(); onEnd && onEnd(); }, 4000);
    },

    stopLoops() {
      clearInterval(this.timer); this.timer = null; this.playing = null;
      if (this.src) { try { this.src.stop(); } catch (_) {} this.src.disconnect(); this.src = null; }
      if (this.out) { // ตัดเสียงที่ตั้งเวลาไว้ล่วงหน้าทันที
        const c = this.ctx, g = this.boost.gain, v = g.value;
        g.cancelScheduledValues(c.currentTime); g.setValueAtTime(0, c.currentTime);
        const old = this.boost;
        this.buildChain();
        setTimeout(() => { try { old.disconnect(); } catch (_) {} }, 1600);
        this.boost.gain.value = v;
      }
    },
    stopAlarm() {
      clearTimeout(this.pvTimer); this.previewing = false;
      this.stopLoops();
      clearInterval(this.vibTimer); this.vibTimer = null;
      try { navigator.vibrate && navigator.vibrate(0); } catch (_) {}
    },
    chime() {
      if (!this.ctx || this.ctx.state !== 'running') return;
      const t = this.ctx.currentTime + .02;
      this.tone(880, t, .35, 'sine', .3);
      this.tone(1318.5, t + .14, .5, 'sine', .28);
    }
  };
  document.addEventListener('pointerdown', () => Sound.unlock(), { passive: true });

  let swReg = null;
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').then(r => { swReg = r; }).catch(() => {});
    // ข้อความจาก service worker: ได้รับ push / กดรับทราบจากแจ้งเตือนแล้ว
    navigator.serviceWorker.addEventListener('message', e => {
      const m = e.data || {};
      if (m.type === 'reload') {
        try { e.source && e.source.postMessage({ type: 'hello' }); } catch (_) {} // บอก SW ว่าหน้านี้รีเฟรชเองได้
        Updater.check(); return;
      }
      if (m.type === 'acked' && m.callId) {
        Staff.acked.add(m.callId);
        Staff.queue = Staff.queue.filter(c => c.callId !== m.callId);
        if (Staff.queue.length) { Staff.showing = null; Staff.ring(); } else Staff.hideAlarm();
      }
      if (Staff.active) Staff.poll();
    });
  }
  // ให้ service worker รู้ว่าเซิร์ฟเวอร์อยู่ที่ไหน (ใช้ตอนได้รับ push ขณะปิดแอป)
  function saveSwCfg(extra) {
    if (!window.caches || !LIVE) return;
    const cfg = Object.assign({ api: API_URL, key: store.get('dc_push_key') || '' }, extra || {});
    caches.open('dc-cfg').then(c => c.put('./__dc_cfg', new Response(JSON.stringify(cfg), { headers: { 'Content-Type': 'application/json' } }))).catch(() => {});
  }
  saveSwCfg();

  const Notify = {
    supported: 'Notification' in window,
    get granted() { return this.supported && Notification.permission === 'granted'; },
    async request() {
      if (!this.supported) return false;
      if (Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (_) {} }
      return this.granted;
    },
    async show(title, body, tag, urgent) {
      if (!this.granted) return;
      const opt = { body, tag, renotify: true, requireInteraction: !!urgent, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', vibrate: urgent ? [1000, 200, 1000, 200, 1000, 200, 1000, 200, 1000] : [200] };
      if (urgent && /^call-/.test(tag)) {
        opt.data = { callId: tag.slice(5), message: title.replace(/^🚨\s*/, ''), detail: body };
        opt.actions = [{ action: 'ack', title: '✅ รับทราบ / ตอบรับ' }, { action: 'open', title: '🔊 เปิดแอป' }];
      }
      try {
        const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.getRegistration());
        if (reg) return reg.showNotification(title, opt);
        new Notification(title, opt);
      } catch (_) {}
    },
    /** ลบแจ้งเตือนการเรียกเก่าที่ไม่ต้องตอบรับแล้วออกจากถาดแจ้งเตือน */
    async clearStale(liveIds) {
      try {
        const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.getRegistration());
        if (reg) (await reg.getNotifications()).forEach(n => { const id = notifCallId(n); if (id && !liveIds.has(id)) n.close(); });
      } catch (_) {}
    },
    async clear(tag) {
      try {
        const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.getRegistration());
        const id = /^call-/.test(tag) ? tag.slice(5) : null;
        if (reg) (await reg.getNotifications()).forEach(n => { if (n.tag === tag || (id && notifCallId(n) === id)) n.close(); });
      } catch (_) {}
    }
  };
  function notifCallId(n) { return (n.data && n.data.callId) || (/^call-([^~]+)/.exec(n.tag || '') || [])[1] || ''; }

  /* ---------- Web Push: เด้งแจ้งเตือนขึ้นจอแม้ปิดแอป/ล็อกหน้าจอ ---------- */
  const b64uToBytes = s => {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));
    return Uint8Array.from(b, c => c.charCodeAt(0));
  };
  const IOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const Push = {
    state: null, // null = ยังไม่ตรวจ | 'on' | 'off' | 'nosupport' | 'needinstall' | 'error'
    get supported() { return LIVE && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && location.protocol === 'https:'; },
    last: 0,
    async ensure(force) {
      const p = Staff.profile();
      if (!LIVE) { this.state = 'demo'; return; }
      if (!this.supported) { this.state = IOS ? 'needinstall' : 'nosupport'; Staff.enforce(); return; }
      if (!Notify.granted) { this.state = 'off'; Staff.enforce(); return; }
      if (!p || !p.staffId || (this.busy && !force)) return;
      if (!force && this.state === 'on' && Date.now() - this.last < 10 * 60000) return; // ยืนยันซ้ำทุก 10 นาที
      this.busy = true;
      try {
        const sub = await this.subscribe();
        await API.call('pushSub', { staffId: p.staffId, sub: sub.toJSON(), device: deviceName() });
        this.state = 'on'; this.last = Date.now();
      } catch (e) {
        this.state = 'error'; this.err = e.message;
      } finally { this.busy = false; Staff.renderChecks(); Staff.enforce(); }
    },
    /** สมัครรับ push บนเครื่องนี้ (ต้องได้รับอนุญาตการแจ้งเตือนแล้ว) */
    async subscribe() {
      const reg = await navigator.serviceWorker.ready;
      const { key } = await API.call('pushKey');
      let sub = await reg.pushManager.getSubscription();
      if (sub && store.get('dc_push_key') !== key) { try { await sub.unsubscribe(); } catch (_) {} sub = null; }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
      store.set('dc_push_key', key);
      saveSwCfg({ key });
      return sub;
    },
    /** ขั้นตอนบังคับตอนลงทะเบียน: ขออนุญาต + สมัคร push → คืน subscription หรือ throw พร้อมวิธีแก้ */
    async requireForRegistration() {
      if (!LIVE) return null;
      if (!this.supported) {
        throw new Error(IOS
          ? 'iPhone/iPad ต้องเพิ่มแอปลงหน้าจอโฮมก่อน (Safari → ปุ่มแชร์ □↑ → เพิ่มไปยังหน้าจอโฮม) แล้วเปิดจากไอคอนเพื่อลงทะเบียน'
          : 'เบราว์เซอร์นี้รับแจ้งเตือนไม่ได้ กรุณาเปิดลิงก์ด้วย Chrome (Android) หรือ Safari (iPhone)');
      }
      await Notify.request();
      if (!Notify.granted) {
        throw new Error(Notification.permission === 'denied'
          ? 'การแจ้งเตือนถูกปิดกั้นไว้ — แตะไอคอน 🔒/ⓘ ข้างลิงก์ (หรือ ข้อมูลแอป) → การแจ้งเตือน → อนุญาต แล้วกดลงทะเบียนอีกครั้ง'
          : 'ต้องกด “อนุญาต” การแจ้งเตือนก่อน จึงจะลงทะเบียนได้ — กดลงทะเบียนอีกครั้งแล้วเลือก “อนุญาต”');
      }
      try { return await this.subscribe(); }
      catch (e) { throw new Error('เปิดรับแจ้งเตือนไม่สำเร็จ: ' + e.message + ' — ลองใหม่อีกครั้ง'); }
    },
    async test() {
      const p = Staff.profile();
      if (this.state !== 'on') { await Notify.request(); await this.ensure(true); }
      if (this.state !== 'on') return toast('err', 'ยังเปิดแจ้งเตือนเมื่อปิดแอปไม่ได้', this.label()[1]);
      toast('info', 'ปิดแอปหรือล็อกหน้าจอภายใน 10 วินาที', 'จะมีแจ้งเตือนทดสอบเด้งขึ้นมาบนหน้าจอ', 10000);
      try {
        const r = await API.call('pushTest', { staffId: p.staffId, delay: 10 });
        if (!r.sent) toast('err', 'ส่งแจ้งเตือนทดสอบไม่สำเร็จ', (r.errors && r.errors.join(' | ')) || 'บริการ push ไม่ตอบรับ', 15000);
      } catch (e) { toast('err', 'ส่งแจ้งเตือนทดสอบไม่สำเร็จ', e.message); }
    },
    blocking() { return LIVE && ['off', 'needinstall', 'nosupport', 'error'].includes(this.state); },
    label() {
      switch (this.state) {
        case 'on': return [true, 'เปิดแล้ว'];
        case 'off': return [Notification.permission === 'denied' ? false : null, Notification.permission === 'denied' ? 'ถูกปิดกั้น' : 'ยังไม่อนุญาต'];
        case 'needinstall': return [false, 'ต้องเพิ่มลงหน้าจอโฮมก่อน'];
        case 'nosupport': return [false, 'เบราว์เซอร์ไม่รองรับ'];
        case 'demo': return [null, 'ต้องเชื่อม Google Sheet'];
        case 'error': return [false, 'ผิดพลาด แตะเพื่อลองใหม่'];
        default: return [null, 'กำลังตรวจ'];
      }
    }
  };
  function deviceName() {
    const m = /Android[^;)]*;\s*([^;)]+?)(?:\sBuild|\))/.exec(UA);
    if (m) return 'Android ' + m[1];
    if (IOS) return 'iPhone/iPad';
    return (navigator.platform || 'เครื่องคอมพิวเตอร์');
  }

  // สถานะ push ของแต่ละคน (ฝั่งผู้บังคับบัญชา): รับแจ้งเตือนตอนปิดแอปได้หรือยัง
  function pushTag(s, long) {
    if (typeof s.push !== 'number') return '';
    return s.push
      ? `<span class="push-tag on" title="ปิดแอป/ล็อกจอก็ยังได้รับแจ้งเตือน">🔔${long ? ' รับแจ้งเตือนตอนปิดแอปได้' : ''}</span>`
      : `<span class="push-tag off" title="ต้องเปิดแอปเวอร์ชันใหม่ 1 ครั้งและอนุญาตการแจ้งเตือน">🔕${long ? ' ยังไม่เปิดรับแจ้งเตือนตอนปิดแอป' : ''}</span>`;
  }

  const Wake = {
    lock: null, want: false,
    async on() {
      this.want = true;
      if (!('wakeLock' in navigator)) return false;
      try { this.lock = await navigator.wakeLock.request('screen'); this.lock.addEventListener('release', () => { this.lock = null; Staff.renderChecks(); }); return true; }
      catch (_) { return false; }
    },
    off() { this.want = false; try { this.lock && this.lock.release(); } catch (_) {} this.lock = null; }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (Wake.want && !Wake.lock) Wake.on().then(() => Staff.renderChecks());
      if (Sound.ctx && Sound.ctx.state === 'suspended') Sound.ctx.resume();
      if (Staff.active) { Staff.poll(); Push.ensure(); }
      if (Cmd.active) Cmd.poll();
    }
  });

  /* =====================================================================
   * UI helpers
   * ===================================================================== */
  function toast(kind, title, body, ms = 5000) {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.innerHTML = `<div class="t-ico">${kind === 'ok' ? '✓' : kind === 'err' ? '!' : '★'}</div><div><div class="t-title">${esc(title)}</div>${body ? `<div class="t-body">${esc(body)}</div>` : ''}</div>`;
    $('#toasts').prepend(el);
    const kill = () => { el.classList.add('out'); setTimeout(() => el.remove(), 300); };
    el.addEventListener('click', kill);
    setTimeout(kill, ms);
    while ($('#toasts').children.length > 5) $('#toasts').lastChild.remove();
  }

  function confirmBox(title, body, yesText = 'ยืนยัน') {
    return new Promise(resolve => {
      const m = $('#confirmModal');
      $('#confirmTitle').textContent = title;
      $('#confirmBody').textContent = body;
      $('#confirmYes').textContent = yesText;
      m.hidden = false;
      const done = v => { m.hidden = true; $('#confirmYes').onclick = $('#confirmNo').onclick = m.onclick = null; resolve(v); };
      $('#confirmYes').onclick = () => done(true);
      $('#confirmNo').onclick = () => done(false);
      m.onclick = e => { if (e.target === m) done(false); };
    });
  }

  const setHTML = (el, html) => { if (el._html !== html) { el._html = html; el.innerHTML = html; } };
  const initials = s => (String(s || '').trim()[0] || '–').toUpperCase();

  /* ---------- Screens / navigation ---------- */
  let current = 'home';
  function show(name) {
    current = name;
    $$('.screen').forEach(s => { s.hidden = s.id !== 'screen-' + name; });
    $('#logoutBtn').hidden = !(name === 'cmd' || name === 'staff');
    window.scrollTo({ top: 0 });
    Install.refresh();
  }

  function go(target) {
    if (target === 'home') { Staff.stop(); Cmd.stop(); show('home'); history.replaceState(null, '', location.pathname); return; }
    if (target === 'cmd-login') {
      if (Cmd.session()) return Cmd.enter();
      show('cmd-login');
      const f = $('#cmdLoginForm'), saved = store.get('dc_cmd_saved');
      if (saved) { f.user.value = saved.user || ''; f.pin.value = saved.pin || ''; f.remember.checked = true; }
      setTimeout(() => (saved ? f.querySelector('[type=submit]') : f.user).focus(), 50);
      return;
    }
    if (target === 'staff') return Staff.enter();
  }

  document.addEventListener('click', e => {
    const n = e.target.closest('[data-nav]');
    if (n) { e.preventDefault(); go(n.dataset.nav); }
  });

  /* =====================================================================
   * Add to Home Screen (PWA install)
   * ===================================================================== */
  const Install = {
    deferred: null, installed: false,
    isIOS: /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    isAndroid: /Android/i.test(UA),
    inApp: /FBAN|FBAV|Instagram|\bLine\/|MicroMessenger|TikTok/i.test(UA),
    get standalone() { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; },
    init() {
      window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); this.deferred = e; this.refresh(); });
      window.addEventListener('appinstalled', () => {
        this.deferred = null; this.installed = true; this.refresh();
        toast('ok', 'ติดตั้งเรียบร้อย', 'เปิดแอป Call Of Duty ได้จากหน้าจอโฮม');
      });
      document.addEventListener('click', e => { if (e.target.closest('[data-install], #installBtn')) this.run(); });
      $('[data-close-sheet]').addEventListener('click', () => { $('#installSheet').hidden = true; });
      $('#installSheet').addEventListener('click', e => { if (e.target.id === 'installSheet') e.currentTarget.hidden = true; });
      this.refresh();
    },
    get available() { return !this.standalone && !this.installed; },
    refresh() {
      const a = this.available;
      $('#installBtn').hidden = !a;
      $('#installCard').hidden = !a;
      $('#staffInstallBtn').hidden = !a;
    },
    async run() {
      if (this.deferred) {
        const ev = this.deferred;
        this.deferred = null;
        try {
          await ev.prompt();
          const r = await ev.userChoice;
          if (r && r.outcome === 'accepted') { this.installed = true; this.refresh(); }
        } catch (_) { this.guide(); }
        return;
      }
      this.guide();
    },
    guide() {
      const share = '<svg viewBox="0 0 24 24"><path d="M12 3v12M12 3l-4 4M12 3l4 4M6 11H5a1 1 0 00-1 1v8a1 1 0 001 1h14a1 1 0 001-1v-8a1 1 0 00-1-1h-1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      let steps;
      if (this.inApp) {
        steps = ['แตะเมนู <b>⋯</b> มุมขวาบนของแอปที่เปิดอยู่', 'เลือก <b>เปิดในเบราว์เซอร์</b> (Safari / Chrome)', 'จากนั้นแตะปุ่ม <b>เพิ่มไปยังหน้าจอโฮม</b> อีกครั้ง'];
      } else if (this.isIOS) {
        steps = [`แตะปุ่ม <b>แชร์</b> ${share} ที่แถบด้านล่าง (หรือแถบที่อยู่ด้านบน)`, 'เลื่อนลงแล้วเลือก <b>เพิ่มไปยังหน้าจอโฮม</b> (Add to Home Screen)', 'แตะ <b>เพิ่ม</b> มุมขวาบน — ไอคอน Call Of Duty จะอยู่บนหน้าจอทันที'];
      } else if (this.isAndroid) {
        steps = ['แตะเมนู <b>⋮</b> มุมขวาบนของ Chrome', 'เลือก <b>ติดตั้งแอป</b> หรือ <b>เพิ่มลงในหน้าจอหลัก</b>', 'แตะ <b>ติดตั้ง</b> — ไอคอน Call Of Duty จะอยู่บนหน้าจอทันที'];
      } else {
        steps = ['คลิกไอคอน <b>ติดตั้ง</b> ⊕ ที่ด้านขวาของแถบที่อยู่ (Chrome / Edge)', 'กด <b>ติดตั้ง</b> เพื่อเพิ่มแอปลงในเครื่อง'];
      }
      $('#installSteps').innerHTML = steps.map((s, i) => `<div class="step"><span class="step-n">${i + 1}</span><div>${s}</div></div>`).join('');
      $('#installSheet').hidden = false;
    }
  };

  /* =====================================================================
   * Commander
   * ===================================================================== */
  const PRESETS = [
    { id: 'emergency', icon: '🚨', title: 'เหตุฉุกเฉิน', sub: 'รายงานตัวทันที', priority: 'critical' },
    { id: 'meeting', icon: '📋', title: 'เรียกประชุมด่วน', sub: 'เข้าห้องประชุมทันที', priority: 'high' },
    { id: 'standby', icon: '🛡️', title: 'เตรียมพร้อมปฏิบัติการ', sub: 'เตรียมอุปกรณ์ รอรับคำสั่ง', priority: 'high' },
    { id: 'muster', icon: '📍', title: 'รวมพล ณ จุดนัดหมาย', sub: 'ไปยังจุดรวมพลโดยด่วน', priority: 'high' },
    { id: 'callback', icon: '📞', title: 'ติดต่อกลับผู้บังคับบัญชา', sub: 'โทรกลับโดยด่วน', priority: 'normal' },
    { id: 'custom', icon: '✍️', title: 'กำหนดข้อความเอง', sub: 'พิมพ์คำสั่งเฉพาะกิจ', priority: 'high' }
  ];

  const Cmd = {
    active: false, timer: null, busy: false, data: null, seenAcks: null, preset: null, target: 'ALL', search: '',
    get tone() { const t = store.get('dc_cmd_tone'); return TONES.some(x => x.id === t) ? t : 'hellmarch'; },
    set tone(v) { store.set('dc_cmd_tone', v); },
    session() { return store.get('dc_cmd') || sstore.get('dc_cmd'); },
    async login(user, pin, remember) {
      user = String(user || '').trim().toLowerCase();
      if (user !== 'commander' || pin !== '9999') throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
      if (LIVE) await API.call('login', { user, pin });
      if (remember) {
        // จดจำไว้ในเครื่อง: เปิดครั้งต่อไปเข้าได้ทันที ไม่ต้องกรอกรหัส
        store.set('dc_cmd', { user, pin }); store.set('dc_cmd_saved', { user, pin });
      } else {
        store.del('dc_cmd'); store.del('dc_cmd_saved'); sstore.set('dc_cmd', { user, pin });
      }
    },
    enter() {
      show('cmd');
      history.replaceState(null, '', '?role=commander');
      this.renderPresets(); this.renderTargets(); this.renderTones();
      this.active = true; this.seenAcks = null;
      this.poll();
      clearInterval(this.timer);
      this.timer = setInterval(() => this.poll(), CFG.COMMANDER_POLL_MS);
    },
    stop() { this.active = false; clearInterval(this.timer); this.timer = null; },
    logout(forget) {
      this.stop(); store.del('dc_cmd'); sstore.del('dc_cmd');
      if (forget) store.del('dc_cmd_saved');
      go('home');
    },
    creds() { const s = this.session() || {}; return { user: s.user, pin: s.pin }; },

    async poll() {
      if (!this.active || this.busy) return;
      this.busy = true;
      try {
        const d = await API.call('commanderPoll', this.creds());
        this.data = d;
        this.detectAcks(d.calls);
        this.render();
      } catch (e) {
        if (/รหัสผ่าน/.test(e.message)) { toast('err', 'เซสชันหมดอายุ', 'กรุณาเข้าสู่ระบบใหม่'); this.logout(true); }
      } finally { this.busy = false; }
    },

    detectAcks(calls) {
      const keys = new Set();
      const fresh = [];
      calls.forEach(c => (c.responses || []).forEach(r => {
        const k = c.callId + '|' + r.staffId;
        keys.add(k);
        if (this.seenAcks && !this.seenAcks.has(k)) fresh.push({ c, r });
      }));
      this.seenAcks = keys;
      fresh.forEach(({ c, r }, i) => setTimeout(() => {
        toast('ok', `${r.nickname} ตอบรับแล้ว`, `${r.fullName} · ${r.team} — ${c.message}`, 7000);
        Sound.chime();
        if (document.visibilityState !== 'visible') Notify.show(`✓ ${r.nickname} ตอบรับแล้ว`, `${r.fullName} · ${r.team}\n${c.message}`, 'ack-' + c.callId + r.staffId, false);
      }, i * 350));
    },

    teams() {
      const set = new Set(CFG.TEAMS || []);
      ((this.data && this.data.staff) || []).forEach(s => s.team && set.add(s.team));
      return Array.from(set);
    },

    renderPresets() {
      $('#presetGrid').innerHTML = PRESETS.map(p => `
        <button type="button" class="preset ${p.priority === 'critical' ? 'critical' : ''} ${this.preset === p.id ? 'sel' : ''}" data-preset="${p.id}">
          <span class="pi">${p.icon}</span><span><span class="pt">${esc(p.title)}</span><br><span class="ps">${esc(p.sub)}</span></span>
        </button>`).join('');
      $('#customField').hidden = this.preset !== 'custom';
    },

    renderTargets() {
      const teams = this.teams();
      if (this.target !== 'ALL' && !teams.includes(this.target)) this.target = 'ALL';
      const html = [`<button type="button" data-target="ALL" class="${this.target === 'ALL' ? 'sel' : ''}">ทุกคน</button>`]
        .concat(teams.map(t => `<button type="button" data-target="${esc(t)}" class="${this.target === t ? 'sel' : ''}">${esc(t)}</button>`)).join('');
      if ($('#targetSeg').innerHTML !== html) $('#targetSeg').innerHTML = html;
    },

    renderTones() {
      const cur = this.tone;
      setHTML($('#cmdToneGrid'), TONES.map(t => `
        <button type="button" class="tone ${t.id === cur ? 'sel' : ''}" data-tone="${t.id}">
          <span class="tone-ic">${t.icon}</span>
          <span class="tone-txt"><span class="tone-name">${esc(t.name)}</span><span class="tone-desc">${esc(t.desc)}</span></span>
          <span class="tone-check">${t.id === cur ? '✓' : '▶'}</span>
        </button>`).join(''));
      $('#cmdToneCurrent').textContent = toneName(cur);
    },

    render() {
      const d = this.data; if (!d) return;
      const staff = d.staff || [];
      const activeCalls = d.calls.filter(c => c.status === 'active');
      $('#statOnline').textContent = staff.filter(s => s.online).length;
      $('#statTotal').textContent = staff.length;
      $('#statActive').textContent = activeCalls.length;
      this.renderTargets();

      // Active calls with acknowledgement status
      setHTML($('#activeCalls'), activeCalls.length ? activeCalls.map(c => {
        const targeted = staff.filter(s => !c.target || c.target === 'ALL' || s.team === c.target);
        const ackIds = new Set(c.responses.map(r => r.staffId));
        const pending = targeted.filter(s => !ackIds.has(s.staffId));
        const total = Math.max(targeted.length, c.responses.length);
        const pct = total ? Math.round(c.responses.length / total * 100) : 0;
        const acks = c.responses.slice().sort((a, b) => a.at - b.at).map(r => `
          <div class="ack-item"><span class="ai-ico">✓</span><span class="ai-name">${esc(r.nickname)}<small>${esc(r.fullName)} · ${esc(r.team)}</small></span><span class="ai-time">${fmtTime(r.at)}</span></div>`).join('');
        const pend = pending.map(s => `
          <div class="ack-item pending"><span class="ai-ico">…</span><span class="ai-name">${esc(s.nickname)}<small>${esc(s.firstName)} ${esc(s.lastName)} · ${esc(s.team)}</small></span><span class="ai-time">${s.online ? '<span class="presence on">ออนไลน์</span>' : '<span class="presence">ออฟไลน์</span>'}${pushTag(s)}</span></div>`).join('');
        return `
          <div class="call-card ${parsePrio(c.priority).level === 'critical' ? 'critical' : ''}">
            <div class="call-top">
              <div>
                <div class="call-msg">${esc(c.message)}</div>
                <div class="call-sub">${fmtDateTime(c.createdAt)} · ผู้รับ: ${c.target === 'ALL' || !c.target ? 'ทุกคน' : esc(c.target)} · เสียง: ${esc(toneName(parsePrio(c.priority).sound) || toneName(Sound.selected))}</div>
                ${c.detail ? `<div class="call-detail">${esc(c.detail)}</div>` : ''}
              </div>
              <span class="tag active">กำลังเรียก</span>
            </div>
            <div class="progress"><i style="width:${pct}%"></i></div>
            <div class="progress-label"><span>ตอบรับแล้ว <strong>${c.responses.length}</strong> / ${total} คน</span><span>${pct}%</span></div>
            ${acks ? `<p class="ack-section-title">ตอบรับแล้ว</p><div class="ack-list">${acks}</div>` : ''}
            ${pend ? `<p class="ack-section-title">รอการตอบรับ</p><div class="ack-list">${pend}</div>` : ''}
            <div class="call-actions"><button class="btn-ghost sm" type="button" data-close-call="${esc(c.callId)}">ปิดการเรียก</button></div>
          </div>`;
      }).join('') : '<div class="empty">ยังไม่มีการเรียกที่เปิดอยู่<br>เลือกประเภทการเรียกแล้วกด “ส่งสัญญาณเรียก”</div>');

      // Roster
      $('#removeAllBtn').hidden = !staff.length;
      const pd = $('#pushDiag'), pl = d.pushLast;
      if (pl && pl.at) {
        const bad = pl.ok < pl.sent;
        pd.hidden = false; pd.classList.toggle('bad', bad);
        pd.textContent = `แจ้งเตือนแบบ push ล่าสุด ${fmtTime(pl.at)}: ส่ง ${pl.sent} เครื่อง สำเร็จ ${pl.ok}` + (pl.errors && pl.errors.length ? ' · ผิดพลาด: ' + pl.errors.join(' | ') : '');
      } else pd.hidden = true;
      $('#closeAllBtn').hidden = d.calls.filter(c => c.status === 'active').length < 2;
      $('#clearHistBtn').hidden = !d.calls.some(c => c.status !== 'active');
      const q = this.search.trim().toLowerCase();
      const roster = staff.filter(s => !q || [s.firstName, s.lastName, s.nickname, s.team, s.lineId].join(' ').toLowerCase().includes(q))
        .sort((a, b) => (b.online - a.online) || String(a.team).localeCompare(b.team, 'th') || String(a.nickname).localeCompare(b.nickname, 'th'));
      setHTML($('#roster'), roster.length ? roster.map(s => `
        <div class="person">
          <div class="avatar">${esc(initials(s.nickname))}</div>
          <div class="person-main">
            <div class="person-name">${esc(s.nickname)} · ${esc(s.firstName)} ${esc(s.lastName)}</div>
            <div class="person-meta">${esc(s.team)} · LINE: ${esc(s.lineId)}</div>
            ${pushTag(s, true)}
          </div>
          <div class="person-actions">
            <span class="presence ${s.online ? 'on' : ''}" title="${esc(ago(s.lastSeen))}">${s.online ? 'ออนไลน์' : esc(ago(s.lastSeen))}</span>
            <button class="btn-ghost sm" type="button" data-remove-staff="${esc(s.staffId)}" data-name="${esc(s.nickname)}">ลบ / ให้ลงทะเบียนใหม่</button>
          </div>
        </div>`).join('') : `<div class="empty">${q ? 'ไม่พบรายชื่อที่ค้นหา' : 'ยังไม่มีผู้ลงทะเบียน'}</div>`);

      // History
      const hist = d.calls.filter(c => c.status !== 'active');
      setHTML($('#callHistory'), hist.length ? hist.map(c => `
        <div class="hist">
          <div><div class="hist-msg">${esc(c.message)}</div><div class="hist-sub">${fmtDateTime(c.createdAt)} · ${c.target === 'ALL' || !c.target ? 'ทุกคน' : esc(c.target)} · ตอบรับ ${c.responses.length} คน</div></div>
          <span class="tag done">ปิดแล้ว</span>
        </div>`).join('') : '<div class="empty">ยังไม่มีประวัติการเรียก</div>');
    },

    async send() {
      const p = PRESETS.find(x => x.id === this.preset);
      if (!p) return toast('err', 'กรุณาเลือกประเภทการเรียก');
      let message = p.title;
      const extra = $('#callDetail').value.trim();
      let detail = extra || p.sub;
      if (p.id === 'custom') {
        message = $('#customMsg').value.trim();
        detail = extra;
        if (!message) { $('#customMsg').focus(); return toast('err', 'กรุณาพิมพ์ข้อความเรียก'); }
      }
      const tgt = this.target === 'ALL' ? 'ทุกคน' : this.target;
      if (!await confirmBox('ยืนยันการส่งสัญญาณเรียก', `“${message}” ถึง ${tgt} · เสียง: ${toneName(this.tone)}`, 'ส่งสัญญาณ')) return;
      const btn = $('#sendCallBtn'); btn.disabled = true;
      try {
        const priority = p.priority + ';sound=' + this.tone;
        const r = await API.call('createCall', Object.assign(this.creds(), { message, detail, priority, target: this.target }));
        toast('info', 'ส่งสัญญาณเรียกแล้ว', `${message} → ${tgt} · เสียง: ${toneName(this.tone)}` +
          (typeof r.pushed === 'number' ? ` · เด้งแจ้งเตือนถึง ${r.pushed} เครื่อง` : ''));
        $('#callDetail').value = ''; $('#customMsg').value = '';
        this.preset = null; this.renderPresets();
        await this.poll();
      } catch (e) { toast('err', 'ส่งสัญญาณไม่สำเร็จ', e.message); }
      finally { btn.disabled = false; }
    },

    async removeAll() {
      const n = (this.data && this.data.staff || []).length;
      if (!await confirmBox('ลบรายชื่อทุกคน ' + n + ' คน?', 'ทุกเครื่องต้องลงทะเบียนใหม่เมื่อเปิดแอปครั้งถัดไป (ต้องอนุญาตการแจ้งเตือน) · ประวัติการเรียกและการตอบรับยังอยู่ · ย้อนกลับไม่ได้', 'ลบทั้งหมด')) return;
      try {
        const r = await API.call('removeAllStaff', Object.assign(this.creds(), { confirm: 'DELETE' }));
        toast('info', 'ลบรายชื่อแล้ว ' + (r.removed || 0) + ' คน', 'ทุกคนต้องลงทะเบียนใหม่เมื่อเปิดแอป'); this.poll();
      } catch (e) { toast('err', 'ไม่สำเร็จ', e.message); }
    },
    async removeStaff(staffId, name) {
      if (!await confirmBox('ลบ ' + name + ' ออกจากทะเบียน?', 'เมื่อเปิดแอปครั้งถัดไป เครื่องนั้นต้องลงทะเบียนใหม่ และต้องกดอนุญาตการแจ้งเตือนจึงจะลงทะเบียนได้', 'ลบรายชื่อ')) return;
      try { await API.call('removeStaff', Object.assign(this.creds(), { staffId })); toast('info', 'ลบรายชื่อแล้ว', name + ' ต้องลงทะเบียนใหม่เมื่อเปิดแอป'); this.poll(); }
      catch (e) { toast('err', 'ไม่สำเร็จ', e.message); }
    },

    async close(callId) {
      if (!await confirmBox('ปิดการเรียกนี้?', 'ผู้ที่ยังไม่ตอบรับจะหยุดได้รับสัญญาณเตือน', 'ปิดการเรียก')) return;
      try { await API.call('closeCall', Object.assign(this.creds(), { callId })); toast('info', 'ปิดการเรียกแล้ว'); this.poll(); }
      catch (e) { toast('err', 'ไม่สำเร็จ', e.message); }
    },

    init() {
      $('#cmdLoginForm').addEventListener('submit', async e => {
        e.preventDefault();
        Sound.unlock(); Notify.request();
        const f = e.currentTarget, btn = f.querySelector('[type=submit]'), err = $('#cmdLoginError');
        err.hidden = true; btn.disabled = true;
        try {
          const remember = f.remember.checked;
          await this.login(f.user.value, f.pin.value, remember);
          if (remember && 'PasswordCredential' in window && navigator.credentials) {
            // ให้เบราว์เซอร์ (Chrome/Android) เสนอบันทึกรหัสผ่านด้วย
            try { await navigator.credentials.store(new PasswordCredential({ id: f.user.value.trim().toLowerCase(), password: f.pin.value, name: 'Commander' })); } catch (_) {}
          }
          this.enter();
        }
        catch (ex) { err.textContent = ex.message; err.hidden = false; }
        finally { btn.disabled = false; }
      });
      $('#presetGrid').addEventListener('click', e => {
        const b = e.target.closest('[data-preset]'); if (!b) return;
        this.preset = b.dataset.preset; this.renderPresets();
        if (this.preset === 'custom') $('#customMsg').focus();
      });
      $('#cmdToneGrid').addEventListener('click', e => {
        const b = e.target.closest('[data-tone]'); if (!b) return;
        this.tone = b.dataset.tone; this.renderTones();
        Sound.unlock();
        Sound.preview(b.dataset.tone);
      });
      $('#targetSeg').addEventListener('click', e => {
        const b = e.target.closest('[data-target]'); if (!b) return;
        this.target = b.dataset.target; this.renderTargets();
      });
      $('#sendCallBtn').addEventListener('click', () => this.send());
      $('#activeCalls').addEventListener('click', e => {
        const b = e.target.closest('[data-close-call]'); if (b) this.close(b.dataset.closeCall);
      });
      $('#rosterSearch').addEventListener('input', e => { this.search = e.target.value; this.render(); });
      $('#roster').addEventListener('click', e => {
        const b = e.target.closest('[data-remove-staff]'); if (b) this.removeStaff(b.dataset.removeStaff, b.dataset.name);
      });
      $('#removeAllBtn').addEventListener('click', () => this.removeAll());
      $('#closeAllBtn').addEventListener('click', async () => {
        if (!await confirmBox('ปิดการเรียกทั้งหมด?', 'ทุกเครื่องจะหยุดได้รับสัญญาณเตือนของการเรียกที่เปิดอยู่', 'ปิดทั้งหมด')) return;
        try { const r = await API.call('closeAllCalls', this.creds()); toast('info', 'ปิดการเรียกแล้ว ' + (r.closed || 0) + ' รายการ'); this.poll(); }
        catch (e) { toast('err', 'ไม่สำเร็จ', e.message); }
      });
      $('#clearHistBtn').addEventListener('click', async () => {
        if (!await confirmBox('ลบประวัติการเรียกเก่า?', 'ลบการเรียกที่ปิดแล้วทั้งหมดและรายชื่อผู้ตอบรับของการเรียกเหล่านั้นออกจาก Google Sheet · ย้อนกลับไม่ได้', 'ลบประวัติ')) return;
        try { const r = await API.call('clearHistory', this.creds()); toast('info', 'ลบประวัติแล้ว ' + (r.removed || 0) + ' รายการ'); this.poll(); }
        catch (e) { toast('err', 'ไม่สำเร็จ', e.message); }
      });
    }
  };

  /* =====================================================================
   * Staff
   * ===================================================================== */
  const Staff = {
    active: false, timer: null, busy: false, queue: [], acked: new Set(), online: null, showing: null,
    profile() { return store.get('dc_staff'); },

    enter() {
      const p = this.profile();
      history.replaceState(null, '', '?role=staff');
      if (!p || !p.staffId) return this.showReg(false);
      this.showDuty();
      if (!Sound.ready) $('#gate').hidden = false;
    },

    syncTeam() {
      const v = $('#regForm').team.value;
      $$('#teamPick [data-team]').forEach(b => { const on = b.dataset.team === v; b.classList.toggle('sel', on); b.setAttribute('aria-checked', on); });
      if (v) $('#teamPick').classList.remove('invalid');
    },

    showReg(edit) {
      this.stop();
      show('staff-reg');
      const f = $('#regForm'), p = this.profile() || {};
      $('#regTitle').textContent = edit ? 'แก้ไขข้อมูลส่วนตัว' : 'ลงทะเบียนผู้ใต้บังคับบัญชา';
      $('#regSubmit').textContent = edit ? 'บันทึกข้อมูล' : 'ลงทะเบียน';
      ['firstName', 'lastName', 'nickname', 'team', 'lineId'].forEach(k => { f[k].value = edit ? (p[k] || '') : (f[k].value || ''); f[k].classList.remove('invalid'); });
      if (!(CFG.TEAMS || []).includes(f.team.value)) f.team.value = ''; // ทีมเก่าที่ไม่มีแล้ว → ต้องเลือกใหม่
      this.syncTeam();
      $('#regError').hidden = true;
      $('#regBack').textContent = edit ? '← กลับ' : '← กลับหน้าหลัก';
      $('#regBack').dataset.nav = edit ? 'staff' : 'home';
    },

    showDuty() {
      show('staff');
      const p = this.profile();
      $('#pfAvatar').textContent = initials(p.nickname);
      $('#pfName').textContent = `${p.nickname} · ${p.firstName} ${p.lastName}`;
      $('#pfTeam').textContent = p.team;
      $('#pfLine').textContent = 'LINE: ' + p.lineId;
      this.start();
    },

    async activate() {
      Sound.unlock();
      await Notify.request();
      await Push.ensure(true);
      await Wake.on();
      if (Push.blocking()) return this.enforce(); // บังคับ: ต้องเปิดรับแจ้งเตือนตอนปิดแอปก่อนจึงจะเข้าเวรได้
      $('#gate').hidden = true; $('#gate').classList.remove('push');
      this.renderChecks();
      if (this.queue.length) this.ring();
    },

    /** ถ้าเครื่องนี้ยังรับแจ้งเตือนตอนปิดแอปไม่ได้ → ขึ้นหน้าบล็อกพร้อมวิธีแก้ */
    enforce() {
      if (current !== 'staff' || !this.active) return;
      const g = $('#gate');
      if (!Push.blocking()) {
        if (g.classList.contains('push')) { g.classList.remove('push'); if (Sound.ready) g.hidden = true; this.resetGate(); }
        return;
      }
      const help = $('#gateHelp');
      const denied = 'Notification' in window && Notification.permission === 'denied';
      g.classList.add('push');
      $('#gateEyebrow').textContent = 'จำเป็นต้องตั้งค่า';
      $('#gateTitle').textContent = 'เปิดรับแจ้งเตือนก่อนเข้าเวร';
      $('#gateText').textContent = 'ต้องอนุญาตการแจ้งเตือน เพื่อให้สัญญาณเรียกเด้งขึ้นจอได้แม้ปิดแอปหรือล็อกหน้าจอ';
      let html = '', btn = 'อนุญาตการแจ้งเตือน';
      if (Push.state === 'needinstall') {
        html = '<b>iPhone/iPad ต้องเพิ่มแอปลงหน้าจอโฮมก่อน</b><ol><li>กดปุ่มแชร์ (□↑) ใน Safari</li><li>เลือก “เพิ่มไปยังหน้าจอโฮม”</li><li>เปิดแอปจากไอคอนบนหน้าจอโฮม แล้วกดอนุญาตการแจ้งเตือน</li></ol>';
        btn = 'ตรวจสอบอีกครั้ง';
      } else if (Push.state === 'nosupport') {
        html = '<b>เบราว์เซอร์นี้ไม่รองรับ</b> กรุณาเปิดลิงก์นี้ด้วย <b>Chrome</b> (Android) หรือ <b>Safari</b> (iPhone) แล้วติดตั้งลงหน้าจอโฮม';
        btn = 'ตรวจสอบอีกครั้ง';
      } else if (denied) {
        html = '<b>การแจ้งเตือนถูกปิดกั้นไว้</b> เปิดใหม่ได้ดังนี้<ol><li>Android: แตะไอคอน 🔒 / ⓘ ข้างลิงก์ด้านบน (หรือ ข้อมูลแอป) → <b>การแจ้งเตือน</b> → <b>อนุญาต</b></li><li>iPhone: ตั้งค่า → การแจ้งเตือน → Call Of Duty → เปิด <b>อนุญาตการแจ้งเตือน</b></li><li>กลับมาที่แอปแล้วกดปุ่มด้านล่าง</li></ol>';
        btn = 'ตรวจสอบอีกครั้ง';
      } else if (Push.state === 'error') {
        html = 'เชื่อมต่อระบบแจ้งเตือนไม่สำเร็จ (' + esc(Push.err || '') + ') ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่';
        btn = 'ลองใหม่';
      }
      help.innerHTML = html; help.hidden = !html;
      $('#gateBtn').textContent = btn;
      g.hidden = false;
    },
    resetGate() {
      $('#gateEyebrow').textContent = 'Ready for Duty';
      $('#gateTitle').textContent = 'เริ่มปฏิบัติหน้าที่';
      $('#gateText').textContent = 'แตะปุ่มด้านล่างเพื่อเปิดเสียงเตือนและเริ่มรอรับสัญญาณเรียก';
      $('#gateHelp').hidden = true;
      $('#gateBtn').textContent = 'แตะเพื่อเริ่ม';
    },

    start() {
      if (this.active) return;
      this.active = true;
      this.poll();
      Push.ensure();
      this.timer = setInterval(() => this.poll(), CFG.STAFF_POLL_MS);
      this.renderChecks();
    },
    stop() {
      this.active = false; clearInterval(this.timer); this.timer = null;
      this.queue = []; this.hideAlarm(); Wake.off();
    },

    async poll() {
      const p = this.profile();
      if (!this.active || this.busy || !p) return;
      this.busy = true;
      try {
        const r = await API.call('staffPoll', { staffId: p.staffId });
        this.setOnline(true);
        if (!r.registered) {
          store.del('dc_staff');
          toast('err', 'ไม่พบข้อมูลการลงทะเบียน', 'กรุณาลงทะเบียนใหม่อีกครั้ง');
          return this.showReg(false);
        }
        const incoming = r.calls.filter(c => !this.acked.has(c.callId));
        const ids = new Set(incoming.map(c => c.callId));
        const before = new Set(this.queue.map(c => c.callId));
        this.queue = incoming.sort((a, b) => a.createdAt - b.createdAt);
        incoming.filter(c => !before.has(c.callId)).forEach(c =>
          Notify.show('🚨 ' + c.message, (c.detail || 'แตะเพื่อเปิดและกดตอบรับ'), 'call-' + c.callId, true));
        before.forEach(id => { if (!ids.has(id)) Notify.clear('call-' + id); });
        Notify.clearStale(ids);
        if (this.queue.length) this.ring(); else this.hideAlarm();
      } catch (_) {
        this.setOnline(false);
      } finally { this.busy = false; }
    },

    setOnline(v) {
      if (this.online === v) return;
      this.online = v;
      $('#screen-staff .duty').classList.toggle('offline', !v);
      $('#dutyHint').textContent = v ? 'เปิดหน้านี้ค้างไว้ ระบบจะแจ้งเตือนทันทีเมื่อมีการเรียก' : 'ขาดการเชื่อมต่อ กำลังพยายามเชื่อมต่อใหม่…';
      this.renderChecks();
    },

    ring() {
      const c = this.queue[0]; if (!c) return;
      const a = $('#alarm');
      if (this.showing !== c.callId) {
        this.showing = c.callId;
        $('#alarmMsg').textContent = c.message;
        $('#alarmDetail').textContent = c.detail || '';
        $('#alarmTime').textContent = 'เวลาเรียก ' + fmtTime(c.createdAt) + (c.target && c.target !== 'ALL' ? ' · ถึง ' + c.target : '');
        $('#ackBtn').disabled = false;
        $('#ackBtn span').textContent = 'รับทราบ / ตอบรับ';
      }
      $('#alarmQueue').textContent = this.queue.length > 1 ? `มีอีก ${this.queue.length - 1} คำสั่งรอการตอบรับ` : '';
      a.hidden = false;
      const want = this.wantTone(c);
      if (Sound.playing && Sound.playing !== want && !Sound.previewing) Sound.stopLoops();
      Sound.startAlarm(want);
      if (!this._title) { this._title = document.title; this._flip = setInterval(() => { document.title = document.title === '🚨 มีการเรียก!' ? this._title : '🚨 มีการเรียก!'; }, 900); }
    },

    hideAlarm() {
      if (!$('#alarm').hidden) setTimeout(() => Updater.apply(), 1500); // อัปเดตที่รออยู่ทำต่อหลังตอบรับ
      $('#alarm').hidden = true;
      this.showing = null;
      Sound.stopAlarm();
      if (this._title) { clearInterval(this._flip); document.title = this._title; this._title = null; }
    },

    async ack() {
      const c = this.queue[0], p = this.profile();
      if (!c || !p) return;
      const btn = $('#ackBtn');
      btn.disabled = true; $('#ackBtn span').textContent = 'กำลังส่งการตอบรับ…';
      try {
        await API.call('ack', { staffId: p.staffId, callId: c.callId });
        this.acked.add(c.callId);
        Notify.clear('call-' + c.callId);
        this.queue.shift();
        toast('ok', 'ตอบรับเรียบร้อย', `แจ้งผู้บังคับบัญชาแล้ว: ${c.message}`);
        if (this.queue.length) { this.showing = null; this.ring(); } else this.hideAlarm();
      } catch (e) {
        btn.disabled = false; $('#ackBtn span').textContent = 'ส่งไม่สำเร็จ — แตะเพื่อลองอีกครั้ง';
        toast('err', 'ส่งการตอบรับไม่สำเร็จ', e.message);
      }
    },

    wantTone(c) { return (c && parsePrio(c.priority).sound) || Sound.selected; },

    previewTone(id) {
      Sound.unlock();
      $('#testAlarmBtn').disabled = true;
      Sound.preview(id, () => {
        $('#testAlarmBtn').disabled = false;
        if (this.queue.length) Sound.startAlarm(this.wantTone(this.queue[0])); // มีการเรียกค้างอยู่ → เล่นเสียงเตือนต่อ
        this.renderChecks();
      });
    },

    renderChecks() {
      const set = (id, ok, text) => { const el = $(id); el.classList.toggle('ok', ok === true); el.classList.toggle('bad', ok === false); $('em', el).textContent = text; };
      set('#ckSound', Sound.ready ? true : false, Sound.ready ? 'พร้อม' : 'แตะเพื่อเปิด');
      if (!Notify.supported) set('#ckNotif', null, 'ไม่รองรับ');
      else set('#ckNotif', Notify.granted ? true : Notification.permission === 'denied' ? false : null, Notify.granted ? 'เปิดแล้ว' : Notification.permission === 'denied' ? 'ถูกปิดกั้น' : 'ยังไม่อนุญาต');
      set('#ckWake', 'wakeLock' in navigator ? !!Wake.lock : null, !('wakeLock' in navigator) ? 'ไม่รองรับ' : Wake.lock ? 'เปิดอยู่' : 'ปิด');
      set('#ckConn', this.online === null ? null : this.online, this.online === null ? 'กำลังเชื่อมต่อ' : this.online ? (LIVE ? 'ออนไลน์' : 'โหมดทดลอง') : 'ขาดการเชื่อมต่อ');
      $('#enableNotifBtn').hidden = !(Notify.supported && Notification.permission === 'default');
      const [pok, ptext] = Push.label();
      set('#ckPush', pok, ptext);
    },

    init() {
      $('#teamPick').innerHTML = (CFG.TEAMS || []).map(t => `<button type="button" role="radio" data-team="${esc(t)}">${esc(t.replace(/^ทีม\s*/, '') || t)}</button>`).join('');
      $('#teamPick').addEventListener('click', e => {
        const b = e.target.closest('[data-team]'); if (!b) return;
        $('#regForm').team.value = b.dataset.team; this.syncTeam();
      });

      $('#regForm').addEventListener('submit', async e => {
        e.preventDefault();
        Sound.unlock();
        const f = e.currentTarget, err = $('#regError'), btn = $('#regSubmit');
        const keys = ['firstName', 'lastName', 'nickname', 'team', 'lineId'];
        const data = {};
        let bad = null;
        keys.forEach(k => { data[k] = f[k].value.trim(); const miss = !data[k]; f[k].classList.toggle('invalid', miss); if (miss && !bad) bad = f[k]; });
        $('#teamPick').classList.toggle('invalid', !data.team);
        if (bad && bad.type === 'hidden') { err.textContent = 'กรุณาเลือกทีม (A / B / C / D)'; err.hidden = false; $('#teamPick').scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
        if (bad) { err.textContent = 'กรุณากรอกข้อมูลให้ครบทุกช่อง'; err.hidden = false; bad.focus(); return; }
        err.hidden = true; btn.disabled = true;
        const prev = this.profile();
        try {
          // บังคับ: ต้องอนุญาตการแจ้งเตือน (รับได้แม้ปิดแอป) ก่อนลงทะเบียน
          let sub = null;
          if (!prev || !prev.staffId) sub = await Push.requireForRegistration();
          else if (Notify.granted && Push.supported) { try { sub = await Push.subscribe(); } catch (_) {} }
          const r = await API.call('register', Object.assign({ staffId: prev && prev.staffId, sub: sub && sub.toJSON(), device: deviceName() }, data));
          if (sub) { Push.state = 'on'; Push.last = Date.now(); }
          store.set('dc_staff', Object.assign({ staffId: r.staffId }, data));
          toast('ok', prev ? 'บันทึกข้อมูลแล้ว' : 'ลงทะเบียนสำเร็จ', `${data.nickname} · ${data.team}`);
          this.showDuty();
          this.activate();
        } catch (ex) { err.textContent = ex.message; err.hidden = false; }
        finally { btn.disabled = false; }
      });
      $$('#regForm input').forEach(i => i.addEventListener('input', () => i.value.trim() && i.classList.remove('invalid')));
      $('#gateBtn').addEventListener('click', () => this.activate());
      $('#ackBtn').addEventListener('click', () => { Sound.unlock(); this.ack(); });
      $('#editProfileBtn').addEventListener('click', () => this.showReg(true));
      $('#enableNotifBtn').addEventListener('click', async () => { await Notify.request(); await Push.ensure(true); this.renderChecks(); });
      $('#ckPush').addEventListener('click', async () => { if (Push.state !== 'on') { await Notify.request(); await Push.ensure(true); } });
      $('#testPushBtn').addEventListener('click', () => Push.test());
      $('#testAlarmBtn').addEventListener('click', () => this.previewTone(Sound.selected));
    }
  };

  /* =====================================================================
   * Boot
   * ===================================================================== */
  $('#orgName').textContent = CFG.ORG_NAME || 'Modern Warfare';
  const badge = $('#modeBadge');
  badge.hidden = false;
  badge.className = 'mode-badge ' + (LIVE ? 'live' : 'demo');
  badge.textContent = LIVE ? '● ออนไลน์' : 'โหมดทดลอง';
  badge.title = LIVE ? 'เชื่อมต่อ Google Sheet แล้ว' : 'ยังไม่ได้ตั้งค่า API_URL — ข้อมูลเก็บในเครื่องนี้เท่านั้น';

  $('#refreshBtn').addEventListener('click', async () => {
    // รีเฟรชเต็มรูปแบบ: ล้างแคช + อัปเดต service worker + ลบแจ้งเตือนเก่า แล้วโหลดใหม่
    try {
      const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.getRegistration());
      if (reg) (await reg.getNotifications()).forEach(n => { const id = notifCallId(n); if (!id || !Staff.queue.some(c => c.callId === id)) n.close(); });
    } catch (_) {}
    sstore.del('dc_upd_try');
    Updater.pending = Updater.pending || 'manual';
    Updater.reload();
  });

  $('#logoutBtn').addEventListener('click', async () => {
    if (current === 'cmd') return Cmd.logout();
    if (current === 'staff') {
      if (await confirmBox('ออกจากเวร?', 'คุณจะไม่ได้รับสัญญาณเรียกจนกว่าจะเปิดหน้านี้อีกครั้ง', 'ออกจากเวร')) go('home');
    }
  });

  /* =====================================================================
   * Auto update: ตรวจ version.json ทุก 1 นาที เจอเวอร์ชันใหม่ → รีเฟรชอัตโนมัติ
   * ===================================================================== */
  const Updater = {
    pending: null,
    async check() {
      if (location.protocol === 'file:') return;
      try {
        const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) return;
        const v = String((await r.json()).version || '');
        if (v && v !== APP_VERSION) { this.pending = v; this.apply(); }
        else if (swReg) swReg.update().catch(() => {}); // ให้ service worker เป็นเวอร์ชันล่าสุดเสมอ
      } catch (_) {}
    },
    apply() {
      if (!this.pending) return;
      if (Staff.queue.length || !$('#alarm').hidden) return; // ห้ามรีเฟรชขณะเสียงเตือนดัง — รอจนกดตอบรับ
      if (sstore.get('dc_upd_try') === this.pending) return;   // กันรีเฟรชวน ถ้ารีเฟรชแล้วยังได้ไฟล์เก่า
      // บังคับรีเฟรชทุกเครื่องทันที (หลังรีเฟรช ผู้ใต้บังคับบัญชาแตะ “เริ่ม” อีกครั้ง — ระหว่างนั้นยังได้รับแจ้งเตือนแบบ push ตามปกติ)
      this.reload();
    },
    async reload() {
      sstore.set('dc_upd_try', this.pending);
      $('#updText').textContent = 'กำลังอัปเดตเป็นเวอร์ชันล่าสุด…';
      $('#updBtn').hidden = true; $('#updSpin').hidden = false;
      $('#updateBox').hidden = false;
      try {
        const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.getRegistration());
        if (reg) await reg.update();
        if (window.caches) await Promise.all((await caches.keys()).filter(k => k !== 'dc-cfg').map(k => caches.delete(k)));
      } catch (_) {}
      setTimeout(() => location.reload(), 700);
    },
    init() {
      $('#updBtn').addEventListener('click', () => this.reload());
      $('#appVersion').textContent = 'v' + APP_VERSION;
      const last = store.get('dc_ver');
      const used = last || store.get('dc_cmd') || store.get('dc_cmd_saved') || store.get('dc_staff');
      if (used && last !== APP_VERSION) setTimeout(() => toast('info', 'อัปเดตเป็นเวอร์ชันล่าสุดแล้ว', 'v' + APP_VERSION + ' — ' + APP_CHANGES, 12000), 800);
      store.set('dc_ver', APP_VERSION);
      setTimeout(() => this.check(), 3000);
      setInterval(() => this.check(), 60000);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.check(); });
      window.addEventListener('online', () => this.check());
    }
  };

  Install.init();
  Cmd.init();
  Staff.init();
  Updater.init();

  const role = params.get('role');
  if (role === 'commander' && Cmd.session()) Cmd.enter();
  else if (role === 'commander') go('cmd-login');
  else if (role === 'staff') Staff.enter();
  else if (Install.standalone && Staff.profile()) Staff.enter();
  else if (Install.standalone && Cmd.session()) Cmd.enter();
  else show('home');
})();
