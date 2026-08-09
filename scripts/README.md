# Test Users Setup Script

Creates test users in **Supabase Auth** and the `users` table for local development.

## Usage

```bash
node scripts/setup-test-users.js
```

Requires `truesight.gamingBackend/.env` with:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=sb_publishable_...
SUPABASE_SERVICE_ROLE_KEY=eyJ... or sb_secret_...
```

## What it creates

- 1 Institute Admin
- 3 Level-1 Teachers
- 5 Level-2 Students

All under institute **Test Academy**. See script output for emails/passwords.

## Test all endpoints

```bash
node scripts/test-endpoints.js
```

Runs auth → users → projects → rewards → challenges → events in order. Requires test users (`setup-test-users.js`) and backend on port 5002.

Optional: set `LLM_API_KEY` in `.env` to test challenges and daily questions generation.

- Safe to re-run — existing users are updated, not duplicated
- Uses `src/db` and `src/services/authService.js` (Supabase only, no Firebase)
