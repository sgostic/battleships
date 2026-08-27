/** Constants shared by the route handlers and the browser client. */

/** Players authenticate with an opaque per-room token, not a cookie session. */
export const PLAYER_TOKEN_HEADER = 'x-player-token';
export const SPECTATOR_TOKEN_PREFIX = 'spectator:';

/** A spectator token has no authority to mutate a match. */
export function isSpectatorToken(token: string): boolean {
  return token.startsWith(SPECTATOR_TOKEN_PREFIX) && token.length > SPECTATOR_TOKEN_PREFIX.length;
}

/** Room codes are short, unambiguous, and case-insensitive. */
export const ROOM_CODE_LENGTH = 6;
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Accepts pasted codes with stray spaces, dashes, or lowercase letters. */
export function normalizeRoomId(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}
