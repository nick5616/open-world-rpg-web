# client/src/voice

Proximity voice in the browser (spec 10, WP11): LiveKit with auto-subscribe
off (the server decides who you hear from the zone's earshot sets), a Web
Audio graph that places every voice at the speaker's interpolated head,
push-to-talk on V, speaking indicators, party radio. Decisions:
`docs/decisions/0011-proximity-voice.md`.

## Mounting

`NetPlay` starts it next to the social session and stops it with it:

```ts
startVoice({
  requestToken: () => requestVoiceToken(),            // voice_token over the social socket
  listenOnly: () => socialStore.me?.isLocalProfile ?? ready.isLocalProfile,
  partyIds: () => socialStore.party?.members.map((m) => m.characterId) ?? [],
  ground,                                               // NetPlay's forwarding ground: the terrain the player walks on
});
// every movement frame: flags | voiceInputFlags()     (InputFlag.speaking -> Activity.speaking for others)
```

`PlayScreen` renders `<VoiceHud />` (nothing until voice starts). The
nameplate (`net/avatar.ts`) shows "speaking" from the local analyser at once,
or from the zone's activity bit for players we don't hear.

## How it sounds

Per speaker: `gain (your volume / mute) → low-pass (terrain between you) →
PannerNode HRTF (inverse distance, ref 2 m, max 40 m)` into one master in one
AudioContext; a party member beyond 48 m (or not drawn) crossfades to a
radio branch (300 Hz-3 kHz band, soft clip, no pan). The listener is your
camera (eye height, yaw, pitch); positions update every frame from
`drawnRemotes` (the interpolation's output). Occlusion is re-checked at 4 Hz
per speaker by sampling the ground height between the two heads.
G3 integration fix: underground, samples in open cave air (`GroundQuery.caveAir`, WP09's cave density from loaded cells) no longer count, so the surface overhead doesn't muffle two people in the same cave; rock between them still does.

## Talking

- Push-to-talk: hold **V** (not while typing in chat). The first push asks for
  the microphone and publishes it; later pushes unmute/mute it.
- Voice activation (settings, opt-in): choosing it is the consent to open
  the mic; the gate follows the local level meter (the-circle thresholds,
  450 ms hangover).
- Players muted by a moderator get listen-only tokens (the client reads the
  token's `video.canPublish`): the HUD says "Listen-only" and V does
  nothing. Local profiles talk like accounts since playtest 2, unless the
  server sets `LODESTONE_VOICE_LOCAL_LISTEN_ONLY=1` (WP11's original rule).
- Settings (Voice button): talk mode, master volume, per-player volume and
  mute (voice only, this device; `/mute Name` mutes everywhere, server-side).
  Saved in localStorage `lodestone.voice.v1`.

## Files

| File | What |
| --- | --- |
| `runtime.ts` | `startVoice`/`stopVoice`: LiveKit Room (connect, retry 1→30 s, subscribe events), the per-frame position loop, occlusion, PTT keys, `voiceInputFlags`, `voiceDebug` |
| `mixer.ts` | `VoiceMixer`: the Web Audio graph, listener/panner updates, volumes, output L/R meters (tests) |
| `spatial.ts` | Pure math: listener axes, head height, inverse-distance gain, spatial vs radio, terrain-between test |
| `talk.ts` | `TalkController`: PTT / voice activation / listen-only rules, serialized mic operations |
| `levels.ts` | the-circle `audio.ts` port: analyser levels → `--lvl` / `data-speaking` on bound DOM nodes, `isSpeaking(name)` |
| `store.ts` | zustand UI state and saved prefs |
| `token.ts` | `voice_token` request over the social socket |
| `ui/VoiceHud.tsx` | PTT indicator, who you hear (level bars), settings |
| `debugHook.ts` | lets `window.__lodestone.voiceDebug()` exist without pulling livekit-client into the title bundle |
| `dev/walkapart.mjs` | The two-browser acceptance test (below) |

`livekit-client` is pinned to 2.15.16: newer clients cannot publish to the
LiveKit 1.8 server in `infra/` (0011).

## Test

```
npx vitest run --root client src/voice                 # spatial math, prefs, push-to-talk rules
node client/src/voice/dev/walkapart.mjs [--livekit ws://localhost:7880]
```

`walkapart.mjs` runs account, director, zone and social (scratch database,
ports 18690-18693, Vite 5196) and two Chromium processes with a fake
microphone (a steady harmonic tone, `--use-file-for-fake-audio-capture`).
Both hold V; B walks to 4 m in front of A, then 62 m to A's right (out of
earshot), back across A's front to 30 m on A's left, then (after A invites B
to a party through chat) on to 80 m. Every 100 ms it records from A's
browser B's panner position, its position in A's ears' frame, the
inverse-distance gain, the analyser level, the left/right RMS of A's actual
audio output, and whether A is subscribed; plus B's true position and the
zone's speaking bit. Checks: fade (level vs distance), pan (louder ear on B's
side), silence and unsubscription past 48 m, subscription inside 38 m, panner
on B's drawn head, speaking indicator in the DOM and from the zone, party
radio past earshot (subscribed, audible, flat). Evidence:
`docs/evidence/wp11-walkapart.{txt,json}` and `wp11-walkapart-*.png`.
