const express = require('express');
const { verifyToken } = require('../middleware/auth');
const { db, dateLine, istHour, seededShuffle, shortName, initials, istDate, GamingError } = require('../services/gaming/util');
const { TOPICS, LEVEL_XP, levelForRating } = require('../services/gaming/catalog');
const players = require('../services/gaming/players');
const duels = require('../services/gaming/duels');
const oracle = require('../services/gaming/oracle');
const gauntlet = require('../services/gaming/gauntlet');

/**
 * /api/gaming/* — backend for the Arena UI (arena, duels, oracle, gauntlet,
 * leagues, rewards store, vault). Every route needs a signed-in user.
 * Responses are { success: true, data } so the frontend can read `response.data`.
 */
const router = express.Router();
router.use(verifyToken);

const handle = (fn) => async (req, res) => {
  try {
    res.json({ success: true, data: await fn(req) });
  } catch (err) {
    const status = err instanceof GamingError ? err.status : 500;
    if (status >= 500) console.error('[gaming]', req.method, req.originalUrl, err);
    res.status(status).json({ success: false, error: status >= 500 && !(err instanceof GamingError) ? 'Something went wrong' : err.message });
  }
};

const topicCard = (t, gaming) => ({
  id: t.id,
  category: t.category,
  title: t.title,
  level: t.level,
  tone: t.tone,
  stats: `10Q · +${LEVEL_XP[t.level]} XP`,
  accuracy: gaming ? players.accuracy(gaming, t.title) : null,
});

const firstName = (name) => shortName(name).split(' ')[0];

// ------------------------------------------------------------------ profile

router.get('/profile', handle(async (req) => {
  const uid = req.user.uid;
  const { data, gaming } = await players.loadUser(uid);
  const [{ activeDuels }, { league }, affordable] = await Promise.all([
    duels.duelsOverview(uid),
    players.leagueFor(uid, data, gaming),
    countAffordable(players.coinsOf(data)),
  ]);
  return {
    navItems: [
      { id: 'arena', label: 'Arena', path: '/l2dashboard/arena' },
      { id: 'duels', label: 'Duels', path: '/l2dashboard/duels', badge: activeDuels.length || undefined },
      { id: 'oracle', label: 'The Oracle', path: '/l2dashboard/oracle' },
      { id: 'vault', label: 'Vault', path: '/l2dashboard/vault' },
      { id: 'leagues', label: 'Leagues', path: '/l2dashboard/leagues' },
      { id: 'rewards', label: 'Rewards', path: '/l2dashboard/rewards', badge: affordable || undefined, badgeColor: 'orange' },
    ],
    userStats: {
      rating: gaming.rating,
      ratingChange: gaming.lastRatingChange || 0,
      coins: players.coinsOf(data),
      streak: players.currentStreak(gaming),
      xp: gaming.xp,
    },
    league,
  };
}));

async function countAffordable(coins) {
  const { data, error } = await db().from('rewards').select('data');
  if (error) throw error;
  return (data || []).filter((r) => r.data.accessible !== false && (Number(r.data.pointsRequired) || 0) <= coins).length;
}

// ------------------------------------------------------------------ arena

async function trendingTopicIds() {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const { data, error } = await db().from('challenges').select('data').eq('data->>kind', 'duel').gte('created_at', since).limit(500);
  if (error) throw error;
  const counts = new Map();
  for (const r of data || []) for (const round of r.data.rounds || []) if (round.topicId) counts.set(round.topicId, (counts.get(round.topicId) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, n }));
}

router.get('/arena', handle(async (req) => {
  const uid = req.user.uid;
  const tab = String(req.query.tab || 'FOR YOU').toUpperCase();
  const { data, gaming } = await players.loadUser(uid);
  const [card, trending, activeCount] = await Promise.all([gauntlet.card(uid), trendingTopicIds(), countActiveDuels()]);

  let picks;
  if (tab === 'TRENDING') {
    const ids = trending.map((t) => t.id);
    picks = [...ids.map((id) => TOPICS.find((t) => t.id === id)).filter(Boolean), ...seededShuffle(TOPICS, `trend:${istDate()}`)];
  } else if (tab === 'YOUR LEVEL') {
    const level = levelForRating(gaming.rating);
    picks = seededShuffle(TOPICS.filter((t) => t.level === level), `level:${uid}:${istDate()}`);
  } else {
    // For you: weakest categories you have played first, then a daily shuffle.
    const weak = Object.entries(gaming.catStats || {})
      .filter(([, s]) => s.n >= 3)
      .sort((a, b) => a[1].c / a[1].n - b[1].c / b[1].n)
      .map(([title]) => TOPICS.find((t) => t.title === title))
      .filter(Boolean);
    picks = [...weak, ...seededShuffle(TOPICS, `foryou:${uid}:${istDate()}`)];
  }
  const topics = [...new Map(picks.map((t) => [t.id, t])).values()].slice(0, 3).map((t) => topicCard(t, gaming));

  const hour = istHour();
  const part = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
  const streakDays = players.currentStreak(gaming);
  const playedToday = gaming.streak.lastDate === istDate();
  const top = trending[0] && TOPICS.find((t) => t.id === trending[0].id);

  return {
    dateLine: dateLine(),
    greeting: `${part}, ${firstName(data.name)}.`,
    gauntlet: card,
    streak: {
      days: streakDays,
      filled: Math.min(streakDays, 28),
      note: streakDays === 0
        ? 'Play anything today to start a streak.'
        : playedToday ? 'You have played today. Come back tomorrow to keep it going.' : 'Play anything today to keep it alive.',
    },
    topicTabs: ['FOR YOU', 'TRENDING', 'YOUR LEVEL'],
    topics,
    ticker: [
      `${activeCount} duel${activeCount === 1 ? '' : 's'} in progress`,
      card.stats.includes('played') ? card.stats.split(' · ')[0] + " today's gauntlet" : null,
      top ? `Trending: ${top.title} (${trending[0].n} round${trending[0].n === 1 ? '' : 's'} this week)` : null,
    ].filter(Boolean).join(' · '),
  };
}));

async function countActiveDuels() {
  const { count, error } = await db().from('challenges').select('id', { count: 'exact', head: true }).eq('data->>kind', 'duel').eq('data->>status', 'active');
  if (error) throw error;
  return count || 0;
}

router.get('/arena/sidebar', handle(async (req) => {
  const uid = req.user.uid;
  const { data, gaming } = await players.loadUser(uid);
  const [{ activeDuels }, { standings }] = await Promise.all([duels.duelsOverview(uid), players.leagueFor(uid, data, gaming)]);
  return {
    yourMoves: activeDuels.slice(0, 3).map((d) => ({ id: d.id, initials: d.initials, name: d.name, timeLeft: d.timeLeft.toLowerCase(), color: d.avatarColor })),
    standings: players.standingsAround(standings),
    oraclePromo: oracle.promo(gaming),
  };
}));

// ------------------------------------------------------------------ gauntlet

router.get('/gauntlet', handle((req) => gauntlet.play(req.user.uid)));
router.post('/gauntlet/answer', handle((req) => gauntlet.answer(req.user.uid, req.body || {})));
router.post('/gauntlet/next', handle((req) => gauntlet.next(req.user.uid)));

// ------------------------------------------------------------------ duels

router.get('/duels', handle(async (req) => {
  const { activeDuels, waitingOnThem, finished } = await duels.duelsOverview(req.user.uid);
  return {
    tabs: [
      { id: 'your-turn', label: 'Your turn', count: activeDuels.length },
      { id: 'their-turn', label: 'Their turn', count: waitingOnThem.length },
      { id: 'finished', label: 'Finished', count: finished.length },
    ],
    activeDuels,
    waitingOnThem,
    finished,
    finishedCount: finished.length,
    emptyFinishedMessage: finished.length ? null : 'No finished duels yet.',
  };
}));

router.get('/opponents', handle(async (req) => {
  const uid = req.user.uid;
  const { data } = await players.loadUser(uid);
  let pool = (await players.listStudents(data.instituteCode)).filter((p) => p.uid !== uid);
  if (!pool.length) pool = (await players.listStudents()).filter((p) => p.uid !== uid);
  pool.sort((a, b) => b.rating - a.rating);
  return {
    opponents: pool.map((p) => ({ uid: p.uid, name: shortName(p.name), initials: initials(p.name), rating: p.rating })),
    topics: TOPICS.map((t) => ({ id: t.id, title: t.title, category: t.category })),
  };
}));

router.post('/duels', handle((req) => duels.createDuel(req.user.uid, req.body || {})));
router.get('/duels/:id/round', handle((req) => duels.roundView(req.user.uid, req.params.id)));
router.post('/duels/:id/round/answer', handle((req) => duels.answerQuestion(req.user.uid, req.params.id, req.body || {})));
router.post('/duels/:id/round/powerup', handle((req) => duels.usePowerUp(req.user.uid, req.params.id, req.body || {})));
router.post('/duels/:id/category', handle((req) => duels.pickCategory(req.user.uid, req.params.id, (req.body || {}).topicId)));
router.post('/duels/:id/nudge', handle((req) => duels.nudge(req.user.uid, req.params.id)));

// ------------------------------------------------------------------ oracle

router.get('/oracle/run', handle((req) => oracle.getRun(req.user.uid)));
router.post('/oracle/start', handle((req) => oracle.startRun(req.user.uid, req.body || {})));
router.post('/oracle/answer', handle((req) => oracle.answer(req.user.uid, req.body || {})));
router.post('/oracle/next', handle((req) => oracle.next(req.user.uid)));
router.post('/oracle/pause', handle((req) => oracle.pause(req.user.uid)));

// ------------------------------------------------------------------ leagues

router.get('/leagues', handle(async (req) => {
  const uid = req.user.uid;
  const { data, gaming } = await players.loadUser(uid);
  const { league, standings } = await players.leagueFor(uid, data, gaming);
  return { league, standings: standings.map(({ uid: _u, ...row }) => row) };
}));

// ------------------------------------------------------------------ vault

router.get('/vault', handle(async (req) => {
  const { gaming } = await players.loadUser(req.user.uid);
  const byCat = new Map();
  for (const t of TOPICS) {
    if (!byCat.has(t.category)) byCat.set(t.category, []);
    byCat.get(t.category).push(topicCard(t, gaming));
  }
  return { categories: [...byCat.entries()].map(([name, topics]) => ({ name, topics })) };
}));

// ------------------------------------------------------------------ rewards store

const COINS_PER_RUPEE = 5;
const STAGES = { pending: 'PLACED', processing: 'PACKED', approved: 'PACKED', shipped: 'SHIPPED', delivered: 'HOME', completed: 'HOME' };
const titleCase = (s) => String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());

router.get('/rewards/store', handle(async (req) => {
  const uid = req.user.uid;
  const category = String(req.query.category || 'all').toLowerCase();
  const { data: user, gaming } = await players.loadUser(uid);
  const coins = players.coinsOf(user);

  const [{ data: rewardRows, error: rErr }, { data: redemptionRows, error: dErr }] = await Promise.all([
    db().from('rewards').select('id, data'),
    db().from('redemptions').select('id, data, created_at').eq('data->>userId', uid).order('created_at', { ascending: false }).limit(20),
  ]);
  if (rErr) throw rErr;
  if (dErr) throw dErr;

  const all = (rewardRows || []).map((r) => {
    const d = r.data || {};
    const price = Math.max(0, Math.round(Number(d.pointsRequired) || 0));
    const locked = d.accessible === false;
    const stock = d.stock == null ? null : Number(d.stock);
    const soldOut = stock !== null && stock <= 0;
    const afford = !locked && !soldOut && coins >= price;
    return {
      id: r.id,
      category: String(d.category || 'other').toUpperCase(),
      categoryId: String(d.category || 'other').toLowerCase(),
      title: d.name || 'Reward',
      desc: d.description || '',
      price,
      afford,
      left: stock !== null && stock > 0 && stock <= 5 ? String(stock) : undefined,
      locked: locked || soldOut,
      tier: soldOut ? 'SOLD OUT' : locked ? 'NOT AVAILABLE' : undefined,
      action: locked || soldOut ? 'LOCKED' : afford ? 'REDEEM' : 'SAVE',
      isGoal: gaming.goalRewardId === r.id,
    };
  });
  const cheapestAffordable = all.filter((p) => p.afford).sort((a, b) => a.price - b.price)[0];
  if (cheapestAffordable) cheapestAffordable.badge = 'YOU CAN AFFORD';

  const catCounts = new Map();
  for (const p of all) catCounts.set(p.categoryId, (catCounts.get(p.categoryId) || 0) + 1);
  const products = category === 'all' ? all : all.filter((p) => p.categoryId === category);

  const goal = all.find((p) => p.id === gaming.goalRewardId);
  const top = goal || [...all].filter((p) => !p.locked).sort((a, b) => b.price - a.price)[0];
  const featured = top
    ? { id: top.id, title: top.title, price: top.price, progress: Math.min(coins, top.price), badge: goal ? 'YOUR GOAL' : 'TOP PRIZE IN THE STORE', isGoal: !!goal, afford: top.afford }
    : null;

  const orders = (redemptionRows || []).map((r) => ({ id: r.id, ...r.data, created_at: r.created_at }));
  const inTransit = orders.filter((o) => !['delivered', 'completed', 'cancelled', 'rejected'].includes(String(o.status || '').toLowerCase()));
  const latest = orders[0];
  const order = latest ? {
    id: latest.id.slice(0, 8).toUpperCase(),
    item: latest.rewardName || latest.productInfo?.name || 'Reward',
    date: new Date(latest.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }),
    stage: STAGES[String(latest.status || 'pending').toLowerCase()] || 'PLACED',
    note: latest.emailSent ? 'Confirmation emailed. We will update the status as it moves.' : 'We have your request and will be in touch.',
  } : null;

  const goalShort = featured ? Math.max(0, featured.price - coins) : 0;
  return {
    wallet: {
      coins,
      rupees: Math.floor(coins / COINS_PER_RUPEE),
      goalNote: featured
        ? goalShort > 0 ? `${goalShort.toLocaleString('en-IN')} more for ${featured.title}.` : `You can redeem ${featured.title} now.`
        : 'Pick a goal in the store.',
      goalProgress: featured && featured.price ? Math.min(1, coins / featured.price) : 0,
    },
    categories: [
      { id: 'all', label: 'All goods', count: all.length },
      ...[...catCounts.entries()].map(([id, count]) => ({ id, label: titleCase(id), count })),
    ],
    filters: ['ALL', ...[...catCounts.keys()].map((c) => c.toUpperCase()), 'UNDER 5,000'],
    sortLabel: 'Affordable',
    ordersInTransit: inTransit.length,
    itemCount: all.filter((p) => !p.locked).length,
    featured,
    order,
    products,
    under5000: all.filter((p) => !p.locked && p.price < 5000).sort((a, b) => a.price - b.price).slice(0, 3).map((p) => ({ id: p.id, title: p.title, price: p.price, afford: p.afford })),
    earnGoals: [
      { task: "Finish today's gauntlet", coins: `up to +${gauntlet.COUNT * 5}` },
      { task: 'Win a duel', coins: `+${duels.WIN_COINS}` },
      { task: 'Beat the Oracle', coins: 'up to +200' },
    ],
  };
}));

router.post('/rewards/goal', handle(async (req) => {
  const rewardId = (req.body || {}).rewardId || null;
  if (rewardId) {
    const { data, error } = await db().from('rewards').select('id').eq('id', rewardId).maybeSingle();
    if (error) throw error;
    if (!data) throw new GamingError(404, 'Reward not found');
  }
  await players.mutateUser(req.user.uid, (data, gaming) => {
    gaming.goalRewardId = rewardId;
  });
  return { goalRewardId: rewardId };
}));

module.exports = router;
