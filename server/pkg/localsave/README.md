# server/pkg/localsave

Signed save blobs for local profiles (spec 11, WP04). Used by the account service (first blob at character creation), the director (verify on connect), and later the zone server (issue at save points, verify on connect: WP06/WP14).

## Use

```go
priv, _, _ := localsave.PrivateKeyFromEnv()          // LODESTONE_SAVE_PRIVATE_KEY (dev key fallback: log a warning)
store := &localsave.Store{RDB: rdb, Priv: priv, Pub: priv.Public().(ed25519.PublicKey), AdoptMissing: true}

st := localsave.NewCharacterState(charID, worldID, name, spawn, nil) // or the live character's state
blob, err := store.Issue(ctx, profileID, charID, worldID, st.Marshal()) // counter+1 in Redis, then sign
err = store.Verify(ctx, blob)  // ErrSignature (edited) · ErrStale (old counter) · ErrMalformed · ErrNoRecord
state, err := blob.DecodeState()
```

## Format

`Blob` JSON: `format "lodestone-save"`, `v 1`, `profileId`, `characterId`, `worldId`, `counter`, `issuedAt` (ms), `state` (character state as JSON **text**), `sig` (base64url Ed25519). The signature covers `"lodestone-localsave-v1\0"`, then v, profileId, characterId, worldId (each u32-length-prefixed), counter u64, issuedAt u64, state (u32-length-prefixed). State is text so browsers can round-trip the blob through `JSON.parse/stringify` without breaking the signature.

## Counters

Redis hash `localsave:{profileId}`, one field per character id holding the newest counter issued, TTL `LOCALSAVE_TTL_DAYS` (180) refreshed on every issue/verify. Per-character because one profile can own several characters and saving one must not invalidate the others.

- A presented counter **below** the record → `ErrStale` (rollback / item duplication attempt).
- **Above** the record (signature valid, so we issued it) → accepted and the record is raised.
- **No record** (180 idle days, or Redis restarted: local Redis is ephemeral) → with `AdoptMissing` the blob is accepted and its counter recorded; without, `ErrNoRecord`. Adopting keeps players' characters alive across Redis restarts at the cost of allowing one rollback right after a Redis loss. See docs/STATUS.md (WP04) for the production recommendation.

## Test

`go test ./localsave/` (unit tests + Redis integration; skips without infra unless `LODESTONE_REQUIRE_INFRA=1`).
