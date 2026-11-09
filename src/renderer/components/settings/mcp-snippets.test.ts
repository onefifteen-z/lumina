import { describe, it, expect } from 'vitest';
import { buildHttpMcpSnippet, buildHttpUrlTokenMcpSnippet, buildStdioMcpSnippet, parseMcpPort } from './mcp-snippets';

describe('mcp snippets', () => {
  it('builds the HTTP entry with the bearer header', () => {
    expect(JSON.parse(buildHttpMcpSnippet(8765, 'abc'))).toEqual({
      mcpServers: {
        lumina: { url: 'http://127.0.0.1:8765/mcp', headers: { Authorization: 'Bearer abc' } },
      },
    });
  });

  it('builds the HTTP entry with the token in the URL', () => {
    expect(JSON.parse(buildHttpUrlTokenMcpSnippet(8765, 'abc'))).toEqual({
      mcpServers: { lumina: { url: 'http://127.0.0.1:8765/mcp?token=abc' } },
    });
  });

  it('builds the stdio entry running the CLI as node', () => {
    const snippet = JSON.parse(
      buildStdioMcpSnippet(
        {
          executablePath: '/Applications/Lumina.app/Contents/MacOS/Lumina',
          cliPath: '/Applications/Lumina.app/Contents/Resources/app.asar/dist/main/mcp/cli.js',
        },
        '/Users/me/wiki',
      ),
    );
    expect(snippet.mcpServers.lumina).toEqual({
      command: '/Applications/Lumina.app/Contents/MacOS/Lumina',
      args: ['/Applications/Lumina.app/Contents/Resources/app.asar/dist/main/mcp/cli.js', '--vault', '/Users/me/wiki'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it('accepts only unprivileged ports', () => {
    expect(parseMcpPort('9000', 8765)).toBe(9000);
    expect(parseMcpPort('80', 8765)).toBe(8765);
    expect(parseMcpPort('abc', 8765)).toBe(8765);
    expect(parseMcpPort('70000', 8765)).toBe(8765);
  });
});
