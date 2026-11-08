// Which GroundQuery the player walks on. PlayScreen provides the flat
// placeholder; WP05 provides its chunk-backed implementation instead (and its
// own terrain visual) without touching the controller.
import { createContext, useContext } from 'react';
import { FlatGround, type GroundQuery } from '../sim/ground';

export const DEFAULT_GROUND: GroundQuery = new FlatGround(0);
export const GroundContext = createContext<GroundQuery>(DEFAULT_GROUND);
export const useGround = () => useContext(GroundContext);
