package upstream

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"time"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/proxy"
)

// Claude accounts may opt in to presenting Claude Code's TLS handshake instead of Go's, as sub2api
// does. The ClientHello below reproduces Node.js 24.x, the runtime Claude Code ships on; its
// parameters come from sub2api's published capture (JA3 44f88fca027f27bab4bb08d4af15f23e, JA4
// t13d1714h1_5b57614c22b0_7baf387fc6ff). Node offers only http/1.1 over ALPN, so these connections
// use HTTP/1.1 like the real client.
func claudeCodeHello() *utls.ClientHelloSpec {
	curves := []utls.CurveID{utls.X25519, utls.CurveP256, utls.CurveP384}
	signatures := []utls.SignatureScheme{0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601, 0x0201}
	return &utls.ClientHelloSpec{
		CipherSuites: []uint16{
			0x1301, 0x1302, 0x1303, // TLS 1.3 AES-GCM and ChaCha20
			0xc02b, 0xc02f, 0xc02c, 0xc030, // ECDHE AES-GCM
			0xcca9, 0xcca8, // ECDHE ChaCha20-Poly1305
			0xc009, 0xc013, 0xc00a, 0xc014, // ECDHE AES-CBC
			0x009c, 0x009d, 0x002f, 0x0035, // RSA AES-GCM and AES-CBC
		},
		CompressionMethods: []uint8{0},
		TLSVersMin:         utls.VersionTLS10,
		TLSVersMax:         utls.VersionTLS13,
		// Node's extension order matters for the fingerprint.
		Extensions: []utls.TLSExtension{
			&utls.SNIExtension{},
			&utls.GREASEEncryptedClientHelloExtension{},
			&utls.ExtendedMasterSecretExtension{},
			&utls.RenegotiationInfoExtension{},
			&utls.SupportedCurvesExtension{Curves: curves},
			&utls.SupportedPointsExtension{SupportedPoints: []uint8{0}},
			&utls.SessionTicketExtension{},
			&utls.ALPNExtension{AlpnProtocols: []string{"http/1.1"}},
			&utls.StatusRequestExtension{},
			&utls.SignatureAlgorithmsExtension{SupportedSignatureAlgorithms: signatures},
			&utls.SCTExtension{},
			&utls.KeyShareExtension{KeyShares: []utls.KeyShare{{Group: utls.X25519}}},
			&utls.PSKKeyExchangeModesExtension{Modes: []uint8{utls.PskModeDHE}},
			&utls.SupportedVersionsExtension{Versions: []uint16{utls.VersionTLS13, utls.VersionTLS12}},
		},
	}
}

var fingerprintDialer = &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}

// dialFingerprinted opens addr directly or through the account's proxy, then performs the TLS
// handshake itself. http.Transport cannot apply a custom handshake inside its own proxy tunnel, so
// the tunnel (HTTP CONNECT or SOCKS5) is established here too.
func dialFingerprinted(ctx context.Context, exit *url.URL, addr string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	conn, err := tunnel(ctx, exit, addr)
	if err != nil {
		return nil, err
	}
	client := utls.UClient(conn, &utls.Config{ServerName: host, NextProtos: []string{"http/1.1"}}, utls.HelloCustom)
	if err := client.ApplyPreset(claudeCodeHello()); err != nil {
		conn.Close()
		return nil, err
	}
	if err := client.HandshakeContext(ctx); err != nil {
		conn.Close()
		return nil, err
	}
	return client, nil
}

func tunnel(ctx context.Context, exit *url.URL, addr string) (net.Conn, error) {
	if exit == nil {
		return fingerprintDialer.DialContext(ctx, "tcp", addr)
	}
	switch exit.Scheme {
	case "socks5":
		var auth *proxy.Auth
		if exit.User != nil {
			password, _ := exit.User.Password()
			auth = &proxy.Auth{User: exit.User.Username(), Password: password}
		}
		socks, err := proxy.SOCKS5("tcp", exit.Host, auth, fingerprintDialer)
		if err != nil {
			return nil, err
		}
		contextual, ok := socks.(proxy.ContextDialer)
		if !ok {
			return nil, errors.New("socks5 dialer lacks context support")
		}
		return contextual.DialContext(ctx, "tcp", addr)
	case "http", "https":
		conn, err := fingerprintDialer.DialContext(ctx, "tcp", exit.Host)
		if err != nil {
			return nil, err
		}
		if exit.Scheme == "https" {
			secured := tls.Client(conn, &tls.Config{ServerName: exit.Hostname()})
			if err := secured.HandshakeContext(ctx); err != nil {
				conn.Close()
				return nil, err
			}
			conn = secured
		}
		if deadline, ok := ctx.Deadline(); ok {
			_ = conn.SetDeadline(deadline)
		}
		request := &http.Request{Method: http.MethodConnect, URL: &url.URL{Opaque: addr}, Host: addr, Header: make(http.Header)}
		if exit.User != nil {
			password, _ := exit.User.Password()
			request.Header.Set("Proxy-Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(exit.User.Username()+":"+password)))
		}
		if err := request.Write(conn); err != nil {
			conn.Close()
			return nil, err
		}
		// The proxy sends nothing after its CONNECT response until the client speaks first.
		response, err := http.ReadResponse(bufio.NewReader(conn), request)
		if err != nil {
			conn.Close()
			return nil, err
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			conn.Close()
			return nil, fmt.Errorf("proxy CONNECT: %s", response.Status)
		}
		_ = conn.SetDeadline(time.Time{})
		return conn, nil
	}
	return nil, ErrUpstream
}

// fingerprintTransport clones base so each fingerprinted route keeps its own HTTP/1.1 pool.
func fingerprintTransport(base *http.Transport, exit *url.URL) *http.Transport {
	transport := base.Clone()
	transport.Proxy = nil
	transport.ForceAttemptHTTP2 = false
	transport.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
	transport.DialTLSContext = func(ctx context.Context, _, addr string) (net.Conn, error) {
		return dialFingerprinted(ctx, exit, addr)
	}
	return transport
}
