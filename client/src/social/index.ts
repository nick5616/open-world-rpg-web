// client/src/social (WP08): chat, whispers, parties, friends and speech
// bubble data over the social service socket. See README.md for how the
// play flow mounts it.
export { startSocial, stopSocial, sendSocial, submitChatInput, onSocialMessage, type StartSocialOptions } from './session';
export { useSocialStore, nameCandidates, type SocialState, type Line } from './store';
export { getSpeechBubble, allSpeechBubbles, useSpeechBubble, onBubblesChanged, type SpeechBubble } from './bubbles';
export { SocialOverlay, type SocialOverlayProps } from './ui/SocialOverlay';
export { parseInput, completeName, regionOf } from './commands';
