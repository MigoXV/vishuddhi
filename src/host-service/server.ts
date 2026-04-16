import path from "node:path";
import { spawn } from "node:child_process";

import express from "express";

import type { AppSettings, RunDenoiseOptions } from "../shared/contracts";
import { HOST_SERVICE_PORT } from "../shared/constants";
import {
  buildPreviewWav,
  deriveResultPath,
  loadSourceDocument,
  scanWorkspace,
} from "../host-core/audio-source";
import { runBatchDenoise, runDenoiseForSource } from "../host-core/denoise";
import { testGrpcConnection } from "../host-core/grpc";
import { readBytes } from "../host-core/wav";

import { HostServiceStore } from "./store";

const app = express();
const store = new HostServiceStore();

app.use((request, response, next) => {
  response.header("Access-Control-Allow-Origin", "*");
  response.header("Access-Control-Allow-Headers", "Content-Type");
  response.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }

  next();
});

app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/bootstrap", async (_request, response) => {
  response.json(await store.load());
});

app.get("/api/settings", async (_request, response) => {
  response.json((await store.load()).settings);
});

app.post("/api/settings", async (request, response) => {
  try {
    response.json(await store.saveSettings(request.body as AppSettings));
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "保存设置失败。",
    });
  }
});

app.post("/api/testGrpcConnection", async (request, response) => {
  const grpcAddress = String(request.body?.grpcAddress ?? "");
  if (!grpcAddress) {
    response.status(400).json({ error: "grpcAddress is required" });
    return;
  }

  response.json(await testGrpcConnection(grpcAddress));
});

app.post("/api/scanWorkspace", async (request, response) => {
  const rootPath = String(request.body?.rootPath ?? "");
  if (!rootPath) {
    response.status(400).json({ error: "rootPath is required" });
    return;
  }

  try {
    await store.saveLastWorkspacePath(rootPath);
    const settings = (await store.load()).settings;
    response.json(await scanWorkspace(rootPath, settings));
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "扫描目录失败。",
    });
  }
});

app.post("/api/loadSource", async (request, response) => {
  const sourcePath = String(request.body?.sourcePath ?? "");
  if (!sourcePath) {
    response.status(400).json({ error: "sourcePath is required" });
    return;
  }

  try {
    const settings = (await store.load()).settings;
    response.json(
      await loadSourceDocument(sourcePath, settings, {
        resolveSourceAudioUrl: (resolvedSourcePath) =>
          `/api/audio?variant=source&sourcePath=${encodeURIComponent(resolvedSourcePath)}`,
        resolveResultAudioUrl: (resolvedSourcePath, stamp) =>
          `/api/audio?variant=result&sourcePath=${encodeURIComponent(resolvedSourcePath)}&stamp=${encodeURIComponent(String(stamp))}`,
      }),
    );
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "加载音频失败。",
    });
  }
});

app.post("/api/runDenoise", async (request, response) => {
  const sourcePath = String(request.body?.sourcePath ?? "");
  const options = request.body?.options as RunDenoiseOptions | undefined;
  if (!sourcePath) {
    response.status(400).json({ error: "sourcePath is required" });
    return;
  }

  try {
    const settings = (await store.load()).settings;
    response.json(await runDenoiseForSource(sourcePath, settings, options));
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "降噪失败。",
    });
  }
});

app.post("/api/runBatch", async (request, response) => {
  const targetDirectory = String(request.body?.targetDirectory ?? "");
  const options = request.body?.options as RunDenoiseOptions | undefined;
  const state = await store.load();
  if (!state.lastWorkspacePath) {
    response.status(400).json({ error: "No workspace selected." });
    return;
  }
  if (!targetDirectory) {
    response.status(400).json({ error: "targetDirectory is required" });
    return;
  }

  try {
    response.json(
      await runBatchDenoise(
        state.lastWorkspacePath,
        targetDirectory,
        state.settings,
        options,
      ),
    );
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "批量降噪失败。",
    });
  }
});

app.get("/api/audio", async (request, response) => {
  const sourcePath = String(request.query.sourcePath ?? "");
  const variant = String(request.query.variant ?? "");
  if (!sourcePath || (variant !== "source" && variant !== "result")) {
    response.status(400).json({ error: "sourcePath and variant are required" });
    return;
  }

  try {
    const settings = (await store.load()).settings;
    const bytes =
      variant === "source"
        ? await buildPreviewWav(sourcePath, settings)
        : await readBytes(deriveResultPath(sourcePath));
    response.setHeader("content-type", "audio/wav");
    response.setHeader("cache-control", "no-store");
    response.send(bytes);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "读取音频失败。",
    });
  }
});

app.post("/api/revealPath", async (request, response) => {
  const targetPath = String(request.body?.path ?? "");
  if (!targetPath) {
    response.status(400).json({ error: "path is required" });
    return;
  }

  try {
    await spawnForPlatform(targetPath, true);
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "打开目录失败。",
    });
  }
});

app.post("/api/openPath", async (request, response) => {
  const targetPath = String(request.body?.path ?? "");
  if (!targetPath) {
    response.status(400).json({ error: "path is required" });
    return;
  }

  try {
    await spawnForPlatform(targetPath, false);
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "打开文件失败。",
    });
  }
});

app.listen(HOST_SERVICE_PORT, () => {
  console.log(`Vishuddhi host service listening on http://localhost:${HOST_SERVICE_PORT}`);
});

function spawnForPlatform(targetPath: string, reveal: boolean): Promise<void> {
  const command = process.platform === "win32"
    ? "explorer"
    : process.platform === "darwin"
      ? "open"
      : "xdg-open";
  const args =
    process.platform === "win32"
      ? reveal
        ? ["/select,", path.normalize(targetPath)]
        : [path.normalize(targetPath)]
      : process.platform === "darwin"
        ? reveal
          ? ["-R", targetPath]
          : [targetPath]
        : [reveal ? path.dirname(targetPath) : targetPath];

  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", reject);
    child.unref();
    resolve();
  });
}
