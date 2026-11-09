// In-world screen: the canvas plus DOM overlays. Lazy-loaded by App so the
// title screen doesn't pull in three.js. Online (WP06) when the account
// screen handed over a ReadySession, else the generated world offline
// (solo builds, "continue offline"); both render through WP05's WorldCanvas.
import { WorldCanvas } from '../world/WorldCanvas';
import { DebugHud } from '../hud/DebugHud';
import { DebugPanel } from '../hud/DebugPanel';
import { Crosshair, LockHint } from '../hud/Overlays';
import { StaminaWheel } from '../hud/StaminaWheel';
import { useDebugHotkeys } from '../hud/useDebugHotkeys';
import { useAppStore } from '../stores/appStore';
import { NetPlay, useOnlineSession } from '../net/NetPlay';
import { DEBUG, SOLO } from '../config';
// WP08: renders nothing until the play flow calls startSocial() (client/src/social/README.md).
import { SocialOverlay } from '../social';
// WP12: compass, discovery toasts, map (M).
import { ExplorationHud } from '../ui/map/ExplorationHud';
// WP13: health, mana, spell slots, boss bar, damage numbers (renders nothing offline).
import { CombatHud } from '../combat/CombatHud';
// WP11: renders nothing until NetPlay starts voice (client/src/voice/README.md).
import { VoiceHud } from '../voice';
// WP14: inventory (I), crafting panel (forge/cook stations), loot toasts, Bitchin' banner, [E] containers/pickups (client/src/ui/inventory/README.md).
import { CraftPanel, InventoryScreen, LootHud } from '../ui/inventory';
// Playtest 1: level-up fanfare, character panel (C), area notices, crystal tower prompt (client/src/ui/progression/README.md).
import { ProgressionHud } from '../ui/progression';
import { PvpHud } from '../ui/pvp';
// Playtest 2: skill tree (N) and build overview (B) (client/src/ui/skills/README.md).
import { SkillScreen } from '../ui/skills';
import { QuestHud } from '../ui/quests/QuestHud';
// Sound and music: boots the audio engine after the first playable frame; K = sound settings (client/src/audio/README.md).
import { AudioRoot } from '../audio/ui/AudioRoot';

function DebugLayer() {
  useDebugHotkeys();
  const hud = useAppStore((s) => s.hudVisible);
  const panel = useAppStore((s) => s.debugPanelOpen);
  return (
    <>
      {hud && <DebugHud />}
      {panel && <DebugPanel />}
    </>
  );
}

export default function PlayScreen() {
  const ready = useOnlineSession();
  const online = !SOLO && ready !== null;
  return (
    <>
      {online ? <NetPlay ready={ready} /> : <WorldCanvas />}
      <Crosshair />
      <StaminaWheel />
      <LockHint />
      {DEBUG && <DebugLayer />}
      <SocialOverlay />
      <ExplorationHud />
      <CombatHud />
      <VoiceHud />
      {/* WP14 */}
      <LootHud />
      <InventoryScreen />
      <CraftPanel />
      <ProgressionHud />
      {/* Playtest 2: PvP flag, duel prompt, countdown, result, kill feed (CR 018) */}
      <PvpHud />
      <SkillScreen />
      {/* Playtest 1: quest tracker, offers with location previews, journal (J) */}
      <QuestHud />
      <AudioRoot />
    </>
  );
}
