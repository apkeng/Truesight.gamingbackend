-- Truesight Gaming - Supabase schema
-- Run this in the Supabase SQL Editor for your project.

-- Generic document storage (mirrors Firestore collections)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_activity_logs (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS private_projects (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS collaborations (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS study_plans (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quiz_results (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rewards (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS redemptions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_registrations (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daily_questions (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daily_question_attempts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS institute_details (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS password_reset_otps (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_syllabus (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common JSONB field queries
CREATE INDEX IF NOT EXISTS idx_sessions_uid ON sessions ((data->>'uid'));
CREATE INDEX IF NOT EXISTS idx_private_projects_uid ON private_projects ((data->>'uid'));
CREATE INDEX IF NOT EXISTS idx_collaborations_uid ON collaborations ((data->>'uid'));
CREATE INDEX IF NOT EXISTS idx_quiz_results_user_id ON quiz_results ((data->>'userId'));
CREATE INDEX IF NOT EXISTS idx_challenges_challenger ON challenges ((data->>'challengerId'));
CREATE INDEX IF NOT EXISTS idx_challenges_opponent ON challenges ((data->>'opponentId'));
CREATE INDEX IF NOT EXISTS idx_redemptions_user_id ON redemptions ((data->>'userId'));
CREATE INDEX IF NOT EXISTS idx_event_registrations_user ON event_registrations ((data->>'userId'));
CREATE INDEX IF NOT EXISTS idx_daily_attempts_user ON daily_question_attempts ((data->>'userId'));
CREATE INDEX IF NOT EXISTS idx_users_institute_code ON users ((data->>'instituteCode'));
CREATE INDEX IF NOT EXISTS idx_users_role ON users ((data->>'role'));
CREATE INDEX IF NOT EXISTS idx_rewards_accessible ON rewards ((data->>'accessible'));
CREATE INDEX IF NOT EXISTS idx_rewards_reward_id ON rewards ((data->>'id'));
CREATE INDEX IF NOT EXISTS idx_events_status ON events ((data->>'status'));
