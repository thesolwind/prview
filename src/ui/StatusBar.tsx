import React from 'react';
import { Box, Text } from 'ink';
import { Row } from './segments';
import type { Theme } from '../theme';
import { RULE } from './DiffPane';

interface Props {
  theme: Theme;
  width: number;
  label: string;
  branch: string;
  files: number;
  additions: number;
  deletions: number;
  layout: 'split' | 'unified';
  message: string | null;
}

export function StatusBar(props: Props): React.ReactElement {
  const { theme, width, label, branch, files, additions, deletions, layout, message } = props;
  return (
    <Box width={width} flexDirection="column">
      <Box width={width}>
        <Text color={theme.border}>
          {RULE.repeat(Math.max(0, width))}
        </Text>
      </Box>
      <Row
        width={width}
        segments={
          message
            ? [{ text: ` ${message}`, color: theme.accent, bold: true }]
            : [
                // Omitted when the branch under review is not the one you are on.
                ...(branch ? [{ text: ` ${branch}`, color: theme.accent, bold: true }] : []),
                { text: `${branch ? '  ' : ' '}${label}  `, color: theme.dim },
                { text: `${files} file${files === 1 ? '' : 's'}`, color: theme.plain },
                { text: `  +${additions}`, color: theme.addSign },
                { text: `  −${deletions}`, color: theme.delSign },
                { text: `  [${layout}]  `, color: theme.dim },
                { text: 'j/k move  n/p file  space viewed  c note  ? help  q quit', color: theme.dim },
              ]
        }
      />
    </Box>
  );
}
