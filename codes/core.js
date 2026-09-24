// Pure logic for CamCut Codes. No DOM, no storage, no network.
// Shared by the browser app and the Node test suite.

import qrcode from "./vendor/qrcode.mjs";

export const STORAGE_KEY = "camcut-codes.v1";
export const REDEEM_BASE = "https://apps.apple.com/redeem?code=";
export const CODE_HEADERS = ["code", "promo_code", "promocode"];
const STATUSES = ["unused", "given_out", "skipped"];
const CODE_PATTERN = /^[A-Z0-9]{6,32}$/;

// ---------- Import parsing ----------

/** Parse CSV text into rows of trimmed cells. Handles quotes, escaped quotes, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

function normalizeHeader(cell) {
  return cell.toLowerCase().replace(/[\s-]+/g, "_").replace(/^\ufeff/, "");
}

/** Normalize one raw cell into a candidate code: strip all whitespace, uppercase. */
export function normalizeCode(raw) {
  return String(raw).replace(/[\s\u00a0\u200b\ufeff]+/g, "").toUpperCase();
}

/**
 * Inspect raw text (a .txt list, a CSV, or pasted text).
 * Returns { kind: "list" } or { kind: "columns", headerIndex, columnCount, hasHeader, rows }.
 */
export function inspectText(text) {
  const clean = String(text).replace(/^\ufeff/, "");
  const rows = parseCsv(clean).filter((r) => r.some((c) => c !== ""));
  const columnCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
  if (rows.length === 0) return { kind: "list", rows: [], columnCount: 0, headerIndex: -1, hasHeader: false };
  const header = rows[0].map(normalizeHeader);
  const headerIndex = header.findIndex((h) => CODE_HEADERS.includes(h));
  if (headerIndex >= 0) return { kind: "columns", rows, columnCount, headerIndex, hasHeader: true };
  if (columnCount <= 1) return { kind: "list", rows, columnCount, headerIndex: 0, hasHeader: false };
  return { kind: "columns", rows, columnCount, headerIndex: -1, hasHeader: false };
}

/**
 * Extract codes from inspected rows using a column index.
 * Returns { codes, duplicates, blanks, invalid } where invalid holds the rejected raw values.
 */
export function extractCodes(inspection, columnIndex, existing = []) {
  const seen = new Set(existing);
  const codes = [];
  let duplicates = 0;
  let blanks = 0;
  const invalid = [];
  const start = inspection.hasHeader ? 1 : 0;
  for (let r = start; r < inspection.rows.length; r++) {
    const raw = inspection.rows[r][columnIndex] ?? "";
    const code = normalizeCode(raw);
    if (!code) { blanks++; continue; }
    if (!CODE_PATTERN.test(code)) { invalid.push(raw); continue; }
    if (seen.has(code)) { duplicates++; continue; }
    seen.add(code);
    codes.push(code);
  }
  return { codes, duplicates, blanks, invalid };
}

/** Best guess for the code column: the one with the most code-shaped values. */
export function guessCodeColumn(inspection) {
  let best = 0;
  let bestScore = -1;
  for (let col = 0; col < inspection.columnCount; col++) {
    const score = inspection.rows.filter((r) => CODE_PATTERN.test(normalizeCode(r[col] ?? ""))).length;
    if (score > bestScore) { best = col; bestScore = score; }
  }
  return best;
}

/** Count blank lines in the original text (lines that parseCsv discards). */
export function countBlankLines(text) {
  const lines = String(text).split(/\r\n|\n|\r/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // trailing newline is not a blank line
  return lines.filter((l) => l.trim() === "").length;
}

// ---------- Wallet state ----------

export function emptyState() {
  return {
    version: 1,
    codes: [], // { code, status: "unused" | "given_out" | "skipped", at: ISO string | null }
    batch: { expiresOn: "", expiresAt: "", store: "", termsLocale: "", terms: "", summary: "", sourceName: "", importedAt: "" },
    history: [], // undo stack: [{ label, changes: [{ i, status, at }] }] (previous values)
    brightnessReminderSeen: false,
  };
}

export function withCodes(state, codes, sourceName, now) {
  return {
    ...state,
    codes: codes.map((code) => ({ code, status: "unused", at: null })),
    batch: { ...state.batch, sourceName: sourceName || "", importedAt: now },
    history: [],
  };
}

export function currentIndex(state) {
  return state.codes.findIndex((c) => c.status === "unused");
}

export function counts(state) {
  const out = { unused: 0, given_out: 0, skipped: 0, total: state.codes.length };
  for (const c of state.codes) out[c.status]++;
  return out;
}

export function setupStep(state) {
  if (state.codes.length === 0) return "codes";
  if (!state.batch.expiresOn) return "expiration";
  if (!state.batch.terms.trim() || !state.batch.termsLocale.trim()) return "terms";
  return "ready";
}

function applyChanges(state, label, updates, now) {
  const codes = state.codes.slice();
  const changes = [];
  for (const [i, status] of updates) {
    changes.push({ i, status: codes[i].status, at: codes[i].at });
    codes[i] = { ...codes[i], status, at: now };
  }
  const history = state.history.concat([{ label, changes }]).slice(-200);
  return { ...state, codes, history };
}

export function markCurrent(state, status, now) {
  const i = currentIndex(state);
  if (i < 0) return state;
  return applyChanges(state, status === "given_out" ? "given out" : "skipped", [[i, status]], now);
}

export function requeueSkipped(state, now) {
  const updates = [];
  state.codes.forEach((c, i) => { if (c.status === "skipped") updates.push([i, "unused"]); });
  if (!updates.length) return state;
  return applyChanges(state, "requeue", updates, now);
}

export function undo(state) {
  if (!state.history.length) return state;
  const last = state.history[state.history.length - 1];
  const codes = state.codes.slice();
  for (const ch of last.changes) codes[ch.i] = { ...codes[ch.i], status: ch.status, at: ch.at };
  return { ...state, codes, history: state.history.slice(0, -1) };
}

/** Validate and restore a stored state; returns emptyState() on anything malformed. */
export function reviveState(json) {
  try {
    const s = JSON.parse(json);
    if (!s || s.version !== 1 || !Array.isArray(s.codes)) return emptyState();
    const base = emptyState();
    const codes = s.codes
      .filter((c) => c && typeof c.code === "string" && STATUSES.includes(c.status))
      .map((c) => ({ code: c.code, status: c.status, at: typeof c.at === "string" ? c.at : null }));
    const batch = { ...base.batch };
    for (const k of Object.keys(batch)) if (typeof s.batch?.[k] === "string") batch[k] = s.batch[k];
    if (batch.summary === OLD_DEFAULT_SUMMARY || batch.summary === DEFAULT_SUMMARY) batch.summary = "";
    const history = Array.isArray(s.history)
      ? s.history.filter((h) => h && Array.isArray(h.changes) && h.changes.every((c) => c && Number.isInteger(c.i) && c.i >= 0 && c.i < codes.length && STATUSES.includes(c.status)))
      : [];
    return { ...base, codes, batch, history, brightnessReminderSeen: s.brightnessReminderSeen === true };
  } catch {
    return emptyState();
  }
}

// ---------- Presentation helpers ----------

export function redeemUrl(code) {
  return REDEEM_BASE + encodeURIComponent(code);
}

/** Group a code into blocks of four for reading aloud: ABCD EFGH IJKL. */
export function formatCode(code) {
  return code.replace(/(.{4})(?=.)/g, "$1 ");
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10-20" -> "October 20, 2026" (no time-zone shifting). */
export function formatDateLong(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return "";
  return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}

export function formatDateShort(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return "";
  return `${MONTHS[+m[2] - 1].slice(0, 3)} ${+m[3]}`;
}

/** Today's date in Pacific Time as YYYY-MM-DD. */
export function todayPacific(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return parts; // en-CA formats as YYYY-MM-DD
}

/** Calendar date (YYYY-MM-DD) of an instant in Pacific Time. */
export function pacificDateOf(iso) {
  return todayPacific(new Date(iso));
}

/**
 * Read the exact expiry from Apple's promo code terms, e.g.
 * "Promo Codes expire on 2026-10-22 20:47:00 Etc/GMT". Returns an ISO UTC string or "".
 */
export function parseAppleExpiry(text) {
  const m = /expires?\s+on\s+(\d{4})-(\d{2})-(\d{2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:Etc\/GMT|GMT|UTC|Z)\b/i.exec(String(text));
  if (!m) return "";
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4].padStart(2, "0")}:${m[5]}:${m[6] || "00"}Z`;
  return Number.isNaN(Date.parse(iso)) ? "" : iso;
}

/** Read the storefront from Apple's terms: "redeemable only on the App Store for United States." */
export function parseAppleStore(text) {
  const m = /App Store for ([A-Za-z][A-Za-z .,'()-]{1,60}?)\s*\./.exec(String(text).replace(/\s+/g, " "));
  return m ? m[1].trim() : "";
}

/** "October 22, 2026 at 1:47 P.M. PT". Falls back to 11:59 P.M. PT when only a date is known. */
export function formatExpiry(batch) {
  if (batch.expiresAt) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", year: "numeric", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    }).formatToParts(new Date(batch.expiresAt)).map((p) => [p.type, p.value]));
    const ampm = parts.dayPeriod.toUpperCase() === "PM" ? "P.M." : "A.M.";
    return `${parts.month} ${parts.day}, ${parts.year} at ${parts.hour}:${parts.minute} ${ampm} PT`;
  }
  return batch.expiresOn ? `${formatDateLong(batch.expiresOn)} at 11:59 P.M. PT` : "";
}

export function isExpired(batch, now = new Date()) {
  if (batch.expiresAt) return now.getTime() >= Date.parse(batch.expiresAt);
  return Boolean(batch.expiresOn) && todayPacific(now) > batch.expiresOn;
}

export const DEFAULT_SUMMARY =
  "Redeemable only on the {store}. Expires {date}. Apple Account required. Not for resale. Full terms apply.";

// Earlier default, which hard-coded 11:59 P.M.; treat a stored copy as "use the current default".
const OLD_DEFAULT_SUMMARY =
  "Valid only where CamCut is available. Expires {date} at 11:59 P.M. PT. Apple Account required. Not for resale. No cash value. Terms & Conditions apply.";

export function renderSummary(template, batch) {
  return (template || DEFAULT_SUMMARY)
    .split("{date}").join(formatExpiry(batch))
    .split("{store}").join(batch.store ? `App Store for ${batch.store}` : "App Store");
}

/** Build the status export as CSV. */
export function statusCsv(state) {
  const esc = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = ["code,status,changed_at,expires_on"];
  for (const c of state.codes) lines.push([c.code, c.status, c.at || "", state.batch.expiresAt || state.batch.expiresOn].map(esc).join(","));
  return lines.join("\n") + "\n";
}

/** QR module matrix for the redemption URL. Returns { size, dark(r, c) }. */
export function qrMatrix(text) {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  return { size, dark: (r, c) => qr.isDark(r, c) };
}

/** SVG path data for the dark modules (one unit per module, offset by the quiet zone). */
export function qrPath(text, quiet = 4) {
  const { size, dark } = qrMatrix(text);
  let d = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (dark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return { d, dim: size + quiet * 2 };
}
