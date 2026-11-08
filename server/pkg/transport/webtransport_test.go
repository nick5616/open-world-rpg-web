package transport

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"
)

// startWT runs a WebTransport server on a random UDP port with a fresh dev
// cert and returns the client URL (with the #certHash fragment, as zones
// announce it).
func startWT(t *testing.T, accept RequestAcceptFunc) string {
	t.Helper()
	cert, err := NewDevCert(0)
	if err != nil {
		t.Fatal(err)
	}
	wt := &WebTransport{Addr: "127.0.0.1:0", TLS: cert.TLS}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- wt.ServeRequests(ctx, accept) }()
	addr := wt.LocalAddr(5 * time.Second)
	if addr == nil {
		t.Fatal("WebTransport server did not start")
	}
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("WebTransport server did not stop")
		}
	})
	return WithCertHash(fmt.Sprintf("https://%s/wt?spawn=1,2", addr), cert.Hash)
}

func dialWT(t *testing.T, url string) Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := DialWebTransport(ctx, url, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close(CloseNormal, "") })
	return c
}

func TestDevCertWithinBrowserLimits(t *testing.T) {
	c, err := NewDevCert(30 * 24 * time.Hour) // asks too much: capped
	if err != nil {
		t.Fatal(err)
	}
	if d := c.NotAfter.Sub(c.NotBefore); d > DevCertMaxValidity {
		t.Fatalf("validity %v over the 14-day serverCertificateHashes limit", d)
	}
	if c.Hash == "" || len(c.TLS.Certificates) != 1 {
		t.Fatal("missing hash or certificate")
	}
	u, h := SplitCertHash(WithCertHash("https://localhost:8092/wt", c.Hash))
	if u != "https://localhost:8092/wt" || h != c.Hash {
		t.Fatalf("fragment round trip: %q %q", u, h)
	}
	if u, h := SplitCertHash("https://example.com/wt"); u != "https://example.com/wt" || h != "" {
		t.Fatal("URL without fragment must pass through")
	}
}

func TestWebTransportRoundTripAndKick(t *testing.T) {
	gotQuery := make(chan string, 1)
	url := startWT(t, func(r *http.Request, s Conn) {
		gotQuery <- r.URL.Query().Get("spawn")
		if s.Kind() != 2 {
			t.Errorf("kind %d", s.Kind())
		}
		// Echo: the first frame arrives on the reliable stream (Hello), the
		// second as a datagram (Input).
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		for i := 0; i < 2; i++ {
			b, err := s.Recv(ctx)
			if err != nil {
				t.Errorf("server recv: %v", err)
				return
			}
			_ = s.SendReliable(append([]byte{64}, b...))
		}
		for i := 0; i < 50; i++ {
			_ = s.SendReliable([]byte{67, byte(i)})
		}
		s.Close(CloseKickBase+3, "duplicate login")
		<-s.Done()
	})
	c := dialWT(t, url)
	if err := c.SendReliable([]byte{1, 0xaa}); err != nil {
		t.Fatal(err)
	}
	// Datagrams may be lost on a real path, never on loopback in practice.
	c.SendUnreliable([]byte{2, 0xbb})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	seen := map[byte]bool{}
	for i := 0; i < 2; i++ {
		b, err := c.Recv(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if b[0] != 64 {
			t.Fatalf("echo frame %v", b)
		}
		seen[b[1]] = true
	}
	if !seen[1] || !seen[2] {
		t.Fatalf("missing echo: %v", seen)
	}
	for i := 0; i < 50; i++ {
		b, err := c.Recv(ctx)
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if b[0] != 67 || b[1] != byte(i) {
			t.Fatalf("out of order: %v want %d", b, i)
		}
	}
	_, err := c.Recv(ctx)
	if got := CloseCode(err); got != CloseKickBase+3 {
		t.Fatalf("close code %d (%v)", got, err)
	}
	if q := <-gotQuery; q != "1,2" {
		t.Fatalf("query not passed to accept: %q", q)
	}
}

func TestWebTransportUnreliableLatestWinsAndBigFrames(t *testing.T) {
	const n = 2000
	url := startWT(t, func(_ *http.Request, s Conn) {
		for i := 1; i <= n; i++ {
			size := 200
			if i%7 == 0 {
				size = 3000 // over the datagram limit: rides the stream
			}
			b := make([]byte, size)
			b[0] = 65
			binary.LittleEndian.PutUint32(b[1:], uint32(i))
			s.SendUnreliable(b)
			if i%50 == 0 {
				time.Sleep(time.Millisecond)
			}
		}
		_ = s.SendReliable([]byte{69, 0xff})
		<-s.Done()
	})
	c := dialWT(t, url)
	_ = c.SendReliable([]byte{1}) // opens the stream on the wire
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	newest, got, big := uint32(0), 0, 0
	for {
		b, err := c.Recv(ctx)
		if err != nil {
			t.Fatalf("recv: %v (newest=%d)", err, newest)
		}
		if b[0] == 69 {
			break
		}
		v := binary.LittleEndian.Uint32(b[1:])
		if v > newest {
			newest = v
		}
		if len(b) > maxDatagramPayload {
			big++
		}
		got++
	}
	// The end marker is reliable and may overtake trailing datagrams; give
	// the last snapshot a moment.
	deadline := time.Now().Add(time.Second)
	for newest != n && time.Now().Before(deadline) {
		rctx, rcancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		b, err := c.Recv(rctx)
		rcancel()
		if err == nil && b[0] == 65 {
			if v := binary.LittleEndian.Uint32(b[1:]); v > newest {
				newest = v
			}
		}
	}
	if newest != n {
		t.Fatalf("newest unreliable frame %d never arrived (want %d)", newest, n)
	}
	if big == 0 {
		t.Fatal("no oversized frame came through the stream")
	}
	t.Logf("received %d of %d unreliable frames (%d via stream); newest delivered", got, n, big)
}

func TestWebTransportWrongCertHashRefused(t *testing.T) {
	url := startWT(t, func(_ *http.Request, s Conn) { <-s.Done() })
	base, _ := SplitCertHash(url)
	other, err := NewDevCert(0)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if c, err := DialWebTransport(ctx, base, other.Hash); err == nil {
		c.Close(CloseNormal, "")
		t.Fatal("dial with the wrong certificate hash must fail")
	}
}

func TestCloseCodeUnknown(t *testing.T) {
	if CloseCode(nil) != -1 || CloseCode(errors.New("x")) != -1 {
		t.Fatal("errors without a code must report -1")
	}
}
