// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { AppSettings, HostBridge, LoadedSourceDocument, SourceDirectory } from "@shared/contracts";

vi.mock("./audio", () => ({
  hydrateAudio: vi.fn(async () => ({
    arrayBuffer: new ArrayBuffer(8),
    blobUrl: "blob:mock",
    waveform: {
      workerChannelData: [new Int8Array([0, 1, 2])],
      waveformLevels: [],
      sampleRate: 9600,
      durationSec: 2,
    },
  })),
}));

vi.mock("./worker-client", () => ({
  SpectrogramWorkerClient: class {
    loadDocument() {}
    unloadDocument() {}
    render() {
      return Promise.resolve({ width: 1, height: 1, data: new Uint8ClampedArray(4) });
    }
    dispose() {}
  },
}));

vi.mock("./SpectrogramPane", () => ({
  SpectrogramPane: ({
    title,
    document,
    emptyState,
    allowFullRender,
  }: {
    title: string;
    document: unknown;
    emptyState?: { title: string };
    allowFullRender?: boolean;
  }) => (
    <div>
      <strong>{title}</strong>
      <span>{document ? "loaded" : emptyState?.title}</span>
      <span>{allowFullRender ? "full" : "preview"}</span>
    </div>
  ),
}));

import { App, replaceTrack } from "./App";

beforeAll(() => {
  class ResizeObserverMock {
    observe() {}
    disconnect() {}
  }

  Object.defineProperty(window, "ResizeObserver", {
    value: ResizeObserverMock,
    writable: true,
  });

  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value() {},
  });
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value() {
      return Promise.resolve();
    },
  });

  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});

function createTree(): SourceDirectory {
  return {
    name: "workspace",
    relativePath: "",
    absolutePath: "/workspace",
    directories: [],
    entries: [
      {
        sourcePath: "/workspace/unsupported.wav",
        kind: "wav",
        stem: "unsupported",
        relativeDir: ".",
        audioMeta: {
          sampleRate: 16000,
          channelCount: 2,
          durationSec: 1,
          bitsPerSample: 16,
        },
        denoiseEligibility: {
          supported: false,
          reason: "仅支持单声道 16-bit PCM WAV 送入降噪引擎。",
        },
        resultPath: null,
        resultStatus: "unsupported",
      },
    ],
  };
}

function createDocument(): LoadedSourceDocument {
  return {
    entry: createTree().entries[0],
    sourceAudioUrl: "file://source.wav",
    resultAudioUrl: null,
    resultAudioMeta: null,
    resultUpdatedAt: null,
    disableReason: "仅支持单声道 16-bit PCM WAV 送入降噪引擎。",
  };
}

describe("App", () => {
  it("does not unload the worker document when replacing a result track with the same document id", () => {
    const unloadDocument = vi.fn();
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const workerClient = { unloadDocument } as unknown as {
      unloadDocument(documentId: string): void;
    };
    const previousTrack = {
      document: {
        documentId: "result:/workspace/sample.pcm",
        sampleRate: 9600,
        durationSec: 2,
      },
      blobUrl: "blob:previous",
      workerChannelData: [new Int8Array([1, 2, 3])],
    };
    const nextTrack = {
      document: {
        documentId: "result:/workspace/sample.pcm",
        sampleRate: 9600,
        durationSec: 2,
      },
      blobUrl: "blob:next",
      workerChannelData: [new Int8Array([4, 5, 6])],
    };

    replaceTrack(workerClient as never, previousTrack, nextTrack);

    expect(unloadDocument).not.toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:previous");
    revokeObjectURL.mockRestore();
  });

  it("shows unsupported state and empty denoised pane", async () => {
    const settings: AppSettings = {
      grpcAddress: "localhost:7860",
      pcmSampleRate: 9600,
      datSampleRate: 9600,
      uiThemePreference: "system",
      sourceHotkey: "r",
      resultHotkey: "d",
    };
    const host: HostBridge = {
      mode: "electron",
      pickDirectory: vi.fn(async () => null),
      getBootstrapState: vi.fn(async () => ({
        settings,
        lastWorkspacePath: "/workspace",
      })),
      getSettings: vi.fn(async () => settings),
      saveSettings: vi.fn(async (value) => value),
      testGrpcConnection: vi.fn(async () => ({ ok: true, message: "ok" })),
      scanWorkspace: vi.fn(async () => createTree()),
      loadSource: vi.fn(async () => createDocument()),
      runDenoise: vi.fn(),
      runBatch: vi.fn(),
      revealPath: vi.fn(async () => undefined),
      openPath: vi.fn(async () => undefined),
    };

    window.vishuddhiHost = host;
    render(<App />);

    await screen.findByRole("button", { name: "运行降噪" });
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "运行降噪" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });
    expect(screen.getByText("结果还不存在")).toBeTruthy();
    expect(screen.getByText("full")).toBeTruthy();
  });
});
