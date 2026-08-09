# Truesight Gaming Backend

Express API for **Truesight Gaming**, powered entirely by **Supabase** (Auth + PostgreSQL).

## Setup

1. Create a [Supabase](https://supabase.com) project.

2. Run the database schema in the Supabase SQL Editor:
   ```
   supabase/schema.sql
   ```

3. Copy environment variables:
   ```bash
   cp .env.example .env
   ```

4. Fill in `.env`:
   - `SUPABASE_URL` — Project URL
   - `SUPABASE_ANON_KEY` — publishable key
   - `SUPABASE_SERVICE_ROLE_KEY` — secret / service role key (keep private)
   - `FRONTEND_URL` — gaming frontend URL

5. Install and run:
   ```bash
   npm install
   npm run dev
   ```

Default port: **5002**

## Architecture (Supabase only)

```
config/supabase.js         → Supabase clients
db/index.js                → getDb(), FieldValue, getSupabase()
db/store.js                → JSON document storage layer
services/authService.js    → Supabase Auth admin
services/databaseService.js → Direct Supabase queries (rewards, OTP)
routes/*.js                → Express HTTP handlers
```

No Firebase dependencies or imports.

## Test users

```bash
node scripts/setup-test-users.js
```

## Frontend

Set in `truesight.gaming/.env`:

```
REACT_APP_BACKEND_URL=http://localhost:5002
```
