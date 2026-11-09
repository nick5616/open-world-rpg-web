package accountapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"lodestone/server/pkg/constants"
	"lodestone/server/pkg/localsave"
)

// Errors callers map to HTTP statuses.
var (
	ErrNotFound        = errors.New("not found")
	ErrNameTaken       = errors.New("name taken")
	ErrProfileSecret   = errors.New("local profile secret mismatch")
	ErrProfileUpgraded = errors.New("local profile already upgraded")
	ErrUpgradeMismatch = errors.New("upgrade must include a verified save for every character of the profile")
)

// DB wraps the shared pool. All queries live here so the account service,
// the director and later the social service agree on one data model.
type DB struct{ Pool *pgxpool.Pool }

// Account is a row of accounts.
type Account struct {
	ID        string    `json:"id"`
	Provider  string    `json:"provider"`
	Subject   string    `json:"-"` // provider uid: never echoed to clients
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`
}

// LocalProfile is a row of local_profiles.
type LocalProfile struct {
	ID                string     `json:"id"`
	CreatedAt         time.Time  `json:"createdAt"`
	UpgradedAccountID *string    `json:"upgradedAccountId,omitempty"`
	UpgradedAt        *time.Time `json:"upgradedAt,omitempty"`
}

// World is a row of worlds as clients see it. Seed is a decimal string
// because uint64 does not survive a JavaScript number.
type World struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Seed       string          `json:"seed"`
	Spec       json.RawMessage `json:"spec"`
	GenVersion string          `json:"genVersion"`
	AtlasHash  string          `json:"atlasHash"`
	Official   bool            `json:"official"`
}

// Character is what clients and the director need about a character.
type Character struct {
	ID        string         `json:"id"`
	WorldID   string         `json:"worldId"`
	Name      string         `json:"name"`
	Level     int            `json:"level"`
	XP        int64          `json:"xp"`
	Position  localsave.Vec3 `json:"position"`
	Local     bool           `json:"local"` // true: a local-profile character (state in the browser)
	AccountID string         `json:"accountId,omitempty"`
	ProfileID string         `json:"profileId,omitempty"`
	CreatedAt time.Time      `json:"createdAt"`
}

// Owner is who a request acts for: an account or a local profile.
type Owner struct {
	Kind string // KindAccount or KindLocal
	ID   string
}

// OwnerOf derives the owner from a verified session.
func OwnerOf(s Session) Owner { return Owner{Kind: s.Kind, ID: s.Subject} }

// UpsertAccount finds or creates the account for a provider identity.
func (d DB) UpsertAccount(ctx context.Context, provider, subject string) (Account, error) {
	var a Account
	// The no-op DO UPDATE makes RETURNING yield the existing row on conflict.
	err := d.Pool.QueryRow(ctx, `
		INSERT INTO accounts (auth_provider, auth_subject) VALUES ($1, $2)
		ON CONFLICT (auth_provider, auth_subject) DO UPDATE SET auth_provider = EXCLUDED.auth_provider
		RETURNING id::text, auth_provider, auth_subject, status, created_at`, provider, subject).
		Scan(&a.ID, &a.Provider, &a.Subject, &a.Status, &a.CreatedAt)
	return a, err
}

// GetAccount loads an account by id.
func (d DB) GetAccount(ctx context.Context, id string) (Account, error) {
	var a Account
	err := d.Pool.QueryRow(ctx, `SELECT id::text, auth_provider, auth_subject, status, created_at FROM accounts WHERE id = $1`, id).
		Scan(&a.ID, &a.Provider, &a.Subject, &a.Status, &a.CreatedAt)
	return a, notFound(err)
}

// ClaimLocalProfile registers a browser-generated profile on first sight, or
// checks the presented secret hash against the stored one. created reports a
// first registration.
func (d DB) ClaimLocalProfile(ctx context.Context, id string, secretHash []byte) (p LocalProfile, created bool, err error) {
	tag, err := d.Pool.Exec(ctx, `INSERT INTO local_profiles (id, secret_hash) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, id, secretHash)
	if err != nil {
		return p, false, err
	}
	created = tag.RowsAffected() == 1
	var stored []byte
	err = d.Pool.QueryRow(ctx, `
		UPDATE local_profiles SET last_seen_at = now() WHERE id = $1
		RETURNING id::text, secret_hash, created_at, upgraded_account_id::text, upgraded_at`, id).
		Scan(&p.ID, &stored, &p.CreatedAt, &p.UpgradedAccountID, &p.UpgradedAt)
	if err != nil {
		return p, false, err
	}
	if subtle.ConstantTimeCompare(stored, secretHash) != 1 {
		return LocalProfile{}, false, ErrProfileSecret
	}
	return p, created, nil
}

// GetLocalProfile loads a local profile by id.
func (d DB) GetLocalProfile(ctx context.Context, id string) (LocalProfile, error) {
	var p LocalProfile
	err := d.Pool.QueryRow(ctx, `SELECT id::text, created_at, upgraded_account_id::text, upgraded_at FROM local_profiles WHERE id = $1`, id).
		Scan(&p.ID, &p.CreatedAt, &p.UpgradedAccountID, &p.UpgradedAt)
	return p, notFound(err)
}

const worldCols = `id::text, name, seed::text, spec, gen_version, atlas_hash, official`

func scanWorld(row pgx.Row) (World, error) {
	var w World
	err := row.Scan(&w.ID, &w.Name, &w.Seed, &w.Spec, &w.GenVersion, &w.AtlasHash, &w.Official)
	return w, err
}

// EnsureOfficialWorld inserts the official world if none exists. The advisory
// lock makes concurrent service starts (several account instances on Cloud
// Run) seed exactly one row.
func (d DB) EnsureOfficialWorld(ctx context.Context, w World) (World, bool, error) {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return World{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(7152)`); err != nil {
		return World{}, false, err
	}
	existing, err := scanWorld(tx.QueryRow(ctx, `SELECT `+worldCols+` FROM worlds WHERE official ORDER BY created_at LIMIT 1`))
	if err == nil {
		return existing, false, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return World{}, false, err
	}
	created, err := scanWorld(tx.QueryRow(ctx, `
		INSERT INTO worlds (name, seed, spec, gen_version, atlas_hash, official) VALUES ($1, $2::numeric, $3, $4, $5, true)
		RETURNING `+worldCols, w.Name, w.Seed, w.Spec, w.GenVersion, w.AtlasHash))
	if err != nil {
		return World{}, false, err
	}
	return created, true, tx.Commit(ctx)
}

// ListWorlds returns every world, official first.
func (d DB) ListWorlds(ctx context.Context) ([]World, error) {
	rows, err := d.Pool.Query(ctx, `SELECT `+worldCols+` FROM worlds ORDER BY official DESC, created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []World{}
	for rows.Next() {
		w, err := scanWorld(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// GetWorld loads one world.
func (d DB) GetWorld(ctx context.Context, id string) (World, error) {
	w, err := scanWorld(d.Pool.QueryRow(ctx, `SELECT `+worldCols+` FROM worlds WHERE id = $1`, id))
	return w, notFound(err)
}

// lockName serializes creates and upgrades of one (world, name) pair across
// both character tables; Postgres cannot express a UNIQUE spanning two tables.
func lockName(ctx context.Context, tx pgx.Tx, worldID, name string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || lower($2), 7153))`, worldID, name)
	return err
}

// CreateCharacter creates an account character (characters + an empty
// character_progress row) or a local-profile character (local_characters).
// name must already be validated.
func (d DB) CreateCharacter(ctx context.Context, o Owner, worldID, name string, appearance json.RawMessage, spawn localsave.Vec3) (Character, error) {
	if len(appearance) == 0 {
		appearance = json.RawMessage(`{}`)
	}
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return Character{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockName(ctx, tx, worldID, name); err != nil {
		return Character{}, err
	}
	var taken bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM characters WHERE world_id = $1 AND name_lower = lower($2))
		OR EXISTS (SELECT 1 FROM local_characters WHERE world_id = $1 AND name_lower = lower($2))`, worldID, name).Scan(&taken); err != nil {
		return Character{}, err
	}
	if taken {
		return Character{}, ErrNameTaken
	}
	c := Character{WorldID: worldID, Name: name, Level: 1, Position: spawn}
	pos, _ := json.Marshal(spawn)
	switch o.Kind {
	case KindAccount:
		c.AccountID = o.ID
		err = tx.QueryRow(ctx, `INSERT INTO characters (account_id, world_id, name, position, appearance) VALUES ($1, $2, $3, $4, $5)
			RETURNING id::text, created_at`, o.ID, worldID, name, pos, appearance).Scan(&c.ID, &c.CreatedAt)
		if err == nil {
			_, err = tx.Exec(ctx, `INSERT INTO character_progress (character_id) VALUES ($1)`, c.ID)
		}
	case KindLocal:
		c.Local, c.ProfileID = true, o.ID
		err = tx.QueryRow(ctx, `INSERT INTO local_characters (profile_id, world_id, name) VALUES ($1, $2, $3)
			RETURNING id::text, created_at`, o.ID, worldID, name).Scan(&c.ID, &c.CreatedAt)
	default:
		return Character{}, fmt.Errorf("unknown owner kind %q", o.Kind)
	}
	if err != nil {
		if isUniqueViolation(err) {
			return Character{}, ErrNameTaken
		}
		return Character{}, err
	}
	return c, tx.Commit(ctx)
}

// ListCharacters returns an owner's characters, optionally in one world.
// Local characters report the spawn position: their real position lives in
// the browser's save blob.
func (d DB) ListCharacters(ctx context.Context, o Owner, worldID string) ([]Character, error) {
	var rows pgx.Rows
	var err error
	if o.Kind == KindAccount {
		rows, err = d.Pool.Query(ctx, `SELECT id::text, world_id::text, name, level, xp, position, created_at FROM characters
			WHERE account_id = $1 AND ($2 = '' OR world_id::text = $2) ORDER BY created_at`, o.ID, worldID)
	} else {
		rows, err = d.Pool.Query(ctx, `SELECT id::text, world_id::text, name, 1, 0::bigint, NULL::jsonb, created_at FROM local_characters
			WHERE profile_id = $1 AND ($2 = '' OR world_id::text = $2) ORDER BY created_at`, o.ID, worldID)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Character{}
	for rows.Next() {
		var c Character
		var pos []byte
		if err := rows.Scan(&c.ID, &c.WorldID, &c.Name, &c.Level, &c.XP, &pos, &c.CreatedAt); err != nil {
			return nil, err
		}
		c.Position = SpawnPosition()
		if pos != nil {
			_ = json.Unmarshal(pos, &c.Position)
		}
		if o.Kind == KindAccount {
			c.AccountID = o.ID
		} else {
			c.Local, c.ProfileID = true, o.ID
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetCharacter loads one of the owner's characters (ErrNotFound if it does
// not exist or belongs to someone else: the two are indistinguishable on purpose).
func (d DB) GetCharacter(ctx context.Context, o Owner, id string) (Character, error) {
	cs, err := d.ListCharacters(ctx, o, "")
	if err != nil {
		return Character{}, err
	}
	for _, c := range cs {
		if c.ID == id {
			return c, nil
		}
	}
	return Character{}, ErrNotFound
}

// DeleteLocalCharacter releases a local character's name reservation. Used
// to compensate when the initial save blob could not be issued.
func (d DB) DeleteLocalCharacter(ctx context.Context, profileID, id string) error {
	_, err := d.Pool.Exec(ctx, `DELETE FROM local_characters WHERE id = $1 AND profile_id = $2`, id, profileID)
	return err
}

// UpgradeLocalProfile moves every character of a local profile into the
// account, copying each one's verified save state, in ONE transaction (spec
// 11): either the account owns all of them with their progress, or nothing
// changed and the browser blobs are still the truth. Callers must verify the
// blobs (signature + newest counter) first; states maps character id → state.
func (d DB) UpgradeLocalProfile(ctx context.Context, profileID, accountID string, states map[string]localsave.State) ([]Character, error) {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var upgraded *string
	// FOR UPDATE: two concurrent upgrades of one profile serialize here and the
	// second sees upgraded_account_id set.
	if err := tx.QueryRow(ctx, `SELECT upgraded_account_id::text FROM local_profiles WHERE id = $1 FOR UPDATE`, profileID).Scan(&upgraded); err != nil {
		return nil, notFound(err)
	}
	if upgraded != nil {
		return nil, ErrProfileUpgraded
	}
	type lc struct{ id, world, name string }
	rows, err := tx.Query(ctx, `SELECT id::text, world_id::text, name FROM local_characters WHERE profile_id = $1 ORDER BY created_at`, profileID)
	if err != nil {
		return nil, err
	}
	var locals []lc
	for rows.Next() {
		var c lc
		if err := rows.Scan(&c.id, &c.world, &c.name); err != nil {
			rows.Close()
			return nil, err
		}
		locals = append(locals, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(locals) != len(states) {
		return nil, ErrUpgradeMismatch
	}
	out := make([]Character, 0, len(locals))
	for _, l := range locals {
		st, ok := states[l.id]
		if !ok || st.WorldID != l.world {
			return nil, ErrUpgradeMismatch
		}
		if err := lockName(ctx, tx, l.world, l.name); err != nil {
			return nil, err
		}
		// Delete first: the name is reserved by this row, and moving it within
		// the transaction keeps it reserved the whole time.
		if _, err := tx.Exec(ctx, `DELETE FROM local_characters WHERE id = $1`, l.id); err != nil {
			return nil, err
		}
		c, err := insertFromState(ctx, tx, accountID, l.id, l.world, l.name, st)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	if _, err := tx.Exec(ctx, `UPDATE local_profiles SET upgraded_account_id = $2, upgraded_at = now() WHERE id = $1`, profileID, accountID); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func jsonOr(b json.RawMessage, def string) json.RawMessage {
	if len(b) == 0 || string(b) == "null" {
		return json.RawMessage(def)
	}
	return b
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func insertFromState(ctx context.Context, tx pgx.Tx, accountID, id, worldID, name string, st localsave.State) (Character, error) {
	pos, _ := json.Marshal(st.Position)
	level := st.Level
	if level < 1 {
		level = 1
	}
	stamina := st.StaminaMax
	if stamina <= 0 || math.IsNaN(stamina) {
		stamina = 100
	}
	c := Character{ID: id, WorldID: worldID, Name: name, Level: level, XP: st.XP, Position: st.Position, AccountID: accountID}
	// The name comes from local_characters, not the blob: the reservation row
	// is the authority on names, the blob on progress.
	if err := tx.QueryRow(ctx, `INSERT INTO characters (id, account_id, world_id, name, level, xp, position, last_waypoint, stamina_max, appearance)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING created_at`,
		id, accountID, worldID, name, level, st.XP, pos, st.LastWaypoint, stamina, jsonOr(st.Appearance, `{}`)).Scan(&c.CreatedAt); err != nil {
		return Character{}, err
	}
	p := st.Progress
	if _, err := tx.Exec(ctx, `INSERT INTO character_progress (character_id, towers, waypoints, containers_opened, discoveries, skill_tree, spells_known, spells_equipped, attuned)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		id, bytesOr(p.Towers), bytesOr(p.Waypoints), bytesOr(p.ContainersOpened), bytesOr(p.Discoveries),
		jsonOr(p.SkillTree, `{}`), nonNil(p.SpellsKnown), nonNil(p.SpellsEquipped), bytesOr(p.Attuned)); err != nil {
		return Character{}, err
	}
	for _, it := range st.Items {
		var slot *string
		if it.Slot != "" {
			slot = &it.Slot
		}
		// Item ids are regenerated: a local blob's ids were never inserted
		// anywhere, and trusting client-visible ids as primary keys invites
		// collisions. Provenance records where the item came from.
		// WP14 (migration 0014): stacks keep their size, trading flags and
		// provenance carry over, with the upgrade appended.
		prov := []json.RawMessage{}
		if len(it.Provenance) > 0 {
			_ = json.Unmarshal(it.Provenance, &prov)
		}
		prov = append(prov, json.RawMessage(fmt.Sprintf(`{"ev":"local_upgrade","event":"local_upgrade","localItemId":%q}`, it.ID)))
		provJSON, _ := json.Marshal(prov)
		tradeable, verified := true, true
		if it.Tradeable != nil {
			tradeable = *it.Tradeable
		}
		if it.Verified != nil {
			verified = *it.Verified
		}
		var name *string
		if it.Name != "" {
			name = &it.Name
		}
		if _, err := tx.Exec(ctx, `INSERT INTO items (owner_character_id, kind, base_id, item_level, rarity, affixes, sockets, slot, roll_seed, provenance, qty, tradeable, verified, display_name)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
			id, it.Kind, it.BaseID, max(it.ItemLevel, 1), it.Rarity, jsonOr(it.Affixes, `[]`), jsonOr(it.Sockets, `[]`), slot, it.RollSeed,
			json.RawMessage(provJSON), max(it.Qty, 1), tradeable, verified, name); err != nil {
			return Character{}, err
		}
	}
	return c, nil
}

func bytesOr(b []byte) []byte {
	if b == nil {
		return []byte{}
	}
	return b
}

// SpawnPosition is where new characters start until worldgen (WP01/WP05)
// supplies a real spawn: the world centre, y = 0 meaning "snap to ground on
// arrival" (the zone owns terrain height).
func SpawnPosition() localsave.Vec3 {
	half := float64(constants.WorldSizeM) / 2
	return localsave.Vec3{X: half, Y: 0, Z: half}
}

func notFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func isUniqueViolation(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}
