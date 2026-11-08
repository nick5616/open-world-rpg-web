# 0004: Accounts, sessions and local saves (WP04)

Date: 2026-11-08

## Session tokens are our own Ed25519 tokens, verified offline

After sign-in (Firebase or dev) the account service issues `lss1.<payload>.<sig>`
(Ed25519, 12 h). The director verifies it with the public key, so the connect
path never calls the account service and the account service can scale to zero
(spec 13). Separate keys for sessions, tickets and saves, each signature
domain-separated, so a leaked or reused key cannot turn one kind of token into
another. Production (`LODESTONE_ENV=production`) refuses every well-known dev
key and the dev auth provider at startup.

## Firebase tokens verified without the Admin SDK

Spec 13 forbids provider SDKs in game code, and the check is small: RS256 with
an alg pin, Google's securetoken JWKS cached per Cache-Control (unknown `kid`
refetches at most once a minute), iss/aud = project, exp/iat/auth_time with
the Admin SDKs' 5 minute skew. `auth_provider` stores the provider used
("google"), `auth_subject` the Firebase uid. If a Firebase user later links a
second provider, the uid is the same but the provider differs, so it would
create a second account; revisit when Discord/GitHub arrive (store
`auth_provider = "firebase"` or look up by uid first).

## Local profiles: browser id + secret, server stores a hash

The browser generates `profileId` (UUID v4) and a 32-byte secret; the server
keeps `sha256(secret)` in `local_profiles` (migration 0002) so a profile id
alone (it rides in tickets) cannot be hijacked. The export file carries the
secret, because importing on another device must be able to claim the
profile. Treat it like a password; the UI says so.

## Local characters live in their own table

`characters.account_id` is NOT NULL and downstream packages assume account
ownership. Rather than change that column's meaning, local characters get
`local_characters` (id, profile, world, name). Names stay unique per world
across both tables under a `pg_advisory_xact_lock` on (world, lower(name));
each table's UNIQUE constraint is the backstop. An upgrade deletes the local
row and inserts the account row with the same id and name in one transaction,
so the name is never free in between.

## Save counters are per character and adopt on loss

`localsave:{profileId}` is a hash with one counter per character (a profile
can hold several characters; saving one must not invalidate the others). Local
Redis runs without persistence (spec 11 "rebuildable"), so after a restart no
counters exist. We accept a correctly signed blob with no record and record
its counter (`AdoptMissing`), and accept a higher signed counter as "the record
is behind". Cost: right after a Redis loss one rollback to any earlier signed
blob is possible. Production should either enable AOF on Redis or move the
counter to Postgres; STATUS tracks this.

## Upgrade requires every character's newest blob

Upgrading moves all of a profile's characters or none. A partial upgrade would
strand characters on a retired profile. The client has every blob in
IndexedDB, so this costs nothing in practice.

## Director prefers explicit region owners

`zoneregistry.Pick` takes the fewest players among owners. The director first
considers zones that list the region explicitly and falls back to whole-world
zones, so once regions split off the v1 primary, it stops absorbing their
players.

## Firebase JS SDK from the CDN, only when configured

The client imports `firebase-app.js`/`firebase-auth.js` (10.14.1) from
gstatic by URL when `VITE_FIREBASE_*` is set. No npm dependency (and no edit to
WP02's client package.json), and players who never press "Sign in with Google"
never download it.

## IndexedDB versions are negotiated, not hard-coded

`openLodestoneDb(stores)` opens the current version and bumps it only if one
of the caller's stores is missing. Connections close on `versionchange`, and
`SaveStore` reopens lazily. WP05 can add `cache:*` stores without coordinating
a version number with this module.
