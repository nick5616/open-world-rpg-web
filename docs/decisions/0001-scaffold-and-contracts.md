# 0001: Scaffold and contract decisions (WP00)

Date: 2026-11-08

## Input frames are fixed 1/60 s steps

Spec 9 samples input at 60 Hz and sends it 30 times a second with the last 3
frames repeated, while the zone simulates at 30 Hz. We make each `InputFrame` a
fixed 1/60 s movement step on both sides: the server applies every new frame
(usually two per tick) in sequence order. Prediction replays therefore walk the
exact same path as the server, which is the property wizard-wars got from one
input per 64 Hz tick. Constant: `MOVE_STEP_HZ`.

## Strict protocol versioning

Decoders reject unknown ids, truncation and trailing bytes. Instead of trying to
make masked-struct extensions forward compatible (an old decoder cannot skip a
field it doesn't know the size of), any protocol change bumps `version` and the
zone kicks clients with a different `Hello.protocolVersion`. Client and server
deploy together, so this costs nothing and removes a class of silent bugs.

## Three codec implementations

The generator holds a generic reference encoder that produces the golden
vectors; generated TS and Go must decode them to equal values and re-encode them
to equal bytes. Rounding in quantization helpers follows JavaScript's
`Math.round` (halves toward +inf) in Go too (`jsRound`), because Go's
`math.Round` rounds halves away from zero and the two disagreed on -x.5.

## Ports

Stock Postgres (5432) and 8080 were already taken on the dev machine, and
Windows Hyper-V reserves random TCP blocks above 49152 (57177-57924 at the time),
which broke LiveKit on 57880. Defaults: Postgres 55432, Redis 56379, LiveKit
7880/7881 + UDP 7900-7950, services 8090-8094, client 5173. All overridable.

## Status files

`docs/STATUS.md` is the single status page, with one section per work package
so parallel packages edit disjoint regions and merges stay clean.

## Workflow

There is no PR review in this unattended run: each package is built on branch
`wp/NN-slug` and merged into `main` with `--no-ff`, so the history still reads
one merge per package. Evidence (logs, screenshots) goes in `docs/evidence/`
and is referenced from the merge commit message and STATUS.md.

## Go module paths

Workspace modules use local paths (`lodestone/server/zone`, ...) resolved by
`go.work`; they are never fetched remotely. Container builds copy the whole
repo including `go.work`.
