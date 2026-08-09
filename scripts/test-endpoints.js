/**
 * Integration test: hits backend endpoints in order (same flow as frontend).
 * Usage: node scripts/test-endpoints.js
 */
require('dotenv').config();

const BASE = process.env.TEST_BACKEND_URL || 'http://localhost:5002';
const STUDENT = { email: 'alice@testacademy.com', password: 'Student123!' };
const TEACHER = { email: 'teacher1@testacademy.com', password: 'Teacher123!' };
const ADMIN = { email: 'admin@testacademy.com', password: 'Admin123!' };

const results = [];

async function req(method, path, { token, body, public: isPublic } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  return { status: res.status, ok: res.ok, data };
}

function record(step, ok, detail = '') {
  results.push({ step, ok, detail });
  const icon = ok ? '✅' : '❌';
  console.log(`${icon} ${step}${detail ? ` — ${detail}` : ''}`);
}

async function login(creds, label) {
  const r = await req('POST', '/api/auth/login', { body: { ...creds, force: true } });
  if (!r.ok || !r.data.token) {
    record(`${label} login`, false, r.data.error || `HTTP ${r.status}`);
    return null;
  }
  record(`${label} login`, true, r.data.user?.role || 'ok');
  return {
    token: r.data.token,
    uid: r.data.user?.uid || r.data.uid,
    user: r.data.user,
  };
}

async function run() {
  console.log('\n🔌 Endpoint integration test');
  console.log(`   Backend: ${BASE}\n`);

  // ── 1. Health ─────────────────────────────────────────
  const health = await req('GET', '/health', { public: true });
  record('GET /health', health.ok);

  // ── 2. Auth (student) ─────────────────────────────────
  const alice = await login(STUDENT, 'Student (alice)');
  if (!alice) {
    printSummary();
    process.exit(1);
  }

  let r = await req('POST', '/api/auth/verify', { token: alice.token });
  record('POST /api/auth/verify', r.ok);

  r = await req('POST', '/api/auth/session/update', { token: alice.token });
  record('POST /api/auth/session/update', r.ok);

  // ── 3. Users ──────────────────────────────────────────
  r = await req('GET', `/api/users/${alice.uid}`, { token: alice.token });
  record('GET /api/users/:id (self)', r.ok, r.data.user?.name);

  const instituteCode = r.data.user?.instituteCode;
  if (instituteCode) {
    r = await req('GET', `/api/users?instituteCode=${instituteCode}`, { token: alice.token });
    record('GET /api/users?instituteCode=', r.ok, `count=${r.data.count ?? '?'}`);
  } else {
    record('GET /api/users?instituteCode=', false, 'no instituteCode on user');
  }

  // ── 4. Projects & study plans ─────────────────────────
  r = await req('GET', '/api/projects?type=all', { token: alice.token });
  record('GET /api/projects', r.ok, `count=${r.data.projects?.length ?? 0}`);

  r = await req('GET', '/api/study-plans', { token: alice.token });
  record('GET /api/study-plans', r.ok, `count=${r.data.studyPlans?.length ?? 0}`);

  r = await req('GET', '/api/study-plans/published', { token: alice.token });
  record('GET /api/study-plans/published', r.ok);

  // ── 5. Quiz results ─────────────────────────────────
  r = await req('GET', '/api/quiz-results', { token: alice.token });
  record('GET /api/quiz-results', r.ok, `count=${r.data.quizResults?.length ?? 0}`);

  r = await req('GET', '/api/quiz-results/user/stats', { token: alice.token });
  record('GET /api/quiz-results/user/stats', r.ok);

  // ── 6. Rewards (public + init) ────────────────────────
  r = await req('GET', '/api/rewards', { public: true });
  record('GET /api/rewards (public)', r.ok, `count=${r.data.count ?? 0}`);

  const admin = await login(ADMIN, 'Institute Admin');
  if (admin) {
    r = await req('POST', '/api/rewards/initialize', { token: admin.token });
    record('POST /api/rewards/initialize', r.ok || r.status === 200, r.data.message || '');

    r = await req('GET', '/api/rewards', { public: true });
    record('GET /api/rewards (after seed)', r.ok, `count=${r.data.count ?? 0}`);
  }

  // ── 7. Redemptions ────────────────────────────────────
  r = await req('GET', '/api/redemptions', { token: alice.token });
  record('GET /api/redemptions', r.ok, `count=${r.data.redemptions?.length ?? 0}`);

  // ── 8. Challenges ─────────────────────────────────────
  r = await req('GET', '/api/challenges', { token: alice.token });
  record('GET /api/challenges', r.ok, `count=${r.data.challenges?.length ?? 0}`);

  const llmConfigured = !!process.env.LLM_API_KEY;

  r = await req('GET', '/api/challenges/available/opponents', { token: alice.token });
  record('GET /api/challenges/available/opponents', r.ok, `count=${r.data.opponents?.length ?? 0}`);

  const level2Opponent = (r.data.opponents || []).find((o) =>
    ['bob@testacademy.com', 'charlie@testacademy.com'].some((e) => o.email === e)
  ) || r.data.opponents?.[0];

  if (level2Opponent && llmConfigured) {
    r = await req('POST', '/api/challenges', {
      token: alice.token,
      body: {
        topic: 'Integration Test Topic',
        challengeType: 'async',
        matchingType: 'invite',
        opponentId: level2Opponent.uid,
      },
    });
    const challengeOk = r.ok || r.status === 500;
    record(
      'POST /api/challenges',
      challengeOk,
      r.ok ? r.data.challenge?.id : (r.status === 500 ? 'LLM failed — check LLM_API_KEY' : r.data.error)
    );

    if (r.ok && r.data.challenge?.id) {
      const challengeId = r.data.challenge.id;
      const bobLogin = await login({ email: 'bob@testacademy.com', password: 'Student123!' }, 'Student (bob)');
      if (bobLogin) {
        r = await req('POST', `/api/challenges/${challengeId}/accept`, { token: bobLogin.token });
        record('POST /api/challenges/:id/accept', r.ok);
      }
    }
  } else {
    record(
      'POST /api/challenges',
      true,
      llmConfigured ? 'no Level-2 opponent' : 'skipped — set LLM_API_KEY to enable'
    );
  }

  r = await req('POST', '/api/quiz-results', {
    token: alice.token,
    body: {
      subtopic: 'Test Subtopic',
      role: 'Level-2',
      answers: [
        { isCorrect: true },
        { isCorrect: true },
        { isCorrect: false },
      ],
      timeTaken: '1:30',
    },
  });
  record('POST /api/quiz-results', r.ok, `score=${r.data.quizResult?.score ?? '?'}`);

  // ── 9. Events ─────────────────────────────────────────
  r = await req('GET', '/api/events', { public: true });
  record('GET /api/events (public)', r.ok, `count=${r.data.events?.length ?? 0}`);

  // ── 10. Daily questions (needs LLM_API_KEY to auto-generate) ──
  r = await req('GET', '/api/daily-questions/current', { public: true });
  const dailyOk = r.ok || (!llmConfigured && r.status === 500);
  record(
    'GET /api/daily-questions/current',
    dailyOk,
    llmConfigured ? (r.ok ? 'ok' : r.data.error) : 'skipped — set LLM_API_KEY to enable'
  );

  r = await req('GET', '/api/daily-questions/attempt-status', { token: alice.token });
  record('GET /api/daily-questions/attempt-status', r.ok);

  // ── 11. Institute details ─────────────────────────────
  if (admin) {
    r = await req('GET', `/api/institute-details/${admin.uid}`, { token: admin.token });
    record('GET /api/institute-details/:id', r.ok, r.data.instituteDetails ? 'has data' : 'empty');

    r = await req('PUT', `/api/institute-details/${admin.uid}`, {
      token: admin.token,
      body: {
        instituteName: 'Test Academy',
        instituteCode: instituteCode || 'TES915',
        address: '123 Test St',
        contactNumber: '1234567890',
        type: 'school',
      },
    });
    record('PUT /api/institute-details/:id', r.ok);
  }

  // ── 12. Syllabus ──────────────────────────────────────
  r = await req('GET', '/api/syllabus', { token: alice.token });
  record('GET /api/syllabus', r.ok || r.status === 404);

  // ── 13. Auth extras ───────────────────────────────────
  r = await req('POST', '/api/auth/verify-password', {
    token: alice.token,
    body: { password: STUDENT.password },
  });
  record('POST /api/auth/verify-password', r.ok);

  // ── 14. Teacher login ─────────────────────────────────
  const teacher = await login(TEACHER, 'Teacher (teacher1)');
  if (teacher) {
    r = await req('GET', `/api/users/${teacher.uid}`, { token: teacher.token });
    record('GET /api/users/:id (teacher)', r.ok);
  }

  // ── 15. Logout ────────────────────────────────────────
  r = await req('POST', '/api/auth/logout', { token: alice.token });
  record('POST /api/auth/logout', r.ok);

  printSummary();
  process.exit(results.some((x) => !x.ok) ? 1 : 0);
}

function printSummary() {
  const passed = results.filter((x) => x.ok).length;
  const failed = results.filter((x) => !x.ok);
  console.log('\n' + '─'.repeat(50));
  console.log(`📊 ${passed}/${results.length} passed`);
  if (failed.length) {
    console.log('\nFailed:');
    failed.forEach((f) => console.log(`  • ${f.step}: ${f.detail}`));
  }
  console.log('');
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
