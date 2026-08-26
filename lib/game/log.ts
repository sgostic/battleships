/** The shot log shown bottom-left. Tags mirror the original stencilled codes. */

export type LogTag = 'RDY' | 'POS' | 'CMD' | 'HIT' | 'MIS' | 'SNK' | 'ELM' | 'ERR';

export type LogEntry = { id: number; tag: LogTag; text: string };

/** 2v2 has four voices in the log at once; 5 lines scrolled the first round away. */
export const LOG_LIMIT = 7;

const TAG_COLOR: Record<LogTag, string> = {
  HIT: 'text-ember',
  SNK: 'text-scorch',
  ELM: 'text-scorch',
  MIS: 'text-foam/85',
  RDY: 'text-brass/90',
  POS: 'text-brass/90',
  CMD: 'text-brass/90',
  ERR: 'text-scorch',
};

export function tagColor(tag: LogTag): string {
  return TAG_COLOR[tag];
}
