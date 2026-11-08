// Package client is a small Go client for the social socket, used by the
// integration tests and the flood tool (cmd/flood). It records every frame
// it receives so tests can wait for one that matches.
package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/coder/websocket"

	sp "lodestone/server/pkg/socialproto"
)

// Frame is one received s2c message: its type and raw JSON.
type Frame struct {
	Type string
	Raw  json.RawMessage
	At   time.Time
}

// Decode unmarshals the frame into v.
func (f Frame) Decode(v any) error { return json.Unmarshal(f.Raw, v) }

// Client is one connected socket.
type Client struct {
	c  *websocket.Conn
	mu sync.Mutex
	// all frames, in arrival order
	frames []Frame
	notify chan struct{}
	closed chan struct{}
	err    error
}

// Dial connects and sends auth. It does not wait for welcome.
func Dial(ctx context.Context, url, ticket string) (*Client, error) {
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return nil, err
	}
	c.SetReadLimit(1 << 20)
	cl := &Client{c: c, notify: make(chan struct{}, 1), closed: make(chan struct{})}
	go cl.read()
	if err := cl.Send(ctx, sp.C2SAuth{Type: sp.C2STypeAuth, Ticket: ticket}); err != nil {
		_ = c.CloseNow()
		return nil, err
	}
	return cl, nil
}

// Connect dials and waits for welcome (or an error frame).
func Connect(ctx context.Context, url, ticket string) (*Client, sp.S2CWelcome, error) {
	cl, err := Dial(ctx, url, ticket)
	if err != nil {
		return nil, sp.S2CWelcome{}, err
	}
	f, err := cl.WaitFor(ctx, func(f Frame) bool { return f.Type == sp.S2CTypeWelcome || f.Type == sp.S2CTypeError })
	if err != nil {
		cl.Close()
		return nil, sp.S2CWelcome{}, err
	}
	if f.Type == sp.S2CTypeError {
		var e sp.S2CError
		_ = f.Decode(&e)
		cl.Close()
		return nil, sp.S2CWelcome{}, fmt.Errorf("refused: %s: %s", e.Code, e.Message)
	}
	var w sp.S2CWelcome
	_ = f.Decode(&w)
	return cl, w, nil
}

func (cl *Client) read() {
	defer close(cl.closed)
	for {
		_, b, err := cl.c.Read(context.Background())
		if err != nil {
			cl.mu.Lock()
			cl.err = err
			cl.mu.Unlock()
			cl.wake()
			return
		}
		var head struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(b, &head)
		cl.mu.Lock()
		cl.frames = append(cl.frames, Frame{Type: head.Type, Raw: b, At: time.Now()})
		cl.mu.Unlock()
		cl.wake()
	}
}

func (cl *Client) wake() {
	select {
	case cl.notify <- struct{}{}:
	default:
	}
}

// Send writes one c2s message.
func (cl *Client) Send(ctx context.Context, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return cl.c.Write(ctx, websocket.MessageText, b)
}

// Frames returns a copy of everything received so far.
func (cl *Client) Frames() []Frame {
	cl.mu.Lock()
	defer cl.mu.Unlock()
	return append([]Frame(nil), cl.frames...)
}

// Count returns how many received frames match.
func (cl *Client) Count(match func(Frame) bool) int {
	n := 0
	for _, f := range cl.Frames() {
		if match(f) {
			n++
		}
	}
	return n
}

// ErrClosed is returned by WaitFor when the socket closed first.
var ErrClosed = errors.New("socket closed")

// WaitFor blocks until a frame matching match has been received (including
// ones received before the call) and returns the first such frame.
func (cl *Client) WaitFor(ctx context.Context, match func(Frame) bool) (Frame, error) {
	return cl.WaitNew(ctx, 0, match)
}

// WaitNew is WaitFor over frames received at or after index from (see Len).
func (cl *Client) WaitNew(ctx context.Context, from int, match func(Frame) bool) (Frame, error) {
	for {
		cl.mu.Lock()
		for i := from; i < len(cl.frames); i++ {
			if match(cl.frames[i]) {
				f := cl.frames[i]
				cl.mu.Unlock()
				return f, nil
			}
		}
		err := cl.err
		cl.mu.Unlock()
		if err != nil {
			return Frame{}, fmt.Errorf("%w: %v", ErrClosed, err)
		}
		select {
		case <-ctx.Done():
			return Frame{}, ctx.Err()
		case <-cl.notify:
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// Len is the number of frames received so far (a cursor for WaitNew).
func (cl *Client) Len() int {
	cl.mu.Lock()
	defer cl.mu.Unlock()
	return len(cl.frames)
}

// Closed is closed when the socket is gone.
func (cl *Client) Closed() <-chan struct{} { return cl.closed }

// Close closes the socket.
func (cl *Client) Close() { _ = cl.c.Close(websocket.StatusNormalClosure, "") }

// CloseNow drops the socket without a close handshake (a crash, from the
// server's point of view the same as a dead network).
func (cl *Client) CloseNow() { _ = cl.c.CloseNow() }

// Chat matches a chat frame on channel whose text equals text.
func Chat(ch sp.Channel, text string) func(Frame) bool {
	return func(f Frame) bool {
		if f.Type != sp.S2CTypeChat {
			return false
		}
		var m sp.S2CChat
		return f.Decode(&m) == nil && m.Message.Channel == ch && m.Message.Text == text
	}
}

// Type matches any frame of a type.
func Type(t string) func(Frame) bool { return func(f Frame) bool { return f.Type == t } }

// Error matches an error frame with code.
func Error(code sp.ErrorCode) func(Frame) bool {
	return func(f Frame) bool {
		if f.Type != sp.S2CTypeError {
			return false
		}
		var e sp.S2CError
		return f.Decode(&e) == nil && e.Code == code
	}
}

// WhisperStatus matches a whisper_status frame.
func WhisperStatus(to string, st sp.WhisperStatus) func(Frame) bool {
	return func(f Frame) bool {
		if f.Type != sp.S2CTypeWhisperStatus {
			return false
		}
		var w sp.S2CWhisperStatus
		return f.Decode(&w) == nil && w.Status == st && (to == "" || w.To == to)
	}
}
