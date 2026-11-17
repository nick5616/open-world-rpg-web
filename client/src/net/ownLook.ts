// The look of the character being played (CR 047): set by the character
// screen when it hands the session over, read by your own body in third
// person (scene/LocalAvatar.tsx). Other players keep the default figure until
// the look is replicated (see docs/cr/047-title-creation.md).

import type { Look } from './look';

let own: Look | null = null;

export function setOwnLook(l: Look | null): void {
  own = l;
}

export function ownLook(): Look | null {
  return own;
}
