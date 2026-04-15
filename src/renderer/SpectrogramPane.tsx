import { useEffect, useMemo, useRef, useState } from "react";

import {
  MAX_SPECTROGRAM_PREVIEW_RENDER_HEIGHT,
  MAX_SPECTROGRAM_PREVIEW_RENDER_WIDTH,
  MAX_SPECTROGRAM_RENDER_HEIGHT,
  MAX_SPECTROGRAM_RENDER_WIDTH,
  MAX_VIEWPORT_WIDTH_SEC,
  MIN_TIME_WINDOW_SEC,
  SPECTROGRAM_PREVIEW_RENDER_SCALE,
  SPECTROGRAM_RENDER_SCALE,
} from "@shared/constants";
import { clamp } from "@shared/math";

import type { SystemThemeMode } from "./theme";
import { useElementSize } from "./use-element-size";
import type { SpectrogramWorkerClient } from "./worker-client";

export interface TimeRange {
  startSec: number;
  endSec: number;
}

export interface SpectrogramDocument {
  documentId: string;
  sampleRate: number;
  durationSec: number;
}

interface SpectrogramPaneProps {
  title: string;
  subtitle: string;
  document: SpectrogramDocument | null;
  isActive?: boolean;
  allowFullRender?: boolean;
  viewport: TimeRange;
  currentTime: number;
  themeMode: SystemThemeMode;
  workerClient: SpectrogramWorkerClient;
  onActivate?(): void;
  onSeek(nextTimeSec: number): void;
  onViewportChange(nextRange: TimeRange): void;
  emptyState?: {
    title: string;
    detail: string;
    actionLabel?: string;
    onAction?(): void;
  };
}

interface RenderImageState {
  imageData: ImageData;
  rangeKey: string;
  documentId: string;
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(1).padStart(4, "0")}`;
}

function getSpectrogramRenderDimension(
  size: number,
  scale: number,
  maxSize: number,
): number {
  return Math.max(1, Math.min(Math.floor(size * scale), maxSize));
}

function buildRangeKey(
  document: SpectrogramDocument | null,
  viewport: TimeRange,
  themeMode: SystemThemeMode,
): string {
  return [
    document?.documentId ?? "empty",
    viewport.startSec.toFixed(4),
    viewport.endSec.toFixed(4),
    themeMode,
  ].join(":");
}

export function SpectrogramPane({
  title,
  subtitle,
  document,
  isActive = false,
  allowFullRender = false,
  viewport,
  currentTime,
  themeMode,
  workerClient,
  onActivate,
  onSeek,
  onViewportChange,
  emptyState,
}: SpectrogramPaneProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const interactionRef = useRef<{
    pointerId: number;
    startX: number;
    startRange: TimeRange;
    dragged: boolean;
  } | null>(null);
  const previewRequestIdRef = useRef(0);
  const fullRequestIdRef = useRef(0);
  const [previewState, setPreviewState] = useState<RenderImageState | null>(null);
  const [fullState, setFullState] = useState<RenderImageState | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [isRenderingPreview, setIsRenderingPreview] = useState(false);
  const [isRenderingFull, setIsRenderingFull] = useState(false);
  const [hoverState, setHoverState] = useState<{ x: number; timeSec: number } | null>(null);
  const stageSize = useElementSize(stageRef.current);
  const displayWidth = Math.max(1, Math.floor(stageSize.width));
  const displayHeight = Math.max(1, Math.floor(stageSize.height));
  const previewWidth = getSpectrogramRenderDimension(
    displayWidth,
    SPECTROGRAM_PREVIEW_RENDER_SCALE,
    MAX_SPECTROGRAM_PREVIEW_RENDER_WIDTH,
  );
  const previewHeight = getSpectrogramRenderDimension(
    displayHeight,
    SPECTROGRAM_PREVIEW_RENDER_SCALE,
    MAX_SPECTROGRAM_PREVIEW_RENDER_HEIGHT,
  );
  const fullWidth = getSpectrogramRenderDimension(
    displayWidth,
    SPECTROGRAM_RENDER_SCALE,
    MAX_SPECTROGRAM_RENDER_WIDTH,
  );
  const fullHeight = getSpectrogramRenderDimension(
    displayHeight,
    SPECTROGRAM_RENDER_SCALE,
    MAX_SPECTROGRAM_RENDER_HEIGHT,
  );
  const spanSec = Math.max(viewport.endSec - viewport.startSec, MIN_TIME_WINDOW_SEC);
  const rangeKey = buildRangeKey(document, viewport, themeMode);
  const hasPersistedFullForDocument = Boolean(
    document && fullState?.documentId === document.documentId,
  );

  useEffect(() => {
    if (!document) {
      setPreviewState(null);
      setFullState(null);
      setRenderError(null);
      setIsRenderingPreview(false);
      setIsRenderingFull(false);
      return;
    }

    if (!allowFullRender && hasPersistedFullForDocument) {
      setIsRenderingPreview(false);
      return;
    }

    const requestId = ++previewRequestIdRef.current;
    let cancelled = false;
    setIsRenderingPreview(true);
    setRenderError(null);

    void workerClient
      .render({
        documentId: document.documentId,
        channelIndex: 0,
        width: previewWidth,
        height: previewHeight,
        startSec: viewport.startSec,
        endSec: viewport.endSec,
        minFreq: 0,
        maxFreq: document.sampleRate / 2,
        frequencyScale: "linear",
        themeMode,
        quality: "preview",
      })
      .then((imageData) => {
        if (cancelled || previewRequestIdRef.current !== requestId) {
          return;
        }

        setPreviewState({
          imageData,
          rangeKey,
          documentId: document.documentId,
        });
        setRenderError(null);
      })
      .catch((error) => {
        if (cancelled || previewRequestIdRef.current !== requestId) {
          return;
        }

        setRenderError(
          error instanceof Error
            ? error.message
            : "语谱图渲染失败，worker 没有返回可用结果。",
        );
      })
      .finally(() => {
        if (!cancelled && previewRequestIdRef.current === requestId) {
          setIsRenderingPreview(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    document,
    hasPersistedFullForDocument,
    allowFullRender,
    previewHeight,
    previewWidth,
    rangeKey,
    themeMode,
    viewport.endSec,
    viewport.startSec,
    workerClient,
  ]);

  useEffect(() => {
    if (!document || !allowFullRender) {
      setIsRenderingFull(false);
      return;
    }

    const requestId = ++fullRequestIdRef.current;
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      setIsRenderingFull(true);
      void workerClient
        .render({
          documentId: document.documentId,
          channelIndex: 0,
          width: fullWidth,
          height: fullHeight,
          startSec: viewport.startSec,
          endSec: viewport.endSec,
          minFreq: 0,
          maxFreq: document.sampleRate / 2,
          frequencyScale: "linear",
          themeMode,
          quality: "full",
        })
        .then((imageData) => {
          if (cancelled || fullRequestIdRef.current !== requestId) {
            return;
          }

          setFullState({
            imageData,
            rangeKey,
            documentId: document.documentId,
          });
          setRenderError(null);
        })
        .catch((error) => {
          if (cancelled || fullRequestIdRef.current !== requestId) {
            return;
          }

          setRenderError(
            error instanceof Error
              ? error.message
              : "语谱图渲染失败，worker 没有返回可用结果。",
          );
        })
        .finally(() => {
          if (!cancelled && fullRequestIdRef.current === requestId) {
            setIsRenderingFull(false);
          }
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [
    allowFullRender,
    document,
    fullHeight,
    fullWidth,
    rangeKey,
    themeMode,
    viewport.endSec,
    viewport.startSec,
    workerClient,
  ]);

  useEffect(() => {
    if (!allowFullRender) {
      fullRequestIdRef.current += 1;
      setIsRenderingFull(false);
    }
  }, [allowFullRender]);

  const currentDocumentId = document?.documentId ?? null;
  const reusableFullImage =
    fullState && fullState.documentId === currentDocumentId
      ? fullState.imageData
      : null;
  const reusablePreviewImage =
    previewState && previewState.documentId === currentDocumentId
      ? previewState.imageData
      : null;
  const displayedImage =
    fullState?.rangeKey === rangeKey
      ? fullState.imageData
      : !allowFullRender && reusableFullImage
        ? reusableFullImage
        : previewState?.rangeKey === rangeKey
          ? previewState.imageData
          : reusableFullImage ?? reusablePreviewImage;

  const markers = useMemo(() => {
    const count = 6;
    return Array.from({ length: count }, (_, index) => {
      const alpha = index / Math.max(count - 1, 1);
      const time = viewport.startSec + spanSec * alpha;
      return {
        x: displayWidth * alpha,
        label: formatTime(time),
      };
    });
  }, [displayWidth, spanSec, viewport.startSec]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || displayWidth <= 0 || displayHeight <= 0) {
      return;
    }

    const devicePixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(displayWidth * devicePixelRatio);
    canvas.height = Math.floor(displayHeight * devicePixelRatio);

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    context.clearRect(0, 0, displayWidth, displayHeight);
    context.fillStyle = themeMode === "dark" ? "#020202" : "#f8f5ee";
    context.fillRect(0, 0, displayWidth, displayHeight);

    if (displayedImage) {
      const bitmapCanvas = window.document.createElement("canvas");
      bitmapCanvas.width = displayedImage.width;
      bitmapCanvas.height = displayedImage.height;
      const bitmapContext = bitmapCanvas.getContext("2d");
      bitmapContext?.putImageData(displayedImage, 0, 0);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "medium";
      context.drawImage(bitmapCanvas, 0, 0, displayWidth, displayHeight);
    }

    context.strokeStyle =
      themeMode === "dark"
        ? "rgba(255, 255, 255, 0.12)"
        : "rgba(24, 24, 24, 0.12)";
    context.fillStyle =
      themeMode === "dark"
        ? "rgba(255, 255, 255, 0.86)"
        : "rgba(34, 34, 34, 0.82)";
    context.font = "11px 'IBM Plex Mono', monospace";
    context.textAlign = "center";

    for (const marker of markers) {
      context.beginPath();
      context.moveTo(marker.x + 0.5, 0);
      context.lineTo(marker.x + 0.5, displayHeight);
      context.stroke();
      context.fillText(marker.label, marker.x, displayHeight - 10);
    }

    if (document) {
      const clampedTime = clamp(currentTime, 0, document.durationSec);
      if (clampedTime >= viewport.startSec && clampedTime <= viewport.endSec) {
        const alpha = (clampedTime - viewport.startSec) / Math.max(spanSec, 1e-6);
        const x = alpha * displayWidth;
        context.strokeStyle =
          themeMode === "dark"
            ? "rgba(255, 255, 255, 0.98)"
            : "rgba(20, 20, 20, 0.98)";
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(x + 0.5, 0);
        context.lineTo(x + 0.5, displayHeight);
        context.stroke();
        context.lineWidth = 1;
      }
    }
  }, [
    currentTime,
    displayHeight,
    displayWidth,
    displayedImage,
    document,
    markers,
    spanSec,
    themeMode,
    viewport.endSec,
    viewport.startSec,
  ]);

  function clampRange(nextStart: number, nextSpan: number): TimeRange {
    if (!document) {
      return viewport;
    }

    const span = clamp(
      nextSpan,
      MIN_TIME_WINDOW_SEC,
      Math.min(document.durationSec, MAX_VIEWPORT_WIDTH_SEC),
    );
    const maxStart = Math.max(document.durationSec - span, 0);
    const startSec = clamp(nextStart, 0, maxStart);
    return {
      startSec,
      endSec: startSec + span,
    };
  }

  function seekFromClientX(clientX: number): void {
    if (!document || !stageRef.current) {
      return;
    }

    const rect = stageRef.current.getBoundingClientRect();
    const alpha = clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
    onSeek(viewport.startSec + spanSec * alpha);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    onActivate?.();
    if (!document) {
      return;
    }

    interactionRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startRange: viewport,
      dragged: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const interaction = interactionRef.current;
    if (!document || !stageRef.current) {
      return;
    }

    const rect = stageRef.current.getBoundingClientRect();
    const alpha = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
    setHoverState({
      x: alpha * displayWidth,
      timeSec: viewport.startSec + spanSec * alpha,
    });

    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }

    const width = Math.max(rect.width, 1);
    const deltaX = event.clientX - interaction.startX;
    if (Math.abs(deltaX) > 2) {
      interaction.dragged = true;
    }

    const rangeSpan = interaction.startRange.endSec - interaction.startRange.startSec;
    const deltaSec = (deltaX / width) * rangeSpan;
    onViewportChange(clampRange(interaction.startRange.startSec - deltaSec, rangeSpan));
  }

  function releaseInteraction(
    event: React.PointerEvent<HTMLDivElement>,
    shouldSeek: boolean,
  ): void {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) {
      return;
    }

    if (!interaction.dragged && shouldSeek) {
      seekFromClientX(event.clientX);
    }

    interactionRef.current = null;
    setHoverState(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>): void {
    if (!document || !stageRef.current) {
      return;
    }

    event.preventDefault();
    const rect = stageRef.current.getBoundingClientRect();
    const alpha = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
    const focusTime = viewport.startSec + spanSec * alpha;
    const nextSpan = spanSec * (event.deltaY > 0 ? 1.14 : 0.86);
    const nextStart = focusTime - nextSpan * alpha;
    onViewportChange(clampRange(nextStart, nextSpan));
  }

  const hasReusableImage = Boolean(reusableFullImage || reusablePreviewImage);
  const isLoading =
    !hasReusableImage &&
    (isRenderingPreview || (allowFullRender && isRenderingFull));

  return (
    <section className={`spectrogram-card ${isActive ? "spectrogram-card-active" : ""}`}>
      <header className="spectrogram-card-header">
        <div>
          {title && title !== subtitle ? <p className="eyebrow">{title}</p> : null}
          <h3>{subtitle}</h3>
        </div>
      </header>
      <div
        ref={stageRef}
        className="spectrogram-stage"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => releaseInteraction(event, true)}
        onPointerCancel={(event) => releaseInteraction(event, false)}
        onPointerLeave={() => setHoverState(null)}
        onWheel={handleWheel}
      >
        {document ? (
          <>
            <canvas ref={canvasRef} className="spectrogram-canvas" />
            {hoverState ? (
              <div
                className="spectrogram-tooltip"
                style={{
                  left: `${clamp(hoverState.x, 24, Math.max(displayWidth - 24, 24))}px`,
                }}
              >
                {formatTime(hoverState.timeSec)}
              </div>
            ) : null}
            {renderError ? (
              <div className="spectrogram-empty">
                <strong>语谱图渲染失败</strong>
                <p>{renderError}</p>
              </div>
            ) : isLoading && !displayedImage ? (
              <div className="spectrogram-overlay-message">正在渲染语谱图…</div>
            ) : null}
          </>
        ) : emptyState ? (
          <div className="spectrogram-empty">
            <strong>{emptyState.title}</strong>
            <p>{emptyState.detail}</p>
            {emptyState.actionLabel && emptyState.onAction ? (
              <button className="action-button" onClick={emptyState.onAction}>
                {emptyState.actionLabel}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <footer className="spectrogram-card-footer">
        <span>{document ? `${formatTime(viewport.startSec)} - ${formatTime(viewport.endSec)}` : "--"}</span>
        <span>{document ? `0-${Math.round(document.sampleRate / 1000)} kHz` : ""}</span>
      </footer>
    </section>
  );
}
