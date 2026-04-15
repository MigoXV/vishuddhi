/// <reference lib="webworker" />

import type { FrequencyScale } from "../shared/contracts";
import {
  cacheSpectrogramResult,
  renderSpectrogramPixels,
  type SpectrogramDocumentData,
  type SpectrogramRenderQuality,
  type SpectrogramThemeMode,
} from "../shared/spectrogram-render";

type IncomingMessage =
  | {
      kind: "load-document";
      documentId: string;
      channelData: Int8Array[];
      sampleRate: number;
    }
  | {
      kind: "unload-document";
      documentId: string;
    }
  | {
      kind: "render";
      requestId: number;
      documentId: string;
      channelIndex: number;
      width: number;
      height: number;
      startSec: number;
      endSec: number;
      minFreq: number;
      maxFreq: number;
      frequencyScale: FrequencyScale;
      themeMode: SpectrogramThemeMode;
      quality: SpectrogramRenderQuality;
    };

type OutgoingMessage =
  | {
      kind: "loaded";
      documentId: string;
    }
  | {
      kind: "rendered";
      requestId: number;
      width: number;
      height: number;
      pixels: Uint8ClampedArray;
    }
  | {
      kind: "render-failed";
      requestId: number;
      message: string;
    };

const documents = new Map<string, SpectrogramDocumentData>();
const cache = new Map<string, Uint8ClampedArray>();

self.onmessage = (event: MessageEvent<IncomingMessage>) => {
  const payload = event.data;
  if (payload.kind === "load-document") {
    cache.clear();
    documents.set(payload.documentId, {
      channelData: payload.channelData,
      sampleRate: payload.sampleRate,
    });
    self.postMessage({
      kind: "loaded",
      documentId: payload.documentId,
    } satisfies OutgoingMessage);
    return;
  }

  if (payload.kind === "unload-document") {
    cache.clear();
    documents.delete(payload.documentId);
    return;
  }

  const document = documents.get(payload.documentId);
  if (!document) {
    self.postMessage({
      kind: "render-failed",
      requestId: payload.requestId,
      message: `语谱图文档未加载：${payload.documentId}`,
    } satisfies OutgoingMessage);
    return;
  }

  try {
    const key = JSON.stringify(payload);
    const pixels =
      cache.get(key) ??
      cacheSpectrogramResult(
        cache,
        key,
        renderSpectrogramPixels(document, payload, payload.channelIndex),
      );

    self.postMessage({
      kind: "rendered",
      requestId: payload.requestId,
      width: payload.width,
      height: payload.height,
      pixels,
    } satisfies OutgoingMessage);
  } catch (error) {
    self.postMessage({
      kind: "render-failed",
      requestId: payload.requestId,
      message:
        error instanceof Error
          ? error.message
          : "语谱图 worker 渲染失败。",
    } satisfies OutgoingMessage);
  }
};
