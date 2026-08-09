const crypto = require('crypto');
const { getSupabase } = require('../config/supabase');
const { Pool } = require('pg');

const COLLECTION_MAP = {
  users: 'users',
  sessions: 'sessions',
  userActivityLogs: 'user_activity_logs',
  privateProjects: 'private_projects',
  collaborations: 'collaborations',
  studyPlans: 'study_plans',
  quizResults: 'quiz_results',
  challenges: 'challenges',
  rewards: 'rewards',
  redemptions: 'redemptions',
  events: 'events',
  eventRegistrations: 'event_registrations',
  dailyQuestions: 'daily_questions',
  dailyQuestionAttempts: 'daily_question_attempts',
  instituteDetails: 'institute_details',
  passwordResetOTPs: 'password_reset_otps',
};

const SERVER_TIMESTAMP = Symbol('SERVER_TIMESTAMP');

class Timestamp {
  constructor(value) {
    if (value instanceof Timestamp) {
      this._date = value._date;
      return;
    }
    this._date = value instanceof Date ? value : new Date(value);
  }

  toDate() {
    return this._date;
  }

  static fromDate(date) {
    return new Timestamp(date);
  }
}

const FieldValue = {
  serverTimestamp: () => SERVER_TIMESTAMP,
};

const resolveWriteValue = (value) => {
  if (value === SERVER_TIMESTAMP) {
    return new Date().toISOString();
  }
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const resolved = {};
    for (const [key, nested] of Object.entries(value)) {
      resolved[key] = resolveWriteValue(nested);
    }
    return resolved;
  }
  return value;
};

const wrapReadValue = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return Timestamp.fromDate(date);
    }
  }
  if (Array.isArray(value)) {
    return value.map(wrapReadValue);
  }
  if (typeof value === 'object') {
    const wrapped = {};
    for (const [key, nested] of Object.entries(value)) {
      wrapped[key] = wrapReadValue(nested);
    }
    return wrapped;
  }
  return value;
};

const mergeData = (existing = {}, updates = {}) => {
  const merged = { ...existing, ...updates };
  for (const [key, value] of Object.entries(updates)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Timestamp)) {
      merged[key] = mergeData(existing[key] || {}, value);
    }
  }
  return merged;
};

let pgPool = null;

const getPgPool = () => {
  if (!pgPool && process.env.DATABASE_URL) {
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pgPool;
};

class DocumentSnapshot {
  constructor(id, data, exists = true, table = null) {
    this.id = id;
    this._data = data;
    this.exists = exists;
    this._table = table;
  }

  data() {
    return this.exists ? wrapReadValue({ ...this._data }) : undefined;
  }

  get ref() {
    if (this._table) {
      return new DocumentReference(this._table, this.id);
    }
    return { id: this.id };
  }
}

class QuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.empty = docs.length === 0;
    this.size = docs.length;
  }

  forEach(callback) {
    this.docs.forEach(callback);
  }
}

class DocumentReference {
  constructor(table, id = null, parentPath = null) {
    this.table = table;
    this.id = id;
    this.parentPath = parentPath;
  }

  async get() {
    const supabase = getSupabase();
    const resolvedId = this._resolveId();

    if (this.parentPath) {
      const { data, error } = await supabase
        .from('user_syllabus')
        .select('*')
        .eq('id', resolvedId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return new DocumentSnapshot(resolvedId, null, false, this.table);
      return new DocumentSnapshot(data.id, data.data, true, this.table);
    }

    const { data, error } = await supabase
      .from(this.table)
      .select('*')
      .eq('id', resolvedId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return new DocumentSnapshot(resolvedId, null, false, this.table);
    return new DocumentSnapshot(data.id, data.data, true, this.table);
  }

  async set(payload, options = {}) {
    const supabase = getSupabase();
    const resolved = resolveWriteValue(payload);
    const resolvedId = this._resolveId();

    if (this.parentPath) {
      const row = {
        id: resolvedId,
        data: { ...resolved, _parentPath: this.parentPath },
        updated_at: new Date().toISOString(),
      };
      const { error } = await supabase.from('user_syllabus').upsert(row);
      if (error) throw error;
      return;
    }

    if (options.merge) {
      const existing = await this.get();
      const merged = existing.exists ? mergeData(existing._data, resolved) : resolved;
      const { error } = await supabase.from(this.table).upsert({
        id: resolvedId,
        data: merged,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      return;
    }

    const { error } = await supabase.from(this.table).upsert({
      id: resolvedId,
      data: resolved,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
  }

  async update(payload) {
    const existing = await this.get();
    if (!existing.exists) {
      throw new Error(`Document ${this.id} not found`);
    }
    const resolved = resolveWriteValue(payload);
    const merged = mergeData(existing._data, resolved);
    await this.set(merged);
  }

  async delete() {
    const supabase = getSupabase();
    const resolvedId = this._resolveId();
    const table = this.parentPath ? 'user_syllabus' : this.table;
    const { error } = await supabase.from(table).delete().eq('id', resolvedId);
    if (error) throw error;
  }

  _resolveId() {
    if (this.id) return this.id;
    return crypto.randomUUID();
  }

  collection(name) {
    if (this.table !== 'users') {
      throw new Error('Subcollections are only supported on users');
    }
    return new CollectionReference(name, null, this.id);
  }
}

class Query {
  constructor(table, filters = [], orderByField = null, orderDirection = 'asc', limitCount = null, parentPath = null) {
    this.table = table;
    this.filters = filters;
    this.orderByField = orderByField;
    this.orderDirection = orderDirection;
    this.limitCount = limitCount;
    this.parentPath = parentPath;
  }

  where(field, operator, value) {
    if (operator !== '==') {
      throw new Error(`Unsupported operator: ${operator}`);
    }
    return new Query(
      this.table,
      [...this.filters, { field, operator, value }],
      this.orderByField,
      this.orderDirection,
      this.limitCount,
      this.parentPath
    );
  }

  orderBy(field, direction = 'asc') {
    return new Query(
      this.table,
      this.filters,
      field,
      direction,
      this.limitCount,
      this.parentPath
    );
  }

  limit(count) {
    return new Query(
      this.table,
      this.filters,
      this.orderByField,
      this.orderDirection,
      count,
      this.parentPath
    );
  }

  async get() {
    const supabase = getSupabase();
    const table = this.parentPath ? 'user_syllabus' : this.table;

    let query = supabase.from(table).select('*');

    if (this.parentPath) {
      query = query.contains('data', { _parentPath: this.parentPath });
    }

    for (const filter of this.filters) {
      query = query.eq(`data->>${filter.field}`, String(filter.value));
    }

    if (this.orderByField) {
      query = query.order(`data->>${this.orderByField}`, {
        ascending: this.orderDirection !== 'desc',
      });
    }

    if (this.limitCount) {
      query = query.limit(this.limitCount);
    }

    const { data, error } = await query;
    if (error) throw error;

    const docs = (data || []).map(
      (row) => new DocumentSnapshot(row.id, row.data, true, this.table)
    );
    return new QuerySnapshot(docs);
  }
}

class CollectionReference extends Query {
  constructor(collectionName, parentPath = null, parentId = null) {
    const table = COLLECTION_MAP[collectionName] || collectionName;
    super(table, [], null, 'asc', null, parentPath);
    this.collectionName = collectionName;
    this.parentId = parentId;
  }

  doc(id) {
    if (this.collectionName === 'syllabus' && this.parentId) {
      const docId = `${this.parentId}/syllabus/${id || 'current'}`;
      return new DocumentReference('user_syllabus', docId, this.parentId);
    }
    return new DocumentReference(this.table, id);
  }

  async add(payload) {
    const id = crypto.randomUUID();
    const ref = this.doc(id);
    ref.id = id;
    await ref.set(payload);
    return ref;
  }
}

class WriteBatch {
  constructor() {
    this.operations = [];
  }

  set(ref, data) {
    this.operations.push({ type: 'set', ref, data });
    return this;
  }

  update(ref, data) {
    this.operations.push({ type: 'update', ref, data });
    return this;
  }

  delete(ref) {
    this.operations.push({ type: 'delete', ref });
    return this;
  }

  async commit() {
    for (const op of this.operations) {
      if (op.type === 'set') await op.ref.set(op.data);
      if (op.type === 'update') await op.ref.update(op.data);
      if (op.type === 'delete') await op.ref.delete();
    }
  }
}

class Transaction {
  constructor() {
    this.reads = [];
    this.writes = [];
  }

  async get(ref) {
    const snapshot = await ref.get();
    this.reads.push({ ref, snapshot });
    return snapshot;
  }

  set(ref, data) {
    this.writes.push({ type: 'set', ref, data });
  }

  update(ref, data) {
    this.writes.push({ type: 'update', ref, data });
  }

  delete(ref) {
    this.writes.push({ type: 'delete', ref });
  }
}

class DocumentStore {
  collection(name) {
    return new CollectionReference(name);
  }

  batch() {
    return new WriteBatch();
  }

  async runTransaction(callback) {
    const pool = getPgPool();

    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const transaction = new Transaction();
        await callback(transaction);
        for (const write of transaction.writes) {
          if (write.type === 'set') await write.ref.set(write.data);
          if (write.type === 'update') await write.ref.update(write.data);
          if (write.type === 'delete') await write.ref.delete();
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return;
    }

    const transaction = new Transaction();
    await callback(transaction);
    for (const write of transaction.writes) {
      if (write.type === 'set') await write.ref.set(write.data);
      if (write.type === 'update') await write.ref.update(write.data);
      if (write.type === 'delete') await write.ref.delete();
    }
  }
}

const documentStore = new DocumentStore();

const getDb = () => documentStore;

module.exports = {
  getDb,
  FieldValue,
  Timestamp,
};
