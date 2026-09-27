import React from 'react';
import { Box, Text } from 'ink';

import type { Theme } from '../theme';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const STREAM_WIDTH = 44;

/**
 * A fixed tape of hex the rows scroll along, rather than fresh bytes each
 * frame. Reshuffling every tick reads as static; sliding a window along a tape
 * reads as data moving past, which is the point — and being built once from a
 * seeded generator keeps every frame reproducible, so the preview harness can
 * compare captures between runs.
 */
function tape(seed: number, bytes: number): string {
  let x = seed >>> 0;
  const out: string[] = [];
  for (let i = 0; i < bytes; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out.push((x >>> 24).toString(16).padStart(2, '0'));
  }
  return out.join(' ');
}

const TAPES = [tape(0x9e3779b9, 160), tape(0x85ebca6b, 160)];

/**
 * Window into a tape, wrapping, so the two rows loop forever.
 *
 * `offset` is in bytes, not characters: a byte renders as `xx ` and slicing
 * off a character boundary leaves a half pair at the edge, which reads as a
 * glitch rather than a stream.
 */
function scroll(which: number, offsetBytes: number, width: number): string {
  const t = TAPES[which] ?? TAPES[0]!;
  const doubled = `${t}  ${t}`;
  const stride = 3; // "xx "
  const bytes = Math.ceil(t.length / stride);
  const start = ((((offsetBytes % bytes) + bytes) % bytes) * stride) % doubled.length;
  return doubled.slice(start, start + width).padEnd(width);
}

export interface WorkingProps {
  theme: Theme;
  width: number;
  height: number;
  /** Animation frame; also drives the byte stream. */
  tick: number;
  /** Files in this batch. */
  total: number;
  done: number;
  model: string;
  elapsedSeconds: number;
}

/**
 * Shown while a batch is in flight, over everything else.
 *
 * The point is not decoration: until the reply lands, most files have no
 * summary, so moving around would mean reading a review that is quietly
 * incomplete. Blocking says "not yet" instead of letting you draw conclusions
 * from missing information. `esc` and `q` still work — a modal you cannot
 * leave is the bug this project already had once.
 */
export function Working(props: WorkingProps): React.ReactElement {
  const { theme, width, height, tick, total, done, model, elapsedSeconds } = props;

  const spin = SPINNER[tick % SPINNER.length] ?? SPINNER[0]!;
  // Chunk counts are not shown: a chunk is all-or-nothing, so the number sits
  // at zero and then jumps, which says less than the stage name does.
  const stage =
    done >= total && total > 0
      ? 'writing summaries'
      : done > 0
        ? `reading batch (${done} of ${total} back)`
        : 'sending batch';

  return (
    <Box width={width} height={height} alignItems="center" justifyContent="center">
      <Box flexDirection="column" borderStyle="double" borderColor={theme.accent} paddingX={2}>
        <Text>
          <Text color={theme.accent} bold>
            {`${spin}  ANALYSING ${total} DIFF${total === 1 ? '' : 'S'}`}
          </Text>
        </Text>
        <Text> </Text>
        {/* Opposite directions: two independent streams read as activity,
            where one row alone reads as a decoration that might be frozen. */}
        <Text color={theme.addSign}>{scroll(0, tick, STREAM_WIDTH)}</Text>
        <Text color={theme.addSign} dimColor>
          {scroll(1, -tick * 2, STREAM_WIDTH)}
        </Text>
        <Text> </Text>
        <Text color={theme.dim}>{`${stage} · ${model} · ${elapsedSeconds}s`}</Text>
        <Text color={theme.dim}>esc cancels · q quits</Text>
      </Box>
    </Box>
  );
}
