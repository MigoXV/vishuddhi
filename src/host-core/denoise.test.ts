import path from "node:path";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppSettings } from "@shared/contracts";

vi.mock("./grpc", () => ({
  denoiseAudio: vi.fn(async (_address: string, audioIn: Buffer) => Buffer.from(audioIn)),
}));

import { DENOISE_SEGMENT_DURATION_SEC } from "@shared/constants";

import { deriveResultPath } from "./audio-source";
import { runBatchDenoise, runDenoiseForSource } from "./denoise";
import { denoiseAudio } from "./grpc";
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
  const root = await mkdtemp(path.join(tmpdir(), "vishuddhi-denoise-"));
  createdDirectories.push(root);
  return root;
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    createdDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("runBatchDenoise", () => {
  it("skips existing results and generates missing ones recursively", async () => {
    const root = await createWorkspace();
    const childDir = path.join(root, "child");
    await mkdir(childDir, { recursive: true });
    const firstSource = path.join(root, "alpha.pcm");
    const secondSource = path.join(childDir, "beta.pcm");
    await writeFile(firstSource, Buffer.alloc(9600 * 2, 1));
    await writeFile(secondSource, Buffer.alloc(9600 * 2, 2), { flag: "w", mode: 0o644 });

    await writeFile(
      deriveResultPath(firstSource),
      wrapPcmAsWav(Buffer.alloc(9600 * 2, 1), {
        sampleRate: 9600,
        channelCount: 1,
        bitsPerSample: 16,
      }),
    );

    const result = await runBatchDenoise(root, root, settings, { force: false });

    expect(result.total).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.completed).toBe(1);
    expect(result.failures).toEqual([]);
    await expect(access(deriveResultPath(secondSource))).resolves.toBeUndefined();
  });

  it("sends long audio to grpc in 30 second chunks", async () => {
    const root = await createWorkspace();
    const source = path.join(root, "long.pcm");
    const sampleRate = 9600;
    const durationSec = DENOISE_SEGMENT_DURATION_SEC * 2 + 5;
    await writeFile(source, Buffer.alloc(sampleRate * durationSec * 2, 7));

    await runDenoiseForSource(source, settings, { force: true });

    const denoiseAudioMock = vi.mocked(denoiseAudio);
    expect(denoiseAudioMock).toHaveBeenCalledTimes(3);
    expect(denoiseAudioMock.mock.calls[0]?.[1]).toHaveLength(
      sampleRate * DENOISE_SEGMENT_DURATION_SEC * 2,
    );
    expect(denoiseAudioMock.mock.calls[2]?.[1]).toHaveLength(sampleRate * 5 * 2);
  });
});
