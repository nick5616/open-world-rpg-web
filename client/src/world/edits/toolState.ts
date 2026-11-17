// The work tool (CR 040): which of chopping and breaking, digging and filling
// the left mouse button does right now. Key = (Equal) cycles it. Kept in its own tiny
// module so the combat runtime can ask "is the left button the shovel's?"
// without importing the world.

export type WorkMode = 'off' | 'harvest' | 'dig' | 'fill';

export const WORK_ORDER: readonly WorkMode[] = ['off', 'harvest', 'dig', 'fill'];

export const workTool = { mode: 'off' as WorkMode };

export function cycleWorkTool(): WorkMode {
  workTool.mode = WORK_ORDER[(WORK_ORDER.indexOf(workTool.mode) + 1) % WORK_ORDER.length];
  return workTool.mode;
}

export function setWorkTool(m: WorkMode): void {
  workTool.mode = m;
}

/** The left mouse button belongs to the work tool (the weapon stays sheathed). */
export const workToolActive = (): boolean => workTool.mode !== 'off';
