/**
 * A React error boundary around the tree.
 *
 * Without one, a throw inside any card component unmounts the whole Ink tree
 * mid-frame and leaves the terminal without a cursor and with a half-painted
 * row. Rendering a message instead keeps the session usable and, more
 * importantly, keeps the failure visible rather than silent.
 */

import { Box, Text } from "ink";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // stderr, never stdout: a render crash must not corrupt a piped transcript.
    process.stderr.write(`render error: ${error.message}\n${info.componentStack ?? ""}\n`);
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <Box flexDirection="column">
        <Text color="red">✗ the display crashed: {this.state.error.message}</Text>
        <Text dimColor>the session is still alive — press ctrl+c to exit</Text>
      </Box>
    );
  }
}
