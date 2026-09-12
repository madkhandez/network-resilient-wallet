package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func setupTestDB(t *testing.T) *pgxpool.Pool {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://wallet:wallet@localhost:5432/wallet?sslmode=disable"
	}

	db, err := pgxpool.New(context.Background(), dbURL)
	if err != nil {
		t.Fatalf("Failed to connect to db: %v", err)
	}

	// For tests, clear the users table
	_, err = db.Exec(context.Background(), "TRUNCATE users CASCADE")
	if err != nil {
		t.Logf("Could not truncate users (might not exist yet): %v", err)
	}

	initSchema(db)

	// Clean up after init just in case
	_, err = db.Exec(context.Background(), "TRUNCATE users CASCADE")
	if err != nil {
		t.Fatalf("Failed to truncate users: %v", err)
	}

	return db
}

func setupTestRouter(db *pgxpool.Pool) chi.Router {
	r := chi.NewRouter()
	r.Post("/api/auth/register", RegisterHandler(db))
	r.Post("/api/auth/login", LoginHandler(db))

	r.Group(func(r chi.Router) {
		r.Use(AuthMiddleware)
		r.Get("/api/me", ProfileHandler(db))
		r.Post("/api/transfers", TransferHandler(db))
		r.Get("/api/transfers", TransferHistoryHandler(db))
	})

	return r
}

func TestAuthFlow(t *testing.T) {
	// Skip if no db is available (e.g., when not running in docker or with local pg)
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("Skipping test because DATABASE_URL is not set")
	}

	// Try to connect to see if DB is available, otherwise skip
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	testConn, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Skip("Skipping test: DB not reachable")
	}
	testConn.Close()

	db := setupTestDB(t)
	defer db.Close()
	r := setupTestRouter(db)

	// 1. Register
	reqBody := `{"email":"test@example.com","password":"password123","confirm_password":"password123"}`
	req := httptest.NewRequest("POST", "/api/auth/register", bytes.NewBufferString(reqBody))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()

	r.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("Expected 201 Created for register, got %v: %v", rr.Code, rr.Body.String())
	}

	// 2. Duplicate Register
	req2 := httptest.NewRequest("POST", "/api/auth/register", bytes.NewBufferString(reqBody))
	req2.Header.Set("Content-Type", "application/json")
	rr = httptest.NewRecorder()
	r.ServeHTTP(rr, req2)
	if rr.Code != http.StatusConflict {
		t.Fatalf("Expected 409 Conflict for duplicate register, got %v", rr.Code)
	}

	// 3. Login
	loginBody := `{"email":"test@example.com","password":"password123"}`
	req = httptest.NewRequest("POST", "/api/auth/login", bytes.NewBufferString(loginBody))
	req.Header.Set("Content-Type", "application/json")
	rr = httptest.NewRecorder()

	r.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK for login, got %v: %v", rr.Code, rr.Body.String())
	}

	var authResp AuthResponse
	if err := json.NewDecoder(rr.Body).Decode(&authResp); err != nil {
		t.Fatalf("Failed to parse login response: %v", err)
	}

	if authResp.Token == "" {
		t.Fatalf("Expected token in response, got empty")
	}

	// 4. Access Protected Route
	req = httptest.NewRequest("GET", "/api/me", nil)
	req.Header.Set("Authorization", "Bearer "+authResp.Token)
	rr = httptest.NewRecorder()

	r.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK for /api/me, got %v", rr.Code)
	}

	var profile ProfileResponse
	if err := json.NewDecoder(rr.Body).Decode(&profile); err != nil {
		t.Fatalf("Failed to parse profile response: %v", err)
	}

	if profile.Email != "test@example.com" {
		t.Errorf("Expected email test@example.com, got %v", profile.Email)
	}

	if profile.Balance != 1000000 {
		t.Errorf("Expected balance 1000000, got %v", profile.Balance)
	}

	// 5. Unauthenticated Request
	req = httptest.NewRequest("GET", "/api/me", nil)
	rr = httptest.NewRecorder()

	r.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("Expected 401 Unauthorized, got %v", rr.Code)
	}
}
