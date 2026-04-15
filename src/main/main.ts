import { app, BrowserWindow, dialog } from "electron";
import path from "path";
import fs from "fs";
import { registerIpcHandlers, hasUnsavedChanges } from "./ipc-handlers";
import { FileSystemService } from "./services/filesystem-service";
import { SearchIndexService } from "./services/search-index-service";
import { LLMService } from "./services/llm-service";
import { ConfigService } from "./services/config-service";
import { ChatService } from "./services/chat-service";

let mainWindow: BrowserWindow | null = null;

// ── Error logging ──────────────────────────────────────────────

const LOG_FILE = path.join(app.getPath("userData"), "llm-wiki-error.log");

function logToFile(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line, "utf-8");
  } catch {
    // Last resort — can't even write to log
    console.error(line);
  }
}

// ── Window creation ────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 20 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "..", "..", "preload", "preload.js"),
    },
  });

  if (process.env.NODE_ENV === "development") {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(
      path.join(__dirname, "..", "..", "renderer", "index.html"),
    );
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── Fatal error handler ────────────────────────────────────────

function handleFatalError(error: unknown, context: string): never {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? "") : "";

  logToFile(`FATAL [${context}]: ${message}\n${stack}`);

  dialog.showErrorBox(
    "LLM Wiki — Fatal Error",
    `${context}\n\n${message}\n\nThe application will now exit. Check the log at:\n${LOG_FILE}`,
  );

  app.exit(1);
  // TypeScript needs this even though app.exit terminates
  process.exit(1);
}

// ── App startup ────────────────────────────────────────────────

app.whenReady().then(async () => {
  let configService: ConfigService;
  try {
    configService = new ConfigService();
  } catch (err) {
    handleFatalError(err, "Failed to initialize configuration service");
  }

  let appConfig;
  try {
    appConfig = configService.getConfig();
  } catch (err) {
    handleFatalError(err, "Failed to read application configuration");
  }

  const vaultPath = appConfig.vaultPath;
  let fileSystemService: FileSystemService | null = null;
  let searchIndexService: SearchIndexService | null = null;

  if (vaultPath) {
    fileSystemService = new FileSystemService(vaultPath);
    searchIndexService = new SearchIndexService();

    // Build initial search index — non-fatal if it fails
    try {
      const articles = await fileSystemService.scanVault();
      await searchIndexService.buildIndex(articles);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logToFile(`WARNING: Failed to build initial search index: ${msg}`);
      console.warn("Failed to build initial search index:", err);
    }
  }

  // Initialize LLM service if configured
  let llmService: LLMService | null = null;
  if (appConfig.llmProvider) {
    try {
      const apiKey = configService.getApiKey();
      llmService = new LLMService(appConfig.llmProvider, apiKey);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logToFile(`WARNING: Failed to initialize LLM service: ${msg}`);
      console.warn("Failed to initialize LLM service:", err);
    }
  }

  // Initialize chat service
  const chatService = new ChatService(llmService, fileSystemService);

  // Register all IPC handlers
  registerIpcHandlers({
    fileSystem: fileSystemService,
    searchIndex: searchIndexService,
    llm: llmService,
    config: configService,
    mainWindow: mainWindow,
    chat: chatService,
  });

  createWindow();

  // Start vault file watcher — notify renderer of external changes
  if (vaultPath && fileSystemService) {
    fileSystemService.watchVault((event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("wiki:vaultChange", event);
      }
    });
  }

  // ── Quit handling ──────────────────────────────────────────

  let forceQuit = false;

  app.on("before-quit", (event) => {
    if (forceQuit) return;

    if (hasUnsavedChanges() && mainWindow && !mainWindow.isDestroyed()) {
      event.preventDefault();
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: "question",
        buttons: ["Discard & Quit", "Cancel"],
        defaultId: 1,
        title: "Unsaved Changes",
        message: "You have unsaved changes. Discard them and quit?",
      });
      if (choice === 0) {
        forceQuit = true;
        fileSystemService?.stopWatching();
        mainWindow.destroy();
        app.quit();
      }
    } else {
      fileSystemService?.stopWatching();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// ── Uncaught exception safety net ──────────────────────────────

process.on("uncaughtException", (err) => {
  logToFile(`UNCAUGHT EXCEPTION: ${err.message}\n${err.stack ?? ""}`);
  console.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? (reason.stack ?? "") : "";
  logToFile(`UNHANDLED REJECTION: ${msg}\n${stack}`);
  console.error("Unhandled rejection:", reason);
});
