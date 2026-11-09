/**
 * Topic catalogue for the Arena, Vault, Oracle runs, duel categories and the daily gauntlet.
 * `tone` is mapped to a gradient on the frontend (purple | gold | teal).
 * `level` drives the "YOUR LEVEL" tab: Easy < 1300 rating, Medium < 1700, Hard above.
 */
const TOPICS = [
  { id: 'mughal-succession', category: 'Indian History', title: 'Mughal Succession Wars', level: 'Hard', tone: 'purple' },
  { id: 'chola-sea-routes', category: 'Indian History', title: 'Chola Bronzes & Sea Routes', level: 'Hard', tone: 'purple' },
  { id: 'revolt-1857', category: 'Indian History', title: 'The Revolt of 1857', level: 'Medium', tone: 'purple' },
  { id: 'harappan-cities', category: 'Indian History', title: 'Harappan Cities', level: 'Easy', tone: 'purple' },
  { id: 'freedom-struggle', category: 'Indian History', title: 'Freedom Struggle, 1915–47', level: 'Medium', tone: 'purple' },
  { id: 'constitution-amendments', category: 'Polity', title: 'Constitution: Schedules & Amendments', level: 'Medium', tone: 'teal' },
  { id: 'fundamental-rights', category: 'Polity', title: 'Landmark Fundamental Rights Cases', level: 'Hard', tone: 'teal' },
  { id: 'parliament-procedure', category: 'Polity', title: 'How Parliament Works', level: 'Easy', tone: 'teal' },
  { id: 'monsoon-systems', category: 'Geography', title: 'The Indian Monsoon', level: 'Medium', tone: 'gold' },
  { id: 'deccan-geology', category: 'Geography', title: 'Indian Geology & the Deccan Traps', level: 'Hard', tone: 'gold' },
  { id: 'rivers-of-india', category: 'Geography', title: 'Rivers of India', level: 'Easy', tone: 'gold' },
  { id: 'economy-1991', category: 'Economy', title: 'Indian Economy Since 1991', level: 'Medium', tone: 'teal' },
  { id: 'banking-basics', category: 'Economy', title: 'Banking & the RBI', level: 'Easy', tone: 'teal' },
  { id: 'isro-missions', category: 'Science & Tech', title: 'ISRO Missions', level: 'Easy', tone: 'teal' },
  { id: 'everyday-chemistry', category: 'Science & Tech', title: 'Everyday Chemistry', level: 'Medium', tone: 'teal' },
  { id: 'computing-pioneers', category: 'Science & Tech', title: 'Computing Pioneers', level: 'Medium', tone: 'teal' },
  { id: 'protected-areas', category: 'Environment', title: 'National Parks & Biosphere Reserves', level: 'Medium', tone: 'gold' },
  { id: 'climate-agreements', category: 'Environment', title: 'Climate Agreements', level: 'Hard', tone: 'gold' },
  { id: 'classical-dance', category: 'Art & Culture', title: 'Classical Dance Forms', level: 'Easy', tone: 'purple' },
  { id: 'mughal-architecture', category: 'Art & Culture', title: 'Mughal Art & Architecture', level: 'Medium', tone: 'purple' },
  { id: 'cricket-tests', category: 'Sports', title: 'Indian Cricket: Overseas Tests', level: 'Medium', tone: 'gold' },
  { id: 'olympic-india', category: 'Sports', title: 'India at the Olympics', level: 'Easy', tone: 'gold' },
  { id: 'world-organisations', category: 'World Affairs', title: 'World Organisations & Summits', level: 'Medium', tone: 'teal' },
  { id: 'cold-war', category: 'World Affairs', title: 'The Cold War', level: 'Hard', tone: 'teal' },
];

const LEVEL_XP = { Easy: 100, Medium: 150, Hard: 180 };

const byId = new Map(TOPICS.map((t) => [t.id, t]));

const getTopic = (id) => byId.get(id) || null;

/** Accepts a catalogue id or a free-text name and returns a topic-like object. */
function resolveTopic(idOrName) {
  if (!idOrName) return null;
  const hit = byId.get(idOrName) || TOPICS.find((t) => t.title.toLowerCase() === String(idOrName).toLowerCase());
  return hit || null;
}

const levelForRating = (rating) => (rating < 1300 ? 'Easy' : rating < 1700 ? 'Medium' : 'Hard');

module.exports = { TOPICS, LEVEL_XP, getTopic, resolveTopic, levelForRating };
