import { app, dialog, safeStorage, BrowserWindow } from "electron";
import Store from "electron-store";
import path from "path";
import fs from "fs";
import { AppConfig, LLMProviderConfig, VaultEntry } from "../../shared/types";

const API_KEY_BUFFER_ENCODING = "latin1";
const API_KEY_FILE = "llm-api-key.enc";
const VAULT_HISTORY_MAX = 20;

interface StoreSchema {
  vaultPath: string;
  vaultHistory: VaultEntry[];
  llmProvider: LLMProviderConfig | null;
  theme: "light" | "dark" | "system";
  chatHistorySidebarOpen: boolean;
  lastChatSessionId: string;
}

export class ConfigService {
  private store: Store<StoreSchema>;
  private apiKeyPath: string;

  constructor() {
    this.store = new Store<StoreSchema>({
      name: "llm-wiki-config",
      defaults: {
        vaultPath: "",
        vaultHistory: [],
        llmProvider: null,
        theme: "system",
        chatHistorySidebarOpen: false,
        lastChatSessionId: "",
      },
    });

    this.apiKeyPath = path.join(app.getPath("userData"), API_KEY_FILE);
  }

  /** Return the current application configuration. */
  getConfig(): AppConfig {
    return {
      vaultPath: this.store.get("vaultPath"),
      llmProvider: this.store.get("llmProvider"),
      theme: this.store.get("theme"),
      chatHistorySidebarOpen: this.store.get("chatHistorySidebarOpen"),
      lastChatSessionId: this.store.get("lastChatSessionId"),
    };
  }

  /** Merge partial config updates into the persisted store. */
  saveConfig(partial: Partial<AppConfig>): void {
    if (partial.vaultPath !== undefined) {
      this.store.set("vaultPath", partial.vaultPath);
    }
    if (partial.llmProvider !== undefined) {
      this.store.set("llmProvider", partial.llmProvider);
    }
    if (partial.theme !== undefined) {
      this.store.set("theme", partial.theme);
    }
    if (partial.chatHistorySidebarOpen !== undefined) {
      this.store.set("chatHistorySidebarOpen", partial.chatHistorySidebarOpen);
    }
    if (partial.lastChatSessionId !== undefined) {
      this.store.set("lastChatSessionId", partial.lastChatSessionId);
    }
  }

  /**
   * Retrieve the stored API key from the OS keychain via safeStorage.
   * Returns an empty string if no key is stored or decryption is unavailable.
   */
  getApiKey(): string {
    if (!safeStorage.isEncryptionAvailable()) {
      return "";
    }

    try {
      if (!fs.existsSync(this.apiKeyPath)) {
        return "";
      }
      const encrypted = fs.readFileSync(this.apiKeyPath);
      return safeStorage.decryptString(encrypted);
    } catch {
      return "";
    }
  }

  /**
   * Encrypt and persist the API key using the OS keychain via safeStorage.
   * If an empty string is provided, the stored key file is removed.
   */
  saveApiKey(key: string): void {
    if (!key) {
      try {
        if (fs.existsSync(this.apiKeyPath)) {
          fs.unlinkSync(this.apiKeyPath);
        }
      } catch {
        // Ignore removal errors
      }
      return;
    }

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "OS secure storage is not available. Cannot store API key securely.",
      );
    }

    const encrypted = safeStorage.encryptString(key);
    fs.writeFileSync(this.apiKeyPath, encrypted);
  }

  /**
   * Open a native folder picker dialog and return the selected path,
   * or null if the user cancelled.
   */
  async selectVaultFolder(): Promise<string | null> {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const options: Electron.OpenDialogOptions = {
      title: "Select Wiki Vault Folder",
      properties: ["openDirectory", "createDirectory"],
    };

    const result = focusedWindow
      ? await dialog.showOpenDialog(focusedWindow, options)
      : await dialog.showOpenDialog(options);

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  }

  /** Return the list of recently-used vaults. */
  getVaultHistory(): VaultEntry[] {
    return this.store.get("vaultHistory");
  }

  /**
   * Add a vault path to the history list (deduplicates, most-recent first).
   * Caps the list at VAULT_HISTORY_MAX entries.
   */
  addVaultToHistory(vaultPath: string): void {
    const name = path.basename(vaultPath);
    const entry: VaultEntry = { path: vaultPath, name };
    const existing = this.store.get("vaultHistory").filter(
      (e) => e.path !== vaultPath,
    );
    this.store.set("vaultHistory", [entry, ...existing].slice(0, VAULT_HISTORY_MAX));
  }

  /** Remove a vault from the history list. Does not affect the active vault. */
  removeVaultFromHistory(vaultPath: string): void {
    const filtered = this.store.get("vaultHistory").filter(
      (e) => e.path !== vaultPath,
    );
    this.store.set("vaultHistory", filtered);
  }

  /** Returns true when no vault path has been configured (first-run state). */
  isFirstRun(): boolean {
    const vaultPath = this.store.get("vaultPath");
    return !vaultPath;
  }

  /**
   * Create a .lumina-vault marker file at the root of the given vault path.
   * If the file already exists, it is left untouched.
   * Throws on permission errors so the caller can abort vault selection.
   */
  async createMarkerFile(vaultPath: string): Promise<void> {
    const markerPath = path.join(vaultPath, ".lumina-vault");
    if (fs.existsSync(markerPath)) return;

    const content = JSON.stringify(
      { createdAt: new Date().toISOString() },
      null,
      2,
    );
    fs.writeFileSync(markerPath, content, "utf-8");
  }
}
