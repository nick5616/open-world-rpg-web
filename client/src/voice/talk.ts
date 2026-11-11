// Push-to-talk / voice-activation logic (spec 10 "Proximity voice" 5),
// independent of LiveKit so it is unit-tested with a fake microphone.
//
// Rules:
//  - The microphone is not requested until the first push of the talk key
//    (or until the player opts into voice activation, which is the same
//    consent). Never at connect.
//  - Push-to-talk (default): transmit while the key is held.
//  - Voice activation (opt-in): transmit while the local level gate is open.
//  - Listen-only players (moderator-muted: the token has no publish grant) never transmit.
//  - Mic enable/disable calls are serialized: a quick tap while the
//    permission prompt is open must not leave the mic live afterwards.

import type { MicState, TalkMode } from './store';

export interface Mic {
  /** Ask for the microphone and publish it (muted). Rejects if denied. */
  acquire(): Promise<void>;
  /** Unmute/mute the published track. */
  setLive(live: boolean): Promise<void>;
}

export interface TalkState {
  mic: MicState;
  transmitting: boolean;
}

export class TalkController {
  mode: TalkMode;
  private held = false;
  private gateOpen = false;
  private mic: MicState = 'idle';
  private live = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly device: Mic,
    private readonly onChange: (s: TalkState) => void,
    private readonly canPublish: () => boolean,
    mode: TalkMode = 'ptt',
  ) {
    this.mode = mode;
  }

  get state(): TalkState {
    return { mic: this.mic, transmitting: this.live };
  }

  /** Talk key down. Returns false when this player cannot transmit at all. */
  press(): boolean {
    if (!this.canPublish()) return false;
    this.held = true;
    this.ensureMic();
    this.apply();
    return true;
  }

  release(): void {
    this.held = false;
    this.apply();
  }

  /** The talk key is down (or, in toggle mode, latched on). */
  get isHeld(): boolean {
    return this.held;
  }

  /**
   * Re-evaluates after something canPublish reads changed (the player muted
   * or unmuted their microphone): stops a live mic at once, and in open-mic
   * mode starts the microphone on unmute.
   */
  refresh(): void {
    if (!this.canPublish()) this.held = false;
    else if (this.mode === 'vad') this.ensureMic();
    this.apply();
  }

  /** Voice-activation gate from the local level meter. */
  setGate(open: boolean): void {
    if (open === this.gateOpen) return;
    this.gateOpen = open;
    this.apply();
  }

  /** Asks for the microphone now (the settings' Retry button: the click is the consent). */
  retryMic(): boolean {
    if (!this.canPublish()) return false;
    this.ensureMic();
    this.apply();
    return true;
  }

  setMode(mode: TalkMode): void {
    this.mode = mode;
    // Choosing voice activation is the player asking for an open mic: that
    // is the consent the first push gives in push-to-talk.
    if (mode === 'vad' && this.canPublish()) this.ensureMic();
    this.apply();
  }

  private ensureMic(): void {
    if (this.mic !== 'idle' && this.mic !== 'denied') return;
    this.mic = 'requesting';
    this.emit();
    this.chain = this.chain.then(
      () =>
        this.device.acquire().then(
          () => {
            this.mic = 'ready';
          },
          () => {
            // Denied or no device: stay listen-only until the next push asks again.
            this.mic = 'denied';
          },
        ),
    );
    this.chain.then(() => {
      this.emit();
      this.apply();
    });
  }

  private desired(): boolean {
    if (this.mic !== 'ready' || !this.canPublish()) return false;
    return this.mode === 'ptt' ? this.held : this.gateOpen;
  }

  private apply(): void {
    this.chain = this.chain.then(async () => {
      const want = this.desired();
      if (want === this.live) return;
      try {
        await this.device.setLive(want);
        this.live = want;
      } catch {
        this.live = false;
      }
      this.emit();
    });
  }

  private emit(): void {
    this.onChange(this.state);
  }

  /** Resolves when queued mic operations are done (tests). */
  settled(): Promise<void> {
    return this.chain;
  }
}
