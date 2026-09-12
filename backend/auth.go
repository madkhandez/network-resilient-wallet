package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

var emailRegex = regexp.MustCompile(`^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`)

func getJWTSecret() []byte {
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		secret = "change-me-in-production"
	}
	return []byte(secret)
}

func RegisterHandler(db *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req RegisterRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "Invalid JSON payload")
			return
		}

		req.Email = strings.ToLower(strings.TrimSpace(req.Email))
		if !emailRegex.MatchString(req.Email) {
			respondError(w, http.StatusBadRequest, "Invalid email format")
			return
		}

		if len(req.Password) < 8 {
			respondError(w, http.StatusBadRequest, "Password must be at least 8 characters")
			return
		}

		if req.Password != req.ConfirmPassword {
			respondError(w, http.StatusBadRequest, "Passwords do not match")
			return
		}

		hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Internal server error")
			return
		}

		dbCtx, dbCancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer dbCancel()

		_, err = db.Exec(dbCtx,
			"INSERT INTO users (email, password_hash) VALUES ($1, $2)",
			req.Email, string(hash))

		if err != nil {
			if strings.Contains(err.Error(), "users_email_key") || strings.Contains(err.Error(), "duplicate key value") {
				respondError(w, http.StatusConflict, "Email already exists")
				return
			}
			respondError(w, http.StatusInternalServerError, "Failed to create user")
			return
		}

		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]string{"message": "User registered successfully"})
	}
}

func LoginHandler(db *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req LoginRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "Invalid JSON payload")
			return
		}

		req.Email = strings.ToLower(strings.TrimSpace(req.Email))

		dbCtx, dbCancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer dbCancel()

		var user User
		err := db.QueryRow(dbCtx,
			"SELECT id, email, password_hash FROM users WHERE email = $1", req.Email).
			Scan(&user.ID, &user.Email, &user.PasswordHash)

		if err != nil {
			respondError(w, http.StatusUnauthorized, "Invalid credentials")
			return
		}

		if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
			respondError(w, http.StatusUnauthorized, "Invalid credentials")
			return
		}

		claims := CustomClaims{
			Email: user.Email,
			RegisteredClaims: jwt.RegisteredClaims{
				Subject:   user.ID,
				ExpiresAt: jwt.NewNumericDate(time.Now().Add(1 * time.Hour)),
				IssuedAt:  jwt.NewNumericDate(time.Now()),
			},
		}

		token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
		signedToken, err := token.SignedString(getJWTSecret())
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to generate token")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(AuthResponse{Token: signedToken})
	}
}

func AuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			respondError(w, http.StatusUnauthorized, "Missing or invalid authorization header")
			return
		}

		tokenString := strings.TrimPrefix(authHeader, "Bearer ")

		claims := &CustomClaims{}
		token, err := jwt.ParseWithClaims(tokenString, claims, func(token *jwt.Token) (interface{}, error) {
			return getJWTSecret(), nil
		})

		if err != nil || !token.Valid {
			respondError(w, http.StatusUnauthorized, "Invalid or expired token")
			return
		}

		ctx := context.WithValue(r.Context(), "user_id", claims.Subject)
		ctx = context.WithValue(ctx, "user_email", claims.Email)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func respondError(w http.ResponseWriter, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(ErrorResponse{Error: message})
}
