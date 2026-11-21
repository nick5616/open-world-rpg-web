import { describe, expect, it } from 'vitest';
import { endCopy } from './endCopy';

describe('disconnect screen words (playtest 6 polish)', () => {
  it('retries an expired ticket and a lost connection on its own', () => {
    expect(endCopy({ kick: 'bad_ticket', reason: 'ticket: expired' }).autoRetry).toBe(true);
    expect(endCopy({ reason: 'websocket connect timeout (10000 ms)' }).autoRetry).toBe(true);
    expect(endCopy({ kick: 'shutdown', reason: '' }).autoRetry).toBe(true);
  });
  it('never retries what a retry cannot fix', () => {
    expect(endCopy({ kick: 'duplicate_login', reason: '' }).autoRetry).toBe(false);
    expect(endCopy({ kick: 'version_mismatch', reason: '' })).toMatchObject({ autoRetry: false, reload: true });
    expect(endCopy({ kick: 'server_full', reason: '' }).autoRetry).toBe(false);
  });
  it('does not show wire names as the title', () => {
    for (const kick of ['bad_ticket', 'version_mismatch', 'duplicate_login', 'server_full', 'rate_limited', 'shutdown']) expect(endCopy({ kick, reason: 'x' }).title).not.toMatch(/_|ticket/);
  });
});
