import React, { useState, useEffect, useCallback } from 'react';
import type { AppConfig, LLMProviderConfig } from '../../shared/types';

type ConnectionStatus = 'idle' | 'testing' | 'success' | 'error';

const SettingsPanel: React.FC = () => {
  // LLM provider fields
  const [endpointUrl, setEndpointUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');

  // Vault & theme
  const [vaultPath, setVaultPath] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');

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
        setTheme(config.theme);
        setEndpointUrl(config.llmProvider?.endpointUrl ?? '');
        setModel(config.llmProvider?.model ?? '');
        setApiKey(storedKey);
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

      await window.api.saveConfig({ vaultPath, theme, llmProvider });
      await window.api.saveApiKey(apiKey);

      // Apply theme immediately
      document.documentElement.setAttribute(
        'data-theme',
        theme === 'system'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : theme,
      );

      setSaveMsg('Settings saved');
      setTimeout(() => setSaveMsg(null), 3000);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }, [endpointUrl, apiKey, model, vaultPath, theme]);

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

      {/* ── Theme Section ─────────────────────────────── */}
      <section className="settings-section">
        <h3 className="settings-section__heading">Appearance</h3>

        <label className="settings-field">
          <span className="settings-field__label">Theme</span>
          <select
            className="settings-field__select"
            value={theme}
            onChange={(e) => setTheme(e.target.value as AppConfig['theme'])}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
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
  );
};

export default SettingsPanel;
