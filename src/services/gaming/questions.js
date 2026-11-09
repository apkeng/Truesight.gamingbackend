const { shuffle, GamingError } = require('./util');

/**
 * Multiple-choice question generation for games.
 * Uses a fast Gemini model (configurable with GAMING_LLM_MODEL) because players
 * wait on these calls; the rest of the app keeps its own model in llmService.
 */

const MODEL = () => (process.env.GAMING_LLM_MODEL || 'gemini-2.5-flash').trim();
const TIMEOUT_MS = 60000;

function apiKey() {
  const key = (process.env.LLM_API_KEY || '').trim();
  if (!key) throw new GamingError(503, 'Question service is not configured (LLM_API_KEY missing).');
  return key;
}

async function callModel(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent?key=${apiKey()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.9, responseMimeType: 'application/json', maxOutputTokens: 12000 },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LLM ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } finally {
    clearTimeout(timer);
  }
}

/** Validate one raw question and shuffle its options so the answer position is unbiased. */
function cleanQuestion(raw) {
  if (!raw || typeof raw.question !== 'string' || !Array.isArray(raw.options)) return null;
  const options = raw.options.map((o) => String(o).trim()).filter(Boolean);
  if (options.length !== 4 || new Set(options.map((o) => o.toLowerCase())).size !== 4) return null;
  let correct = Number.isInteger(raw.correctIndex) ? raw.correctIndex : options.indexOf(String(raw.correctAnswer || '').trim());
  if (correct < 0 || correct > 3) return null;
  const order = shuffle([0, 1, 2, 3]);
  return {
    question: raw.question.trim(),
    options: order.map((i) => options[i]),
    correctIndex: order.indexOf(correct),
    explanation: String(raw.explanation || '').trim(),
    hint: String(raw.hint || '').trim(),
  };
}

/**
 * Generate `count` questions on a topic.
 * difficulty: { from, to } on a 1–10 scale; questions ramp from `from` to `to`.
 * Returns { title?, questions: [...] }.
 */
async function generateQuestions({ topic, count, difficulty = { from: 4, to: 6 }, withTitle = false, audience }) {
  const who = audience || 'Indian students preparing for competitive exams such as UPSC, and general-knowledge enthusiasts';
  const ramp = difficulty.from === difficulty.to
    ? `All questions should be about difficulty ${difficulty.from} on a 1–10 scale.`
    : `Difficulty should ramp evenly from ${difficulty.from} (first question) to ${difficulty.to} (last question) on a 1–10 scale.`;
  const prompt = `Write exactly ${count} multiple-choice quiz questions on the topic "${topic}" for ${who}.
${ramp}
Rules:
- Each question has exactly 4 distinct options and exactly one correct answer.
- Facts must be accurate and unambiguous; avoid "all of the above"/"none of the above".
- Vary the sub-themes; no two questions should test the same fact.
- "explanation": 1–3 sentences on why the answer is right (an interesting "for the record" note).
- "hint": a short nudge that does not give the answer away.
Return JSON only, in this shape:
{${withTitle ? '"title": "a catchy one-line title for this set, e.g. \\"Twelve on the Mughal succession wars — and who paid for them\\"", ' : ''}"questions": [{"question": "...", "options": ["...", "...", "...", "..."], "correctIndex": 0, "explanation": "...", "hint": "..."}]}`;

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = await callModel(prompt);
      const list = Array.isArray(out) ? out : out.questions;
      const questions = (list || []).map(cleanQuestion).filter(Boolean);
      if (questions.length >= count) {
        return { title: typeof out.title === 'string' ? out.title.trim() : undefined, questions: questions.slice(0, count) };
      }
      lastError = new Error(`Got ${questions.length}/${count} valid questions`);
    } catch (err) {
      lastError = err;
    }
    console.warn(`[gaming] question generation attempt ${attempt + 1} failed:`, lastError.message);
  }
  throw new GamingError(502, 'Could not generate questions right now. Please try again in a moment.');
}

module.exports = { generateQuestions };
