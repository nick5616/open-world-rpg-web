// The conversation (CR 049, revamped in CR 053 / playtest 5). A framed box
// at the bottom of the screen: the person's name, role and town and how warm
// they are to you, a scrollable transcript of this conversation (their lines
// and yours), the current line typing out, and your answers numbered
// underneath, written in your own voice with a tag at the front ([Leave],
// [Barter], [Rumour], [Mage], [Warmth ♥♥♥]...). E, Space, Enter or a click
// skips the typing, 1-6 or a click answers. The way out is always the last
// answer; Esc is the "walk away" path (the panel stack). The camera frames
// the face above the box and the HUD dims. The line is also the person's
// speech bubble (npcFocus), your answer a bubble over you (Event 1960).
//
// Sized by one unit (`--u`): 1 px at 1280x720, growing with the window up to
// 2 px, so it reads from small windows to 4K.

import { useEffect, useRef, useState } from 'react';
import { npcFocus } from '../../world/buildings/npcFocus';
import { notGameKey } from '../../input/useKeyboard';
import { usePanelEsc } from '../../input/panelStack';
import { dialogController } from './link';
import { advanceAction, checkWords, choiceForKey, typedChars, useDialog } from './store';
import { blipsAt, speakBlip } from './voice';
import type { DialogChoice } from './events';

const CSS = `
body[data-dialog] > #root > *:not([data-dialog-ui]):not(canvas):not([data-testid="town-panel"]) { opacity: 0.12; transition: opacity .35s ease; pointer-events: none; }
body[data-dialog] canvas { filter: saturate(0.92) contrast(1.03); }
@keyframes ls-dlg-in { from { opacity: 0; transform: translate(-50%, 12px); } to { opacity: 1; transform: translate(-50%, 0); } }
[data-dialog-ui] { --u: max(1px, min(calc(100vw / 1280), calc(100vh / 720), 2px)); }
[data-dialog-ui] button:focus-visible { outline: 2px solid #f3d48a; outline-offset: 2px; }
.ls-dlg-box { position: absolute; left: 50%; bottom: calc(var(--u) * 22); transform: translateX(-50%); width: min(calc(var(--u) * 940), 94vw); max-height: min(calc(var(--u) * 470), 64vh); display: flex; flex-direction: column; box-sizing: border-box;
  padding: calc(var(--u) * 12) calc(var(--u) * 18) calc(var(--u) * 12); color: #f1e8d4; font: calc(var(--u) * 16) / 1.45 Georgia, "Times New Roman", serif;
  background: linear-gradient(180deg, rgba(34,26,18,0.95), rgba(20,15,10,0.97)); border: calc(var(--u) * 2) solid #b8923e; border-radius: calc(var(--u) * 6);
  box-shadow: 0 0 0 calc(var(--u) * 3) rgba(20,14,8,0.9), 0 calc(var(--u) * 10) calc(var(--u) * 40) rgba(0,0,0,0.65), inset 0 0 calc(var(--u) * 28) rgba(120,84,30,0.22); animation: ls-dlg-in .28s ease-out both; }
.ls-dlg-box::before, .ls-dlg-box::after { content: ''; position: absolute; width: calc(var(--u) * 14); height: calc(var(--u) * 14); border: calc(var(--u) * 2) solid #e8c46a; pointer-events: none; }
.ls-dlg-box::before { left: calc(var(--u) * -6); top: calc(var(--u) * -6); border-right: none; border-bottom: none; }
.ls-dlg-box::after { right: calc(var(--u) * -6); bottom: calc(var(--u) * -6); border-left: none; border-top: none; }
.ls-dlg-head { display: flex; align-items: baseline; gap: calc(var(--u) * 12); padding-bottom: calc(var(--u) * 6); border-bottom: 1px solid rgba(184,146,62,0.45); flex: none; }
.ls-dlg-name { font: 600 calc(var(--u) * 22) Georgia, serif; color: #f3d48a; letter-spacing: .4px; }
.ls-dlg-role { font: calc(var(--u) * 13) system-ui, sans-serif; opacity: .75; text-transform: capitalize; }
.ls-dlg-hearts { font: calc(var(--u) * 13) system-ui, sans-serif; color: #e58a8a; letter-spacing: 1px; }
.ls-dlg-walk { margin-left: auto; font: 600 calc(var(--u) * 12) system-ui, sans-serif; padding: calc(var(--u) * 3) calc(var(--u) * 9); border-radius: 4px; border: 1px solid rgba(232,196,106,0.4); background: rgba(24,20,16,0.6); color: #d9cdb2; cursor: pointer; }
.ls-dlg-walk:hover { background: rgba(70,52,24,0.8); color: #fff; }
.ls-dlg-log { flex: 1 1 auto; min-height: 0; max-height: calc(var(--u) * 120); overflow-y: auto; margin: calc(var(--u) * 6) 0 calc(var(--u) * 4); padding-right: calc(var(--u) * 6); font-size: calc(var(--u) * 14); line-height: 1.4; scrollbar-width: thin; scrollbar-color: #8a6d2f transparent; }
.ls-dlg-log:empty { display: none; }
.ls-dlg-log > div { padding: calc(var(--u) * 1) 0; opacity: .72; }
.ls-dlg-log .you { color: #a9cff0; font-style: italic; padding-left: calc(var(--u) * 28); }
.ls-dlg-log .npc b { color: #d8b86a; font-weight: 600; }
.ls-dlg-log .you b { color: #7fb0e0; font-style: normal; font-weight: 600; }
.ls-dlg-line { flex: none; min-height: calc(var(--u) * 54); font-size: calc(var(--u) * 19); line-height: 1.42; padding: calc(var(--u) * 4) 0; }
.ls-dlg-chip { display: inline-block; margin-left: calc(var(--u) * 8); padding: 0 calc(var(--u) * 8); border-radius: 999px; font: 600 calc(var(--u) * 11) system-ui, sans-serif; vertical-align: middle; }
.ls-dlg-chip.pass { color: #bfe9c4; border: 1px solid #5fa86b; background: rgba(40,90,50,0.45); }
.ls-dlg-chip.fail { color: #f0b9b0; border: 1px solid #b0584d; background: rgba(100,40,34,0.45); }
.ls-dlg-choices { flex: none; display: flex; flex-direction: column; gap: calc(var(--u) * 3); margin-top: calc(var(--u) * 4); padding-top: calc(var(--u) * 8); border-top: 1px solid rgba(184,146,62,0.35); transition: opacity .2s; }
.ls-dlg-choice { display: flex; align-items: baseline; gap: calc(var(--u) * 10); text-align: left; font: calc(var(--u) * 16) / 1.35 Georgia, serif; color: #efe6d2; padding: calc(var(--u) * 4) calc(var(--u) * 10); border-radius: 5px; border: 1px solid transparent; background: rgba(46,34,20,0.5); cursor: pointer; }
.ls-dlg-choice:hover, .ls-dlg-choice:focus-visible { background: rgba(104,76,30,0.75); border-color: rgba(232,196,106,0.55); }
.ls-dlg-num { font: 600 calc(var(--u) * 13) system-ui, sans-serif; color: #c9a650; width: calc(var(--u) * 14); flex: none; }
.ls-dlg-tag { font: 600 calc(var(--u) * 13) system-ui, sans-serif; flex: none; }
.ls-dlg-choice[data-kind="leave"] { color: #cdbf9e; }
.ls-dlg-choice[data-low="1"] { opacity: .62; }
.ls-dlg-choice[data-low="1"] .ls-dlg-tag { text-decoration: line-through; text-decoration-thickness: 1px; }
.ls-dlg-low { font: calc(var(--u) * 11) system-ui, sans-serif; color: #e3948a; margin-left: auto; flex: none; }
.ls-dlg-hint { flex: none; font: calc(var(--u) * 11) system-ui, sans-serif; opacity: .55; margin-top: calc(var(--u) * 6); text-align: right; }
.ls-dlg-card { margin: calc(var(--u) * 4) 0 calc(var(--u) * 2); padding: calc(var(--u) * 6) calc(var(--u) * 10); border: 1px solid rgba(255,223,138,0.45); border-radius: 6px; background: rgba(60,44,16,0.55); font: calc(var(--u) * 13) system-ui, sans-serif; color: #ffe9b0; }
@media (prefers-reduced-motion: reduce) { [data-dialog-ui] * { animation: none !important; transition: none !important; } }
`;

const TAG_TINT: Record<string, string> = { rumour: '#9fd8ff', work: '#f3d48a', quest: '#ffdf8a', mark: '#a6e8b4', more: '#d8cdb6', leave: '#c9b99a', topic: '#efe6d2', check: '#e8b4f0' };

function ensureCss(): void {
  if (typeof document === 'undefined') return;
  let el = document.getElementById('ls-dialog-css');
  if (!el) {
    el = document.createElement('style');
    el.id = 'ls-dialog-css';
    document.head.appendChild(el);
  }
  if (el.textContent !== CSS) el.textContent = CSS;
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
  const history = useDialog((s) => s.history);
  const [shown, setShown] = useState(0);
  const [, tick] = useState(0);
  const typed = useRef(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  const total = node?.line.length ?? 0;
  typed.current = total > 0 && shown >= total;

  useEffect(ensureCss, []);

  // The HUD dims while a conversation is up.
  const live = open && !parked && !!node;
  usePanelEsc('dialog', live, () => dialogController.close()); // Esc = walk away (the panel stack)
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

  // The transcript sticks to the newest line.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length, live]);

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
        if (typed.current) dialogController.choose(node.choices[i].id);
        else advance(); // a number key during the typing skips it first
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
    const a = advanceAction(typed.current, n.choices, !!n.bye);
    if (a.kind === 'skip') {
      setShown(n.line.length);
      npcFocus.setSpeaking(false);
    } else if (a.kind === 'choose') dialogController.choose(a.id);
    else if (a.kind === 'close') dialogController.close();
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
  const who = n.npc.name.split(' ')[0];
  return (
    <div data-dialog-ui data-ui-panel data-testid="dialog" data-npc={n.npc.name} onClick={(e) => { if (!(e.target as HTMLElement).closest('button')) advance(); }} style={{ position: 'fixed', inset: 0, zIndex: 45, cursor: 'default', userSelect: 'none' }}>
      {/* a soft vignette so the face and the box read against any scene */}
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at 50% 35%, rgba(0,0,0,0) 45%, rgba(0,0,0,0.5) 100%)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '48vh', background: 'linear-gradient(rgba(6,4,2,0), rgba(6,4,2,0.55) 75%)', pointerEvents: 'none' }} />
      <div className="ls-dlg-box" data-testid="dialog-box">
        <div className="ls-dlg-head">
          <span className="ls-dlg-name" data-testid="dialog-name">{n.npc.name}</span>
          <span className="ls-dlg-role">{n.npc.title}{n.npc.town ? ` of ${n.npc.town}` : ''}</span>
          {n.met && <span className="ls-dlg-hearts" title="How warm they are to you">{warmth(n.aff)}</span>}
          <button className="ls-dlg-walk" data-testid="dialog-close" onClick={() => dialogController.close()} title="Walk away (Esc)">
            Walk away (Esc)
          </button>
        </div>
        <div className="ls-dlg-log" ref={logRef} data-testid="dialog-transcript" aria-label="This conversation so far">
          {history.map((h, i) =>
            h.who === 'npc' ? (
              <div key={i} className="npc"><b>{who}:</b> {h.text}{h.check ? <span className={`ls-dlg-chip ${h.check.pass ? 'pass' : 'fail'}`}>{checkWords(h.check)}</span> : null}</div>
            ) : (
              <div key={i} className="you"><b>You:</b> {h.tag ? `[${h.tag}] ` : ''}{h.text}</div>
            ),
          )}
        </div>
        <div className="ls-dlg-line" data-testid="dialog-line" aria-live="polite">
          {n.line.slice(0, shown)}
          <span style={{ opacity: 0 }}>{n.line.slice(shown)}</span>
          {n.check && done ? <span data-testid="dialog-check" className={`ls-dlg-chip ${n.check.pass ? 'pass' : 'fail'}`}>{checkWords(n.check)}</span> : null}
        </div>
        {n.quest && done && (
          <div className="ls-dlg-card" data-testid="dialog-quest">
            <b>{n.quest.title}</b>
            <span style={{ opacity: 0.85 }}>
              {n.quest.gold ? `  ·  ${n.quest.gold} gold` : ''}
              {n.quest.xp ? `  ·  ${n.quest.xp} XP` : ''}
              {n.quest.items ? `  ·  ${n.quest.items} item${n.quest.items > 1 ? 's' : ''}` : ''}
              {n.quest.rep && n.quest.repTown ? `  ·  renown in ${n.quest.repTown}` : ''}
            </span>
          </div>
        )}
        {n.note && done && <div data-testid="dialog-note" style={{ font: 'calc(var(--u) * 13) system-ui, sans-serif', color: '#a6e8b4', margin: '2px 0 4px' }}>{n.note}</div>}
        {n.bye ? (
          <div className="ls-dlg-hint" data-testid="dialog-bye" style={{ opacity: done ? 0.8 : 0.35 }}>
            They nod you off. E, click or Esc closes.
          </div>
        ) : (
          <div className="ls-dlg-choices" data-testid="dialog-choices" style={{ opacity: done ? 1 : 0.25, pointerEvents: done ? 'auto' : 'none' }}>
            {n.choices.map((c: DialogChoice, i: number) => (
              <button key={c.id} className="ls-dlg-choice" data-testid={`dialog-choice-${i + 1}`} data-kind={c.kind} data-low={c.low ? '1' : undefined} onClick={() => dialogController.choose(c.id)}>
                <span className="ls-dlg-num">{i + 1}</span>
                <span>
                  {c.tag ? (
                    <span className="ls-dlg-tag" data-testid="dialog-tag" style={{ color: c.low ? '#c98f86' : TAG_TINT[c.kind] ?? '#efe6d2' }}>
                      [{c.tag}]{' '}
                    </span>
                  ) : null}
                  {c.text}
                </span>
                {c.low ? <span className="ls-dlg-low">too low</span> : null}
              </button>
            ))}
          </div>
        )}
        {!n.bye && <div className="ls-dlg-hint">{done ? '1-6 or click to answer  ·  Esc walks away' : 'E / Space: skip'}</div>}
      </div>
    </div>
  );
}
