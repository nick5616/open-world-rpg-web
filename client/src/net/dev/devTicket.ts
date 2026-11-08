// Node-only test helper: signs a zone connect ticket with the INSECURE
// development key, byte-compatible with server/pkg/ticket.Sign (the zone
// accepts these only when LODESTONE_TICKET_PUBLIC_KEY is unset). Never
// imported by browser code.
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { TICKET_TTL_S, Writer } from '@lodestone/contracts';

export interface DevClaims {
  characterId: string;
  characterName: string;
  worldId: string;
  zoneId: string;
  accountId?: string;
}

export function devTicket(c: DevClaims, now = Date.now()): string {
  const seed = createHash('sha256').update('lodestone-dev-ticket-key-NOT-FOR-PRODUCTION').digest();
  // PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410).
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const w = new Writer(128);
  w.u8(1); // format version
  w.str(c.accountId ?? 'dev-account');
  w.str('');
  w.str(c.characterId);
  w.str(c.characterName);
  w.str(c.worldId);
  w.str(`zone:${c.zoneId}`);
  w.bool(false);
  w.i64(BigInt(now));
  w.i64(BigInt(now + TICKET_TTL_S * 1000));
  const payload = Buffer.from(w.finish());
  const sig = sign(null, payload, key);
  return Buffer.concat([payload, sig]).toString('base64url');
}
