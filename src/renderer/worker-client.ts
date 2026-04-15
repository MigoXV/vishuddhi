import type { FrequencyScale } from "../shared/contracts";
import {
  renderSpectrogramPixels,
  type SpectrogramDocumentData,
  type SpectrogramRenderQuality,
  type SpectrogramThemeMode,
} from "../shared/spectrogram-render";

type WorkerRequest =
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

type WorkerResponse =
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

const RENDER_TIMEOUT_MS = 1_200;

interface PendingRender {
  reject(error: Error): void;
  resolve(payload: {
    width: number;
    height: number;
    pixels: Uint8ClampedArray;
  }): void;
  timeoutId: number;
}

export class SpectrogramWorkerClient {
  private worker = new Worker(
    new URL("../workers/spectrogram.worker.ts", import.meta.url),
    { type: "module" },
  );

  private documents = new Map<string, SpectrogramDocumentData>();
  private requestId = 0;
  private pending = new Map<number, PendingRender>();
  private workerHealthy = true;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const payload = event.data;
      if (payload.kind === "loaded") {
        return;
      }

      const pending = this.pending.get(payload.requestId);
      if (!pending) {
        return;
      }

      this.pending.delete(payload.requestId);
      window.clearTimeout(pending.timeoutId);
      if (payload.kind === "render-failed") {
        pending.reject(new Error(payload.message));
        return;
      }

      pending.resolve(payload);
    };

    this.worker.onerror = (event) => {
      this.workerHealthy = false;
      this.rejectAll(
        new Error(
          event.message || "语谱图 worker 崩溃，渲染已中断。",
        ),
      );
    };

    this.worker.onmessageerror = () => {
      this.workerHealthy = false;
      this.rejectAll(new Error("语谱图 worker 返回了无法解析的数据。"));
    };
  }

  loadDocument(
    documentId: string,
    channelData: Int8Array[],
    sampleRate: number,
  ): void {
    this.documents.set(documentId, {
      channelData,
      sampleRate,
    });

    const payload: WorkerRequest = {
      kind: "load-document",
      documentId,
      channelData,
      sampleRate,
    };

    this.worker.postMessage(payload);
  }

  unloadDocument(documentId: string): void {
    this.documents.delete(documentId);
    this.worker.postMessage({
      kind: "unload-document",
      documentId,
    } satisfies WorkerRequest);
  }

  render(request: Omit<Extract<WorkerRequest, { kind: "render" }>, "kind" | "requestId">) {
    if (!this.workerHealthy) {
      return this.renderInMainThread(request);
    }

    const requestId = ++this.requestId;
    this.worker.postMessage({
      kind: "render",
      requestId,
      ...request,
    } satisfies WorkerRequest);

    return new Promise<ImageData>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.pending.delete(requestId);
        void this.renderInMainThread(request).then(resolve).catch(reject);
      }, RENDER_TIMEOUT_MS);

      this.pending.set(requestId, {
        timeoutId,
        reject,
        resolve: ({ width, height, pixels }) => {
          resolve(new ImageData(new Uint8ClampedArray(pixels), width, height));
        },
      });
    });
  }

  dispose(): void {
    this.documents.clear();
    this.rejectAll(new Error("语谱图 worker 已释放。"));
    this.worker.terminate();
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async renderInMainThread(
    request: Omit<Extract<WorkerRequest, { kind: "render" }>, "kind" | "requestId">,
  ): Promise<ImageData> {
    const document = this.documents.get(request.documentId);
    if (!document) {
      throw new Error(`语谱图文档未加载：${request.documentId}`);
    }

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });

    const pixels = renderSpectrogramPixels(
      document,
      request,
      request.channelIndex,
    );
    return new ImageData(pixels, request.width, request.height);
  }
}
