package transport

import (
	"context"

	"lodestone/server/pkg/proto"
)

// WebTransport is the preferred transport (spec 9: WebTransport over HTTP/3,
// quic-go/webtransport-go). Stubbed in WP03; WP06 implements it behind this
// same shape so session code does not change:
//
//   - one session per client at Path on a UDP listener at Addr (TLS cert
//     required, even in dev: browsers accept a self-signed cert only via
//     serverCertificateHashes, which needs a <= 14 day ECDSA cert);
//   - SendUnreliable -> datagram (fall back to the reliable stream when a
//     frame exceeds the path MTU, roughly 1200 bytes; large full snapshots do);
//   - SendReliable   -> one long-lived bidirectional stream, length-prefixed
//     frames (streams have no message boundaries, unlike WebSocket);
//   - per-chunk WorldEdits -> one unidirectional stream per chunk.
//
// Its Conn must report Kind() == proto.TransportWebtransport so the client's
// Hello.transport and the debug HUD agree.
type WebTransport struct {
	Addr     string
	Path     string
	CertFile string
	KeyFile  string
}

// Kind identifies the transport.
func (*WebTransport) Kind() proto.Transport { return proto.TransportWebtransport }

// Serve would accept sessions until ctx ends. Not implemented yet.
func (*WebTransport) Serve(_ context.Context, _ AcceptFunc) error { return ErrNotImplemented }
