import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import type { Tok } from '../highlight';
import type { Span } from '../intraline';

export interface SegmentOptions {
  text: string;
  /** Visible column window. */
  width: number;
  offset: number;
  /** Syntax tokens for this line, if the grammar was available. */
  tokens?: Tok[] | null;
  /** Row background, painted across the full width. */
  bg?: string;
  /** Background for word-level emphasis inside `spans`. */
  emphBg?: string;
  spans?: Span[];
  fallback: string;
}

interface Run {
  text: string;
  color?: string;
  bg?: string;
}

/**
 * Build the coloured runs for one rendered line.
 *
 * Syntax colour and diff background are independent layers, and word-level
 * emphasis cuts across token boundaries, so both are resolved per character
 * and then coalesced. Lines are short enough that this is cheaper than trying
 * to intersect the two span sets analytically.
 */
export function buildRuns(opts: SegmentOptions): Run[] {
  const { text, width, offset, tokens, bg, emphBg, spans, fallback } = opts;
  if (width <= 0) return [];

  const end = offset + width;
  const fg: Array<string | undefined> = new Array(text.length);
  if (tokens && tokens.length) {
    let at = 0;
    for (const tok of tokens) {
      for (let i = 0; i < tok.text.length && at < text.length; i++, at++) fg[at] = tok.color;
    }
  }

  const bgOf: Array<string | undefined> = new Array(text.length).fill(bg);
  if (spans && emphBg) {
    for (const span of spans) {
      for (let i = Math.max(span.start, 0); i < Math.min(span.end, text.length); i++) bgOf[i] = emphBg;
    }
  }

  const runs: Run[] = [];
  const push = (ch: string, color: string | undefined, back: string | undefined) => {
    const last = runs[runs.length - 1];
    if (last && last.color === color && last.bg === back) last.text += ch;
    else runs.push({ text: ch, color, bg: back });
  };

  for (let i = offset; i < Math.min(end, text.length); i++) {
    push(text[i]!, fg[i] ?? fallback, bgOf[i]);
  }

  const painted = Math.max(0, Math.min(end, text.length) - offset);
  if (bg && painted < width) runs.push({ text: ' '.repeat(width - painted), bg });
  return runs;
}

/**
 * Clip to at most `width` *display columns*, returning the text and the
 * columns it actually occupies.
 *
 * Counting code units is not good enough: Ink lays out by display width, so a
 * glyph it measures as two columns (an emoji badge, a CJK path) makes a row
 * that looked exactly `width` long overflow, and Ink wraps it onto a second
 * line — silently pushing the whole pane down a row.
 */
export function clipToWidth(text: string, width: number): { text: string; columns: number } {
  if (width <= 0) return { text: '', columns: 0 };
  if (stringWidth(text) <= width) return { text, columns: stringWidth(text) };
  let out = '';
  let columns = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (columns + w > width) break;
    out += ch;
    columns += w;
  }
  return { text: out, columns };
}

/** Pad or clip to exactly `width` display columns, for a solid background. */
export function band(text: string, width: number): string {
  const clipped = clipToWidth(text, width);
  return clipped.text + ' '.repeat(Math.max(0, width - clipped.columns));
}

/**
 * Blank painted rows. Themes that own the screen need their background to
 * reach the bottom of a short file; themes that sit on the terminal's own
 * background render nothing at all here.
 */
export function Filler({ rows, width, bg }: { rows: number; width: number; bg?: string }) {
  if (!bg || rows <= 0) return null;
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <Box key={i} width={width}>
          <Text backgroundColor={bg}>{band('', width)}</Text>
        </Box>
      ))}
    </>
  );
}

export interface Seg {
  text: string;
  color?: string;
  bold?: boolean;
  bg?: string;
}

/**
 * One row of chrome, exactly `width` columns wide.
 *
 * Clipping and padding have to happen over the *combined* text, not per
 * segment: padding each piece to the full width overflows and makes Ink add an
 * ellipsis, and padding none of them leaves a themed background stopping short
 * of the edge.
 */
export function Row({ segments, width, bg }: { segments: Seg[]; width: number; bg?: string }) {
  const out: Seg[] = [];
  let used = 0;
  for (const seg of segments) {
    if (used >= width) break;
    const clipped = clipToWidth(seg.text, width - used);
    if (!clipped.text.length) continue;
    out.push({ ...seg, text: clipped.text });
    used += clipped.columns;
  }
  if (used < width) out.push({ text: ' '.repeat(width - used) });
  return (
    <Box width={width}>
      {/* Truncate rather than wrap: if a width measurement is ever off by one,
          losing a cell beats pushing the entire pane down a row. */}
      <Text wrap="truncate">
        {out.map((seg, i) => (
          <Text key={i} color={seg.color} bold={seg.bold} backgroundColor={seg.bg ?? bg}>
            {seg.text}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

export function Segments(props: SegmentOptions): React.ReactElement {
  const runs = buildRuns(props);
  return (
    <Text wrap="truncate">
      {runs.map((run, i) => (
        <Text key={i} color={run.color} backgroundColor={run.bg}>
          {run.text}
        </Text>
      ))}
    </Text>
  );
}
