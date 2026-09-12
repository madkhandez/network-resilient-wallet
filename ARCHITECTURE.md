# Architecture Decision

We will build a minimal, offline-resilient Single Page Application (SPA) with a monolithic Go backend. The architecture prioritizes predictable behavior under poor network conditions and strict financial correctness over complex enterprise abstractions. 

The frontend uses an optimistic UI with durable local mutation queues and idempotency keys to handle intermittent connectivity. The backend relies on PostgreSQL's ACID guarantees and transactional locks for financial consistency, exposing a simple REST API. We avoid microservices, complex layering, and heavy ORMs to keep the codebase minimal, readable, and highly maintainable.

# Technology Choices

*   **Backend Language**: Go (Standard library `net/http` with `chi` for minimal routing). Idiomatic, statically typed, and compiles to a tiny binary.
*   **Database**: PostgreSQL. Essential for strict ACID guarantees and row-level locking needed for the wallet.
*   **Database Access (Go)**: `pgx` (Standard SQL driver). No heavy ORM (like GORM) to avoid hidden queries and unnecessary complexity.
*   **Frontend**: React (via Vite) in TypeScript.
*   **Frontend State & Network**: TanStack Query (React Query) with local persistence. It natively handles caching, retry logic with exponential backoff, and offline mutation queues without reinventing the wheel.
*   **Authentication**: Standard JWT.
*   **Containerization**: Docker & Docker Compose for single-command local deployment.

# System Architecture

1.  **React SPA (Client)**: Manages UI, form validation, and local state. Tracks user inactivity. Intercepts offline scenarios and queues wallet transfers with unique Idempotency Keys.
2.  **Go Backend (API)**: Stateless REST API. Validates requests, enforces business rules, issues JWTs, and interacts with the database.
3.  **PostgreSQL (State)**: The absolute source of truth. Handles data persistence, balance tracking, and deduplication of idempotent requests via unique constraints.

# Data Model

The schema uses integer types (`BIGINT`) for financial values (cents/lowest denomination) to prevent floating-point precision errors.

**Table: `users`**
*   `id` (UUID, Primary Key)
*   `email` (VARCHAR, Unique, Indexed)
*   `password_hash` (VARCHAR)
*   `balance` (BIGINT) - Current balance in cents.
*   `created_at` (TIMESTAMP)

**Table: `transfers`**
*   `id` (UUID, Primary Key)
*   `idempotency_key` (UUID, Unique, Indexed) - Client-generated to prevent duplicate processing.
*   `sender_id` (UUID, Foreign Key -> users)
*   `recipient_id` (UUID, Foreign Key -> users)
*   `amount` (BIGINT) - Must be > 0.
*   `notes` (TEXT)
*   `status` (VARCHAR) - e.g., 'completed', 'failed'.
*   `created_at` (TIMESTAMP)

# API Architecture

The API uses standard REST/JSON over HTTP.

*   `POST /api/auth/register` - Creates user.
*   `POST /api/auth/login` - Returns JWT token.
*   `GET /api/me` - Validates JWT, returns user profile (email, balance).
*   `GET /api/users` - Fetches available recipients.
*   `POST /api/transfers` - Initiates a transfer. **Requires `Idempotency-Key` header.**
*   `GET /api/transfers` - Fetches transfer history for reconciliation.

# Authentication & Session Strategy

To handle the "15 minutes of inactivity" requirement gracefully in poor networks without spamming the backend:

1.  **Token Issuance**: The backend issues a JWT on login. The JWT contains `sub` (user id) and `email`. It has a strict 24-hour expiration on the backend.
2.  **Client-Side Inactivity Tracking**: The React frontend tracks user activity (clicks, keypresses, scroll) and updates a `last_active` timestamp in `localStorage`. 
3.  **Enforcement**: If the frontend detects `Date.now() - last_active > 15 minutes`, it aggressively drops the JWT from local storage and redirects to the login screen. 
4.  **Offline Benefit**: If the network drops for 5 minutes, but the user is actively typing a transfer note, they are *not* logged out. The session relies on local activity tracking. A short-lived server JWT would require constant polling (which fails offline), so relying on frontend activity tracking combined with a reasonable server-side expiry strikes the right pragmatic balance.

# Wallet Transaction Strategy

To prevent race conditions, overdrafts, and duplicate transactions, the backend implements the following sequence for `POST /api/transfers`:

1.  **Idempotency Check**: Attempt to insert the `Idempotency-Key` into the `transfers` table with a `pending` status. If a unique constraint violation occurs, it means this request was already processed (or is in progress). Return the existing result.
2.  **Atomicity**: Begin a PostgreSQL transaction (`BEGIN`).
3.  **Concurrency Control**: Lock the sender's row: `SELECT balance FROM users WHERE id = $1 FOR UPDATE`. This prevents concurrent requests from causing race conditions.
4.  **Validation**: Check if `balance >= amount`. If insufficient, `ROLLBACK` and return 400.
5.  **Mutation**: 
    *   `UPDATE users SET balance = balance - amount WHERE id = sender`
    *   `UPDATE users SET balance = balance + amount WHERE id = recipient`
    *   `UPDATE transfers SET status = 'completed' WHERE idempotency_key = ...`
6.  **Commit**: `COMMIT` the transaction. 

# Network Resilience Strategy

1.  **Read Caching**: The frontend caches the "Hello [email]" profile data and recipient list. If the user opens the app while offline, they see the cached state instantly.
2.  **Offline Mutations**: When a user transfers money while offline, the frontend queues the POST request locally (using TanStack Query's persist plugins backed by IndexedDB). The UI shows the transfer as "Pending (Offline)".
3.  **Deduplication (Idempotency)**: If the client sends a transfer, the server processes it, but the response is lost due to a network drop, the client will retry later. Because the client sends the *same* `Idempotency-Key`, the server safely returns a success response without moving funds twice.
4.  **Timeouts & Retries**: All GET and POST requests are configured with reasonable timeouts (e.g., 10s) and exponential backoff for retries to avoid overwhelming a recovering network.

# Project Structure

A flat, feature-focused Go structure to avoid over-engineering.

```
/
├── backend/
│   ├── main.go          # App entrypoint, dependency wire-up
│   ├── handlers.go      # HTTP handlers, routing, parsing
│   ├── auth.go          # JWT generation, middleware
│   ├── wallet.go        # Business logic, PostgreSQL transactions
│   ├── models.go        # Types / Structs
│   ├── Dockerfile
│   └── go.mod
├── frontend/
│   ├── src/
│   │   ├── components/  # Reusable UI
│   │   ├── pages/       # Login, Register, Wallet 
│   │   ├── api/         # Axios/Fetch clients and offline queue config
│   │   └── App.tsx      # Routing and QueryClientProvider
│   ├── package.json
│   └── Dockerfile
├── docker-compose.yml
└── README.md
```

# Dependency Decisions

*   **Go - `go-chi/chi`**: Extremely lightweight router. No bloated framework.
*   **Go - `jackc/pgx`**: Fastest and most robust PostgreSQL driver for Go.
*   **Go - `golang-jwt/jwt`**: Standard library for JWT signing/parsing.
*   **React - `TanStack Query`**: Manages async state, caching, retries, and offline mutation queuing. Eliminates hundreds of lines of custom `useEffect` network logic.
*   **React - `lucide-react` / Minimal CSS**: For simple, clean UI without massive component libraries.

# Testing Architecture

*   **Backend Unit Tests**: Focus heavily on `wallet.go`. Mock the database interface to test concurrency edge cases, insufficient balances, and idempotency logic.
*   **Backend Integration Tests**: Spin up a real PostgreSQL instance (via Testcontainers or standard CI service) to verify the `FOR UPDATE` locking and transaction rollbacks work at the database engine level.
*   **Frontend Tests**: Minimal component tests for the inactivity timer logic and form validation.
*   **End-to-End**: A simple playwright/cypress test running against the docker-compose stack to verify the Login -> View -> Transfer flow.

# Docker / Runtime Architecture

*   `docker-compose.yml` orchestrates three services:
    1.  `db`: `postgres:15-alpine` (with persistent volume).
    2.  `backend`: Go binary built from scratch or alpine image (port 8080).
    3.  `frontend`: Nginx serving the static React build (port 80).
*   No external API gateways or reverse proxies (beyond the frontend Nginx) are necessary for this scope.

# Trade-offs

*   **No Refresh Tokens**: Implementing a fully secure offline-compatible refresh token rotation adds significant complexity. We rely on a frontend-enforced inactivity timer and a longer-lived access token, which sacrifices some strict backend invalidation for much better offline UX.
*   **Single DB Node**: We assume a single PostgreSQL instance. Distributed databases or read-replicas are intentionally excluded to keep the deployment simple.
*   **No Event Bus / Kafka**: Transfers are handled synchronously in a single DB transaction. If this were a massive enterprise system, we might use a message queue and saga pattern, but for this assignment, a single ACID transaction is vastly superior in simplicity and correctness.

# Implementation Sequence

1.  **Database**: Scaffold PostgreSQL schema and docker-compose.
2.  **Backend Auth**: Implement `/register`, `/login`, and JWT middleware.
3.  **Frontend Auth**: Build React login/register UI and the 15-minute inactivity tracker. Connect to backend.
4.  **Backend Wallet**: Implement the transfer logic with `FOR UPDATE` locks and idempotency. Write unit tests for race conditions.
5.  **Frontend Wallet**: Build the transfer UI. Integrate TanStack Query for offline queuing and retry mechanisms.
6.  **Polish**: Error handling, loading states, README documentation, and final Docker build verifications.

# Architecture Risks

*   **Risk**: The client deletes the `localStorage` while transfers are in the offline queue, losing the idempotency keys and state.
    *   *Mitigation*: Persist the mutation queue in `IndexedDB` which is more durable, but ultimately, client-side data loss while offline is an accepted risk. The server balance remains correct.
*   **Risk**: Clock skew between client and server affects the inactivity timeout.
    *   *Mitigation*: Use relative timestamps (`Date.now() - last_active`) entirely on the client side, rather than comparing client time to server time.
*   **Risk**: Go's default HTTP client/server timeout hangs indefinitely on bad connections.
    *   *Mitigation*: Enforce explicit `ReadTimeout` and `WriteTimeout` on the Go `http.Server` and use context timeouts for all database queries.
