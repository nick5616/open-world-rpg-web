// Playtest 2: who gets the mouse-look deltas this frame. Normally the
// player's view (PlayerController); the emote wheel (ui/emotes) borrows them
// to pick a sector while H is held, photo mode (ui/photo) to turn its free
// camera. `blockMove` stands the player still (photo mode flies with WASD).

export const lookRouter = {
  sink: null as null | ((dx: number, dy: number) => void),
  blockMove: false,
};
