package game

// Playtest 2 taming and pet companions (CR 029, docs/cr/029-pets.md).
//
// Taming: carry a food a creature likes and weaken it below
// taming.weakenPct of its health (combat reports it: PetOutputs.Weakened).
// If the player who hurt it, or anyone within taming.smellM, carries one of
// its foods, the creature calms (it stands and sniffs for taming.calmS;
// Event 1201 to players near). E beside it feeds it (Interact 130/1: one
// food spent, the favourite first) and starts the taming meter (1202): it
// fills over the species' tameS while the tamer stays within taming.stayM,
// isn't hurt, and nothing hurts the creature. Then the zone rolls
// (content.RollTame: world seed, character, the character's roll count,
// the creature): tamed (the creature leaves the world, a pet record is
// added, maybe shiny or elemental) or it snatches the food and fights on.
//
// Pets: one is out with you (an ally in the combat world, combat/pets.go:
// it follows, fights what fights you, uses its ability, levels from the
// creatures it helped defeat), the rest wait in your stable: within
// taming.stableM of one of your camp pieces, or in any town, you can take
// another out, stable the one out, or release one (C → Your pets). 6
// follows / stays / attacks your target / comes back (7: stay or follow).
// Knocked out, it goes home to recover for taming.koRecoverS, then trots
// back to you. Feeding heals it, petting it is an emote others see.
//
// Persistence: the whole state is one JSON per character (character_pets,
// migration 0029, epoch-fenced like character_content; local profiles'
// save blob `pets`; a WP16 handoff field `pets` that carries the pet out
// with you across a border: the next zone puts it beside you).
//
// Wire: pets are ordinary snapshot entities (EntityKind effect, typeId
// combat.PetTypeID: one entity per player who has one out). Events
// 1200-1205 are sent only to pet owners, tamers and players near a calm
// creature or a pet's act, so the scale scenario (no pets, no taming:
// content is off there) is unchanged.

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"lodestone/server/pkg/contentdefs"
	"lodestone/server/pkg/movement"
	"lodestone/server/pkg/proto"
	"lodestone/server/pkg/writebehind"
	"lodestone/server/zone/internal/combat"
	"lodestone/server/zone/internal/content"
	"lodestone/server/zone/internal/items"
)

// InteractPet is contracts/events.md Interact 130 `pet`.
const InteractPet = 130

// Interact 130 actions.
const (
	PetActFeed    = 1  // targetId = the calm creature's entity id: feed it, start the taming meter
	PetActCommand = 2  // arg = PetCmd*, targetId = the enemy to attack (PetCmdAttack)
	PetActPet     = 3  // pet your pet (an emote)
	PetActFeedPet = 4  // feed your pet (heals it)
	PetActName    = 5  // targetId = pet id | chunk << 16, arg = 4 ASCII bytes (a 0 byte ends it)
	PetActTakeOut = 6  // targetId = pet id: out with you (at a stable)
	PetActStable  = 7  // the pet out goes to the stable (at a stable)
	PetActRelease = 8  // targetId = pet id: let it go for good
	PetActSync    = 9  // send 1200 again
	PetActDev     = 10 // dev builds: arg 1 foods, 2 a weakened creature of species targetId near you, 3 pet XP (targetId)
)

// Pet commands (Interact 130/2 arg).
const (
	PetCmdFollow = 1
	PetCmdStay   = 2
	PetCmdAttack = 3
	PetCmdCome   = 4
)

// Events 1200-1219 (contracts/events.md).
const (
	EventPetSync      = 1200
	EventTameCalm     = 1201
	EventTameProgress = 1202
	EventPetRefused   = 1203
	EventPetNote      = 1204
	EventPetAct       = 1205
)

// Taming meter phases (Event 1202 value).
const (
	TameStarted     = 1
	TameInterrupted = 2
	TameTamed       = 3
	TameFailed      = 4
)

// Interruption reasons (1202 data "reason").
const (
	TameWhyHit     = 1 // the creature was hurt
	TameWhyHurt    = 2 // you were hurt
	TameWhyAway    = 3 // you walked away
	TameWhyGone    = 4 // the creature is gone (or its calm ran out)
	TameWhyDowned  = 5
	TameWhyStopped = 6 // you left
)

// Refusals (Event 1203 value).
const (
	PetRefuseUnknown = 1
	PetRefuseNotCalm = 2  // nothing calm there
	PetRefuseFar     = 3  // too far
	PetRefuseNoFood  = 4  // you carry nothing it likes
	PetRefuseTaken   = 5  // someone else is taming it
	PetRefuseNoPet   = 6  // no pet out
	PetRefuseStable  = 7  // only at a stable: your camp or a town
	PetRefuseFull    = 8  // the stable is full
	PetRefuseName    = 9  // 1-16 letters, digits, spaces, ' or -
	PetRefuseKO      = 10 // it is recovering at home
	PetRefuseNotNow  = 11 // you are down
	PetRefuseBusy    = 12 // you are already taming something
)

// Notes (Event 1204 value).
const (
	PetNoteLevel    = 1
	PetNoteKO       = 2
	PetNoteBack     = 3
	PetNoteStabled  = 4 // tamed with a pet already out: it went to the stable
	PetNoteReleased = 5
	PetNoteNamed    = 6
)

// Pet acts (Event 1205 value).
const (
	PetActAbility = 1
	PetActPetted  = 2
	PetActFed     = 3
	PetActKO      = 4
	PetActArrived = 5
)

// EmotePet is the content.yaml emote "pet" (the zone sends it when you pet your pet).
const EmotePet = 25

const (
	petSaveKey   = "pets:"
	petSaveEvery = 8 * time.Second
	petNameMax   = 16
	petSeeM      = 48.0
	petPetReachM = 4.0
	petFeedReach = 5.0
)

// petSess is one session's pets.
type petSess struct {
	st       *content.PetState
	out      uint32 // the active pet's entity id while it is in the world
	dirty    bool
	lastSave time.Time
	label    []byte
	labelFor int
	tame     *tameRun
	stable   bool // at a stable at the last check (1200 says so)
	petted   time.Time // the last petting (one per 1.5 s reaches others)
}

// tameRun is the taming meter running for a session.
type tameRun struct {
	creature uint32
	sp       *contentdefs.PetSpecies
	food     string
	fav      bool
	start    uint32 // combat tick
	end      uint32
	health   uint16 // the tamer's health at the start
}

// calmRec is a creature calmed for taming.
type calmRec struct {
	sp    *contentdefs.PetSpecies
	tamer string // character taming it ("" none)
}

// petGlue is the server-wide part.
type petGlue struct {
	handed    map[string]*petHanded
	calm      map[uint32]*calmRec
	devWeaken map[*combat.Group]string
}

type petHanded struct {
	St json.RawMessage `json:"st"`
	HP float64         `json:"hp"` // the pet out: its health share (-1: none out)
}

func init() {
	RegisterHandoffField(HandoffField{
		Name: "pets",
		Save: func(s *Server, e *Entity) json.RawMessage {
			sess := s.byChar[e.CharacterID]
			if sess == nil || sess.pets == nil || len(sess.pets.st.Pets) == 0 {
				return nil
			}
			s.petSyncHP(sess)
			b, _ := json.Marshal(petHanded{St: sess.pets.st.JSON(), HP: -1})
			return b
		},
		Load: func(s *Server, e *Entity, data json.RawMessage) {
			var h petHanded
			if json.Unmarshal(data, &h) != nil {
				return
			}
			if s.petsG.handed == nil {
				s.petsG.handed = map[string]*petHanded{}
			}
			s.petsG.handed[e.CharacterID] = &h
		},
	})
}

func (s *Server) initPets() {
	s.petsG.calm = map[uint32]*calmRec{}
	if !s.contentOn() || s.cbt.w == nil {
		return // taming needs the world's content (the scale worlds have none)
	}
	w := s.cbt.w
	w.Tameable = map[int]bool{}
	w.TameWeakenPct = contentdefs.D.Taming.WeakenPct
	for _, sp := range contentdefs.D.Taming.Species {
		w.Tameable[sp.EnemyID] = true
	}
}

// ---- persistence ----

// PetStore persists pet states (PGStore implements it).
type PetStore interface {
	LoadPets(ctx context.Context, characterID string) ([]byte, bool, error)
	SavePets(ctx context.Context, characterID string, data []byte, epoch int64) error
}

// LoadPets implements PetStore.
func (p *PGStore) LoadPets(ctx context.Context, id string) ([]byte, bool, error) {
	if !uuidRe.MatchString(id) {
		return nil, false, nil
	}
	var b []byte
	err := p.Pool.QueryRow(ctx, `SELECT data FROM character_pets WHERE character_id = $1::uuid`, id).Scan(&b)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	return b, err == nil, err
}

// SavePets implements PetStore (epoch-fenced like SaveContent).
func (p *PGStore) SavePets(ctx context.Context, id string, data []byte, epoch int64) error {
	if !uuidRe.MatchString(id) {
		return ErrNoRow
	}
	_, err := p.Pool.Exec(ctx, `
		INSERT INTO character_pets (character_id, data, epoch, updated_at) VALUES ($1::uuid, $2::jsonb, $3, now())
		ON CONFLICT (character_id) DO UPDATE SET data = EXCLUDED.data, epoch = GREATEST(character_pets.epoch, EXCLUDED.epoch), updated_at = now()
		WHERE EXCLUDED.epoch = 0 OR character_pets.epoch <= EXCLUDED.epoch`, id, string(data), epoch)
	var pe *pgconn.PgError
	if errors.As(err, &pe) && pe.Code == "23503" {
		return ErrNoRow
	}
	return err
}

// loadPets runs on the connection goroutine before join.
func (s *Server) loadPets(characterID string, x *exploreState) *petSess {
	ps := &petSess{st: &content.PetState{V: 1}}
	if x != nil && x.local != nil {
		ps.st = content.LoadPets(x.local.state.Pets)
		return ps
	}
	store, ok := s.cfg.Store.(PetStore)
	if !ok || s.cfg.Store == nil {
		return ps
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	b, found, err := store.LoadPets(ctx, characterID)
	if err != nil {
		s.log.Warn("pets load failed; none this session", "character", characterID, "err", err)
	}
	if found {
		ps.st = content.LoadPets(b)
	}
	return ps
}

// petsIntoLocal copies the pets into a local save's state (localState).
func petsIntoLocal(sess *session, raw *json.RawMessage) {
	ps := sess.pets
	if ps == nil || (len(ps.st.Pets) == 0 && ps.st.Rolls == 0) {
		return
	}
	*raw = ps.st.JSON()
	ps.dirty = false
}

// petSyncHP copies the pet out's health into its record.
func (s *Server) petSyncHP(sess *session) {
	ps := sess.pets
	if ps == nil || ps.out == 0 {
		return
	}
	en := s.cbt.w.Summon(ps.out)
	rec := ps.st.ActivePet()
	if en == nil || rec == nil || !en.IsPet() {
		return
	}
	hp := math.Round(en.HP/math.Max(1, en.HPMax)*1000) / 1000
	if hp != rec.HP {
		rec.HP = hp
		ps.dirty = true
	}
	mode, _ := en.PetMode()
	ps.st.Mode = mode
}

// savePets persists a changed state: accounts through the write-behind
// queue (coalesced per character), local profiles in the next save blob.
func (s *Server) savePets(sess *session) {
	ps, e := sess.pets, sess.ent
	if ps == nil || e == nil {
		return
	}
	s.petSyncHP(sess)
	if !ps.dirty || s.cfg.Queue == nil {
		return
	}
	ps.lastSave = s.cfg.Now()
	if sess.x != nil && sess.x.local != nil {
		sess.x.prog.MarkDirty() // petsIntoLocal copies them into the blob
		s.saveProgressSoon(sess, false)
		return
	}
	store, ok := s.cfg.Store.(PetStore)
	if !ok || s.cfg.Store == nil {
		return
	}
	ps.dirty = false
	data, id, epoch, log := ps.st.JSON(), e.CharacterID, e.epoch, s.log
	s.cfg.Queue.Enqueue(writebehind.Op{Key: petSaveKey + id, Run: func(ctx context.Context) error {
		err := store.SavePets(ctx, id, data, epoch)
		if err != nil && errors.Is(err, writebehind.ErrSkip) {
			if _, seen := loggedMissing.LoadOrStore(petSaveKey+id, true); !seen {
				log.Info("pets save skipped: no character row", "character", id)
			}
		}
		return err
	}})
}

func (s *Server) petChanged(sess *session) {
	sess.pets.dirty = true
	s.savePets(sess)
	s.sendPetSync(sess)
}

// ---- join, leave ----

func (s *Server) petJoin(sess *session) {
	e := sess.ent
	if e == nil {
		return
	}
	if sess.pets == nil {
		sess.pets = &petSess{st: &content.PetState{V: 1}}
	}
	ps := sess.pets
	if h, ok := s.petsG.handed[e.CharacterID]; ok {
		delete(s.petsG.handed, e.CharacterID)
		ps.st = content.LoadPets(h.St)
	}
	ps.stable = s.atStable(e)
	if len(ps.st.Pets) > 0 { // nothing for everyone else (the scale scenario's wire is unchanged)
		s.sendPetSync(sess)
	}
	s.petEnsureOut(sess, false)
}

func (s *Server) petLeave(sess *session) {
	ps := sess.pets
	if ps == nil || sess.ent == nil {
		return
	}
	if ps.tame != nil {
		s.tameStop(sess, TameWhyStopped)
	}
	s.petSyncHP(sess)
	if ps.out != 0 {
		if en := s.cbt.w.Summon(ps.out); en != nil && en.IsPet() {
			s.cbt.w.RemovePet(en)
		}
		ps.out = 0
	}
	if ps.dirty {
		s.savePets(sess)
	}
}

// ---- the pet in the world ----

// petSpec is a record's pet as the combat world needs it.
func (s *Server) petSpec(sess *session, rec *content.PetRec) (combat.PetSpec, bool) {
	sp := rec.Def()
	if sp == nil {
		return combat.PetSpec{}, false
	}
	t := &contentdefs.D.Taming
	hpMax, dmg := content.PetStats(sp, rec.Level, rec.Variant)
	ab := contentdefs.D.PetAbility(sp.Ability)
	cab := combat.PetAbility{}
	if ab != nil {
		cab = combat.PetAbility{ID: ab.ID, Kind: ab.Kind, CooldownS: ab.CooldownS, Power: ab.Power, HealBelow: ab.HealBelow, Party: ab.Party, DurationS: ab.DurationS,
			RangeMin: ab.RangeM[0], RangeMax: ab.RangeM[1], RadiusM: ab.RadiusM, Status: ab.Status, Element: ab.Element}
		if rec.Variant == content.VariantElemental && rec.Element >= 0 && cab.Kind != "heal" && cab.Kind != "buff" {
			cab.Element = rec.Element
		}
	}
	el := -1
	if rec.Variant == content.VariantElemental {
		el = rec.Element
	}
	hp := rec.HP
	if hp <= 0 {
		hp = 1
	}
	return combat.PetSpec{
		Owner: sess.ent.ID, Slot: rec.ID, Enemy: sp.Enemy, Level: rec.Level, Element: el, Shiny: rec.Variant == content.VariantShiny,
		HPMax: hpMax, HP: hpMax * hp, Damage: dmg, Speed: sp.Speed, Reach: sp.Attack.Reach, EveryMs: sp.Attack.EveryMs, WindupMs: sp.Attack.WindupMs,
		Ability: cab, AggroM: t.AggroM, LeashM: t.LeashM, FollowM: t.FollowM, WarpM: t.WarpM, GuardM: t.StayGuardM, RegenPctS: t.RegenPctS,
		Mode: sess.pets.st.Mode,
	}, true
}

// petEntityName is a pet's nameplate: "Nicole's Bramble".
func (s *Server) petEntityName(en *combat.Enemy) string {
	o := s.entityByID(en.Owner())
	if o == nil {
		return ""
	}
	sess := s.byChar[o.CharacterID]
	if sess == nil || sess.pets == nil {
		return o.Name + "'s pet"
	}
	rec := sess.pets.st.Pet(en.PetSlot())
	if rec == nil {
		return o.Name + "'s pet"
	}
	return o.Name + "'s " + rec.Name
}

// petEnsureOut puts the active pet in the world when it should be there
// (after join, back from a knockout, taken out of the stable). at: spawn
// where the tamed creature stood instead of beside the owner.
func (s *Server) petEnsureOut(sess *session, arrived bool, at ...movement.Vec3) {
	ps, e := sess.pets, sess.ent
	if ps == nil || e == nil || ps.out != 0 || e.cbt == nil || e.cbt.Downed {
		return
	}
	rec := ps.st.ActivePet()
	if rec == nil || rec.KOUntil > s.cfg.Now().UnixMilli() {
		return
	}
	spec, ok := s.petSpec(sess, rec)
	if !ok {
		return
	}
	yaw := e.Yaw
	spec.Pos = movement.Vec3{X: e.Move.Pos.X + math.Sin(yaw)*2.4 + math.Cos(yaw)*1.2, Z: e.Move.Pos.Z + math.Cos(yaw)*2.4 - math.Sin(yaw)*1.2}
	if len(at) > 0 {
		spec.Pos = at[0]
	}
	en := s.cbt.w.SpawnPet(spec)
	if en == nil {
		return
	}
	ps.out = en.ID
	if arrived {
		s.petActEvent(en.ID, PetActArrived, uint32(rec.ID), en.Pos, nil)
	}
	s.sendPetSync(sess)
}

// petTakeIn takes the pet out of the world (its health saved).
func (s *Server) petTakeIn(sess *session) {
	ps := sess.pets
	if ps.out == 0 {
		return
	}
	s.petSyncHP(sess)
	if en := s.cbt.w.Summon(ps.out); en != nil && en.IsPet() {
		s.cbt.w.RemovePet(en)
	}
	ps.out = 0
}

// atStable: within taming.stableM of one of your camp pieces, or in a
// town. A world with neither towns nor camps has no stables: anywhere.
func (s *Server) atStable(e *Entity) bool {
	if e == nil {
		return false
	}
	p := e.Move.Pos
	r := contentdefs.D.Taming.StableM
	for _, pc := range s.camp.byOwner[e.CharacterID] {
		if math.Hypot(pc.X-p.X, pc.Z-p.Z) <= r {
			return true
		}
	}
	if s.cfg.Towns == nil {
		return !s.campsOn()
	}
	return campEnv{s}.InTown(p.X, p.Z, 8)
}

// ---- events ----

type petJSON struct {
	ID      int     `json:"id"`
	Species string  `json:"sp"`
	Name    string  `json:"name"`
	Variant int     `json:"variant"`
	Element int     `json:"el"`
	Level   int     `json:"lv"`
	XP      int     `json:"xp"`
	Next    int     `json:"next"`
	HP      float64 `json:"hp"`
	HPMax   float64 `json:"hpMax"`
	Damage  float64 `json:"dmg"`
	KOMs    int64   `json:"koMs"`
	Active  bool    `json:"active"`
	Out     uint32  `json:"out"` // its entity id while it is in the world
	Kills   int     `json:"kills"`
	TamedAt int64   `json:"tamedAt"`
}

type petSyncJSON struct {
	Pets   []petJSON `json:"pets"`
	Active int       `json:"active"`
	Mode   int       `json:"mode"`
	Stable bool      `json:"stable"`
	Max    int       `json:"max"`
}

// sendPetSync is Event 1200: your pets (to you).
func (s *Server) sendPetSync(sess *session) {
	ps, e := sess.pets, sess.ent
	if ps == nil || e == nil {
		return
	}
	s.petSyncHP(sess)
	now := s.cfg.Now().UnixMilli()
	j := petSyncJSON{Pets: []petJSON{}, Active: ps.st.Active, Mode: ps.st.Mode, Stable: ps.stable, Max: contentdefs.D.Taming.MaxPets}
	for i := range ps.st.Pets {
		r := &ps.st.Pets[i]
		sp := r.Def()
		if sp == nil {
			continue
		}
		hpMax, dmg := content.PetStats(sp, r.Level, r.Variant)
		pj := petJSON{ID: r.ID, Species: r.Species, Name: r.Name, Variant: r.Variant, Element: r.Element, Level: r.Level, XP: r.XP, HP: r.HP, HPMax: hpMax, Damage: math.Round(dmg*10) / 10, Active: r.ID == ps.st.Active, Kills: r.Kills, TamedAt: r.TamedAt}
		if r.Level < contentdefs.D.Taming.LevelMax {
			pj.Next = contentdefs.D.PetXPToNext(r.Level)
		}
		if r.KOUntil > now {
			pj.KOMs = r.KOUntil - now
		}
		if pj.Active {
			pj.Out = ps.out
		}
		j.Pets = append(j.Pets, pj)
	}
	b, _ := json.Marshal(j)
	s.sendEvent(sess, &proto.Event{Kind: EventPetSync, EntityID: e.ID, Value: int32(len(j.Pets)), TargetID: ps.out, Data: b})
}

func (s *Server) petRefuse(sess *session, action uint8, reason int, target uint32) {
	s.sendEvent(sess, &proto.Event{Kind: EventPetRefused, EntityID: sess.ent.ID, TargetID: target, Value: int32(reason), Data: []byte{action}})
}

func (s *Server) petNote(sess *session, kind int, pet int, text string) {
	s.sendEvent(sess, &proto.Event{Kind: EventPetNote, EntityID: sess.ent.ID, TargetID: uint32(pet), Value: int32(kind), Data: []byte(text)})
}

// petActEvent is Event 1205 to players within petSeeM of the pet.
func (s *Server) petActEvent(pet uint32, act int, target uint32, at movement.Vec3, data []byte) {
	ev := proto.Encode(&proto.Event{Kind: EventPetAct, EntityID: pet, TargetID: target, Value: int32(act), X: cm(at.X), Y: cm(at.Y), Z: cm(at.Z), Data: data})
	for _, o := range s.sessions {
		if o.ent == nil || math.Hypot(o.ent.Move.Pos.X-at.X, o.ent.Move.Pos.Z-at.Z) > petSeeM {
			continue
		}
		if err := o.conn.SendReliable(ev); err != nil {
			o.closed.Store(true)
		}
	}
}

// tameNear sends a taming Event to players within petSeeM of at (and to the tamer).
func (s *Server) tameNear(ev *proto.Event, at movement.Vec3, also *session) {
	b := proto.Encode(ev)
	for _, o := range s.sessions {
		if o.ent == nil || (o != also && math.Hypot(o.ent.Move.Pos.X-at.X, o.ent.Move.Pos.Z-at.Z) > petSeeM) {
			continue
		}
		if err := o.conn.SendReliable(b); err != nil {
			o.closed.Store(true)
		}
	}
}

type tameJSON struct {
	Species string `json:"sp"`
	Food    string `json:"food,omitempty"`
	Fav     bool   `json:"fav,omitempty"`
	Reason  int    `json:"reason,omitempty"`
	Variant int    `json:"variant,omitempty"`
	Element int    `json:"el,omitempty"`
	Name    string `json:"name,omitempty"`
	By      uint32 `json:"by"`
	Ms      int64  `json:"ms,omitempty"`
}

func (s *Server) tameEvent(creature uint32, phase int, target uint32, at movement.Vec3, j tameJSON, tamer *session) {
	b, _ := json.Marshal(j)
	s.tameNear(&proto.Event{Kind: EventTameProgress, EntityID: creature, TargetID: target, Value: int32(phase), X: cm(at.X), Y: cm(at.Y), Z: cm(at.Z), Data: b}, at, tamer)
}

func (s *Server) calmEvent(en *combat.Enemy, sp *contentdefs.PetSpecies, ms int64) {
	s.tameNear(&proto.Event{Kind: EventTameCalm, EntityID: en.ID, TargetID: uint32(sp.ID), Value: int32(ms), X: cm(en.Pos.X), Y: cm(en.Pos.Y), Z: cm(en.Pos.Z)}, en.Pos, nil)
}

// ---- the tick ----

func (s *Server) petsTick(tick uint32) {
	w := s.cbt.w
	if w == nil {
		return
	}
	out := w.DrainPets()
	for _, wk := range out.Weakened {
		s.petWeakened(wk.Enemy, wk.By)
	}
	for _, id := range out.CalmBroken {
		s.calmOver(id, TameWhyHit)
	}
	for id := range s.petsG.calm {
		if en := w.Enemy(id); en == nil || !en.Calm(w.Tick()) {
			s.calmOver(id, TameWhyGone)
		}
	}
	for _, ko := range out.KO {
		s.petKO(ko)
	}
	for _, x := range out.XP {
		s.petXP(x)
	}
	for _, a := range out.Acts {
		data := binary.LittleEndian.AppendUint32(nil, a.Target)
		s.petActEvent(a.Pet, PetActAbility, uint32(a.Ability), a.Pos, data)
	}
	if len(s.petsG.devWeaken) > 0 {
		s.petDevWeakenTick()
	}
	now := s.cfg.Now()
	for _, sess := range s.sessions {
		ps := sess.pets
		if ps == nil || sess.ent == nil {
			continue
		}
		if ps.tame != nil {
			s.tameTick(sess)
		}
		if len(ps.st.Pets) == 0 || (tick+sess.ent.ID)%30 != 0 {
			continue
		}
		// once a second: back from a knockout, the stable, saves
		if ps.out == 0 && ps.st.Active != 0 {
			if rec := ps.st.ActivePet(); rec != nil && rec.KOUntil != 0 && rec.KOUntil <= now.UnixMilli() {
				rec.KOUntil = 0
				rec.HP = 0.5
				ps.dirty = true
				s.petEnsureOut(sess, true)
				if ps.out != 0 {
					s.petNote(sess, PetNoteBack, rec.ID, rec.Name+" has recovered and comes running back")
				}
			} else {
				s.petEnsureOut(sess, true)
			}
		}
		if st := s.atStable(sess.ent); st != ps.stable {
			ps.stable = st
			s.sendPetSync(sess)
		}
		if ps.out != 0 && s.cbt.w.Summon(ps.out) == nil {
			ps.out = 0 // removed without us (a full reset)
		}
		if (ps.dirty || ps.out != 0) && now.Sub(ps.lastSave) >= petSaveEvery {
			s.petSyncHP(sess)
			if ps.dirty {
				s.savePets(sess)
			}
		}
	}
}

// ownerSession is the session of the player with entity id.
func (s *Server) ownerSession(id uint32) *session {
	e := s.entityByID(id)
	if e == nil || e.Kind != proto.EntityKindPlayer {
		return nil
	}
	return s.byChar[e.CharacterID]
}

func (s *Server) petKO(ko combat.PetKO) {
	sess := s.ownerSession(ko.Owner)
	if sess == nil || sess.pets == nil {
		return
	}
	ps := sess.pets
	rec := ps.st.Pet(ko.Slot)
	if rec == nil {
		return
	}
	pos := sess.ent.Move.Pos
	if ps.out != 0 {
		if en := s.cbt.w.Summon(ps.out); en != nil {
			pos = en.Pos
		}
	}
	s.petActEvent(ps.out, PetActKO, uint32(rec.ID), pos, nil)
	ps.out = 0
	rec.HP = 0
	rec.KOUntil = s.cfg.Now().Add(time.Duration(contentdefs.D.Taming.KORecoverS * float64(time.Second))).UnixMilli()
	s.petNote(sess, PetNoteKO, rec.ID, rec.Name+" was knocked out and limps home to recover")
	s.petChanged(sess)
}

func (s *Server) petXP(x combat.PetXP) {
	sess := s.ownerSession(x.Owner)
	if sess == nil || sess.pets == nil {
		return
	}
	ps := sess.pets
	rec := ps.st.Pet(x.Slot)
	if rec == nil {
		return
	}
	rec.Kills++
	ps.dirty = true
	if up := rec.GainXP(int(math.Round(x.XP))); up > 0 {
		if en := s.cbt.w.Summon(ps.out); en != nil && en.IsPet() && en.PetSlot() == rec.ID {
			if spec, ok := s.petSpec(sess, rec); ok {
				s.cbt.w.UpdatePet(en, spec)
				s.cbt.w.HealPet(en, 0.25)
			}
			if ent := s.cbt.byID[en.ID]; ent != nil {
				ent.Level = uint8(min(255, rec.Level))
			}
		}
		s.petNote(sess, PetNoteLevel, rec.ID, rec.Name+" reached level "+itoa(rec.Level))
		if sess.cnt != nil {
			s.contentFeats(sess)
		}
	}
	s.sendPetSync(sess)
}

// ---- taming ----

// petWeakened: a tameable creature fell below the weaken share. It calms
// if the player who hurt it, or someone within smellM, carries its food.
func (s *Server) petWeakened(en *combat.Enemy, by uint32) {
	if en == nil || !en.Alive() || en.Def == nil {
		return
	}
	sp := contentdefs.D.PetByEnemy(en.Def.Key)
	if sp == nil {
		return
	}
	t := &contentdefs.D.Taming
	carrier := false
	check := func(sess *session) {
		if !carrier && sess != nil && sess.items != nil && sess.ent != nil {
			if f, _ := content.LikedFood(sp, sess.items.inv.Count); f != "" {
				carrier = true
			}
		}
	}
	check(s.ownerSession(by))
	for _, sess := range s.sessions {
		if carrier {
			break
		}
		if sess.ent != nil && math.Hypot(sess.ent.Move.Pos.X-en.Pos.X, sess.ent.Move.Pos.Z-en.Pos.Z) <= t.SmellM {
			check(sess)
		}
	}
	if !carrier {
		return
	}
	s.cbt.w.Calm(en, t.CalmS)
	s.petsG.calm[en.ID] = &calmRec{sp: sp}
	s.calmEvent(en, sp, int64(t.CalmS*1000))
}

// calmOver ends a calm (a hit, it ran out, it is gone) and any meter on it.
func (s *Server) calmOver(id uint32, why int) {
	rec := s.petsG.calm[id]
	if rec == nil {
		return
	}
	delete(s.petsG.calm, id)
	if rec.tamer != "" {
		if sess := s.byChar[rec.tamer]; sess != nil && sess.pets != nil && sess.pets.tame != nil && sess.pets.tame.creature == id {
			s.tameStop(sess, why)
		}
	}
	at := movement.Vec3{}
	if en := s.cbt.w.Enemy(id); en != nil {
		at = en.Pos
		s.calmEvent(en, rec.sp, 0)
	}
	_ = at
}

// tameFeed is Interact 130/1: feed a calm creature, start the meter.
func (s *Server) tameFeed(sess *session, id uint32) {
	e, ps := sess.ent, sess.pets
	w := s.cbt.w
	en := w.Enemy(id)
	rec := s.petsG.calm[id]
	switch {
	case e.cbt == nil || e.cbt.Downed:
		s.petRefuse(sess, PetActFeed, PetRefuseNotNow, id)
		return
	case ps.tame != nil:
		s.petRefuse(sess, PetActFeed, PetRefuseBusy, id)
		return
	case en == nil || rec == nil || !en.Calm(w.Tick()):
		s.petRefuse(sess, PetActFeed, PetRefuseNotCalm, id)
		return
	case rec.tamer != "" && rec.tamer != e.CharacterID:
		s.petRefuse(sess, PetActFeed, PetRefuseTaken, id)
		return
	case math.Hypot(en.Pos.X-e.Move.Pos.X, en.Pos.Z-e.Move.Pos.Z) > contentdefs.D.Taming.FeedReachM+en.Radius() || math.Abs(en.Pos.Y-e.Move.Pos.Y) > 3:
		s.petRefuse(sess, PetActFeed, PetRefuseFar, id)
		return
	case sess.items == nil:
		s.petRefuse(sess, PetActFeed, PetRefuseNoFood, id)
		return
	}
	food, fav := content.LikedFood(rec.sp, sess.items.inv.Count)
	if food == "" {
		s.petRefuse(sess, PetActFeed, PetRefuseNoFood, id)
		return
	}
	var d items.Delta
	if !sess.items.inv.Spend(food, 1, &d) {
		s.petRefuse(sess, PetActFeed, PetRefuseNoFood, id)
		return
	}
	s.commitItems(sess, &d, nil, "tame "+rec.sp.Key)
	secs := content.TameTime(rec.sp, fav)
	tk := w.Tick()
	ps.tame = &tameRun{creature: id, sp: rec.sp, food: food, fav: fav, start: tk, end: tk + uint32(math.Round(secs*30)), health: e.Health}
	rec.tamer = e.CharacterID
	w.ExtendCalm(en, secs+3)
	ms := int64(math.Round(secs * 1000))
	s.tameEvent(id, TameStarted, uint32(ms), en.Pos, tameJSON{Species: rec.sp.Key, Food: food, Fav: fav, By: e.ID, Ms: ms}, sess)
}

// tameStop interrupts sess's meter.
func (s *Server) tameStop(sess *session, why int) {
	ps := sess.pets
	tr := ps.tame
	if tr == nil {
		return
	}
	ps.tame = nil
	at := sess.ent.Move.Pos
	en := s.cbt.w.Enemy(tr.creature)
	if en != nil {
		at = en.Pos
	}
	if rec := s.petsG.calm[tr.creature]; rec != nil && rec.tamer == sess.ent.CharacterID {
		rec.tamer = ""
	}
	if why == TameWhyHurt || why == TameWhyAway {
		// it startles: the calm is over and it turns on you
		if en != nil {
			delete(s.petsG.calm, tr.creature)
			s.cbt.w.EndCalm(en, sess.ent.ID)
			s.calmEvent(en, tr.sp, 0)
		}
	}
	s.tameEvent(tr.creature, TameInterrupted, 0, at, tameJSON{Species: tr.sp.Key, Reason: why, By: sess.ent.ID}, sess)
}

// tameTick checks a running meter: walked off, hurt, done.
func (s *Server) tameTick(sess *session) {
	e, ps := sess.ent, sess.pets
	tr := ps.tame
	w := s.cbt.w
	en := w.Enemy(tr.creature)
	switch {
	case en == nil || !en.Alive() || !en.Calm(w.Tick()):
		s.tameStop(sess, TameWhyGone)
		return
	case e.cbt != nil && e.cbt.Downed:
		s.tameStop(sess, TameWhyDowned)
		return
	case e.Health < tr.health:
		s.tameStop(sess, TameWhyHurt)
		return
	case math.Hypot(en.Pos.X-e.Move.Pos.X, en.Pos.Z-e.Move.Pos.Z) > contentdefs.D.Taming.StayM:
		s.tameStop(sess, TameWhyAway)
		return
	}
	tr.health = max(tr.health, e.Health)
	if w.Tick() < tr.end {
		return
	}
	s.tameFinish(sess, en)
}

// tameFinish rolls the taming.
func (s *Server) tameFinish(sess *session, en *combat.Enemy) {
	e, ps := sess.ent, sess.pets
	tr := ps.tame
	ps.tame = nil
	w := s.cbt.w
	region := -1
	if a := w.Atlas; a != nil {
		region = a.Region(a.RegionAt(en.Pos.X, en.Pos.Z)).Element
	}
	roll := content.RollTame(s.cfg.Seed, e.CharacterID, ps.st.Rolls, en.ID, tr.sp, tr.fav, region)
	ps.st.Rolls++
	ps.dirty = true
	delete(s.petsG.calm, en.ID)
	at := en.Pos
	if !roll.OK || ps.st.Full() {
		w.EndCalm(en, e.ID)
		s.calmEvent(en, tr.sp, 0)
		reason := 0
		if roll.OK {
			reason = PetRefuseFull
		}
		s.tameEvent(en.ID, TameFailed, 0, at, tameJSON{Species: tr.sp.Key, Reason: reason, By: e.ID}, sess)
		s.savePets(sess)
		return
	}
	level := max(1, min(en.Level, contentdefs.D.Taming.LevelMax))
	if e.cbt != nil {
		level = max(1, min(level, e.cbt.Level))
	}
	def := contentdefs.D.Taming
	name := en.Def.Name
	if roll.Variant == content.VariantShiny {
		name = "Shiny " + name
	}
	_ = def
	rec, ok := ps.st.Add(content.PetRec{Species: tr.sp.Key, Name: name, Variant: roll.Variant, Element: roll.Element, Level: level, HP: math.Max(0.5, en.HP/math.Max(1, en.HPMax)), TamedAt: s.cfg.Now().UnixMilli()})
	if !ok {
		return
	}
	id, wasActive := rec.ID, ps.st.Active == rec.ID
	w.Tame(en)
	s.tameEvent(en.ID, TameTamed, uint32(id), at, tameJSON{Species: tr.sp.Key, Food: tr.food, Fav: tr.fav, Variant: roll.Variant, Element: roll.Element, Name: name, By: e.ID}, sess)
	if sess.cnt != nil {
		sess.cnt.st.Tamed(tr.sp.Key, roll.Variant == content.VariantShiny)
		s.contentFeats(sess)
		s.saveContent(sess)
	}
	if wasActive {
		s.petEnsureOut(sess, true, at)
	} else {
		s.petNote(sess, PetNoteStabled, id, name+" waits for you in your stable")
	}
	s.log.Info("tamed", "character", e.CharacterID, "species", tr.sp.Key, "variant", roll.Variant, "pet", id)
	s.petChanged(sess)
}

// ---- Interact 130 ----

func (s *Server) petInteract(sess *session, m *proto.Interact) {
	e := sess.ent
	if e == nil {
		return
	}
	if sess.pets == nil {
		sess.pets = &petSess{st: &content.PetState{V: 1}}
	}
	ps := sess.pets
	w := s.cbt.w
	switch m.Action {
	case PetActFeed:
		s.tameFeed(sess, uint32(m.TargetID))
	case PetActCommand:
		en := w.Summon(ps.out)
		if en == nil || !en.IsPet() {
			s.petRefuse(sess, m.Action, PetRefuseNoPet, 0)
			return
		}
		switch m.Arg {
		case PetCmdFollow:
			w.CommandPet(en, combat.PetFollow, 0)
		case PetCmdStay:
			w.CommandPet(en, combat.PetStay, 0)
		case PetCmdAttack:
			mode, _ := en.PetMode()
			t := w.Enemy(uint32(m.TargetID))
			if t == nil || !t.Alive() || math.Hypot(t.Pos.X-e.Move.Pos.X, t.Pos.Z-e.Move.Pos.Z) > contentdefs.D.Taming.LeashM+10 {
				s.petRefuse(sess, m.Action, PetRefuseFar, uint32(m.TargetID))
				return
			}
			w.CommandPet(en, mode, t.ID)
		case PetCmdCome:
			w.RecallPet(en)
		default:
			s.petRefuse(sess, m.Action, PetRefuseUnknown, 0)
			return
		}
		mode, _ := en.PetMode()
		if ps.st.Mode != mode {
			ps.st.Mode = mode
			ps.dirty = true
		}
		s.sendPetSync(sess)
	case PetActPet, PetActFeedPet:
		s.petPetOrFeed(sess, m.Action)
	case PetActName:
		s.petName(sess, int(m.TargetID&0xffff), int(m.TargetID>>16), m.Arg)
	case PetActTakeOut:
		rec := ps.st.Pet(int(m.TargetID))
		switch {
		case rec == nil:
			s.petRefuse(sess, m.Action, PetRefuseUnknown, uint32(m.TargetID))
		case !s.atStable(e):
			s.petRefuse(sess, m.Action, PetRefuseStable, uint32(m.TargetID))
		case rec.ID == ps.st.Active:
			s.petEnsureOut(sess, true)
			s.sendPetSync(sess)
		default:
			s.petTakeIn(sess)
			ps.st.Active = rec.ID
			ps.st.Mode = combat.PetFollow
			if rec.KOUntil > s.cfg.Now().UnixMilli() {
				s.petRefuse(sess, m.Action, PetRefuseKO, uint32(rec.ID)) // chosen; it comes when it has recovered
			}
			ps.dirty = true
			s.petEnsureOut(sess, true)
			s.petChanged(sess)
		}
	case PetActStable:
		if ps.st.Active == 0 {
			s.petRefuse(sess, m.Action, PetRefuseNoPet, 0)
			return
		}
		if !s.atStable(e) {
			s.petRefuse(sess, m.Action, PetRefuseStable, 0)
			return
		}
		s.petTakeIn(sess)
		ps.st.Active = 0
		s.petChanged(sess)
	case PetActRelease:
		rec := ps.st.Pet(int(m.TargetID))
		if rec == nil {
			s.petRefuse(sess, m.Action, PetRefuseUnknown, uint32(m.TargetID))
			return
		}
		name := rec.Name
		if rec.ID == ps.st.Active {
			s.petTakeIn(sess)
		}
		ps.st.Release(rec.ID)
		s.petNote(sess, PetNoteReleased, int(m.TargetID), name+" returns to the wild")
		s.petChanged(sess)
	case PetActSync:
		s.sendPetSync(sess)
	case PetActDev:
		s.petDev(sess, m)
	default:
		s.petRefuse(sess, m.Action, PetRefuseUnknown, 0)
	}
}

// petPetOrFeed: pet your pet (an emote everyone near sees) or feed it.
func (s *Server) petPetOrFeed(sess *session, action uint8) {
	e, ps := sess.ent, sess.pets
	en := s.cbt.w.Summon(ps.out)
	if en == nil || !en.IsPet() {
		s.petRefuse(sess, action, PetRefuseNoPet, 0)
		return
	}
	reach := petPetReachM
	if action == PetActFeedPet {
		reach = petFeedReach
	}
	if math.Hypot(en.Pos.X-e.Move.Pos.X, en.Pos.Z-e.Move.Pos.Z) > reach+en.Radius() {
		s.petRefuse(sess, action, PetRefuseFar, en.ID)
		return
	}
	rec := ps.st.ActivePet()
	if rec == nil {
		return
	}
	if action == PetActPet {
		if e.cbt != nil && e.cbt.Downed {
			s.petRefuse(sess, action, PetRefuseNotNow, 0)
			return
		}
		if now := s.cfg.Now(); now.Sub(ps.petted) >= 1500*time.Millisecond {
			ps.petted = now
			s.playEmote(sess, EmotePet, false, int32(en.ID), en.Pos.X, en.Pos.Y, en.Pos.Z)
			s.petActEvent(en.ID, PetActPetted, e.ID, en.Pos, nil)
		}
		return
	}
	// feeding: a food it likes (favourite first), else any food
	food := ""
	if sp := rec.Def(); sp != nil && sess.items != nil {
		food, _ = content.LikedFood(sp, sess.items.inv.Count)
	}
	if food == "" && sess.items != nil {
		for _, it := range sess.items.inv.Items {
			if strings.HasPrefix(it.Base, "food:") || strings.HasPrefix(it.Base, "meat:") {
				food = it.Base
				break
			}
		}
	}
	if food == "" {
		s.petRefuse(sess, action, PetRefuseNoFood, en.ID)
		return
	}
	var d items.Delta
	if !sess.items.inv.Spend(food, 1, &d) {
		s.petRefuse(sess, action, PetRefuseNoFood, en.ID)
		return
	}
	s.commitItems(sess, &d, nil, "pet food")
	s.cbt.w.HealPet(en, contentdefs.D.Taming.FeedHealPct)
	s.petActEvent(en.ID, PetActFed, e.ID, en.Pos, []byte(food))
	ps.dirty = true
	s.sendPetSync(sess)
}

func (s *Server) petName(sess *session, id, chunk int, arg uint32) {
	ps := sess.pets
	rec := ps.st.Pet(id)
	if rec == nil || chunk < 0 || chunk > 3 {
		s.petRefuse(sess, PetActName, PetRefuseUnknown, uint32(id))
		return
	}
	if chunk == 0 {
		ps.label, ps.labelFor = ps.label[:0], id
	} else if len(ps.label) != chunk*4 || ps.labelFor != id {
		return // a chunk went missing: wait for a restart
	}
	done := chunk == 3
	for i := 0; i < 4; i++ {
		c := byte(arg >> (8 * i))
		if c == 0 {
			done = true
			break
		}
		ps.label = append(ps.label, c)
	}
	if !done {
		return
	}
	name := trimSpaces(string(ps.label))
	ps.label = ps.label[:0]
	if !validPetName(name) {
		s.petRefuse(sess, PetActName, PetRefuseName, uint32(id))
		return
	}
	rec.Name = name
	if ps.out != 0 && rec.ID == ps.st.Active {
		if ent := s.cbt.byID[ps.out]; ent != nil {
			ent.Name = sess.ent.Name + "'s " + name
		}
	}
	s.petNote(sess, PetNoteNamed, id, "Your pet is now called "+name)
	s.petChanged(sess)
}

func validPetName(name string) bool {
	ok := len(name) > 0 && len(name) <= petNameMax
	for i := 0; ok && i < len(name); i++ {
		c := name[i]
		ok = c == ' ' || c == '\'' || c == '-' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
	}
	return ok
}

// ---- dev tools (dev builds: evidence runs) ----

func (s *Server) petDev(sess *session, m *proto.Interact) {
	if !s.cfg.DevSpawn {
		s.petRefuse(sess, PetActDev, PetRefuseUnknown, 0)
		return
	}
	e, ps := sess.ent, sess.pets
	switch m.Arg {
	case 1: // a few of every species' favourite food
		if sess.items == nil {
			return
		}
		var d items.Delta
		var got []*items.Item
		seen := map[string]bool{}
		for _, sp := range contentdefs.D.Taming.Species {
			if seen[sp.Foods[0]] {
				continue
			}
			seen[sp.Foods[0]] = true
			it := items.Stack(sp.Foods[0], 5)
			it.Prov = []items.Prov{{Ev: "dev_grant", Char: e.CharacterID, At: s.cfg.Now().UnixMilli()}}
			if left := sess.items.inv.Add(it, &d); left < 5 {
				got = append(got, it)
			}
		}
		s.commitItems(sess, &d, nil, "pet dev foods")
		s.sendGranted(sess, SourceCraft, got)
	case 2: // a creature of species targetId near you, already weakened
		sp := contentdefs.D.PetByID(int(m.TargetID))
		if sp == nil || s.cbt.w == nil {
			s.petRefuse(sess, PetActDev, PetRefuseUnknown, 0)
			return
		}
		yaw := e.Yaw
		x, z := e.Move.Pos.X-math.Sin(yaw)*7, e.Move.Pos.Z-math.Cos(yaw)*7
		g := s.cbt.w.TestGroup(movement.Vec3{X: x, Z: z}, []string{sp.Enemy}, 1, "")
		if s.petsG.devWeaken == nil {
			s.petsG.devWeaken = map[*combat.Group]string{}
		}
		s.petsG.devWeaken[g] = e.CharacterID
	case 3: // pet XP
		rec := ps.st.ActivePet()
		if rec == nil {
			return
		}
		s.petXP(combat.PetXP{Owner: e.ID, Slot: rec.ID, XP: float64(max(1, m.TargetID))})
	default:
		s.petRefuse(sess, PetActDev, PetRefuseUnknown, 0)
	}
}

// petDevWeakenTick weakens dev-spawned creatures once they exist.
func (s *Server) petDevWeakenTick() {
	for g, char := range s.petsG.devWeaken {
		if !g.Spawned || len(g.Members) == 0 {
			continue
		}
		delete(s.petsG.devWeaken, g)
		en := g.Members[0]
		sess := s.byChar[char]
		if sess == nil || sess.ent == nil || !en.Alive() {
			continue
		}
		en.HP = en.HPMax * contentdefs.D.Taming.WeakenPct * 0.8
		s.petWeakened(en, sess.ent.ID)
	}
}

// PetsDebug is a summary for tests and the debug endpoint.
func (s *Server) PetsDebug(characterID string) *content.PetState {
	if sess := s.byChar[characterID]; sess != nil && sess.pets != nil {
		return sess.pets.st
	}
	return nil
}
