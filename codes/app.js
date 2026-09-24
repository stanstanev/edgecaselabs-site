// CamCut Codes: UI layer. Codes never leave this file's in-memory state and localStorage.
// Privacy rules: no console output, no fetch, no URL/hash changes, textContent only.

import {
  STORAGE_KEY, DEFAULT_SUMMARY, emptyState, reviveState, withCodes, setupStep, currentIndex, counts,
  markCurrent, requeueSkipped, undo, inspectText, extractCodes, countBlankLines, guessCodeColumn, redeemUrl, formatCode,
  formatDateShort, formatExpiry, isExpired, todayPacific, pacificDateOf, parseAppleExpiry, parseAppleStore,
  renderSummary, statusCsv, qrPath,
} from "./core.js";

const $app = document.getElementById("app");
let state = load();
let editingTerms = false;
let pendingImport = null; // { inspection, sourceName, text }
let installSkipped = false;

// A browser tab on iPhone/iPad (Safari, Chrome, ...), not the Home Screen app.
function inIosBrowserTab() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  return ios && !standalone;
}

function browserName() {
  const ua = navigator.userAgent;
  if (/CriOS/.test(ua)) return "Chrome";
  if (/FxiOS/.test(ua)) return "Firefox";
  if (/EdgiOS/.test(ua)) return "Edge";
  return "Safari";
}

// ---------- Storage ----------

function load() {
  try { return reviveState(localStorage.getItem(STORAGE_KEY) || ""); }
  catch { return emptyState(); }
}

function save(next) {
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    toast("Couldn't save on this phone. Check storage settings.", true);
    return false;
  }
}

// Ask the browser to keep this data (best effort; Safari may ignore it).
try { navigator.storage?.persist?.(); } catch { /* ignore */ }

// ---------- Helpers ----------

function clone(id) { return document.getElementById(id).content.firstElementChild.cloneNode(true); }
function q(root, role) { return root.querySelector(`[data-role="${role}"]`); }
function now() { return new Date().toISOString(); }
function plural(n, word) { return `${n} ${word}${n === 1 ? "" : "s"}`; }

let toastTimer = 0;
function toast(message, isError = false) {
  const el = document.querySelector('[data-role="toast"]');
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1800);
}

function openSheet(id) {
  const d = document.getElementById(id);
  if (!d.open) d.showModal();
  return d;
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("read failed"));
    r.readAsText(file);
  });
}

// ---------- Render ----------

function render() {
  const step = editingTerms ? "terms" : setupStep(state);
  $app.replaceChildren();
  if (step === "codes" && !installSkipped && inIosBrowserTab()) return renderInstall();
  if (step === "codes") return renderCodesStep();
  if (step === "expiration") return renderExpirationStep();
  if (step === "terms") return renderTermsStep();
  if (currentIndex(state) < 0) return renderDone();
  renderWallet();
}

function renderInstall() {
  const el = clone("tpl-install");
  for (const n of el.querySelectorAll('[data-role="browser"]')) n.textContent = browserName();
  q(el, "not-safari").hidden = browserName() === "Safari";
  $app.append(el);
  el.querySelector('[data-action="skip-install"]').addEventListener("click", () => { installSkipped = true; render(); });
}

function renderCodesStep() {
  const el = clone("tpl-setup-codes");
  $app.append(el);
  const fileInput = q(el, "file");
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try { prepareImport(el, await readFile(file), file.name); }
    catch { toast("Couldn't read that file.", true); }
    fileInput.value = "";
  });
  el.querySelector('[data-action="use-paste"]').addEventListener("click", () => {
    prepareImport(el, q(el, "paste").value, "Pasted codes");
  });
  q(el, "column-select").addEventListener("change", () => showPreview(el));
  el.querySelector('[data-action="save-codes"]').addEventListener("click", () => {
    const result = currentExtraction(el);
    if (!result || !result.codes.length) return;
    save(withCodes(state, result.codes, pendingImport.sourceName, now()));
    pendingImport = null;
    render();
  });
}

function prepareImport(el, text, sourceName) {
  const inspection = inspectText(text);
  pendingImport = { inspection, sourceName, text };
  const pick = q(el, "column-pick");
  const select = q(el, "column-select");
  select.replaceChildren();
  if (inspection.kind === "columns" && !inspection.hasHeader) {
    for (let i = 0; i < inspection.columnCount; i++) {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `Column ${i + 1}`;
      select.append(opt);
    }
    select.value = String(guessCodeColumn(inspection));
    pick.hidden = false;
  } else {
    pick.hidden = true;
  }
  showPreview(el);
}

function currentExtraction(el) {
  if (!pendingImport) return null;
  const { inspection } = pendingImport;
  const col = inspection.kind === "list" ? 0
    : inspection.hasHeader ? inspection.headerIndex
    : Number(q(el, "column-select").value || 0);
  return extractCodes(inspection, col);
}

function showPreview(el) {
  const result = currentExtraction(el);
  const box = q(el, "preview");
  const btn = el.querySelector('[data-action="save-codes"]');
  box.replaceChildren();
  const blanks = countBlankLines(pendingImport.text);
  const big = document.createElement("p");
  big.className = "preview-count";
  big.textContent = `${plural(result.codes.length, "code")} ready`;
  box.append(big);
  const details = [];
  if (result.duplicates) details.push(`${plural(result.duplicates, "duplicate")} removed`);
  if (blanks + result.blanks) details.push(`${plural(blanks + result.blanks, "blank line")} ignored`);
  if (result.invalid.length) details.push(`${plural(result.invalid.length, "line")} skipped (not a code)`);
  if (pendingImport.inspection.hasHeader) details.push("header row detected");
  if (details.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = details.join(" · ");
    box.append(p);
  }
  if (result.invalid.length) {
    const p = document.createElement("p");
    p.className = "warn";
    const sample = result.invalid.slice(0, 3).map((v) => `“${v.slice(0, 40)}”`).join(", ");
    p.textContent = `Not imported: ${sample}${result.invalid.length > 3 ? "…" : ""}`;
    box.append(p);
  }
  box.hidden = false;
  btn.hidden = result.codes.length === 0;
  btn.textContent = `Save ${plural(result.codes.length, "Code")}`;
  box.scrollIntoView({ behavior: "smooth", block: "center" });
}

function renderExpirationStep() {
  const el = clone("tpl-setup-expiration");
  $app.append(el);
  const input = q(el, "expires");
  const warn = q(el, "expires-warn");
  input.value = state.batch.expiresOn || "";
  const check = () => {
    const v = input.value;
    const msgs = [];
    if (v && isExpired({ expiresOn: v })) msgs.push("That date is already past in Pacific Time. These codes won't redeem.");
    if (v) {
      const days = (Date.parse(v) - Date.parse(todayPacific())) / 86400000;
      if (days > 28) msgs.push("That's more than 28 days away. Apple codes expire within 28 days of being requested, so double-check History.");
    }
    warn.textContent = msgs.join(" ");
    warn.hidden = msgs.length === 0;
  };
  input.addEventListener("input", check);
  check();
  el.querySelector('[data-action="save-expiration"]').addEventListener("click", () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.value)) { toast("Enter the expiration date first.", true); return; }
    const keepExact = state.batch.expiresAt && pacificDateOf(state.batch.expiresAt) === input.value;
    save({ ...state, batch: { ...state.batch, expiresOn: input.value, expiresAt: keepExact ? state.batch.expiresAt : "" } });
    render();
  });
  el.querySelector('[data-action="back-to-codes"]').addEventListener("click", () => {
    if (!confirm("Discard the imported codes and choose a different file?")) return;
    save(emptyState());
    render();
  });
}

function renderTermsStep() {
  const el = clone("tpl-setup-terms");
  $app.append(el);
  const locale = q(el, "locale");
  const terms = q(el, "terms");
  const summary = q(el, "summary");
  locale.value = state.batch.termsLocale;
  terms.value = state.batch.terms;
  summary.value = state.batch.summary || DEFAULT_SUMMARY;
  const found = q(el, "terms-found");
  const showFound = () => {
    const at = parseAppleExpiry(terms.value);
    const store = parseAppleStore(terms.value);
    if (!at && !store) { found.hidden = true; return; }
    const bits = [];
    if (at) bits.push(`expires ${formatExpiry({ expiresAt: at })}`);
    if (store) bits.push(`App Store for ${store}`);
    found.textContent = `Read from Apple's terms: ${bits.join(" · ")}`;
    found.hidden = false;
    if (store && !locale.value.trim()) locale.value = `English — ${store}`;
  };
  terms.addEventListener("input", showFound);
  showFound();

  if (editingTerms) {
    el.querySelector(".eyebrow").textContent = "Edit";
    el.querySelector("h1").textContent = "Expiration & Terms";
    const date = document.createElement("input");
    date.type = "date";
    date.className = "field";
    date.value = state.batch.expiresOn;
    date.dataset.role = "edit-expires";
    const label = document.createElement("label");
    label.className = "field-label";
    label.textContent = "Expiration date (from History)";
    el.querySelector(".setup-head").after(label, date);
    const cancel = el.querySelector('[data-action="cancel-terms"]');
    cancel.hidden = false;
    cancel.addEventListener("click", () => { editingTerms = false; render(); });
    el.querySelector('[data-action="save-terms"]').textContent = "Save";
  }

  const termsFile = q(el, "terms-file");
  termsFile.addEventListener("change", async () => {
    const file = termsFile.files?.[0];
    if (!file) return;
    try { terms.value = (await readFile(file)).replace(/^\ufeff/, ""); showFound(); }
    catch { toast("Couldn't read that file.", true); }
    termsFile.value = "";
  });

  el.querySelector('[data-action="save-terms"]').addEventListener("click", () => {
    if (!locale.value.trim()) { toast("Enter the language / storefront.", true); locale.focus(); return; }
    if (!terms.value.trim()) { toast("Paste Apple's Holder Terms.", true); terms.focus(); return; }
    const batch = {
      ...state.batch,
      termsLocale: locale.value.trim(),
      terms: terms.value, // stored exactly as supplied
      summary: summary.value.trim() === DEFAULT_SUMMARY ? "" : summary.value.trim(),
      store: parseAppleStore(terms.value),
    };
    const editDate = q(el, "edit-expires");
    if (editDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(editDate.value)) { toast("Enter the expiration date.", true); return; }
      batch.expiresOn = editDate.value;
      if (batch.expiresAt && pacificDateOf(batch.expiresAt) !== editDate.value) batch.expiresAt = "";
    }
    // Apple's own expiry in the terms is authoritative over a typed date.
    const exact = parseAppleExpiry(terms.value);
    if (exact) { batch.expiresAt = exact; batch.expiresOn = pacificDateOf(exact); }
    save({ ...state, batch });
    editingTerms = false;
    render();
  });
}

function renderWallet() {
  const el = clone("tpl-wallet");
  $app.append(el);
  const i = currentIndex(state);
  const code = state.codes[i].code;
  const c = counts(state);

  const { d, dim } = qrPath(redeemUrl(code));
  const svg = q(el, "qr");
  svg.setAttribute("viewBox", `0 0 ${dim} ${dim}`);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000");
  svg.append(path);

  q(el, "code").textContent = formatCode(code);
  q(el, "remaining").textContent = `${plural(c.unused, "code")} remaining`;
  q(el, "expiry").textContent = `Expires ${formatDateShort(state.batch.expiresOn)}`;
  q(el, "summary").textContent = renderSummary(state.batch.summary, state.batch);
  q(el, "expired").hidden = !isExpired(state.batch);
  el.querySelector('[data-action="undo"]').disabled = state.history.length === 0;

  el.querySelector('[data-action="given"]').addEventListener("click", () => advance("given_out"));
  el.querySelector('[data-action="skip"]').addEventListener("click", () => advance("skipped"));
  el.querySelector('[data-action="undo"]').addEventListener("click", doUndo);
  el.querySelector('[data-action="copy"]').addEventListener("click", () => copyCode(code));
  el.querySelector('[data-action="terms"]').addEventListener("click", showTerms);
  el.querySelector('[data-action="menu"]').addEventListener("click", showMenu);

  requestWakeLock();
  if (!state.brightnessReminderSeen) {
    save({ ...state, brightnessReminderSeen: true });
    openSheet("sheet-brightness");
  }
}

function renderDone() {
  const el = clone("tpl-done");
  $app.append(el);
  const c = counts(state);
  if (c.skipped) q(el, "done-title").textContent = "No unused codes left";
  q(el, "done-counts").textContent = `${c.given_out} given out · ${c.skipped} skipped · ${c.total} total`;
  const requeue = el.querySelector('[data-action="requeue"]');
  requeue.hidden = c.skipped === 0;
  requeue.addEventListener("click", () => { save(requeueSkipped(state, now())); render(); });
  el.querySelector('[data-action="export"]').addEventListener("click", exportStatus);
  const undoBtn = el.querySelector('[data-action="undo"]');
  undoBtn.disabled = state.history.length === 0;
  undoBtn.addEventListener("click", doUndo);
  el.querySelector('[data-action="menu"]').addEventListener("click", showMenu);
  releaseWakeLock();
}

// ---------- Actions ----------

function advance(status) {
  save(markCurrent(state, status, now()));
  render();
  toast(status === "given_out" ? "Marked given out" : "Skipped");
  window.scrollTo(0, 0);
}

function doUndo() {
  if (!state.history.length) return;
  save(undo(state));
  render();
  toast("Undone");
}

async function copyCode(code) {
  try {
    await navigator.clipboard.writeText(code);
    toast("Code copied");
  } catch {
    toast("Copy isn't available here.", true);
  }
}

function showTerms() {
  const d = document.getElementById("sheet-terms");
  q(d, "terms-expiry").textContent = `Expires ${formatExpiry(state.batch)}`;
  q(d, "terms-locale").textContent = `Holder Terms · ${state.batch.termsLocale}`;
  q(d, "terms-text").textContent = state.batch.terms;
  openSheet("sheet-terms");
  d.querySelector(".sheet-body").scrollTop = 0;
}

function showMenu() {
  const d = document.getElementById("sheet-menu");
  const c = counts(state);
  q(d, "menu-counts").textContent = `${c.unused} unused · ${c.given_out} given out · ${c.skipped} skipped`;
  openSheet("sheet-menu");
}

function statusFileName() {
  return `camcut-codes-status-${todayPacific()}.csv`;
}

async function exportStatus() {
  const csv = statusCsv(state);
  const name = statusFileName();
  try {
    const file = new File([csv], name, { type: "text/csv" });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "CamCut code status" });
      return;
    }
  } catch (e) {
    if (e && e.name === "AbortError") return;
  }
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Menu sheet wiring (static elements)
{
  const menu = document.getElementById("sheet-menu");
  menu.querySelector('[data-action="export"]').addEventListener("click", exportStatus);
  menu.querySelector('[data-action="edit-terms"]').addEventListener("click", () => {
    menu.close();
    editingTerms = true;
    render();
    window.scrollTo(0, 0);
  });
  menu.querySelector('[data-action="rules"]').addEventListener("click", () => { menu.close(); openSheet("sheet-rules"); });
  menu.querySelector('[data-action="erase"]').addEventListener("click", () => {
    menu.close();
    const d = openSheet("sheet-erase");
    const input = q(d, "erase-input");
    input.value = "";
    d.querySelector('[data-action="erase-confirm"]').disabled = true;
  });

  const erase = document.getElementById("sheet-erase");
  const input = q(erase, "erase-input");
  const btn = erase.querySelector('[data-action="erase-confirm"]');
  input.addEventListener("input", () => { btn.disabled = input.value.trim().toUpperCase() !== "ERASE"; });
  btn.addEventListener("click", () => {
    if (input.value.trim().toUpperCase() !== "ERASE") return;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    state = emptyState();
    editingTerms = false;
    erase.close();
    render();
    toast("All codes erased");
  });
}

// Tap outside a sheet closes it.
for (const d of document.querySelectorAll("dialog.sheet")) {
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
}

// ---------- Wake lock ----------

let wakeLock = null;
async function requestWakeLock() {
  if (wakeLock || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch { wakeLock = null; }
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && document.querySelector(".wallet")) requestWakeLock();
});

// Another tab changed the data: re-read so both stay in step.
window.addEventListener("storage", (e) => {
  if (e.key === STORAGE_KEY || e.key === null) { state = load(); render(); }
});

// Swallow errors silently (never report anything that could include a code).
window.addEventListener("error", (e) => { e.preventDefault(); });
window.addEventListener("unhandledrejection", (e) => { e.preventDefault(); });

// ---------- Offline ----------

if ("serviceWorker" in navigator) {
  // When a newer version takes over, reload once so the phone shows it right away.
  // Safe mid-event: every state change is already saved.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    location.reload();
  });
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

render();
