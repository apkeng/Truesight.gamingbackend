const { db, getRow, putRow, istDate, istYesterday, shortName, GamingError } = require('./util');

/**
 * Per-player gaming state lives in users.data.gaming. Coins are the existing
 * users.data.userPoints balance, so the rewards store and /api/redemptions keep
 * working with one wallet.
 */

const DEFAULT_RATING = 1200;
const STUDENT_ROLE = 'Level-2';

const LEAGUES = [
  { min: 0, name: 'SHISHYA LEAGUE' },
  { min: 1300, name: 'VIDYARTHI LEAGUE' },
  { min: 1600, name: 'VIDWAN LEAGUE' },
  { min: 1900, name: 'PANDIT LEAGUE' },
];

function defaultGaming() {
  return {
    rating: DEFAULT_RATING,
    lastRatingChange: 0,
    xp: 0,
    streak: { days: 0, lastDate: null },
    catStats: {},
    oracle: { rating: DEFAULT_RATING + 50, prevRating: DEFAULT_RATING + 50, history: [DEFAULT_RATING + 50], rung: 1, run: null },
    goalRewardId: null,
  };
}

function withDefaults(gaming = {}) {
  const d = defaultGaming();
  return {
    ...d,
    ...gaming,
    streak: { ...d.streak, ...(gaming.streak || {}) },
    oracle: { ...d.oracle, ...(gaming.oracle || {}) },
    catStats: { ...(gaming.catStats || {}) },
  };
}

async function loadUser(uid) {
  const row = await getRow('users', uid);
  if (!row) throw new GamingError(404, 'User profile not found');
  const data = row.data || {};
  return { data, gaming: withDefaults(data.gaming) };
}

/**
 * Read-modify-write a user's document. `fn(data, gaming)` mutates in place and may return a value.
 */
async function mutateUser(uid, fn) {
  const { data, gaming } = await loadUser(uid);
  const result = await fn(data, gaming);
  data.gaming = gaming;
  data.updatedAt = new Date().toISOString();
  await putRow('users', uid, data);
  return result;
}

const coinsOf = (data) => Math.max(0, Math.round(Number(data.userPoints) || 0));

/** Credit coins into the shared wallet (userPoints/totalScore, as the quiz flow does). */
function addCoins(data, amount) {
  if (!amount) return;
  data.userPoints = coinsOf(data) + amount;
  data.totalScore = Math.max(0, Math.round(Number(data.totalScore) || 0) + amount);
}

/** Record that the player did something today (keeps the daily streak alive). */
function touchStreak(gaming) {
  const today = istDate();
  const s = gaming.streak;
  if (s.lastDate === today) return;
  s.days = s.lastDate === istYesterday() ? (s.days || 0) + 1 : 1;
  s.lastDate = today;
}

/** Streak as displayed: a streak that missed yesterday is broken. */
function currentStreak(gaming) {
  const s = gaming.streak || {};
  if (s.lastDate === istDate() || s.lastDate === istYesterday()) return s.days || 0;
  return 0;
}

function recordAnswer(gaming, category, correct) {
  if (!category) return;
  const s = gaming.catStats[category] || { c: 0, n: 0 };
  s.n += 1;
  if (correct) s.c += 1;
  gaming.catStats[category] = s;
}

function accuracy(gaming, category) {
  const s = gaming.catStats?.[category];
  return s && s.n >= 3 ? Math.round((100 * s.c) / s.n) : null;
}

const leagueName = (rating) => [...LEAGUES].reverse().find((l) => rating >= l.min).name;

/** All students (Level-2), optionally limited to one institute. */
async function listStudents(instituteCode) {
  let q = db().from('users').select('id, data').eq('data->>role', STUDENT_ROLE);
  if (instituteCode) q = q.eq('data->>instituteCode', instituteCode);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map((r) => {
    const g = withDefaults(r.data.gaming);
    return {
      uid: r.id,
      name: r.data.name || r.data.email || 'Player',
      instituteCode: r.data.instituteCode || null,
      rating: g.rating,
      xp: g.xp,
    };
  });
}

/**
 * League card + division standings. A division is the player's institute
 * cohort (falls back to all students), ranked by rating then XP.
 */
async function leagueFor(uid, userData, gaming) {
  const cohort = await listStudents(userData.instituteCode);
  if (!cohort.find((p) => p.uid === uid)) {
    cohort.push({ uid, name: userData.name || 'You', rating: gaming.rating, xp: gaming.xp });
  }
  cohort.sort((a, b) => b.rating - a.rating || b.xp - a.xp || a.name.localeCompare(b.name));
  const standings = cohort.map((p, i) => ({
    rank: i + 1,
    uid: p.uid,
    name: p.uid === uid ? 'You' : shortName(p.name),
    score: p.rating,
    isYou: p.uid === uid,
  }));
  const me = standings.find((s) => s.isYou);
  const above = standings[me.rank - 2];
  const total = standings.length;
  const note = !above
    ? total > 1 ? 'Top of the division. Win duels to stay there.' : 'You are the first in your division. Challenge a friend.'
    : above.score === me.score
      ? `Level on rating with ${above.name}. One win moves you up.`
      : `${above.score - me.score} rating behind ${above.name} at #${above.rank}.`;
  const league = {
    name: leagueName(gaming.rating),
    division: userData.instituteName ? `DIV · ${String(userData.instituteName).toUpperCase()}` : 'OPEN DIVISION',
    rank: me.rank,
    total,
    progress: total > 1 ? (total - me.rank) / (total - 1) : 1,
    note,
  };
  return { league, standings };
}

/** Up to 4 rows of standings centred on the player. */
function standingsAround(standings) {
  const i = standings.findIndex((s) => s.isYou);
  const start = Math.max(0, Math.min(i - 2, standings.length - 4));
  return standings.slice(start, start + 4).map(({ uid, ...row }) => row);
}

module.exports = {
  DEFAULT_RATING,
  STUDENT_ROLE,
  loadUser,
  mutateUser,
  coinsOf,
  addCoins,
  touchStreak,
  currentStreak,
  recordAnswer,
  accuracy,
  listStudents,
  leagueFor,
  standingsAround,
  withDefaults,
};
