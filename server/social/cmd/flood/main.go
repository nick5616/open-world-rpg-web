// Command flood hammers the social service with chat from many clients and
// checks the rate limits hold (WP08 acceptance: "rate limits hold under a
// bot flood"). Each flooder sends as fast as -rate allows on every channel;
// an observer counts what actually reached other players.
//
//	go run ./server/social/cmd/flood -clients 50 -duration 20s -rate 40
//
// Tickets are signed with LODESTONE_TICKET_PRIVATE_KEY (the dev key when
// unset, matching a dev social service). Accepted = messages the server
// echoed back to their sender; rejected = sent - accepted. The bound per
// client per channel is burst + refill x duration from DefaultLimits; the run
// PASSes when no client beats it and the observer saw nothing extra.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"lodestone/server/pkg/accountapi"
	sp "lodestone/server/pkg/socialproto"
	"lodestone/server/pkg/ticket"
	"lodestone/server/social/internal/client"
	"lodestone/server/social/internal/social"
)

type chanStats struct {
	Sent, Accepted int64
}

type result struct {
	Clients      int                         `json:"clients"`
	DurationS    float64                     `json:"durationS"`
	RatePerS     float64                     `json:"ratePerClientPerS"`
	PerChannel   map[sp.Channel]*chanStats   `json:"perChannel"`
	BoundPerCli  map[sp.Channel]float64      `json:"boundPerClient"`
	MaxPerCli    map[sp.Channel]int64        `json:"maxAcceptedByOneClient"`
	ErrorsByCode map[string]int64            `json:"errorFramesByCode"`
	Observer     map[sp.Channel]int64        `json:"observerReceived"`
	Violations   []string                    `json:"violations"`
	Pass         bool                        `json:"pass"`
	ConnectFails int64                       `json:"connectFailures"`
	perClient    []map[sp.Channel]*chanStats `json:"-"`
}

func main() {
	url := flag.String("url", "ws://localhost:8093/ws", "social /ws endpoint")
	world := flag.String("world", "", "world id (default: a fresh random world, so the flood never touches real chat)")
	n := flag.Int("clients", 50, "flooding clients")
	dur := flag.Duration("duration", 20*time.Second, "flood length")
	rate := flag.Float64("rate", 40, "messages per second per client, spread over channels")
	chans := flag.String("channels", "global,zone,local,party,whisper", "channels to flood")
	out := flag.String("json", "", "write the result JSON here")
	flag.Parse()

	if *world == "" {
		*world = accountapi.NewUUID()
	}
	priv, _, err := ticket.PrivateKeyFromEnv()
	if err != nil {
		fail(err)
	}
	var channels []sp.Channel
	for _, c := range strings.Split(*chans, ",") {
		channels = append(channels, sp.Channel(strings.TrimSpace(c)))
	}
	mk := func(name string) (string, string) {
		id := accountapi.NewUUID()
		return id, ticket.Sign(priv, ticket.Claims{AccountID: accountapi.NewUUID(), CharacterID: id, CharacterName: name,
			WorldID: *world, Audience: ticket.AudienceSocial, ExpiresAt: time.Now().Add(10 * time.Minute)})
	}
	ctx := context.Background()

	// The observer stands among the flooders and is everyone's whisper target.
	_, obsTicket := mk("Observer")
	obs, _, err := client.Connect(ctx, *url, obsTicket)
	if err != nil {
		fail(fmt.Errorf("observer: %w", err))
	}
	defer obs.Close()
	_ = obs.Send(ctx, sp.C2SPresence{Type: sp.C2STypePresence, Region: "2,2", X: 2048, Z: 2048, ZoneID: "flood-zone"})

	res := &result{Clients: *n, DurationS: dur.Seconds(), RatePerS: *rate, PerChannel: map[sp.Channel]*chanStats{},
		BoundPerCli: map[sp.Channel]float64{}, MaxPerCli: map[sp.Channel]int64{}, ErrorsByCode: map[string]int64{}, Observer: map[sp.Channel]int64{}}
	for _, c := range channels {
		res.PerChannel[c] = &chanStats{}
	}
	lim := social.DefaultLimits()
	for _, c := range channels {
		burst, perS := 0.0, 0.0
		switch c {
		case sp.ChannelGlobal:
			burst, perS = 1, 1/lim.GlobalSlowMode.Seconds()
		case sp.ChannelZone:
			burst, perS = lim.ZoneBurst, lim.ZonePerS
		case sp.ChannelLocal:
			burst, perS = lim.LocalBurst, lim.LocalPerS
		case sp.ChannelParty:
			burst, perS = lim.PartyBurst, lim.PartyPerS
		case sp.ChannelWhisper:
			burst, perS = lim.WhisperBurst, lim.WhisperPerS
		}
		res.BoundPerCli[c] = burst + perS*dur.Seconds()
	}

	// Flooders: connect all first, form parties of 4, then flood together.
	type flooder struct {
		cl   *client.Client
		id   string
		name string
	}
	fl := make([]*flooder, *n)
	var wg sync.WaitGroup
	var connectFails atomic.Int64
	for i := range fl {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			name := fmt.Sprintf("flood%03d", i)
			id, tk := mk(name)
			cl, _, err := client.Connect(ctx, *url, tk)
			if err != nil {
				connectFails.Add(1)
				return
			}
			// Everyone within 30 m of the observer so local chat reaches it.
			_ = cl.Send(ctx, sp.C2SPresence{Type: sp.C2STypePresence, Region: "2,2", X: 2048 + float64(i%10), Z: 2048 + float64(i/10%10), ZoneID: "flood-zone"})
			fl[i] = &flooder{cl: cl, id: id, name: name}
		}(i)
	}
	wg.Wait()
	res.ConnectFails = connectFails.Load()
	for i := 0; i+1 < len(fl); i += 4 {
		lead := fl[i]
		if lead == nil {
			continue
		}
		for j := i + 1; j < i+4 && j < len(fl); j++ {
			if fl[j] == nil {
				continue
			}
			_ = lead.cl.Send(ctx, sp.C2SPartyInvite{Type: sp.C2STypePartyInvite, Name: fl[j].name})
			wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			if f, err := fl[j].cl.WaitFor(wctx, client.Type(sp.S2CTypePartyInvite)); err == nil {
				var inv sp.S2CPartyInvite
				_ = f.Decode(&inv)
				_ = fl[j].cl.Send(ctx, sp.C2SPartyRespond{Type: sp.C2STypePartyRespond, PartyID: inv.PartyID, Accept: true})
			}
			cancel()
		}
	}
	time.Sleep(time.Second)
	// The party setup spent social tokens, not chat tokens; start counting now.
	obsStart := obs.Len()
	starts := make([]int, len(fl))
	for i, f := range fl {
		if f != nil {
			starts[i] = f.cl.Len()
		}
	}

	res.perClient = make([]map[sp.Channel]*chanStats, len(fl))
	fmt.Printf("flooding: %d clients x %.0f msg/s for %s on %v (world %s)\n", *n-int(res.ConnectFails), *rate, *dur, channels, *world)
	t0 := time.Now()
	for i, f := range fl {
		if f == nil {
			continue
		}
		stats := map[sp.Channel]*chanStats{}
		for _, c := range channels {
			stats[c] = &chanStats{}
		}
		res.perClient[i] = stats
		wg.Add(1)
		go func(f *flooder, stats map[sp.Channel]*chanStats) {
			defer wg.Done()
			tick := time.NewTicker(time.Duration(float64(time.Second) / *rate))
			defer tick.Stop()
			k := 0
			for time.Since(t0) < *dur {
				<-tick.C
				c := channels[k%len(channels)]
				text := fmt.Sprintf("%s#%d", f.name, k)
				k++
				var err error
				if c == sp.ChannelWhisper {
					err = f.cl.Send(ctx, sp.C2SWhisper{Type: sp.C2STypeWhisper, To: "Observer", Text: text})
				} else {
					err = f.cl.Send(ctx, sp.C2SChatSend{Type: sp.C2STypeChatSend, Channel: c, Text: text})
				}
				if err != nil {
					return
				}
				stats[c].Sent++
			}
		}(f, stats)
	}
	wg.Wait()
	elapsed := time.Since(t0)
	time.Sleep(2 * time.Second) // let the last deliveries land

	for i, f := range fl {
		if f == nil {
			continue
		}
		for _, fr := range f.cl.Frames()[starts[i]:] {
			switch fr.Type {
			case sp.S2CTypeChat:
				var m sp.S2CChat
				if fr.Decode(&m) == nil && m.Message.FromID == f.id {
					if s := res.perClient[i][m.Message.Channel]; s != nil {
						s.Accepted++
					}
				}
			case sp.S2CTypeError:
				var e sp.S2CError
				_ = fr.Decode(&e)
				res.ErrorsByCode[string(e.Code)]++
			}
		}
		for c, s := range res.perClient[i] {
			res.PerChannel[c].Sent += s.Sent
			res.PerChannel[c].Accepted += s.Accepted
			if s.Accepted > res.MaxPerCli[c] {
				res.MaxPerCli[c] = s.Accepted
			}
			// +1: the flood starts mid-refill and ends with a token in flight.
			if float64(s.Accepted) > res.BoundPerCli[c]+1 {
				res.Violations = append(res.Violations, fmt.Sprintf("%s %s accepted %d > bound %.1f", f.name, c, s.Accepted, res.BoundPerCli[c]))
			}
		}
		f.cl.Close()
	}
	for _, fr := range obs.Frames()[obsStart:] {
		var m sp.S2CChat
		if fr.Type == sp.S2CTypeChat && fr.Decode(&m) == nil && strings.HasPrefix(m.Message.FromName, "flood") {
			res.Observer[m.Message.Channel]++
		}
	}
	// The observer hears every accepted global, zone, local and whisper line
	// (party chat stays in the parties). More than accepted = a leak.
	for _, c := range channels {
		if c == sp.ChannelParty {
			continue
		}
		if res.Observer[c] > res.PerChannel[c].Accepted {
			res.Violations = append(res.Violations, fmt.Sprintf("observer saw %d %s lines but only %d were accepted", res.Observer[c], c, res.PerChannel[c].Accepted))
		}
	}
	res.Pass = len(res.Violations) == 0 && res.ConnectFails == 0

	fmt.Printf("elapsed %.1fs, connect failures %d\n", elapsed.Seconds(), res.ConnectFails)
	fmt.Printf("%-8s %9s %9s %9s %8s %14s %10s\n", "channel", "sent", "accepted", "rejected", "accept%", "bound/client", "max/client")
	sorted := append([]sp.Channel(nil), channels...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	for _, c := range sorted {
		s := res.PerChannel[c]
		pct := 0.0
		if s.Sent > 0 {
			pct = 100 * float64(s.Accepted) / float64(s.Sent)
		}
		fmt.Printf("%-8s %9d %9d %9d %7.1f%% %14.1f %10d\n", c, s.Sent, s.Accepted, s.Sent-s.Accepted, pct, res.BoundPerCli[c], res.MaxPerCli[c])
	}
	fmt.Printf("observer received: %v\n", res.Observer)
	fmt.Printf("error frames (throttled to 1/s per client per code): %v\n", res.ErrorsByCode)
	for _, v := range res.Violations {
		fmt.Println("VIOLATION:", v)
	}
	if res.Pass {
		fmt.Println("PASS: no client exceeded its per-channel bound")
	} else {
		fmt.Println("FAIL")
	}
	if *out != "" {
		b, _ := json.MarshalIndent(res, "", "  ")
		_ = os.WriteFile(*out, b, 0o644)
	}
	if !res.Pass {
		os.Exit(1)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "flood:", err)
	os.Exit(1)
}
