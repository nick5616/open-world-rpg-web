package game

// Playtest 2 content (CR 022, contracts/content.yaml): the glue between the
// pure internal/content package and the zone. This file holds the per
// character content state (reputation, codex, lore tablets, feats and the
// nameplate title, vault discoveries, herb patches) with its persistence
// (character_content, migration 0025; local profiles' save blob; a WP16
// handoff field), Interact 80 and the cheap periodic work: regions walked,
// feats, titles near you and the lore/herb places of the areas around you.
// Side and story quests are content_quests.go, world events
// worldevents.go, the sealed vaults dungeons.go. Events 1000-1029 are in
// contracts/events.md.
//
// Cost: kills and Interacts are event driven; the rest runs once a second
// per player, staggered (an area change sends that area's places once per
// session), and titles are only sent for the few players who chose one, so
// the scale scenario's bots (no titles, no content Interacts) cost a map
// lookup and a modulo per tick.

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"hash/fnv"
	"math"
	"sort"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/contentdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/structures"
	"lodestone/server/pkg/towns"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/content"
	"lodestone/server/zone/internal/items"
	"lodestone/server/zone/internal/npc"
	"lodestone/server/zone/internal/quests"
)

// Event kinds 1000-1029 (CR 022).
const (
	EventContentSync     = 1000
	EventCodexUnlocked   = 1001
	EventFeatEarned      = 1002
	EventTabletRead      = 1003
	EventRepChanged      = 1004
	EventPlayerTitle     = 1005
	EventContentRefused  = 1006
	EventContentPlaces   = 1007
	EventForagePicked    = 1008
	EventContentSay      = 1009
	EventWorldEvent      = 1010
	EventWorldEventPrize = 1011
	EventVaultState      = 1020
	EventVaultFound      = 1021
	EventVaultNote       = 1022
)

// Interact 80 `content`.
const (
	InteractContent = 80

	ContentActSync   = 1 // send Event 1000 again (the journal's codex/lore/feats tabs)
	ContentActRead   = 2 // read the lore tablet at atlas site targetId
	ContentActForage = 3 // pick herb patch targetId
	ContentActVault  = 4 // use vault part: targetId = site << 8 | part id
	ContentActTitle  = 5 // show feat targetId's title (0 = none)
	ContentActEvent  = 9 // dev: start world event kind arg near you (dev builds only)
)

// Refusals (Event 1006 value).
const (
	ContentRefuseUnknown = 1
	ContentRefuseTooFar  = 2
	ContentRefusePicked  = 3
	ContentRefuseFull    = 4
	ContentRefuseSealed  = 5
	ContentRefuseNotYet  = 6
	ContentRefuseOpened  = 7
	ContentRefuseTitle   = 8
)

// SourceContent is Event 401's source for content rewards (feats, events,
// vault chests, herbs).
const SourceContent = 10

const (
	contentEveryTicks = 30   // per-player checks once a second (staggered)
	contentSaveEvery  = 5    // seconds between saves of a changed state
	tabletReachM      = 4.5  // from the eye
	titleSeeM         = 140  // titles are sent to players this close
	titleEveryTicks   = 60   // and checked every 2 s
	areaSpan          = 1    // places are sent for the 3 x 3 areas around you
	forageGrantMax    = 2    // herbs per patch
	contentSaveKey    = "content:"
)

// contentSess is one character's content state in a session.
type contentSess struct {
	st       *content.State
	areas    map[int32]bool    // areas whose places were sent this session
	told     map[uint32]string // titles of other players told to this client
	lastSave time.Time
	region   int
	recheck  bool // feats need a look (kills, counters)
}

// contentGlue is the server-wide part.
type contentGlue struct {
	world   *content.World
	built   bool
	handed  map[string]*content.State
	tablets map[int]int // atlas site -> tablet id
	tabSite []int       // sites with a tablet, by index
	offers  map[string]map[uint32]*content.Offer
	follow  map[string]*follower // char -> rescued villager following them
	ev      eventsState          // worldevents.go
	vault   vaultsState          // dungeons.go
}

// ContentStore persists content states (PGStore implements it).
type ContentStore interface {
	LoadContent(ctx context.Context, characterID string) ([]byte, bool, error)
	SaveContent(ctx context.Context, characterID string, data []byte, epoch int64) error
}

// LoadContent implements ContentStore.
func (p *PGStore) LoadContent(ctx context.Context, id string) ([]byte, bool, error) {
	if !uuidRe.MatchString(id) {
		return nil, false, nil
	}
	var b []byte
	err := p.Pool.QueryRow(ctx, `SELECT data FROM character_content WHERE character_id = $1::uuid`, id).Scan(&b)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	return b, err == nil, err
}

// SaveContent implements ContentStore (epoch-fenced like SaveQuests).
func (p *PGStore) SaveContent(ctx context.Context, id string, data []byte, epoch int64) error {
	if !uuidRe.MatchString(id) {
		return ErrNoRow
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO character_content (character_id, data, epoch, updated_at) VALUES ($1::uuid, $2::jsonb, $3, now())
		ON CONFLICT (character_id) DO UPDATE SET data = EXCLUDED.data, epoch = GREATEST(character_content.epoch, EXCLUDED.epoch), updated_at = now()
		WHERE EXCLUDED.epoch = 0 OR character_content.epoch <= EXCLUDED.epoch`, id, string(data), epoch)
	var pe *pgconn.PgError
	if errors.As(err, &pe) && pe.Code == "23503" {
		return ErrNoRow
	}
	return err
}

// loadContent runs on the connection goroutine before join.
func (s *Server) loadContent(characterID string, x *exploreState) *contentSess {
	cs := &contentSess{areas: map[int32]bool{}, told: map[uint32]string{}, region: -1}
	if x != nil && x.local != nil {
		cs.st = content.LoadState(x.local.state.Content)
		return cs
	}
	store, ok := s.cfg.Store.(ContentStore)
	if !ok || s.cfg.Store == nil {
		cs.st = content.NewState()
		return cs
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	b, found, err := store.LoadContent(ctx, characterID)
	if err != nil {
		s.log.Warn("content load failed; empty state this session", "character", characterID, "err", err)
	}
	if !found {
		cs.st = content.NewState()
		return cs
	}
	cs.st = content.LoadState(b)
	return cs
}

func init() {
	RegisterHandoffField(HandoffField{
		Name: "content",
		Save: func(s *Server, e *Entity) json.RawMessage {
			if sess := s.byChar[e.CharacterID]; sess != nil && sess.cnt != nil {
				return sess.cnt.st.JSON()
			}
			return nil
		},
		Load: func(s *Server, e *Entity, data json.RawMessage) {
			if s.cnt.handed == nil {
				s.cnt.handed = map[string]*content.State{}
			}
			s.cnt.handed[e.CharacterID] = content.LoadState(data)
		},
	})
}

func (s *Server) initContent() {
	s.cnt.offers = map[string]map[uint32]*content.Offer{}
	s.cnt.follow = map[string]*follower{}
	prev := s.cbt.w.OnKill
	s.cbt.w.OnKill = func(k combat.KillInfo) {
		if prev != nil {
			prev(k)
		}
		s.contentOnKill(k)
	}
}

// contentWorld builds the generators' view of the world once.
func (s *Server) contentWorld() *content.World {
	if s.cnt.built {
		return s.cnt.world
	}
	s.cnt.built = true
	cw := &content.World{Seed: s.cfg.Seed}
	var atlas *combat.AtlasInfo
	if s.cbt.w != nil {
		atlas = s.cbt.w.Atlas
	}
	region := func(x, z float64) int {
		if atlas != nil {
			return atlas.RegionAt(x, z)
		}
		return 0
	}
	if tw := s.cfg.Towns; tw != nil {
		for si := range tw.T.Settlements {
			st := &tw.T.Settlements[si]
			t := content.Town{Index: si, ID: st.ID, Name: s.settlementName(si), X: st.X, Z: st.Z, Radius: st.Radius, Region: region(st.X, st.Z)}
			if atlas != nil {
				t.Biome = atlas.BiomeAt(st.X, st.Z)
			}
			for i := st.NPCFirst; i < st.NPCFirst+st.NPCs; i++ {
				d := &tw.T.NPCs[i]
				t.NPCs = append(t.NPCs, content.NPC{Index: i, Name: d.Name, Role: int(d.Role), X: d.WorkX, Z: d.WorkZ})
			}
			cw.Towns = append(cw.Towns, t)
		}
	}
	s.cnt.tablets = map[int]int{}
	if ex := s.cfg.Explore; ex != nil {
		for i := range ex.Atlas.Sites {
			a := &ex.Atlas.Sites[i]
			kind := ""
			switch {
			case a.Category == structures.CategoryPOI && a.Kind == structures.POITower:
				kind = content.SiteTower
			case a.Category == structures.CategoryPOI && a.Kind == structures.POILandmark:
				kind = content.SiteLandmark
			case a.Category == structures.CategoryPOI && a.Kind == structures.POIEnemyCamp:
				kind = content.SiteCamp
			case a.Category == structures.CategoryStructure && a.Kind == combat.StructRuin:
				kind = content.SiteRuin
			case a.Category == structures.CategoryStructure && a.Kind == combat.StructWatchtower:
				kind = content.SiteWatchtower
			case a.Category == structures.CategoryStructure && a.Kind == combat.StructShrine:
				kind = content.SiteShrine
			case a.Category == structures.CategoryStructure && a.Kind == combat.StructBanditCamp:
				kind = content.SiteBanditCamp
			}
			if kind == "" {
				continue
			}
			cw.Sites = append(cw.Sites, content.Site{Index: i, Kind: kind, Name: a.Name, X: a.X, Z: a.Z, R: a.Radius, Region: int(a.Region), Size: int(a.Size)})
		}
		// Lore tablets: every ruin, shrine and watchtower holds one; the
		// tablets are dealt round-robin over a seeded shuffle of those sites,
		// so every tablet stands somewhere when there are enough sites.
		var tab []int
		for _, c := range cw.Sites {
			if c.Kind == content.SiteRuin || c.Kind == content.SiteShrine || c.Kind == content.SiteWatchtower {
				tab = append(tab, c.Index)
			}
		}
		sort.Slice(tab, func(i, j int) bool {
			hi, hj := content.Mix(s.cfg.Seed^uint64(tab[i])*0x7ab1e7), content.Mix(s.cfg.Seed^uint64(tab[j])*0x7ab1e7)
			if hi != hj {
				return hi < hj
			}
			return tab[i] < tab[j]
		})
		for k, si := range tab {
			s.cnt.tablets[si] = k%len(contentdefs.D.Tablets) + 1
		}
		sort.Ints(tab)
		s.cnt.tabSite = tab
		per := max(1, ex.Atlas.RegionsPerEdge)
		size := ex.Atlas.WorldSize / float64(per)
		centre := func(r int) (float64, float64) {
			return (float64(r%per) + 0.5) * size, (float64(r/per) + 0.5) * size
		}
		cw.Dungeons = content.PickVaultSites(cw.Sites, centre, per*per)
		for i := range cw.Dungeons {
			cw.Dungeons[i].Kind = content.SiteDungeon
			cw.Dungeons[i].Name = content.PlanVault(s.cfg.Seed, cw.Dungeons[i]).Name
		}
	}
	s.cnt.world = cw
	return cw
}

// contentJoin adopts a handed-over state and sends the sync (tick goroutine).
// contentOn: content needs a world to be about (an atlas or towns); the
// flat test and scale worlds have neither, so their wire is untouched.
func (s *Server) contentOn() bool { return s.cfg.Explore != nil || s.cfg.Towns != nil }

func (s *Server) contentJoin(sess *session) {
	e := sess.ent
	if !s.contentOn() {
		return
	}
	if h := s.cnt.handed[e.CharacterID]; h != nil {
		delete(s.cnt.handed, e.CharacterID)
		if sess.cnt == nil {
			sess.cnt = &contentSess{areas: map[int32]bool{}, told: map[uint32]string{}, region: -1}
		}
		sess.cnt.st = h
	}
	if sess.cnt == nil {
		sess.cnt = &contentSess{st: content.NewState(), areas: map[int32]bool{}, told: map[uint32]string{}, region: -1}
	}
	sess.cnt.recheck = true
	s.sendContentSync(sess)
	if t := sess.cnt.st.TitleText(); t != "" {
		s.contentTitleChanged(sess)
	}
}

func (s *Server) contentLeave(sess *session) {
	if sess.cnt == nil {
		return
	}
	s.dismissFollower(sess.ent)
	if sess.cnt.st.Dirty() {
		s.saveContent(sess)
	}
}

// saveContent persists a changed state: accounts through the write-behind
// queue (coalesced per character), local profiles in the next save blob.
func (s *Server) saveContent(sess *session) {
	e, cs := sess.ent, sess.cnt
	if e == nil || cs == nil || !cs.st.Dirty() || s.cfg.Queue == nil {
		return
	}
	cs.lastSave = s.cfg.Now()
	if sess.x != nil && sess.x.local != nil {
		sess.x.prog.MarkDirty() // contentIntoLocal copies the state into the blob
		s.saveProgressSoon(sess, false)
		return
	}
	store, ok := s.cfg.Store.(ContentStore)
	if !ok || s.cfg.Store == nil {
		return
	}
	b, id, epoch, log := cs.st.JSON(), e.CharacterID, e.epoch, s.log
	cs.st.MarkSaved()
	s.cfg.Queue.Enqueue(writebehind.Op{Key: contentSaveKey + id, Run: func(ctx context.Context) error {
		err := store.SaveContent(ctx, id, b, epoch)
		if err != nil && errors.Is(err, writebehind.ErrSkip) {
			if _, seen := loggedMissing.LoadOrStore(contentSaveKey+id, true); !seen {
				log.Info("content save skipped: no character row", "character", id)
			}
		}
		return err
	}})
}

// contentIntoLocal copies the state into a local save's state (localState).
func contentIntoLocal(sess *session, raw *json.RawMessage) {
	if sess.cnt == nil {
		return
	}
	*raw = sess.cnt.st.JSON()
	sess.cnt.st.MarkSaved()
}

// ---- the sync (Event 1000) ----

type syncVault struct {
	Site int     `json:"site"`
	Name string  `json:"name"`
	X    float64 `json:"x"`
	Z    float64 `json:"z"`
}

type syncRep struct {
	Town int    `json:"town"`
	Name string `json:"name"`
	Rep  int    `json:"rep"`
	Tier int    `json:"tier"`
}

func (s *Server) sendContentSync(sess *session) {
	cs := sess.cnt
	if cs == nil || sess.ent == nil {
		return
	}
	st := cs.st
	out := struct {
		V       int            `json:"v"`
		Kills   map[string]int `json:"kills"`
		Tablets []int          `json:"tablets"`
		Feats   []string       `json:"feats"`
		Title   string         `json:"title"`
		Stats   map[string]int `json:"stats"`
		Regions int            `json:"regions"`
		Rep     []syncRep      `json:"rep"`
		Vaults  []syncVault    `json:"vaults"`
		Progress map[string]int `json:"progress"`
	}{V: 1, Kills: st.Kills, Tablets: st.Tablets, Feats: st.Feats, Title: st.Title, Stats: st.Stats, Regions: st.RegionsWalked(), Progress: map[string]int{}}
	if out.Kills == nil {
		out.Kills = map[string]int{}
	}
	if out.Stats == nil {
		out.Stats = map[string]int{}
	}
	for k, v := range st.Rep {
		si, _ := strconv.Atoi(k)
		out.Rep = append(out.Rep, syncRep{Town: si, Name: s.settlementName(si), Rep: v, Tier: contentdefs.D.TierOf(v)})
	}
	sort.Slice(out.Rep, func(i, j int) bool { return out.Rep[i].Town < out.Rep[j].Town })
	cw := s.contentWorld()
	for _, site := range st.VaultSites() {
		for _, d := range cw.Dungeons {
			if d.Index == site {
				out.Vaults = append(out.Vaults, syncVault{Site: site, Name: d.Name, X: d.X, Z: d.Z})
			}
		}
	}
	for i := range contentdefs.D.Feats {
		f := &contentdefs.D.Feats[i]
		out.Progress[f.Key] = s.featStat(sess, f.Stat)
	}
	b, _ := json.Marshal(out)
	s.sendEvent(sess, &proto.Event{Kind: EventContentSync, EntityID: sess.ent.ID, Value: int32(len(st.Feats)), Data: b})
}

// featStat answers a feat stat for sess.
func (s *Server) featStat(sess *session, stat string) int {
	if v := sess.cnt.st.Stat2(stat); v >= 0 {
		return v
	}
	x := sess.x
	if x == nil || x.prog == nil {
		return 0
	}
	switch stat {
	case "towers":
		return x.prog.Attuned.Count()
	case "level":
		return x.prog.Level
	}
	return 0
}

// contentFeats earns what can be earned now and pays it.
func (s *Server) contentFeats(sess *session) {
	cs := sess.cnt
	if cs == nil || sess.ent == nil {
		return
	}
	cs.recheck = false
	titled := cs.st.TitleText()
	for _, f := range cs.st.NewFeats(func(stat string) int { return s.featStat(sess, stat) }) {
		if f.Gold > 0 {
			s.questGrant(sess, []quests.ItemQty{{Item: "currency:gold", Qty: f.Gold}}, "feat:"+f.Key, "feat "+f.Key)
		}
		if f.XP > 0 {
			s.grantCombatXP(combat.XPGrant{Player: sess.ent.ID, XP: f.XP, Reason: "feat"})
		}
		b, _ := json.Marshal(struct {
			Key   string `json:"key"`
			Name  string `json:"name"`
			Desc  string `json:"desc"`
			Title string `json:"title"`
			Gold  int    `json:"gold"`
			XP    int64  `json:"xp"`
		}{f.Key, f.Name, f.Desc, f.Title, f.Gold, f.XP})
		s.sendEvent(sess, &proto.Event{Kind: EventFeatEarned, EntityID: sess.ent.ID, TargetID: uint32(f.ID), Data: b})
		s.log.Info("feat earned", "character", sess.ent.CharacterID, "feat", f.Key)
	}
	if cs.st.TitleText() != titled {
		s.contentTitleChanged(sess)
	}
	if cs.st.Dirty() {
		s.saveContent(sess)
	}
}

// ---- titles on nameplates (Event 1005) ----

// contentTitleChanged tells everyone near sess's player about its title.
func (s *Server) contentTitleChanged(sess *session) {
	e := sess.ent
	if e == nil || sess.cnt == nil {
		return
	}
	t := sess.cnt.st.TitleText()
	ev := &proto.Event{Kind: EventPlayerTitle, EntityID: e.ID, Data: []byte(t)}
	b := proto.Encode(ev)
	for _, o := range s.sessions {
		if o.ent == nil || o.cnt == nil {
			continue
		}
		if o != sess && math.Hypot(o.ent.Move.Pos.X-e.Move.Pos.X, o.ent.Move.Pos.Z-e.Move.Pos.Z) > titleSeeM {
			continue
		}
		o.cnt.told[e.ID] = t
		if err := o.conn.SendReliable(b); err != nil {
			o.closed.Store(true)
		}
	}
}

// titlesTick sends the titles of titled players to clients that came near
// them since (every 2 s; nothing at all while nobody has a title).
func (s *Server) titlesTick() {
	var titled []*session
	for _, sess := range s.sessions {
		if sess.cnt != nil && sess.ent != nil && sess.cnt.st.Title != "" {
			titled = append(titled, sess)
		}
	}
	if len(titled) == 0 {
		return
	}
	for _, o := range s.sessions {
		if o.ent == nil || o.cnt == nil {
			continue
		}
		for _, t := range titled {
			if t == o {
				continue
			}
			text := t.cnt.st.TitleText()
			if o.cnt.told[t.ent.ID] == text || math.Hypot(o.ent.Move.Pos.X-t.ent.Move.Pos.X, o.ent.Move.Pos.Z-t.ent.Move.Pos.Z) > titleSeeM {
				continue
			}
			o.cnt.told[t.ent.ID] = text
			s.sendEvent(o, &proto.Event{Kind: EventPlayerTitle, EntityID: t.ent.ID, Data: []byte(text)})
		}
	}
}

// ---- the tick ----

func (s *Server) contentTick(tick uint32) {
	if !s.contentOn() {
		return
	}
	now := s.cfg.Now()
	for _, sess := range s.sessions {
		cs, e := sess.cnt, sess.ent
		if cs == nil || e == nil {
			continue
		}
		if (tick+e.ID)%contentEveryTicks == 0 {
			s.contentPlayerSecond(sess, now)
		}
	}
	if tick%titleEveryTicks == 0 {
		s.titlesTick()
	}
	s.followersTick()           // content_quests.go
	s.worldEventsTick(tick)     // worldevents.go
	s.vaultsTick(tick)          // dungeons.go
}

// contentPlayerSecond: regions walked, vault discoveries, places near, feats, saves.
func (s *Server) contentPlayerSecond(sess *session, now time.Time) {
	cs, e := sess.cnt, sess.ent
	if s.cbt.w != nil && s.cbt.w.Atlas != nil {
		if r := s.cbt.w.Atlas.RegionAt(e.Move.Pos.X, e.Move.Pos.Z); r != cs.region {
			cs.region = r
			if cs.st.Walked(r) {
				cs.recheck = true
			}
		}
	}
	s.vaultDiscover(sess) // dungeons.go
	s.sendPlacesNear(sess, false)
	if cs.recheck {
		s.contentFeats(sess)
	}
	if cs.st.Dirty() && now.Sub(cs.lastSave) >= contentSaveEvery*time.Second {
		s.saveContent(sess)
	}
}

// ---- kills: the codex, counters, quest kill steps ----

func (s *Server) contentOnKill(k combat.KillInfo) {
	en := k.Enemy
	if en == nil || en.Def == nil || !s.contentOn() {
		return
	}
	s.eventsOnKill(k) // worldevents.go
	s.vaultsOnKill(k) // dungeons.go
	demon := en.Demon != nil
	for _, id := range k.Eligible {
		pe := s.entityByID(id)
		if pe == nil || pe.Kind != proto.EntityKindPlayer {
			continue
		}
		sess := s.byChar[pe.CharacterID]
		if sess == nil || sess.cnt == nil {
			continue
		}
		if sess.cnt.st.Kill(en.Def.Key, en.Def.Family, demon) {
			s.sendEvent(sess, &proto.Event{Kind: EventCodexUnlocked, EntityID: pe.ID, TargetID: uint32(en.Def.ID), Value: 1, Data: []byte(en.Def.Key)})
		}
		sess.cnt.recheck = true
		// Kill steps are counted in questsOnKill (quests.go), content on or off.
	}
}

// contentAttuned: an attunement (progression.go) may finish a story step
// and earn a feat.
func (s *Server) contentAttuned(sess *session) {
	if sess.quests != nil && sess.quests.log.Needs(quests.ObjAttune) {
		s.questsAdvance(sess, &quests.Signal{Kind: quests.ObjAttune, Site: -1})
	}
	if sess.cnt != nil {
		s.contentFeats(sess)
	}
}

// contentLevel: a level-up may earn a feat.
func (s *Server) contentLevel(sess *session) {
	if sess.cnt != nil {
		sess.cnt.recheck = true
	}
}

// contentDuelWon counts a duel win (duel.go).
func (s *Server) contentDuelWon(e *Entity) {
	if sess := s.byChar[e.CharacterID]; sess != nil && sess.cnt != nil {
		sess.cnt.st.Add("duels", 1)
		s.contentFeats(sess)
	}
}

// ---- Interact 80 ----

func (s *Server) contentInteract(sess *session, m *proto.Interact) {
	e, cs := sess.ent, sess.cnt
	if e == nil || cs == nil {
		return
	}
	refuse := func(r int32) {
		s.sendEvent(sess, &proto.Event{Kind: EventContentRefused, EntityID: e.ID, TargetID: uint32(m.TargetID), Value: r, Data: []byte{m.Action}})
	}
	switch m.Action {
	case ContentActSync:
		s.sendContentSync(sess)
	case ContentActRead:
		s.readTablet(sess, int(m.TargetID), refuse)
	case ContentActForage:
		s.forage(sess, uint32(m.TargetID), refuse)
	case ContentActVault:
		s.vaultUse(sess, int(m.TargetID>>8), int(m.TargetID&0xff), refuse) // dungeons.go
	case ContentActTitle:
		key := ""
		if m.TargetID != 0 {
			if int(m.TargetID) > len(contentdefs.D.Feats) {
				refuse(ContentRefuseTitle)
				return
			}
			key = contentdefs.D.Feats[m.TargetID-1].Key
		}
		if !cs.st.SetTitle(key) {
			refuse(ContentRefuseTitle)
			return
		}
		s.contentTitleChanged(sess)
		s.saveContent(sess)
		s.sendContentSync(sess)
	case ContentActEvent:
		if !s.cfg.DevSpawn {
			refuse(ContentRefuseUnknown)
			return
		}
		if !s.devStartEvent(sess, int(m.Arg)) { // worldevents.go
			refuse(ContentRefuseUnknown)
		}
	default:
		refuse(ContentRefuseUnknown)
	}
}

// ---- lore tablets ----

// tabletPos is where the tablet of atlas site si stands.
func (s *Server) tabletPos(si int) (movement.Vec3, bool) {
	if s.cfg.Explore == nil || si < 0 || si >= len(s.cfg.Explore.Atlas.Sites) {
		return movement.Vec3{}, false
	}
	a := &s.cfg.Explore.Atlas.Sites[si]
	off := math.Max(a.Radius*0.45, 4)
	ang := a.Yaw + math.Pi*0.75
	x, z := a.X+off*math.Cos(ang), a.Z+off*math.Sin(ang)
	return movement.Vec3{X: x, Y: s.surfaceAt(x, z, a.Y), Z: z}, true
}

func (s *Server) readTablet(sess *session, si int, refuse func(int32)) {
	s.contentWorld()
	id, ok := s.cnt.tablets[si]
	if !ok {
		refuse(ContentRefuseUnknown)
		return
	}
	p, _ := s.tabletPos(si)
	if eyeDist(sess.ent, p.X, p.Y+1.0, p.Z) > tabletReachM {
		refuse(ContentRefuseTooFar)
		return
	}
	t := &contentdefs.D.Tablets[id-1]
	first := sess.cnt.st.ReadTablet(id)
	b, _ := json.Marshal(struct {
		Site  int    `json:"site"`
		ID    int    `json:"id"`
		Title string `json:"title"`
		Text  string `json:"text"`
		New   bool   `json:"new"`
		Place string `json:"place"`
	}{si, id, t.Title, t.Text, first, s.cfg.Explore.Atlas.Sites[si].Name})
	s.sendEvent(sess, &proto.Event{Kind: EventTabletRead, EntityID: sess.ent.ID, TargetID: uint32(si), Value: int32(id), Data: b})
	if first {
		s.grantCombatXP(combat.XPGrant{Player: sess.ent.ID, XP: 25, Reason: "lore"})
		s.contentFeats(sess)
	}
	if sess.quests != nil && sess.quests.log.Needs(quests.ObjRead) {
		s.questsAdvance(sess, &quests.Signal{Kind: quests.ObjRead, Site: si})
	}
}

// ---- herb patches ----

func (s *Server) patchOK(x, z float64) bool {
	g := s.cfg.Ground
	y := g.HeightAt(x, z)
	if movement.WaterAt(g, x, z) > y-0.2 || movement.SlopeAt(g, x, z).T2 > constants.WalkableTanSq {
		return false
	}
	if tw := s.cfg.Towns; tw != nil {
		for i := range tw.T.Settlements {
			st := &tw.T.Settlements[i]
			if math.Hypot(st.X-x, st.Z-z) < st.Radius+18 {
				return false
			}
		}
	}
	return true
}

func (s *Server) biomeAt(x, z float64) int {
	if s.cbt.w != nil && s.cbt.w.Atlas != nil {
		return s.cbt.w.Atlas.BiomeAt(x, z)
	}
	return 0
}

func (s *Server) forage(sess *session, id uint32, refuse func(int32)) {
	e := sess.ent
	cx, cz := content.PatchCell(id)
	p, ok := content.PatchAt(s.cfg.Seed, cx, cz, s.biomeAt, s.patchOK)
	if !ok || p.ID != id {
		refuse(ContentRefuseUnknown)
		return
	}
	if math.Hypot(p.X-e.Move.Pos.X, p.Z-e.Move.Pos.Z) > contentdefs.D.Forage.ReachM+1.0 {
		refuse(ContentRefuseTooFar)
		return
	}
	now := s.cfg.Now().UnixMilli()
	if sess.cnt.st.Picked(id, now) {
		refuse(ContentRefusePicked)
		return
	}
	herb := content.HerbByID(p.Herb)
	n := 1 + int(content.Mix(s.cfg.Seed^uint64(id)^uint64(now/60000)^hashString(e.CharacterID))%forageGrantMax)
	ci := sess.items
	if herb == nil || ci == nil || !ci.inv.CanFit(herb.Item, n) {
		refuse(ContentRefuseFull)
		return
	}
	var d items.Delta
	it := items.Stack(herb.Item, n)
	it.Prov = []items.Prov{{Ev: "forage", Char: e.CharacterID, Name: e.Name, Src: "herb:" + strconv.FormatUint(uint64(id), 10), At: now, Local: ci.persist == persistLocal}}
	ci.inv.Add(it, &d)
	s.commitItems(sess, &d, nil, "forage")
	s.sendGranted(sess, SourceContent, []*items.Item{it})
	until := now + int64(contentdefs.D.Forage.RegrowS*1000)
	sess.cnt.st.Pick(id, until, now)
	sess.cnt.st.Add("forage", n)
	sess.cnt.recheck = true
	s.sendEvent(sess, &proto.Event{Kind: EventForagePicked, EntityID: e.ID, TargetID: id, Value: int32(until - now), Data: []byte(herb.Item)})
	s.questsChanged(sess)
}

// ---- places near you (Event 1007) ----

func areaKey(ax, az int) int32 { return int32(az*64 + ax) }

// sendPlacesNear sends, once per session, the lore tablets, herb patches
// and vault yards of the 3 x 3 areas around the player.
func (s *Server) sendPlacesNear(sess *session, force bool) {
	e, cs := sess.ent, sess.cnt
	ax, az := int(math.Floor(e.Move.Pos.X/content.AreaM)), int(math.Floor(e.Move.Pos.Z/content.AreaM))
	n := int(float64(constants.WorldSizeM) / content.AreaM)
	for dz := -areaSpan; dz <= areaSpan; dz++ {
		for dx := -areaSpan; dx <= areaSpan; dx++ {
			x, z := ax+dx, az+dz
			if x < 0 || z < 0 || x >= n || z >= n {
				continue
			}
			k := areaKey(x, z)
			if cs.areas[k] && !force {
				continue
			}
			cs.areas[k] = true
			s.sendPlaces(sess, x, z)
		}
	}
}

// sendPlaces is Event 1007 for one area: u8 version | u16 ax | u16 az |
// u16 tablets x (u16 site | u8 tablet id | i32 x, y, z cm | u8 read) |
// u16 patches x (u32 id | u8 herb | i32 x, y, z cm | u32 ms until it regrows for you).
func (s *Server) sendPlaces(sess *session, ax, az int) {
	s.contentWorld()
	cs := sess.cnt
	x0, z0 := float64(ax)*content.AreaM, float64(az)*content.AreaM
	in := func(x, z float64) bool { return x >= x0 && x < x0+content.AreaM && z >= z0 && z < z0+content.AreaM }
	b := []byte{1}
	b = binary.LittleEndian.AppendUint16(b, uint16(ax))
	b = binary.LittleEndian.AppendUint16(b, uint16(az))
	var tabs []int
	for _, si := range s.cnt.tabSite {
		a := &s.cfg.Explore.Atlas.Sites[si]
		if in(a.X, a.Z) {
			tabs = append(tabs, si)
		}
	}
	b = binary.LittleEndian.AppendUint16(b, uint16(len(tabs)))
	for _, si := range tabs {
		p, _ := s.tabletPos(si)
		id := s.cnt.tablets[si]
		b = binary.LittleEndian.AppendUint16(b, uint16(si))
		b = append(b, byte(id))
		b = binary.LittleEndian.AppendUint32(b, uint32(cm(p.X)))
		b = binary.LittleEndian.AppendUint32(b, uint32(cm(p.Y)))
		b = binary.LittleEndian.AppendUint32(b, uint32(cm(p.Z)))
		read := byte(0)
		for _, t := range cs.st.Tablets {
			if t == id {
				read = 1
			}
		}
		b = append(b, read)
	}
	patches := content.PatchesIn(s.cfg.Seed, ax, az, s.biomeAt, s.patchOK)
	b = binary.LittleEndian.AppendUint16(b, uint16(len(patches)))
	now := s.cfg.Now().UnixMilli()
	for _, p := range patches {
		y := s.surfaceAt(p.X, p.Z, 0)
		b = binary.LittleEndian.AppendUint32(b, p.ID)
		b = append(b, byte(p.Herb))
		b = binary.LittleEndian.AppendUint32(b, uint32(cm(p.X)))
		b = binary.LittleEndian.AppendUint32(b, uint32(cm(y)))
		b = binary.LittleEndian.AppendUint32(b, uint32(cm(p.Z)))
		left := int64(0)
		if until := cs.st.Forage[strconv.FormatUint(uint64(p.ID), 10)]; until > now {
			left = until - now
		}
		b = binary.LittleEndian.AppendUint32(b, uint32(left))
	}
	s.sendEvent(sess, &proto.Event{Kind: EventContentPlaces, EntityID: sess.ent.ID, TargetID: uint32(areaKey(ax, az)), Data: b})
}

// ---- reputation and shops ----

// waresFor is NPC i's shop for e: the WP20 stock plus what e's reputation
// with the settlement unlocks (content.yaml reputation.wares).
func (s *Server) waresFor(e *Entity, i int) []npc.Ware {
	w := s.cfg.Towns
	base := w.Wares(i)
	if base == nil || e == nil {
		return base
	}
	sess := s.byChar[e.CharacterID]
	if sess == nil || sess.cnt == nil {
		return base
	}
	d := w.NPCs[i].Def
	shop := -1
	switch {
	case d.Role == towns.RoleMerchant && d.Merchant < 4:
		shop = int(d.Merchant)
	case d.Role == towns.RoleBlacksmith:
		shop = 4
	}
	tier := contentdefs.D.TierOf(sess.cnt.st.RepOf(d.Settlement))
	if shop < 0 || tier == 0 {
		return base
	}
	out := append([]npc.Ware(nil), base...)
	for t := 1; t <= tier && t < len(contentdefs.D.Reputation.Wares); t++ {
		for _, x := range contentdefs.D.Reputation.Wares[t][shop] {
			out = append(out, npc.Ware{Item: x.Item, Price: x.Price, Stock: x.Stock})
		}
	}
	return out
}

// contentRep raises e's reputation with settlement si and says so.
func (s *Server) contentRep(sess *session, si, n int) {
	if sess.cnt == nil || n <= 0 || si < 0 {
		return
	}
	rep, before, after := sess.cnt.st.AddRep(si, n)
	tier := contentdefs.D.Reputation.Tiers[after]
	b, _ := json.Marshal(struct {
		Town     string `json:"town"`
		Rep      int    `json:"rep"`
		Gain     int    `json:"gain"`
		Tier     int    `json:"tier"`
		TierName string `json:"tierName"`
		Up       bool   `json:"up"`
	}{s.settlementName(si), rep, n, after, tier.Name, after > before})
	s.sendEvent(sess, &proto.Event{Kind: EventRepChanged, EntityID: sess.ent.ID, TargetID: uint32(si), Value: int32(rep), Data: b})
	sess.cnt.recheck = true
}

// hashString64 is FNV-1a 64 (seeded per-character picks).
func hashString64(v string) uint64 {
	h := fnv.New64a()
	h.Write([]byte(v))
	return h.Sum64()
}
