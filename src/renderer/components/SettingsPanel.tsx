import React, { useState, useEffect, useCallback } from 'react';
import type { LLMProviderConfig, PhoenixConfig } from '../../shared/types';

type ConnectionStatus = 'idle' | 'testing' | 'success' | 'error';

const DEFAULT_PHOENIX: PhoenixConfig = { enabled: false, scheme: 'http', host: 'localhost', port: 6006 };

const SettingsPanel: React.FC = () => {
  // LLM provider fields
  const [endpointUrl, setEndpointUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');

  // Vault
  const [vaultPath, setVaultPath] = useState('');

  // Phoenix
  const [phoenixEnabled, setPhoenixEnabled] = useState(false);
  const [phoenixScheme, setPhoenixScheme] = useState<'http' | 'https'>('http');
  const [phoenixHost, setPhoenixHost] = useState('localhost');
  const [phoenixPort, setPhoenixPort] = useState('6006');

  /** Rasterize PDF pages to PNG for chat attach and ingest_source vision mode. */
  const [pdfImageIngest, setPdfImageIngest] = useState(false);

  /** Upload PDF/image/PPTX via OpenAI Files API. */
  const [fileIngest, setFileIngest] = useState(false);

  // UI state
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [connStatus, setConnStatus] = useState<ConnectionStatus>('idle');
  const [connError, setConnError] = useState<string | null>(null);

  // Load current config on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [config, storedKey] = await Promise.all([
          window.api.getConfig(),
          window.api.getApiKey(),
        ]);
        if (cancelled) return;
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
      } catch {
        // Defaults are fine
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

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

      await window.api.saveConfig({ vaultPath, llmProvider, phoenix, pdfImageIngest, fileIngest });
      await window.api.saveApiKey(apiKey);

      setSaveMsg('Settings saved');
      setTimeout(() => setSaveMsg(null), 3000);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }, [endpointUrl, apiKey, model, vaultPath, phoenixEnabled, phoenixScheme, phoenixHost, phoenixPort, pdfImageIngest, fileIngest]);

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
            ? <>When enabled, PDFs are uploaded via the OpenAI Files API and referenced by file ID during ingest (more efficient than inline base64). Images are attached as native vision content blocks. Other office formats (XLSX, PPTX, DOCX, …) still fall back to local text extraction since Chat Completions only accepts file IDs for PDFs.</>
            : <>File upload is not supported by the current LLM endpoint. Only OpenAI-compatible endpoints support this feature.</>
          }
        </p>
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
