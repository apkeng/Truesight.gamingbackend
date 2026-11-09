const crypto = require('crypto');
const {
  db, getRow, putRow, casUpdate, formatDuration, eloDelta, expectedScore, shuffle,
  LETTERS, initials, shortName, GamingError,
} = require('./util');
const { TOPICS, getTopic } = require('./catalog');
const { generateQuestions } = require('./questions');
const players = require('./players');

/**
 * Asynchronous best-of-three duels.
 *  - Round 1: the challenger's category. Round 2: the opponent drafts one of three.
 *  - Round 3 (decider): drawn at random, only if the first two do not decide it.
 *  - Both players answer the same 5 questions per round, in their own time.
 *  - Each stage has a 48h deadline; whoever leaves work outstanding at the deadline forfeits.
 *
 * Storage (existing `challenges` table, no schema change):
 *  - duel row:      id = <uuid>,            data.kind = 'duel'
 *  - progress rows: id = <uuid>:<playerId>, data.kind = 'duel_progress' (one writer each, so
 *    two players answering at the same moment never overwrite each other)
 */

const TABLE = 'challenges';
const QUESTIONS_PER_ROUND = 5;
const STAGE_MS = 48 * 3600 * 1000;
const NUDGE_COOLDOWN_MS = 12 * 3600 * 1000;
const WIN_COINS = 80;
const LOSS_COINS = 20;
const DRAW_COINS = 40;
const XP_PER_CORRECT = 10;
const BASE_POINTS = 100;
const POWER_UPS = { fifty: 2, hint: 1, skip: 1 };
const AVATAR_COLORS = ['bg-gaming-pink', 'bg-blue-500', 'bg-slate-600', 'bg-gaming-gold'];

const progressId = (duelId, uid) => `${duelId}:${uid}`;
const avatarColor = (uid) => AVATAR_COLORS[parseInt(crypto.createHash('md5').update(uid).digest('hex').slice(0, 6), 16) % AVATAR_COLORS.length];
const deadlineFromNow = () => new Date(Date.now() + STAGE_MS).toISOString();
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

function emptyProgress(duelId, uid) {
  return { kind: 'duel_progress', duelId, uid, rounds: {}, powerUps: { ...POWER_UPS }, active: null };
}

async function loadDuel(id) {
  const row = await getRow(TABLE, id);
  if (!row || row.data?.kind !== 'duel') throw new GamingError(404, 'Duel not found');
  return row.data;
}

async function loadProgress(duelId, uid) {
  const row = await getRow(TABLE, progressId(duelId, uid));
  return row?.data?.kind === 'duel_progress' ? row.data : emptyProgress(duelId, uid);
}

const saveProgress = (p) => putRow(TABLE, progressId(p.duelId, p.uid), p);

const answersOf = (prog, n) => prog.rounds?.[n] || [];
const isDone = (prog, round) => !!round.questions && answersOf(prog, round.n).length >= round.questions.length;
const correctIn = (prog, n) => answersOf(prog, n).filter((a) => a.correct).length;
const pointsIn = (prog, n) => answersOf(prog, n).reduce((s, a) => s + (a.points || 0), 0);

function other(duel, uid) {
  if (duel.playerA === uid) return duel.playerB;
  if (duel.playerB === uid) return duel.playerA;
  throw new GamingError(403, 'You are not part of this duel');
}

/** Wins per player over rounds both have finished. */
function tally(duel, prog) {
  const { playerA: A, playerB: B } = duel;
  const res = { wins: { [A]: 0, [B]: 0 }, correct: { [A]: 0, [B]: 0 }, points: { [A]: 0, [B]: 0 }, sealedRounds: 0 };
  for (const r of duel.rounds) {
    if (!(isDone(prog[A], r) && isDone(prog[B], r))) continue;
    res.sealedRounds += 1;
    const ca = correctIn(prog[A], r.n);
    const cb = correctIn(prog[B], r.n);
    const pa = pointsIn(prog[A], r.n);
    const pb = pointsIn(prog[B], r.n);
    res.correct[A] += ca; res.correct[B] += cb;
    res.points[A] += pa; res.points[B] += pb;
    if (ca > cb || (ca === cb && pa > pb)) res.wins[A] += 1;
    else if (cb > ca || (ca === cb && pb > pa)) res.wins[B] += 1;
  }
  return res;
}

/** What the duel needs next: 'play' (still in progress), 'needR3', or 'finish'. */
function nextStep(duel, prog) {
  const [r1, r2, r3] = duel.rounds;
  const both = (r) => r && isDone(prog[duel.playerA], r) && isDone(prog[duel.playerB], r);
  if (!(both(r1) && both(r2))) return 'play';
  const t = tally(duel, prog);
  if (t.wins[duel.playerA] >= 2 || t.wins[duel.playerB] >= 2) return 'finish';
  if (!r3) return 'needR3';
  return both(r3) ? 'finish' : 'play';
}

function winnerOf(duel, prog) {
  const { playerA: A, playerB: B } = duel;
  const t = tally(duel, prog);
  for (const key of ['wins', 'correct', 'points']) {
    if (t[key][A] > t[key][B]) return A;
    if (t[key][B] > t[key][A]) return B;
  }
  return 'draw';
}

/** Does this player still owe something in the current stage? */
function outstanding(duel, prog, uid) {
  return duel.rounds.some((r) => (r.questions ? !isDone(prog[uid], r) : r.pickedBy === uid));
}

/** Claim the finish with a compare-and-swap, then settle ratings and coins once. */
async function finalize(duelId, duel, winner, reason) {
  const { playerA: A, playerB: B } = duel;
  const settled = { ...duel, version: (duel.version || 0) + 1, finishedAt: new Date().toISOString(), winner, reason };
  if (reason === 'expired') {
    settled.status = 'expired';
    settled.result = { [A]: { ratingChange: 0, coins: 0 }, [B]: { ratingChange: 0, coins: 0 } };
    await casUpdate(TABLE, duelId, settled, 'version', duel.version || 0);
    return settled;
  }

  const [ua, ub] = await Promise.all([players.loadUser(A), players.loadUser(B)]);
  const ra = ua.gaming.rating;
  const rb = ub.gaming.rating;
  const sa = winner === 'draw' ? 0.5 : winner === A ? 1 : 0;
  const result = {
    [A]: { ratingChange: eloDelta(ra, rb, sa), coins: winner === 'draw' ? DRAW_COINS : winner === A ? WIN_COINS : LOSS_COINS },
    [B]: { ratingChange: eloDelta(rb, ra, 1 - sa), coins: winner === 'draw' ? DRAW_COINS : winner === B ? WIN_COINS : LOSS_COINS },
  };
  settled.status = 'finished';
  settled.result = result;

  const won = await casUpdate(TABLE, duelId, settled, 'version', duel.version || 0);
  if (!won) return loadDuel(duelId); // someone else settled it first

  for (const uid of [A, B]) {
    await players.mutateUser(uid, (data, gaming) => {
      gaming.rating = Math.max(100, gaming.rating + result[uid].ratingChange);
      gaming.lastRatingChange = result[uid].ratingChange;
      players.addCoins(data, result[uid].coins);
    });
  }
  return settled;
}

/**
 * Bring a duel up to date: settle expired stages, create the decider round,
 * or finish it. Safe to call repeatedly and concurrently.
 */
async function advance(duelId) {
  for (let i = 0; i < 4; i++) {
    const duel = await loadDuel(duelId);
    if (duel.status !== 'active') return duel;
    const prog = {
      [duel.playerA]: await loadProgress(duelId, duel.playerA),
      [duel.playerB]: await loadProgress(duelId, duel.playerB),
    };

    const step = nextStep(duel, prog);
    if (step === 'finish') return finalize(duelId, duel, winnerOf(duel, prog), 'completed');

    if (step === 'needR3') {
      // Normally prepared when round 2's category was picked; generate now only as a fallback.
      const decider = duel.decider || (await drawDecider(duel.rounds.map((r) => r.topicId)));
      const next = {
        ...duel,
        version: (duel.version || 0) + 1,
        deadline: deadlineFromNow(),
        decider: null,
        rounds: [...duel.rounds, { n: 3, topicId: decider.topicId, category: decider.category, pickedBy: 'draw', choices: null, questions: decider.questions }],
      };
      if (await casUpdate(TABLE, duelId, next, 'version', duel.version || 0)) return next;
      continue; // lost the race; reload
    }

    if (new Date(duel.deadline).getTime() < Date.now()) {
      const oa = outstanding(duel, prog, duel.playerA);
      const ob = outstanding(duel, prog, duel.playerB);
      if (oa && ob) return finalize(duelId, duel, 'draw', 'expired');
      if (oa || ob) return finalize(duelId, duel, oa ? duel.playerB : duel.playerA, 'forfeit');
    }
    return duel;
  }
  return loadDuel(duelId);
}

/** Draw a decider topic not used in earlier rounds and generate its questions. */
async function drawDecider(usedTopicIds) {
  const topic = shuffle(TOPICS.filter((t) => !usedTopicIds.includes(t.id)))[0];
  const { questions } = await generateQuestions({ topic: topic.title, count: QUESTIONS_PER_ROUND, difficulty: { from: 5, to: 7 } });
  return { topicId: topic.id, category: topic.title, questions };
}

/** The player's next action in a duel, or null when waiting on the opponent. */
function myTurn(duel, mine, uid) {
  if (duel.status !== 'active') return null;
  for (const r of duel.rounds) {
    if (!r.questions) {
      if (r.pickedBy === uid) return { type: 'draft', round: r };
      continue;
    }
    if (!isDone(mine, r)) return { type: r.n === 3 ? 'settle' : 'play', round: r };
  }
  return null;
}

// ---------------------------------------------------------------- creation

async function listMyDuelRows(uid) {
  const { data, error } = await db()
    .from(TABLE)
    .select('id, data, created_at')
    .eq('data->>kind', 'duel')
    .or(`data->>playerA.eq.${uid},data->>playerB.eq.${uid}`)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return data || [];
}

async function createDuel(uid, { opponentId, topicId } = {}) {
  const me = await players.loadUser(uid);
  if (me.data.role !== players.STUDENT_ROLE) throw new GamingError(403, 'Duels are for student accounts');

  const rows = await listMyDuelRows(uid);
  const activeWith = new Map(
    rows.filter((r) => r.data.status === 'active').map((r) => [other(r.data, uid), r.id])
  );

  let opponent;
  if (opponentId) {
    if (opponentId === uid) throw new GamingError(400, 'You cannot duel yourself');
    if (activeWith.has(opponentId)) return { duelId: activeWith.get(opponentId), existing: true };
    const row = await getRow('users', opponentId);
    if (!row || row.data.role !== players.STUDENT_ROLE) throw new GamingError(404, 'Opponent not found');
    opponent = { uid: opponentId, name: row.data.name || 'Player' };
  } else {
    // Quick duel: closest rating first, prefer people you are not already playing, same institute first.
    let pool = (await players.listStudents(me.data.instituteCode)).filter((p) => p.uid !== uid);
    if (!pool.length) pool = (await players.listStudents()).filter((p) => p.uid !== uid);
    const fresh = pool.filter((p) => !activeWith.has(p.uid));
    if (!fresh.length) {
      if (pool.length) {
        const p = pool[0];
        return { duelId: activeWith.get(p.uid), existing: true };
      }
      throw new GamingError(404, 'No opponents are available yet. Invite a classmate to join.');
    }
    fresh.sort((a, b) => Math.abs(a.rating - me.gaming.rating) - Math.abs(b.rating - me.gaming.rating));
    opponent = shuffle(fresh.slice(0, 3))[0];
  }

  const topic = (topicId && getTopic(topicId)) || shuffle(TOPICS)[0];
  const { questions } = await generateQuestions({ topic: topic.title, count: QUESTIONS_PER_ROUND, difficulty: { from: 3, to: 6 } });
  const choices = shuffle(TOPICS.filter((t) => t.id !== topic.id)).slice(0, 3).map((t) => t.id);

  const duelId = crypto.randomUUID();
  const now = new Date().toISOString();
  const duel = {
    kind: 'duel',
    version: 1,
    status: 'active',
    playerA: uid,
    playerB: opponent.uid,
    names: { [uid]: me.data.name || 'Player', [opponent.uid]: opponent.name },
    createdAt: now,
    deadline: deadlineFromNow(),
    rounds: [
      { n: 1, topicId: topic.id, category: topic.title, pickedBy: uid, choices: null, questions },
      { n: 2, topicId: null, category: null, pickedBy: opponent.uid, choices, questions: null },
    ],
    winner: null,
    nudges: {},
  };
  await putRow(TABLE, duelId, duel);
  return { duelId, existing: false };
}

async function pickCategory(uid, duelId, topicId) {
  const duel = await advance(duelId);
  other(duel, uid);
  const turn = myTurn(duel, await loadProgress(duelId, uid), uid);
  if (!turn || turn.type !== 'draft') throw new GamingError(409, 'It is not your turn to pick a category');
  if (!turn.round.choices.includes(topicId)) throw new GamingError(400, 'Pick one of the offered categories');
  const topic = getTopic(topicId);
  // Prepare the possible decider at the same time so finishing round 2 never waits on the LLM.
  const [{ questions }, decider] = await Promise.all([
    generateQuestions({ topic: topic.title, count: QUESTIONS_PER_ROUND, difficulty: { from: 4, to: 7 } }),
    drawDecider([...duel.rounds.map((r) => r.topicId), topicId]).catch(() => null),
  ]);
  const next = {
    ...duel,
    version: (duel.version || 0) + 1,
    deadline: deadlineFromNow(),
    decider,
    rounds: duel.rounds.map((r) => (r.n === turn.round.n ? { ...r, topicId, category: topic.title, questions } : r)),
  };
  if (!(await casUpdate(TABLE, duelId, next, 'version', duel.version || 0))) {
    throw new GamingError(409, 'The duel changed while you were picking. Please try again.');
  }
  return { ok: true, round: turn.round.n, category: topic.title };
}

// ---------------------------------------------------------------- playing

const comboOf = (answers) => {
  let c = 0;
  for (let i = answers.length - 1; i >= 0 && answers[i].correct; i--) c += 1;
  return c;
};
const multiplierFor = (combo) => (combo >= 2 ? 2 : 1);

function comboText(combo) {
  if (combo === 0) return 'Answer right to start a combo.';
  if (combo === 1) return 'One straight. One more and points double.';
  return `${combo} straight. This one is worth double.`;
}

async function loadForPlay(uid, duelId) {
  const duel = await advance(duelId);
  const them = other(duel, uid);
  const mine = await loadProgress(duelId, uid);
  const theirs = await loadProgress(duelId, them);
  return { duel, them, mine, theirs };
}

function currentQuestion(duel, mine, uid) {
  const turn = myTurn(duel, mine, uid);
  if (!turn || turn.type === 'draft') return null;
  const answers = answersOf(mine, turn.round.n);
  const k = answers.length;
  let active = mine.active;
  if (!active || active.round !== turn.round.n || active.q !== k) {
    active = { round: turn.round.n, q: k, removed: [], hint: false };
  }
  return { turn, round: turn.round, k, q: turn.round.questions[k], answers, active };
}

/** Record a choice (index, or -1 for a skip) for the player's current question. */
async function recordChoice(uid, duelId, { choice, questionNum, skipped = false }) {
  const { duel, mine } = await loadForPlay(uid, duelId);
  const cur = currentQuestion(duel, mine, uid);
  if (!cur) throw new GamingError(409, duel.status === 'active' ? 'It is not your turn in this duel' : 'This duel is over');
  if (questionNum != null && Number(questionNum) !== cur.k + 1) {
    throw new GamingError(409, 'That question was already answered. Refreshing…');
  }
  if (!skipped && cur.active.removed.includes(choice)) throw new GamingError(400, 'That option was removed by 50:50');

  const correct = !skipped && choice === cur.q.correctIndex;
  const points = correct ? BASE_POINTS * multiplierFor(comboOf(cur.answers)) : 0;
  mine.rounds = { ...mine.rounds, [cur.round.n]: [...cur.answers, { choice, correct, points, skipped, at: new Date().toISOString() }] };
  mine.active = null;
  await saveProgress(mine);

  await players.mutateUser(uid, (data, gaming) => {
    players.recordAnswer(gaming, cur.round.category, correct);
    players.touchStreak(gaming);
    if (correct) gaming.xp += XP_PER_CORRECT;
  });

  const roundComplete = cur.k + 1 >= cur.round.questions.length;
  const after = roundComplete ? await advance(duelId) : duel;
  return {
    correct,
    skipped,
    points,
    correctAnswerId: LETTERS[cur.q.correctIndex],
    correctAnswer: cur.q.options[cur.q.correctIndex],
    explanation: cur.q.explanation,
    roundComplete,
    duelFinished: after.status !== 'active',
    outcome: after.status !== 'active' ? outcomeFor(after, uid) : null,
  };
}

function answerQuestion(uid, duelId, { answerId, questionNum }) {
  const choice = LETTERS.indexOf(String(answerId || '').toUpperCase());
  if (choice < 0) throw new GamingError(400, 'answerId must be A, B, C or D');
  return recordChoice(uid, duelId, { choice, questionNum });
}

async function usePowerUp(uid, duelId, { type, questionNum }) {
  const key = { '50:50': 'fifty', fifty: 'fifty', hint: 'hint', skip: 'skip' }[String(type || '').toLowerCase()];
  if (!key) throw new GamingError(400, 'Unknown power-up');
  const { duel, mine } = await loadForPlay(uid, duelId);
  const cur = currentQuestion(duel, mine, uid);
  if (!cur) throw new GamingError(409, 'It is not your turn in this duel');
  if (questionNum != null && Number(questionNum) !== cur.k + 1) throw new GamingError(409, 'Question changed. Refreshing…');
  const left = mine.powerUps?.[key] ?? POWER_UPS[key];
  if (left <= 0) throw new GamingError(400, 'No uses left for that power-up');

  if (key === 'skip') {
    mine.powerUps = { ...POWER_UPS, ...mine.powerUps, skip: left - 1 };
    await saveProgress(mine);
    return { type: 'skip', ...(await recordChoice(uid, duelId, { choice: -1, questionNum, skipped: true })) };
  }
  if (key === 'fifty') {
    if (cur.active.removed.length) throw new GamingError(400, '50:50 is already active on this question');
    const wrong = shuffle([0, 1, 2, 3].filter((i) => i !== cur.q.correctIndex)).slice(0, 2);
    mine.active = { ...cur.active, removed: wrong };
  } else {
    if (cur.active.hint) throw new GamingError(400, 'Hint already shown');
    mine.active = { ...cur.active, hint: true };
  }
  mine.powerUps = { ...POWER_UPS, ...mine.powerUps, [key]: left - 1 };
  await saveProgress(mine);
  return key === 'fifty'
    ? { type: 'fifty', removed: mine.active.removed.map((i) => LETTERS[i]) }
    : { type: 'hint', hint: cur.q.hint || 'No hint for this one — trust your instinct.' };
}

async function nudge(uid, duelId) {
  const duel = await advance(duelId);
  const them = other(duel, uid);
  if (duel.status !== 'active') throw new GamingError(409, 'This duel is over');
  const last = duel.nudges?.[uid];
  if (last && Date.now() - new Date(last).getTime() < NUDGE_COOLDOWN_MS) {
    throw new GamingError(429, 'You already nudged them recently');
  }
  const prog = { [uid]: await loadProgress(duelId, uid), [them]: await loadProgress(duelId, them) };
  if (!outstanding(duel, prog, them)) throw new GamingError(409, 'They are not holding things up');
  const next = { ...duel, version: (duel.version || 0) + 1, nudges: { ...(duel.nudges || {}), [uid]: new Date().toISOString() } };
  if (!(await casUpdate(TABLE, duelId, next, 'version', duel.version || 0))) throw new GamingError(409, 'Please try again');
  return { ok: true };
}

// ---------------------------------------------------------------- views

function outcomeFor(duel, uid) {
  const them = other(duel, uid);
  const r = duel.result?.[uid] || { ratingChange: 0, coins: 0 };
  const label = duel.status === 'expired' ? 'Expired'
    : duel.winner === 'draw' ? 'Draw'
      : duel.winner === uid ? 'Won' : 'Lost';
  return {
    result: label,
    reason: duel.reason,
    opponent: shortName(duel.names?.[them]),
    ratingChange: r.ratingChange,
    coins: r.coins,
  };
}

function roundsProgress(duel, mine, theirs, uid) {
  const them = shortName(duel.names?.[other(duel, uid)]).toUpperCase();
  return duel.rounds.map((r) => {
    const label = `R${r.n}`;
    if (!r.questions) {
      return { label, title: r.pickedBy === uid ? 'YOUR PICK' : `${them} PICKING`, segments: QUESTIONS_PER_ROUND, filled: 0, variant: 'orange-outline' };
    }
    const cat = r.category.toUpperCase();
    const myCount = answersOf(mine, r.n).length;
    if (isDone(mine, r) && isDone(theirs, r)) {
      return { label, title: `${cat} · YOU ${correctIn(mine, r.n)}–${correctIn(theirs, r.n)}`, segments: QUESTIONS_PER_ROUND, filled: QUESTIONS_PER_ROUND, variant: 'teal' };
    }
    if (isDone(mine, r)) return { label, title: `${cat} · SEALED`, segments: QUESTIONS_PER_ROUND, filled: QUESTIONS_PER_ROUND, variant: 'teal' };
    if (myCount) return { label, title: `${cat} · Q${myCount + 1} NEXT`, segments: QUESTIONS_PER_ROUND, filled: myCount, variant: 'orange' };
    return { label, title: 'AWAITING YOU', segments: QUESTIONS_PER_ROUND, filled: 0, variant: 'orange-outline' };
  });
}

function scoreLine(duel, prog, uid) {
  const them = other(duel, uid);
  const t = tally(duel, prog);
  return { you: t.correct[uid], them: t.correct[them], sealedRounds: t.sealedRounds };
}

function recentNudge(duel, fromUid) {
  const at = duel.nudges?.[fromUid];
  return at && Date.now() - new Date(at).getTime() < 24 * 3600 * 1000;
}

/** Build everything the Duels page, nav badge and Arena sidebar need. */
async function duelsOverview(uid) {
  const rows = await listMyDuelRows(uid);
  // Bring stale active duels up to date (deadlines, decider rounds) before rendering.
  const duels = [];
  for (const row of rows) {
    let d = row.data;
    if (d.status === 'active' && (new Date(d.deadline).getTime() < Date.now())) d = await advance(row.id);
    duels.push({ id: row.id, ...d });
  }

  const ids = duels.map((d) => d.id);
  const progressById = new Map();
  if (ids.length) {
    const { data, error } = await db().from(TABLE).select('id, data').in('id', duels.flatMap((d) => [progressId(d.id, d.playerA), progressId(d.id, d.playerB)]));
    if (error) throw error;
    for (const r of data || []) progressById.set(r.id, r.data);
  }
  const progOf = (d, u) => progressById.get(progressId(d.id, u)) || emptyProgress(d.id, u);

  const opponentIds = [...new Set(duels.map((d) => other(d, uid)))];
  const ratings = new Map();
  if (opponentIds.length) {
    const { data, error } = await db().from('users').select('id, data').in('id', opponentIds);
    if (error) throw error;
    for (const r of data || []) ratings.set(r.id, players.withDefaults(r.data.gaming).rating);
  }
  const me = await players.loadUser(uid);
  const myRating = me.gaming.rating;

  const activeDuels = [];
  const waitingOnThem = [];
  const finished = [];

  for (const d of duels) {
    const them = other(d, uid);
    const mine = progOf(d, uid);
    const theirs = progOf(d, them);
    const prog = { [uid]: mine, [them]: theirs };
    const themName = shortName(d.names?.[them]);
    const theirRating = ratings.get(them) ?? players.DEFAULT_RATING;
    const score = scoreLine(d, prog, uid);

    if (d.status !== 'active') {
      const o = outcomeFor(d, uid);
      finished.push({
        id: d.id,
        name: themName,
        initials: initials(d.names?.[them]),
        avatarColor: avatarColor(them),
        result: o.result,
        reason: o.reason,
        score: `${score.you}–${score.them}`,
        ratingChange: o.ratingChange,
        coins: o.coins,
        finishedAt: d.finishedAt,
      });
      continue;
    }

    const turn = myTurn(d, mine, uid);
    const timeLeft = `${formatDuration(new Date(d.deadline).getTime() - Date.now())} LEFT`;
    const nudged = recentNudge(d, them) ? ` · ${themName} nudged you` : '';

    if (turn) {
      const base = {
        id: d.id,
        opponentId: them,
        initials: initials(d.names?.[them]),
        name: themName,
        rating: theirRating,
        league: titleCase(leagueShort(theirRating)),
        avatarColor: avatarColor(them),
        timeLeft,
        scoreYou: score.you,
        scoreThem: score.them,
      };
      if (turn.type === 'draft') {
        const { gaming: theirGaming } = await players.loadUser(them).catch(() => ({ gaming: players.withDefaults({}) }));
        activeDuels.push({
          ...base,
          type: 'draft',
          status: `Round ${turn.round.n} · draft your category${nudged}`,
          categories: turn.round.choices.map((tid) => {
            const t = getTopic(tid);
            return { id: tid, name: t.title, you: players.accuracy(me.gaming, t.title), them: players.accuracy(theirGaming, t.title) };
          }),
        });
      } else {
        const r = turn.round;
        const started = answersOf(mine, r.n).length > 0;
        const picker = r.pickedBy === uid ? 'you chose' : r.pickedBy === 'draw' ? 'drawn category:' : `${themName} chose`;
        const gain = Math.max(1, Math.round(32 * (1 - expectedScore(myRating, theirRating))));
        activeDuels.push({
          ...base,
          type: turn.type,
          status: turn.type === 'settle'
            ? `Round 3 · decider · drawn category: ${r.category}${nudged}`
            : `Round ${r.n} of ${Math.max(2, d.rounds.length)} · ${picker} ${r.category}${nudged}`,
          rounds: roundsProgress(d, mine, theirs, uid),
          cta: turn.type === 'settle' ? 'Settle it' : started ? `Continue round ${r.n}` : `Play round ${r.n}`,
          footer: `${QUESTIONS_PER_ROUND} questions · a win is worth about +${gain} rating and ${WIN_COINS} coins`,
        });
      }
    } else {
      const owes = d.rounds.find((r) => (r.questions ? !isDone(theirs, r) : r.pickedBy === them));
      const what = owes ? (owes.questions ? `R${owes.n} · their turn` : `R${owes.n} · picking category`) : 'finishing up';
      const lead = score.sealedRounds
        ? score.you > score.them ? ` · you lead ${score.you}–${score.them}` : score.you < score.them ? ` · they lead ${score.them}–${score.you}` : ` · level ${score.you}–${score.them}`
        : '';
      const last = d.nudges?.[uid];
      waitingOnThem.push({
        id: d.id,
        name: themName,
        status: `${what}${lead} · ${timeLeft.toLowerCase()}`,
        canNudge: !last || Date.now() - new Date(last).getTime() >= NUDGE_COOLDOWN_MS,
      });
    }
  }

  return { activeDuels, waitingOnThem, finished };
}

function leagueShort(rating) {
  if (rating >= 1900) return 'PANDIT';
  if (rating >= 1600) return 'VIDWAN';
  if (rating >= 1300) return 'VIDYARTHI';
  return 'SHISHYA';
}

/** The duel-round screen for the current player. */
async function roundView(uid, duelId) {
  const { duel, them, mine, theirs } = await loadForPlay(uid, duelId);
  const themName = shortName(duel.names?.[them]);
  if (duel.status !== 'active') return { state: 'finished', duelId, outcome: outcomeFor(duel, uid) };

  const turn = myTurn(duel, mine, uid);
  if (!turn) return { state: 'waiting', duelId, message: `Your part is done. Waiting on ${themName}.` };

  const timeLeftMs = new Date(duel.deadline).getTime() - Date.now();
  if (turn.type === 'draft') {
    const { gaming: theirGaming } = await players.loadUser(them).catch(() => ({ gaming: players.withDefaults({}) }));
    const { gaming: myGaming } = await players.loadUser(uid);
    return {
      state: 'draft',
      duelId,
      round: turn.round.n,
      opponent: themName,
      expiresIn: formatDuration(timeLeftMs, { seconds: true }),
      choices: turn.round.choices.map((tid) => {
        const t = getTopic(tid);
        return { id: tid, name: t.title, you: players.accuracy(myGaming, t.title), them: players.accuracy(theirGaming, t.title) };
      }),
    };
  }

  const cur = currentQuestion(duel, mine, uid);
  const prog = { [uid]: mine, [them]: theirs };
  const sealed = scoreLine(duel, prog, uid);
  const myTotal = duel.rounds.reduce((s, r) => s + correctIn(mine, r.n), 0);
  const combo = comboOf(cur.answers);
  const theirCount = answersOf(theirs, cur.round.n).length;
  const opponentStatus = theirCount >= cur.round.questions.length
    ? `${themName.toUpperCase()} FINISHED THIS ROUND · SEALED`
    : theirCount > 0 ? `${themName.toUpperCase()} IS ON Q${theirCount + 1}` : `${themName.toUpperCase()} HASN'T PLAYED THIS ROUND YET`;
  const pu = { ...POWER_UPS, ...(mine.powerUps || {}) };

  return {
    state: 'question',
    duelId,
    round: cur.round.n,
    category: cur.round.category.toUpperCase(),
    playerYou: { initials: initials(duel.names?.[uid]), score: myTotal, color: 'bg-gaming-gold' },
    playerThem: { initials: initials(duel.names?.[them]), score: sealed.them, color: avatarColor(them) === 'bg-gaming-gold' ? 'bg-gaming-pink' : avatarColor(them) },
    questionNum: cur.k + 1,
    totalQuestions: cur.round.questions.length,
    points: BASE_POINTS * multiplierFor(combo),
    combo,
    comboText: comboText(combo),
    opponentStatus,
    question: cur.q.question,
    answers: cur.q.options
      .map((text, i) => ({ id: LETTERS[i], text }))
      .filter((_, i) => !cur.active.removed.includes(i)),
    powerUps: [
      { key: 'fifty', label: '50:50', count: pu.fifty, active: cur.active.removed.length > 0, disabled: pu.fifty <= 0 || cur.active.removed.length > 0 },
      { key: 'hint', label: 'HINT', count: pu.hint, active: cur.active.hint, disabled: pu.hint <= 0 || cur.active.hint },
      { key: 'skip', label: 'SKIP', count: pu.skip, disabled: pu.skip <= 0 },
    ],
    expiresIn: formatDuration(timeLeftMs, { seconds: true }),
    hint: cur.active.hint ? `Hint: ${cur.q.hint || 'No hint for this one.'}` : `${themName}'s answers stay sealed until you both finish the round.`,
    footerNote: 'Progress saved · the clock does not pause',
  };
}

module.exports = {
  createDuel,
  pickCategory,
  answerQuestion,
  usePowerUp,
  nudge,
  duelsOverview,
  roundView,
  WIN_COINS,
};
