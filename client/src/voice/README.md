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
- Settings: see "Voice settings" below. Saved in localStorage
  `lodestone.voice.v1` (one validated blob; WP11 blobs still load).

## Voice settings (playtest 2)

`ui/VoiceSettings.tsx`, opened from the HUD's Voice button, the Sound panel
("Voice settings") and the Esc menu's Voice row. A panel on the panel stack
(`'voice'`, Esc closes it), `data-ui-panel`. Every change applies live:
`runtime.ts` subscribes to the store.

- **Microphone**: input device (`devices.ts pickDevice`: saved id, else the
  same label under a new id, else the default while it is unplugged, and
  back when it returns; `devicechange` is followed), speakers
  (`AudioContext.setSinkId`, game sound and voice share it; hidden where
  unsupported), input boost -20..+20 dB (`micChain.ts`: a LiveKit audio
  processor in the send path; the meter / gate listen to a clone, because
  LiveKit's mute disables the raw track), push to talk (key rebindable,
  hold or toggle, mouse side buttons) or open mic (`vad.ts VadGate`:
  threshold dBFS on a live meter with the line, open-after, hold-open), mic
  mute + key (default 0), echo cancellation / noise suppression / auto gain
  (`restartTrack` with new constraints; the meter's clone is released first,
  because Chrome gives a new capture the processing of any capture still
  open on the same device: the same holds while the mic test runs), incoming volume.
- **Voice keys** (`keys.ts`): validated against `input/bindings.ts`: a key
  another feature binds in the world or the menu, the other voice key, or a
  reserved key (Esc, Enter, Tab, Space, modifiers, arrows) is refused with
  the reason; a stored key that became invalid falls back to the default.
- **Test** (`micTest.ts`, its own capture, works offline): RMS / peak dBFS
  meter with a clip light, hear yourself through the voice bus with 0-2 s
  delay, record 5 s (MediaRecorder) and play it back on the chosen speakers.
- **Players**: everyone subscribed now, level, volume 0-200 %, mute; saved
  by character id (`store.ts peerPref/withPeer`; WP11 by-name entries are
  read until replaced).
- **Diagnostics** (`diag.ts`, 1 Hz while open): room state, server URL,
  region, version, reconnects / attempts / failures, the token's grant
  (never the token), listen-only reason, microphone permission, device
  and pick status, capture settings (sample rate, channels, processing,
  latency), boost, level; sending: codec, bitrate, loss, jitter, RTT, path
  (UDP/TCP/TURN relay), level sent (`stats.ts` parses `getRTCStatsReport()`
  of the mic sender and each remote receiver); each speaker's distance,
  level, codec, bitrate, loss, jitter, concealment; recent errors.
  Copy diagnostics (JSON, no token, URL without query), Reconnect voice.
- **Guidance** (`guidance.ts`): permission denied, no / busy / unplugged
  device, listen-only (why), muted, server unreachable vs UDP blocked,
  TURN relay / TCP fallback, loss, delay, flapping, suspended audio, silent mic.

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
| `ui/VoiceHud.tsx` | PTT indicator, who you hear (level bars), the Voice button, the Esc menu row |
| `ui/VoiceSettings.tsx` | The voice settings panel (four tabs) |
| `ui/LevelMeter.tsx` | Live dBFS meter (rAF, writes the DOM), threshold line, clip light, gate |
| `ui/micTestStore.ts` | The running mic test, record / play back |
| `keys.ts` | Voice keys: defaults, validation against `input/bindings.ts`, event reading |
| `vad.ts` | dBFS levels, `VadGate` (threshold, open-after, hold-open) |
| `devices.ts` | Device lists, `pickDevice` fallback, `applySink`, mic error kinds, permission |
| `micChain.ts` | The input boost processor + meter tap |
| `micTest.ts` | Standalone mic test: meter, loopback with delay, recorder |
| `stats.ts` | getStats parsing, rates, formatting |
| `diag.ts` | Diagnostics shape, error ring, JSON, clipboard |
| `guidance.ts` | Friendly help from a diagnostics snapshot |
| `debugHook.ts` | lets `window.__lodestone.voiceDebug()` exist without pulling livekit-client into the title bundle |
| `dev/walkapart.mjs` | The two-browser acceptance test (below) |

`livekit-client` is pinned to 2.15.16: newer clients cannot publish to the
LiveKit 1.8 server in `infra/` (0011).

## Test

```
npx vitest run --root client src/voice                 # spatial math, prefs, push-to-talk rules, voice settings
node tools/playtest/stack.mjs  +  LODESTONE_CLIENT_URL=<url> node tools/playtest/voice-settings-shots.mjs   # the settings panel, two players
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
