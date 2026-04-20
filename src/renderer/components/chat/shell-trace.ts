import type { TraceItem } from '../ChatView';

/**
 * Return the most recent shell command string from a thinking trace.
 * Only considers `tool_call` entries whose name is `shell`.
 */
export function latestShellCommandFromTrace(trace: TraceItem[] | undefined): string | null {
  if (!trace || trace.length === 0) return null;
  for (let i = trace.length - 1; i >= 0; i--) {
    const item = trace[i];
    if (item.kind !== 'tool_call') continue;
    if (item.name !== 'shell') continue;
    const cmd = extractShellCommand(item.args);
    if (cmd) return cmd;
  }
  return null;
}

function extractShellCommand(argsJson: string): string | null {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const cmd = (parsed as Record<string, unknown>).command;
      if (typeof cmd === 'string' && cmd.trim()) return cmd;
    }
  } catch {
    // fall through
  }
  const trimmed = argsJson.trim();
  return trimmed.length > 0 ? trimmed : null;
}
