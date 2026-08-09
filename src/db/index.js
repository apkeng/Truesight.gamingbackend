/**
 * Database access for Supabase PostgreSQL (JSON document tables).
 */
const { getSupabase, getSupabaseAnon } = require('../config/supabase');
const store = require('./store');

module.exports = {
  getDb: store.getDb,
  getSupabase,
  getSupabaseAnon,
  FieldValue: store.FieldValue,
  Timestamp: store.Timestamp,
};
