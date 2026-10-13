'use strict';
// Play Along: plays a transcribed score with per-hand mute/volume, tempo, count-in,
// click, tap-a-measure to start, and looping. All audio is scheduled with Web Audio.

const $ = (id) => document.getElementById(id);
const LOOKAHEAD = 0.15;     // seconds of audio scheduled ahead of the playhead
const TICK_MS = 25;         // how often the scheduler wakes up
const STEP = 0.25;          // beats scheduled per scheduler step
const DEFAULT_VELOCITY = 80;
const HANDS = ['RH', 'LH'];

// ---------- audio graph ----------
const ctx = new (window.AudioContext || window.webkitAudioContext)();
// Music (piano hands and band): -> gentle compressor (keeps stacked chords from clipping) -> speakers.
const musicComp = ctx.createDynamicsCompressor();
musicComp.threshold.value = -10;
musicComp.ratio.value = 4;
// A fast limiter after it catches the peaks when the whole band and piano hit together.
const limiter = ctx.createDynamicsCompressor();
limiter.threshold.value = -4;
limiter.knee.value = 0;
limiter.ratio.value = 20;
limiter.attack.value = 0;
limiter.release.value = 0.1;
// Master volume: music goes compressor -> master -> limiter; the click's level is scaled to match.
const musicMaster = ctx.createGain();
musicComp.connect(musicMaster).connect(limiter).connect(ctx.destination);
// Click: its own path, so it isn't squashed by the piano's compressor. A soft clipper lets the
// volume go well past full scale; the tick just gets denser instead of distorting harshly.
const clickPre = ctx.createGain();
clickPre.gain.value = 0.25;
const clickShaper = ctx.createWaveShaper();
clickShaper.curve = Float32Array.from({ length: 2048 }, (_, i) => Math.tanh(4 * (i / 1023.5 - 1)));
clickShaper.oversample = '2x';
clickPre.connect(clickShaper).connect(ctx.destination);
const bus = {};
for (const name of ['RH', 'LH', 'click', 'countin', 'preview']) {
  bus[name] = ctx.createGain();
  bus[name].connect(HANDS.includes(name) ? musicComp : clickPre);
}
// Band instruments -> one band group (the "All instruments" slider) -> the music compressor.
const bandGroup = ctx.createGain();
bandGroup.connect(musicComp);
function partBus(part) {   // band instruments get their own volume control on first use
  if (!bus[part]) {
    bus[part] = ctx.createGain();
    bus[part].connect(bandGroup);
    applyMix(true);
  }
  return bus[part];
}
let sampleSets = {};      // set name -> { notes, level, oneShot, bufs: {midi: {buf, offset}} }
const active = new Set(); // sounding/scheduled nodes, so Stop can silence them

// ---------- volume in dB ----------
// Every volume slider runs in 1 dB steps; 0 dB is the balanced mix and the bottom means off.
const DB_OFF = -31;
const dbToGain = (db) => (db <= DB_OFF ? 0 : Math.pow(10, db / 20));
const dbText = (db) => (db <= DB_OFF ? 'Off' : `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db)} dB`);
const UNITY = 0.9;          // part-bus gain at 0 dB (the level the mix was balanced at)
const CLICK_UNITY = 2.45;   // click-bus gain at 0 dB

// ---------- settings (remembered on this device) ----------
const STORE = 'playalong:v1';
const S = Object.assign({
  song: null,
  rhOn: true, rhDb: 0,
  lhOn: true, lhDb: 0,
  clickOn: false, clickDb: 0, clickSound: 'metronome', clickAccent: false,
  countInBeats: 4, loopCountIn: true, pedal: true, view: 'measures',
  follow: true,      // the sheet scrolls to keep the current measure in view
  band: 'full',      // band arrangement: off / simple / moving / full
  masterDb: 0, bandDb: 0,
  inst: {},          // band instrument -> { on, db }
  perSong: {},
}, migrateVolumes(readStore()));
function readStore() {
  try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
}
// Earlier versions stored volumes as 0-100 slider positions; convert them to the same loudness in dB.
function migrateVolumes(o) {
  const toDb = (gain, unity, max = 6) =>
    Math.max(DB_OFF, Math.min(max, Math.round(20 * Math.log10(Math.max(gain, 1e-6) / unity))));
  const part = (v) => toDb(Math.pow(v / 100, 2) * 1.6, UNITY);
  const group = (v) => toDb(Math.pow(v / 75, 2), 1);
  const convert = { rhVol: ['rhDb', part], lhVol: ['lhDb', part], masterVol: ['masterDb', group], bandVol: ['bandDb', group],
    clickVol: ['clickDb', (v) => toDb(Math.pow(v / 100, 2) * 5, CLICK_UNITY, 12)] };
  for (const [old, [key, fn]] of Object.entries(convert)) {
    if (o[old] !== undefined) {
      if (o[key] === undefined) o[key] = fn(o[old]);
      delete o[old];
    }
  }
  for (const st of Object.values(o.inst || {})) {
    if (st.vol !== undefined) {
      if (st.db === undefined) st.db = part(st.vol);
      delete st.vol;
    }
  }
  return o;
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(S)); } catch { /* private mode etc. */ }
}
const songState = () => (S.perSong[S.song] ||= { tempo: null, start: 1, loop: false, loopEnd: null });

// ---------- song data ----------
let song = null;    // JSON from tools/export_web.py
let notes = [];     // flattened, sorted by beat: { beat, len, midi, part, set, vel, barEnd }
let lineOf = {};    // measure -> { page, line, last }

async function loadSong(id) {
  song = await (await fetch(`songs/${id}.json`)).json();
  sheet = null;
  $('sheet').innerHTML = '';
  buildNotes();
  lineOf = {};
  song.pages.forEach((lines, p) => lines.forEach((ms, l) => {
    for (const m of ms) lineOf[m] = { page: p + 1, line: l + 1, last: ms[ms.length - 1] };
  }));
  const st = songState();
  if (!st.tempo) st.tempo = song.tempo;
  if (st.start > song.measures.length) st.start = 1;
  renderMap();
  renderTempo();
  showIdle();
}

function bandVersion() {
  return song.band?.versions.find((v) => v.id === S.band) || null;
}
// Everything that plays, in time order: the piano hands plus the chosen band version.
function buildNotes() {
  const bpb = song.beatsPerBar;
  notes = [];
  song.measures.forEach((m, i) => {
    for (const hand of HANDS) {
      for (const [start, len, pitches, vel] of m[hand] || []) {
        for (const midi of pitches) {
          notes.push({ beat: i * bpb + start, len, midi, part: hand, set: 'piano', vel: vel || DEFAULT_VELOCITY, barEnd: (i + 1) * bpb });
        }
      }
    }
  });
  const version = bandVersion();
  for (const [part, events] of Object.entries(version?.parts || {})) {
    for (const [m, start, len, pitches, vel] of events) {
      for (const midi of pitches) {
        notes.push({ beat: (m - 1) * bpb + start, len, midi, part, set: part, vel, barEnd: m * bpb });
      }
    }
  }
  notes.sort((a, b) => a.beat - b.beat);
}

// ---------- samples ----------
function decode(ab) {
  return new Promise((resolve, reject) => ctx.decodeAudioData(ab, resolve, reject));
}
function onsetSeconds(buf) {
  // AAC adds a little silence at the start; skip it so notes land exactly on the beat.
  const d = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  const thr = peak * 0.02;
  for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > thr) return Math.max(0, i - 60) / buf.sampleRate;
  return 0;
}
let manifest = null;
async function loadSet(name, label) {
  manifest ||= await (await fetch('samples/index.json')).json();
  const spec = manifest[name];
  if (!spec || sampleSets[name]) return;
  const set = { ...spec, bufs: {} };
  let done = 0;
  await Promise.all(spec.notes.map(async (n) => {
    const buf = await decode(await (await fetch(`samples/${name}/${n}.m4a`)).arrayBuffer());
    set.bufs[n] = { buf, offset: onsetSeconds(buf) };
    if (label) $('status').textContent = `Loading ${label} ${++done}/${spec.notes.length}`;
  }));
  sampleSets[name] = set;
}
async function loadSamples() {
  await loadSet('piano', 'piano');
  renderTransport();   // the piano is enough to start playing
  const instruments = song.band?.instruments || [];
  for (const [i, inst] of instruments.entries()) {
    $('status').textContent = `Loading band ${i + 1}/${instruments.length}`;
    await loadSet(inst.id);
  }
}

// ---------- sound makers ----------
function track(src, gain) {
  const item = { src, gain };
  active.add(item);
  src.onended = () => { active.delete(item); gain.disconnect(); };
}
// Band level corrections (dB), measured in the app so the default mix matches the reviewed preview
// (the app plays both piano hands at the same volume, which made the band sit a little lower).
const BAND_TRIM_DB = { bass: 2.7, strings: 3.8, harp: 1.1, cello: 3.5, drums: 0.8 };
// How each kind of instrument lets go of a note: [extra ring in seconds, release time constant]
const RELEASE = { piano: [0, 0.06], strings: [0.1, 0.25], cello: [0.05, 0.2], harp: [1.2, 0.3], bass: [0, 0.08] };
function playNote(note, when, dur) {
  const set = sampleSets[note.set];
  if (!set) return;                       // still loading
  // the recorded note nearest to the one we need, pitch-shifted the rest of the way
  const n = set.notes.reduce((best, x) => (Math.abs(x - note.midi) < Math.abs(best - note.midi) ? x : best));
  const s = set.bufs[n];
  const src = ctx.createBufferSource();
  src.buffer = s.buf;
  if (n !== note.midi) src.playbackRate.value = Math.pow(2, (note.midi - n) / 12);
  const g = ctx.createGain();
  const trim = Math.pow(10, (BAND_TRIM_DB[note.set] || 0) / 20);
  const level = 0.55 * set.level * trim * Math.pow(note.vel / manifest.velocity, 2);
  g.gain.setValueAtTime(level, when);
  src.connect(g).connect(HANDS.includes(note.part) ? bus[note.part] : partBus(note.part));
  src.start(when, s.offset);
  if (set.oneShot) {
    src.stop(when + s.buf.duration);      // drums: let each hit ring out naturally
  } else {
    const [ring, tau] = RELEASE[note.set] || RELEASE.piano;
    const end = when + dur + ring;
    g.gain.setTargetAtTime(0, end, tau);  // key/pedal release
    src.stop(end + tau * 6);
  }
  track(src, g);
}
const noiseBuf = (() => {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.25), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
})();
function hitEnvelope(when, peak, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(peak, when + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, when + decay);
  return g;
}
function noiseHit(when, dest, filterType, freq, q, peak, decay) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = filterType;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = hitEnvelope(when, peak, decay);
  src.connect(f).connect(g).connect(dest);
  src.start(when);
  src.stop(when + decay + 0.02);
  track(src, g);
}
function toneHit(when, dest, wave, freq, peak, decay) {
  const osc = ctx.createOscillator();
  osc.type = wave;
  osc.frequency.value = freq;
  const g = hitEnvelope(when, peak, decay);
  osc.connect(g).connect(dest);
  osc.start(when);
  osc.stop(when + decay + 0.02);
  track(osc, g);
}
const CLICK_SOUNDS = {
  // Mechanical metronome: a bright, very short wooden tick.
  metronome(when, accent, dest) {
    noiseHit(when, dest, 'bandpass', accent ? 4300 : 3100, 1.6, 4.5, 0.045);
    toneHit(when, dest, 'triangle', accent ? 2600 : 1900, 1.2, 0.025);
  },
  // Woodblock: a pitched, hollow knock.
  woodblock(when, accent, dest) {
    const f = accent ? 1250 : 880;
    toneHit(when, dest, 'sine', f, 1.0, 0.08);
    toneHit(when, dest, 'sine', f * 2.76, 0.3, 0.03);
    noiseHit(when, dest, 'bandpass', f * 2, 1.5, 0.8, 0.01);
  },
  // Cowbell: two square waves through a band-pass, like a drum machine's.
  cowbell(when, accent, dest) {
    const k = accent ? 1.26 : 1;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2400 * k;
    f.Q.value = 0.8;
    const g = hitEnvelope(when, 1.6, 0.22);
    f.connect(g).connect(dest);
    for (const hz of [540 * k, 800 * k]) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = hz;
      osc.connect(f);
      osc.start(when);
      osc.stop(when + 0.24);
      track(osc, g);
    }
  },
  // Electronic beep.
  beep(when, accent, dest) {
    toneHit(when, dest, 'triangle', accent ? 1760 : 1320, 1.2, 0.07);
  },
};
function playClick(when, downbeat, dest) {
  (CLICK_SOUNDS[S.clickSound] || CLICK_SOUNDS.metronome)(when, S.clickAccent && downbeat, dest);
}
function silenceAll() {
  const t = ctx.currentTime;
  for (const { src, gain } of active) {
    try {
      gain.gain.cancelScheduledValues(t);
      gain.gain.setTargetAtTime(0, t, 0.015);
      src.stop(t + 0.08);
    } catch { /* already stopped */ }
  }
}

// ---------- mix ----------
const instState = (id) => (S.inst[id] ||= { on: true, db: 0 });
function applyMix(instant) {
  const set = (node, value) => instant ? (node.gain.value = value) : node.gain.setTargetAtTime(value, ctx.currentTime, 0.03);
  set(bus.RH, S.rhOn ? UNITY * dbToGain(S.rhDb) : 0);
  set(bus.LH, S.lhOn ? UNITY * dbToGain(S.lhDb) : 0);
  set(bus.click, S.clickOn ? CLICK_UNITY * dbToGain(S.clickDb) : 0);
  set(bus.countin, CLICK_UNITY * dbToGain(Math.max(S.clickDb, -12)));  // count-in stays audible even with the click off
  set(bus.preview, CLICK_UNITY * dbToGain(S.clickDb));
  set(musicMaster, dbToGain(S.masterDb));
  set(clickPre, 0.25 * dbToGain(S.masterDb));
  set(bandGroup, dbToGain(S.bandDb));
  const version = song && bandVersion();
  for (const inst of song?.band?.instruments || []) {
    if (!bus[inst.id]) continue;
    const st = instState(inst.id);
    set(bus[inst.id], st.on && version?.parts[inst.id] ? UNITY * dbToGain(st.db) : 0);
  }
}

// ---------- iPhone audio quirks ----------
let silentAudio = null;
function silentWavUrl() {
  const n = 4000, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
function unlockAudio() {
  // Must run inside a tap. Playing an <audio> element puts iOS into "playback" mode,
  // so the ring/silent switch doesn't mute the piano.
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* unsupported */ }
  if (!silentAudio) {
    silentAudio = new Audio(silentWavUrl());
    silentAudio.loop = true;
    silentAudio.setAttribute('playsinline', '');
  }
  silentAudio.play().catch(() => {});
  if (ctx.state !== 'running') ctx.resume();
}
let wakeLock = null;
async function keepAwake(on) {
  const video = $('keepawake');
  if (on) {
    if ('wakeLock' in navigator) {
      try { wakeLock = await navigator.wakeLock.request('screen'); return; } catch { /* needs https */ }
    }
    video.play().catch(() => {});
  } else {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    video.pause();
    if (silentAudio) silentAudio.pause();
  }
}

// ---------- transport ----------
// The scheduler walks "song beats" (beat 0 = start of measure 1). seg maps a song beat to
// an audio-clock time; it is re-anchored on tempo changes and loop wraps.
const P = { playing: false, timer: null, seg: null, cursor: 0, startBeat: 0, endBeat: 0, loop: null, ending: false, markers: [], raf: 0, lastStart: null };
const b2t = (b) => P.seg.t0 + (b - P.seg.b0) * 60 / songState().tempo;

function loopRange() {
  const st = songState();
  if (!st.loop) return null;
  return { from: st.start, to: Math.max(st.start, st.loopEnd || lineOf[st.start].last) };
}
function setLoopWindow() {
  const bpb = song.beatsPerBar, r = loopRange();
  P.loop = r ? { fromBeat: (r.from - 1) * bpb, toBeat: r.to * bpb } : null;
  P.endBeat = P.loop ? P.loop.toBeat : song.measures.length * bpb;
}

function start(measure) {
  stop(true);
  unlockAudio();
  const bpb = song.beatsPerBar;
  P.lastStart = measure;
  P.startBeat = (measure - 1) * bpb;
  setLoopWindow();
  P.cursor = P.startBeat - S.countInBeats;
  P.seg = { t0: ctx.currentTime + 0.12, b0: P.cursor };
  P.markers = [];
  P.ending = false;
  P.playing = true;
  P.timer = setInterval(tick, TICK_MS);
  tick();
  keepAwake(true);
  P.raf = requestAnimationFrame(frame);
  renderTransport();
}

function stop(silence) {
  const was = P.playing;
  P.playing = false;
  clearInterval(P.timer);
  cancelAnimationFrame(P.raf);
  P.markers = [];
  if (silence) silenceAll();
  if (was) keepAwake(false);
  document.querySelectorAll('.cur').forEach((b) => b.classList.remove('cur'));
  lightNotes(null);
  setBeatDots(0);
  renderTransport();
}

function tick() {
  if (!P.playing) return;
  const horizon = ctx.currentTime + LOOKAHEAD;
  while (b2t(P.cursor) < horizon) {
    if (P.cursor >= P.endBeat - 1e-9) {
      if (P.loop) {
        // Wrap to the loop start; optionally pause for a fresh count-in first.
        const lead = S.loopCountIn ? S.countInBeats : 0;
        P.startBeat = P.loop.fromBeat;   // beats before this are count-in clicks, not music
        P.seg = { t0: b2t(P.cursor), b0: P.startBeat - lead };
        P.cursor = P.startBeat - lead;
        continue;
      }
      if (!P.ending) { P.ending = true; P.markers.push({ t: b2t(P.cursor), done: true }); }
      break;
    }
    const next = Math.min(P.cursor + STEP, P.endBeat);
    schedule(P.cursor, next);
    P.cursor = next;
  }
}

function schedule(a, b) {
  const bpb = song.beatsPerBar;
  for (let k = Math.ceil(a - 1e-9); k < b - 1e-9; k++) {
    const t = b2t(k), pos = ((k % bpb) + bpb) % bpb, countIn = k < P.startBeat;
    if (countIn) playClick(t, pos === 0, bus.countin);
    else playClick(t, pos === 0, bus.click);   // click bus is muted when the click is off
    P.markers.push({ t, measure: Math.floor(k / bpb) + 1, beat: pos + 1, countIn, next: Math.floor(P.startBeat / bpb) + 1 });
  }
  if (b <= P.startBeat) return;
  const spb = 60 / songState().tempo;
  for (const n of notes) {
    if (n.beat < a - 1e-9 || n.beat < P.startBeat - 1e-9) continue;
    if (n.beat >= b - 1e-9) break;
    const pedalled = S.pedal && HANDS.includes(n.part);
    const end = pedalled ? Math.max(n.beat + n.len, n.barEnd) : n.beat + n.len;
    playNote(n, b2t(n.beat), (end - n.beat) * spb - 0.03);
  }
  if (sheet) {
    for (let i = 0; i < sheet.q.length; i++) {
      const q = sheet.q[i];
      if (q < a - 1e-9 || q < P.startBeat - 1e-9) continue;
      if (q >= b - 1e-9) break;
      P.markers.push({ t: b2t(q), noteIdx: i });
    }
  }
}

function setTempo(v) {
  v = Math.round(Math.min(160, Math.max(20, Number(v) || songState().tempo)));
  if (P.playing) P.seg = { t0: b2t(P.cursor), b0: P.cursor };  // re-anchor, then change speed
  songState().tempo = v;
  save();
  renderTempo();
}

// ---------- drawing ----------
function frame() {
  const now = ctx.currentTime - (ctx.outputLatency || 0);
  let mark = null;
  while (P.markers.length && P.markers[0].t <= now) {
    const m = P.markers.shift();
    if (m.done) { finish(); return; }
    if (m.noteIdx !== undefined) lightNotes(m.noteIdx);
    else mark = m;
  }
  if (mark) showPosition(mark);
  if (P.playing) P.raf = requestAnimationFrame(frame);
}
function finish() {
  stop(false);   // let the last chord ring
  $('now-main').textContent = 'The end';
  $('now-sub').textContent = `Restart to go again from measure ${P.lastStart}`;
}
function setBeatDots(beat, countIn) {
  const dots = $('beats');
  dots.classList.toggle('countin', !!countIn);
  [...dots.children].forEach((d, i) => d.classList.toggle('on', i === beat - 1));
}
const span = (r) => (r.from === r.to ? `measure ${r.from}` : `${r.from}–${r.to}`);
function where(m) {
  const l = lineOf[m];
  return l ? `Page ${l.page} · line ${l.line}` : '';
}
function showPosition(mark) {
  setBeatDots(mark.beat, mark.countIn);
  if (mark.countIn) {
    lightNotes(null);
    document.querySelectorAll('.cur').forEach((b) => b.classList.remove('cur'));
    $('now-main').textContent = `Count-in ${mark.beat}`;
    $('now-sub').textContent = `Measure ${mark.next} next · ${where(mark.next)}`;
    return;
  }
  $('now-main').textContent = `Measure ${mark.measure}`;
  const r = loopRange();
  $('now-sub').textContent = where(mark.measure) + (r ? ` · looping ${span(r)}` : '');
  document.querySelectorAll('.cur').forEach((b) => b.classList.remove('cur'));
  document.querySelector(`.m[data-m="${mark.measure}"]`)?.classList.add('cur');
  const box = sheet && sheet.rects[mark.measure];
  if (box) {
    box.classList.add('cur');
    if (S.view === 'sheet' && S.follow && mark.beat === 1) keepInView(box);
  }
}
function showIdle() {
  const st = songState();
  $('now-main').textContent = `Measure ${st.start}`;
  $('now-sub').textContent = where(st.start);
  setBeatDots(0);
}

// ---------- sheet music ----------
let sheet = null;   // { rects: {measure: <rect>}, q: [beats], activeAt: [[note ids]], lit: [elements] }

async function loadSheet() {
  if (sheet || !song.sheet) return;
  const base = `songs/${song.id}/`;
  const data = await (await fetch(base + 'sheet.json')).json();
  const box = $('sheet');
  box.innerHTML = '';
  for (const name of data.pages) {
    const page = document.createElement('div');
    page.className = 'sheet-page';
    page.innerHTML = await (await fetch(base + name)).text();
    box.appendChild(page);
  }
  // A box behind each measure, spanning both staves: shows the loop/current measure and catches taps.
  const rects = {};
  for (const [id, n] of Object.entries(data.measures)) {
    const g = document.getElementById(id);
    if (!g) continue;
    g.dataset.m = n;
    const mb = g.getBBox(), sb = (g.closest('g.system') || g).getBBox();
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('x', mb.x);
    r.setAttribute('width', mb.width);
    r.setAttribute('y', sb.y);
    r.setAttribute('height', sb.height);
    r.setAttribute('class', 'mbox');
    r.dataset.m = n;
    g.parentNode.insertBefore(r, g);
    rects[n] = r;
  }
  // Which notes are sounding at each point in the time map.
  const sounding = new Set(), activeAt = [];
  for (const e of data.timemap) {
    e.off.forEach((id) => sounding.delete(id));
    e.on.forEach((id) => sounding.add(id));
    activeAt.push([...sounding]);
  }
  sheet = { rects, q: data.timemap.map((e) => e.q), activeAt, lit: [] };
  renderMap();
}

function lightNotes(i) {
  if (!sheet) return;
  for (const el of sheet.lit) el.classList.remove('playing');
  sheet.lit = i === null ? [] : sheet.activeAt[i].map((id) => document.getElementById(id)).filter(Boolean);
  for (const el of sheet.lit) el.classList.add('playing');
}

function keepInView(el) {
  const sc = document.querySelector('.scroller');
  const r = el.getBoundingClientRect(), view = sc.getBoundingClientRect();
  if (r.top < view.top + 8 || r.bottom > view.bottom - 8) {
    sc.scrollTo({ top: sc.scrollTop + (r.top - view.top) - view.height * 0.15, behavior: 'smooth' });
  }
}

async function setView(view) {
  S.view = view;
  save();
  document.querySelectorAll('#view button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  $('pages').hidden = view !== 'measures';
  $('sheet').hidden = view !== 'sheet';
  $('follow-wrap').hidden = view !== 'sheet';
  document.querySelector('.map').classList.toggle('sheet-mode', view === 'sheet');
  if (view === 'sheet') await loadSheet();   // measured after it is visible, so sizes are real
}

// Press and hold a measure, then drag across measures to loop them (works in both views).
// A quick swipe still scrolls; a quick tap still picks a start measure.
let suppressClick = false;
function measureAt(x, y) {
  const hit = document.elementFromPoint(x, y)?.closest('[data-m]');
  return hit ? Number(hit.dataset.m) : null;
}
function previewRange(a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  document.querySelectorAll('.m, .mbox').forEach((el) => {
    const m = Number(el.dataset.m);
    el.classList.toggle('inloop', m >= lo && m <= hi);
    el.classList.toggle('sel', m === lo);
  });
}
function commitRange(a, b) {
  const st = songState();
  st.start = Math.min(a, b);
  st.loopEnd = Math.max(a, b);
  st.loop = true;
  $('loop').checked = true;
  awaitingLoopEnd = false;
  save();
  renderMap();
  if (P.playing) start(st.start);
  else showIdle();
}
function attachRangeGesture(el) {
  let timer = null, from = null, to = null, origin = null, selecting = false;
  const reset = () => { clearTimeout(timer); timer = null; selecting = false; from = null; };
  el.addEventListener('touchstart', (e) => {
    reset();
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    from = to = measureAt(t.clientX, t.clientY);
    if (from === null) return;
    origin = [t.clientX, t.clientY];
    timer = setTimeout(() => { selecting = true; previewRange(from, to); }, 350);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (selecting) {
      e.preventDefault();   // hold-and-drag selects instead of scrolling
      const m = measureAt(t.clientX, t.clientY);
      if (m !== null && m !== to) { to = m; previewRange(from, to); }
    } else if (timer && Math.hypot(t.clientX - origin[0], t.clientY - origin[1]) > 10) {
      reset();              // moved early: it's a scroll
    }
  }, { passive: false });
  el.addEventListener('touchend', (e) => {
    if (selecting) { e.preventDefault(); commitRange(from, to); }
    reset();
  });
  el.addEventListener('touchcancel', () => { if (selecting) renderMap(); reset(); });
  // Mouse: press and drag across measures.
  el.addEventListener('mousedown', (e) => { from = to = measureAt(e.clientX, e.clientY); selecting = false; });
  el.addEventListener('mousemove', (e) => {
    if (from === null || !(e.buttons & 1)) return;
    const m = measureAt(e.clientX, e.clientY);
    if (m !== null && m !== to) { to = m; selecting = true; previewRange(from, to); }
  });
  window.addEventListener('mouseup', () => {
    if (selecting) { commitRange(from, to); suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); }
    selecting = false;
    from = null;
  });
}

// ---------- UI ----------
let awaitingLoopEnd = false;

function renderMap() {
  const st = songState(), r = loopRange();
  const box = $('pages');
  box.innerHTML = '';
  song.pages.forEach((lines, p) => {
    const page = document.createElement('div');
    page.innerHTML = `<div class="page-label">Page ${p + 1}</div>`;
    for (const ms of lines) {
      const row = document.createElement('div');
      row.className = 'line';
      for (const m of ms) {
        const b = document.createElement('button');
        b.className = 'm';
        b.dataset.m = m;
        b.textContent = m;
        if (m === st.start) b.classList.add('sel');
        if (r && m >= r.from && m <= r.to) b.classList.add('inloop');
        row.appendChild(b);
      }
      page.appendChild(row);
    }
    box.appendChild(page);
  });
  if (sheet) {
    for (const [m, box] of Object.entries(sheet.rects)) {
      box.classList.toggle('sel', Number(m) === st.start);
      box.classList.toggle('inloop', !!r && m >= r.from && m <= r.to);
    }
  }
  $('map-hint').textContent = r
    ? (awaitingLoopEnd ? `Looping ${span(r)}. Tap the last measure of your loop, or press and hold, then drag.` : `Looping ${span(r)}. Tap a measure to start a new loop there.`)
    : `Play starts at measure ${st.start}. Tap a measure to start there. To loop a section, press and hold, then drag.`;
  renderTransport();
}

function onMeasureTap(m) {
  const st = songState();
  if (st.loop) {
    if (awaitingLoopEnd && m >= st.start) {
      st.loopEnd = m;            // only moves the loop's end; playback carries on
      awaitingLoopEnd = false;
      save();
      renderMap();
      if (P.playing) setLoopWindow();
      return;
    } else {
      st.start = m;
      st.loopEnd = lineOf[m].last;
      awaitingLoopEnd = true;
    }
  } else {
    st.start = m;
  }
  save();
  renderMap();
  if (P.playing) start(st.start);
  else showIdle();
}

function renderTransport() {
  const st = songState();
  document.body.classList.toggle('is-playing', P.playing);
  const ready = !!song && !!sampleSets.piano;
  $('play').disabled = !ready;
  $('play').classList.toggle('stop', P.playing);
  $('play-label').textContent = P.playing ? '■ Stop' : `▶ Play from ${st.start}`;
  $('play').setAttribute('aria-label', P.playing ? 'Stop' : 'Play');
  const again = P.lastStart || st.start;
  $('restart').disabled = !ready;
  $('restart-label').textContent = `⟲ Restart ${again}`;
}

// A dB slider with its readout; tapping the readout snaps back to 0 dB.
function bindDb(slider, readout, get, put, max = 6) {
  slider.min = DB_OFF;
  slider.max = max;
  slider.step = 1;
  const show = () => { slider.value = get(); readout.textContent = dbText(get()); };
  slider.addEventListener('input', () => { put(Number(slider.value)); readout.textContent = dbText(Number(slider.value)); save(); applyMix(); });
  readout.addEventListener('click', () => { put(0); show(); save(); applyMix(); });
  readout.setAttribute('aria-label', 'Reset to 0 dB');
  show();
}
function dbReadout() {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'db';
  return b;
}

// ---------- band ----------
function renderBand() {
  const card = $('band-card');
  card.hidden = !song.band;
  if (!song.band) return;
  document.querySelectorAll('#band button').forEach((b) => b.classList.toggle('on', b.dataset.band === S.band));
  const version = bandVersion();
  const box = $('band-mix');
  box.innerHTML = '';
  for (const inst of song.band.instruments) {
    const st = instState(inst.id);
    const inVersion = !!version?.parts[inst.id];
    const firstVersion = song.band.versions.find((v) => v.parts[inst.id]);
    const label = document.createElement('label');
    label.className = 'switch' + (inVersion ? '' : ' absent');
    label.innerHTML = `<input type="checkbox" id="inst-${inst.id}-on"><span>${inst.name}</span>`;
    const toggle = label.querySelector('input');
    toggle.checked = st.on;
    toggle.disabled = !inVersion;
    toggle.addEventListener('change', () => { st.on = toggle.checked; save(); applyMix(); });
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.id = `inst-${inst.id}-vol`;
    slider.disabled = !inVersion;
    slider.setAttribute('aria-label', `${inst.name} volume`);
    const readout = dbReadout();
    readout.disabled = !inVersion;
    bindDb(slider, readout, () => st.db, (v) => { st.db = v; });
    box.append(label, slider, readout);
    if (!inVersion && firstVersion && S.band !== 'off') {
      const last = song.band.versions[song.band.versions.length - 1];
      const when = firstVersion === last ? `${last.name} only` : `from ${firstVersion.name}`;
      label.querySelector('span').textContent = `${inst.name} (${when})`;
    }
  }
  $('band-hint').textContent = S.band === 'off'
    ? 'Just you and the piano.'
    : { simple: 'Soft drums, bass and a string pad.', moving: 'Adds harp and moving strings.', full: 'Adds the cello countermelody and a busier groove.' }[S.band] || '';
}
function setBand(id) {
  S.band = id;
  save();
  buildNotes();     // takes effect right away, even mid-song
  renderBand();
  applyMix();
}

function renderTempo() {
  const st = songState();
  $('tempo').value = st.tempo;
  $('tempo-slider').value = st.tempo;
  $('tempo-orig').textContent = song.tempo;
}

function bindControls() {
  for (const view of ['pages', 'sheet']) {
    $(view).addEventListener('click', (e) => {
      const hit = e.target.closest('[data-m]');
      if (hit && !suppressClick) onMeasureTap(Number(hit.dataset.m));
    });
    attachRangeGesture($(view));
  }
  $('follow').addEventListener('change', () => {
    const current = document.querySelector('.mbox.cur');
    if (S.follow && current) keepInView(current);   // turning it back on jumps to where the music is
  });
  $('band').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setBand(b.dataset.band);
  });
  $('view').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setView(b.dataset.view);
  });
  const ready = () => !$('play').disabled;
  const playOrStop = () => (P.playing ? stop(true) : start(songState().start));
  const restart = () => {
    const st = songState();
    start(st.loop ? st.start : (P.lastStart || st.start));
  };
  $('play').addEventListener('click', playOrStop);
  $('restart').addEventListener('click', restart);
  document.querySelector('.now').addEventListener('click', () => { if (ready()) restart(); });

  // Bluetooth page-turner pedals and keyboards: left pedal (or ←/↑/PageUp/R) restarts,
  // right pedal (or →/↓/PageDown/Space/Enter) plays or stops.
  const RESTART_KEYS = ['ArrowLeft', 'ArrowUp', 'PageUp', 'KeyR'];
  const PLAY_KEYS = ['ArrowRight', 'ArrowDown', 'PageDown', 'Space', 'Enter', 'NumpadEnter'];
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t.tagName === 'SELECT' || (t.tagName === 'INPUT' && !['checkbox', 'range'].includes(t.type))) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const isRestart = RESTART_KEYS.includes(e.code), isPlay = PLAY_KEYS.includes(e.code);
    if (!isRestart && !isPlay) return;
    e.preventDefault();             // keep the key from also moving a slider or pressing a focused button
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    if (e.repeat || !ready()) return;
    if (isRestart) restart(); else playOrStop();
  });

  $('loop').addEventListener('change', (e) => {
    const st = songState();
    st.loop = e.target.checked;
    if (st.loop && !(st.loopEnd >= st.start)) st.loopEnd = lineOf[st.start].last;
    awaitingLoopEnd = st.loop;
    save();
    renderMap();
    if (P.playing) setLoopWindow();
  });

  document.querySelectorAll('.step').forEach((b) =>
    b.addEventListener('click', () => setTempo(songState().tempo + Number(b.dataset.step))));
  $('tempo').addEventListener('change', (e) => setTempo(e.target.value));
  $('tempo-slider').addEventListener('input', (e) => setTempo(e.target.value));
  $('tempo-reset').addEventListener('click', () => setTempo(song.tempo));

  const toggles = { 'rh-on': 'rhOn', 'lh-on': 'lhOn', 'click-on': 'clickOn', 'click-accent': 'clickAccent', 'loop-countin': 'loopCountIn', pedal: 'pedal', follow: 'follow' };
  for (const [id, key] of Object.entries(toggles)) {
    $(id).checked = S[key];
    $(id).addEventListener('change', (e) => { S[key] = e.target.checked; save(); applyMix(); });
  }
  const sliders = { 'rh-vol': ['rhDb', 6], 'lh-vol': ['lhDb', 6], 'click-vol': ['clickDb', 12], 'master-vol': ['masterDb', 6], 'band-vol': ['bandDb', 6] };
  for (const [id, [key, max]] of Object.entries(sliders)) {
    const readout = dbReadout();
    $(id).after(readout);
    bindDb($(id), readout, () => S[key], (v) => { S[key] = v; }, max);
  }

  // Let the player hear the click while choosing its sound or volume.
  const previewClick = () => {
    unlockAudio();
    applyMix(true);
    const t = ctx.currentTime + 0.05;
    for (let i = 0; i < 2; i++) playClick(t + i * 0.45, i === 0, bus.preview);
  };
  const renderClickSound = () => document.querySelectorAll('#click-sound button').forEach((b) =>
    b.classList.toggle('on', b.dataset.sound === S.clickSound));
  $('click-sound').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.clickSound = b.dataset.sound;
    save();
    renderClickSound();
    if (!P.playing) previewClick();
  });
  $('click-vol').addEventListener('change', () => { if (!P.playing) previewClick(); });
  renderClickSound();

  const renderCountIn = () => document.querySelectorAll('#countin-beats button').forEach((b) =>
    b.classList.toggle('on', Number(b.dataset.beats) === S.countInBeats));
  $('countin-beats').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.countInBeats = Number(b.dataset.beats);
    save();
    renderCountIn();
  });
  renderCountIn();

  $('song').addEventListener('change', async (e) => {
    stop(true);
    S.song = e.target.value;
    save();
    await loadSong(S.song);
    $('loop').checked = songState().loop;
    await setView(S.view === 'sheet' && song.sheet ? 'sheet' : 'measures');
    renderBand();
    loadSamples();
  });
}

async function main() {
  bindControls();
  applyMix(true);
  const list = await (await fetch('songs/index.json')).json();
  if (!list.some((s) => s.id === S.song)) S.song = list[0].id;
  $('song').innerHTML = list.map((s) => `<option value="${s.id}">${s.title}</option>`).join('');
  $('song').value = S.song;
  await loadSong(S.song);
  $('loop').checked = songState().loop;
  await setView(S.view === 'sheet' && song.sheet ? 'sheet' : 'measures');
  renderBand();
  try {
    await loadSamples();
    $('status').textContent = '';
  } catch (err) {
    $('status').textContent = 'Could not load piano sounds';
    console.error(err);
  }
  renderTransport();
}
main();
