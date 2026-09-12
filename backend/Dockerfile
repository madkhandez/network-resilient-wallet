# Stage 1: Build Frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /app
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Backend
FROM golang:1.22-alpine AS backend-builder
WORKDIR /app
COPY backend/go.mod ./
# Ignore go.sum missing error since we didn't generate it locally
RUN go mod download || true
COPY backend/ ./
# Run go mod tidy to generate go.sum and download deps
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -o wallet-server .

# Stage 3: Final Runtime Image
FROM alpine:3.19
WORKDIR /app
COPY --from=backend-builder /app/wallet-server /app/wallet-server
COPY --from=backend-builder /app/schema.sql /app/schema.sql
COPY --from=frontend-builder /app/dist /app/frontend/dist

EXPOSE 8080
CMD ["/app/wallet-server"]
