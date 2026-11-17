// The look of the character being played (CR 047): set by the character
// screen when it hands the session over, read by your own body in third
// person (scene/LocalAvatar.tsx). Other players keep the default figure until
// the look is replicated (see docs/cr/047-title-creation.md).

import { SKIN_TONES, type Look } from './look';

let own: Look | null = null;

export function setOwnLook(l: Look | null): void {
  own = l;
}

export function ownLook(): Look | null {
  return own;
}

/** Your skin tone as a CSS colour (the default tan until a look is set): first-person hands and sleeves build with it. */
export function ownSkinHex(): string {
  return own ? '#' + SKIN_TONES[own.skin].toString(16).padStart(6, '0') : '#c9a27e';
}
