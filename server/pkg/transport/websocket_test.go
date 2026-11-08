package transport

import (
	"context"
	"encoding/binary"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func dial(t *testing.T, h *WebSocket, accept AcceptFunc) (Conn, func()) {
	t.Helper()
	srv := httptest.NewServer(h.Handler(accept))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := DialWebSocket(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"))
	if err != nil {
		t.Fatal(err)
	}
	return c, func() { c.Close(CloseNormal, ""); srv.Close() }
}

func TestReliableOrderAndKickCloseCode(t *testing.T) {
	c, stop := dial(t, &WebSocket{}, func(s Conn) {
		for i := 0; i < 50; i++ {
			_ = s.SendReliable([]byte{69, byte(i)})
		}
		s.Close(CloseKickBase+3, "duplicate login")
		<-s.Done()
	})
	defer stop()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for i := 0; i < 50; i++ {
		b, err := c.Recv(ctx)
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if b[1] != byte(i) {
			t.Fatalf("out of order: got %d want %d", b[1], i)
		}
	}
	_, err := c.Recv(ctx)
	if got := websocket.CloseStatus(err); got != CloseKickBase+3 {
		t.Fatalf("close status %d (%v)", got, err)
	}
	if c.Stats().BytesIn.Load() != 50*(2+2) {
		t.Fatalf("bytes in %d, want payload + 2-byte headers", c.Stats().BytesIn.Load())
	}
}

func TestUnreliableIsLatestWins(t *testing.T) {
	const n = 3000
	c, stop := dial(t, &WebSocket{}, func(s Conn) {
		for i := 1; i <= n; i++ {
			b := make([]byte, 2048)
			b[0] = 65
			binary.LittleEndian.PutUint32(b[1:], uint32(i))
			s.SendUnreliable(b)
		}
		// A different message id is never replaced by snapshots.
		s.SendUnreliable([]byte{66, 1})
		_ = s.SendReliable([]byte{69, 0xff})
		<-s.Done()
	})
	defer stop()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	last, got, pong := uint32(0), 0, false
	sawEnd := false
	for !(sawEnd && last == n && pong) {
		b, err := c.Recv(ctx)
		if err != nil {
			t.Fatalf("recv: %v (last=%d pong=%v end=%v)", err, last, pong, sawEnd)
		}
		switch b[0] {
		case 65:
			v := binary.LittleEndian.Uint32(b[1:])
			if v <= last {
				t.Fatalf("snapshots went backwards: %d after %d", v, last)
			}
			last = v
			got++
		case 66:
			pong = true
		case 69:
			sawEnd = true
		}
	}
	if got > n {
		t.Fatal("received more than sent")
	}
	t.Logf("received %d of %d unreliable frames; newest always delivered", got, n)
}

func TestSendAfterCloseFails(t *testing.T) {
	c, stop := dial(t, &WebSocket{}, func(s Conn) { <-s.Done() })
	defer stop()
	c.Close(CloseNormal, "")
	<-c.Done()
	if err := c.SendReliable([]byte{1}); !errors.Is(err, ErrClosed) {
		t.Fatalf("want ErrClosed, got %v", err)
	}
	if c.SendUnreliable([]byte{2}) {
		t.Fatal("unreliable send after close must report false")
	}
}
