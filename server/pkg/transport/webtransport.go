package transport

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"

	"lodestone/server/pkg/proto"
)

// WebTransport is the preferred transport (spec 9: WebTransport over HTTP/3,
// quic-go/webtransport-go). Mapping of the delivery classes:
//
//   - SendReliable   -> one long-lived bidirectional stream the CLIENT opens
//     right after the session is established (its first frame is Hello).
//     Streams have no message boundaries, so every frame is prefixed with its
//     length as a u32 little-endian (Hello can carry a save blob of hundreds
//     of KB, so u16 is not enough).
//   - SendUnreliable -> one QUIC datagram per frame, latest-wins per message
//     id exactly like the WebSocket queue. A frame larger than the path's
//     datagram limit (~1200 bytes; full snapshots in crowds are bigger) goes
//     on the reliable stream instead, still latest-wins while it waits.
//   - Client -> server unreliable frames (Input, ClockPing) arrive as
//     datagrams; Recv merges them with stream frames.
//
// Per-chunk WorldEdits streams (one unidirectional stream per chunk) arrive
// with the first package that sends WorldEdits (WP09); until then they would
// ride the reliable stream.
type WebTransport struct {
	// Addr is the UDP listen address, e.g. ":8092".
	Addr string
	// Path is the HTTP/3 path that upgrades to a session (default "/wt").
	Path string
	// TLS must carry a certificate. Browsers accept a self-signed one only via
	// serverCertificateHashes (see NewDevCert).
	TLS *tls.Config
	// CheckOrigin validates the Origin header; nil accepts any origin (dev,
	// and the ticket is the real authentication anyway).
	CheckOrigin func(r *http.Request) bool
	// ReliableQueue bounds queued reliable frames per connection (default 1024).
	ReliableQueue int

	mu     sync.Mutex
	server *webtransport.Server
	ready  chan struct{}
	addr   net.Addr
	active sync.WaitGroup // sessions whose handler has not returned
}

// Drain waits (up to timeout) for every session to finish closing. Call it
// after kicking everyone and before cancelling Serve's context: cancelling
// closes all QUIC connections at once, which would cut off the kick frames
// and close codes still being flushed.
func (t *WebTransport) Drain(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		t.active.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

// Kind identifies the transport.
func (*WebTransport) Kind() proto.Transport { return proto.TransportWebtransport }

// RequestAcceptFunc is AcceptFunc plus the upgrade request (query strings,
// e.g. the zone's dev-only ?spawn=x,z).
type RequestAcceptFunc func(r *http.Request, c Conn)

// Serve accepts sessions until ctx ends.
func (t *WebTransport) Serve(ctx context.Context, accept AcceptFunc) error {
	return t.ServeRequests(ctx, func(_ *http.Request, c Conn) { accept(c) })
}

// LocalAddr returns the bound UDP address once Serve is listening (blocks up
// to timeout). Tests listen on ":0" and read the port here.
func (t *WebTransport) LocalAddr(timeout time.Duration) net.Addr {
	t.mu.Lock()
	if t.ready == nil {
		t.ready = make(chan struct{})
	}
	ready := t.ready
	t.mu.Unlock()
	select {
	case <-ready:
	case <-time.After(timeout):
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.addr
}

// ServeRequests accepts sessions until ctx ends, handing each one (after the
// client opened its reliable stream) to accept on its own goroutine.
func (t *WebTransport) ServeRequests(ctx context.Context, accept RequestAcceptFunc) error {
	if t.TLS == nil || len(t.TLS.Certificates) == 0 {
		return errors.New("transport: WebTransport needs a TLS certificate")
	}
	path := t.Path
	if path == "" {
		path = "/wt"
	}
	check := t.CheckOrigin
	if check == nil {
		check = func(*http.Request) bool { return true }
	}
	mux := http.NewServeMux()
	h3 := &http3.Server{
		TLSConfig: http3.ConfigureTLSConfig(t.TLS.Clone()),
		Handler:   mux,
		QUICConfig: &quic.Config{
			EnableDatagrams: true,
			// Browsers keep the session alive with their own PINGs only while
			// streams are active; the zone sends 30 snapshots a second, so a
			// 30 s idle timeout only fires for a truly dead peer.
			MaxIdleTimeout:  30 * time.Second,
			KeepAlivePeriod: 10 * time.Second,
		},
	}
	webtransport.ConfigureHTTP3Server(h3)
	srv := &webtransport.Server{H3: h3, CheckOrigin: check}
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		t.active.Add(1)
		defer t.active.Done()
		sess, err := srv.Upgrade(w, r)
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		// The client opens its reliable stream immediately and writes Hello
		// on it; a session that never does is a broken or idle client.
		actx, cancel := context.WithTimeout(sess.Context(), 10*time.Second)
		str, err := sess.AcceptStream(actx)
		cancel()
		if err != nil {
			_ = sess.CloseWithError(1002, "no reliable stream")
			return
		}
		c := newWTConn(sess, str, r.RemoteAddr, false, t.ReliableQueue)
		defer func() {
			// Wait for the close (kick frame and code) to go out so Drain
			// means "everyone was told".
			c.Close(CloseNormal, "")
			select {
			case <-c.Done():
			case <-time.After(2 * time.Second):
			}
		}()
		accept(r, c)
	})

	udp, err := net.ListenPacket("udp", t.Addr)
	if err != nil {
		return fmt.Errorf("transport: WebTransport listen %s: %w", t.Addr, err)
	}
	t.mu.Lock()
	t.server = srv
	t.addr = udp.LocalAddr()
	if t.ready == nil {
		t.ready = make(chan struct{})
	}
	close(t.ready)
	t.mu.Unlock()

	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(udp) }()
	select {
	case <-ctx.Done():
		_ = srv.Close()
		_ = udp.Close()
		<-errc
		return nil
	case err := <-errc:
		_ = udp.Close()
		return err
	}
}

// DialWebTransport connects a client (tests, tools) to a zone's WebTransport
// endpoint. certHash is the base64 SHA-256 of the server certificate (what a
// browser passes as serverCertificateHashes); empty means normal verification.
// The URL may carry it as a #certHash= fragment, as zones announce it.
func DialWebTransport(ctx context.Context, rawURL, certHash string) (Conn, error) {
	u, frag := SplitCertHash(rawURL)
	if certHash == "" {
		certHash = frag
	}
	tlsConf := &tls.Config{NextProtos: []string{http3.NextProtoH3}}
	if certHash != "" {
		want, err := base64.StdEncoding.DecodeString(padB64(certHash))
		if err != nil {
			return nil, fmt.Errorf("transport: bad certHash: %w", err)
		}
		// Same rule as the browser's serverCertificateHashes: trust exactly
		// this leaf, whatever its issuer or name.
		tlsConf.InsecureSkipVerify = true
		tlsConf.VerifyConnection = func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("no server certificate")
			}
			got := sha256.Sum256(cs.PeerCertificates[0].Raw)
			if string(got[:]) != string(want) {
				return errors.New("server certificate hash mismatch")
			}
			return nil
		}
	}
	d := &webtransport.Transport{TLSClientConfig: tlsConf, QUICConfig: &quic.Config{EnableDatagrams: true, EnableStreamResetPartialDelivery: true}}
	_, sess, err := d.Dial(ctx, u, nil)
	if err != nil {
		return nil, err
	}
	str, err := sess.OpenStreamSync(ctx)
	if err != nil {
		_ = sess.CloseWithError(0, "")
		return nil, err
	}
	return newWTConn(sess, str, u, true, 0), nil
}

// SplitCertHash splits "https://host/wt#certHash=BASE64" into the URL and the
// hash. Zones with a self-signed dev certificate announce their endpoint this
// way so the hash travels through the registry and the director unchanged
// (a fragment is never sent to the server).
func SplitCertHash(rawURL string) (string, string) {
	i := strings.IndexByte(rawURL, '#')
	if i < 0 {
		return rawURL, ""
	}
	frag := rawURL[i+1:]
	for _, kv := range strings.Split(frag, "&") {
		if v, ok := strings.CutPrefix(kv, "certHash="); ok {
			return rawURL[:i], v
		}
	}
	return rawURL[:i], ""
}

func padB64(s string) string {
	if m := len(s) % 4; m != 0 {
		s += strings.Repeat("=", 4-m)
	}
	return s
}

// Overhead estimates for byte accounting, so WebTransport bandwidth is
// comparable to the WebSocket numbers (which include WS frame headers but not
// TCP/TLS/IP). A datagram is one QUIC short-header packet: 1 flags + 4
// connection id (quic-go default) + ~2 packet number + 16 AEAD tag, plus the
// DATAGRAM frame type and length (3) and the WebTransport quarter-stream id
// (1): 27 bytes. Stream frames add the 4-byte length prefix and a STREAM
// frame header (~4) and share packets, so they are counted at 8. Neither
// includes UDP/IP, matching the WebSocket figure that excludes TCP/IP.
const (
	WTDatagramOverhead = 27
	wtStreamOverhead   = 8
	// maxDatagramPayload is conservative: QUIC's minimum path MTU is 1200
	// bytes minus headers; quic-go computes the exact limit per connection
	// and SendDatagram refuses bigger frames, which we then route to the
	// stream. Keeping our own cap avoids a failed attempt every tick.
	maxDatagramPayload = 1100
)

type wtConn struct {
	sess   *webtransport.Session
	str    *webtransport.Stream
	remote string
	client bool
	stats  Stats
	k      wake // WP19b: holdable writer wake-ups (Holder)

	in        chan []byte
	readLimit atomic.Int64
	err       atomic.Value // first close error worth reporting (*webtransport.SessionError)

	mu         sync.Mutex
	reliable   [][]byte
	unreliable [][]byte // datagram-sized, at most one per message id
	big        [][]byte // unreliable but too big for a datagram: stream, latest-wins
	maxRel     int
	closing    bool
	closeCode  int
	closeMsg   string
	closed     bool
	streamPoke chan struct{}
	dgramPoke  chan struct{}
	done       chan struct{}
	closeOnce  sync.Once
}

func newWTConn(sess *webtransport.Session, str *webtransport.Stream, remote string, client bool, maxRel int) *wtConn {
	if maxRel <= 0 {
		maxRel = 1024
	}
	c := &wtConn{sess: sess, str: str, remote: remote, client: client, maxRel: maxRel,
		in: make(chan []byte, 256), streamPoke: make(chan struct{}, 1), dgramPoke: make(chan struct{}, 1), done: make(chan struct{})}
	c.readLimit.Store(64 << 10)
	go c.readStream()
	go c.readDatagrams()
	go c.streamWriter()
	go c.datagramWriter()
	go func() {
		<-sess.Context().Done()
		c.markClosed(c.sessionErr())
	}()
	return c
}

func (c *wtConn) Kind() proto.Transport { return proto.TransportWebtransport }
func (c *wtConn) RemoteAddr() string    { return c.remote }
func (c *wtConn) Stats() *Stats         { return &c.stats }
func (c *wtConn) Done() <-chan struct{} { return c.done }
func (c *wtConn) SetReadLimit(n int64)  { c.readLimit.Store(n) }

func (c *wtConn) Recv(ctx context.Context) ([]byte, error) {
	select {
	case b := <-c.in:
		return b, nil
	case <-c.done:
		// Deliver frames that arrived before the close (a Kick, typically).
		select {
		case b := <-c.in:
			return b, nil
		default:
		}
		if e, ok := c.err.Load().(error); ok && e != nil {
			return nil, e
		}
		return nil, ErrClosed
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *wtConn) push(b []byte) bool {
	select {
	case c.in <- b:
		return true
	case <-c.done:
		return false
	}
}

func (c *wtConn) readStream() {
	var hdr [4]byte
	for {
		if _, err := io.ReadFull(c.str, hdr[:]); err != nil {
			if errors.Is(err, io.EOF) {
				// The peer half-closed after its last frame (a kick): the
				// session close carrying the code follows shortly.
				select {
				case <-c.sess.Context().Done():
				case <-time.After(time.Second):
				}
			}
			c.markClosed(c.sessionErr())
			return
		}
		n := binary.LittleEndian.Uint32(hdr[:])
		if int64(n) > c.readLimit.Load() {
			c.Close(1009, "frame too large")
			return
		}
		b := make([]byte, n)
		if _, err := io.ReadFull(c.str, b); err != nil {
			c.markClosed(nil)
			return
		}
		c.stats.BytesIn.Add(int64(n) + wtStreamOverhead)
		c.stats.FramesIn.Add(1)
		if n == 0 {
			continue
		}
		if !c.push(b) {
			return
		}
	}
}

func (c *wtConn) readDatagrams() {
	for {
		b, err := c.sess.ReceiveDatagram(c.sess.Context())
		if err != nil {
			return
		}
		c.stats.BytesIn.Add(int64(len(b)) + WTDatagramOverhead)
		c.stats.FramesIn.Add(1)
		if len(b) == 0 || int64(len(b)) > c.readLimit.Load() {
			continue
		}
		// Datagrams are latest-wins by nature: if the session's inbox is
		// full (a stalled reader), drop instead of blocking QUIC.
		select {
		case c.in <- b:
		default:
			c.stats.Dropped.Add(1)
		}
	}
}

func (c *wtConn) SendReliable(b []byte) error {
	c.mu.Lock()
	if c.closing || c.closed {
		c.mu.Unlock()
		return ErrClosed
	}
	if len(c.reliable) >= c.maxRel {
		c.mu.Unlock()
		return ErrSlowConsumer
	}
	c.reliable = append(c.reliable, b)
	c.mu.Unlock()
	c.stats.ReliableQueued.Add(int64(len(b)) + wtStreamOverhead)
	c.k.poke(c.pokeAll)
	return nil
}

// pokeAll wakes both writers (a held wake-up does not remember which).
func (c *wtConn) pokeAll() {
	poke(c.streamPoke)
	poke(c.dgramPoke)
}

// Hold and Release implement Holder (WP19b).
func (c *wtConn) Hold()    { c.k.hold() }
func (c *wtConn) Release() { c.k.release(c.pokeAll) }

func (c *wtConn) SendUnreliable(b []byte) bool { return c.sendUnreliable(b, false) }

// SendUrgent implements Holder.
func (c *wtConn) SendUrgent(b []byte) bool { return c.sendUnreliable(b, true) }

func (c *wtConn) sendUnreliable(b []byte, urgent bool) bool {
	if len(b) == 0 {
		return false
	}
	c.mu.Lock()
	if c.closing || c.closed {
		c.mu.Unlock()
		return false
	}
	q, wake := &c.unreliable, c.dgramPoke
	if len(b) > maxDatagramPayload {
		q, wake = &c.big, c.streamPoke
	}
	replaced := replaceByID(*q, b)
	if !replaced {
		*q = append(*q, b)
	}
	// A newer frame of the same id supersedes one waiting in the other queue
	// too (a small snapshot after a big one), or the client would get the
	// older one last and ignore the newer as stale.
	other := &c.big
	if q == &c.big {
		other = &c.unreliable
	}
	*other = removeByID(*other, b[0])
	c.mu.Unlock()
	if !urgent && c.k.held.Load() {
		c.k.poke(c.pokeAll) // held: Release wakes both writers
	} else {
		poke(wake)
	}
	if replaced {
		c.stats.Dropped.Add(1)
	}
	return !replaced
}

func replaceByID(q [][]byte, b []byte) bool {
	for i, p := range q {
		if p[0] == b[0] {
			q[i] = b
			return true
		}
	}
	return false
}

func removeByID(q [][]byte, id byte) [][]byte {
	for i, p := range q {
		if p[0] == id {
			copy(q[i:], q[i+1:])
			q[len(q)-1] = nil
			return q[:len(q)-1]
		}
	}
	return q
}

func poke(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}

func (c *wtConn) Close(code int, reason string) {
	c.mu.Lock()
	if c.closing || c.closed {
		c.mu.Unlock()
		return
	}
	c.closing, c.closeCode, c.closeMsg = true, code, reason
	c.mu.Unlock()
	poke(c.streamPoke)
	poke(c.dgramPoke)
}

// sessionErr returns the session's close error (*webtransport.SessionError
// carrying the peer's code) once the session has ended, else nil. Accepting
// a stream on a closed session returns exactly that error.
func (c *wtConn) sessionErr() error {
	select {
	case <-c.sess.Context().Done():
	default:
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := c.sess.AcceptUniStream(ctx)
	var se *webtransport.SessionError
	if errors.As(err, &se) {
		return se
	}
	return nil
}

func (c *wtConn) markClosed(err error) {
	if err != nil {
		c.err.CompareAndSwap(nil, err)
	}
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	poke(c.streamPoke)
	poke(c.dgramPoke)
	c.closeOnce.Do(func() {
		_ = c.sess.CloseWithError(0, "")
		close(c.done)
	})
}

// streamWriter writes reliable frames, then oversized unreliable ones. When
// closing it flushes the reliable queue, half-closes the stream and gives the
// peer a moment to read it before closing the session with the code: closing
// the session at once resets the stream and could lose the final Kick.
func (c *wtConn) streamWriter() {
	for {
		c.mu.Lock()
		var b []byte
		switch {
		case c.closed:
			c.mu.Unlock()
			return
		case len(c.reliable) > 0:
			b = c.reliable[0]
			c.reliable[0] = nil
			c.reliable = c.reliable[1:]
		case len(c.big) > 0 && !c.closing:
			b = c.big[0]
			c.big = removeByID(c.big, b[0])
		case c.closing:
			code, msg := c.closeCode, c.closeMsg
			c.mu.Unlock()
			_ = c.str.Close()
			select {
			case <-c.done:
			case <-time.After(300 * time.Millisecond):
			}
			_ = c.sess.CloseWithError(webtransport.SessionErrorCode(code), msg)
			// CloseWithError only queues the close capsule; wait until it is
			// written (the session context ends) so a server shutting down
			// right after doesn't tear the QUIC connection down first.
			select {
			case <-c.sess.Context().Done():
			case <-time.After(time.Second):
			}
			c.markClosed(nil)
			return
		}
		c.mu.Unlock()
		if b == nil {
			select {
			case <-c.streamPoke:
			case <-c.done:
				return
			}
			continue
		}
		frame := make([]byte, 4+len(b))
		binary.LittleEndian.PutUint32(frame, uint32(len(b)))
		copy(frame[4:], b)
		_ = c.str.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if _, err := c.str.Write(frame); err != nil {
			c.markClosed(nil)
			return
		}
		c.stats.BytesOut.Add(int64(len(b)) + wtStreamOverhead)
		c.stats.FramesOut.Add(1)
	}
}

// datagramWriter sends latest-wins frames. SendDatagram blocks only when
// quic-go's 32-deep send queue is full (congestion), which is exactly when
// the latest-wins replacement above sheds stale snapshots.
func (c *wtConn) datagramWriter() {
	for {
		c.mu.Lock()
		if c.closed || c.closing {
			c.mu.Unlock()
			return
		}
		var b []byte
		if len(c.unreliable) > 0 {
			b = c.unreliable[0]
			c.unreliable = removeByID(c.unreliable, b[0])
		}
		c.mu.Unlock()
		if b == nil {
			select {
			case <-c.dgramPoke:
			case <-c.done:
				return
			}
			continue
		}
		if err := c.sess.SendDatagram(b); err != nil {
			var tooBig *quic.DatagramTooLargeError
			if errors.As(err, &tooBig) {
				// The path allows less than our cap: send it on the stream.
				c.mu.Lock()
				if !replaceByID(c.big, b) {
					c.big = append(c.big, b)
				}
				c.mu.Unlock()
				poke(c.streamPoke)
				continue
			}
			c.markClosed(nil)
			return
		}
		c.stats.BytesOut.Add(int64(len(b)) + WTDatagramOverhead)
		c.stats.FramesOut.Add(1)
	}
}
