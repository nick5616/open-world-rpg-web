# client/src/ui/whatsnew

"What's new since you last played" (playtest 2).

| File | What |
| --- | --- |
| `changelog.json` | The player-facing changelog, newest first: `{ id, date, title, items[] }` |
| `news.ts` | Validation (`changelogProblems`, `validEntries`), what to show (`whatsNew`), the per-browser marker (localStorage `lodestone_whatsnew_seen`) |
| `WhatsNew.tsx` | The panel after login and the Esc menu's "What's new" page (the whole list) |
| `news.test.ts` | The rules, and that the shipped `changelog.json` is well formed |

After login (online, once the world is up) the panel lists the entries above
the id this browser last closed the panel on (at most 8, the most important first: entries of one date can be in any order, so put the big ones on top; the footer counts the rest, "N more: Esc, What's new"). It waits for the arrival cards and for any open panel. A browser with no
marker and no older Lodestone settings is a first-time player: a three-line
welcome instead of the history. A browser with older settings but no marker
(it played before this panel existed) gets the list. Closing stores the
newest id.

## Adding an entry (every deploy players will notice)

```
node scripts/whatsnew.mjs add --id pt3-fishing --title "Gone fishing" "Fish at any lake (E with a rod)." "Cook what you catch."
node scripts/whatsnew.mjs check
```

`add` prepends with today's date and refuses anything malformed. Write for
players: short lines about what they will notice, no internals. Never reuse
or rename a shipped id (browsers remember it); removing old entries is fine
(a browser whose id is gone sees the newest three).

## Fail-safe

- Invalid JSON stops the client build (`vite build`), so nothing ships and
  the live site keeps the previous build.
- Well-formed JSON with a bad entry (missing date, duplicate id, empty
  lines, out of order) builds; the client drops that entry
  (`validEntries`, never throws), and `scripts/whatsnew.mjs check` and the
  vitest fail so it gets fixed.
- The panel sits in an error boundary: the worst case is no panel.
