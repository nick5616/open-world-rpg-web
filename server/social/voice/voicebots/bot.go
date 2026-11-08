package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/livekit/protocol/livekit"
	protoLogger "github.com/livekit/protocol/logger"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/snapshot"
	"lodestone/server/pkg/ticket"
	"lodestone/server/pkg/transport"
)

// bot is one voice soak player: a zone session (it walks, so the zone puts
// it in earshot sets), a social session (it asks for a voice token, the real
// path), and a LiveKit participant that publishes a microphone track of
// synthetic Opus speech and records every subscription LiveKit gives it.
type bot struct {
	id       int
	charID   string
	name     string
	cfg      *config
	rec      *recorder
	angle    float64 // radial direction from the cluster centre
	r0       float64 // starting radius
	pos      movement.State
	yaw      float64
	seq      uint32
	last     proto.InputFrame
	dec      snapshot.Decoder
	mu       sync.Mutex
	walk     int // -1 inward, 0 stand, +1 outward
	track    *lksdk.LocalTrack
	room     *lksdk.Room
	readyAt  float64 // ms: LiveKit connected and track published
	errs     []string
	zoneConn transport.Conn
	leaving  atomic.Bool
}

func newBot(i int, cfg *config, rec *recorder, rng *rand.Rand) *bot {
	b := &bot{id: i, cfg: cfg, rec: rec, charID: uuidish(rng), name: fmt.Sprintf("vbot-%02d", i)}
	b.angle = 2*math.Pi*float64(i)/float64(cfg.bots) + (rng.Float64()-0.5)*0.2
	b.r0 = 2 + cfg.clusterR*math.Sqrt(rng.Float64())
	b.pos.Pos = movement.Vec3{X: cfg.cx + b.r0*math.Sin(b.angle), Z: cfg.cz + b.r0*math.Cos(b.angle)}
	return b
}

func uuidish(rng *rand.Rand) string {
	var b [16]byte
	rng.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func nowMs() float64 { return float64(time.Now().UnixMicro()) / 1000 }

func (b *bot) fail(format string, a ...any) {
	b.mu.Lock()
	b.errs = append(b.errs, fmt.Sprintf(format, a...))
	b.mu.Unlock()
}

// joinZone connects to the zone and keeps sending input until ctx ends.
func (b *bot) joinZone(ctx context.Context) error {
	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	c, err := transport.DialWebSocket(dctx, fmt.Sprintf("%s?spawn=%.2f,%.2f", b.cfg.zoneURL, b.pos.Pos.X, b.pos.Pos.Z))
	if err != nil {
		return err
	}
	b.zoneConn = c
	tk := ticket.Sign(b.cfg.priv, ticket.Claims{AccountID: b.charID, CharacterID: b.charID, CharacterName: b.name,
		WorldID: b.cfg.worldID, Audience: ticket.AudienceZone(b.cfg.zoneID)})
	if err := c.SendReliable(proto.Encode(&proto.Hello{ProtocolVersion: proto.ProtocolVersion, Ticket: []byte(tk), ClientTime: nowMs(), Transport: proto.TransportWebsocket})); err != nil {
		return err
	}
	welcomed := make(chan error, 1)
	go func() {
		first := true
		for {
			raw, err := c.Recv(context.Background())
			if err != nil {
				if first {
					welcomed <- err
				}
				return
			}
			m, err := proto.DecodeMessage(raw)
			if err != nil {
				continue
			}
			switch msg := m.(type) {
			case *proto.Welcome:
				b.mu.Lock()
				b.pos.Pos = movement.Vec3{X: proto.CmToMeters(msg.X), Y: 0, Z: proto.CmToMeters(msg.Z)}
				b.mu.Unlock()
				if first {
					first = false
					welcomed <- nil
				}
			case *proto.Kick:
				if first {
					first = false
					welcomed <- fmt.Errorf("kicked %d %s", msg.Code, msg.Reason)
				}
				return
			case *proto.Snapshot:
				b.mu.Lock()
				_, _ = b.dec.Apply(msg)
				b.mu.Unlock()
			}
		}
	}()
	select {
	case err := <-welcomed:
		if err != nil {
			return err
		}
	case <-time.After(10 * time.Second):
		return fmt.Errorf("no welcome")
	}
	go b.inputLoop(ctx)
	return nil
}

// inputLoop sends 30 packets/s of two 60 Hz frames (plus one repeat), like
// the client, steering by the current walk direction. The bot simulates its
// own movement with the same Go step the zone runs (flat ground), so its
// logged position is exactly the zone's.
func (b *bot) inputLoop(ctx context.Context) {
	t := time.NewTicker(time.Second / constants.InputSendHz)
	defer t.Stop()
	posT := time.NewTicker(100 * time.Millisecond)
	defer posT.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = b.zoneConn.SendReliable(proto.Encode(&proto.Bye{}))
			b.zoneConn.Close(transport.CloseNormal, "")
			return
		case <-posT.C:
			b.mu.Lock()
			x, z := b.pos.Pos.X, b.pos.Pos.Z
			b.mu.Unlock()
			b.rec.logPos(b.charID, x, z)
		case <-t.C:
			b.mu.Lock()
			frames := make([]proto.InputFrame, 0, 3)
			if b.seq > 0 {
				frames = append(frames, b.last)
			}
			var flags uint16
			dx, dz := b.pos.Pos.X-b.cfg.cx, b.pos.Pos.Z-b.cfg.cz
			r := math.Hypot(dx, dz)
			switch b.walk {
			case 1:
				flags = proto.InputFlagForward
				b.yaw = math.Atan2(-math.Sin(b.angle), -math.Cos(b.angle)) // forward = (-sin yaw, -cos yaw)
			case -1:
				if r > b.r0 {
					flags = proto.InputFlagForward
					b.yaw = math.Atan2(math.Sin(b.angle), math.Cos(b.angle))
				}
			}
			if b.cfg.speakFlag {
				flags |= proto.InputFlagSpeaking
			}
			for k := 0; k < constants.MoveStepHz/constants.InputSendHz; k++ {
				b.seq++
				f := proto.InputFrame{Seq: b.seq, Flags: flags, Yaw: proto.YawToU16(b.yaw)}
				b.pos = movement.StepFrame(b.pos, f, movement.Flat{})
				frames = append(frames, f)
				b.last = f
			}
			ack := b.dec.Latest()
			b.mu.Unlock()
			_ = b.zoneConn.SendUnreliable(proto.Encode(&proto.Input{AckTick: ack, Frames: frames}))
		}
	}
}

func (b *bot) setWalk(w int) {
	b.mu.Lock()
	b.walk = w
	b.mu.Unlock()
}

// voiceToken asks the social service for a LiveKit token (and keeps the
// social socket open, like a real client).
func (b *bot) voiceToken(ctx context.Context) (url, token string, err error) {
	dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(dctx, b.cfg.socialURL, nil)
	if err != nil {
		return "", "", err
	}
	tk := ticket.Sign(b.cfg.priv, ticket.Claims{AccountID: b.charID, CharacterID: b.charID, CharacterName: b.name,
		WorldID: b.cfg.worldID, Audience: ticket.AudienceSocial})
	send := func(v any) error {
		raw, _ := json.Marshal(v)
		return c.Write(dctx, websocket.MessageText, raw)
	}
	if err := send(map[string]any{"type": "auth", "ticket": tk}); err != nil {
		return "", "", err
	}
	asked := false
	for {
		_, raw, err := c.Read(dctx)
		if err != nil {
			return "", "", err
		}
		var m struct {
			Type    string `json:"type"`
			URL     string `json:"url"`
			Token   string `json:"token"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &m)
		switch m.Type {
		case "welcome":
			if !asked {
				asked = true
				if err := send(map[string]any{"type": "voice_token"}); err != nil {
					return "", "", err
				}
			}
		case "error":
			return "", "", fmt.Errorf("social: %s", m.Message)
		case "voice_token":
			go func() { // keep the session (presence) alive and drained
				for {
					if _, _, err := c.Read(ctx); err != nil {
						return
					}
				}
			}()
			go func() { <-ctx.Done(); c.Close(websocket.StatusNormalClosure, "") }()
			return m.URL, m.Token, nil
		}
	}
}

// joinVoice connects to LiveKit with auto-subscribe off and publishes the
// microphone track. Subscriptions arrive only when the server decides.
func (b *bot) joinVoice(url, token string) error {
	cb := lksdk.NewRoomCallback()
	cb.ParticipantCallback.OnTrackSubscribed = func(t *webrtc.TrackRemote, _ *lksdk.RemoteTrackPublication, rp *lksdk.RemoteParticipant) {
		who := rp.Identity()
		b.rec.sub(b.charID, who, true)
		// The Go SDK fires OnTrackUnsubscribed only when the speaker
		// unpublishes, not when the server unsubscribes us. A server-side
		// unsubscribe renegotiates the transceiver away, which ends the
		// remote track: ReadRTP returns an error at that moment, which is
		// exactly "this listener stopped receiving that speaker". Reading
		// also proves audio flows (packets are counted).
		//
		// LiveKit stops forwarding at once on unsubscribe but keeps the
		// transceiver until its 1 s flush ends (sfu/downtrack.go flushTimeout),
		// so the track itself ends ~1 s after the listener stopped hearing.
		go func() {
			// Speakers send a packet every 20 ms without pause, so "the next
			// packet never came" is when forwarding stopped: last arrival +
			// 20 ms. Blank frames (f8 ff fe), should LiveKit send any during
			// the flush, do not count as hearing someone.
			lastReal := 0.0
			for {
				p, _, err := t.ReadRTP()
				if err != nil {
					if !b.leaving.Load() {
						if lastReal > 0 {
							b.rec.add(event{T: lastReal + 20, Kind: "mstop", L: b.charID, S: who})
						}
						b.rec.sub(b.charID, who, false)
					}
					return
				}
				b.rec.packets.Add(1)
				if pl := p.Payload; !(len(pl) == 3 && pl[0] == 0xf8 && pl[1] == 0xff && pl[2] == 0xfe) {
					lastReal = nowMs()
				}
			}
		}()
	}
	cb.OnDisconnected = func() {
		if !b.leaving.Load() {
			b.fail("livekit disconnected")
		}
	}
	var lg protoLogger.Logger = protoLogger.GetDiscardLogger()
	if b.id == b.cfg.traceBot {
		// -trace-bot N: the SDK's debug log for one bot (SDP offers and
		// answers with timestamps), to see where subscription time goes.
		if zl, err := protoLogger.NewZapLogger(&protoLogger.Config{Level: "debug"}); err == nil {
			lg = zl
		}
	}
	room, err := lksdk.ConnectToRoomWithToken(url, token, cb, lksdk.WithAutoSubscribe(false), lksdk.WithLogger(lg))
	if err != nil {
		return err
	}
	b.room = room
	track, err := lksdk.NewLocalSampleTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2})
	if err != nil {
		return err
	}
	if _, err := room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "microphone", Source: livekit.TrackSource_MICROPHONE}); err != nil {
		return err
	}
	b.mu.Lock()
	b.track = track
	b.readyAt = nowMs()
	b.mu.Unlock()
	b.rec.markReady(b.charID, b.readyAt)
	return nil
}

// writeSample sends the next 20 ms Opus packet (called by the shared pacer).
func (b *bot) writeSample(pkt []byte) {
	b.mu.Lock()
	t := b.track
	b.mu.Unlock()
	if t != nil {
		_ = t.WriteSample(media.Sample{Data: pkt, Duration: 20 * time.Millisecond}, nil)
	}
}

func (b *bot) leave() {
	b.leaving.Store(true)
	if b.room != nil {
		b.room.Disconnect()
	}
}
