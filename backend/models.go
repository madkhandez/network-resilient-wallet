package main

import (
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type User struct {
	ID           string    `json:"id"`
	Email        string    `json:"email"`
	PasswordHash string    `json:"-"`
	Balance      int64     `json:"balance"`
	CreatedAt    time.Time `json:"created_at"`
}

type RegisterRequest struct {
	Email           string `json:"email"`
	Password        string `json:"password"`
	ConfirmPassword string `json:"confirm_password"`
}

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type AuthResponse struct {
	Token string `json:"token"`
}

type ProfileResponse struct {
	ID      string `json:"id"`
	Email   string `json:"email"`
	Balance int64  `json:"balance"`
}

type ErrorResponse struct {
	Error string `json:"error"`
}

type CustomClaims struct {
	Email string `json:"email"`
	jwt.RegisteredClaims
}

type TransferRequest struct {
	RecipientEmail string `json:"recipient_email"`
	Amount         int64  `json:"amount"`
	Notes          string `json:"notes"`
}

type Transfer struct {
	ID             string    `json:"id"`
	IdempotencyKey string    `json:"idempotency_key"`
	SenderID       string    `json:"sender_id"`
	RecipientID    string    `json:"recipient_id"`
	Amount         int64     `json:"amount"`
	Notes          string    `json:"notes"`
	Status         string    `json:"status"`
	CreatedAt      time.Time `json:"created_at"`
}
