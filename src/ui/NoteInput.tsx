import React from 'react';
import { Box, Text } from 'ink';
import { Row } from './segments';
import type { Theme } from '../theme';
import { RULE } from './DiffPane';

interface Props {
  theme: Theme;
  width: number;
  prompt: string;
  value: string;
}

export function NoteInput(props: Props): React.ReactElement {
  const { theme, width, prompt, value } = props;
  const room = Math.max(8, width - prompt.length - 3);
  const shown = value.length > room ? value.slice(value.length - room) : value;
  return (
    <Box width={width} flexDirection="column">
      <Box width={width}>
        <Text color={theme.noteFg}>
          {RULE.repeat(Math.max(0, width))}
        </Text>
      </Box>
      <Row
        width={width}
        bg={theme.noteBg}
        segments={[
          { text: ` ${prompt} `, color: theme.noteFg, bold: true },
          { text: shown, color: theme.plain },
          { text: '▏', color: theme.accent },
        ]}
      />
    </Box>
  );
}
