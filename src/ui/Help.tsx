import React from 'react';
import { Box, Text } from 'ink';
import { Filler, Row } from './segments';
import type { Theme } from '../theme';

const KEYS: Array<[string, string]> = [
  ['j / k, ↓ / ↑', 'move one line'],
  ['ctrl-d / ctrl-u', 'half page'],
  ['g / G', 'top / bottom of file'],
  ['} / {', 'next / previous hunk'],
  ['h / l, ← / →', 'scroll code sideways (stops auto-follow)'],
  ['0', 'reset sideways scroll, resume auto-follow'],
  ['n / p', 'next / previous file'],
  ['Tab / shift-Tab', 'next / previous unviewed file'],
  ['J / K', 'same as n / p'],
  ['space', 'toggle viewed on this file'],
  ['a / A', 'mark all viewed / clear all (asks first)'],
  ['c', 'write a note on the cursor line'],
  ['d', 'delete the note on the cursor line'],
  ['s', 'switch split / unified'],
  ['o', 'open the file in $EDITOR at this line'],
  ['w', 'write notes to a markdown file'],
  ['r', 're-read the diff from git'],
  ['esc', 'cancel a running explain'],
  ['?', 'toggle this help'],
  ['q', 'quit (notes are printed on exit)'],
];

export function Help({
  theme,
  width,
  height,
}: {
  theme: Theme;
  width: number;
  height: number;
}): React.ReactElement {
  const keyWidth = Math.max(...KEYS.map(([k]) => k.length));
  const shown = KEYS.slice(0, Math.max(1, height - 6));
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Row
        width={width}
        segments={[{ text: '  prview — keys', color: theme.accent, bold: true }]}
      />
      <Row width={width} segments={[]} />
      {shown.map(([key, desc]) => (
        <Row
          key={key}
          width={width}
          segments={[
            { text: '  ' + key.padEnd(keyWidth + 2), color: theme.noteFg },
            { text: desc, color: theme.plain },
          ]}
        />
      ))}
      <Row width={width} segments={[]} />
      <Row
        width={width}
        segments={[{ text: '  Review state is stored in .git/prview/reviews.json', color: theme.dim }]}
      />
      <Filler rows={height - shown.length - 4} width={width} />
    </Box>
  );
}
