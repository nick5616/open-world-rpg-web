package svc

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCORSAllowsEachListedOrigin(t *testing.T) {
	h := CORS("https://lodestone-rpg-game.netlify.app, https://lodestone.saucedog.art/", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	for origin, want := range map[string]string{
		"https://lodestone.saucedog.art":         "https://lodestone.saucedog.art",
		"https://lodestone-rpg-game.netlify.app": "https://lodestone-rpg-game.netlify.app",
		"https://evil.example":                   "https://lodestone-rpg-game.netlify.app",
	} {
		for _, method := range []string{http.MethodOptions, http.MethodPost} {
			r := httptest.NewRequest(method, "/v1/wake", nil)
			r.Header.Set("Origin", origin)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if got := w.Header().Get("Access-Control-Allow-Origin"); got != want {
				t.Errorf("%s from %s: allow %q, want %q", method, origin, got, want)
			}
			if w.Header().Get("Vary") != "Origin" {
				t.Errorf("%s from %s: no Vary: Origin", method, origin)
			}
		}
	}
}

func TestCORSSingleOriginAndAny(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {})
	for cfg, want := range map[string]string{"https://a.example": "https://a.example", "*": "*", "": "*"} {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.Header.Set("Origin", "https://b.example")
		w := httptest.NewRecorder()
		CORS(cfg, ok).ServeHTTP(w, r)
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != want {
			t.Errorf("config %q: allow %q, want %q", cfg, got, want)
		}
	}
}
