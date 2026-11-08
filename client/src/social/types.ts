// Unions over the generated social message types (contracts/social.yaml).
// The generator emits one interface per message; these unions are what the
// socket client sends and receives.

import type {
  C2SAuth, C2SBlock, C2SChatSend, C2SFriendRemove, C2SFriendRequest, C2SFriendRespond, C2SMute, C2SPartyInvite,
  C2SPartyKick, C2SPartyLeave, C2SPartyPromote, C2SPartyRespond, C2SPing, C2SPresence, C2SReply, C2SReport,
  C2SSetFilter, C2SUnblock, C2SUnmute, C2SVoiceToken, C2SWhisper,
  S2CChat, S2CError, S2CFriends, S2CHistory, S2CPartyInvite, S2CPartyLeft, S2CPartyState, S2CPong, S2CRelations,
  S2CSystem, S2CVoiceToken, S2CWelcome, S2CWhisperStatus,
} from '@lodestone/contracts';

export type C2S =
  | C2SAuth | C2SChatSend | C2SWhisper | C2SReply | C2SPartyInvite | C2SPartyRespond | C2SPartyLeave | C2SPartyKick
  | C2SPartyPromote | C2SFriendRequest | C2SFriendRespond | C2SFriendRemove | C2SBlock | C2SUnblock | C2SMute
  | C2SUnmute | C2SReport | C2SPresence | C2SSetFilter | C2SVoiceToken | C2SPing;

export type S2C =
  | S2CWelcome | S2CChat | S2CHistory | S2CWhisperStatus | S2CPartyState | S2CPartyInvite | S2CPartyLeft
  | S2CFriends | S2CError | S2CSystem | S2CVoiceToken | S2CPong | S2CRelations;
