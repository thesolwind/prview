import React from 'react';
import { Box, Text } from 'ink';
import { band, Filler, Row, Segments } from './segments';
import type { Theme } from '../theme';
import type { Tok } from '../highlight';
import { columnLabels, type ViewRow } from '../view';
import type { Cell } from '../pair';
import { statusLabel, type FileDiff } from '../parse';

export interface TokenMaps {
  old: Tok[][] | null;
  new: Tok[][] | null;
}

/** Box-drawing glyphs used for the pane furniture. */
export const RULE = '─';
export const DIVIDER = '│';

/** File name, column band, rule. App scrolls against this, so keep in sync. */
export const DIFF_HEADER_HEIGHT = 3;

/** The one-column cursor marker down the left edge of the pane. */
const MARKER = 1;

interface Props {
  file: FileDiff;
  oldLabel: string;
  newLabel: string;
  rows: ViewRow[];
  tokens: TokenMaps;
  theme: Theme;
  width: number;
  height: number;
  cursor: number;
  scroll: number;
  hscroll: number;
  viewed: boolean;
  noteCount: number;
}

const digits = (n: number) => String(Math.max(n, 1)).length;

/** Keep the filename when a path is too long for the header. */
function fitRight(path: string, width: number): string {
  return path.length <= width ? path : '…' + path.slice(path.length - width + 1);
}

export function gutterWidth(file: FileDiff): number {
  let max = 1;
  for (const hunk of file.hunks) {
    max = Math.max(max, hunk.oldStart + hunk.oldCount, hunk.newStart + hunk.newCount);
  }
  return Math.max(3, digits(max));
}

/**
 * Columns of code visible on one side, given the pane width. Exported because
 * App needs the same number to decide whether a change is off-screen; a second
 * copy of this arithmetic would drift from the renderer's.
 */
export function codeWidthFor(file: FileDiff, width: number, layout: 'split' | 'unified'): number {
  const gutter = gutterWidth(file);
  if (layout === 'unified') return Math.max(4, width - MARKER - gutter * 2 - 2);
  return Math.max(4, Math.floor((width - MARKER - 1) / 2) - gutter - 1);
}

/** Context lines take the pane background, which is unset on the GitHub themes. */
function bgFor(kind: Cell['kind'], theme: Theme): string | undefined {
  if (kind === 'add') return theme.addBg;
  if (kind === 'del') return theme.delBg;
  // Context lines keep the terminal's own background.
  return undefined;
}

function emphFor(kind: Cell['kind'], theme: Theme): string | undefined {
  if (kind === 'add') return theme.addEmph;
  if (kind === 'del') return theme.delEmph;
  return undefined;
}

const sign = (kind: Cell['kind']) => (kind === 'add' ? '+' : kind === 'del' ? '-' : ' ');

const signColor = (kind: Cell['kind'], theme: Theme) =>
  kind === 'add' ? theme.addSign : kind === 'del' ? theme.delSign : theme.dim;

function Gutter({
  no,
  theme,
  width,
  bg,
  active,
}: {
  no: number | null;
  theme: Theme;
  width: number;
  bg?: string;
  active: boolean;
}) {
  return (
    <Text backgroundColor={bg} color={active ? theme.gutterActive : theme.gutter}>
      {(no == null ? '' : String(no)).padStart(width)}
    </Text>
  );
}

function SideCell({
  cell,
  tokens,
  theme,
  gutter,
  codeWidth,
  hscroll,
  active,
}: {
  cell: Cell | null;
  tokens: Tok[][] | null;
  theme: Theme;
  gutter: number;
  codeWidth: number;
  hscroll: number;
  active: boolean;
}) {
  if (!cell) {
    // Absent side of an unbalanced pair: GitHub greys the whole cell out.
    return (
      <Text color={theme.dim}>
        {band('', gutter + 1 + codeWidth)}
      </Text>
    );
  }
  const bg = bgFor(cell.kind, theme);
  const line = cell.no != null && tokens ? tokens[cell.no - 1] ?? null : null;
  return (
    <>
      <Gutter no={cell.no} theme={theme} width={gutter} bg={bg} active={active} />
      <Text backgroundColor={bg} color={signColor(cell.kind, theme)}>
        {sign(cell.kind)}
      </Text>
      <Segments
        text={cell.text + (cell.noNewline ? ' ↵̸' : '')}
        width={codeWidth}
        offset={hscroll}
        tokens={line}
        bg={bg}
        emphBg={emphFor(cell.kind, theme)}
        spans={cell.spans}
        fallback={theme.plain}
      />
    </>
  );
}

/** Names both columns, so it is never a guess which side is the old one. */
function ColumnBand({
  theme,
  width,
  marker,
  sideWidth,
  split,
  was,
  now,
}: {
  theme: Theme;
  width: number;
  marker: number;
  sideWidth: number;
  split: boolean;
  was: string;
  now: string;
}) {
  if (!split) {
    return (
      <Row
        width={width}
        bg={theme.hunkBg}
        segments={[
          { text: ' was ', color: theme.delSign, bold: true },
          { text: was, color: theme.hunkFg },
          { text: '  →  ', color: theme.hunkFg },
          { text: 'now ', color: theme.addSign, bold: true },
          { text: now, color: theme.hunkFg },
        ]}
      />
    );
  }
  return (
    <Box width={width}>
      <Text backgroundColor={theme.hunkBg}> </Text>
      <Box width={sideWidth}>
        <Text backgroundColor={theme.hunkBg} wrap="truncate">
          <Text color={theme.delSign} bold>
            {' was '}
          </Text>
          <Text color={theme.hunkFg}>{band(was, sideWidth - 5)}</Text>
        </Text>
      </Box>
      <Text backgroundColor={theme.hunkBg} color={theme.border}>
        {DIVIDER}
      </Text>
      <Box width={sideWidth}>
        <Text backgroundColor={theme.hunkBg} wrap="truncate">
          <Text color={theme.addSign} bold>
            {' now '}
          </Text>
          <Text color={theme.hunkFg}>{band(now, sideWidth - 5)}</Text>
        </Text>
      </Box>
    </Box>
  );
}

export function DiffPane(props: Props): React.ReactElement {
  const { file, oldLabel, newLabel, rows, tokens, theme, width, height, cursor, scroll, hscroll, viewed, noteCount } =
    props;

  const bodyHeight = Math.max(1, height - DIFF_HEADER_HEIGHT);
  const gutter = gutterWidth(file);
  const marker = MARKER;

  const visible = rows.slice(scroll, scroll + bodyHeight);
  const split = rows.some((row) => row.t === 'sbs');
  const sideWidth = Math.floor((width - marker - 1) / 2);
  const codeWidth = codeWidthFor(file, width, 'split');
  const uniCodeWidth = codeWidthFor(file, width, 'unified');
  // Room left for the path once the status and counts have taken theirs.
  const headerRoom = Math.max(12, width - statusLabel(file).length - 24);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Row
        width={width}
        segments={[
          { text: viewed ? '✓ ' : '◻ ', color: viewed ? theme.addSign : theme.dim },
          { text: fitRight(file.path, headerRoom), color: theme.plain, bold: true },
          { text: `  ${statusLabel(file)}  `, color: theme.dim },
          { text: `+${file.additions}`, color: theme.addSign },
          { text: ' ', color: theme.dim },
          { text: `−${file.deletions}`, color: theme.delSign },
          ...(noteCount > 0
            ? [{ text: `  ${noteCount} note${noteCount === 1 ? '' : 's'}`, color: theme.noteFg }]
            : []),
          ...(hscroll > 0 ? [{ text: `  →${hscroll}`, color: theme.dim }] : []),
        ]}
      />

      <ColumnBand
        theme={theme}
        width={width}
        marker={marker}
        sideWidth={sideWidth}
        split={split}
        {...columnLabels(file, oldLabel, newLabel)}
      />

      <Box width={width}>
        <Text color={theme.border}>
          {RULE.repeat(Math.max(0, width))}
        </Text>
      </Box>

      {visible.map((row, i) => {
        const index = scroll + i;
        const isCursor = index === cursor;
        const markerCell = (
          <Text color={theme.accent}>
            {isCursor ? '▌' : ' '}
          </Text>
        );

        if (row.t === 'hunk') {
          return (
            <Box key={index} width={width}>
              {markerCell}
              <Text backgroundColor={theme.hunkBg} color={theme.hunkFg} wrap="truncate">
                {band(row.text, width - marker)}
              </Text>
            </Box>
          );
        }
        if (row.t === 'summary') {
          // Generated context, not a review comment: dim, labelled, and set
          // apart from the notes the reviewer wrote.
          return (
            <Box key={index} width={width}>
              {markerCell}
              <Text color={theme.dim} wrap="truncate">
                {band(row.first ? `  ⌁ ${row.text}` : `    ${row.text}`, width - marker)}
              </Text>
            </Box>
          );
        }
        if (row.t === 'msg') {
          return (
            <Box key={index} width={width}>
              {markerCell}
              <Text color={theme.dim} wrap="truncate">
                {band(`  ${row.text}`, width - marker)}
              </Text>
            </Box>
          );
        }
        if (row.t === 'note') {
          return (
            <Box key={index} width={width}>
              {markerCell}
              <Text backgroundColor={theme.noteBg} color={theme.noteFg} wrap="truncate">
                {band(row.text, width - marker)}
              </Text>
            </Box>
          );
        }
        if (row.t === 'sbs') {
          return (
            <Box key={index} width={width}>
              {markerCell}
              <Box width={sideWidth}>
                <SideCell
                  cell={row.left}
                  tokens={tokens.old}
                  theme={theme}
                  gutter={gutter}
                  codeWidth={codeWidth}
                  hscroll={hscroll}
                  active={isCursor}
                />
              </Box>
              <Text color={theme.border}>
                {DIVIDER}
              </Text>
              <Box width={sideWidth}>
                <SideCell
                  cell={row.right}
                  tokens={tokens.new}
                  theme={theme}
                  gutter={gutter}
                  codeWidth={codeWidth}
                  hscroll={hscroll}
                  active={isCursor}
                />
              </Box>
            </Box>
          );
        }

        const bg = bgFor(row.kind, theme);
        const lineTokens =
          row.kind === 'del'
            ? row.oldNo != null && tokens.old
              ? tokens.old[row.oldNo - 1] ?? null
              : null
            : row.newNo != null && tokens.new
              ? tokens.new[row.newNo - 1] ?? null
              : null;
        return (
          <Box key={index} width={width}>
            {markerCell}
            <Gutter no={row.oldNo} theme={theme} width={gutter} bg={bg} active={isCursor} />
            <Text backgroundColor={bg}> </Text>
            <Gutter no={row.newNo} theme={theme} width={gutter} bg={bg} active={isCursor} />
            <Text backgroundColor={bg} color={signColor(row.kind, theme)}>
              {sign(row.kind)}
            </Text>
            <Segments
              text={row.text + (row.noNewline ? ' ↵̸' : '')}
              width={uniCodeWidth}
              offset={hscroll}
              tokens={lineTokens}
              bg={bg}
              emphBg={emphFor(row.kind, theme)}
                    spans={row.spans}
              fallback={theme.plain}
            />
          </Box>
        );
      })}

      <Filler rows={bodyHeight - visible.length} width={width} />
    </Box>
  );
}
