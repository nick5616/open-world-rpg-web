// Package env reads service configuration from environment variables. Every
// port and endpoint is configurable (spec section 4); defaults match
// scripts/config.mjs so `npm run dev` and a bare `go run` agree.
package env

import (
	"os"
	"strconv"
	"time"
)

// Str returns the variable or def when unset/empty.
func Str(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// Int returns the variable parsed as int, or def.
func Int(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// Float returns the variable parsed as float64, or def.
func Float(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseFloat(v, 64); err == nil {
			return n
		}
	}
	return def
}

// Bool returns true for 1/true/yes and false for 0/false/no, else def.
func Bool(key string, def bool) bool {
	switch os.Getenv(key) {
	case "1", "true", "yes":
		return true
	case "0", "false", "no":
		return false
	}
	return def
}

// Duration parses a Go duration string (e.g. "2ms"), or def.
func Duration(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}

// Default endpoints and ports (keep in sync with scripts/config.mjs). The
// stock Postgres/Redis ports are commonly taken on dev machines, so local
// infra listens on 55432/56379.
const (
	DefaultPostgresURL  = "postgres://lodestone:lodestone@localhost:55432/lodestone?sslmode=disable"
	DefaultRedisAddr    = "localhost:56379"
	DefaultDirectorPort = 8090
	DefaultAccountPort  = 8091
	DefaultZonePort     = 8092
	DefaultSocialPort   = 8093
	DefaultCreatorPort  = 8094
	DefaultLiveKitURL   = "ws://localhost:7880"
)

// PostgresURL is LODESTONE_PG_URL or the local docker-compose default.
func PostgresURL() string { return Str("LODESTONE_PG_URL", DefaultPostgresURL) }

// RedisAddr is LODESTONE_REDIS_ADDR or the local docker-compose default.
func RedisAddr() string { return Str("LODESTONE_REDIS_ADDR", DefaultRedisAddr) }

// Addr builds ":port" from a PORT-style variable.
func Addr(key string, def int) string { return ":" + strconv.Itoa(Int(key, def)) }
