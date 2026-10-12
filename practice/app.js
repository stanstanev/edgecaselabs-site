'use strict';
// Play Along: plays a transcribed score with per-hand mute/volume, tempo, count-in,
// click, tap-a-measure to start, and looping. All audio is scheduled with Web Audio.

const $ = (id) => document.getElementById(id);
const LOOKAHEAD = 0.15;     // seconds of audio scheduled ahead of the playhead
const TICK_MS = 25;         // how often the scheduler wakes up
const STEP = 0.25;          // beats scheduled per scheduler step
const SAMPLE_LOW = 36, SAMPLE_HIGH = 84;   // samples/piano/36.m4a .. 84.m4a (C2..C6)
const DEFAULT_VELOCITY = 80;

// ---------- audio graph ----------
const ctx = new (window.AudioContext || window.webkitAudioContext)();
const master = ctx.createDynamicsCompressor();   // keeps stacked chords from clipping
master.threshold.value = -10;
master.ratio.value = 4;
master.connect(ctx.destination);
const bus = {};
for (const name of ['RH', 'LH', 'click', 'countin']) {
  bus[name] = ctx.createGain();
  bus[name].connect(master);
}
const samples = {};       // midi -> { buf, offset }
const active = new Set(); // sounding/scheduled nodes, so Stop can silence them

// ---------- settings (remembered on this device) ----------
const STORE = 'playalong:v1';
const S = Object.assign({
  song: null,
  rhOn: true, rhVol: 75,
  lhOn: true, lhVol: 75,
  clickOn: false, clickVol: 70,
  countInBeats: 4, loopCountIn: true, pedal: true,
  perSong: {},
}, readStore());
function readStore() {
  try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(S)); } catch { /* private mode etc. */ }
}
const songState = () => (S.perSong[S.song] ||= { tempo: null, start: 1, loop: false, loopEnd: null });

// ---------- song data ----------
let song = null;    // JSON from tools/export_web.py
let notes = [];     // flattened, sorted by beat: { beat, len, midi, hand, vel, barEnd }
let lineOf = {};    // measure -> { page, line, last }

async function loadSong(id) {
  song = await (await fetch(`songs/${id}.json`)).json();
  const bpb = song.beatsPerBar;
  notes = [];
  song.measures.forEach((m, i) => {
    for (const hand of ['RH', 'LH']) {
      for (const [start, len, pitches, vel] of m[hand] || []) {
        for (const midi of pitches) {
          notes.push({ beat: i * bpb + start, len, midi, hand, vel: vel || DEFAULT_VELOCITY, barEnd: (i + 1) * bpb });
        }
      }
    }
  });
  notes.sort((a, b) => a.beat - b.beat);
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
async function loadSamples() {
  let done = 0;
  const total = SAMPLE_HIGH - SAMPLE_LOW + 1;
  const jobs = [];
  for (let n = SAMPLE_LOW; n <= SAMPLE_HIGH; n++) {
    jobs.push((async () => {
      const buf = await decode(await (await fetch(`samples/piano/${n}.m4a`)).arrayBuffer());
      samples[n] = { buf, offset: onsetSeconds(buf) };
      $('status').textContent = `Loading piano ${++done}/${total}`;
    })());
  }
  await Promise.all(jobs);
}

// ---------- sound makers ----------
function track(src, gain) {
  const item = { src, gain };
  active.add(item);
  src.onended = () => { active.delete(item); gain.disconnect(); };
}
function playNote(midi, when, dur, hand, vel) {
  const n = Math.min(SAMPLE_HIGH, Math.max(SAMPLE_LOW, midi));
  const s = samples[n];
  if (!s) return;
  const src = ctx.createBufferSource();
  src.buffer = s.buf;
  if (n !== midi) src.playbackRate.value = Math.pow(2, (midi - n) / 12);
  const g = ctx.createGain();
  const level = 0.55 * Math.pow(vel / DEFAULT_VELOCITY, 1.5);
  g.gain.setValueAtTime(level, when);
  g.gain.setTargetAtTime(0, when + dur, 0.06);  // key/pedal release
  src.connect(g).connect(bus[hand]);
  src.start(when, s.offset);
  src.stop(when + dur + 0.5);
  track(src, g);
}
function playClick(when, accent, dest) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = accent ? 1568 : 1046;
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(accent ? 0.9 : 0.55, when + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
  osc.connect(g).connect(dest);
  osc.start(when);
  osc.stop(when + 0.07);
  track(osc, g);
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
const volGain = (v) => Math.pow(v / 100, 2) * 1.6;
function applyMix(instant) {
  const set = (node, value) => instant ? (node.gain.value = value) : node.gain.setTargetAtTime(value, ctx.currentTime, 0.03);
  set(bus.RH, S.rhOn ? volGain(S.rhVol) : 0);
  set(bus.LH, S.lhOn ? volGain(S.lhVol) : 0);
  set(bus.click, S.clickOn ? volGain(S.clickVol) : 0);
  set(bus.countin, volGain(Math.max(S.clickVol, 40)));  // count-in stays audible even with the click off
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
  document.querySelectorAll('.m.cur').forEach((b) => b.classList.remove('cur'));
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
    const end = S.pedal ? Math.max(n.beat + n.len, n.barEnd) : n.beat + n.len;
    playNote(n.midi, b2t(n.beat), (end - n.beat) * spb - 0.03, n.hand, n.vel);
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
    mark = P.markers.shift();
    if (mark.done) { finish(); return; }
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
    $('now-main').textContent = `Count-in ${mark.beat}`;
    $('now-sub').textContent = `Measure ${mark.next} next · ${where(mark.next)}`;
    return;
  }
  $('now-main').textContent = `Measure ${mark.measure}`;
  const r = loopRange();
  $('now-sub').textContent = where(mark.measure) + (r ? ` · looping ${span(r)}` : '');
  document.querySelectorAll('.m.cur').forEach((b) => b.classList.remove('cur'));
  document.querySelector(`.m[data-m="${mark.measure}"]`)?.classList.add('cur');
}
function showIdle() {
  const st = songState();
  $('now-main').textContent = `Measure ${st.start}`;
  $('now-sub').textContent = where(st.start);
  setBeatDots(0);
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
  $('map-hint').textContent = r
    ? (awaitingLoopEnd ? `Looping ${span(r)}. Tap a later measure to move the loop's end.` : `Looping ${span(r)}. Tap a measure to start a new loop there.`)
    : `Play starts at measure ${st.start}. Tap any measure to start there.`;
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
  const ready = !!song && Object.keys(samples).length > 0;
  $('play').disabled = !ready;
  $('play').classList.toggle('stop', P.playing);
  $('play-label').textContent = P.playing ? '■ Stop' : `▶ Play from ${st.start}`;
  const again = P.lastStart || st.start;
  $('restart').disabled = !ready;
  $('restart-label').textContent = `⟲ Restart ${again}`;
}

function renderTempo() {
  const st = songState();
  $('tempo').value = st.tempo;
  $('tempo-slider').value = st.tempo;
  $('tempo-orig').textContent = song.tempo;
}

function bindControls() {
  $('pages').addEventListener('click', (e) => {
    const b = e.target.closest('.m');
    if (b) onMeasureTap(Number(b.dataset.m));
  });
  $('play').addEventListener('click', () => (P.playing ? stop(true) : start(songState().start)));
  $('restart').addEventListener('click', () => {
    const st = songState();
    start(st.loop ? st.start : (P.lastStart || st.start));
  });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') { e.preventDefault(); $('play').click(); }
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

  const toggles = { 'rh-on': 'rhOn', 'lh-on': 'lhOn', 'click-on': 'clickOn', 'loop-countin': 'loopCountIn', pedal: 'pedal' };
  for (const [id, key] of Object.entries(toggles)) {
    $(id).checked = S[key];
    $(id).addEventListener('change', (e) => { S[key] = e.target.checked; save(); applyMix(); });
  }
  const sliders = { 'rh-vol': 'rhVol', 'lh-vol': 'lhVol', 'click-vol': 'clickVol' };
  for (const [id, key] of Object.entries(sliders)) {
    $(id).value = S[key];
    $(id).addEventListener('input', (e) => { S[key] = Number(e.target.value); save(); applyMix(); });
  }

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
