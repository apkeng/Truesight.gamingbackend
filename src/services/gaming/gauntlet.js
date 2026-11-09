const {
  db, getRow, putRow, insertIfAbsent, istDate, msUntilIstMidnight, formatDuration,
  seededShuffle, median, LETTERS, GamingError,
} = require('./util');
const { TOPICS } = require('./catalog');
const { generateQuestions } = require('./questions');
const players = require('./players');

/**
 * Daily gauntlet: 12 questions, the same set for every player each IST day.
 *  - Set:      daily_questions row         id = gauntlet:<date>, data.kind = 'gauntlet'
 *  - Attempts: daily_question_attempts row id = gauntlet:<date>:<uid>
 */

const COUNT = 12;
const COINS_PER_CORRECT = 5;
const XP_PER_CORRECT = 20;

const setId = (date) => `gauntlet:${date}`;
const attemptId = (date, uid) => `gauntlet:${date}:${uid}`;

const inflight = new Map(); // date -> Promise, so one server never generates the same day twice

async function getSet(date = istDate()) {
  const existing = await getRow('daily_questions', setId(date));
  if (existing) return existing.data;
  if (!inflight.has(date)) {
    inflight.set(date, (async () => {
      const topic = seededShuffle(TOPICS, `gauntlet:${date}`)[0];
      const { title, questions } = await generateQuestions({
        topic: topic.title, count: COUNT, difficulty: { from: 3, to: 8 }, withTitle: true,
      });
      const row = await insertIfAbsent('daily_questions', setId(date), {
        kind: 'gauntlet', date, topicId: topic.id, topic: topic.title,
        title: title || `Twelve on ${topic.title}`, questions, createdAt: new Date().toISOString(),
      });
      return row.data; // if another instance won the insert, everyone plays that one
    })().finally(() => inflight.delete(date)));
  }
  return inflight.get(date);
}

async function getAttempt(date, uid) {
  const row = await getRow('daily_question_attempts', attemptId(date, uid));
  return row?.data || { kind: 'gauntlet', date, uid, answers: [], phase: 'question', completed: false };
}

async function completedScores(date) {
  const { data, error } = await db()
    .from('daily_question_attempts')
    .select('data')
    .eq('data->>kind', 'gauntlet')
    .eq('data->>date', date)
    .eq('data->>completed', 'true');
  if (error) throw error;
  return (data || []).map((r) => r.data.score || 0);
}

/** Summary for the Arena card (does not generate the set). */
async function card(uid) {
  const date = istDate();
  const [setRow, attempt, scores] = await Promise.all([
    getRow('daily_questions', setId(date)),
    getAttempt(date, uid),
    completedScores(date),
  ]);
  const m = median(scores);
  const played = scores.length;
  const statsBits = [
    played ? `${played.toLocaleString('en-IN')} played` : 'Be the first to play today',
    m != null ? `Median ${m}/${COUNT}` : null,
    `Up to +${COUNT * XP_PER_CORRECT} XP · ${COUNT * COINS_PER_CORRECT} coins`,
  ].filter(Boolean);
  return {
    title: setRow?.data?.title || "Today's twelve — a fresh set every midnight",
    stats: statsBits.join(' · '),
    resetText: `Resets 12:00 AM IST · ${formatDuration(msUntilIstMidnight())}`,
    status: attempt.completed ? 'completed' : attempt.answers.length ? 'in-progress' : 'new',
    score: attempt.completed ? attempt.score : null,
    total: COUNT,
    progress: attempt.answers.length,
  };
}

function view(set, attempt, extra = {}) {
  const idx = attempt.phase === 'reveal' ? attempt.answers.length - 1 : attempt.answers.length;
  const base = {
    date: set.date,
    title: set.title,
    topic: set.topic,
    totalQuestions: COUNT,
    score: attempt.answers.filter((a) => a.correct).length,
    segments: Array.from({ length: COUNT }, (_, i) => (attempt.answers[i] ? (attempt.answers[i].correct ? 'correct' : 'wrong') : 'pending')),
    resetText: `Resets in ${formatDuration(msUntilIstMidnight())}`,
    ...extra,
  };
  if (attempt.completed && attempt.phase !== 'reveal') {
    return { ...base, phase: 'finished', result: attempt.result };
  }
  const q = set.questions[idx];
  const answers = q.options.map((text, i) => ({ id: LETTERS[i], text }));
  if (attempt.phase === 'reveal') {
    const a = attempt.answers[idx];
    return {
      ...base,
      phase: 'reveal',
      questionNum: idx + 1,
      question: q.question,
      yourChoice: LETTERS[a.choice],
      verdict: a.correct ? 'correct' : 'wrong',
      answers: answers.map((ans, i) => ({ ...ans, correct: i === q.correctIndex || undefined, wrongPick: (i === a.choice && !a.correct) || undefined })),
      explanation: q.explanation ? { title: 'FOR THE RECORD', body: q.explanation } : null,
    };
  }
  return { ...base, phase: 'question', questionNum: idx + 1, question: q.question, answers };
}

async function play(uid) {
  const date = istDate();
  const set = await getSet(date);
  return view(set, await getAttempt(date, uid));
}

async function answer(uid, { answerId, questionNum }) {
  const choice = LETTERS.indexOf(String(answerId || '').toUpperCase());
  if (choice < 0) throw new GamingError(400, 'answerId must be A, B, C or D');
  const date = istDate();
  const set = await getSet(date);
  const attempt = await getAttempt(date, uid);
  if (attempt.completed || attempt.phase !== 'question') throw new GamingError(409, 'No question is waiting for an answer');
  const idx = attempt.answers.length;
  if (questionNum != null && Number(questionNum) !== idx + 1) throw new GamingError(409, 'That question was already answered. Refreshing…');

  const q = set.questions[idx];
  const correct = choice === q.correctIndex;
  attempt.answers.push({ choice, correct, at: new Date().toISOString() });
  attempt.phase = 'reveal';

  let reward = null;
  if (attempt.answers.length >= COUNT) {
    const score = attempt.answers.filter((a) => a.correct).length;
    attempt.completed = true;
    attempt.score = score;
    attempt.completedAt = new Date().toISOString();
    reward = { coins: score * COINS_PER_CORRECT, xp: score * XP_PER_CORRECT };
    attempt.result = { score, total: COUNT, ...reward };
  }
  await putRow('daily_question_attempts', attemptId(date, uid), attempt);

  await players.mutateUser(uid, (data, gaming) => {
    players.recordAnswer(gaming, set.topic, correct);
    players.touchStreak(gaming);
    if (reward) {
      gaming.xp += reward.xp;
      players.addCoins(data, reward.coins);
    }
  });

  if (reward) {
    const scores = await completedScores(date);
    attempt.result.played = scores.length;
    attempt.result.median = median(scores);
    attempt.result.beat = scores.filter((s) => s < attempt.score).length;
    await putRow('daily_question_attempts', attemptId(date, uid), attempt);
  }
  return view(set, attempt);
}

async function next(uid) {
  const date = istDate();
  const set = await getSet(date);
  const attempt = await getAttempt(date, uid);
  if (attempt.phase === 'reveal') {
    attempt.phase = 'question';
    await putRow('daily_question_attempts', attemptId(date, uid), attempt);
  }
  return view(set, attempt);
}

module.exports = { card, play, answer, next, COUNT };
