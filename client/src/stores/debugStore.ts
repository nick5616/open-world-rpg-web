// Dev tool toggles (spec 14). Reactive because the debug panel renders them;
// the player controller reads them with getState() inside useFrame.

import { create } from 'zustand';

export interface TeleportTarget {
  x: number;
  /** Omitted: land on the ground at (x, z). */
  y?: number;
  z: number;
}

interface DebugState {
  fly: boolean;
  freezeTime: boolean;
  showCells: boolean;
  /** Consumed (set back to null) by the player controller on its next frame. */
  pendingTeleport: TeleportTarget | null;
  /** Scripted look for headless runs, which have no pointer lock. Null = mouse. */
  lookOverride: { yaw: number; pitch: number } | null;
  setFly: (v: boolean) => void;
  setFreezeTime: (v: boolean) => void;
  setShowCells: (v: boolean) => void;
  teleport: (t: TeleportTarget) => void;
  takeTeleport: () => TeleportTarget | null;
  setLookOverride: (v: { yaw: number; pitch: number } | null) => void;
}

export const useDebugStore = create<DebugState>()((set, get) => ({
  fly: false,
  freezeTime: false,
  showCells: false,
  pendingTeleport: null,
  lookOverride: null,
  setFly: (fly) => set({ fly }),
  setFreezeTime: (freezeTime) => set({ freezeTime }),
  setShowCells: (showCells) => set({ showCells }),
  teleport: (pendingTeleport) => set({ pendingTeleport }),
  takeTeleport: () => {
    const t = get().pendingTeleport;
    if (t) set({ pendingTeleport: null });
    return t;
  },
  setLookOverride: (lookOverride) => set({ lookOverride }),
}));

/** Parse "x z" or "x y z" (commas or spaces). Returns null when malformed. */
export function parseTeleport(text: string): TeleportTarget | null {
  const parts = text.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) return { x: parts[0], z: parts[1] };
  if (parts.length === 3) return { x: parts[0], y: parts[1], z: parts[2] };
  return null;
}
