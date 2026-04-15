import path from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  shell,
} from "electron";

import type { AppSettings, RunDenoiseOptions } from "@shared/contracts";
import { APP_NAME, AUDIO_PROTOCOL } from "@shared/constants";
import {
  buildPreviewWav,
  deriveResultPath,
  loadSourceDocument,
  scanWorkspace,
} from "@host-core/audio-source";
import { runBatchDenoise, runDenoiseForSource } from "@host-core/denoise";
import { testGrpcConnection } from "@host-core/grpc";
import { readBytes } from "@host-core/wav";

import { SessionStore } from "./store";

const sessionStore = new SessionStore();

protocol.registerSchemesAsPrivileged([
  {
    scheme: AUDIO_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1520,
    height: 980,
    minWidth: 1220,
    minHeight: 760,
    backgroundColor: "#f4f2ee",
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  }

  return mainWindow;
}

function buildAudioUrl(
  sourcePath: string,
  variant: "source" | "result",
  stamp?: number,
): string {
  const params = new URLSearchParams({
    variant,
    sourcePath,
  });
  if (typeof stamp === "number") {
    params.set("stamp", String(stamp));
  }
  return `${AUDIO_PROTOCOL}://audio?${params.toString()}`;
}

async function registerProtocol(): Promise<void> {
  await protocol.handle(AUDIO_PROTOCOL, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "audio") {
      return new Response("Not found", { status: 404 });
    }

    const sourcePath = url.searchParams.get("sourcePath");
    const variant = url.searchParams.get("variant");
    if (!sourcePath || (variant !== "source" && variant !== "result")) {
      return new Response("Missing sourcePath or variant", { status: 400 });
    }

    try {
      const settings = await sessionStore.getSettings();
      const bytes =
        variant === "source"
          ? await buildPreviewWav(sourcePath, settings)
          : await readBytes(deriveResultPath(sourcePath));
      return new Response(bytes, {
        headers: {
          "content-type": "audio/wav",
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      return new Response(
        error instanceof Error ? error.message : "Failed to stream audio",
        { status: 500 },
      );
    }
  });
}

async function getSettings(): Promise<AppSettings> {
  return sessionStore.getSettings();
}

async function registerIpcHandlers(): Promise<void> {
  ipcMain.handle("host:pickDirectory", async () => {
    const state = await sessionStore.load();
    const result = await dialog.showOpenDialog({
      defaultPath: state.lastWorkspacePath ?? undefined,
      properties: ["openDirectory"],
    });

    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle("host:getBootstrapState", async () => sessionStore.load());
  ipcMain.handle("host:getSettings", async () => sessionStore.getSettings());
  ipcMain.handle("host:saveSettings", async (_event, settings: AppSettings) => {
    return sessionStore.saveSettings(settings);
  });

  ipcMain.handle("host:testGrpcConnection", async (_event, grpcAddress: string) => {
    return testGrpcConnection(grpcAddress);
  });

  ipcMain.handle("host:scanWorkspace", async (_event, rootPath: string) => {
    if (!rootPath) {
      throw new Error("rootPath is required");
    }

    await sessionStore.saveLastWorkspacePath(rootPath);
    return scanWorkspace(rootPath, await getSettings());
  });

  ipcMain.handle("host:loadSource", async (_event, sourcePath: string) => {
    if (!sourcePath) {
      throw new Error("sourcePath is required");
    }

    return loadSourceDocument(sourcePath, await getSettings(), {
      resolveSourceAudioUrl: (resolvedSourcePath) =>
        buildAudioUrl(resolvedSourcePath, "source"),
      resolveResultAudioUrl: (resolvedSourcePath, stamp) =>
        buildAudioUrl(resolvedSourcePath, "result", stamp),
    });
  });

  ipcMain.handle(
    "host:runDenoise",
    async (
      _event,
      sourcePath: string,
      options: RunDenoiseOptions | undefined,
    ) => runDenoiseForSource(sourcePath, await getSettings(), options),
  );

  ipcMain.handle(
    "host:runBatch",
    async (
      _event,
      targetDirectory: string,
      options: RunDenoiseOptions | undefined,
    ) => {
      const state = await sessionStore.load();
      if (!state.lastWorkspacePath) {
        throw new Error("No workspace selected.");
      }

      return runBatchDenoise(
        state.lastWorkspacePath,
        targetDirectory,
        state.settings,
        options,
      );
    },
  );

  ipcMain.handle("host:revealPath", async (_event, targetPath: string) => {
    shell.showItemInFolder(targetPath);
  });

  ipcMain.handle("host:openPath", async (_event, targetPath: string) => {
    const error = await shell.openPath(targetPath);
    if (error) {
      throw new Error(error);
    }
  });
}

app.whenReady().then(async () => {
  await sessionStore.load();
  await registerProtocol();
  await registerIpcHandlers();
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
