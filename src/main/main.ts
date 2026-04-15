import { app, BrowserWindow } from "electron";
import path from "path";
import { registerIpcHandlers } from "./ipc-handlers";
import { FileSystemService } from "./services/filesystem-service";
import { SearchIndexService } from "./services/search-index-service";
import { LLMService } from "./services/llm-service";
import { ConfigService } from "./services/config-service";

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(
        __dirname,
        "..",
        "..",
        "preload",
        "preload",
        "preload.js",
      ),
    },
  });

  // In development, load from Vite dev server; in production, load the built file
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

app.whenReady().then(async () => {
  // Initialize services
  const configService = new ConfigService();
  const appConfig = configService.getConfig();

  const vaultPath = appConfig.vaultPath || app.getPath("documents");
  const fileSystemService = new FileSystemService(vaultPath);
  const searchIndexService = new SearchIndexService();

  // Build initial search index from vault contents
  try {
    const articles = await fileSystemService.scanVault();
    await searchIndexService.buildIndex(articles);
  } catch (err) {
    console.warn("Failed to build initial search index:", err);
  }

  // Initialize LLM service if configured
  let llmService: LLMService | null = null;
  if (appConfig.llmProvider) {
    const apiKey = configService.getApiKey();
    llmService = new LLMService(appConfig.llmProvider, apiKey);
  }

  // Register all IPC handlers
  registerIpcHandlers({
    fileSystem: fileSystemService,
    searchIndex: searchIndexService,
    llm: llmService,
    config: configService,
  });

  createWindow();

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
