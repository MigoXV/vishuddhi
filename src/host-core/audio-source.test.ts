import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { describe, expect, it, afterEach } from "vitest";

import type { AppSettings } from "@shared/contracts";

import {
  buildPreviewWav,
  deriveResultPath,
  flattenEntries,
  scanWorkspace,
} from "./audio-source";
import { wrapPcmAsWav } from "./wav";

const settings: AppSettings = {
  grpcAddress: "localhost:7860",
  pcmSampleRate: 9600,
  datSampleRate: 9600,
  uiThemePreference: "system",
  sourceHotkey: "r",
  resultHotkey: "d",
};

const createdDirectories: string[] = [];

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vishuddhi-audio-source-"));
  createdDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("scanWorkspace", () => {
  it("indexes source files, skips generated results, and flags unsupported wav files", async () => {
    const root = await createWorkspace();
    const nested = path.join(root, "nested");
    await mkdir(nested, { recursive: true });

    const pcmPath = path.join(root, "alpha.pcm");
    const pcmBytes = Buffer.alloc(9600 * 2, 1);
    await writeFile(pcmPath, pcmBytes);

    const pcmResultPath = deriveResultPath(pcmPath);
    await writeFile(
      pcmResultPath,
      wrapPcmAsWav(pcmBytes, {
        sampleRate: 9600,
        channelCount: 1,
        bitsPerSample: 16,
      }),
    );

    await writeFile(path.join(nested, "beta.dat"), Buffer.alloc(4800 * 2, 2));
    await writeFile(
      path.join(root, "mono.wav"),
      wrapPcmAsWav(Buffer.alloc(3200), {
        sampleRate: 16000,
        channelCount: 1,
        bitsPerSample: 16,
      }),
    );
    await writeFile(
      path.join(root, "stereo.wav"),
      wrapPcmAsWav(Buffer.alloc(3200), {
        sampleRate: 16000,
        channelCount: 2,
        bitsPerSample: 16,
      }),
    );

    const tree = await scanWorkspace(root, settings);
    const entries = flattenEntries(tree);

    expect(entries.map((entry) => path.basename(entry.sourcePath)).sort()).toEqual([
      "alpha.pcm",
      "beta.dat",
      "mono.wav",
      "stereo.wav",
    ]);

    const pcmEntry = entries.find((entry) => entry.sourcePath === pcmPath);
    expect(pcmEntry?.resultPath).toBe(pcmResultPath);
    expect(pcmEntry?.resultStatus).toBe("done");
    expect(pcmEntry?.audioMeta.sampleRate).toBe(9600);

    const unsupportedEntry = entries.find((entry) =>
      entry.sourcePath.endsWith("stereo.wav"),
    );
    expect(unsupportedEntry?.denoiseEligibility.supported).toBe(false);
    expect(unsupportedEntry?.resultStatus).toBe("unsupported");
  });

  it("wraps raw preview audio as wav for renderer playback", async () => {
    const root = await createWorkspace();
    const pcmPath = path.join(root, "preview.pcm");
    await writeFile(pcmPath, Buffer.alloc(9600 * 2, 5));

    const previewBytes = await buildPreviewWav(pcmPath, settings);
    expect(previewBytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(previewBytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
  });
});
