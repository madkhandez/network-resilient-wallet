package main

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

var uuidRegex = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func TransferHandler(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		senderID := r.Context().Value("user_id").(string)

		var req TransferRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "Invalid JSON payload")
			return
		}

		idempotencyKey := r.Header.Get("Idempotency-Key")
		if idempotencyKey == "" {
			respondError(w, http.StatusBadRequest, "Missing Idempotency-Key header")
			return
		}
		if !uuidRegex.MatchString(idempotencyKey) {
			respondError(w, http.StatusBadRequest, "Invalid Idempotency-Key format")
			return
		}

		if req.Amount <= 0 {
			respondError(w, http.StatusBadRequest, "Amount must be greater than zero")
			return
		}
		if req.Amount > 10000000000 { // 100 million dollars
			respondError(w, http.StatusBadRequest, "Amount exceeds maximum limit")
			return
		}

		req.RecipientEmail = strings.ToLower(strings.TrimSpace(req.RecipientEmail))
		if !emailRegex.MatchString(req.RecipientEmail) {
			respondError(w, http.StatusBadRequest, "Invalid recipient email format")
			return
		}

		// --- FAST PATH ---
		var existing Transfer
		err := pool.QueryRow(r.Context(),
			`SELECT id, idempotency_key, sender_id, recipient_id, amount, notes, status, created_at
             FROM transfers WHERE idempotency_key = $1`, idempotencyKey).
			Scan(&existing.ID, &existing.IdempotencyKey, &existing.SenderID, &existing.RecipientID,
				&existing.Amount, &existing.Notes, &existing.Status, &existing.CreatedAt)
		if err == nil {
			status := http.StatusOK
			if existing.Status == "failed" {
				status = http.StatusBadRequest
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			json.NewEncoder(w).Encode(existing)
			return
		}

		// --- BEGIN TRANSACTION ---
		tx, err := pool.Begin(r.Context())
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to start transaction")
			return
		}
		defer tx.Rollback(r.Context())

		// Step 1: Resolve recipient
		var recipientID string
		err = tx.QueryRow(r.Context(),
			`SELECT id FROM users WHERE email = $1`, req.RecipientEmail).Scan(&recipientID)
		if err != nil {
			respondError(w, http.StatusBadRequest, "recipient not found")
			return
		}

		if recipientID == senderID {
			respondError(w, http.StatusBadRequest, "cannot transfer to self")
			return
		}

		// Step 2: Lock users in deterministic UUID order
		firstID, secondID := senderID, recipientID
		if senderID > recipientID {
			firstID, secondID = recipientID, senderID
		}

		var firstBalance, secondBalance int64
		err = tx.QueryRow(r.Context(),
			`SELECT balance FROM users WHERE id = $1 FOR UPDATE`, firstID).Scan(&firstBalance)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to lock sender")
			return
		}
		err = tx.QueryRow(r.Context(),
			`SELECT balance FROM users WHERE id = $1 FOR UPDATE`, secondID).Scan(&secondBalance)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to lock recipient")
			return
		}

		var senderBalance int64
		if firstID == senderID {
			senderBalance = firstBalance
		} else {
			senderBalance = secondBalance
		}

		// Step 3: Re-check idempotency key
		err = tx.QueryRow(r.Context(),
			`SELECT id, idempotency_key, sender_id, recipient_id, amount, notes, status, created_at
             FROM transfers WHERE idempotency_key = $1`, idempotencyKey).
			Scan(&existing.ID, &existing.IdempotencyKey, &existing.SenderID, &existing.RecipientID,
				&existing.Amount, &existing.Notes, &existing.Status, &existing.CreatedAt)
		if err == nil {
			tx.Commit(r.Context())
			status := http.StatusOK
			if existing.Status == "failed" {
				status = http.StatusBadRequest
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			json.NewEncoder(w).Encode(existing)
			return
		}

		// Step 4: Check balance
		if senderBalance < req.Amount {
			err = tx.QueryRow(r.Context(),
				`INSERT INTO transfers (idempotency_key, sender_id, recipient_id, amount, notes, status)
                 VALUES ($1,$2,$3,$4,$5,'failed')
                 RETURNING id, idempotency_key, sender_id, recipient_id, amount, notes, status, created_at`,
				idempotencyKey, senderID, recipientID, req.Amount, req.Notes).
				Scan(&existing.ID, &existing.IdempotencyKey, &existing.SenderID, &existing.RecipientID,
					&existing.Amount, &existing.Notes, &existing.Status, &existing.CreatedAt)
			if err != nil {
				respondError(w, http.StatusInternalServerError, "Failed to record failed transfer")
				return
			}
			tx.Commit(r.Context())

			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(existing)
			return
		}

		// Step 5: Execute transfer
		_, err = tx.Exec(r.Context(),
			`UPDATE users SET balance = balance - $1 WHERE id = $2`, req.Amount, senderID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to update sender balance")
			return
		}
		_, err = tx.Exec(r.Context(),
			`UPDATE users SET balance = balance + $1 WHERE id = $2`, req.Amount, recipientID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to update recipient balance")
			return
		}

		err = tx.QueryRow(r.Context(),
			`INSERT INTO transfers (idempotency_key, sender_id, recipient_id, amount, notes, status)
             VALUES ($1,$2,$3,$4,$5,'completed')
             RETURNING id, idempotency_key, sender_id, recipient_id, amount, notes, status, created_at`,
			idempotencyKey, senderID, recipientID, req.Amount, req.Notes).
			Scan(&existing.ID, &existing.IdempotencyKey, &existing.SenderID, &existing.RecipientID,
				&existing.Amount, &existing.Notes, &existing.Status, &existing.CreatedAt)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to record transfer")
			return
		}

		// Step 6: Commit
		err = tx.Commit(r.Context())
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to commit transaction")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(existing)
	}
}

func TransferHistoryHandler(pool *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := r.Context().Value("user_id").(string)

		rows, err := pool.Query(r.Context(),
			`SELECT id, idempotency_key, sender_id, recipient_id, amount, notes, status, created_at
             FROM transfers
             WHERE sender_id = $1 OR recipient_id = $1
             ORDER BY created_at DESC`, userID)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to load transfer history")
			return
		}
		defer rows.Close()

		var history []Transfer
		for rows.Next() {
			var t Transfer
			if err := rows.Scan(&t.ID, &t.IdempotencyKey, &t.SenderID, &t.RecipientID,
				&t.Amount, &t.Notes, &t.Status, &t.CreatedAt); err != nil {
				respondError(w, http.StatusInternalServerError, "Failed to parse transfer history")
				return
			}
			history = append(history, t)
		}

		if history == nil {
			history = []Transfer{}
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(history)
	}
}
