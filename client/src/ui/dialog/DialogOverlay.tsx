// The conversation (CR 049): light and cinematic. The camera frames the
// person's face (ui/dialog/camera.ts), the rest of the HUD dims, a lower
// third carries their name and role, the line types out (E, Space, Enter or a
// click skips, then goes on) with a soft murmur per person, and the answers
// are numbered (1-6 or a click). Esc closes it (panel stack). The line is
// also mirrored as the person's speech bubble (npcFocus).

import { useEffect, useRef, useState } from 'react';
import { npcFocus } from '../../world/buildings/npcFocus';
import { notGameKey } from '../../input/useKeyboard';
import { dialogController } from './link';
import { advanceAction, choiceForKey, typedChars, useDialog } from './store';
import { blipsAt, speakBlip } from './voice';
import type { DialogChoice } from './events';

const CSS = `
body[data-dialog] > #root > *:not([data-dialog-ui]):not(canvas):not([data-testid="town-panel"]) { opacity: 0.12; transition: opacity .35s ease; pointer-events: none; }
body[data-dialog] canvas { filter: saturate(0.92) contrast(1.03); }
@keyframes ls-dlg-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
[data-dialog-ui] button:focus-visible { outline: 2px solid #f3d48a; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { [data-dialog-ui] * { animation: none !important; transition: none !important; } }
`;

const KIND_GLYPH: Record<string, string> = { rumour: '✶', work: '◆', quest: '❗', mark: '◉', more: '›', leave: '×', topic: '•' };
const KIND_TINT: Record<string, string> = { rumour: '#9fd8ff', work: '#f3d48a', quest: '#ffdf8a', mark: '#a6e8b4', more: '#d8cdb6', leave: '#c9b99a', topic: '#efe6d2' };

function ensureCss(): void {
  if (typeof document === 'undefined' || document.getElementById('ls-dialog-css')) return;
  const el = document.createElement('style');
  el.id = 'ls-dialog-css';
  el.textContent = CSS;
  document.head.appendChild(el);
}

function warmth(aff: number): string {
  const n = Math.max(0, Math.min(5, Math.floor(aff / 2)));
  return '♥'.repeat(n) + '♡'.repeat(5 - n);
}

export function DialogOverlay() {
  const open = useDialog((s) => s.open);
  const parked = useDialog((s) => s.parked);
  const node = useDialog((s) => s.node);
  const lineAt = useDialog((s) => s.lineAt);
  const key = useDialog((s) => s.key);
  const toast = useDialog((s) => s.toast);
  const [shown, setShown] = useState(0);
  const [, tick] = useState(0);
  const typed = useRef(false);
  const total = node?.line.length ?? 0;
  typed.current = total > 0 && shown >= total;

  useEffect(ensureCss, []);

  // The HUD dims while a conversation is up.
  const live = open && !parked && !!node;
  useEffect(() => {
    if (live) document.body.dataset.dialog = '1';
    else delete document.body.dataset.dialog;
    return () => {
      delete document.body.dataset.dialog;
    };
  }, [live]);

  // Typewriter: reveal by time; a soft blip every few letters; the person "speaks" meanwhile.
  useEffect(() => {
    if (!node || !live) return;
    let raf = 0;
    let last = 0;
    const line = node.line;
    const step = () => {
      const n = typedChars(line, performance.now() - lineAt);
      if (n !== last) {
        if (key !== null) for (let i = last; i < n; i++) if (blipsAt(line[i], i)) speakBlip(key, line[i], i);
        last = n;
        setShown(n);
      }
      if (n < line.length) raf = requestAnimationFrame(step);
      else npcFocus.setSpeaking(false);
    };
    setShown(0);
    npcFocus.setSpeaking(true);
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      npcFocus.setSpeaking(false);
    };
  }, [node, lineAt, live, key]);

  // The toast (why it ended) fades on its own.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => tick((n) => n + 1), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  // Keys: 1-6 pick, E / Space / Enter skip then go on (Esc is the panel stack's).
  useEffect(() => {
    if (!live || !node) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || notGameKey(e)) return;
      const i = choiceForKey(e.code, node.choices.length);
      if (i !== null) {
        e.preventDefault();
        e.stopPropagation();
        dialogController.choose(node.choices[i].id);
        return;
      }
      if (e.code === 'KeyE' || e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        advance();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [live, node]);

  const advance = () => {
    const n = useDialog.getState().node;
    if (!n) return;
    const a = advanceAction(typed.current, n.choices);
    if (a.kind === 'skip') {
      setShown(n.line.length);
      npcFocus.setSpeaking(false);
    } else if (a.kind === 'choose') dialogController.choose(a.id);
  };

  const showToast = toast && performance.now() - toast.at < 2600 && !open;
  if (!live) {
    return showToast ? (
      <div data-dialog-ui data-testid="dialog-toast" style={{ position: 'fixed', left: '50%', bottom: '22%', transform: 'translateX(-50%)', zIndex: 44, color: '#f4efe2', font: '600 14px system-ui, sans-serif', textShadow: '0 1px 3px #000', pointerEvents: 'none' }}>
        {toast.text}
      </div>
    ) : null;
  }
  const n = node!;
  const done = shown >= n.line.length;
  return (
    <div data-dialog-ui data-ui-panel data-testid="dialog" data-npc={n.npc.name} onClick={(e) => { if (!(e.target as HTMLElement).closest('button')) advance(); }} style={{ position: 'fixed', inset: 0, zIndex: 45, cursor: 'default', userSelect: 'none' }}>
      {/* cinematic framing: soft bars and a vignette */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: '9vh', background: 'linear-gradient(rgba(6,4,2,0.82), rgba(6,4,2,0))', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at 50% 40%, rgba(0,0,0,0) 45%, rgba(0,0,0,0.5) 100%)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '52vh', background: 'linear-gradient(rgba(6,4,2,0), rgba(6,4,2,0.9) 70%)', pointerEvents: 'none' }} />
      <button data-testid="dialog-close" onClick={() => dialogController.close()} style={{ position: 'absolute', right: 18, top: 14, font: '600 12px system-ui', padding: '4px 10px', borderRadius: 4, border: '1px solid rgba(232,196,106,0.5)', background: 'rgba(24,20,16,0.6)', color: '#efe6d2', cursor: 'pointer' }}>
        Leave (Esc)
      </button>
      <div style={{ position: 'absolute', left: '50%', bottom: '5vh', transform: 'translateX(-50%)', width: 'min(880px, 92vw)', color: '#f4efe2', font: '17px/1.5 Georgia, "Times New Roman", serif', animation: 'ls-dlg-in .3s ease-out', textShadow: '0 1px 3px rgba(0,0,0,0.9)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
          <span data-testid="dialog-name" style={{ font: '600 22px Georgia, serif', color: '#f3d48a', letterSpacing: 0.4 }}>{n.npc.name}</span>
          <span style={{ font: '13px system-ui, sans-serif', opacity: 0.75, textTransform: 'capitalize' }}>{n.npc.title}{n.npc.town ? ` of ${n.npc.town}` : ''}</span>
          {n.met && <span title="How warm they are to you" style={{ font: '12px system-ui', color: '#e58a8a', opacity: 0.85, letterSpacing: 1 }}>{warmth(n.aff)}</span>}
        </div>
        <div data-testid="dialog-line" style={{ minHeight: '3.2em', fontSize: 19 }}>
          {n.line.slice(0, shown)}
          <span style={{ opacity: 0 }}>{n.line.slice(shown)}</span>
        </div>
        {n.quest && done && (
          <div data-testid="dialog-quest" style={{ margin: '8px 0 2px', padding: '6px 10px', border: '1px solid rgba(255,223,138,0.45)', borderRadius: 6, background: 'rgba(60,44,16,0.55)', font: '13px system-ui, sans-serif', color: '#ffe9b0' }}>
            <b>{n.quest.title}</b>
            <span style={{ opacity: 0.85 }}>
              {n.quest.gold ? `  ·  ${n.quest.gold} gold` : ''}
              {n.quest.xp ? `  ·  ${n.quest.xp} XP` : ''}
              {n.quest.items ? `  ·  ${n.quest.items} item${n.quest.items > 1 ? 's' : ''}` : ''}
              {n.quest.rep && n.quest.repTown ? `  ·  renown in ${n.quest.repTown}` : ''}
            </span>
          </div>
        )}
        {n.note && done && <div data-testid="dialog-note" style={{ font: '13px system-ui, sans-serif', color: '#a6e8b4', margin: '2px 0 4px' }}>{n.note}</div>}
        <div data-testid="dialog-choices" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10, opacity: done ? 1 : 0.25, pointerEvents: done ? 'auto' : 'none', transition: 'opacity .2s' }}>
          {n.choices.map((c: DialogChoice, i: number) => (
            <button key={c.id} data-testid={`dialog-choice-${i + 1}`} data-kind={c.kind} onClick={() => dialogController.choose(c.id)} style={{ display: 'flex', alignItems: 'baseline', gap: 10, textAlign: 'left', font: '16px Georgia, serif', color: KIND_TINT[c.kind] ?? '#efe6d2', padding: '5px 12px', borderRadius: 5, border: '1px solid rgba(232,196,106,0.0)', background: 'rgba(24,18,12,0.5)', cursor: 'pointer', textShadow: '0 1px 2px #000' }} onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(70,52,24,0.75)')} onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(24,18,12,0.5)')}>
              <span style={{ font: '600 13px system-ui, sans-serif', color: '#c9a650', width: 14 }}>{i + 1}</span>
              <span style={{ width: 14, opacity: 0.85 }}>{KIND_GLYPH[c.kind] ?? '•'}</span>
              <span>{c.text}</span>
            </button>
          ))}
        </div>
        {!done && <div style={{ font: '11px system-ui, sans-serif', opacity: 0.55, marginTop: 6 }}>E / Space: skip</div>}
      </div>
    </div>
  );
}
