const crypto = require('crypto');
const { eloDelta, expectedScore, seededRandom, LETTERS, GamingError } = require('./util');
const { TOPICS, resolveTopic, levelForRating } = require('./catalog');
const { generateQuestions } = require('./questions');
const players = require('./players');

/**
 * The Oracle: a solo 10-question ladder against a simulated rival.
 * The Oracle's chance of answering correctly comes from its rating versus each
 * question's difficulty (rises with the rung and through the run). Beating it
 * moves you up a rung; ratings for you and the Oracle move by Elo at the end.
 * State lives in users.data.gaming.oracle.
 */

const RUN_LENGTH = 10;
const COINS_PER_CORRECT = 10;
const BEAT_BONUS = 100;
const XP_PER_CORRECT = 20;
const BASE_POINTS = 100;

const questionRating = (rung, idx) => 1000 + rung * 80 + idx * 30;

function oracleChoice(run, idx, oracleRating) {
  const q = run.questions[idx];
  const p = Math.min(0.92, Math.max(0.25, expectedScore(oracleRating, questionRating(run.rung, idx))));
  if (seededRandom(`${run.id}:${idx}:oracle`) < p) return q.correctIndex;
  const wrong = [0, 1, 2, 3].filter((i) => i !== q.correctIndex);
  return wrong[Math.floor(seededRandom(`${run.id}:${idx}:wrong`) * wrong.length)];
}

const comboOf = (answers) => {
  let c = 0;
  for (let i = answers.length - 1; i >= 0 && answers[i].correct; i--) c += 1;
  return c;
};

function oracleCard(o) {
  const hist = (o.history || []).slice(-7);
  const lo = Math.min(...hist) - 20;
  const hi = Math.max(...hist) + 20;
  return {
    rating: o.rating,
    prevRating: o.prevRating,
    quote: 'Every correct answer buys you a harder one. Every miss buys mercy.',
    ratingHistory: hist.map((r) => Math.round(20 + (80 * (r - lo)) / Math.max(1, hi - lo))),
  };
}

function runSummary(run) {
  const you = run.answers.filter((a) => a.correct).length;
  const oracle = run.answers.filter((a) => a.oracleCorrect).length;
  return {
    you,
    total: run.answers.length,
    oracle,
    totalSlots: RUN_LENGTH,
    segments: Array.from({ length: RUN_LENGTH }, (_, i) => (run.answers[i] ? (run.answers[i].correct ? 'correct' : 'wrong') : 'pending')),
  };
}

function suggestions(gaming) {
  const level = levelForRating(gaming.rating);
  const fit = TOPICS.filter((t) => t.level === level);
  return [...fit, ...TOPICS.filter((t) => t.level !== level)].slice(0, 6).map((t) => ({ id: t.id, title: t.title, category: t.category, level: t.level }));
}

function view(gaming) {
  const o = gaming.oracle;
  const run = o.run;
  const base = {
    oracle: oracleCard(o),
    rung: o.rung,
    rewards: [
      { label: 'Each correct answer', value: `+${COINS_PER_CORRECT} coins` },
      { label: 'Beat the Oracle', value: `+${BEAT_BONUS} coins · rung ${o.rung + 1}` },
    ],
    pauseNote: 'Your rung is saved. The Oracle waits.',
    footerNote: 'No timer here. Go make chai.',
  };
  if (!run) return { ...base, phase: 'idle', topics: suggestions(gaming), lastRun: o.lastRun || null };

  const idx = run.phase === 'reveal' ? run.answers.length - 1 : Math.min(run.answers.length, RUN_LENGTH - 1);
  const q = run.questions[idx];
  const combo = comboOf(run.phase === 'reveal' ? run.answers.slice(0, -1) : run.answers);
  const common = {
    ...base,
    runId: run.id,
    topicId: run.topicId,
    topic: run.topic,
    runLabel: 'Oracle run',
    runContext: `${run.topic} · ladder rung ${run.rung}`,
    xp: run.answers.filter((a) => a.correct).length * XP_PER_CORRECT,
    questionNum: idx + 1,
    totalQuestions: RUN_LENGTH,
    run: runSummary(run),
    rewards: [
      { label: 'Each correct answer', value: `+${COINS_PER_CORRECT} coins` },
      { label: 'Beat the Oracle', value: `+${BEAT_BONUS} coins · rung ${run.rung + 1}` },
    ],
  };

  if (run.phase === 'finished') {
    return { ...common, phase: 'finished', summary: run.result };
  }

  const difficultyUp = combo >= 3;
  const answers = q.options.map((text, i) => ({ id: LETTERS[i], text }));
  if (run.phase === 'reveal') {
    const a = run.answers[idx];
    return {
      ...common,
      phase: 'reveal',
      difficultyUp,
      difficultyText: 'Three in a row. The Oracle stops being polite.',
      question: q.question,
      yourChoice: a.choice >= 0 ? LETTERS[a.choice] : null,
      answers: answers.map((ans, i) => ({
        ...ans,
        correct: i === q.correctIndex || undefined,
        oracleChose: (i === a.oracleChoice && i !== q.correctIndex) || undefined,
        combo: i === q.correctIndex && a.correct ? `+${a.points}${a.points > BASE_POINTS ? ' · 2x COMBO' : ''}` : undefined,
      })),
      explanation: {
        title: 'FOR THE RECORD',
        body: `${q.explanation || ''} ${a.oracleCorrect ? 'The Oracle got this one too.' : 'The Oracle got this one wrong.'}`.trim(),
      },
      verdict: a.correct ? 'correct' : 'wrong',
    };
  }
  return {
    ...common,
    phase: 'question',
    difficultyUp,
    difficultyText: 'Three in a row. The Oracle stops being polite.',
    question: q.question,
    answers,
  };
}

async function getRun(uid) {
  const { gaming } = await players.loadUser(uid);
  return view(gaming);
}

async function startRun(uid, { topicId, restart = false } = {}) {
  const { gaming } = await players.loadUser(uid);
  const existing = gaming.oracle.run;
  if (existing && existing.phase !== 'finished' && !restart) return view(gaming);

  const topic = resolveTopic(topicId) || suggestions(gaming)[0];
  const rung = gaming.oracle.rung || 1;
  const from = Math.min(8, 2 + Math.floor(rung / 2));
  const { questions } = await generateQuestions({ topic: topic.title, count: RUN_LENGTH, difficulty: { from, to: Math.min(10, from + 4) } });

  return players.mutateUser(uid, (data, g) => {
    g.oracle.run = {
      id: crypto.randomUUID(),
      topicId: topic.id,
      topic: topic.title,
      category: topic.category,
      rung,
      questions,
      answers: [],
      phase: 'question',
      startedAt: new Date().toISOString(),
    };
    return view(g);
  });
}

async function answer(uid, { answerId, questionNum }) {
  const choice = LETTERS.indexOf(String(answerId || '').toUpperCase());
  if (choice < 0) throw new GamingError(400, 'answerId must be A, B, C or D');
  return players.mutateUser(uid, (data, gaming) => {
    const o = gaming.oracle;
    const run = o.run;
    if (!run || run.phase !== 'question') throw new GamingError(409, 'No question is waiting for an answer');
    const idx = run.answers.length;
    if (questionNum != null && Number(questionNum) !== idx + 1) throw new GamingError(409, 'That question was already answered. Refreshing…');

    const q = run.questions[idx];
    const correct = choice === q.correctIndex;
    const oc = oracleChoice(run, idx, o.rating);
    const combo = comboOf(run.answers);
    run.answers.push({
      choice,
      correct,
      oracleChoice: oc,
      oracleCorrect: oc === q.correctIndex,
      points: correct ? BASE_POINTS * (combo >= 2 ? 2 : 1) : 0,
    });
    run.phase = 'reveal';
    players.recordAnswer(gaming, run.topic, correct);
    players.touchStreak(gaming);

    if (run.answers.length >= RUN_LENGTH) {
      // Settle as soon as the last answer is in, so leaving the page cannot skip rewards.
      const s = runSummary(run);
      const beat = s.you > s.oracle;
      const score = beat ? 1 : s.you === s.oracle ? 0.5 : 0;
      const delta = eloDelta(gaming.rating, o.rating, score, 24);
      const coins = s.you * COINS_PER_CORRECT + (beat ? BEAT_BONUS : 0);
      const xp = s.you * XP_PER_CORRECT;
      o.prevRating = o.rating;
      o.rating = Math.max(800, o.rating - delta);
      o.history = [...(o.history || []), o.rating].slice(-7);
      gaming.rating = Math.max(100, gaming.rating + delta);
      gaming.lastRatingChange = delta;
      gaming.xp += xp;
      players.addCoins(data, coins);
      if (beat) o.rung = (o.rung || 1) + 1;
      run.result = { you: s.you, oracle: s.oracle, beat, draw: s.you === s.oracle, coins, xp, ratingChange: delta, newRung: o.rung, topic: run.topic };
      o.lastRun = run.result;
      o.runsPlayed = (o.runsPlayed || 0) + 1;
    }
    return view(gaming);
  });
}

async function next(uid) {
  return players.mutateUser(uid, (data, gaming) => {
    const run = gaming.oracle.run;
    if (!run) throw new GamingError(409, 'No run in progress');
    if (run.phase === 'reveal') run.phase = run.answers.length >= RUN_LENGTH ? 'finished' : 'question';
    else if (run.phase === 'finished') gaming.oracle.run = null; // acknowledge and return to the start screen
    return view(gaming);
  });
}

async function pause(uid) {
  return players.mutateUser(uid, (data, gaming) => {
    if (gaming.oracle.run) gaming.oracle.run.pausedAt = new Date().toISOString();
    return { ok: true };
  });
}

/** One-line promo for the Arena sidebar. */
function promo(gaming) {
  const o = gaming.oracle;
  const last = o.lastRun;
  const tail = last
    ? last.beat ? ` You beat it ${last.you}–${last.oracle} last time.` : ` It took your last run ${last.oracle}–${last.you}.`
    : ' You have not taken it on yet.';
  return {
    message: `Playing at ${o.rating.toLocaleString('en-IN')} on rung ${o.rung}.${tail}`,
    ctaLabel: o.run && o.run.phase !== 'finished' ? 'Resume your run' : 'Take it on',
  };
}

module.exports = { getRun, startRun, answer, next, pause, promo };
