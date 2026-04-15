import { describe, expect, it } from "vitest";

import { renderSpectrogramPixels } from "./spectrogram-render";

describe("renderSpectrogramPixels", () => {
  it("returns visible pixels for a simple tone", () => {
    const sampleRate = 16_000;
    const channelData = new Int8Array(sampleRate);
    for (let index = 0; index < channelData.length; index += 1) {
      channelData[index] = Math.round(
        Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 96,
      );
    }

    const pixels = renderSpectrogramPixels(
      {
        channelData: [channelData],
        sampleRate,
      },
      {
        width: 96,
        height: 64,
        startSec: 0,
        endSec: 1,
        minFreq: 0,
        maxFreq: sampleRate / 2,
        frequencyScale: "linear",
        themeMode: "dark",
        quality: "full",
      },
      0,
    );

    expect(pixels).toHaveLength(96 * 64 * 4);
    expect(pixels.some((value, index) => index % 4 !== 3 && value > 0)).toBe(true);
  });

  it("supports preview quality with lower dimensions", () => {
    const sampleRate = 16_000;
    const channelData = new Int8Array(sampleRate);
    for (let index = 0; index < channelData.length; index += 1) {
      channelData[index] = Math.round(
        Math.sin((2 * Math.PI * 220 * index) / sampleRate) * 72,
      );
    }

    const pixels = renderSpectrogramPixels(
      {
        channelData: [channelData],
        sampleRate,
      },
      {
        width: 48,
        height: 24,
        startSec: 0,
        endSec: 1,
        minFreq: 0,
        maxFreq: sampleRate / 2,
        frequencyScale: "linear",
        themeMode: "dark",
        quality: "preview",
      },
      0,
    );

    expect(pixels).toHaveLength(48 * 24 * 4);
    expect(pixels.some((value, index) => index % 4 !== 3 && value > 0)).toBe(true);
  });
});
