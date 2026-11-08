package transport

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"errors"
	"math/big"
	"net"
	"time"
)

// DevCertMaxValidity is the longest validity a browser accepts for a
// certificate pinned with serverCertificateHashes (W3C WebTransport: "the
// certificate's validity period ... MUST be at most two weeks").
const DevCertMaxValidity = 14 * 24 * time.Hour

// DevCert is a self-signed certificate for local WebTransport plus the hash a
// browser pins it by.
type DevCert struct {
	TLS *tls.Config
	// Hash is the SHA-256 of the DER certificate, standard base64 with
	// padding (what the client turns into serverCertificateHashes).
	Hash      string
	NotBefore time.Time
	NotAfter  time.Time
}

// NewDevCert generates a fresh ECDSA P-256 certificate valid for validity
// (capped at 13 days so clock skew can't push it past the 14-day browser
// limit). Chromium requires ECDSA for serverCertificateHashes; RSA certs are
// refused. A new key per zone start means nothing secret ever sits on disk;
// the hash changes on restart, which is fine because zones re-announce the
// endpoint (with its hash) every heartbeat.
func NewDevCert(validity time.Duration, hosts ...string) (*DevCert, error) {
	if validity <= 0 || validity > 13*24*time.Hour {
		validity = 10 * 24 * time.Hour
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 62))
	if err != nil {
		return nil, err
	}
	// Backdate one hour against small clock differences between the zone
	// and the browser; the total stays under the limit.
	now := time.Now()
	tmpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "lodestone-zone-dev"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(validity),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	if len(hosts) == 0 {
		hosts = []string{"localhost", "127.0.0.1", "::1"}
	}
	for _, h := range hosts {
		if ip := net.ParseIP(h); ip != nil {
			tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
		} else {
			tmpl.DNSNames = append(tmpl.DNSNames, h)
		}
	}
	if tmpl.NotAfter.Sub(tmpl.NotBefore) > DevCertMaxValidity {
		return nil, errors.New("transport: dev cert validity over 14 days")
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(der)
	return &DevCert{
		TLS:       &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}}},
		Hash:      base64.StdEncoding.EncodeToString(sum[:]),
		NotBefore: tmpl.NotBefore,
		NotAfter:  tmpl.NotAfter,
	}, nil
}

// WithCertHash appends the #certHash= fragment to a WebTransport URL (see
// SplitCertHash).
func WithCertHash(url, hash string) string {
	if hash == "" {
		return url
	}
	return url + "#certHash=" + hash
}
