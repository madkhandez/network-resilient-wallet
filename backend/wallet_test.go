package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func registerUser(t *testing.T, router http.Handler, email, pass string) {
	reqBody := fmt.Sprintf(`{"email":"%s","password":"%s","confirm_password":"%s"}`, email, pass, pass)
	req := httptest.NewRequest("POST", "/api/auth/register", bytes.NewBufferString(reqBody))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	if rr.Code != http.StatusCreated && rr.Code != http.StatusConflict {
		t.Fatalf("Failed to register %s: %v", email, rr.Body.String())
	}
}

func loginUser(t *testing.T, router http.Handler, email, pass string) string {
	reqBody := fmt.Sprintf(`{"email":"%s","password":"%s"}`, email, pass)
	req := httptest.NewRequest("POST", "/api/auth/login", bytes.NewBufferString(reqBody))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("Failed to login %s: %v", email, rr.Body.String())
	}
	var authResp AuthResponse
	json.NewDecoder(rr.Body).Decode(&authResp)
	return authResp.Token
}

func getBalance(t *testing.T, router http.Handler, token string) int64 {
	req := httptest.NewRequest("GET", "/api/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("Failed to get profile: %v", rr.Body.String())
	}
	var profile ProfileResponse
	json.NewDecoder(rr.Body).Decode(&profile)
	return profile.Balance
}

func doTransfer(router http.Handler, token, key, recipient string, amount int64) *httptest.ResponseRecorder {
	reqBody := fmt.Sprintf(`{"recipient_email":"%s","amount":%d,"notes":"test"}`, recipient, amount)
	req := httptest.NewRequest("POST", "/api/transfers", bytes.NewBufferString(reqBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", key)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

func setupWalletTestEnv(t *testing.T) (*pgxpool.Pool, http.Handler) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://wallet:wallet@localhost:5432/wallet?sslmode=disable"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	testConn, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Skip("Skipping test: DB not reachable")
	}
	testConn.Close()

	pool := setupTestDB(t)
	_, err = pool.Exec(context.Background(), "TRUNCATE transfers CASCADE; TRUNCATE users CASCADE;")
	if err != nil {
		t.Fatalf("Failed to truncate: %v", err)
	}

	return pool, setupTestRouter(pool)
}

// 1. TestTransferSuccess
func TestTransferSuccess(t *testing.T) {
	pool, router := setupWalletTestEnv(t)
	defer pool.Close()

	registerUser(t, router, "a@example.com", "password")
	registerUser(t, router, "b@example.com", "password")
	tokenA := loginUser(t, router, "a@example.com", "password")

	resp := doTransfer(router, tokenA, "11111111-1111-1111-1111-111111111111", "b@example.com", 500000)
	if resp.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d: %s", resp.Code, resp.Body.String())
	}

	var tr Transfer
	json.NewDecoder(resp.Body).Decode(&tr)
	if tr.Status != "completed" {
		t.Fatalf("Expected status completed, got %s", tr.Status)
	}

	tokenB := loginUser(t, router, "b@example.com", "password")
	balA := getBalance(t, router, tokenA)
	balB := getBalance(t, router, tokenB)

	if balA != 500000 {
		t.Errorf("Expected A to have 500000, got %d", balA)
	}
	if balB != 1500000 {
		t.Errorf("Expected B to have 1500000, got %d", balB)
	}
	if balA+balB != 2000000 {
		t.Errorf("Conservation failed: %d", balA+balB)
	}
}

// 2. TestTransferInsufficientFunds
func TestTransferInsufficientFunds(t *testing.T) {
	pool, router := setupWalletTestEnv(t)
	defer pool.Close()

	registerUser(t, router, "a@example.com", "password")
	registerUser(t, router, "b@example.com", "password")
	tokenA := loginUser(t, router, "a@example.com", "password")

	resp := doTransfer(router, tokenA, "22222222-2222-2222-2222-222222222222", "b@example.com", 1500000)
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400, got %d: %s", resp.Code, resp.Body.String())
	}

	var tr Transfer
	json.NewDecoder(resp.Body).Decode(&tr)
	if tr.Status != "failed" {
		t.Fatalf("Expected status failed, got %s", tr.Status)
	}

	tokenB := loginUser(t, router, "b@example.com", "password")
	if getBalance(t, router, tokenA) != 1000000 || getBalance(t, router, tokenB) != 1000000 {
		t.Errorf("Balances should not change")
	}
}

// 3. TestTransferRecipientNotFound
func TestTransferRecipientNotFound(t *testing.T) {
	pool, router := setupWalletTestEnv(t)
	defer pool.Close()

	registerUser(t, router, "a@example.com", "password")
	tokenA := loginUser(t, router, "a@example.com", "password")

	resp := doTransfer(router, tokenA, "33333333-3333-3333-3333-333333333333", "nonexistent@example.com", 50000)
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400, got %d", resp.Code)
	}
	if !bytes.Contains(resp.Body.Bytes(), []byte("not found")) {
		t.Fatalf("Expected not found error, got %s", resp.Body.String())
	}

	if getBalance(t, router, tokenA) != 1000000 {
		t.Errorf("Balance should not change")
	}
}

// 4. TestTransferSelf
func TestTransferSelf(t *testing.T) {
	pool, router := setupWalletTestEnv(t)
	defer pool.Close()

	registerUser(t, router, "a@example.com", "password")
	tokenA := loginUser(t, router, "a@example.com", "password")

	resp := doTransfer(router, tokenA, "44444444-4444-4444-4444-444444444444", "a@example.com", 50000)
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("Expected 400, got %d", resp.Code)
	}
}

// 5. TestDuplicateIdempotencyKeySequential
func TestDuplicateIdempotencyKeySequential(t *testing.T) {
	pool, router := setupWalletTestEnv(t)
	defer pool.Close()

	registerUser(t, router, "a@example.com", "password")
	registerUser(t, router, "b@example.com", "password")
	tokenA := loginUser(t, router, "a@example.com", "password")

	key := "55555555-5555-5555-5555-555555555555"
	resp1 := doTransfer(router, tokenA, key, "b@example.com", 500000)
	if resp1.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", resp1.Code)
	}

	resp2 := doTransfer(router, tokenA, key, "b@example.com", 500000)
	if resp2.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", resp2.Code)
	}

	if getBalance(t, router, tokenA) != 500000 {
		t.Errorf("Balance should only decrease once")
	}
}

// 6. TestDuplicateIdempotencyKeyConcurrent
func TestDuplicateIdempotencyKeyConcurrent(t *testing.T) {
	pool, router := setupWalletTestEnv(t)
	defer pool.Close()

	registerUser(t, router, "a@example.com", "password")
	registerUser(t, router, "b@example.com", "password")
	tokenA := loginUser(t, router, "a@example.com", "password")

	const N = 10
	ready := make(chan struct{})
	results := make(chan *httptest.ResponseRecorder, N)

	key := "66666666-6666-6666-6666-666666666666"

	for i := 0; i < N; i++ {
		go func() {
			<-ready
			results <- doTransfer(router, tokenA, key, "b@example.com", 500000)
		}()
	}

	close(ready)

	for i := 0; i < N; i++ {
		resp := <-results
		if resp.Code != http.StatusOK {
			t.Errorf("Expected 200, got %d", resp.Code)
		}
	}

	var count int
	pool.QueryRow(context.Background(), "SELECT count(*) FROM transfers WHERE idempotency_key=$1", key).Scan(&count)
	if count != 1 {
		t.Errorf("Expected exactly 1 transfer record, got %d", count)
	}

	if getBalance(t, router, tokenA) != 500000 {
		t.Errorf("Balance should only decrease once")
	}
}

// 7. TestSameSenderConcurrentTransfers
func TestSameSenderConcurrentTransfers(t *testing.T) {
	pool, router := setupWalletTestEnv(t)
	defer pool.Close()

	registerUser(t, router, "a@example.com", "password")
	registerUser(t, router, "b@example.com", "password")
	tokenA := loginUser(t, router, "a@example.com", "password")

	const N = 10
	ready := make(chan struct{})
	results := make(chan *httptest.ResponseRecorder, N)

	for i := 0; i < N; i++ {
		key := fmt.Sprintf("77777777-7777-7777-7777-%012d", i)
		go func(k string) {
			<-ready
			results <- doTransfer(router, tokenA, k, "b@example.com", 200000)
		}(key)
	}

	close(ready)

	var successCount int
	for i := 0; i < N; i++ {
		resp := <-results
		if resp.Code == http.StatusOK {
			successCount++
		}
	}

	if successCount > 5 {
		t.Errorf("At most 5 should succeed, got %d", successCount)
	}

	tokenB := loginUser(t, router, "b@example.com", "password")
	balA := getBalance(t, router, tokenA)
	balB := getBalance(t, router, tokenB)
	if balA+balB != 2000000 {
		t.Errorf("Conservation failed: %d", balA+balB)
	}
}

// 8. TestConservationOfBalance
func TestConservationOfBalance(t *testing.T) {
	pool, router := setupWalletTestEnv(t)
	defer pool.Close()

	registerUser(t, router, "a@example.com", "password")
	registerUser(t, router, "b@example.com", "password")
	registerUser(t, router, "c@example.com", "password")
	tokenA := loginUser(t, router, "a@example.com", "password")
	tokenB := loginUser(t, router, "b@example.com", "password")
	tokenC := loginUser(t, router, "c@example.com", "password")

	doTransfer(router, tokenA, "88888888-8888-8888-8888-000000000001", "b@example.com", 300000)
	doTransfer(router, tokenB, "88888888-8888-8888-8888-000000000002", "c@example.com", 200000)
	doTransfer(router, tokenA, "88888888-8888-8888-8888-000000000003", "c@example.com", 100000)

	balA := getBalance(t, router, tokenA)
	balB := getBalance(t, router, tokenB)
	balC := getBalance(t, router, tokenC)

	if balA+balB+balC != 3000000 {
		t.Errorf("Conservation failed: %d", balA+balB+balC)
	}
}

// 9. TestFailedTransferDoesNotAlterBalance
func TestFailedTransferDoesNotAlterBalance(t *testing.T) {
	pool, router := setupWalletTestEnv(t)
	defer pool.Close()

	registerUser(t, router, "a@example.com", "password")
	registerUser(t, router, "b@example.com", "password")
	tokenA := loginUser(t, router, "a@example.com", "password")
	tokenB := loginUser(t, router, "b@example.com", "password")

	doTransfer(router, tokenA, "99999999-9999-9999-9999-999999999999", "b@example.com", 1500000)

	if getBalance(t, router, tokenA) != 1000000 {
		t.Errorf("A balance should be 1000000")
	}
	if getBalance(t, router, tokenB) != 1000000 {
		t.Errorf("B balance should be 1000000")
	}
}

// 10. TestRetryAfterLostResponse
func TestRetryAfterLostResponse(t *testing.T) {
	pool, router := setupWalletTestEnv(t)
	defer pool.Close()

	registerUser(t, router, "a@example.com", "password")
	registerUser(t, router, "b@example.com", "password")
	tokenA := loginUser(t, router, "a@example.com", "password")

	key := "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	doTransfer(router, tokenA, key, "b@example.com", 100000)
	resp2 := doTransfer(router, tokenA, key, "b@example.com", 100000)

	if resp2.Code != http.StatusOK {
		t.Errorf("Expected 200 on retry")
	}
	if getBalance(t, router, tokenA) != 900000 {
		t.Errorf("Balance should only change once")
	}
}

// 11. TestSameIdempotencyKeyDifferentPayload
func TestSameIdempotencyKeyDifferentPayload(t *testing.T) {
	pool, router := setupWalletTestEnv(t)
	defer pool.Close()

	registerUser(t, router, "a@example.com", "password")
	registerUser(t, router, "b@example.com", "password")
	registerUser(t, router, "c@example.com", "password")
	tokenA := loginUser(t, router, "a@example.com", "password")
	tokenC := loginUser(t, router, "c@example.com", "password")

	key := "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
	doTransfer(router, tokenA, key, "b@example.com", 50000)
	resp2 := doTransfer(router, tokenA, key, "c@example.com", 99900)

	if resp2.Code != http.StatusOK {
		t.Errorf("Expected 200 on retry")
	}

	var tr Transfer
	json.NewDecoder(resp2.Body).Decode(&tr)
	if tr.Amount != 50000 {
		t.Errorf("Expected returned amount to be 50000, got %d", tr.Amount)
	}

	if getBalance(t, router, tokenC) != 1000000 {
		t.Errorf("C balance should be unchanged")
	}
}

// 12. TestTransferHistoryEndpoint
func TestTransferHistoryEndpoint(t *testing.T) {
	pool, router := setupWalletTestEnv(t)
	defer pool.Close()

	registerUser(t, router, "a@example.com", "password")
	registerUser(t, router, "b@example.com", "password")
	registerUser(t, router, "c@example.com", "password")
	tokenA := loginUser(t, router, "a@example.com", "password")
	tokenB := loginUser(t, router, "b@example.com", "password")

	doTransfer(router, tokenA, "cccccccc-cccc-cccc-cccc-000000000001", "b@example.com", 10000)
	doTransfer(router, tokenA, "cccccccc-cccc-cccc-cccc-000000000002", "c@example.com", 20000)
	doTransfer(router, tokenB, "cccccccc-cccc-cccc-cccc-000000000003", "a@example.com", 30000)

	req := httptest.NewRequest("GET", "/api/transfers", nil)
	req.Header.Set("Authorization", "Bearer "+tokenA)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", rr.Code)
	}

	var history []Transfer
	json.NewDecoder(rr.Body).Decode(&history)

	if len(history) != 3 {
		t.Fatalf("Expected 3 transfers in history, got %d", len(history))
	}

	// Should be ordered by created_at DESC (30000, 20000, 10000)
	if history[0].Amount != 30000 || history[1].Amount != 20000 || history[2].Amount != 10000 {
		t.Errorf("Incorrect order in history: %+v", history)
	}
}

// 13. TestConcurrentCrossTransfer (Deadlock prevention test A <-> B)
func TestConcurrentCrossTransfer(t *testing.T) {
	pool, router := setupWalletTestEnv(t)
	defer pool.Close()

	registerUser(t, router, "a@example.com", "password")
	registerUser(t, router, "b@example.com", "password")
	tokenA := loginUser(t, router, "a@example.com", "password")
	tokenB := loginUser(t, router, "b@example.com", "password")

	const N = 10 // 10 transfers each way
	ready := make(chan struct{})
	done := make(chan struct{}, N*2)

	for i := 0; i < N; i++ {
		keyA := fmt.Sprintf("A-to-B-%012d", i)
		keyB := fmt.Sprintf("B-to-A-%012d", i)

		// A to B
		go func(k string) {
			<-ready
			doTransfer(router, tokenA, k, "b@example.com", 1000)
			done <- struct{}{}
		}(keyA)

		// B to A
		go func(k string) {
			<-ready
			doTransfer(router, tokenB, k, "a@example.com", 1000)
			done <- struct{}{}
		}(keyB)
	}

	close(ready) // start all at once

	// wait for all to finish
	for i := 0; i < N*2; i++ {
		<-done
	}

	balA := getBalance(t, router, tokenA)
	balB := getBalance(t, router, tokenB)

	// A and B each sent 10 * 1000 = 10000, and received 10 * 1000 = 10000.
	// Initial balance is 1000000.
	// So final balances should be unchanged: 1000000.
	if balA != 1000000 {
		t.Errorf("Expected A balance 1000000, got %d", balA)
	}
	if balB != 1000000 {
		t.Errorf("Expected B balance 1000000, got %d", balB)
	}
	if balA+balB != 2000000 {
		t.Errorf("Conservation failed: %d", balA+balB)
	}
}
