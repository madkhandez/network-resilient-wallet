package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://wallet:wallet@localhost:5432/wallet?sslmode=disable"
	}

	db := connectDB(dbURL)
	defer db.Close()

	initSchema(db)

	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	r.Route("/api", func(r chi.Router) {
		r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"status":"ok"}`))
		})

		r.Route("/auth", func(r chi.Router) {
			r.Post("/register", RegisterHandler(db))
			r.Post("/login", LoginHandler(db))
		})

		// Protected routes
		r.Group(func(r chi.Router) {
			r.Use(AuthMiddleware)
			r.Get("/me", ProfileHandler(db))
			r.Post("/transfers", TransferHandler(db))
			r.Get("/transfers", TransferHistoryHandler(db))
		})
	})

	// Serve React App
	workDir, _ := os.Getwd()
	var filesDir string
	if _, err := os.Stat(filepath.Join(workDir, "frontend/dist")); err == nil {
		filesDir = filepath.Join(workDir, "frontend/dist") // Running locally or in stage 3 with /app
	} else {
		filesDir = filepath.Join(workDir, "../frontend/dist") // Running locally from backend/
	}
	serveSPA(r, filesDir)

	log.Printf("Server starting on port %s", port)
	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      r,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}

func connectDB(url string) *pgxpool.Pool {
	var pool *pgxpool.Pool
	var err error
	maxRetries := 10

	for i := 0; i < maxRetries; i++ {
		pool, err = pgxpool.New(context.Background(), url)
		if err == nil {
			err = pool.Ping(context.Background())
			if err == nil {
				log.Println("Successfully connected to the database")
				return pool
			}
			pool.Close()
		}
		log.Printf("Failed to connect to database. Retrying in 2 seconds... (%d/%d)\n", i+1, maxRetries)
		time.Sleep(2 * time.Second)
	}
	log.Fatalf("Unable to connect to database: %v\n", err)
	return nil
}

func initSchema(db *pgxpool.Pool) {
	pathsToTry := []string{
		"schema.sql",
		"backend/schema.sql",
		"../backend/schema.sql",
		"/app/schema.sql",
	}

	var content []byte
	var err error
	for _, p := range pathsToTry {
		content, err = os.ReadFile(p)
		if err == nil {
			break
		}
	}

	if err != nil {
		log.Printf("Warning: schema.sql not found in any standard location, skipping schema initialization")
		return
	}

	_, err = db.Exec(context.Background(), string(content))
	if err != nil {
		log.Fatalf("Failed to execute schema.sql: %v", err)
	}
	log.Println("Database schema initialized successfully")
}

func ProfileHandler(db *pgxpool.Pool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := r.Context().Value("user_id").(string)

		dbCtx, dbCancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer dbCancel()

		var profile ProfileResponse
		err := db.QueryRow(dbCtx,
			"SELECT id, email, balance FROM users WHERE id = $1", userID).
			Scan(&profile.ID, &profile.Email, &profile.Balance)

		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to load profile")
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(profile)
	}
}

// serveSPA serves the static files and falls back to index.html for unknown routes
func serveSPA(r chi.Router, publicDir string) {
	fs := http.FileServer(http.Dir(publicDir))

	r.Get("/*", func(w http.ResponseWriter, r *http.Request) {
		// If path is not an API path and the file does not exist, serve index.html
		if strings.HasPrefix(r.URL.Path, "/api") {
			http.NotFound(w, r)
			return
		}

		path := filepath.Join(publicDir, filepath.Clean(r.URL.Path))
		if _, err := os.Stat(path); os.IsNotExist(err) {
			http.ServeFile(w, r, filepath.Join(publicDir, "index.html"))
			return
		}

		fs.ServeHTTP(w, r)
	})
}
