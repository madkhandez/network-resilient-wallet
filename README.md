# Network-Resilient Wallet

A full-stack wallet application with JWT authentication and fund transfers, designed for reliability under poor network conditions.

## Tech Stack

- **Backend**: Go with chi router, pgx/v5 (PostgreSQL driver), golang-jwt
- **Frontend**: React 18 + TypeScript, TanStack Query, Vite
- **Database**: PostgreSQL 15
- **Containerization**: Docker + Docker Compose

## Quick Start

```bash
docker compose up --build
```

The application will be available at [http://localhost:8080](http://localhost:8080).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgres://wallet:wallet@localhost:5432/wallet?sslmode=disable` | PostgreSQL connection string |
| `JWT_SECRET` | `change-me-in-production` | Secret key for JWT signing (HMAC-SHA256) |
| `PORT` | `8080` | HTTP server port |

## Features

1. **Registration** — Email, password, confirm password with validation
2. **Login** — Returns JWT containing email and user ID
3. **Authenticated View** — Protected dashboard showing "Hello [email], welcome back"
4. **15-minute inactivity logout** — Client-side timer with server-enforced 1-hour token expiry
5. **Wallet** — View balance, transfer funds (recipient email, amount, notes)
6. **Network Resilience** — Offline transfer queue, idempotent retries, reconnect reconciliation

## Architecture

Single Go binary serves the REST API and static React SPA on the same origin (no CORS). PostgreSQL handles all financial invariants via transactions with `SELECT ... FOR UPDATE` and `CHECK` constraints.

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed design decisions.

## Running Tests

### Backend

```bash
# Requires PostgreSQL running on localhost:5432
cd backend
go test -v ./...
```

### Frontend

```bash
cd frontend
npm test
```

## Project Structure

```
├── backend/
│   ├── main.go          # Server entrypoint, DB connection, SPA serving
│   ├── auth.go          # Register, login, JWT middleware
│   ├── wallet.go        # Transfer handler with idempotency
│   ├── models.go        # Struct definitions
│   ├── schema.sql       # Database DDL
│   ├── Dockerfile       # Multi-stage build (frontend + backend + runtime)
│   ├── main_test.go     # Auth integration tests
│   └── wallet_test.go   # Wallet correctness tests (13 scenarios)
├── frontend/
│   └── src/
│       ├── App.tsx            # Router, auth guard, inactivity timer
│       ├── api.ts             # Fetch wrapper with timeout, error classification
│       ├── transferQueue.ts   # localStorage pending queue
│       └── pages/
│           ├── Login.tsx
│           ├── Register.tsx
│           └── Dashboard.tsx  # Balance, transfer form, history
├── docker-compose.yml
└── ARCHITECTURE.md
```
