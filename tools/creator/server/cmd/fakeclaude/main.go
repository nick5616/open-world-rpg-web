// Command fakeclaude serves the fake Messages API from internal/vibe/vibetest
// on a local port, so the headless e2e run (tools/creator/scripts/e2e.mjs)
// can exercise the vibe path with LODESTONE_CREATOR_LLM=1 and no real API
// call. Never point a production creator at it.
//
//	go run ./tools/creator/server/cmd/fakeclaude -addr 127.0.0.1:8095
package main

import (
	"flag"
	"log"
	"net/http"

	"lodestone/tools/creator/server/internal/vibe/vibetest"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8095", "listen address")
	flag.Parse()
	fake := &vibetest.Fake{}
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fake.ServeHTTP(w, r)
		log.Printf("fake messages api: %s %s (request #%d)", r.Method, r.URL.Path, fake.Requests.Load())
	})
	log.Printf("fake Messages API on http://%s", *addr)
	log.Fatal(http.ListenAndServe(*addr, h))
}
