// Speech bubbles over townsfolk heads (playtest 4, CR 050): every live line
// of npcFocus (zone barks, greetings, market cries, chats, dialog lines) is
// drawn as a small DOM card over its speaker. A handful of reusable divs
// positioned from the projected head (the same cheap way as the name
// labels): at most BUBBLE_MAX at once, nearest first, within BUBBLE_M of the
// camera, easing in and out; a line addressed to you gets a warm border and
// a touch more weight.

import * as THREE from 'three';
import { npcFocus, playerFocus } from './npcFocus';
import { BUBBLE_M, BUBBLE_MAX, bubbleAlpha, selectBubbles, type BubbleCandidate } from './npcLife';

interface Cand extends BubbleCandidate {
  text: string;
  from: number;
  until: number;
  sx: number;
  sy: number;
}

export interface BubbleSubject {
  x: number;
  y: number;
  z: number;
}

const BASE =
  'position:absolute;transform:translate(-50%,-100%);max-width:clamp(230px,18vw,420px);padding:5px 10px 6px;border-radius:10px;font:500 clamp(13px,0.8vw + 0.35vh,20px)/1.25 system-ui,sans-serif;text-align:center;pointer-events:none;will-change:opacity,transform;white-space:normal;';

export class BubbleLayer {
  /** npc: townsfolk lines (npcFocus); player: what players say in a conversation (Event 1960, CR 053). */
  constructor(private readonly kind: 'npc' | 'player' = 'npc') {}

  private root: HTMLDivElement | null = null;
  private readonly els: HTMLDivElement[] = [];
  private readonly cands: Cand[] = [];
  private readonly p = new THREE.Vector3();
  /** Keys that have a bubble this frame (the name labels step aside for them). */
  readonly shown = new Set<number>();

  /**
   * Per frame: draw the live lines. `subject(key)` gives a speaker's position
   * (undefined: not in view, no bubble). `headY` is how far above its feet
   * the bubble hangs.
   */
  update(camera: THREE.Camera, subject: (key: number) => BubbleSubject | undefined, nowMs: number, headY = 2.35): void {
    this.shown.clear();
    const live = this.kind === 'player' ? playerFocus.live(nowMs) : npcFocus.live(nowMs);
    if (!live.length && !this.els.some((e) => e.style.display !== 'none')) return;
    if (!this.root) {
      this.root = document.createElement('div');
      this.root.dataset.testid = this.kind === 'player' ? 'player-bubbles' : 'npc-bubbles';
      this.root.setAttribute('aria-hidden', 'true');
      Object.assign(this.root.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '16', overflow: 'hidden' });
      document.body.appendChild(this.root);
    }
    const cam = camera.position;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.cands.length = 0;
    for (const [key, l] of live) {
      const s = subject(key);
      if (!s) continue;
      const d = Math.hypot(s.x - cam.x, s.y + 1.6 - cam.y, s.z - cam.z);
      if (d > BUBBLE_M) continue;
      this.p.set(s.x, s.y + headY, s.z).project(camera);
      const onScreen = this.p.z > -1 && this.p.z < 1 && Math.abs(this.p.x) < 1.05 && Math.abs(this.p.y) < 1.05;
      this.cands.push({ key, d, toYou: l.toYou, onScreen, text: l.text, from: l.from, until: l.until, sx: ((this.p.x + 1) / 2) * w, sy: ((1 - this.p.y) / 2) * h });
    }
    const chosen = selectBubbles(this.cands, BUBBLE_MAX);
    let k = 0;
    for (const c of chosen) {
      let el = this.els[k];
      if (!el) {
        el = document.createElement('div');
        el.innerHTML = '<span></span><i style="position:absolute;left:50%;bottom:-5px;width:9px;height:9px;transform:translateX(-50%) rotate(45deg);background:inherit;border-right:inherit;border-bottom:inherit"></i>';
        this.els.push(el);
        this.root.appendChild(el);
      }
      const span = el.firstChild as HTMLSpanElement;
      if (span.textContent !== c.text) span.textContent = c.text;
      const key = c.toYou ? 'y' : 'n';
      if (el.dataset.kind !== key) {
        el.dataset.kind = key;
        el.style.cssText =
          BASE +
          (this.kind === 'player'
            ? c.toYou
              ? 'background:#e6f1ff;color:#10233a;border:2px solid #5fa0e0;box-shadow:0 2px 10px #0008,0 0 12px #8fc4ff66;font-weight:600;font-style:italic;'
              : 'background:#e9eef4;color:#1d2a38;border:1px solid #7a8da3;box-shadow:0 2px 8px #0007;font-style:italic;'
            : c.toYou
            ? 'background:#fff6dc;color:#2a1c0c;border:2px solid #d9a441;box-shadow:0 2px 10px #0008,0 0 12px #f3d48a66;font-weight:600;'
            : 'background:#f3ecdc;color:#2a2418;border:1px solid #8a7a58;box-shadow:0 2px 8px #0007;');
      }
      const a = bubbleAlpha(nowMs, c.from, c.until, c.d);
      const rise = (1 - Math.min(1, (nowMs - c.from) / 220)) * 6;
      el.style.left = `${c.sx.toFixed(1)}px`;
      el.style.top = `${(c.sy + rise).toFixed(1)}px`;
      el.style.opacity = a.toFixed(2);
      el.style.display = '';
      this.shown.add(c.key);
      k++;
    }
    for (let i = k; i < this.els.length; i++) this.els[i].style.display = 'none';
  }

  dispose(): void {
    this.root?.remove();
    this.root = null;
    this.els.length = 0;
  }
}
