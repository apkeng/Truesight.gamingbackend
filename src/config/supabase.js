const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const supabaseAnonKey =
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;

const clientOptions = {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: WebSocket },
};

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn(
    '\n⚠️  Supabase credentials not configured!\n' +
    'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your .env file.\n'
  );
} else if (
  supabaseServiceKey.startsWith('sb_publishable_') ||
  supabaseServiceKey === supabaseAnonKey
) {
  console.warn(
    '\n⚠️  SUPABASE_SERVICE_ROLE_KEY looks wrong!\n' +
    'It must be the SECRET key (sb_secret_... or legacy service_role JWT),\n' +
    'NOT the publishable/anon key. Auth admin (createUser) will fail otherwise.\n' +
    'Get it from Supabase Dashboard → Connect → Server → SUPABASE_SECRET_KEY → Reveal\n'
  );
}

const supabaseAdmin = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey, clientOptions)
  : null;

const supabaseAnon = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, clientOptions)
  : supabaseAdmin;

const getSupabase = () => {
  if (!supabaseAdmin) {
    throw new Error('Supabase not initialized. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }
  return supabaseAdmin;
};

const getSupabaseAnon = () => {
  if (!supabaseAnon) {
    throw new Error('Supabase not initialized. Set SUPABASE_URL and SUPABASE_ANON_KEY.');
  }
  return supabaseAnon;
};

module.exports = {
  supabaseAdmin,
  supabaseAnon,
  getSupabase,
  getSupabaseAnon,
};
