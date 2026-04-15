import { app, dialog, safeStorage, BrowserWindow } from "electron";
import Store from "electron-store";
import path from "path";
import fs from "fs";
import { AppConfig, LLMProviderConfig } from "../../shared/types";

const API_KEY_BUFFER_ENCODING = "latin1";
const API_KEY_FILE = "llm-api-key.enc";

interface StoreSchema {
  vaultPath: string;
  llmProvider: LLMProviderConfig | null;
  theme: "light" | "dark" | "system";
}

export class ConfigService {
  private store: Store<StoreSchema>;
  private apiKeyPath: string;

  constructor() {
    this.store = new Store<StoreSchema>({
      name: "llm-wiki-config",
      defaults: {
        vaultPath: "",
        llmProvider: null,
        theme: "system",
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

  /** Returns true when no vault path has been configured (first-run state). */
  isFirstRun(): boolean {
    const vaultPath = this.store.get("vaultPath");
    return !vaultPath;
  }
}
