# Architecture Decision

A two-container monolith: a single Go binary that serves both the REST API and the static React SPA, backed by PostgreSQL.

This eliminates CORS entirely (same origin), removes the need for a frontend web server, and reduces docker-compose to two services. The frontend persists the JWT and a pending-transfer queue in `localStorage` so the app remains usable across reloads and connectivity gaps. The backend enforces all financial invariants inside single PostgreSQL transactions with row-level locking and database-level constraints.

We deliberately avoid microservices, message queues, ORMs, refresh tokens, and frontend persistence frameworks. Every component earns its place by solving a concrete problem from the assignment.

---

# System Architecture

```
┌──────────────────────────────────────────────┐
│                   Browser                    │
│                                              │
│  React SPA                                   │
│  ├── JWT in localStorage                     │
│  ├── Pending transfer queue in localStorage  │
│  ├── TanStack Query cache (in-memory)        │
│  └── Client-side inactivity timer            │
└──────────────┬───────────────────────────────┘
               │ HTTP (same origin)
┌──────────────▼───────────────────────────────┐
│          Go Binary (single process)          │
│                                              │
│  / ──────────► Static file server (SPA)      │
│  /api/* ─────► REST handlers                 │
│               ├── Auth (register, login)     │
│               ├── Profile                    │
│               └── Transfers (idempotent)     │
└──────────────┬───────────────────────────────┘
               │ TCP
┌──────────────▼───────────────────────────────┐
│            PostgreSQL                        │
│  Source of truth for users, balances,        │
│  and completed/failed transfers              │
└──────────────────────────────────────────────┘
```

**Component responsibilities:**

| Component | Responsibility |
|-----------|---------------|
| React SPA | UI, form validation, inactivity tracking, offline transfer queue, retry on reconnect |
| Go server | Request validation, business rules, JWT issuance/verification, database transactions, serves SPA static files |
| PostgreSQL | Data persistence, ACID transactions, row-level locking, uniqueness constraints, balance floor constraint |

---

# Technology Decisions

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Backend | Go + `net/http` + `chi` | `chi` adds routing and middleware composition with zero magic. Compatible with `net/http` so no framework lock-in. |
| Database driver | `pgx/v5` | Direct PostgreSQL driver. No ORM — we need explicit control over transactions and `FOR UPDATE` locks. |
| Password hashing | `golang.org/x/crypto/bcrypt` | Standard, well-audited. |
| JWT | `golang-jwt/jwt/v5` | Lightweight, widely used. |
| Frontend | React 18 + TypeScript via Vite | Fast builds, small bundles. TypeScript catches bugs at compile time. |
| Frontend data fetching | TanStack Query v5 | Caching, stale-while-revalidate, retry with backoff, and request deduplication — all built in. Used for GET requests only. |
| HTTP client | Native `fetch` | No Axios. Fetch is built into every browser. |
| Offline mutation queue | Custom ~50-line localStorage queue | Simpler and more transparent than TanStack Query's persist-mutation plugins, which require function serialization workarounds. |
| Database | PostgreSQL 15 | ACID guarantees, `SELECT ... FOR UPDATE`, `CHECK` constraints. |
| Containers | Docker + Docker Compose | Two services: `app` (Go binary with embedded SPA) and `db` (PostgreSQL). |

---

# Data Model

All monetary values are stored as `BIGINT` in cents (lowest denomination). No floating-point.

### Table: `users`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` |
| `email` | `VARCHAR(255)` | `UNIQUE NOT NULL` |
| `password_hash` | `VARCHAR(255)` | `NOT NULL` |
| `balance` | `BIGINT` | `NOT NULL DEFAULT 1000000` (= $10,000 starting balance), `CHECK (balance >= 0)` |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |

The `CHECK (balance >= 0)` constraint is a database-level guarantee against overdrafts. Even if the application logic has a bug, the database will reject a transaction that would drive the balance negative.

### Table: `transfers`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` |
| `idempotency_key` | `UUID` | `UNIQUE NOT NULL` |
| `sender_id` | `UUID` | `NOT NULL REFERENCES users(id)` |
| `recipient_id` | `UUID` | `NOT NULL REFERENCES users(id)` |
| `amount` | `BIGINT` | `NOT NULL CHECK (amount > 0)` |
| `notes` | `TEXT` | `DEFAULT ''` |
| `status` | `VARCHAR(20)` | `NOT NULL` — one of `completed`, `failed` |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |

### Indexes

- `users(email)` — unique index (implicit from `UNIQUE` constraint)
- `transfers(idempotency_key)` — unique index (implicit from `UNIQUE` constraint)
- `transfers(sender_id, created_at DESC)` — for transfer history queries
- `transfers(recipient_id, created_at DESC)` — for transfer history queries

### Schema management

A single `schema.sql` file in the backend directory. The Go app executes it on startup using `IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` guards. No migration framework.

---

# API Design

All endpoints use JSON. All protected endpoints require `Authorization: Bearer <jwt>`.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/auth/register` | No | Create user. Validate email format, password length, password match. |
| `POST` | `/api/auth/login` | No | Verify credentials, return JWT. |
| `GET` | `/api/me` | Yes | Return `{ email, balance }`. |
| `POST` | `/api/transfers` | Yes | Execute transfer. Requires `Idempotency-Key` header. |
| `GET` | `/api/transfers` | Yes | Return transfer history for the authenticated user (sent and received). |

### Deliberately excluded endpoints

- **No `GET /api/users`**. The assignment's transfer form has a "recipient" field — the user types an email. Exposing a user list is a privacy leak and an unnecessary network round-trip. If the recipient email doesn't exist, the backend returns a clear error.

### Request/response conventions

- Errors return `{ "error": "human-readable message" }` with appropriate HTTP status codes.
- The transfer endpoint returns the transfer record on success (including when the idempotency key matches a previous completed transfer).
- `GET /api/me` returns the current server-authoritative balance. The client calls this on reconnect to reconcile.

---

# Authentication & Session

### JWT structure

Claims: `sub` (user UUID), `email`, `exp` (expiry), `iat` (issued at).

Signed with HMAC-SHA256 using a server-side secret from environment variable `JWT_SECRET`.

### Token lifetime: 1 hour

A 24-hour token (as proposed in the original architecture) is too long — a stolen token would be usable all day. A 15-minute token would require refresh tokens, adding complexity and failing during connectivity gaps.

**1 hour** is the pragmatic middle ground: short enough to limit the blast radius of a stolen token, long enough that the user won't be interrupted during normal use with poor connectivity.

### Inactivity timeout: 15 minutes (client-enforced)

The frontend tracks user activity (clicks, keypresses, scroll, touch) and stores `last_active` in `localStorage`. On every activity check and before every API call, if `Date.now() - last_active > 15 minutes`, the frontend deletes the JWT from `localStorage` and redirects to login.

### Why client-enforced inactivity is acceptable

- Server-enforced inactivity would require either: (a) sliding-window token refresh on every request (adds round-trips, fails offline), or (b) a server-side session store (adds infrastructure, defeats stateless JWT).
- The server-side 1-hour hard expiry provides a security ceiling regardless of client behavior.
- An attacker with a stolen token gets at most 1 hour, not 24. The 15-minute client enforcement is defense-in-depth UX, not the security boundary.

### Offline behavior

- If the network is down, the user is NOT logged out (the JWT persists in `localStorage`).
- If the user is actively interacting, the inactivity timer resets — even offline.
- When connectivity returns, the JWT is sent with the next request. If it has expired server-side, the backend returns 401, and the frontend redirects to login.
- The "Hello [email]" greeting can be displayed offline by decoding the JWT's `email` claim client-side — no network request needed for the welcome message itself. The balance requires a server call.

---

# Wallet Transaction & Consistency Model

### The critical invariants

1. A transfer must never execute twice for the same idempotency key.
2. A sender's balance must never go below zero.
3. The sum of all user balances must remain constant (conservation of money).
4. The server is the sole authority on whether a transfer succeeded.

### Transaction flow for `POST /api/transfers`

Everything happens inside a single PostgreSQL transaction:

```
BEGIN;

-- Step 1: Check idempotency. If this key was already used, return the existing result.
SELECT id, status FROM transfers WHERE idempotency_key = $key;
→ If found: COMMIT, return the existing transfer. Done.

-- Step 2: Lock the sender's row to prevent concurrent balance reads.
SELECT balance FROM users WHERE id = $sender_id FOR UPDATE;

-- Step 3: Resolve recipient by email.
SELECT id FROM users WHERE email = $recipient_email FOR UPDATE;
→ If not found: ROLLBACK, return 400 "recipient not found".
→ If recipient = sender: ROLLBACK, return 400 "cannot transfer to self".

-- Step 4: Validate balance.
→ If balance < amount: 
    INSERT INTO transfers (..., status) VALUES (..., 'failed');
    COMMIT, return 400 "insufficient funds".

-- Step 5: Execute transfer.
UPDATE users SET balance = balance - $amount WHERE id = $sender_id;
UPDATE users SET balance = balance + $amount WHERE id = $recipient_id;
INSERT INTO transfers (..., status) VALUES (..., 'completed');

COMMIT;
→ Return the transfer record.
```

### Why this is correct

- **Atomicity**: All balance mutations and the transfer record are in one transaction. Either everything commits or nothing does.
- **No duplicate execution**: The idempotency key check is inside the transaction. If a duplicate request arrives concurrently, one of two things happens: (a) the first transaction has committed — the SELECT finds the existing record; (b) the first transaction is still running — the second transaction blocks on `FOR UPDATE` on the sender row, then sees the first transaction's committed state.
- **No overdraft**: The `FOR UPDATE` lock serializes concurrent transfers from the same sender. The `CHECK (balance >= 0)` constraint is a database-level safety net.
- **Failed transfers are recorded**: If the balance is insufficient, we still record the transfer as `failed`. This ensures that retrying with the same idempotency key returns a consistent "failed" result instead of re-attempting.

### Why we lock the recipient FOR UPDATE

The original architecture only locked the sender. We lock the recipient too because the sender resolution happens by email, and we need a consistent read of the recipient's `id`. More importantly, locking both participants serializes the transaction fully, preventing any possible MVCC anomaly during the balance updates. The performance cost is negligible for this application's scale.

---

# Idempotency & Failure Recovery

### Client-generated idempotency keys

When the user submits a transfer, the frontend generates a UUID v4 as the idempotency key **before** sending the request. This key is stored in the pending queue in `localStorage` alongside the transfer details.

### Failure scenarios and how they resolve

| Scenario | What happens |
|----------|-------------|
| Request never reaches server | Client retries with same idempotency key. Server processes normally. |
| Server processes, response lost | Client retries with same key. Server finds existing transfer, returns it. No double-execution. |
| Server rejects (bad input, insufficient funds) | Client receives error. Pending item is marked failed in local queue. Same key returns same failure on retry. |
| App reloads while transfer is pending | Pending queue survives in `localStorage`. On reload, the app re-sends pending items. |
| User clears browser storage | Pending queue is lost. Server balance is still correct. User sees accurate state on next `GET /api/me`. |

### Reconciliation

On reconnect (or app load with connectivity), the client:
1. Sends any pending transfers from the localStorage queue.
2. Calls `GET /api/me` to get the authoritative balance.
3. Calls `GET /api/transfers` to get the authoritative transfer history.
4. Clears successfully reconciled items from the pending queue.

---

# Poor-Network Strategy

### What works offline

| Feature | Offline behavior |
|---------|-----------------|
| View "Hello [email]" greeting | ✅ Decoded from JWT locally, no network needed. |
| View balance | ❌ Requires server. Shows last known cached value with "may be outdated" indicator. |
| View transfer history | ❌ Requires server. Shows cached list if available. |
| Submit a transfer | ⚠️ Queued locally as "Pending." NOT shown as successful. Sent when connectivity returns. |
| Login / Register | ❌ Requires server. |
| Stay logged in | ✅ JWT persists in localStorage. Inactivity timer runs locally. |

### Retry strategy

- **GET requests**: TanStack Query handles retry with exponential backoff (3 retries, 1s/2s/4s). Stale data is shown while revalidating.
- **POST /api/transfers**: The custom pending queue retries on a simple interval when connectivity is detected (via `navigator.onLine` + actual fetch attempt). Exponential backoff per item. Max retry period: until the JWT expires.
- **POST /api/auth/***: No retry. User re-submits manually.

### Timeout strategy

- Frontend: `fetch` with `AbortController` timeout of 15 seconds (generous for slow connections).
- Backend: `http.Server.ReadTimeout` = 30s, `WriteTimeout` = 30s. Context timeout on database queries = 10s.

### What is NOT supported offline

- Users cannot register or log in offline. Authentication requires the server.
- Transfers are never confirmed offline. The UI explicitly shows "Pending — will send when connected."
- The client never displays a transfer as "successful" based on local state alone.

---

# Security Model

| Threat | Mitigation |
|--------|-----------|
| Password brute force | bcrypt with default cost (10). Rate limiting is out of scope but noted as a production concern. |
| JWT theft | 1-hour max lifetime. `httpOnly` is not used (JWT needs to be accessible to JS for offline use), but stored only in `localStorage`, not cookies. |
| IDOR on transfers | Transfer endpoint uses the authenticated user's ID from the JWT as the sender. The client cannot specify a different sender. |
| Balance manipulation | All balance logic is server-side inside a PostgreSQL transaction. Client never sends a balance. |
| Negative/zero transfer | `CHECK (amount > 0)` in the database. Also validated in the handler. |
| Self-transfer | Explicitly checked in the transfer handler. |
| SQL injection | Parameterized queries via `pgx`. No string concatenation in SQL. |
| XSS | React's default escaping. No `dangerouslySetInnerHTML`. |
| CORS | Eliminated. Go serves the SPA on the same origin. |
| Duplicate transfer | Idempotency key with unique constraint inside the transaction. |
| Overdraft via concurrent requests | `SELECT ... FOR UPDATE` serializes concurrent transfers. `CHECK (balance >= 0)` is the database-level safety net. |

---

# Project Structure

```
/
├── backend/
│   ├── main.go              # Entrypoint: config, DB connect, router setup, serve SPA
│   ├── auth.go              # Register, login handlers, JWT create/verify, auth middleware
│   ├── wallet.go            # Transfer handler, transfer query handler, DB transaction logic
│   ├── models.go            # Struct definitions (User, Transfer, request/response types)
│   ├── schema.sql           # Database DDL, run on startup
│   ├── main_test.go         # Integration tests (auth + wallet against real DB)
│   ├── wallet_test.go       # Unit tests for wallet logic
│   ├── Dockerfile           # Multi-stage: build Go binary, copy frontend dist, run on alpine
│   ├── go.mod
│   └── go.sum
├── frontend/
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx         # React entry, QueryClientProvider
│   │   ├── App.tsx          # Router, auth guard, inactivity timer
│   │   ├── api.ts           # fetch wrapper with auth header, timeout, error handling
│   │   ├── transferQueue.ts # ~50 lines: localStorage queue, retry logic, reconciliation
│   │   ├── pages/
│   │   │   ├── Login.tsx
│   │   │   ├── Register.tsx
│   │   │   └── Dashboard.tsx  # Welcome message, balance, transfer form, transfer history
│   │   └── components/       # Small shared components (e.g., TransferForm, TransferList)
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
├── docker-compose.yml        # Two services: app, db
└── README.md
```

### Why no separate frontend Dockerfile

The Go Dockerfile uses a multi-stage build:
1. Stage 1: `node` image — builds the React app (`npm run build`).
2. Stage 2: `golang` image — builds the Go binary.
3. Stage 3: `alpine` — copies the Go binary and the frontend `dist/` directory. The Go binary serves the SPA files.

This produces a single container with everything needed.

---

# Dependencies

### Go

| Dependency | Purpose |
|------------|---------|
| `go-chi/chi/v5` | Lightweight router and middleware. |
| `jackc/pgx/v5` | PostgreSQL driver with native protocol support. |
| `golang-jwt/jwt/v5` | JWT signing and parsing. |
| `golang.org/x/crypto` | bcrypt for password hashing. |

4 dependencies. No ORM, no migration framework, no validation library, no logging framework.

### Frontend (npm)

| Dependency | Purpose |
|------------|---------|
| `react`, `react-dom` | UI framework. |
| `react-router-dom` | Client-side routing (3 pages). |
| `@tanstack/react-query` | GET request caching, retry, stale-while-revalidate. |

3 production dependencies (plus React peer deps). No Axios, no state management library, no CSS framework, no icon library, no IndexedDB adapter.

### Dev dependencies

| Dependency | Purpose |
|------------|---------|
| `vite` | Frontend build tool. |
| `typescript` | Type checking. |
| `vitest` + `@testing-library/react` | Frontend tests. |

---

# Testing Strategy

### Backend

- **Unit tests** (`wallet_test.go`): Test the transfer logic with a real PostgreSQL connection (from docker-compose). Test: successful transfer, insufficient funds, duplicate idempotency key, self-transfer, nonexistent recipient, concurrent transfers to the same sender.
- **Integration tests** (`main_test.go`): Start the HTTP server, hit endpoints with `net/http/httptest`. Test the full flow: register → login → get profile → transfer → verify balances → verify idempotency.
- **Run with**: `docker-compose up db -d && go test ./backend/...`

### Frontend

- **Unit tests**: Test the `transferQueue.ts` logic (add, retry, reconcile, persistence across reloads). Test the inactivity timer logic.
- **Component tests**: Test form validation (register, login, transfer).
- **Run with**: `npm test` (vitest).

### What we do NOT test

- No end-to-end browser tests (Playwright/Cypress). The scope doesn't justify the infrastructure. The backend integration tests cover the critical paths.
- No load tests. Concurrency correctness is validated by the backend tests with parallel goroutines.

---

# Docker / Runtime

### `docker-compose.yml`

```yaml
services:
  db:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: wallet
      POSTGRES_USER: wallet
      POSTGRES_PASSWORD: wallet
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  app:
    build: ./backend
    depends_on:
      - db
    environment:
      DATABASE_URL: postgres://wallet:wallet@db:5432/wallet?sslmode=disable
      JWT_SECRET: change-me-in-production
      PORT: "8080"
    ports:
      - "8080:8080"

volumes:
  pgdata:
```

Two services. `docker-compose up` runs everything. The Go binary waits for the database to be ready (simple retry loop on connect), runs `schema.sql`, and starts serving.

---

# Trade-offs

| What we chose | What we gave up | Why |
|---------------|----------------|-----|
| Client-side inactivity enforcement | Server-enforced inactivity | Avoids refresh tokens, session stores, and network round-trips. Server-side 1-hour expiry is the hard security boundary. |
| localStorage for pending queue | IndexedDB / durable offline storage | Simpler implementation. localStorage is sufficient for a small queue of pending transfers. If the user clears storage, the server balance is still correct. |
| No `GET /api/users` endpoint | Auto-complete for recipient | Avoids exposing the full user list. The user types an email. The server validates it exists. |
| Single Go binary serves SPA | Separate frontend container | Eliminates CORS, Nginx config, and one container. |
| No refresh tokens | Seamless long-session renewal | Keeps auth model simple. 1-hour token is long enough for realistic use. Re-login is acceptable when it expires. |
| `schema.sql` on startup | Migration framework | Overkill for a single-version take-home. |
| No rate limiting | Brute-force protection | Out of scope. Noted as a production concern. |

---

# Implementation Plan

### Phase 1: Foundation

**Objective**: A running dockerized app that can serve a page.

**Work**:
- Create `docker-compose.yml` with PostgreSQL.
- Create `schema.sql` with both tables.
- Create Go `main.go`: connect to DB, run schema, serve a placeholder "hello" on `/api/health`.
- Create Vite React app with a single page.
- Create multi-stage Dockerfile that builds both and serves them.
- Verify `docker-compose up` shows the React page with the API responding.

**Dependencies**: None.

**Validation**: `docker-compose up` → browser shows React page → `/api/health` returns 200.

**Done when**: The full build/serve pipeline works end-to-end.

---

### Phase 2: Authentication

**Objective**: Register, login, JWT-protected routes, inactivity logout.

**Work**:
- Backend: `POST /api/auth/register` with email/password validation, bcrypt hashing.
- Backend: `POST /api/auth/login` with credential check, JWT issuance.
- Backend: Auth middleware that verifies JWT and injects user ID/email into context.
- Backend: `GET /api/me` returns `{ email, balance }`.
- Frontend: Register page with form validation (email format, password match, min length).
- Frontend: Login page, store JWT in `localStorage`.
- Frontend: Auth guard on protected routes (redirect to login if no token).
- Frontend: Inactivity timer (15 min), delete token and redirect on timeout.
- Frontend: "Hello [email], welcome back" from JWT claims.
- Backend tests: register, login, access protected route, reject expired/invalid token.

**Dependencies**: Phase 1.

**Validation**: Register → login → see welcome message → wait 15 min → redirected to login. Invalid credentials rejected. Duplicate email rejected.

**Done when**: Full auth flow works with tests passing.

---

### Phase 3: Wallet Core

**Objective**: Transfers work correctly with full consistency guarantees.

**Work**:
- Backend: `POST /api/transfers` with the full transaction flow (idempotency check, `FOR UPDATE` lock, balance check, transfer, record).
- Backend: `GET /api/transfers` returns paginated transfer history for the authenticated user.
- Frontend: Dashboard shows balance (from `GET /api/me`).
- Frontend: Transfer form (recipient email, amount, notes).
- Frontend: Transfer history list.
- Backend tests: successful transfer, insufficient funds, duplicate idempotency key (returns same result), self-transfer rejected, nonexistent recipient rejected, concurrent transfers from same sender (verify serialization via goroutines).

**Dependencies**: Phase 2.

**Validation**: Transfer money between two users → balances update correctly → duplicate idempotency key returns same result → concurrent transfers don't overdraw → `CHECK` constraint holds.

**Done when**: All wallet tests pass. Manual test of the full UI flow works.

---

### Phase 4: Network Resilience

**Objective**: The app handles poor/no connectivity gracefully.

**Work**:
- Frontend: `api.ts` — fetch wrapper with `AbortController` timeout (15s), auth header injection, 401 handling (redirect to login).
- Frontend: TanStack Query setup — retry config (3 retries, exponential backoff), `staleTime` to reduce refetches.
- Frontend: `transferQueue.ts` — pending transfer queue in localStorage, auto-retry on reconnect, reconciliation with `GET /api/transfers` and `GET /api/me`.
- Frontend: UI states — loading, error, offline indicator, "Pending" badge on queued transfers.
- Backend: Server timeouts (`ReadTimeout`, `WriteTimeout`), database query context timeouts.
- Test: Kill network (browser DevTools offline mode) → submit transfer → see "Pending" → restore network → transfer executes → balance updates.

**Dependencies**: Phase 3.

**Validation**: Transfers queued offline are sent on reconnect. Duplicate idempotency keys are handled. Cached data shown when offline. Balance reconciles after reconnect.

**Done when**: The offline-queue-and-retry flow works end-to-end. The UI never shows a transfer as "completed" until the server confirms it.

---

### Phase 5: Polish

**Objective**: Production-ready take-home quality.

**Work**:
- Error handling: user-friendly error messages for all failure modes.
- Input validation: email format, password strength, positive amount, non-empty recipient.
- README: build/run instructions, environment variables, architecture summary.
- Frontend tests: form validation, inactivity timer, transfer queue logic.
- Final Docker build verification: clean `docker-compose up` from scratch works.
- Code review pass: remove dead code, unnecessary comments, ensure consistent style.

**Dependencies**: Phase 4.

**Validation**: Clean clone → `docker-compose up` → all features work → all tests pass.

**Done when**: A reviewer can clone the repo, run one command, and use the full application.

---

# Architecture Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| localStorage cleared while transfers are pending | Medium | Server balance remains correct. User loses visibility of pending items only. Documented as a known limitation. |
| JWT stolen via XSS | Medium | 1-hour expiry limits exposure. React's built-in escaping prevents most XSS. No `dangerouslySetInnerHTML`. |
| Go server timeout configuration too aggressive for slow networks | Medium | Use generous timeouts (30s server-side, 15s client-side). Test with throttled connections. |
| PostgreSQL connection lost during transfer | Low | Transaction is automatically rolled back. Client retries with same idempotency key. |
| Clock drift on client affects inactivity timer | Low | Inactivity uses relative `Date.now()` deltas, not absolute server time. |
| TanStack Query cache grows unbounded | Low | Cache has reasonable `gcTime` (default 5 min for inactive queries). The data set is small. |

---

# Final Decision Summary

- **Two containers**: Go (serves API + SPA) and PostgreSQL. No Nginx, no reverse proxy.
- **Same origin**: No CORS.
- **4 Go dependencies**: chi, pgx, golang-jwt, x/crypto.
- **3 React dependencies**: react, react-router-dom, tanstack-query.
- **JWT**: 1-hour server expiry. Client-enforced 15-minute inactivity.
- **Money**: BIGINT cents. `CHECK (balance >= 0)`.
- **Transfers**: Single PostgreSQL transaction with `FOR UPDATE` locks and idempotency key uniqueness.
- **Offline**: localStorage queue for pending transfers. Never shown as "completed" until server confirms. Reconcile on reconnect.
- **Recipient lookup**: By email in the transfer request. No user list endpoint.
- **Testing**: Backend integration tests against real PostgreSQL. Frontend unit tests for queue and timer logic.
- **Schema**: Single `schema.sql`, applied on startup.
