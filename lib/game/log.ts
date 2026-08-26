/** The shot log shown bottom-left. Tags mirror the original stencilled codes. */

export type LogTag = 'RDY' | 'POS' | 'CMD' | 'HIT' | 'MIS' | 'SNK' | 'ERR';

export type LogEntry = { id: number; tag: LogTag; text: string };

export const LOG_LIMIT = 5;

const TAG_COLOR: Record<LogTag, string> = {
  HIT: 'text-ember',
  SNK: 'text-scorch',
  MIS: 'text-foam/85',
  RDY: 'text-brass/90',
  POS: 'text-brass/90',
  CMD: 'text-brass/90',
  ERR: 'text-scorch',
};

export function tagColor(tag: LogTag): string {
  return TAG_COLOR[tag];
}
