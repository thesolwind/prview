import React from 'react';
import { Box, Text } from 'ink';
import { band, Filler, Row } from './segments';
import type { FileDiff } from '../parse';
import type { Theme } from '../theme';
import { RULE } from './DiffPane';

/** Matches DIFF_HEADER_HEIGHT so both panes rule off on the same row. */
export const FILE_LIST_HEADER_HEIGHT = 3;

interface Props {
  files: FileDiff[];
  cursor: number;
  viewed: Set<string>;
  noteCounts: Map<string, number>;
  theme: Theme;
  width: number;
  height: number;
}

const STATUS_MARK: Record<FileDiff['status'], string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
  copied: 'C',
  mode: 'T',
};

/** Trim from the left so the filename always survives a narrow pane. */
function fit(path: string, width: number): string {
  if (path.length <= width) return band(path, width);
  return band('…' + path.slice(path.length - width + 1), width);
}

export function FileList(props: Props): React.ReactElement {
  const { files, cursor, viewed, noteCounts, theme, width, height } = props;

  const bodyHeight = Math.max(1, height - FILE_LIST_HEADER_HEIGHT);
  // Keep the cursor roughly centred without scrolling past either end.
  const half = Math.floor(bodyHeight / 2);
  const maxScroll = Math.max(0, files.length - bodyHeight);
  const scroll = Math.min(Math.max(0, cursor - half), maxScroll);
  const visible = files.slice(scroll, scroll + bodyHeight);

  const doneCount = files.filter((f) => viewed.has(f.path)).length;
  const totals = files.reduce(
    (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { additions: 0, deletions: 0 },
  );

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Row
        width={width}
        segments={[
          { text: ` ${files.length} file${files.length === 1 ? '' : 's'}`, color: theme.plain },
          { text: `  +${totals.additions}`, color: theme.addSign },
          { text: `  −${totals.deletions}`, color: theme.delSign },
        ]}
      />
      <Row
        width={width}
        segments={[{ text: ` ${doneCount}/${files.length} viewed`, color: theme.dim }]}
      />
      <Box width={width}>
        <Text color={theme.border}>
          {RULE.repeat(Math.max(0, width))}
        </Text>
      </Box>
      {visible.map((file, i) => {
        const index = scroll + i;
        const isCursor = index === cursor;
        const isViewed = viewed.has(file.path);
        const notes = noteCounts.get(file.path) ?? 0;

        const stat = `+${file.additions}`;
        const badge = notes ? `💬${notes}` : '';
        const reserved = 2 + 1 + 1 + stat.length + 1 + badge.length + 1;
        const nameWidth = Math.max(6, width - reserved);

        const rowBg = isCursor ? theme.cursorBg : undefined;

        return (
          <Row
            key={file.path + index}
            width={width}
            bg={rowBg}
            segments={[
              { text: isCursor ? '▌' : ' ', color: theme.accent },
              { text: isViewed ? '✓' : '·', color: isViewed ? theme.addSign : theme.dim },
              { text: STATUS_MARK[file.status], color: theme.dim },
              {
                text: ' ' + fit(file.path, nameWidth),
                color: isViewed ? theme.dim : theme.plain,
                bold: isCursor,
              },
              { text: ' ' + stat, color: theme.addSign },
              ...(badge ? [{ text: ' ' + badge, color: theme.noteFg }] : []),
            ]}
          />
        );
      })}
      <Filler rows={bodyHeight - visible.length} width={width} />
    </Box>
  );
}
