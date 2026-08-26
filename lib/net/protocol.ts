/** Constants shared by the route handlers and the browser client. */

/** Players authenticate with an opaque per-room token, not a cookie session. */
export const PLAYER_TOKEN_HEADER = 'x-player-token';

/** Room codes are short, unambiguous, and case-insensitive. */
export const ROOM_CODE_LENGTH = 6;
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Accepts pasted codes with stray spaces, dashes, or lowercase letters. */
export function normalizeRoomId(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}
