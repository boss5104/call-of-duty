/* Call Of Duty Modern Warfare — ระบบเรียกปฏิบัติหน้าที่ (client) */
(() => {
  'use strict';

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
  const Sound = {
    ctx: null, out: null, boost: null, timer: null, vibTimer: null, src: null, noise: null,
    fileBuf: null, fileState: 'idle', // idle | loading | ok | none

    unlock() {
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) {} // iOS: ดังแม้เปิดโหมดเงียบ
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

    /* ขยายเสียง → ลิมิตเตอร์ → ส่งออกเต็ม 0 dBFS (ดังที่สุดเท่าที่เบราว์เซอร์ส่งออกได้) */
    buildChain() {
      const c = this.ctx;
      this.boost = c.createGain();
      this.boost.gain.value = Math.min(6, Math.max(1, Number(CFG.ALARM_BOOST) || 4));
      const lim = c.createDynamicsCompressor();
      lim.threshold.value = -12; lim.knee.value = 0; lim.ratio.value = 20;
      lim.attack.value = 0.001; lim.release.value = 0.08;
      const makeup = c.createGain();
      makeup.gain.value = 2.2;
      const clip = c.createWaveShaper(); // soft clip กันเสียงแตกหนักเกินไปแต่ยังดังเต็มที่
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
          if (this.timer) { this.stopLoops(); this.startAlarm(); } // สลับจากเสียงสังเคราะห์เป็นไฟล์ทันที
        })
        .catch(() => { this.fileState = 'none'; });
    },

    get ready() { return !!this.ctx && this.ctx.state === 'running'; },

    tone(freq, at, dur, type = 'sine', vol = .2, dest) {
      const c = this.ctx; if (!c) return;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, at);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(vol, at + .01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g); g.connect(dest || this.out || c.destination);
      o.start(at); o.stop(at + dur + .05);
    },
    kick(at) {
      const c = this.ctx, o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(160, at); o.frequency.exponentialRampToValueAtTime(42, at + .18);
      g.gain.setValueAtTime(1, at); g.gain.exponentialRampToValueAtTime(0.001, at + .32);
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
    stab(notes, at, dur = .22, vol = .32) { notes.forEach(f => { this.tone(f, at, dur, 'sawtooth', vol); this.tone(f * 1.006, at, dur, 'square', vol * .5); }); },

    /* มาร์ชทหารสังเคราะห์ (แต่งขึ้นเอง) + ไซเรน — ใช้เมื่อไม่มีไฟล์ assets/alarm.mp3 */
    marchBar() {
      const t = this.ctx.currentTime + .03, q = 60 / 132; // 132 BPM, 4/4
      const Dm = [146.8, 174.6, 220], Bb = [116.5, 146.8, 174.6], C = [130.8, 164.8, 196], A = [110, 138.6, 164.8];
      for (let i = 0; i < 4; i++) this.kick(t + i * q);
      this.kick(t + 3.5 * q);
      this.snare(t + q); this.snare(t + 3 * q);
      [3.25, 3.5, 3.75].forEach(b => this.snare(t + b * q, .5));
      this.stab(Dm, t); this.stab(Dm, t + .75 * q, .14); this.stab(Bb, t + 1.5 * q);
      this.stab(C, t + 2 * q); this.stab(A, t + 2.75 * q, .14); this.stab(Dm, t + 3 * q, .4);
      for (let i = 0; i < 8; i++) this.tone(i % 2 ? 880 : 1174.7, t + i * q / 2, q / 2 - .03, 'square', .22); // ไซเรน
      return q * 4 * 1000;
    },

    startAlarm() {
      this.unlock();
      if (!this.ctx) return;
      if (!this.timer && !this.src) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        if (this.fileBuf) {
          const s = this.ctx.createBufferSource();
          s.buffer = this.fileBuf; s.loop = true; s.connect(this.out); s.start();
          this.src = s;
          this.timer = setInterval(() => { if (this.ctx.state === 'suspended') this.ctx.resume(); }, 1000);
        } else {
          const ms = this.marchBar();
          this.timer = setInterval(() => { if (this.ctx.state === 'suspended') this.ctx.resume(); this.marchBar(); }, ms);
        }
      }
      if (!this.vibTimer && 'vibrate' in navigator) {
        const v = () => { try { navigator.vibrate([900, 200, 900, 200, 900]); } catch (_) {} };
        v(); this.vibTimer = setInterval(v, 3000);
      }
    },
    stopLoops() {
      clearInterval(this.timer); this.timer = null;
      if (this.src) { try { this.src.stop(); } catch (_) {} this.src.disconnect(); this.src = null; }
    },
    stopAlarm() {
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
  }

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
      const opt = { body, tag, renotify: true, requireInteraction: !!urgent, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', vibrate: urgent ? [700, 250, 700, 250, 700, 250, 700] : [200] };
      try {
        const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.getRegistration());
        if (reg) return reg.showNotification(title, opt);
        new Notification(title, opt);
      } catch (_) {}
    },
    async clear(tag) {
      try {
        const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.getRegistration());
        if (reg) (await reg.getNotifications({ tag })).forEach(n => n.close());
      } catch (_) {}
    }
  };

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
      if (Staff.active) Staff.poll();
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
      show('cmd-login'); setTimeout(() => $('#cmdLoginForm [name=user]').focus(), 50); return;
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
    session() { return store.get('dc_cmd'); },
    async login(user, pin) {
      user = String(user || '').trim().toLowerCase();
      if (user !== 'commander' || pin !== '9999') throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
      if (LIVE) await API.call('login', { user, pin });
      store.set('dc_cmd', { user, pin });
    },
    enter() {
      show('cmd');
      history.replaceState(null, '', '?role=commander');
      this.renderPresets(); this.renderTargets();
      this.active = true; this.seenAcks = null;
      this.poll();
      clearInterval(this.timer);
      this.timer = setInterval(() => this.poll(), CFG.COMMANDER_POLL_MS);
    },
    stop() { this.active = false; clearInterval(this.timer); this.timer = null; },
    logout() { this.stop(); store.del('dc_cmd'); go('home'); },
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
        if (/รหัสผ่าน/.test(e.message)) { toast('err', 'เซสชันหมดอายุ', 'กรุณาเข้าสู่ระบบใหม่'); this.logout(); }
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
          <div class="ack-item pending"><span class="ai-ico">…</span><span class="ai-name">${esc(s.nickname)}<small>${esc(s.firstName)} ${esc(s.lastName)} · ${esc(s.team)}</small></span><span class="ai-time">${s.online ? '<span class="presence on">ออนไลน์</span>' : '<span class="presence">ออฟไลน์</span>'}</span></div>`).join('');
        return `
          <div class="call-card ${c.priority === 'critical' ? 'critical' : ''}">
            <div class="call-top">
              <div>
                <div class="call-msg">${esc(c.message)}</div>
                <div class="call-sub">${fmtDateTime(c.createdAt)} · ผู้รับ: ${c.target === 'ALL' || !c.target ? 'ทุกคน' : esc(c.target)}</div>
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
      const q = this.search.trim().toLowerCase();
      const roster = staff.filter(s => !q || [s.firstName, s.lastName, s.nickname, s.team, s.lineId].join(' ').toLowerCase().includes(q))
        .sort((a, b) => (b.online - a.online) || String(a.team).localeCompare(b.team, 'th') || String(a.nickname).localeCompare(b.nickname, 'th'));
      setHTML($('#roster'), roster.length ? roster.map(s => `
        <div class="person">
          <div class="avatar">${esc(initials(s.nickname))}</div>
          <div class="person-main">
            <div class="person-name">${esc(s.nickname)} · ${esc(s.firstName)} ${esc(s.lastName)}</div>
            <div class="person-meta">${esc(s.team)} · LINE: ${esc(s.lineId)}</div>
          </div>
          <span class="presence ${s.online ? 'on' : ''}" title="${esc(ago(s.lastSeen))}">${s.online ? 'ออนไลน์' : esc(ago(s.lastSeen))}</span>
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
      if (!await confirmBox('ยืนยันการส่งสัญญาณเรียก', `“${message}” ถึง ${tgt}`, 'ส่งสัญญาณ')) return;
      const btn = $('#sendCallBtn'); btn.disabled = true;
      try {
        await API.call('createCall', Object.assign(this.creds(), { message, detail, priority: p.priority, target: this.target }));
        toast('info', 'ส่งสัญญาณเรียกแล้ว', `${message} → ${tgt}`);
        $('#callDetail').value = ''; $('#customMsg').value = '';
        this.preset = null; this.renderPresets();
        await this.poll();
      } catch (e) { toast('err', 'ส่งสัญญาณไม่สำเร็จ', e.message); }
      finally { btn.disabled = false; }
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
        try { await this.login(f.user.value, f.pin.value); f.reset(); this.enter(); }
        catch (ex) { err.textContent = ex.message; err.hidden = false; }
        finally { btn.disabled = false; }
      });
      $('#presetGrid').addEventListener('click', e => {
        const b = e.target.closest('[data-preset]'); if (!b) return;
        this.preset = b.dataset.preset; this.renderPresets();
        if (this.preset === 'custom') $('#customMsg').focus();
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

    showReg(edit) {
      this.stop();
      show('staff-reg');
      const f = $('#regForm'), p = this.profile() || {};
      $('#regTitle').textContent = edit ? 'แก้ไขข้อมูลส่วนตัว' : 'ลงทะเบียนผู้ใต้บังคับบัญชา';
      $('#regSubmit').textContent = edit ? 'บันทึกข้อมูล' : 'ลงทะเบียน';
      ['firstName', 'lastName', 'nickname', 'team', 'lineId'].forEach(k => { f[k].value = edit ? (p[k] || '') : (f[k].value || ''); f[k].classList.remove('invalid'); });
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
      await Wake.on();
      $('#gate').hidden = true;
      this.renderChecks();
      if (this.queue.length) this.ring();
    },

    start() {
      if (this.active) return;
      this.active = true;
      this.poll();
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
      Sound.startAlarm();
      if (!this._title) { this._title = document.title; this._flip = setInterval(() => { document.title = document.title === '🚨 มีการเรียก!' ? this._title : '🚨 มีการเรียก!'; }, 900); }
    },

    hideAlarm() {
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

    renderChecks() {
      const set = (id, ok, text) => { const el = $(id); el.classList.toggle('ok', ok === true); el.classList.toggle('bad', ok === false); $('em', el).textContent = text; };
      set('#ckSound', Sound.ready ? true : false, Sound.ready ? 'พร้อม' : 'แตะเพื่อเปิด');
      if (!Notify.supported) set('#ckNotif', null, 'ไม่รองรับ');
      else set('#ckNotif', Notify.granted ? true : Notification.permission === 'denied' ? false : null, Notify.granted ? 'เปิดแล้ว' : Notification.permission === 'denied' ? 'ถูกปิดกั้น' : 'ยังไม่อนุญาต');
      set('#ckWake', 'wakeLock' in navigator ? !!Wake.lock : null, !('wakeLock' in navigator) ? 'ไม่รองรับ' : Wake.lock ? 'เปิดอยู่' : 'ปิด');
      set('#ckConn', this.online === null ? null : this.online, this.online === null ? 'กำลังเชื่อมต่อ' : this.online ? (LIVE ? 'ออนไลน์' : 'โหมดทดลอง') : 'ขาดการเชื่อมต่อ');
      $('#enableNotifBtn').hidden = !(Notify.supported && Notification.permission === 'default');
    },

    init() {
      const dl = $('#teamList');
      dl.innerHTML = (CFG.TEAMS || []).map(t => `<option value="${esc(t)}">`).join('');

      $('#regForm').addEventListener('submit', async e => {
        e.preventDefault();
        Sound.unlock();
        const f = e.currentTarget, err = $('#regError'), btn = $('#regSubmit');
        const keys = ['firstName', 'lastName', 'nickname', 'team', 'lineId'];
        const data = {};
        let bad = null;
        keys.forEach(k => { data[k] = f[k].value.trim(); const miss = !data[k]; f[k].classList.toggle('invalid', miss); if (miss && !bad) bad = f[k]; });
        if (bad) { err.textContent = 'กรุณากรอกข้อมูลให้ครบทุกช่อง'; err.hidden = false; bad.focus(); return; }
        err.hidden = true; btn.disabled = true;
        const prev = this.profile();
        try {
          const r = await API.call('register', Object.assign({ staffId: prev && prev.staffId }, data));
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
      $('#enableNotifBtn').addEventListener('click', async () => { await Notify.request(); this.renderChecks(); });
      $('#testAlarmBtn').addEventListener('click', async () => {
        Sound.unlock();
        Sound.startAlarm();
        $('#testAlarmBtn').disabled = true;
        await sleep(4000);
        if (!this.queue.length) Sound.stopAlarm();
        $('#testAlarmBtn').disabled = false;
        this.renderChecks();
      });
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

  $('#logoutBtn').addEventListener('click', async () => {
    if (current === 'cmd') return Cmd.logout();
    if (current === 'staff') {
      if (await confirmBox('ออกจากเวร?', 'คุณจะไม่ได้รับสัญญาณเรียกจนกว่าจะเปิดหน้านี้อีกครั้ง', 'ออกจากเวร')) go('home');
    }
  });

  Install.init();
  Cmd.init();
  Staff.init();

  const role = params.get('role');
  if (role === 'commander' && Cmd.session()) Cmd.enter();
  else if (role === 'commander') go('cmd-login');
  else if (role === 'staff') Staff.enter();
  else if (Install.standalone && Staff.profile()) Staff.enter();
  else if (Install.standalone && Cmd.session()) Cmd.enter();
  else show('home');
})();
