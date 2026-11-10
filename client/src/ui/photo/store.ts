// Playtest 2 photo mode: its settings (client only: nothing here reaches
// the zone). The world scene reads `photo` every frame for the lighting
// preview (time of day) and the photo post pass (depth of field, vignette,
// grain); the free camera lives in PhotoRig (ui/photo/PhotoRig.tsx).

import { create } from 'zustand';
import type { VisualStyle } from '../../stores/qualityStore';

export interface PhotoSettings {
  active: boolean;
  /** Hide the side panel (a clean frame; any photo key brings it back). */
  panelHidden: boolean;
  /** Preview hour 0..24, or null for the live sky. */
  hour: number | null;
  /** Depth of field 0..1 (0 off), focus distance m (0 = auto: what the centre of the view is on). */
  dof: number;
  focusM: number;
  vignette: number;
  grain: number;
  fov: number;
  hidePlates: boolean;
  /** The style when photo mode opened (restored on leaving). */
  styleBefore: VisualStyle | null;
  /** Shots saved this session (the toast counts them). */
  shots: number;
  lastShotAt: number;
}

export const PHOTO_DEFAULTS = { hour: null, dof: 0, focusM: 0, vignette: 0.25, grain: 0.12, fov: 60, hidePlates: true } as const;

export const usePhoto = create<PhotoSettings>(() => ({ active: false, panelHidden: false, styleBefore: null, shots: 0, lastShotAt: 0, ...PHOTO_DEFAULTS }));

/** Per-frame values the rig writes and the world scene reads (no React). */
export const photoLive = {
  /** Auto focus: distance to what the centre of the view hits (m). */
  autoFocusM: 12,
  /** A shot was asked for: the frame after the next render saves it. */
  captureRequested: false,
};

export function photoActive(): boolean {
  return usePhoto.getState().active;
}

/** Photo keys beyond the movement map (PhotoMode's key handler sets them): E/Q up/down, Z/C roll, Alt slow. */
export const photoKeys = { up: false, down: false, rollL: false, rollR: false, slow: false };
export const PHOTO_KEYS: Record<string, keyof typeof photoKeys> = { KeyE: 'up', KeyQ: 'down', KeyZ: 'rollL', KeyC: 'rollR', AltLeft: 'slow' };
