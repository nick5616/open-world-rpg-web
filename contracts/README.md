# contracts

Everything more than one package agrees on. Edit the sources here, then run
`npm run gen`; never hand-edit generated files (CI runs `npm run gen:check`).

| Source | Generates | Consumers |
| --- | --- | --- |
| `protocol.yaml` | `ts/src/gen/protocol.ts`, `server/pkg/proto/protocol_gen.go`, `golden/protocol_vectors.json`, Go vector test | client net, zone, bots |
| `constants.yaml` | `ts/src/gen/constants.ts`, `server/pkg/constants/constants_gen.go`, `worldgen/src/gen/constants.rs` | everyone |
| `social.yaml` | `ts/src/gen/social.ts`, `server/pkg/socialproto/social_gen.go` | client social, social service |
| `worldspec.schema.json` | `ts/src/gen/worldspec.ts`, `server/pkg/worldspec/worldspec_gen.go`, `worldgen/src/gen/worldspec.rs` | worldgen, creator, director |
| `migrations/*.sql` | applied by `server/pkg/cmd/migrate` (`npm run migrate`) | all Go services |
| `events.md` | (documentation) Event message `kind` registry | zone, client |

## Wire format in one paragraph

Each binary frame is `[msgId u8][body]`, little-endian. `string` = u16 length +
UTF-8, `bytes` = u32 length, `list<T>` = u16 count. Masked structs write their
`always` fields, then a bitmask, then only the fields whose bit is set, which is
how snapshot deltas cost nothing for unchanged fields. Decoding is strict
(unknown id, truncation or trailing bytes are errors); the zone kicks clients
whose `Hello.protocolVersion` differs, so old and new builds never talk.

## Golden vectors

`codegen/lib/protocol.mjs` contains a third, generic reference encoder that
writes `golden/protocol_vectors.json` (min, max and random cases per message).
`ts/test/protocol.test.ts` and `server/pkg/proto/protocol_vectors_gen_test.go`
must decode every vector to the same values and re-encode it to the same bytes.

## Changing a contract

Write `docs/cr/NNN-slug.md` (what, why, every consumer affected), edit the
source, bump its `version`, run `npm run gen`, fix every consumer in the same
change, and run `npm test`.

## Tests

```
npm run test -w @lodestone/contracts   # TS codec + quantization
cd server/pkg && go test ./...          # Go codec + quantization + migrations
```
