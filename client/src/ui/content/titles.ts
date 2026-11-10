// Titles shown on other players' nameplates (CR 023 feats): entity id ->
// title, from Event 1005. A plain Map read by the avatar's nameplate
// (net/avatar.ts), which redraws only when the text changes.
export const playerTitles = new Map<number, string>();

export function titleOf(id: number): string {
  return playerTitles.get(id) ?? '';
}
