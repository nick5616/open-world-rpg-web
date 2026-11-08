import { weatherHash, isRaining } from '../../../client/src/sim/weather';
console.log(JSON.stringify([0, 1, 2, 3, 2946000, -1].map((w) => weatherHash(20261108n, w))), isRaining(20261108n, 0));
