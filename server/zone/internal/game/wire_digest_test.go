package game

import (
	"crypto/sha256"
	"fmt"
	"os"
	"testing"

	"lodestone/server/pkg/transport"
)

// TestWireDigest (G5, 4 vCPU): a SHA-256 over every snapshot and reliable
// byte two deterministic scale runs send (90 clients with 600 enemies for
// 400 ticks; 300 clients with 2,000 enemies for 300 ticks). Not a golden
// test: run it on two builds and compare the digests to prove a
// performance change left the wire untouched (any gameplay change moves
// them on purpose).
//
//	LODESTONE_WIRE_DIGEST=1 go test ./internal/game -run WireDigest -v
func TestWireDigest(t *testing.T) {
	if os.Getenv("LODESTONE_WIRE_DIGEST") == "" {
		t.Skip("set LODESTONE_WIRE_DIGEST=1 (compares builds; see the comment)")
	}
	for _, c := range []struct {
		p, e  int
		r     float64
		ticks int
	}{{90, 600, 160, 400}, {300, 2000, 300, 300}} {
		w := newScaleWorldConn(t, c.p, c.e, c.r, func() transport.Conn { return &recConn{benchConn: benchConn{done: make(chan struct{})}} })
		for i := 0; i < c.ticks; i++ {
			w.step()
		}
		h := sha256.New()
		n := 0
		for _, b := range w.bots {
			rc := b.sess.conn.(*recConn)
			for _, f := range rc.snaps {
				h.Write(f)
				n += len(f)
			}
			for _, f := range rc.rel {
				h.Write(f)
				n += len(f)
			}
		}
		fmt.Printf("DIGEST p%d_e%d %d ticks: %d bytes %x\n", c.p, c.e, c.ticks, n, h.Sum(nil))
	}
}
