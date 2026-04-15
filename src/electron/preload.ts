import { contextBridge, ipcRenderer } from "electron";

import type {
  AppSettings,
  HostBridge,
  RunDenoiseOptions,
} from "@shared/contracts";

const hostBridge: HostBridge = {
  mode: "electron",
  pickDirectory: () => ipcRenderer.invoke("host:pickDirectory"),
  getBootstrapState: () => ipcRenderer.invoke("host:getBootstrapState"),
  getSettings: () => ipcRenderer.invoke("host:getSettings"),
  saveSettings: (settings: AppSettings) =>
    ipcRenderer.invoke("host:saveSettings", settings),
  testGrpcConnection: (grpcAddress: string) =>
    ipcRenderer.invoke("host:testGrpcConnection", grpcAddress),
  scanWorkspace: (rootPath: string) =>
    ipcRenderer.invoke("host:scanWorkspace", rootPath),
  loadSource: (sourcePath: string) => ipcRenderer.invoke("host:loadSource", sourcePath),
  runDenoise: (sourcePath: string, options?: RunDenoiseOptions) =>
    ipcRenderer.invoke("host:runDenoise", sourcePath, options),
  runBatch: (targetDirectory: string, options?: RunDenoiseOptions) =>
    ipcRenderer.invoke("host:runBatch", targetDirectory, options),
  revealPath: (targetPath: string) => ipcRenderer.invoke("host:revealPath", targetPath),
  openPath: (targetPath: string) => ipcRenderer.invoke("host:openPath", targetPath),
};

contextBridge.exposeInMainWorld("vishuddhiHost", hostBridge);
