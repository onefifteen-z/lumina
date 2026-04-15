import { contextBridge, ipcRenderer } from "electron";

// Preload script stub — exposes a typed API to the renderer via contextBridge.
// Each method will wrap an ipcRenderer.invoke call with a typed channel name.
// Full implementation will be added in task 6.1.

contextBridge.exposeInMainWorld("api", {
  // Placeholder — will be populated with WikiAPI methods
  ping: () => ipcRenderer.invoke("ping"),
});
