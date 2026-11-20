// Playtest 6 polish: what the disconnect screen says, and whether the client
// tries again on its own. It printed the wire names ("Disconnected: bad
// ticket", "ticket: expired") with two unstyled buttons; an expired ticket
// (tickets live 60 s, so any remount or long stall that reuses one) is
// fixed by asking the director for a fresh one, which the player had to know
// to click.

export interface EndInfo {
  /** The kick's wire name (KickCode), when the zone kicked us. */
  kick?: string;
  /** The zone's reason or the transport's error text. */
  reason: string;
}

export interface EndCopy {
  title: string;
  detail: string;
  /** Try to reconnect without a click (a fresh ticket from the director). */
  autoRetry: boolean;
  /** The page itself must be reloaded (a new client build). */
  reload: boolean;
}

/** The disconnect screen's words for a session end. */
export function endCopy(e: EndInfo): EndCopy {
  switch (e.kick) {
    case 'bad_ticket':
      return { title: 'Your pass into the world ran out', detail: 'Getting a fresh one…', autoRetry: true, reload: false };
    case 'version_mismatch':
      return { title: 'Lodestone has been updated', detail: 'Reload the page to get the new version.', autoRetry: false, reload: true };
    case 'duplicate_login':
      return { title: 'This character signed in somewhere else', detail: 'Another tab or device is playing it now.', autoRetry: false, reload: false };
    case 'server_full':
      return { title: 'This world is full right now', detail: 'Try again in a minute.', autoRetry: false, reload: false };
    case 'rate_limited':
      return { title: 'Disconnected for sending too much at once', detail: 'Reconnect to carry on.', autoRetry: false, reload: false };
    case 'shutdown':
      return { title: 'The world is restarting', detail: 'Reconnecting when it is back…', autoRetry: true, reload: false };
    case undefined:
      return { title: 'Connection lost', detail: 'Reconnecting…', autoRetry: true, reload: false };
    default:
      return { title: 'Disconnected', detail: e.reason, autoRetry: false, reload: false };
  }
}

/** Automatic tries before the screen waits for a click, and the wait before each (ms). */
export const AUTO_RETRY_DELAYS_MS = [800, 3000, 8000] as const;
