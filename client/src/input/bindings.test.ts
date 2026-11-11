// Playtest 2 integration QA: no key does two things by accident. Reads every
// handler file under client/src and checks it against input/bindings.ts.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BINDINGS, NOT_HANDLERS, SHARED } from './bindings';
import { controlGroups, keyLabel } from '../ui/menu/controls';
import { E_ORDER, eTakenAbove } from './interact';
import { isChatShortcut, notGameKey } from './useKeyboard';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = /['"`](Key[A-Z]|Digit\d|Numpad\w+|F\d{1,2}|Escape|Enter|Tab|Space|Arrow(?:Up|Down|Left|Right)|Backquote|Delete|Backspace|AltLeft|AltRight|ShiftLeft|ShiftRight|ControlLeft|ControlRight)['"`]/g;

function handlerFiles(dir = SRC, out: string[] = []): string[] {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) {
      if (f.name !== 'dev' && f.name !== 'golden' && f.name !== 'node_modules') handlerFiles(p, out);
    } else if (/\.tsx?$/.test(f.name) && !/\.test\.tsx?$/.test(f.name)) out.push(path.relative(SRC, p).replace(/\\/g, '/'));
  }
  return out;
}

describe('key bindings', () => {
  it('every key code a handler tests is declared in input/bindings.ts', () => {
    const undeclared: string[] = [];
    let seen = 0;
    for (const file of handlerFiles()) {
      if (NOT_HANDLERS[file]) continue;
      const text = readFileSync(path.join(SRC, file), 'utf8');
      for (const m of text.matchAll(CODE)) {
        seen++;
        const code = m[1];
        if (NOT_HANDLERS[`${file}#${code}`]) continue;
        if (!BINDINGS.some((b) => b.file === file && b.code === code)) undeclared.push(`${code} in ${file}`);
      }
    }
    expect(seen).toBeGreaterThan(60);
    expect([...new Set(undeclared)], 'declare these (context, what they do) in input/bindings.ts').toEqual([]);
  });

  it('every declared binding is still in its file', () => {
    for (const b of BINDINGS) {
      const text = readFileSync(path.join(SRC, b.file), 'utf8');
      expect(text.includes(b.code), `${b.code} (${b.does}) in ${b.file}`).toBe(true);
    }
  });

  it('no key does two things in one situation unless SHARED says who wins', () => {
    const by = new Map<string, string[]>();
    for (const b of BINDINGS) {
      const k = `${b.ctx} ${b.code}`;
      by.set(k, [...(by.get(k) ?? []), `${b.does} (${b.file})`]);
    }
    const dup = [...by].filter(([k, v]) => v.length > 1 && !SHARED[k.split(' ')[1]]).map(([k, v]) => `${k}: ${v.join(' / ')}`);
    expect(dup).toEqual([]);
  });

  it('the old clashes stay fixed', () => {
    const world = (code: string) => BINDINGS.filter((b) => b.ctx === 'world' && b.code === code).map((b) => b.does);
    expect(world('KeyV')).toEqual(['push to talk']); // the technique moved to Tab
    expect(world('Tab')).toEqual(['weapon technique']);
    expect(world('KeyU')).toEqual(['play your instrument']); // a pending duel ('duel') keeps U for "no"
    expect(world('KeyH')).toEqual(['emote wheel (hold)']); // photo mode's H is its own ('photo')
    expect(world('KeyR')).toEqual(['drink a draught']); // placing a camp piece turns it with R ('placing')
    // CR 031: Y (the one free letter) opens the Achievements screen; a pending duel's Y accepts instead.
    expect(world('KeyY')).toEqual(['achievements screen']);
    expect(BINDINGS.filter((b) => b.ctx === 'duel' && b.code === 'KeyY').map((b) => b.does)).toEqual(['accept the duel']);
    expect(readFileSync(path.join(SRC, 'ui/achievements/AchievementsHud.tsx'), 'utf8')).toContain('usePvp.getState().challenge');
  });

  it('CR 033: a bow draws on the left button and Z lowers the draw (the Controls say so)', () => {
    const world = (code: string) => BINDINGS.filter((b) => b.ctx === 'world' && b.code === code).map((b) => b.does);
    expect(world('KeyZ')).toEqual(["the weapon's secondary (hold); a bow: lower the draw"]);
    const rows = controlGroups(false).find((g) => g.title === 'Fighting')!.rows;
    expect(rows.find((r) => r.keys.includes('Left mouse'))!.note).toMatch(/bow: hold to draw, let go to shoot/);
    expect(rows.find((r) => r.keys.includes('Left mouse'))!.note).toMatch(/never run out of arrows/);
    expect(rows.find((r) => r.keys.includes('Z'))!.action).toMatch(/bow: lower the draw/);
    // the runtime's left button feeds the timeline's draw (attackDown), not a bow-only key
    const rt = readFileSync(path.join(SRC, 'combat/runtime.ts'), 'utf8');
    expect(rt).toContain('this.buttons.attackDown = true');
    expect(readFileSync(path.join(SRC, 'combat/timeline.ts'), 'utf8')).toContain('drawWeapon(w)');
  });

  it("every binding a player can use is in the Esc menu's Controls", () => {
    const listed = new Set(controlGroups(true).flatMap((g) => g.rows.flatMap((r) => r.keys)));
    const missing = BINDINGS.filter((b) => b.ctx !== 'debug' && b.ctx !== 'title' && b.code !== 'ShiftRight')
      .map((b) => keyLabel(b.code))
      .filter((k) => !listed.has(k));
    expect([...new Set(missing)]).toEqual([]);
  });
});

describe('typing "/" for chat (playtest 2 polish)', () => {
  const ev = (code: string, key: string, target: unknown = null) => ({ code, key, target }) as unknown as KeyboardEvent;

  it('is never a game key, whatever key types it', () => {
    expect(isChatShortcut(ev('Digit7', '/'))).toBe(true); // German, Nordic, Spanish: Shift+7
    expect(isChatShortcut(ev('KeyQ', '/'))).toBe(true); // Hebrew
    expect(isChatShortcut(ev('Slash', '/'))).toBe(true); // US
    expect(isChatShortcut(ev('Digit7', '7'))).toBe(false);
    expect(isChatShortcut(ev('Digit7', '&'))).toBe(false); // AZERTY: the key's place still counts (e.code)
    expect(notGameKey(ev('KeyE', 'e', { tagName: 'INPUT' }))).toBe(true);
    expect(notGameKey(ev('KeyE', 'e', { tagName: 'CANVAS' }))).toBe(false);
  });

  it('every world letter and digit handler leaves the chat shortcut alone', () => {
    const files = new Set(BINDINGS.filter((b) => b.ctx === 'world' && /^(Key[A-Z]|Digit\d)$/.test(b.code) && b.file !== 'input/useKeyboard.ts').map((b) => b.file));
    expect(files.size).toBeGreaterThan(15);
    const missing = [...files].filter((f) => !/\b(notGameKey|isChatShortcut)\(/.test(readFileSync(path.join(SRC, f), 'utf8')));
    expect(missing, 'guard these keydown handlers with notGameKey(e) (input/useKeyboard.ts)').toEqual([]);
  });
});

describe('E', () => {
  it('has one owner: the first prompt in E_ORDER, and only the steed in the saddle', () => {
    expect(E_ORDER[0]).toBe('town');
    expect(E_ORDER.at(-1)).toBe('steed');
    // no DOM here: nothing above anyone, so every user may act on foot
    for (const u of E_ORDER) expect(eTakenAbove(u, false)).toBe(false);
    for (const u of E_ORDER) expect(eTakenAbove(u, true)).toBe(u !== 'steed');
  });

  it('every E handler in the declared table takes part in E_ORDER', () => {
    const eFiles = BINDINGS.filter((b) => b.ctx === 'world' && b.code === 'KeyE').map((b) => b.file);
    for (const f of eFiles) expect(readFileSync(path.join(SRC, f), 'utf8').includes('eFree('), f).toBe(true);
  });
});
