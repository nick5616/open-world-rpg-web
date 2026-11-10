// In-world screen: the canvas plus DOM overlays. Lazy-loaded by App so the
// title screen doesn't pull in three.js. Online (WP06) when the account
// screen handed over a ReadySession, else the generated world offline
// (solo builds, "continue offline"); both render through WP05's WorldCanvas.
import { WorldCanvas } from '../world/WorldCanvas';
// Playtest 2: photo mode (L) and fishing take their keys in the capture phase from module load,
// before any panel's own listener (ui/photo/PhotoMode.tsx, ui/fishing/FishingHud.tsx).
import { PhotoMode } from '../ui/photo/PhotoMode';
import { FishingHud } from '../ui/fishing/FishingHud';
// Playtest 2: hold H for the emote wheel (ui/emotes).
import { EmoteWheel } from '../ui/emotes/EmoteWheel';
import { DebugHud } from '../hud/DebugHud';
import { DebugPanel } from '../hud/DebugPanel';
import { Crosshair, LockHint } from '../hud/Overlays';
import { StaminaWheel } from '../hud/StaminaWheel';
// Playtest 2: T toggles the third-person camera (hud/ViewHud.tsx, scene/thirdPerson.ts).
import { ViewHud } from '../hud/ViewHud';
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
// Playtest 2 content (CR 023): world events, lore tablets, herbs, sealed vaults, feats (client/src/ui/content/README.md).
import { ContentHud } from '../ui/content/ContentHud';
// Playtest 2 camps (CR 025): P = camp menu, placement, chests, signposts, Rested (client/src/ui/camps/README.md).
import { CampHud } from '../ui/camps/CampHud';
import { MountHud } from '../ui/mounts/MountHud'; // CR 027 mounts
import { PetHud } from '../ui/pets/PetHud'; // CR 029 pets
// Sound and music: boots the audio engine after the first playable frame; K = sound settings (client/src/audio/README.md).
import { AudioRoot } from '../audio/ui/AudioRoot';
// Playtest 2 onboarding: Esc menu (controls, sound, plug-in settings, leave) and contextual tips (client/src/ui/menu, ui/tips).
import { EscMenu } from '../ui/menu/EscMenu';
import { TipsHud } from '../ui/tips/TipsHud';
// Playtest 2: what's new since this browser last played (client/src/ui/whatsnew).
import { WhatsNew } from '../ui/whatsnew/WhatsNew';
// Playtest 2: spell FX (online it is CombatLayer's; debug solo mounts it for the FX gallery and cast-spam bench).
import { SpellFxLayer } from '../combat/fx/SpellFxLayer';
// `?nofx`: solo without the FX layer (the A/B of the spell FX benchmark, combat/fx/dev/fx-bench.mjs).
const NO_FX = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nofx');

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
      {online ? <NetPlay ready={ready} /> : <WorldCanvas>{DEBUG && !NO_FX && <SpellFxLayer />}</WorldCanvas>}
      <Crosshair />
      <StaminaWheel />
      <LockHint />
      <ViewHud />
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
      {/* Playtest 2: PvP flag, duel prompt, countdown, result, kill feed (CR 019) */}
      <PvpHud />
      <SkillScreen />
      {/* Playtest 1: quest tracker, offers with location previews, journal (J) */}
      <QuestHud />
      <ContentHud />
      <CampHud />
      <MountHud />
      <PetHud />
      {/* Playtest 2: fishing (E at deep water with a rod), emotes (H), photo mode (L) */}
      <FishingHud />
      <EmoteWheel />
      <PhotoMode />
      <AudioRoot />
      <TipsHud />
      <EscMenu />
      <WhatsNew />
    </>
  );
}
