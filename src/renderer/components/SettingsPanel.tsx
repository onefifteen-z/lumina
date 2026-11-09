import React, { useState, useEffect, useCallback } from 'react';
import {
  DEFAULT_MCP_SERVER_CONFIG,
  type LLMProviderConfig,
  type McpServerStatus,
  type PhoenixConfig,
  type QmdSearchMode,
  type QmdSearchStatus,
  type VaultLanguage,
} from '../../shared/types';
import {
  buildHttpMcpSnippet,
  buildHttpUrlTokenMcpSnippet,
  buildStdioMcpSnippet,
  parseMcpPort,
} from './settings/mcp-snippets';

type ConnectionStatus = 'idle' | 'testing' | 'success' | 'error';

const DEFAULT_PHOENIX: PhoenixConfig = { enabled: false, scheme: 'http', host: 'localhost', port: 6006 };
const DEFAULT_VAULT_LANGUAGE: VaultLanguage = 'en';

const toMb = (bytes: number) => Math.round(bytes / (1024 * 1024));

function describeQmdActivity(status: QmdSearchStatus): string {
  const p = status.progress;
  if (status.downloading) {
    return p && p.phase === 'download' && p.total > 0
      ? `Downloading embedding model ${toMb(p.current)} / ${toMb(p.total)} MB`
      : 'Downloading embedding model…';
  }
  if (status.embedding) {
    return p && p.phase === 'embed' && p.total > 0
      ? `Embedding ${p.current} / ${p.total} chunks`
      : 'Embedding…';
  }
  if (status.indexing) return 'Indexing…';
  return status.ready ? 'Ready' : 'Not ready';
}

const SettingsPanel: React.FC = () => {
  // LLM provider fields
  const [endpointUrl, setEndpointUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');

  // Vault
  const [vaultPath, setVaultPath] = useState('');
  const [vaultLanguage, setVaultLanguage] = useState<VaultLanguage>(DEFAULT_VAULT_LANGUAGE);

  // Phoenix
  const [phoenixEnabled, setPhoenixEnabled] = useState(false);
  const [phoenixScheme, setPhoenixScheme] = useState<'http' | 'https'>('http');
  const [phoenixHost, setPhoenixHost] = useState('localhost');
  const [phoenixPort, setPhoenixPort] = useState('6006');

  /** Rasterize PDF pages to PNG for chat attach and ingest_source vision mode. */
  const [pdfImageIngest, setPdfImageIngest] = useState(false);

  /** Upload PDF/image/PPTX via OpenAI Files API. */
  const [fileIngest, setFileIngest] = useState(false);

  const [qmdSearchEnabled, setQmdSearchEnabled] = useState(false);
  const [qmdSearchMode, setQmdSearchMode] = useState<QmdSearchMode>('hybrid');
  const [qmdAutoEmbed, setQmdAutoEmbed] = useState(true);
  const [qmdStatus, setQmdStatus] = useState<QmdSearchStatus | null>(null);
  const [qmdRebuilding, setQmdRebuilding] = useState(false);

  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [mcpPort, setMcpPort] = useState(String(DEFAULT_MCP_SERVER_CONFIG.port));
  const [mcpToken, setMcpToken] = useState('');
  const [mcpTokenVisible, setMcpTokenVisible] = useState(false);
  const [mcpAllowWrite, setMcpAllowWrite] = useState(false);
  const [mcpAllowLuminaIngest, setMcpAllowLuminaIngest] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<McpServerStatus | null>(null);
  const [mcpCopied, setMcpCopied] = useState<string | null>(null);

  // UI state
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [connStatus, setConnStatus] = useState<ConnectionStatus>('idle');
  const [connError, setConnError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      const [config, storedKey, vaultConfig] = await Promise.all([
        window.api.getConfig(),
        window.api.getApiKey(),
        window.api.getVaultConfig(),
      ]);
      setVaultPath(config.vaultPath);
      setEndpointUrl(config.llmProvider?.endpointUrl ?? '');
      setModel(config.llmProvider?.model ?? '');
      setApiKey(storedKey);
      const ph = config.phoenix ?? DEFAULT_PHOENIX;
      setPhoenixEnabled(ph.enabled);
      setPhoenixScheme(ph.scheme ?? 'http');
      setPhoenixHost(ph.host || 'localhost');
      setPhoenixPort(String(ph.port || 6006));
      setPdfImageIngest(config.pdfImageIngest ?? false);
      setFileIngest(config.fileIngest ?? false);
      setQmdSearchEnabled(config.qmdSearch?.enabled ?? false);
      setQmdSearchMode(config.qmdSearch?.mode ?? 'hybrid');
      setQmdAutoEmbed(config.qmdSearch?.autoEmbed ?? true);
      setVaultLanguage(vaultConfig.language ?? DEFAULT_VAULT_LANGUAGE);
      const mcp = { ...DEFAULT_MCP_SERVER_CONFIG, ...config.mcpServer };
      setMcpEnabled(mcp.enabled);
      setMcpPort(String(mcp.port));
      setMcpToken(mcp.token);
      setMcpAllowWrite(mcp.allowWrite);
      setMcpAllowLuminaIngest(mcp.allowLuminaIngest);
      try {
        const status = await window.api.getQmdStatus();
        setQmdStatus(status);
      } catch {
        setQmdStatus(null);
      }
      try {
        setMcpStatus(await window.api.getMcpStatus());
      } catch {
        setMcpStatus(null);
      }
    } catch {
      // Defaults are fine
    }
  }, []);

  // Load current config on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadSettings();
        if (cancelled) return;
      } catch {
        // Defaults are fine
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadSettings]);

  useEffect(() => {
    const onVaultSwitched = () => {
      void loadSettings();
    };
    window.api.onVaultSwitched(onVaultSwitched);
    return () => {
      window.api.removeVaultSwitchedListener();
    };
  }, [loadSettings]);

  useEffect(() => {
    const refreshStatus = () => {
      void window.api.getQmdStatus().then(setQmdStatus).catch(() => setQmdStatus(null));
    };
    window.api.onQmdProgress(() => {
      refreshStatus();
    });
    const interval = qmdSearchEnabled
      ? window.setInterval(refreshStatus, 3000)
      : undefined;
    return () => {
      window.api.removeQmdProgressListener();
      if (interval) window.clearInterval(interval);
    };
  }, [qmdSearchEnabled]);

  // Save all settings
  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const llmProvider: LLMProviderConfig | null =
        endpointUrl && model ? { endpointUrl, model } : null;

      const port = parseInt(phoenixPort, 10);
      const phoenix: PhoenixConfig = {
        enabled: phoenixEnabled,
        scheme: phoenixScheme,
        host: phoenixHost.trim() || 'localhost',
        port: Number.isNaN(port) || port <= 0 ? 6006 : port,
      };

      await window.api.saveConfig({
        vaultPath,
        llmProvider,
        phoenix,
        pdfImageIngest,
        fileIngest,
        qmdSearch: {
          enabled: qmdSearchEnabled,
          mode: qmdSearchMode,
          autoEmbed: qmdAutoEmbed,
        },
        mcpServer: {
          enabled: mcpEnabled,
          port: parseMcpPort(mcpPort, DEFAULT_MCP_SERVER_CONFIG.port),
          token: mcpToken,
          allowWrite: mcpAllowWrite,
          allowLuminaIngest: mcpAllowLuminaIngest,
        },
      });
      await window.api.saveVaultConfig({ language: vaultLanguage });
      await window.api.saveApiKey(apiKey);
      const saved = await window.api.getConfig();
      setMcpToken(saved.mcpServer.token);
      setMcpPort(String(saved.mcpServer.port));
      setMcpStatus(await window.api.getMcpStatus());

      setSaveMsg('Settings saved');
      setTimeout(() => setSaveMsg(null), 3000);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }, [
    endpointUrl,
    apiKey,
    model,
    vaultPath,
    vaultLanguage,
    phoenixEnabled,
    phoenixScheme,
    phoenixHost,
    phoenixPort,
    pdfImageIngest,
    fileIngest,
    qmdSearchEnabled,
    qmdSearchMode,
    qmdAutoEmbed,
    mcpEnabled,
    mcpPort,
    mcpToken,
    mcpAllowWrite,
    mcpAllowLuminaIngest,
  ]);

  const handleRegenerateMcpToken = useCallback(async () => {
    try {
      const status = await window.api.regenerateMcpToken();
      setMcpStatus(status);
      setMcpToken((await window.api.getConfig()).mcpServer.token);
      setMcpTokenVisible(true);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : 'Failed to regenerate token');
    }
  }, []);

  const copyMcpText = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMcpCopied(key);
      setTimeout(() => setMcpCopied((current) => (current === key ? null : current)), 2000);
    } catch {
      // Clipboard may be unavailable; the text stays selectable.
    }
  }, []);

  const handleRebuildQmd = useCallback(async () => {
    setQmdRebuilding(true);
    setSaveMsg(null);
    try {
      await window.api.rebuildQmdIndex();
      const status = await window.api.getQmdStatus();
      setQmdStatus(status);
      setSaveMsg('QMD index rebuilt');
      setTimeout(() => setSaveMsg(null), 3000);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : 'Failed to rebuild QMD index');
    } finally {
      setQmdRebuilding(false);
    }
  }, []);

  // Test LLM connection
  const handleTestConnection = useCallback(async () => {
    if (!endpointUrl || !model) return;
    setConnStatus('testing');
    setConnError(null);
    try {
      // Save API key first so the main process can use it for the test
      await window.api.saveApiKey(apiKey);
      const ok = await window.api.testLLMConnection({ endpointUrl, model });
      setConnStatus(ok ? 'success' : 'error');
      if (!ok) setConnError('Connection test failed');
    } catch (err) {
      setConnStatus('error');
      setConnError(err instanceof Error ? err.message : 'Connection test failed');
    }
  }, [endpointUrl, model, apiKey]);

  // Select vault folder
  const handleSelectVault = useCallback(async () => {
    const selected = await window.api.selectVaultFolder();
    if (selected) setVaultPath(selected);
  }, []);

  if (loading) {
    return <div className="settings-panel settings-panel--loading">Loading settings…</div>;
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel__content">
      <h2 className="settings-panel__title">Settings</h2>

      {/* ── Vault Section ─────────────────────────────── */}
      <section className="settings-section">
        <h3 className="settings-section__heading">Vault</h3>

        <label className="settings-field">
          <span className="settings-field__label">Vault folder</span>
          <div className="settings-field__row">
            <input
              className="settings-field__input settings-field__input--path"
              type="text"
              value={vaultPath}
              readOnly
              placeholder="No folder selected"
            />
            <button
              className="settings-field__btn"
              type="button"
              onClick={handleSelectVault}
            >
              Browse…
            </button>
          </div>
        </label>

        <label className="settings-field">
          <span className="settings-field__label">Wiki language</span>
          <select
            className="settings-field__input"
            value={vaultLanguage}
            onChange={(e) => setVaultLanguage(e.target.value as VaultLanguage)}
          >
            <option value="en">English</option>
            <option value="ja">Japanese</option>
            <option value="zh">Chinese</option>
          </select>
          <span className="settings-field__hint">
            Applied per vault and injected into the runtime system prompt.
          </span>
        </label>
      </section>

      {/* ── LLM Provider Section ──────────────────────── */}
      <section className="settings-section">
        <h3 className="settings-section__heading">LLM Provider</h3>

        <label className="settings-field">
          <span className="settings-field__label">Endpoint URL</span>
          <input
            className="settings-field__input"
            type="url"
            value={endpointUrl}
            onChange={(e) => setEndpointUrl(e.target.value)}
            placeholder="https://api.openai.com"
          />
        </label>

        <label className="settings-field">
          <span className="settings-field__label">API Key</span>
          <input
            className="settings-field__input"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
            autoComplete="off"
          />
        </label>

        <label className="settings-field">
          <span className="settings-field__label">Model</span>
          <input
            className="settings-field__input"
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o"
          />
        </label>

        <div className="settings-field__row settings-field__row--actions">
          <button
            className="settings-field__btn settings-field__btn--test"
            type="button"
            onClick={handleTestConnection}
            disabled={connStatus === 'testing' || !endpointUrl || !model}
          >
            {connStatus === 'testing' ? 'Testing…' : 'Test Connection'}
          </button>
          {connStatus === 'success' && (
            <span className="settings-conn settings-conn--ok">Connected</span>
          )}
          {connStatus === 'error' && (
            <span className="settings-conn settings-conn--err">{connError}</span>
          )}
        </div>
      </section>

      {/* ── PDF vision ingest ─────────────────────────── */}
      <section className="settings-section">
        <div className="settings-section__header-row">
          <h3 className="settings-section__heading">PDF page images</h3>
          <button
            type="button"
            className={`phoenix-toggle ${pdfImageIngest ? 'phoenix-toggle--on' : ''}`}
            onClick={() => setPdfImageIngest((v) => !v)}
            aria-pressed={pdfImageIngest}
          >
            <span className="phoenix-toggle__track">
              <span className="phoenix-toggle__thumb" />
            </span>
            <span className="phoenix-toggle__label">{pdfImageIngest ? 'Enabled' : 'Disabled'}</span>
          </button>
        </div>
        <p className="settings-section__hint">
          When enabled, attached PDFs and <code className="settings-inline-code">ingest_source</code> with{' '}
          <code className="settings-inline-code">mode: &quot;vision&quot;</code> send rasterized page screenshots.
          When disabled, PDFs are extracted as Markdown only (markitdown).
        </p>
      </section>

      {/* ── OpenAI File Upload ────────────────────────── */}
      <section className="settings-section">
        <div className="settings-section__header-row">
          <h3 className="settings-section__heading">OpenAI File Upload</h3>
          <button
            type="button"
            className={`phoenix-toggle ${fileIngest ? 'phoenix-toggle--on' : ''}${!endpointUrl.toLowerCase().includes('openai') ? ' phoenix-toggle--disabled' : ''}`}
            onClick={() => { if (endpointUrl.toLowerCase().includes('openai')) setFileIngest((v) => !v); }}
            aria-pressed={fileIngest}
            disabled={!endpointUrl.toLowerCase().includes('openai')}
          >
            <span className="phoenix-toggle__track">
              <span className="phoenix-toggle__thumb" />
            </span>
            <span className="phoenix-toggle__label">{fileIngest ? 'Enabled' : 'Disabled'}</span>
          </button>
        </div>
        <p className="settings-section__hint">
          {endpointUrl.toLowerCase().includes('openai')
            ? <>When enabled, Lumina switches the chat to the OpenAI <strong>Responses API</strong> and uploads PDF/PPTX/XLSX/DOCX/etc. via the Files API, referencing them by file ID. Spreadsheets get a server-side augmentation flow; office docs are read natively. Images stay inline as native vision content blocks. Disable to keep using Chat Completions and local <code className="settings-inline-code">markitdown</code> extraction for non-PDF formats.</>
            : <>File upload is not supported by the current LLM endpoint. Only OpenAI-compatible endpoints support this feature.</>
          }
        </p>
      </section>

      {/* ── QMD semantic search ───────────────────────── */}
      <section className="settings-section">
        <div className="settings-section__header-row">
          <h3 className="settings-section__heading">Semantic search (QMD)</h3>
          <button
            type="button"
            className={`phoenix-toggle ${qmdSearchEnabled ? 'phoenix-toggle--on' : ''}`}
            onClick={() => setQmdSearchEnabled((v) => !v)}
            aria-pressed={qmdSearchEnabled}
          >
            <span className="phoenix-toggle__track">
              <span className="phoenix-toggle__thumb" />
            </span>
            <span className="phoenix-toggle__label">{qmdSearchEnabled ? 'Enabled' : 'Disabled'}</span>
          </button>
        </div>
        <p className="settings-section__hint">
          When enabled, Chat <code className="settings-inline-code">search_wiki</code> uses local QMD
          hybrid search (BM25 + vectors) over <code className="settings-inline-code">wiki/</code>. Global
          search (<span className="kbd">⌘⇧F</span>) stays on FlexSearch for instant results. First enable
          downloads a local embedding model (~334 MB).
        </p>
        {qmdSearchEnabled && (
          <>
            <label className="settings-field">
              <span className="settings-field__label">Search mode</span>
              <select
                className="settings-field__input"
                value={qmdSearchMode}
                onChange={(e) => setQmdSearchMode(e.target.value as QmdSearchMode)}
              >
                <option value="hybrid">Hybrid (best quality)</option>
                <option value="lex">Keyword only (faster)</option>
              </select>
            </label>
            <div className="settings-section__header-row">
              <span className="settings-field__label">Auto-embed after indexing</span>
              <button
                type="button"
                className={`phoenix-toggle ${qmdAutoEmbed ? 'phoenix-toggle--on' : ''}`}
                onClick={() => setQmdAutoEmbed((v) => !v)}
                aria-pressed={qmdAutoEmbed}
              >
                <span className="phoenix-toggle__track">
                  <span className="phoenix-toggle__thumb" />
                </span>
                <span className="phoenix-toggle__label">{qmdAutoEmbed ? 'On' : 'Off'}</span>
              </button>
            </div>
            {qmdStatus && (
              <p className="settings-section__hint">
                {describeQmdActivity(qmdStatus)}
                {' · '}
                {qmdStatus.totalDocuments} documents
                {qmdStatus.needsEmbedding > 0
                  ? ` · ${qmdStatus.needsEmbedding} pending embed`
                  : ''}
                {qmdStatus.error ? ` · Error: ${qmdStatus.error}` : ''}
              </p>
            )}
            <div className="settings-field__row settings-field__row--actions">
              <button
                className="settings-field__btn"
                type="button"
                onClick={handleRebuildQmd}
                disabled={qmdRebuilding || !vaultPath}
              >
                {qmdRebuilding ? 'Rebuilding…' : 'Rebuild index'}
              </button>
            </div>
          </>
        )}
      </section>

      {/* ── MCP server ────────────────────────────────── */}
      <section className="settings-section">
        <div className="settings-section__header-row">
          <h3 className="settings-section__heading">MCP server</h3>
          <button
            type="button"
            className={`phoenix-toggle ${mcpEnabled ? 'phoenix-toggle--on' : ''}`}
            onClick={() => setMcpEnabled((v) => !v)}
            aria-pressed={mcpEnabled}
          >
            <span className="phoenix-toggle__track">
              <span className="phoenix-toggle__thumb" />
            </span>
            <span className="phoenix-toggle__label">{mcpEnabled ? 'Enabled' : 'Disabled'}</span>
          </button>
        </div>
        <p className="settings-section__hint">
          Lets other agents (Cursor, Claude Code, …) search and read this wiki over MCP and answer with
          their own model via the <code className="settings-inline-code">answer_from_wiki</code> prompt.
          The HTTP endpoint listens on <code className="settings-inline-code">127.0.0.1</code> only while
          Lumina runs and requires the bearer token. The stdio command below works without the app.
          Every vault in your vault list is reachable: agents call <code className="settings-inline-code">list_vaults</code>{' '}
          and pass <code className="settings-inline-code">vault</code> to any tool (default: the open vault /{' '}
          <code className="settings-inline-code">--vault</code>).
        </p>
        {mcpEnabled && (
          <>
            <label className="settings-field">
              <span className="settings-field__label">Port</span>
              <input
                className="settings-field__input settings-field__input--short"
                type="number"
                min={1024}
                max={65535}
                value={mcpPort}
                onChange={(e) => setMcpPort(e.target.value)}
                placeholder={String(DEFAULT_MCP_SERVER_CONFIG.port)}
              />
            </label>
            {mcpStatus && (
              <p className="settings-section__hint">
                {mcpStatus.running ? `Running at ${mcpStatus.url}` : 'Not running — save to start'}
                {mcpStatus.error ? ` · Error: ${mcpStatus.error}` : ''}
              </p>
            )}
            <label className="settings-field">
              <span className="settings-field__label">Bearer token</span>
              <div className="settings-field__row">
                <input
                  className="settings-field__input settings-field__input--path"
                  type={mcpTokenVisible ? 'text' : 'password'}
                  value={mcpToken}
                  readOnly
                  placeholder="Generated when you save"
                />
                <button className="settings-field__btn" type="button" onClick={() => setMcpTokenVisible((v) => !v)}>
                  {mcpTokenVisible ? 'Hide' : 'Show'}
                </button>
                <button
                  className="settings-field__btn"
                  type="button"
                  disabled={!mcpToken}
                  onClick={() => void copyMcpText('token', mcpToken)}
                >
                  {mcpCopied === 'token' ? 'Copied' : 'Copy'}
                </button>
                <button
                  className="settings-field__btn"
                  type="button"
                  disabled={!mcpToken}
                  onClick={() => void handleRegenerateMcpToken()}
                  title="Invalidates the current token for all HTTP clients"
                >
                  Regenerate
                </button>
              </div>
            </label>
            <div className="settings-section__header-row">
              <span className="settings-field__label">Allow writing wiki pages</span>
              <button
                type="button"
                className={`phoenix-toggle ${mcpAllowWrite ? 'phoenix-toggle--on' : ''}`}
                onClick={() => setMcpAllowWrite((v) => !v)}
                aria-pressed={mcpAllowWrite}
              >
                <span className="phoenix-toggle__track">
                  <span className="phoenix-toggle__thumb" />
                </span>
                <span className="phoenix-toggle__label">{mcpAllowWrite ? 'On' : 'Off'}</span>
              </button>
            </div>
            <p className="settings-section__hint">
              Adds <code className="settings-inline-code">write_wiki_page</code> and{' '}
              <code className="settings-inline-code">append_wiki_log</code> so the caller&apos;s model can ingest
              with the <code className="settings-inline-code">ingest</code> prompt. Writes are limited to{' '}
              <code className="settings-inline-code">wiki/</code>; <code className="settings-inline-code">raw/</code> stays read-only.
            </p>
            <div className="settings-section__header-row">
              <span className="settings-field__label">Allow ingest with Lumina&apos;s model</span>
              <button
                type="button"
                className={`phoenix-toggle ${mcpAllowLuminaIngest ? 'phoenix-toggle--on' : ''}`}
                onClick={() => setMcpAllowLuminaIngest((v) => !v)}
                aria-pressed={mcpAllowLuminaIngest}
              >
                <span className="phoenix-toggle__track">
                  <span className="phoenix-toggle__thumb" />
                </span>
                <span className="phoenix-toggle__label">{mcpAllowLuminaIngest ? 'On' : 'Off'}</span>
              </button>
            </div>
            <p className="settings-section__hint">
              Adds <code className="settings-inline-code">ingest_with_lumina</code> (HTTP only): Lumina ingests a{' '}
              <code className="settings-inline-code">raw/</code> file with its own LLM and tools, exactly like
              <code className="settings-inline-code">/ingest</code> in Chat, and uses your API quota.
            </p>
            {(
              [
                ['http', 'HTTP (while Lumina runs)', buildHttpMcpSnippet(parseMcpPort(mcpPort, DEFAULT_MCP_SERVER_CONFIG.port), mcpToken)],
                ['http-url', 'HTTP, token in URL (for clients that reject an Authorization header)', buildHttpUrlTokenMcpSnippet(parseMcpPort(mcpPort, DEFAULT_MCP_SERVER_CONFIG.port), mcpToken)],
                ...(mcpStatus
                  ? [['stdio', 'stdio (no app needed, read-only unless writes are allowed)', buildStdioMcpSnippet(mcpStatus, vaultPath)]]
                  : []),
              ] as [string, string, string][]
            ).map(([key, label, snippet]) => (
              <div className="settings-field" key={key}>
                <div className="settings-field__row">
                  <span className="settings-field__label">{label}</span>
                  <button className="settings-field__btn" type="button" onClick={() => void copyMcpText(key, snippet)}>
                    {mcpCopied === key ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="settings-code-block">{mcpTokenVisible || !key.startsWith('http') ? snippet : snippet.replace(mcpToken || '\u0000', '••••••••')}</pre>
              </div>
            ))}
          </>
        )}
      </section>

      {/* ── Phoenix Observability Section ────────────── */}
      <section className="settings-section">
        <div className="settings-section__header-row">
          <h3 className="settings-section__heading">Phoenix Observability</h3>
          <button
            type="button"
            className={`phoenix-toggle ${phoenixEnabled ? 'phoenix-toggle--on' : ''}`}
            onClick={() => {
              const next = !phoenixEnabled;
              setPhoenixEnabled(next);
              if (!next) {
                setPhoenixScheme('http');
                setPhoenixHost('localhost');
                setPhoenixPort('6006');
              }
            }}
            aria-pressed={phoenixEnabled}
          >
            <span className="phoenix-toggle__track">
              <span className="phoenix-toggle__thumb" />
            </span>
            <span className="phoenix-toggle__label">{phoenixEnabled ? 'Enabled' : 'Disabled'}</span>
          </button>
        </div>

        {phoenixEnabled && (
          <>
            <label className="settings-field">
              <span className="settings-field__label">Host</span>
              <div className="settings-field__input-group">
                <button
                  type="button"
                  className="settings-field__scheme-btn"
                  onClick={() => setPhoenixScheme(s => s === 'http' ? 'https' : 'http')}
                  title="Click to toggle http / https"
                >
                  {phoenixScheme}://
                </button>
                <input
                  className="settings-field__input settings-field__input--grouped"
                  type="text"
                  value={phoenixHost}
                  onChange={(e) => setPhoenixHost(e.target.value)}
                  placeholder="localhost"
                />
              </div>
            </label>

            <label className="settings-field">
              <span className="settings-field__label">Port</span>
              <input
                className="settings-field__input settings-field__input--short"
                type="number"
                min={1}
                max={65535}
                value={phoenixPort}
                onChange={(e) => setPhoenixPort(e.target.value)}
                placeholder="6006"
              />
            </label>
          </>
        )}
      </section>

      {/* ── Save ──────────────────────────────────────── */}
      <div className="settings-panel__footer">
        <button
          className="settings-panel__save-btn"
          type="button"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
        {saveMsg && (
          <span
            className={`settings-panel__msg ${saveMsg.startsWith('Settings saved') ? 'settings-panel__msg--ok' : 'settings-panel__msg--err'}`}
          >
            {saveMsg}
          </span>
        )}
      </div>
      </div>
    </div>
  );
};

export default SettingsPanel;
