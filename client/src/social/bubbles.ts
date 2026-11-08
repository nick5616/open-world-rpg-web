// Speech bubbles for local chat (spec 10: shown over the speaker's head for
// CHAT_BUBBLE_MS). This module owns only the data: remote player models and
// nameplates belong to WP06 (client/src/net/), which reads bubbles from here
// by character name (nameplates know names from the zone's first-sight
// records; zone entity ids and social character ids are different spaces).
//
// Two ways to read, like client/src/state/live.ts vs the stores:
//  - getSpeechBubble(name): imperative, for a render loop (no React).
//  - useSpeechBubble(name): React hook for DOM nameplates.

import { useEffect, useState } from 'react';
import { CHAT_BUBBLE_MS } from '@lodestone/contracts';

export interface SpeechBubble {
  name: string;
  text: string;
  /** performance.now() when it disappears. */
  until: number;
  /** Where it was said (world meters), for a bubble whose speaker is out of view. */
  x?: number;
  z?: number;
}

const bubbles = new Map<string, SpeechBubble>();
const listeners = new Set<() => void>();
let version = 0;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Show (or replace) a bubble over `name`. */
export function showBubble(name: string, text: string, pos?: { x?: number; z?: number }, ms = CHAT_BUBBLE_MS): void {
  bubbles.set(name.toLowerCase(), { name, text, until: now() + ms, x: pos?.x, z: pos?.z });
  version++;
  listeners.forEach((l) => l());
}

/** The live bubble over `name`, or undefined (expired bubbles are dropped lazily). */
export function getSpeechBubble(name: string): SpeechBubble | undefined {
  const k = name.toLowerCase();
  const b = bubbles.get(k);
  if (!b) return undefined;
  if (b.until <= now()) {
    bubbles.delete(k);
    return undefined;
  }
  return b;
}

/** Every live bubble (e.g. to draw them all in one pass). */
export function allSpeechBubbles(): SpeechBubble[] {
  const out: SpeechBubble[] = [];
  for (const b of bubbles.values()) {
    const live = getSpeechBubble(b.name);
    if (live) out.push(live);
  }
  return out;
}

/** Subscribe to bubble changes (returns unsubscribe). */
export function onBubblesChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function bubblesVersion(): number {
  return version;
}

/** React: the bubble over `name`, re-rendering when it appears and when it expires. */
export function useSpeechBubble(name: string | undefined): SpeechBubble | undefined {
  const [, force] = useState(0);
  const b = name ? getSpeechBubble(name) : undefined;
  useEffect(() => onBubblesChanged(() => force((n) => n + 1)), []);
  useEffect(() => {
    if (!b) return;
    const t = setTimeout(() => force((n) => n + 1), Math.max(0, b.until - now()) + 20);
    return () => clearTimeout(t);
  }, [b]);
  return b;
}

/** Test helper. */
export function clearBubbles(): void {
  bubbles.clear();
  version++;
}
