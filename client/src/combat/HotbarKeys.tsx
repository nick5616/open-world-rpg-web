// CR 039: the spell slot keys on the Esc menu's Controls page. Click a
// slot, press the key (or a mouse side button) you want; a key another slot
// holds swaps with it; keys the world already uses for something else are
// refused with what they do (input/bindings.ts). Esc cancels (and, as for
// the voice key capture, goes back a page). Stored in this browser.

import { useEffect, useReducer, useState, type CSSProperties } from 'react';
import { BINDINGS } from '../input/bindings';
import { KEY_MAP } from '../input/useKeyboard';
import { useVoiceStore } from '../voice/store';
import { useCombatHud } from './store';
import { MAX_SPELL_SLOTS, hotbarKey, keyName, mouseCode, onHotbarKeys, resetHotbarKeys, setHotbarKey, slotLevel, spellSlots } from './hotbar';

/** What a world key already does (null: free for a spell slot). Slot keys themselves are not "taken" (they swap). */
export function takenBy(code: string): string | null {
  if (KEY_MAP[code]) return `that key is ${KEY_MAP[code]}`;
  const v = useVoiceStore.getState();
  if (code === v.pttKey) return 'that key is push to talk (voice settings)';
  if (code === v.muteKey) return 'that key mutes your microphone (voice settings)';
  if (code === 'Slash' || code === 'Enter') return 'that key opens chat';
  if (code === 'Escape' || code === 'Tab') return 'that key is the menu / the technique';
  const b = BINDINGS.find((x) => x.ctx === 'world' && x.code === code && x.file !== 'combat/hotbar.ts');
  return b ? `that key is "${b.does}"` : null;
}

const KEYCAP: CSSProperties = { display: 'inline-block', minWidth: 22, padding: '0 6px', border: '1px solid rgba(255,255,255,0.4)', borderBottomWidth: 2, borderRadius: 4, background: 'rgba(255,255,255,0.07)', font: '600 11.5px/19px system-ui, sans-serif', textAlign: 'center', whiteSpace: 'nowrap', color: '#e9ecef', cursor: 'pointer' };

export function HotbarKeys() {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [capture, setCapture] = useState(-1);
  const [msg, setMsg] = useState('');
  const level = useCombatHud((s) => s.level);
  useEffect(() => onHotbarKeys(bump), []);
  useEffect(() => {
    if (capture < 0) return;
    const done = (code: string | null) => {
      if (!code) return;
      const why = setHotbarKey(capture, code, takenBy);
      setMsg(why ? `${keyName(code)}: ${why}` : `Slot ${capture + 1}: ${keyName(code)}`);
      setCapture(-1);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        setCapture(-1); // and the menu goes back a page, like the voice key capture
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      done(e.code);
    };
    const onMouse = (e: MouseEvent) => {
      const c = mouseCode(e.button);
      if (!c) return;
      e.preventDefault();
      done(c);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
    };
  }, [capture]);
  const open = spellSlots(level);
  return (
    <div data-testid="hotbar-keys" style={{ margin: '4px 0 12px', padding: '8px 10px', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <span style={{ color: '#ffd166', font: '600 12px system-ui, sans-serif', letterSpacing: 0.5, textTransform: 'uppercase' }}>Spell slot keys</span>
        <span style={{ fontSize: 11.5, opacity: 0.65 }}>click a slot, then press a key or a mouse side button · a new slot every ten levels</span>
        <button data-testid="hotbar-keys-reset" tabIndex={-1} onClick={() => (resetHotbarKeys(), setMsg('Back to 1 2 3 4 8 9 - ='))} style={{ ...KEYCAP, marginLeft: 'auto', font: '12px system-ui, sans-serif', padding: '1px 8px' }}>
          Defaults
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px' }}>
        {Array.from({ length: MAX_SPELL_SLOTS }, (_, i) => (
          <span key={i} style={{ fontSize: 12.5, opacity: i < open ? 1 : 0.6 }} title={i < open ? undefined : `Opens at level ${slotLevel(i)}`}>
            {i + 1}{' '}
            <button data-testid={`hotbar-key-${i}`} tabIndex={-1} onClick={() => (setCapture(capture === i ? -1 : i), setMsg(''))} style={{ ...KEYCAP, background: capture === i ? '#2b4f7a' : KEYCAP.background }}>
              {capture === i ? 'press a key…' : keyName(hotbarKey(i))}
            </button>
            {i >= open && <span style={{ fontSize: 10.5, opacity: 0.8 }}> L{slotLevel(i)}</span>}
          </span>
        ))}
      </div>
      {msg && (
        <div data-testid="hotbar-keys-msg" style={{ fontSize: 11.5, marginTop: 6, opacity: 0.85 }}>
          {msg}
        </div>
      )}
    </div>
  );
}
