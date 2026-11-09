package transport

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"lodestone/server/pkg/proto"
)

// WebSocket is the mandatory fallback transport (spec 9): binary frames, one
// protocol message per frame, mounted on the service's HTTP mux at /ws.
type WebSocket struct {
	// OriginPatterns limits browser origins (host patterns, see
	// websocket.AcceptOptions). Empty or "*" accepts any origin (dev).
	OriginPatterns []string
	// ReliableQueue bounds queued reliable frames per connection (default 1024).
	ReliableQueue int
}

// Handler upgrades requests and hands each connection to accept on the
// request goroutine.
func (ws *WebSocket) Handler(accept AcceptFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		opts := &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled}
		if len(ws.OriginPatterns) == 0 || (len(ws.OriginPatterns) == 1 && ws.OriginPatterns[0] == "*") {
			opts.InsecureSkipVerify = true
		} else {
			opts.OriginPatterns = ws.OriginPatterns
		}
		c, err := websocket.Accept(w, r, opts)
		if err != nil {
			return // Accept already wrote the HTTP error
		}
		conn := newWSConn(c, r.RemoteAddr, false, ws.ReliableQueue)
		defer conn.Close(CloseNormal, "")
		accept(conn)
	})
}

// DialWebSocket connects a client (bots, tests) to a zone /ws endpoint.
func DialWebSocket(ctx context.Context, url string) (Conn, error) {
	c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return nil, err
	}
	return newWSConn(c, url, true, 0), nil
}

type wsConn struct {
	c      *websocket.Conn
	remote string
	client bool // client-side frames are masked (+4 header bytes)
	stats  Stats
	k      wake // WP19b: holdable writer wake-ups (Holder)

	ctx    context.Context
	cancel context.CancelFunc

	mu         sync.Mutex
	reliable   [][]byte
	unreliable [][]byte // at most one pending frame per message id
	maxRel     int
	closing    bool
	closeCode  int
	closeMsg   string
	closed     bool
	notify     chan struct{}
	done       chan struct{}
}

func newWSConn(c *websocket.Conn, remote string, client bool, maxRel int) *wsConn {
	if maxRel <= 0 {
		maxRel = 1024
	}
	ctx, cancel := context.WithCancel(context.Background())
	w := &wsConn{c: c, remote: remote, client: client, ctx: ctx, cancel: cancel, maxRel: maxRel,
		notify: make(chan struct{}, 1), done: make(chan struct{})}
	c.SetReadLimit(64 << 10)
	go w.writer()
	return w
}

func (w *wsConn) Kind() proto.Transport { return proto.TransportWebsocket }
func (w *wsConn) RemoteAddr() string    { return w.remote }
func (w *wsConn) Stats() *Stats         { return &w.stats }
func (w *wsConn) Done() <-chan struct{} { return w.done }
func (w *wsConn) SetReadLimit(n int64)  { w.c.SetReadLimit(n) }

func (w *wsConn) Recv(ctx context.Context) ([]byte, error) {
	for {
		typ, b, err := w.c.Read(ctx)
		if err != nil {
			w.markClosed()
			return nil, err
		}
		w.stats.BytesIn.Add(int64(len(b) + wsHeaderLen(len(b), !w.client)))
		w.stats.FramesIn.Add(1)
		if typ != websocket.MessageBinary {
			continue // the protocol is binary only; ignore stray text frames
		}
		return b, nil
	}
}

func (w *wsConn) SendReliable(b []byte) error {
	w.mu.Lock()
	if w.closing || w.closed {
		w.mu.Unlock()
		return ErrClosed
	}
	if len(w.reliable) >= w.maxRel {
		w.mu.Unlock()
		return ErrSlowConsumer
	}
	w.reliable = append(w.reliable, b)
	w.mu.Unlock()
	w.stats.ReliableQueued.Add(int64(len(b) + wsHeaderLen(len(b), w.client)))
	w.k.poke(w.poke)
	return nil
}

func (w *wsConn) SendUnreliable(b []byte) bool { return w.sendUnreliable(b, false) }

// SendUrgent implements Holder.
func (w *wsConn) SendUrgent(b []byte) bool { return w.sendUnreliable(b, true) }

// Hold and Release implement Holder (WP19b).
func (w *wsConn) Hold()    { w.k.hold() }
func (w *wsConn) Release() { w.k.release(w.poke) }

func (w *wsConn) sendUnreliable(b []byte, urgent bool) bool {
	if len(b) == 0 {
		return false
	}
	w.mu.Lock()
	if w.closing || w.closed {
		w.mu.Unlock()
		return false
	}
	for i, p := range w.unreliable {
		if p[0] == b[0] {
			w.unreliable[i] = b
			w.mu.Unlock()
			w.stats.Dropped.Add(1)
			return false
		}
	}
	w.unreliable = append(w.unreliable, b)
	w.mu.Unlock()
	if urgent {
		w.poke()
	} else {
		w.k.poke(w.poke)
	}
	return true
}

func (w *wsConn) Close(code int, reason string) {
	w.mu.Lock()
	if w.closing || w.closed {
		w.mu.Unlock()
		return
	}
	w.closing, w.closeCode, w.closeMsg = true, code, reason
	w.mu.Unlock()
	w.poke()
}

func (w *wsConn) poke() {
	select {
	case w.notify <- struct{}{}:
	default:
	}
}

func (w *wsConn) markClosed() {
	w.mu.Lock()
	w.closed = true
	w.mu.Unlock()
	w.poke()
}

// writer is the only goroutine that writes to the socket. Reliable frames go
// first; unreliable ones fill the gaps.
func (w *wsConn) writer() {
	defer close(w.done)
	defer w.cancel()
	for {
		w.mu.Lock()
		var b []byte
		switch {
		case w.closed:
			w.mu.Unlock()
			w.c.CloseNow()
			return
		case len(w.reliable) > 0:
			b = w.reliable[0]
			w.reliable[0] = nil
			w.reliable = w.reliable[1:]
		case len(w.unreliable) > 0 && !w.closing:
			b = w.unreliable[0]
			copy(w.unreliable, w.unreliable[1:])
			w.unreliable[len(w.unreliable)-1] = nil
			w.unreliable = w.unreliable[:len(w.unreliable)-1]
		case w.closing:
			code, msg := w.closeCode, w.closeMsg
			w.closed = true
			w.mu.Unlock()
			// Close does the close handshake with its own timeout (5 s).
			_ = w.c.Close(websocket.StatusCode(code), msg)
			return
		}
		w.mu.Unlock()

		if b == nil {
			<-w.notify
			continue
		}
		wctx, cancel := context.WithTimeout(w.ctx, 10*time.Second)
		err := w.c.Write(wctx, websocket.MessageBinary, b)
		cancel()
		if err != nil {
			w.markClosed()
			if !errors.Is(err, context.Canceled) {
				w.c.CloseNow()
			}
			return
		}
		w.stats.BytesOut.Add(int64(len(b) + wsHeaderLen(len(b), w.client)))
		w.stats.FramesOut.Add(1)
	}
}
