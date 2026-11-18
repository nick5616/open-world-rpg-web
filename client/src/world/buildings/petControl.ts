// Petting, the wiring side (playtest 5, CR 054): E on a dog or cat starts it
// (rules in petting.ts), it follows the zone (Interact 183 out, Events 1970
// and 1971 in), moving or a fight ends it, and the avatar, the animal and the
// sound are told. Offline (no zone) it all works locally.

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { localPlayer, view } from '../../state/live';
import { netRuntime } from '../../net/netStore';
import { audioWorld, emitSound } from '../../audio/bridge';
import { useCombatHud } from '../../combat/store';
import { localEmote, setEmote, SELF } from '../../ui/emotes/store';
import type { Candidate } from './interact';
import type { TownAnimals } from './townAnimals';
import { EMOTE_PET_ANIMAL, EV_ANIMAL_PET, EV_ANIMAL_PET_REFUSED, PET_ACT, PET_INTERACT, PET_REFUSAL, beginPet, endPet, petBlocked, petCancelled, petState, tickPet } from './petting';

/** Why E on this animal does nothing right now (null: it started). Called from TownHud.act. */
export function startPetting(c: Candidate, now = performance.now()): string | null {
  if (petState.active) return null;
  const f = localPlayer.pos;
  const why = petBlocked({
    mounted: localPlayer.mounted,
    downed: useCombatHud.getState().downedUntil > now,
    inCombat: audioWorld.combatUntil > now,
    grounded: localPlayer.grounded && localPlayer.mode !== 'swim' && localPlayer.mode !== 'fly',
    dist: Math.hypot(c.x - f.x, c.z - f.z),
  });
  if (why) return why;
  const key = Number(c.stableId);
  beginPet(key, c.role, c.name, now, f);
  setEmote(SELF, EMOTE_PET_ANIMAL, key, f.x, f.y, f.z, now);
  localEmote.id = EMOTE_PET_ANIMAL;
  localEmote.n++;
  localEmote.at = now;
  netRuntime.session?.sendInteract(PET_INTERACT, BigInt(key), PET_ACT.start);
  emitSound(c.role === 2 ? 'pet_cat' : 'pet_dog', { at: { x: c.x, y: c.y, z: c.z } });
  return null;
}

function stopLocal(tellZone: boolean): void {
  if (!petState.active) return;
  const key = petState.key;
  endPet(false);
  setEmote(SELF, 0, 0, view.feet.x, view.feet.y, view.feet.z);
  if (tellZone) netRuntime.session?.sendInteract(PET_INTERACT, BigInt(key), PET_ACT.stop);
}

/** Per frame: the clock, and what ends it early (moving, jumping, a fight, the saddle, getting hurt). */
export function tickPetting(now = performance.now()): void {
  if (!petState.active) return;
  const lp = localPlayer;
  const speed = Math.hypot(lp.vel.x, lp.vel.z);
  const moved = Math.hypot(lp.pos.x - petState.fx, lp.pos.z - petState.fz) > 0.9;
  if (petCancelled({ speed: moved ? 9 : speed, grounded: lp.grounded, mounted: lp.mounted, inCombat: audioWorld.combatUntil > now, downed: useCombatHud.getState().downedUntil > now })) {
    stopLocal(true);
    return;
  }
  tickPet(now);
}

/** Events 1970 / 1971 (the hud's session hook). Returns the toast to show, if any. */
export function onPetEvent(e: ZoneEvent, animals: TownAnimals, now = performance.now()): string | null {
  if (e.kind === EV_ANIMAL_PET_REFUSED) {
    if (petState.active && petState.key === e.targetId) stopLocal(false);
    return PET_REFUSAL[e.value] ?? 'Not now';
  }
  if (e.kind !== EV_ANIMAL_PET) return null;
  const x = e.x / 100;
  const y = e.y / 100;
  const z = e.z / 100;
  if (e.value === 1) {
    animals.remotePet(e.targetId, e.entityId, true, x, z, now);
    setEmote(e.entityId, EMOTE_PET_ANIMAL, e.targetId, x, y, z, now);
    const kind = (e.targetId & 0xff) >> 6;
    emitSound(kind === 2 ? 'pet_cat' : 'pet_dog', { at: { x, y: y + 0.4, z } });
  } else {
    animals.remotePet(e.targetId, e.entityId, false, x, z, now);
    setEmote(e.entityId, 0, 0, x, y, z, now);
  }
  return null;
}
