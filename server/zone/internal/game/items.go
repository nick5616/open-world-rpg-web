package game

// Items in the zone (WP14, spec 8 "Loot, rarities and dropping items"):
// the glue between sessions/entities and the pure item logic
// (internal/items).
//
//   - Every character has an inventory in zone memory (authoritative while
//     online, spec 11), loaded at connect from Postgres (accounts) or the
//     signed save blob (local profiles), memory-only for characters without
//     a row (bots, dev tickets). Changes reach Postgres through the ordered
//     item journal (items_journal.go), local profiles through their next
//     signed blob.
//   - Personal loot (spec 8): every kill (combat OnKill), container and
//     vein rolls separately per eligible player from a logged seed; kill
//     and vein loot pops out as owner-only pickups (WP09's pickup entity,
//     auto-taken on touch), containers go straight into the inventory.
//     Each roll is granted exactly once (loot_grants markers).
//   - Dropping (Interact 21/2) and taking a dropped item (Interact 41) move
//     the item through TransferItem (the one server path trades will
//     reuse); a dropped item is a public pickup anyone near can take for
//     10 minutes, then it despawns. A local profile's drop is marked
//     unverified and untradeable.
//   - Gear: the equipped weapon, armor and socketed gems set combat's
//     Player.Gear and the loadout's weapon/gem (WP13 elemental forms read
//     the socketed gem); consumables replace WP13's stand-in draught.
//   - Stations: forges and anvils (WP20's Config.Stations hook) and inn
//     hearths/campfires host smelting, forging and cooking.
//
// Wire conventions: contracts/events.md (Events 400-411, Interact 20-22,
// Interact 41 for dropped items).

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"lodestone/server/pkg/combatdefs"
	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/localsave"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/towns"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/items"
)

// Interact target kinds owned by items (contracts/events.md 20-29).
const (
	InteractContainer = 20
	InteractItem      = 21
	InteractCraft     = 22
)

// Interact 21 actions.
const (
	ItemActUse      = 1
	ItemActDrop     = 2
	ItemActEquip    = 3
	ItemActUnequip  = 4
	ItemActMove     = 5
	ItemActSocket   = 6
	ItemActUnsocket = 7
	ItemActCombine  = 8
	ItemActQuick    = 9
)

// Interact 22 actions.
const (
	CraftActCraft = 1
	CraftActOpen  = 2
)

// Event kinds (contracts/events.md, WP14 range 400-499).
const (
	EventInventory       = 400
	EventLootGranted     = 401
	EventBitchin         = 402
	EventItemRefused     = 403
	EventStation         = 404
	EventCrafted         = 405
	EventContainers      = 406
	EventContainerOpened = 407
	EventDropped         = 408
	EventBossLockout     = 409
	EventGemCombined     = 410
	EventItemTaken       = 411
)

// Refusal reasons (Event 403 value).
const (
	ItemRefuseFull      = 1
	ItemRefuseNoItem    = 2
	ItemRefuseNotAllow  = 3
	ItemRefuseMissing   = 4
	ItemRefuseBlueprint = 5
	ItemRefuseGold      = 6
	ItemRefuseTooFar    = 7
	ItemRefuseOpened    = 8
	ItemRefuseSocket    = 9
	ItemRefuseWaypoint  = 10
	ItemRefuseBusy      = 11
	ItemRefuseStation   = 12
)

// Loot sources (Event 401 targetId).
const (
	SourceKill      = 1
	SourceContainer = 2
	SourceVein      = 3
	SourceCraft     = 4
	SourcePurchase  = 5
	SourceStarter   = 6
	SourceDropped   = 7
	SourceGem       = 8
)

// Station kinds (Event 404 targetId; 1 and 2 match WP20's Event 805).
const (
	StationForge = 1
	StationAnvil = 2
	StationCook  = 3
)

const (
	itemReachM      = 4.5  // containers, stations (spec "4 m from the eye" + slack)
	stationStayM    = 7.0  // crafting while still near the open station
	smithNearM      = 8.0  // unsocket keeping the gem: at a town blacksmith (forge/anvil)
	waypointNearM   = 8.0  // combine gems at a waypoint (spec 7)
	containerListM  = 96.0 // containers sent to the client within this
	takeReachM      = 3.5  // take a dropped item (eye to item, like WP09)
	pickupRefuseGap = 3 * time.Second
	containerEvery  = constants.TickRateHz // container list refresh check, 1 Hz
	propHearth      = 4
	propCampfire    = 22
)

// ItemsSetup configures items (main.go fills it; nil = memory-only items,
// no containers, the spec's 10-minute drop timer).
type ItemsSetup struct {
	Store       ItemStore       // nil: no Postgres (items live in memory)
	Containers  ContainerSource // nil: no world containers
	Themes      []string        // the world spec's lootThemes (region theme for kill loot)
	DropDespawn time.Duration   // spec 8: 10 minutes; tests shorten it
	Announce    func(text string)
}

// ContainerSource lists the world's loot containers (worldgen chunk
// container anchors) near a point.
type ContainerSource interface {
	ContainersNear(x, z, r float64) []ContainerInfo
}

// ContainerInfo is one container anchor.
type ContainerInfo struct {
	ID      uint64
	X, Y, Z float64
	Kind    int    // 0 chest, 1 buried cache, 2 urn, 3 crate
	Theme   string // loot theme ("" none)
	Level   int    // fallback item level (worldgen's region danger curve): used only without discovery-stamped difficulty or while the area is unknown (loot.go lootLevelAt)
	Element int    // region element (-1 unknown)
}

// Persistence of a character's items.
const (
	persistMemory = iota
	persistDB
	persistLocal
)

// charItems is one connected character's item state (tick-owned after join).
type charItems struct {
	inv        items.Inventory
	markers    map[string]bool
	persist    int
	quick      string
	version    int
	gearVer    int
	gearActive int
	synced     [2]string // weapon type WP14 last put in each loadout
	charges    int
	station    *openStation
	contChunk  [2]int32
	contSent   bool
	contSig    uint64 // which containers the last 406 listed (resend when it changes)
	contVer    int
	refuseAt   time.Time
	takes      int
}

type openStation struct {
	kind    int
	prop    uint64
	x, y, z float64
}

// itemDrop is the item behind a pickup entity (WP09's pickup kind): rolled
// personal loot (owner-only, granted with key) or a dropped item lying in
// the world (public, a database row while persisted).
type itemDrop struct {
	item      *items.Item
	world     bool
	persisted bool
	key       string
	source    int
	takes     int
	refused   time.Time
}

type itemsState struct {
	setup  ItemsSetup
	j      *itemJournal
	nextH  uint32
	boot   uint64
	props  map[uint64]int // station-ish town props by id (forge, anvil, hearth, campfire)
	runCtx context.CancelFunc
	ran    bool
	loot   int64
	// Local profiles' drops parked until their blob is issued (loot.go);
	// written from the write-behind worker, hence the mutex.
	ldMu       sync.Mutex
	localDrops map[string][]*ItemOp
	later      []func() // tick callbacks queued off the tick (no journal)
	handed     map[string]*handedItems
}

func (s *Server) initItems() {
	st := ItemsSetup{}
	if s.cfg.Items != nil {
		st = *s.cfg.Items
	}
	if st.DropDespawn <= 0 {
		st.DropDespawn = constants.PickupDespawnS * time.Second
	}
	s.itm = itemsState{setup: st, boot: items.Mix64(uint64(time.Now().UnixNano()))}
	if st.Store != nil {
		s.itm.j = newItemJournal(st.Store, s.log)
	}
	if s.cfg.Stations == nil {
		s.cfg.Stations = itemStations{s}
	}
	prev := s.cbt.w.OnKill
	s.cbt.w.OnKill = func(k combat.KillInfo) {
		s.lootOnKill(k)
		if prev != nil {
			prev(k)
		}
	}
}

// startItems runs the item journal (Start).
func (s *Server) startItems() {
	if s.itm.j == nil || s.itm.ran {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.itm.runCtx, s.itm.ran = cancel, true
	go s.itm.j.Run(ctx)
}

// stopItems flushes the journal (Stop, after the tick halted).
func (s *Server) stopItems(ctx context.Context) {
	if s.itm.j == nil || !s.itm.ran {
		return
	}
	s.itm.runCtx()
	if err := s.itm.j.Flush(ctx); err != nil {
		s.log.Error("item journal flush", "err", err, "left", s.itm.j.Depth())
	} else {
		s.log.Info("item journal flushed", "applied", s.itm.j.applied.Load())
	}
}

// ItemsPending is the number of item ops still queued for a character
// (WP16: a handoff waits for 0 before the next zone loads the inventory).
func (s *Server) ItemsPending(characterID string) int {
	if s.itm.j == nil {
		return 0
	}
	return s.itm.j.Pending(characterID)
}

// ItemsDepth is the journal depth (metrics, tests).
func (s *Server) ItemsDepth() int {
	if s.itm.j == nil {
		return 0
	}
	return s.itm.j.Depth()
}

func (s *Server) allocHandle() uint32 {
	s.itm.nextH++
	return s.itm.nextH
}

// ---- load / join / leave ----

// loadItems runs on the connection goroutine before join (like loadCombat).
func (s *Server) loadItems(characterID string, x *exploreState) *charItems {
	ci := &charItems{markers: map[string]bool{}}
	if x != nil && x.local != nil {
		ci.persist = persistLocal
		st := x.local.state
		for _, li := range st.Items {
			if it := fromLocalItem(li); it != nil {
				ci.inv.Items = append(ci.inv.Items, it)
			}
		}
		if st.Loot != nil {
			for _, k := range st.Loot.Markers {
				ci.markers[k] = true
			}
			ci.quick = st.Loot.Quick
		}
		return ci
	}
	if x != nil && x.readOnly {
		return ci // a local profile whose blob failed verification: nothing saves
	}
	if s.itm.j == nil {
		return ci
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	inv, markers, found, err := s.itm.setup.Store.LoadItems(ctx, characterID)
	if err != nil {
		// Never play on an empty inventory that would then be saved over
		// the real one: this session's items stay in memory only.
		s.log.Warn("items load failed; items this session are not saved", "character", characterID, "err", err)
		return ci
	}
	if !found {
		return ci
	}
	ci.persist = persistDB
	for _, it := range inv {
		if it.Def() == nil {
			s.log.Warn("unknown item base kept in the database, hidden this session", "character", characterID, "item", it.ID, "base", it.Base)
			continue
		}
		ci.inv.Items = append(ci.inv.Items, it)
	}
	for _, k := range markers {
		ci.markers[k] = true
	}
	return ci
}

func (s *Server) itemsOf(e *Entity) *charItems {
	if e == nil {
		return nil
	}
	if sess := s.byChar[e.CharacterID]; sess != nil && sess.ent == e {
		return sess.items
	}
	return nil
}

// itemsJoin finishes setup on the tick (after combatJoin).
func (s *Server) itemsJoin(sess *session) {
	adopted := s.adoptHanded(sess) // WP16: a handed-over character keeps its live items (items_handoff.go)
	ci := sess.items
	if ci == nil {
		ci = &charItems{markers: map[string]bool{}}
		sess.items = ci
	}
	ci.inv.Alloc = s.allocHandle
	for _, it := range ci.inv.Items {
		it.H = s.allocHandle()
	}
	if s.itm.j != nil {
		s.itm.j.clearPoison(sess.ent.CharacterID)
	}
	if adopted {
		s.syncAll(sess, "handoff sync") // first write at our epoch: fences the old owner's leftovers
	}
	s.topUpStarter(sess)
	if p := sess.ent.cbt; p != nil {
		p.OnDrink = func() (float64, bool) { return s.drink(sess) }
	}
	ci.gearVer = -1
	s.applyGear(sess)
	s.sendInventory(sess)
}

func (s *Server) grantStarter(sess *session) {
	ci := sess.items
	var d items.Delta
	now := s.cfg.Now().UnixMilli()
	for _, q := range items.D.Starter {
		it := items.Stack(q.Item, q.Qty)
		it.Prov = []items.Prov{{Ev: "starter", Char: sess.ent.CharacterID, At: now}}
		ci.inv.Add(it, &d)
	}
	ci.markers["starter"] = true
	ci.markers[starterPickaxeMarker] = true // the kit has one (items.yaml starter)
	if ci.persist == persistLocal {
		// Rides the next save point (no blob issued at join just for this).
		ci.version++
		if sess.x != nil && sess.x.prog != nil {
			sess.x.prog.MarkDirty()
		}
		return
	}
	s.commitItems(sess, &d, &GrantMark{Key: "starter"}, "starter")
}

// starterPickaxeMarker: the once-per-character pickaxe for characters
// created before the starter kit carried one (playtest 2: the starter
// quest says "mine sunsteel ore" and players had no pickaxe to see).
const starterPickaxeMarker = "starter:pickaxe"

// topUpStarter grants the starter kit to a new character, and the kit's
// later additions (the pickaxe, playtest 2) once to older ones.
func (s *Server) topUpStarter(sess *session) {
	ci := sess.items
	switch {
	case !ci.markers["starter"]:
		s.grantStarter(sess)
	case !ci.markers[starterPickaxeMarker]:
		s.grantStarterPickaxe(sess)
	}
}

// grantStarterPickaxe gives an older character the kit's pickaxe once,
// unless they already carry one (the kit's, bought, looted). Carrying one
// only sets the marker in memory: no journal op on every join for the
// characters the new kit already equipped (their "starter" marker is the
// only one stored). The stored marker comes with an actual grant, so a
// pickaxe sold or dropped after that is not replaced for free.
func (s *Server) grantStarterPickaxe(sess *session) {
	ci := sess.items
	ci.markers[starterPickaxeMarker] = true
	if ci.inv.Count("tool:pickaxe") > 0 || !ci.inv.CanFit("tool:pickaxe", 1) {
		return
	}
	var d items.Delta
	it := items.Stack("tool:pickaxe", 1)
	it.Prov = []items.Prov{{Ev: "starter", Char: sess.ent.CharacterID, At: s.cfg.Now().UnixMilli()}}
	ci.inv.Add(it, &d)
	if ci.persist == persistLocal {
		ci.version++ // rides the next save point, like the starter kit
		if sess.x != nil && sess.x.prog != nil {
			sess.x.prog.MarkDirty()
		}
		return
	}
	s.commitItems(sess, &d, &GrantMark{Key: starterPickaxeMarker}, "starter pickaxe")
}

// ---- persistence ----

// commitItems mirrors a delta to the character's persistence and tells the
// client. grant (optional) makes the op exactly-once.
func (s *Server) commitItems(sess *session, d *items.Delta, grant *GrantMark, note string) {
	ci := sess.items
	ci.version++
	switch ci.persist {
	case persistDB:
		if d.Empty() && grant == nil {
			break
		}
		op := &ItemOp{Char: sess.ent.CharacterID, Epoch: sess.ent.epoch, Grant: grant, Note: note}
		created, updated, deleted := d.Rows()
		for _, it := range created {
			op.Upsert = append(op.Upsert, ItemRow{Item: it, Owner: op.Char})
		}
		for _, it := range updated {
			op.Update = append(op.Update, ItemRow{Item: it, Owner: op.Char})
		}
		op.Delete = deleted
		s.enqueueItems(sess, op)
	case persistLocal:
		if sess.x != nil && sess.x.prog != nil {
			sess.x.prog.MarkDirty() // the next blob carries the items (itemsIntoLocal)
			s.saveProgressSoon(sess, false)
		}
	}
	s.sendInventory(sess)
}

func (s *Server) enqueueItems(sess *session, op *ItemOp) {
	if s.itm.j == nil {
		return
	}
	if !s.itm.j.Enqueue(op) {
		// Backlog full (database down for very long) or the character is
		// quarantined: memory is now ahead of anything that can be saved.
		// Kick so the next session reloads the database's state.
		s.log.Error("item journal refused an op; kicking so the inventory reloads", "character", op.Char, "note", op.Note)
		if sess != nil {
			s.kick(sess, proto.KickCodeShutdown, "inventory could not be saved; please reconnect")
		}
	}
}

// itemsIntoLocal copies a local profile's items into its save state
// (called by issueLocalSave).
func itemsIntoLocal(sess *session, st *localsave.State) {
	ci := sess.items
	if ci == nil || ci.persist != persistLocal {
		return
	}
	st.Items = st.Items[:0:0]
	for _, it := range ci.inv.Items {
		st.Items = append(st.Items, toLocalItem(it))
	}
	keys := make([]string, 0, len(ci.markers))
	for k := range ci.markers {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	st.Loot = &localsave.Loot{Markers: keys, Quick: ci.quick}
}

func toLocalItem(it *items.Item) localsave.Item {
	t, v := it.Tradeable, it.Verified
	return localsave.Item{ID: it.ID, Kind: it.Def().Kind, BaseID: it.Base, ItemLevel: it.Level, Rarity: it.Rarity,
		Affixes: it.AffixesJSON(), Sockets: it.SocketsJSON(), Slot: it.Slot, RollSeed: it.Seed,
		Qty: it.Qty, Tradeable: &t, Verified: &v, Provenance: it.ProvJSON(), Name: it.Name}
}

func fromLocalItem(li localsave.Item) *items.Item {
	it := &items.Item{ID: li.ID, Base: li.BaseID, Qty: max(1, li.Qty), Level: max(1, li.ItemLevel), Rarity: li.Rarity, Slot: li.Slot, Seed: li.RollSeed, Name: li.Name, Tradeable: true, Verified: true}
	if li.Tradeable != nil {
		it.Tradeable = *li.Tradeable
	}
	if li.Verified != nil {
		it.Verified = *li.Verified
	}
	it.SetAffixesJSON(li.Affixes)
	it.SetSocketsJSON(li.Sockets)
	it.SetProvJSON(li.Provenance)
	if it.Def() == nil || it.ID == "" {
		return nil
	}
	return it
}

// ---- wire ----

type inventoryJSON struct {
	V       int              `json:"v"`
	Gold    int              `json:"gold"`
	Quick   string           `json:"quick"`
	Persist string           `json:"persist"`
	Items   []items.WireItem `json:"items"`
}

var persistNames = [...]string{"memory", "db", "local"}

func (s *Server) sendInventory(sess *session) {
	ci := sess.items
	if ci == nil || sess.ent == nil {
		return
	}
	inv := inventoryJSON{V: 1, Gold: ci.inv.Gold(), Quick: ci.quick, Persist: persistNames[ci.persist], Items: make([]items.WireItem, 0, len(ci.inv.Items))}
	for _, it := range ci.inv.Items {
		inv.Items = append(inv.Items, it.Wire())
	}
	b, _ := json.Marshal(inv)
	s.sendEvent(sess, &proto.Event{Kind: EventInventory, EntityID: sess.ent.ID, Value: int32(inv.Gold), Data: b})
	s.questsChanged(sess) // quests.go: "hold items" objectives
}

func (s *Server) refuseItem(sess *session, kind, action uint8, reason int32) {
	s.sendEvent(sess, &proto.Event{Kind: EventItemRefused, EntityID: sess.ent.ID, TargetID: uint32(kind)<<8 | uint32(action), Value: reason})
}

func refusalOf(err error) int32 {
	switch {
	case errors.Is(err, items.ErrFull):
		return ItemRefuseFull
	case errors.Is(err, items.ErrNoItem):
		return ItemRefuseNoItem
	case errors.Is(err, items.ErrMissing):
		return ItemRefuseMissing
	case errors.Is(err, items.ErrBlueprint):
		return ItemRefuseBlueprint
	case errors.Is(err, items.ErrGold):
		return ItemRefuseGold
	case errors.Is(err, items.ErrSocket):
		return ItemRefuseSocket
	}
	return ItemRefuseNotAllow
}

type grantedJSON struct {
	B string `json:"b"`
	Q int    `json:"q"`
	R int    `json:"r"`
	N string `json:"n,omitempty"`
}

func (s *Server) sendGranted(sess *session, source int, got []*items.Item) {
	if len(got) == 0 {
		return
	}
	list := make([]grantedJSON, 0, len(got))
	for _, it := range got {
		list = append(list, grantedJSON{B: it.Base, Q: it.Qty, R: it.Rarity, N: it.Name})
	}
	b, _ := json.Marshal(list)
	s.sendEvent(sess, &proto.Event{Kind: EventLootGranted, EntityID: sess.ent.ID, TargetID: uint32(source), Value: int32(len(got)), Data: b})
}

// ---- gear, consumables ----

// applyGear pushes the inventory's gear into combat when items or the
// active loadout changed (itemsTick).
func (s *Server) applyGear(sess *session) {
	ci, e := sess.items, sess.ent
	if ci == nil || e == nil || e.cbt == nil {
		return
	}
	p := e.cbt
	pr := p.Profile
	if ci.gearVer == ci.version && ci.gearActive == pr.Active && !s.loadoutDrift(ci, pr) {
		return
	}
	changed := false
	for l := 0; l < 2; l++ {
		w := ci.inv.InSlot(items.MainSlot(l))
		lo := &pr.Loadouts[l]
		if w != nil {
			if ci.synced[l] != "" && lo.Weapon != ci.synced[l] {
				// The player picked a training weapon (WP13 combat Interact
				// equip): the item goes back to the bag.
				var d items.Delta
				if ci.inv.Unequip(items.MainSlot(l), &d) == nil {
					s.commitItems(sess, &d, nil, "unequip (training weapon)")
				}
				ci.synced[l] = ""
				if lo.Gem >= 0 {
					pr.SetGem(l, -1)
				}
				changed = true
				continue
			}
			g := ci.inv.Gear(l)
			if lo.Weapon != g.WeaponType {
				pr.EquipWeapon(l, g.WeaponType)
				changed = true
			}
			if lo.Gem != g.GemElement {
				pr.SetGem(l, g.GemElement)
				changed = true
			}
			ci.synced[l] = g.WeaponType
		} else if ci.synced[l] != "" {
			// The item left the main hand (unequipped, dropped, moved):
			// the hand falls back to the loadout's default training weapon
			// (combat.yaml start: the sword, the staff). Playtest 2: it kept
			// the item's weapon type, so after equipping a spear or a bow
			// there was no way back to the starter sword.
			ci.synced[l] = ""
			if lo.Gem >= 0 {
				pr.SetGem(l, -1)
				changed = true
			}
			if def := defaultWeapon(l); def != "" && lo.Weapon != def {
				pr.EquipWeapon(l, def)
				changed = true
			}
		}
	}
	g := ci.inv.Gear(pr.Active)
	p.SetGear(combat.Gear{WeaponMult: g.WeaponMult, DamagePct: g.DamagePct, SpellPower: g.SpellPower, CritPct: g.CritPct,
		Health: g.Health, ArmorPct: g.ArmorPct, FormMult: g.FormMult, KillsDemons: g.KillsDemons, Stagger: g.Stagger})
	ci.gearVer, ci.gearActive = ci.version, pr.Active
	n := s.consumableCount(ci)
	if n != ci.charges || p.Charges != n {
		ci.charges = n
		p.Charges = n
		changed = true
	}
	if _, look := weaponLooks(sess); look != e.TypeID&^(typePvPMask|TypeRiding) {
		changed = true // pt/ux: a different material (iron -> sunsteel sword) shows on the avatar
	}
	if changed {
		s.sendCombatSync(sess)
		s.saveCombat(sess, false)
	}
}

// defaultWeapon is loadout l's starting (training) weapon, what an empty
// main hand wields (combat.yaml start.loadouts: sword, staff).
func defaultWeapon(l int) string {
	if ls := combatdefs.D.Start.Loadouts; l >= 0 && l < len(ls) {
		return ls[l].Weapon
	}
	return ""
}

// loadoutDrift: a combat Interact changed a loadout's weapon away from the
// item WP14 put there.
func (s *Server) loadoutDrift(ci *charItems, pr *combat.Profile) bool {
	for l := 0; l < 2; l++ {
		if ci.synced[l] != "" && pr.Loadouts[l].Weapon != ci.synced[l] {
			return true
		}
	}
	return false
}

// quickConsumable is the consumable the drink key uses: the chosen one,
// else the strongest one held.
func (s *Server) quickConsumable(ci *charItems) string {
	if ci.quick != "" && ci.inv.Count(ci.quick) > 0 {
		return ci.quick
	}
	best, heal := "", 0.0
	for _, it := range ci.inv.Items {
		if d := it.Def(); d != nil && d.Kind == "consumable" && d.Heal > heal {
			best, heal = it.Base, d.Heal
		}
	}
	return best
}

func (s *Server) consumableCount(ci *charItems) int {
	q := s.quickConsumable(ci)
	if q == "" {
		return 0
	}
	return min(255, ci.inv.Count(q))
}

// drink spends one consumable when a drink starts (combat OnDrink).
func (s *Server) drink(sess *session) (float64, bool) {
	ci := sess.items
	if ci == nil {
		return 0, false
	}
	q := s.quickConsumable(ci)
	d := items.D.Item(q)
	if q == "" || d == nil {
		return 0, false
	}
	var dl items.Delta
	if !ci.inv.Spend(q, 1, &dl) {
		return 0, false
	}
	s.commitItems(sess, &dl, nil, "drink "+q)
	s.weatherAte(sess, q) // CR 030: warm food keeps the cold off
	n := s.consumableCount(ci)
	ci.charges = n
	sess.ent.cbt.Charges = n + 1 // Frame decrements after a successful spend
	return d.Heal, true
}

// ---- tick ----

// itemsTick: journal results, gear, world drop despawn, container lists.
func (s *Server) itemsTick(tick uint32, now time.Time) {
	s.itm.ldMu.Lock()
	later := s.itm.later
	s.itm.later = nil
	s.itm.ldMu.Unlock()
	for _, f := range later {
		f()
	}
	if s.itm.j != nil {
		for _, r := range s.itm.j.drainResults() {
			if r.err == nil {
				if r.op.Done != nil {
					r.op.Done()
				}
				continue
			}
			if r.char == "" {
				continue
			}
			if errors.Is(r.err, errItemsFenced) {
				continue // the character lives on another zone now (or came back newer): nothing to undo here
			}
			if sess := s.byChar[r.char]; sess != nil {
				s.kick(sess, proto.KickCodeShutdown, "inventory out of sync; please reconnect")
			}
		}
	}
	for _, sess := range s.sessions {
		if sess.items != nil && sess.ent != nil {
			s.applyGear(sess)
		}
	}
	// Dropped items despawn after DropDespawn (spec 8: 10 minutes); this
	// runs before miningTick's own pickup expiry so the row goes too.
	var expired []*Entity
	for _, e := range s.ents {
		if e.Kind == proto.EntityKindPickup && e.drop != nil && !now.Before(e.DespawnAt) {
			expired = append(expired, e)
		}
	}
	for _, p := range expired {
		s.removeEntity(p)
		if p.drop.world {
			s.log.Info("dropped item despawned", "item", p.drop.item.ID, "base", p.drop.item.Base, "qty", p.drop.item.Qty)
			if p.drop.persisted {
				s.enqueueItems(nil, &ItemOp{Delete: []string{p.drop.item.ID}, Note: "despawn"})
			}
		}
	}
	if s.itm.setup.Containers != nil && tick%containerEvery == 0 {
		for _, sess := range s.sessions {
			if sess.items != nil && sess.ent != nil {
				s.sendContainers(sess, false)
			}
		}
	}
}

// ---- interact ----

// itemInteract applies an item Interact (tick goroutine).
func (s *Server) itemInteract(sess *session, m *proto.Interact, now time.Time) {
	e, ci := sess.ent, sess.items
	if e == nil || ci == nil {
		return
	}
	switch m.TargetKind {
	case InteractContainer:
		if m.Action == ActionUse {
			s.openContainer(sess, m.TargetID, now)
		}
	case InteractItem:
		s.itemAction(sess, m)
	case InteractCraft:
		switch m.Action {
		case CraftActOpen:
			s.openCookStation(sess, m.TargetID)
		case CraftActCraft:
			s.craft(sess, int(m.Arg), now)
		}
	case InteractPickup:
		if m.Action == ActionUse {
			s.takeWorldPickup(sess, uint32(m.TargetID), now)
		}
	}
}

func (s *Server) itemAction(sess *session, m *proto.Interact) {
	ci, e := sess.items, sess.ent
	kind, act := uint8(m.TargetKind), m.Action
	var d items.Delta
	var err error
	note := ""
	switch act {
	case ItemActUnequip:
		slots := []string{items.EqMain0, items.EqMain1, items.EqHead, items.EqBody, items.EqLegs}
		if int(m.Arg) >= len(slots) {
			s.refuseItem(sess, kind, act, ItemRefuseNotAllow)
			return
		}
		err = ci.inv.Unequip(slots[m.Arg], &d)
		note = "unequip"
	case ItemActSocket:
		w, g := ci.inv.ByHandle(uint32(m.TargetID)), ci.inv.ByHandle(uint32(m.TargetID>>32))
		if w == nil || g == nil {
			err = items.ErrNoItem
			break
		}
		err = ci.inv.Socket(w, g, int(m.Arg), &d)
		note = "socket " + g.Base + " into " + w.Base
	case ItemActUnsocket:
		w := ci.inv.ByHandle(uint32(m.TargetID))
		if w == nil {
			err = items.ErrNoItem
			break
		}
		keep := s.nearSmith(e)
		var gem string
		gem, err = ci.inv.Unsocket(w, int(m.Arg), keep, &d)
		note = fmt.Sprintf("unsocket %s (kept %v)", gem, keep)
	case ItemActCombine:
		it := ci.inv.ByHandle(uint32(m.TargetID))
		if it == nil {
			err = items.ErrNoItem
			break
		}
		if !s.nearWaypoint(e) {
			s.refuseItem(sess, kind, act, ItemRefuseWaypoint)
			return
		}
		var out *items.Item
		out, err = ci.inv.Combine(it.Base, &d)
		if err == nil {
			out.Prov = []items.Prov{{Ev: "combined", Char: e.CharacterID, At: s.cfg.Now().UnixMilli()}}
			s.sendEvent(sess, &proto.Event{Kind: EventGemCombined, EntityID: e.ID, Value: 1, Data: []byte(out.Base)})
			note = "combine " + it.Base
		}
	default:
		it := ci.inv.ByHandle(uint32(m.TargetID))
		if it == nil {
			s.refuseItem(sess, kind, act, ItemRefuseNoItem)
			return
		}
		switch act {
		case ItemActUse:
			err = s.useItem(sess, it, &d)
			note = "use " + it.Base
		case ItemActDrop:
			s.dropItem(sess, it, int(m.Arg))
			return
		case ItemActEquip:
			def := it.Def()
			slot := items.MainSlot(int(m.Arg & 1))
			if def.Kind == "armor" {
				slot = items.ArmorSlot(def)
			}
			err = ci.inv.Equip(it, slot, &d)
			note = "equip " + it.Base
		case ItemActMove:
			p, _ := items.SlotPouch(it.Slot)
			if strings.HasPrefix(it.Slot, "eq:") {
				p = it.Def().Pouch
			}
			err = ci.inv.Move(it, p+":"+strconv.Itoa(int(m.Arg)), &d)
			note = "move"
		case ItemActQuick:
			if it.Def().Kind != "consumable" {
				err = items.ErrNotAllowed
				break
			}
			ci.quick = it.Base
			ci.version++
			s.sendInventory(sess)
			return
		default:
			err = items.ErrNotAllowed
		}
	}
	if err != nil {
		s.refuseItem(sess, kind, act, refusalOf(err))
		return
	}
	s.commitItems(sess, &d, nil, note)
}

// useItem: consumables become the drink key's choice (the drink itself is
// an input-frame action with combat timing), tomes teach their spell,
// arrows set the active loadout's arrowheads, gear equips.
func (s *Server) useItem(sess *session, it *items.Item, d *items.Delta) error {
	ci, e := sess.items, sess.ent
	def := it.Def()
	switch def.Kind {
	case "consumable":
		ci.quick = it.Base
		ci.version++
		return nil
	case "tome":
		if e.cbt == nil {
			return items.ErrNotAllowed
		}
		key := strings.TrimPrefix(it.Base, "tome:")
		if combatdefs.D.SpellByKey(key) == nil || !e.cbt.Profile.Grant(key) {
			return items.ErrNotAllowed
		}
		ci.inv.Spend(it.Base, 1, d)
		learnedSpellIntoSlot(e.cbt, key) // quests.go: no spellbook screen yet
		s.sendCombatSync(sess)
		s.saveCombat(sess, false)
		return nil
	case "ammo":
		if e.cbt == nil {
			return items.ErrNotAllowed
		}
		pr := e.cbt.Profile
		pr.Loadouts[pr.Active].ArrowOre = def.Arrow
		pr.EquipWeapon(pr.Active, pr.Loadouts[pr.Active].Weapon) // marks the profile dirty so the arrowheads save
		s.sendCombatSync(sess)
		s.saveCombat(sess, true)
		return nil
	case "weapon":
		return ci.inv.Equip(it, items.MainSlot(e.cbt.Profile.Active), d)
	case "armor":
		return ci.inv.Equip(it, items.ArmorSlot(def), d)
	}
	return items.ErrNotAllowed
}

// ---- places ----

func (s *Server) townProps() map[uint64]int {
	if s.itm.props == nil {
		s.itm.props = map[uint64]int{}
		if s.cfg.Towns != nil {
			for i, p := range s.cfg.Towns.T.Props {
				switch p.Kind {
				case towns.PropForge, towns.PropAnvil, propHearth, propCampfire:
					s.itm.props[p.ID] = i
				}
			}
		}
	}
	return s.itm.props
}

func (s *Server) nearProp(e *Entity, r float64, kinds ...uint8) bool {
	if s.cfg.Towns == nil {
		return false
	}
	pos := e.Move.Pos
	for _, i := range s.townProps() {
		p := &s.cfg.Towns.T.Props[i]
		if slices.Contains(kinds, p.Kind) && math.Hypot(p.X-pos.X, p.Z-pos.Z) <= r && math.Abs(p.Y-pos.Y) < 4 {
			return true
		}
	}
	return false
}

// nearSmith: spec 8 "unsocketing destroys the gem unless done at a town
// blacksmith" = within reach of a town forge or anvil.
func (s *Server) nearSmith(e *Entity) bool {
	return s.nearProp(e, smithNearM, towns.PropForge, towns.PropAnvil)
}

// nearWaypoint: spec 7 "three of a cut combine into the next at a waypoint".
func (s *Server) nearWaypoint(e *Entity) bool {
	if s.cfg.Explore == nil || s.cfg.Explore.Atlas == nil {
		return false
	}
	pos := e.Move.Pos
	for i := range s.cfg.Explore.Atlas.Sites {
		st := &s.cfg.Explore.Atlas.Sites[i]
		if st.IsWaypoint() && math.Hypot(st.X-pos.X, st.Z-pos.Z) <= waypointNearM {
			return true
		}
	}
	return false
}

// itemStations is the WP20 Config.Stations hook: a forge or anvil use
// opens smithing for this player. It returns false so WP20's Event 805
// still goes out: the client opens the forge panel on it.
type itemStations struct{ s *Server }

func (st itemStations) UseStation(e *Entity, station int, propID uint64, _ int) bool {
	s := st.s
	ci := s.itemsOf(e)
	if ci == nil {
		return false
	}
	if i, ok := s.townProps()[propID]; ok {
		p := &s.cfg.Towns.T.Props[i]
		ci.station = &openStation{kind: station, prop: propID, x: p.X, y: p.Y, z: p.Z}
	}
	return false
}

func (s *Server) openCookStation(sess *session, propID uint64) {
	e, ci := sess.ent, sess.items
	i, ok := s.townProps()[propID]
	if !ok {
		s.refuseItem(sess, InteractCraft, CraftActOpen, ItemRefuseStation)
		return
	}
	p := &s.cfg.Towns.T.Props[i]
	if p.Kind != propHearth && p.Kind != propCampfire {
		s.refuseItem(sess, InteractCraft, CraftActOpen, ItemRefuseStation)
		return
	}
	if eyeDist(e, p.X, p.Y+0.5, p.Z) > itemReachM {
		s.refuseItem(sess, InteractCraft, CraftActOpen, ItemRefuseTooFar)
		return
	}
	ci.station = &openStation{kind: StationCook, prop: propID, x: p.X, y: p.Y, z: p.Z}
	s.sendEvent(sess, &proto.Event{Kind: EventStation, EntityID: e.ID, TargetID: StationCook, Value: int32(s.smithing(e)), Data: binary.LittleEndian.AppendUint64(nil, propID)})
}

func (s *Server) smithing(e *Entity) int {
	if e.cbt == nil {
		return 0
	}
	return e.cbt.Profile.SkillLevel("smithing")
}

// craft runs a recipe at the open station.
func (s *Server) craft(sess *session, recipeID int, now time.Time) {
	e, ci := sess.ent, sess.items
	rc := items.D.RecipeByID(recipeID)
	if rc == nil {
		s.refuseItem(sess, InteractCraft, CraftActCraft, ItemRefuseNotAllow)
		return
	}
	st := ci.station
	// CR 025 camps: camp kits need no station; the workbench is a camp piece.
	if rc.Station != "camp" && (st == nil || math.Hypot(st.x-e.Move.Pos.X, st.z-e.Move.Pos.Z) > stationStayM ||
		(rc.Station == "forge" && st.kind != StationForge && st.kind != StationAnvil) || (rc.Station == "cook" && st.kind != StationCook) ||
		(rc.Station == "workbench" && st.kind != StationWorkbench)) {
		s.refuseItem(sess, InteractCraft, CraftActCraft, ItemRefuseStation)
		return
	}
	seed := items.Mix64(s.itm.boot ^ uint64(now.UnixNano()) ^ hashString(e.CharacterID) ^ uint64(rc.ID)<<48)
	var d items.Delta
	out, err := ci.inv.Craft(rc, s.smithing(e), seed, &d)
	if err != nil {
		s.refuseItem(sess, InteractCraft, CraftActCraft, refusalOf(err))
		return
	}
	out.Prov = append(out.Prov, items.Prov{Ev: "crafted", Char: e.CharacterID, Name: e.Name, Src: rc.Key, At: now.UnixMilli(), Local: ci.persist == persistLocal})
	s.log.Info("crafted", "character", e.CharacterID, "recipe", rc.Key, "item", out.Base, "qty", out.Qty, "rarity", out.Rarity, "sockets", len(out.Sockets), "rollSeed", seed)
	s.commitItems(sess, &d, nil, "craft "+rc.Key)
	b, _ := json.Marshal(out.Wire())
	s.sendEvent(sess, &proto.Event{Kind: EventCrafted, EntityID: e.ID, TargetID: uint32(rc.ID), Value: int32(out.Qty), Data: b})
	s.sendGranted(sess, SourceCraft, []*items.Item{out})
	if e.cbt != nil && rc.Station == "forge" {
		if lvl, up := e.cbt.Profile.AddSkillXP("smithing", int64(rc.XP)); up {
			if sk := combatdefs.D.SkillByKey("smithing"); sk != nil {
				s.sendEvent(sess, &proto.Event{Kind: combat.EvSkillUp, EntityID: e.ID, TargetID: uint32(sk.ID), Value: int32(lvl)})
			}
		}
		s.sendCombatSync(sess)
		s.saveCombat(sess, false)
	}
	s.announceIfBitchin(sess, out)
}

// ---- purchases (WP20 merchants; currency: CR 010) ----

// Buy implements the towns purchase hook: spend gold, add the item.
func (s *Server) Buy(e *Entity, item string, price int) error {
	sess := s.byChar[e.CharacterID]
	if sess == nil || sess.items == nil {
		return items.ErrNotAllowed
	}
	ci := sess.items
	def := items.D.Item(item)
	if def == nil {
		return items.ErrNoItem
	}
	if ci.inv.Gold() < price {
		s.refuseItem(sess, InteractNPC, ActionBuy, ItemRefuseGold)
		return items.ErrGold
	}
	if !ci.inv.CanFit(item, 1) {
		s.refuseItem(sess, InteractNPC, ActionBuy, ItemRefuseFull)
		return items.ErrFull
	}
	var d items.Delta
	ci.inv.Spend("currency:gold", price, &d)
	it := items.Stack(item, 1)
	if def.Kind == "weapon" || def.Kind == "armor" {
		it = items.RollEquipment(items.NewRNG(items.Mix64(s.itm.boot^uint64(s.cfg.Now().UnixNano()))), items.Rolled{Base: item, Level: def.Level, Luck: 1, Element: -1})
		it.Rarity, it.Affixes, it.Uniques, it.Name = 0, nil, nil, "" // shop stock is plain
	}
	it.Prov = []items.Prov{{Ev: "purchased", Char: e.CharacterID, Name: e.Name, Src: strconv.Itoa(price), At: s.cfg.Now().UnixMilli()}}
	ci.inv.Add(it, &d)
	s.commitItems(sess, &d, nil, "buy "+item)
	s.sendGranted(sess, SourcePurchase, []*items.Item{it})
	return nil
}

// ---- Bitchin' ----

func (s *Server) announceIfBitchin(sess *session, it *items.Item) {
	if !items.Announce(it) {
		return
	}
	text := fmt.Sprintf("%s found %s, a Bitchin' %s!", sess.ent.Name, it.DisplayName(), items.D.Item(it.Base).Name)
	s.log.Warn("BITCHIN' ROLL", "character", sess.ent.CharacterID, "name", sess.ent.Name, "item", it.Base, "displayName", it.Name, "rollSeed", it.Seed)
	b, _ := json.Marshal(map[string]any{"name": sess.ent.Name, "item": it.Base, "displayName": it.DisplayName(), "text": text})
	ev := proto.Encode(&proto.Event{Kind: EventBitchin, EntityID: sess.ent.ID, Data: b})
	for _, o := range s.sessions {
		_ = o.conn.SendReliable(ev)
	}
	if s.itm.setup.Announce != nil {
		s.itm.setup.Announce(text)
	}
}
