import type {
  AppSettings,
  BatchJobStatus,
  BootstrapState,
  HostBridge,
  LoadedSourceDocument,
  RunDenoiseOptions,
  RunDenoiseResult,
  SourceDirectory,
} from "@shared/contracts";
import { HOST_SERVICE_PORT } from "@shared/constants";

function getServiceOrigin(): string {
  const configuredOrigin = import.meta.env.VITE_HOST_SERVICE_URL;
  if (configuredOrigin) {
    return configuredOrigin;
  }

  return `${window.location.protocol}//${window.location.hostname}:${HOST_SERVICE_PORT}`;
}

async function requestJson<TResponse>(
  endpoint: string,
  options: RequestInit,
): Promise<TResponse> {
  let response: Response;

  try {
    response = await fetch(endpoint, options);
  } catch {
    throw new Error(
      `Host service is unreachable at ${endpoint}. Start it with "pnpm dev:web" or "pnpm dev:service".`,
    );
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(
      payload?.error ??
        `Request failed: ${response.status} ${response.statusText} (${endpoint})`,
    );
  }

  return response.json() as Promise<TResponse>;
}

function withOrigin(path: string): string {
  if (path.startsWith("http")) {
    return path;
  }

  return `${getServiceOrigin()}${path}`;
}

export const browserHostBridge: HostBridge = {
  mode: "browser",
  async pickDirectory() {
    const directory = window.prompt("输入待扫描目录的绝对路径");
    return directory?.trim() ? directory.trim() : null;
  },
  getBootstrapState() {
    return requestJson<BootstrapState>(`${getServiceOrigin()}/api/bootstrap`, {
      method: "GET",
    });
  },
  getSettings() {
    return requestJson<AppSettings>(`${getServiceOrigin()}/api/settings`, {
      method: "GET",
    });
  },
  saveSettings(settings: AppSettings) {
    return requestJson<AppSettings>(`${getServiceOrigin()}/api/settings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(settings),
    });
  },
  testGrpcConnection(grpcAddress: string) {
    return requestJson<{ ok: boolean; message: string }>(
      `${getServiceOrigin()}/api/testGrpcConnection`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ grpcAddress }),
      },
    );
  },
  scanWorkspace(rootPath: string) {
    return requestJson<SourceDirectory>(`${getServiceOrigin()}/api/scanWorkspace`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ rootPath }),
    });
  },
  async loadSource(sourcePath: string) {
    const document = await requestJson<LoadedSourceDocument>(
      `${getServiceOrigin()}/api/loadSource`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ sourcePath }),
      },
    );

    return {
      ...document,
      sourceAudioUrl: withOrigin(document.sourceAudioUrl),
      resultAudioUrl: document.resultAudioUrl ? withOrigin(document.resultAudioUrl) : null,
    };
  },
  runDenoise(sourcePath: string, options?: RunDenoiseOptions) {
    return requestJson<RunDenoiseResult>(`${getServiceOrigin()}/api/runDenoise`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ sourcePath, options }),
    });
  },
  runBatch(targetDirectory: string, options?: RunDenoiseOptions) {
    return requestJson<BatchJobStatus>(`${getServiceOrigin()}/api/runBatch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ targetDirectory, options }),
    });
  },
  async revealPath(targetPath: string) {
    await requestJson<{ ok: true }>(`${getServiceOrigin()}/api/revealPath`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ path: targetPath }),
    });
  },
  async openPath(targetPath: string) {
    await requestJson<{ ok: true }>(`${getServiceOrigin()}/api/openPath`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ path: targetPath }),
    });
  },
};
