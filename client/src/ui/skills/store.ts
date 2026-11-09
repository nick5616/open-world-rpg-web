// Skill tree screen state (playtest 2): open, which tab, which node is
// picked (its card in the sidebar; a picked learned spell goes into the
// slot you click next).

import { create } from 'zustand';
import { spellByKey, TREE_ORDER } from './tree';

const spellTree = (key: string) => spellByKey.get(key)?.tree;

/** A spell tree key ('fire'...), 'skills' (weapon skills and techniques) or 'build' (the build overview). */
export type SkillTab = string;

export interface SkillScreenState {
  open: boolean;
  tab: SkillTab;
  /** The last spell tree tab (N reopens it). */
  lastTree: string;
  picked: string | null;
}

export const useSkillScreen = create<SkillScreenState>(() => ({ open: false, tab: TREE_ORDER[0] ?? 'fire', lastTree: TREE_ORDER[0] ?? 'fire', picked: null }));

export function openSkillScreen(tab?: SkillTab): void {
  const s = useSkillScreen.getState();
  const t = tab ?? s.lastTree;
  useSkillScreen.setState({ open: true, tab: t, lastTree: TREE_ORDER.includes(t) ? t : s.lastTree });
  if (typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock();
}

export function closeSkillScreen(): void {
  useSkillScreen.setState({ open: false, picked: null });
}

export function setSkillTab(tab: SkillTab): void {
  const s = useSkillScreen.getState();
  // A picked spell stays picked only on its own tree.
  const keep = s.picked && TREE_ORDER.includes(tab) && spellTree(s.picked) === tab;
  useSkillScreen.setState({ tab, lastTree: TREE_ORDER.includes(tab) ? tab : s.lastTree, picked: keep ? s.picked : null });
}

/** The key: same tab toggles closed, another tab switches. */
export function toggleSkillScreen(tab?: SkillTab): void {
  const s = useSkillScreen.getState();
  const want = tab ?? s.lastTree;
  if (s.open && (s.tab === want || (!tab && TREE_ORDER.includes(s.tab)))) closeSkillScreen();
  else openSkillScreen(want);
}
