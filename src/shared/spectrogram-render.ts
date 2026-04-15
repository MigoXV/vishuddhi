import FFT from "fft.js";

import {
  MAX_SPECTROGRAM_CACHE_ENTRIES,
  SPECTROGRAM_FFT_SIZE,
  SPECTROGRAM_PREVIEW_FFT_SIZE,
  SPECTROGRAM_PREVIEW_WINDOW_SIZE,
  SPECTROGRAM_WINDOW_SIZE,
} from "./constants";
import type { FrequencyScale } from "./contracts";
import { clamp, lerp } from "./math";

export type SpectrogramThemeMode = "light" | "dark";
export type SpectrogramRenderQuality = "preview" | "full";

export interface SpectrogramDocumentData {
  channelData: Int8Array[];
  sampleRate: number;
}

export interface SpectrogramRenderRequest {
  width: number;
  height: number;
  startSec: number;
  endSec: number;
  minFreq: number;
  maxFreq: number;
  frequencyScale: FrequencyScale;
  themeMode: SpectrogramThemeMode;
  quality: SpectrogramRenderQuality;
}

interface RenderProfile {
  fftSize: number;
  windowSize: number;
  rowBinStep: number;
  columnStride: number;
  noiseSampleStride: number;
}

interface RenderRuntime {
  fft: FFT;
  hannWindow: Float32Array;
}

const RENDER_PROFILES: Record<SpectrogramRenderQuality, RenderProfile> = {
  preview: {
    fftSize: SPECTROGRAM_PREVIEW_FFT_SIZE,
    windowSize: SPECTROGRAM_PREVIEW_WINDOW_SIZE,
    rowBinStep: 4,
    columnStride: 2,
    noiseSampleStride: 8,
  },
  full: {
    fftSize: SPECTROGRAM_FFT_SIZE,
    windowSize: SPECTROGRAM_WINDOW_SIZE,
    rowBinStep: 2,
    columnStride: 1,
    noiseSampleStride: 4,
  },
};

const runtimeByProfile = new Map<SpectrogramRenderQuality, RenderRuntime>();

const DARK_SPECTROGRAM_STOPS = [
  { at: 0, color: [3, 3, 3] as const },
  { at: 0.16, color: [18, 18, 18] as const },
  { at: 0.34, color: [52, 52, 52] as const },
  { at: 0.56, color: [112, 112, 112] as const },
  { at: 0.78, color: [182, 182, 182] as const },
  { at: 1, color: [248, 248, 246] as const },
];

const LIGHT_SPECTROGRAM_STOPS = [
  { at: 0, color: [249, 247, 242] as const },
  { at: 0.18, color: [228, 225, 218] as const },
  { at: 0.36, color: [188, 184, 176] as const },
  { at: 0.58, color: [132, 128, 121] as const },
  { at: 0.8, color: [72, 69, 65] as const },
  { at: 1, color: [18, 18, 18] as const },
];

function getRenderProfile(quality: SpectrogramRenderQuality): RenderProfile {
  return RENDER_PROFILES[quality];
}

function getRuntime(quality: SpectrogramRenderQuality): RenderRuntime {
  const existing = runtimeByProfile.get(quality);
  if (existing) {
    return existing;
  }

  const profile = getRenderProfile(quality);
  const hannWindow = new Float32Array(profile.windowSize).map((_, index) => {
    return 0.5 * (1 - Math.cos((2 * Math.PI * index) / (profile.windowSize - 1)));
  });
  const runtime = {
    fft: new FFT(profile.fftSize),
    hannWindow,
  };
  runtimeByProfile.set(quality, runtime);
  return runtime;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = clamp(
    Math.floor((sorted.length - 1) * ratio),
    0,
    sorted.length - 1,
  );
  return sorted[index];
}

export function cacheSpectrogramResult(
  cache: Map<string, Uint8ClampedArray>,
  key: string,
  value: Uint8ClampedArray,
): Uint8ClampedArray {
  if (cache.has(key)) {
    cache.delete(key);
  }

  cache.set(key, value);
  while (cache.size > MAX_SPECTROGRAM_CACHE_ENTRIES) {
    const firstKey = cache.keys().next().value as string | undefined;
    if (!firstKey) {
      break;
    }

    cache.delete(firstKey);
  }

  return value;
}

function frequencyForRow(
  row: number,
  height: number,
  minFreq: number,
  maxFreq: number,
  scale: FrequencyScale,
): number {
  const alpha = 1 - row / Math.max(height - 1, 1);
  if (scale === "log") {
    const safeMin = Math.max(minFreq, 1);
    const minLog = Math.log10(safeMin);
    const maxLog = Math.log10(Math.max(maxFreq, safeMin + 1));
    return 10 ** lerp(minLog, maxLog, alpha);
  }

  return lerp(minFreq, maxFreq, alpha);
}

function createFrame(
  channelData: Int8Array,
  centerSample: number,
  quality: SpectrogramRenderQuality,
): Float32Array {
  const profile = getRenderProfile(quality);
  const runtime = getRuntime(quality);
  const frame = new Float32Array(profile.windowSize);
  const half = Math.floor(profile.windowSize / 2);

  for (let index = 0; index < profile.windowSize; index += 1) {
    const sampleIndex = centerSample - half + index;
    const sample =
      sampleIndex >= 0 && sampleIndex < channelData.length
        ? channelData[sampleIndex] / 127
        : 0;
    frame[index] = sample * runtime.hannWindow[index];
  }

  return frame;
}

function magnitudesForFrame(
  frame: Float32Array,
  quality: SpectrogramRenderQuality,
): Float32Array {
  const profile = getRenderProfile(quality);
  const runtime = getRuntime(quality);
  const complex = runtime.fft.createComplexArray();
  const magnitudes = new Float32Array(profile.fftSize / 2);

  runtime.fft.realTransform(complex, frame);
  runtime.fft.completeSpectrum(complex);

  for (let index = 0; index < magnitudes.length; index += 1) {
    const real = complex[index * 2];
    const imaginary = complex[index * 2 + 1];
    const magnitude = Math.sqrt(real * real + imaginary * imaginary);
    magnitudes[index] = 20 * Math.log10(magnitude + 1e-6);
  }

  return magnitudes;
}

function colorize(
  value: number,
  minValue: number,
  maxValue: number,
  themeMode: SpectrogramThemeMode,
): [number, number, number, number] {
  const normalized = clamp(
    (value - minValue) / Math.max(maxValue - minValue, 1e-6),
    0,
    1,
  );
  const boosted = normalized ** 0.42;
  const palette =
    themeMode === "dark" ? DARK_SPECTROGRAM_STOPS : LIGHT_SPECTROGRAM_STOPS;

  for (let index = 1; index < palette.length; index += 1) {
    const previous = palette[index - 1];
    const next = palette[index];
    if (boosted > next.at) {
      continue;
    }

    const alpha = clamp(
      (boosted - previous.at) / Math.max(next.at - previous.at, 1e-6),
      0,
      1,
    );
    const red = Math.round(lerp(previous.color[0], next.color[0], alpha));
    const green = Math.round(lerp(previous.color[1], next.color[1], alpha));
    const blue = Math.round(lerp(previous.color[2], next.color[2], alpha));
    return [red, green, blue, 255];
  }

  const brightest = palette[palette.length - 1].color;
  return [brightest[0], brightest[1], brightest[2], 255];
}

function estimateNoiseFloor(columns: Float32Array[]): Float32Array {
  const binCount = columns[0]?.length ?? 0;
  const floor = new Float32Array(binCount);
  const mean = new Float32Array(binCount);
  floor.fill(Number.POSITIVE_INFINITY);

  for (const column of columns) {
    for (let binIndex = 0; binIndex < binCount; binIndex += 1) {
      const value = column[binIndex];
      floor[binIndex] = Math.min(floor[binIndex], value);
      mean[binIndex] += value;
    }
  }

  for (let binIndex = 0; binIndex < binCount; binIndex += 1) {
    const blended = lerp(
      floor[binIndex],
      mean[binIndex] / Math.max(columns.length, 1),
      0.16,
    );
    floor[binIndex] = Number.isFinite(blended) ? blended : 0;
  }

  const smoothed = new Float32Array(binCount);
  for (let binIndex = 0; binIndex < binCount; binIndex += 1) {
    let weightedSum = 0;
    let totalWeight = 0;
    for (let offset = -2; offset <= 2; offset += 1) {
      const sampleIndex = clamp(binIndex + offset, 0, binCount - 1);
      const weight = offset === 0 ? 0.4 : Math.abs(offset) === 1 ? 0.2 : 0.1;
      weightedSum += floor[sampleIndex] * weight;
      totalWeight += weight;
    }
    smoothed[binIndex] = weightedSum / Math.max(totalWeight, 1e-6);
  }

  return smoothed;
}

function createRowBinMap(
  request: SpectrogramRenderRequest,
  binCount: number,
  nyquist: number,
): Uint16Array {
  const rowBinMap = new Uint16Array(request.height);
  const profile = getRenderProfile(request.quality);

  for (let row = 0; row < request.height; row += 1) {
    const frequency = frequencyForRow(
      row,
      request.height,
      request.minFreq,
      request.maxFreq,
      request.frequencyScale,
    );
    const normalizedFrequency = clamp(frequency / nyquist, 0, 1);
    const rawIndex = Math.round(normalizedFrequency * Math.max(binCount - 1, 0));
    const steppedIndex =
      request.quality === "preview"
        ? Math.floor(rawIndex / profile.rowBinStep) * profile.rowBinStep
        : rawIndex;
    rowBinMap[row] = clamp(steppedIndex, 0, Math.max(binCount - 1, 0));
  }

  return rowBinMap;
}

export function renderSpectrogramPixels(
  document: SpectrogramDocumentData,
  request: SpectrogramRenderRequest,
  channelIndex: number,
): Uint8ClampedArray {
  const channel = document.channelData[channelIndex];
  const pixels = new Uint8ClampedArray(request.width * request.height * 4);
  const sampleRate = document.sampleRate;
  const nyquist = sampleRate / 2;
  const width = Math.max(request.width, 1);
  const height = Math.max(request.height, 1);
  const timeSpan = Math.max(request.endSec - request.startSec, 1e-3);
  const profile = getRenderProfile(request.quality);

  const columnCount = Math.max(1, Math.ceil(width / profile.columnStride));
  const columns = Array.from({ length: columnCount }, (_, index) => {
    const x =
      request.quality === "preview"
        ? Math.min(index * profile.columnStride, width - 1)
        : index;
    const time = request.startSec + (x / Math.max(width - 1, 1)) * timeSpan;
    const centerSample = Math.round(time * sampleRate);
    return magnitudesForFrame(
      createFrame(channel, centerSample, request.quality),
      request.quality,
    );
  });
  const noiseFloor = estimateNoiseFloor(columns);
  const sampledValues: number[] = [];
  const enhancedColumns = columns.map((column, columnIndex) => {
    const enhanced = new Float32Array(column.length);
    for (let binIndex = 0; binIndex < column.length; binIndex += 1) {
      const frequency = (binIndex / Math.max(column.length - 1, 1)) * nyquist;
      const voiceWeight =
        frequency >= 180 && frequency <= 4200
          ? 1.12
          : frequency >= 90 && frequency <= 6200
            ? 1.04
            : 1;
      const enhancedValue =
        (column[binIndex] - noiseFloor[binIndex] * 0.82) * voiceWeight;
      enhanced[binIndex] = enhancedValue;
      if (
        columnIndex % profile.noiseSampleStride === 0 &&
        binIndex % profile.rowBinStep === 0
      ) {
        sampledValues.push(enhancedValue);
      }
    }
    return enhanced;
  });
  const lowerBound = percentile(sampledValues, 0.02);
  const upperBound = Math.max(
    percentile(sampledValues, 0.985),
    lowerBound + 1.5,
  );
  const rowBinMap = createRowBinMap(request, profile.fftSize / 2, nyquist);

  for (let row = 0; row < height; row += 1) {
    const binIndex = rowBinMap[row];

    for (let x = 0; x < width; x += 1) {
      const sampleIndex =
        request.quality === "preview"
          ? clamp(
              Math.floor(x / profile.columnStride),
              0,
              enhancedColumns.length - 1,
            )
          : x;
      const [red, green, blue, alpha] = colorize(
        enhancedColumns[sampleIndex][binIndex],
        lowerBound,
        upperBound,
        request.themeMode,
      );
      const offset = (row * width + x) * 4;
      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = alpha;
    }
  }

  return pixels;
}
