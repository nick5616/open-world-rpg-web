// Package transport hides how zone frames travel (spec 9 Transport). The zone
// and bots talk to a Conn; WebSocket (the mandatory fallback) and WebTransport
// (HTTP/3, preferred where browsers have it) implement the same interface, so
// session code never knows which one a client picked.
//
// Every frame is exactly one protocol message ([msgId][body], see
// contracts/README.md). Two send paths map spec 9's delivery classes:
//
//   - SendReliable: reliable ordered (Welcome, Kick, events, inventory). Over
//     WebSocket everything is reliable ordered; over WebTransport it is one
//     bidirectional stream (per-chunk WorldEdits streams arrive with WP09).
//   - SendUnreliable: latest-wins (snapshots, clock pongs). Over WebTransport
//     these become datagrams. Over WebSocket we cannot drop on the wire, so we
//     drop in the queue instead: a not-yet-written unreliable frame is replaced
//     by a newer one with the same message id. A slow reader therefore sheds
//     stale snapshots instead of building seconds of latency (snapshots are
//     deltas against acknowledged baselines, so skipping one is always safe).
package transport

import (
	"context"
	"errors"
	"sync/atomic"

	"github.com/coder/websocket"
	"github.com/quic-go/webtransport-go"

	"lodestone/server/pkg/proto"
)

// AcceptFunc handles one accepted connection. It runs on the connection's own
// goroutine and should block for the connection's lifetime (it is the reader).
type AcceptFunc func(Conn)

// Conn is one client connection, whatever the transport.
type Conn interface {
	Kind() proto.Transport
	RemoteAddr() string
	// Recv blocks for the next frame. The returned slice is owned by the caller.
	Recv(ctx context.Context) ([]byte, error)
	// SendReliable queues b (ownership passes to the Conn). It fails if the
	// connection is closed or its reliable queue is full; a client that far
	// behind should be dropped.
	SendReliable(b []byte) error
	// SendUnreliable offers b latest-wins (ownership passes to the Conn).
	// Returns false if it replaced a pending frame or the conn is closed.
	SendUnreliable(b []byte) bool
	// SetReadLimit caps the size of one inbound frame.
	SetReadLimit(n int64)
	// Close flushes queued reliable frames (bounded time), then closes with an
	// application close code (4000 + KickCode for kicks, 1000 normal).
	Close(code int, reason string)
	// Done is closed once the connection is fully closed.
	Done() <-chan struct{}
	// Stats returns byte and frame counters (bytes include transport framing).
	Stats() *Stats
}

// Stats counts traffic for metrics and bandwidth budgets. Bytes include the
// WebSocket frame header (2-14 bytes) but not TCP/IP, since that is what the
// budget in spec 9 can actually be tuned against.
type Stats struct {
	BytesIn, BytesOut   atomic.Int64
	FramesIn, FramesOut atomic.Int64
	Dropped             atomic.Int64 // unreliable frames replaced before they were written
}

// Close codes.
const (
	CloseNormal    = 1000
	CloseGoingAway = 1001
	// CloseKickBase + proto.KickCode is the close code for a kick, so a client
	// that missed the Kick frame still learns why.
	CloseKickBase = 4000
)

var (
	// ErrClosed is returned by sends on a closed connection.
	ErrClosed = errors.New("transport: connection closed")
	// ErrSlowConsumer is returned when the reliable queue overflows.
	ErrSlowConsumer = errors.New("transport: reliable queue full")
)

// CloseCode extracts the application close code from a Recv error: the
// WebSocket close status or the WebTransport session error code. -1 when the
// error carries none (network failure, local close).
func CloseCode(err error) int {
	if err == nil {
		return -1
	}
	if s := websocket.CloseStatus(err); s != -1 {
		return int(s)
	}
	var se *webtransport.SessionError
	if errors.As(err, &se) {
		return int(se.ErrorCode)
	}
	return -1
}

// wsHeaderLen is the WebSocket frame header size for a payload of n bytes
// (+4 masking key for client-to-server frames).
func wsHeaderLen(n int, masked bool) int {
	h := 2
	switch {
	case n >= 65536:
		h = 10
	case n >= 126:
		h = 4
	}
	if masked {
		h += 4
	}
	return h
}
