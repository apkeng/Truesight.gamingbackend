const crypto = require('crypto');
const { getSupabase } = require('../../config/supabase');

/**
 * Thin helpers over the generic `{ id, data jsonb }` document tables.
 * The gaming feature reuses existing tables (users, challenges, daily_questions,
 * daily_question_attempts, rewards, redemptions), so no schema change is needed.
 */

const db = () => getSupabase();

async function getRow(table, id) {
  const { data, error } = await db()
    .from(table)
    .select('id, data, created_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function putRow(table, id, data) {
  const { error } = await db()
    .from(table)
    .upsert({ id, data, updated_at: new Date().toISOString() });
  if (error) throw error;
}

/** Insert only if no row with this id exists. Returns the row that is stored afterwards. */
async function insertIfAbsent(table, id, data) {
  const { error } = await db()
    .from(table)
    .upsert({ id, data, updated_at: new Date().toISOString() }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) throw error;
  return getRow(table, id);
}

/**
 * Compare-and-swap: replace `data` only while `data->>field` still equals `expected`.
 * Returns true when this call won the write.
 */
async function casUpdate(table, id, data, field, expected) {
  const { data: rows, error } = await db()
    .from(table)
    .update({ data, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq(`data->>${field}`, String(expected))
    .select('id');
  if (error) throw error;
  return Array.isArray(rows) && rows.length > 0;
}

// ---------- time (the product runs on Indian Standard Time) ----------

const IST = 'Asia/Kolkata';

const istDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: IST }); // YYYY-MM-DD

const istYesterday = () => istDate(new Date(Date.now() - 24 * 3600 * 1000));

function msUntilIstMidnight(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: IST, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(now).map((p) => [p.type, p.value])
  );
  const elapsed = (Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return (24 * 3600 - elapsed) * 1000;
}

function istHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', hour12: false }).format(now)) % 24;
}

function dateLine(now = new Date()) {
  const s = new Intl.DateTimeFormat('en-IN', {
    timeZone: IST, weekday: 'long', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(now);
  const get = (t) => s.find((p) => p.type === t)?.value || '';
  return `${get('weekday')} · ${get('day')} ${get('month')} · ${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase()} IST`;
}

function formatDuration(ms, { seconds = false } = {}) {
  if (ms <= 0) return seconds ? '00:00:00' : '0m';
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (seconds) {
    const hh = d * 24 + h;
    return [hh, m, s].map((n) => String(n).padStart(2, '0')).join(':');
  }
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

// ---------- maths ----------

const expectedScore = (ra, rb) => 1 / (1 + Math.pow(10, (rb - ra) / 400));

/** Elo update. score: 1 win, 0.5 draw, 0 loss. Returns the integer change for player A. */
const eloDelta = (ra, rb, score, k = 32) => Math.round(k * (score - expectedScore(ra, rb)));

/** Deterministic pseudo-random in [0,1) from a string seed. */
function seededRandom(seed) {
  const h = crypto.createHash('sha256').update(String(seed)).digest();
  return h.readUInt32BE(0) / 0x100000000;
}

function seededShuffle(items, seed) {
  return items
    .map((item, i) => ({ item, k: seededRandom(`${seed}:${i}`) }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.item);
}

function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const LETTERS = ['A', 'B', 'C', 'D'];

function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** "Student Alice" -> "Alice", "Meera Sharma" -> "Meera S." */
function shortName(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Player';
  if (parts[0].toLowerCase() === 'student' && parts.length > 1) return parts.slice(1).join(' ');
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

class GamingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = {
  db,
  getRow,
  putRow,
  insertIfAbsent,
  casUpdate,
  istDate,
  istYesterday,
  istHour,
  msUntilIstMidnight,
  dateLine,
  formatDuration,
  expectedScore,
  eloDelta,
  seededRandom,
  seededShuffle,
  shuffle,
  LETTERS,
  initials,
  shortName,
  median,
  GamingError,
};
