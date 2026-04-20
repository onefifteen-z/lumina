import { describe, it, expect } from 'vitest';
import { latestShellCommandFromTrace } from './shell-trace';
import type { TraceItem } from '../ChatView';

describe('latestShellCommandFromTrace', () => {
  it('returns the most recent shell command', () => {
    const trace: TraceItem[] = [
      { kind: 'tool_call', id: 'a', name: 'shell', args: JSON.stringify({ command: 'ls' }) },
      { kind: 'tool_call', id: 'b', name: 'shell', args: JSON.stringify({ command: 'pwd' }) },
    ];
    expect(latestShellCommandFromTrace(trace)).toBe('pwd');
  });

  it('ignores non-shell tool calls when scanning backwards', () => {
    const trace: TraceItem[] = [
      { kind: 'tool_call', id: '1', name: 'read_file', args: JSON.stringify({ path: 'x' }) },
      { kind: 'tool_call', id: '2', name: 'shell', args: JSON.stringify({ command: 'echo hi' }) },
    ];
    expect(latestShellCommandFromTrace(trace)).toBe('echo hi');
  });

  it('returns null when there is no shell call', () => {
    const trace: TraceItem[] = [
      { kind: 'tool_call', id: '1', name: 'read_file', args: '{}' },
    ];
    expect(latestShellCommandFromTrace(trace)).toBeNull();
  });
});
