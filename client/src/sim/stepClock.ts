// The movement step being simulated right now (its input seq): LocalSim sets
// it before each predicted step and ClientPrediction before each replayed
// one. Grounds whose answer depends on the step (building doors, which the
// zone changes from a stamped input seq on: client/src/world/buildings/
// doorGround.ts) read it, so a replay sees the world exactly as the zone
// did for that frame. Single-threaded: set, step, done.
export const stepClock = { seq: 0 };
