import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

import type { AppSettings, BootstrapState } from "@shared/contracts";
import {
  DEFAULT_GRPC_ADDRESS,
  DEFAULT_RAW_SAMPLE_RATE,
  DEFAULT_RESULT_HOTKEY,
  DEFAULT_SOURCE_HOTKEY,
} from "@shared/constants";

interface PersistedState extends BootstrapState {}

const DEFAULT_SETTINGS: AppSettings = {
  grpcAddress: DEFAULT_GRPC_ADDRESS,
  pcmSampleRate: DEFAULT_RAW_SAMPLE_RATE,
  datSampleRate: DEFAULT_RAW_SAMPLE_RATE,
  uiThemePreference: "system",
  sourceHotkey: DEFAULT_SOURCE_HOTKEY,
  resultHotkey: DEFAULT_RESULT_HOTKEY,
};

function getStatePath(): string {
  return path.join(homedir(), ".config", "vishuddhi", "settings.json");
}

function normalizeHotkey(
  value: string | null | undefined,
  fallback: string,
): string {
  const nextValue = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9]$/.test(nextValue) ? nextValue : fallback;
}

function normalizeSettings(settings: Partial<AppSettings> | null | undefined): AppSettings {
  const sourceHotkey = normalizeHotkey(
    settings?.sourceHotkey,
    DEFAULT_SETTINGS.sourceHotkey,
  );
  const resultHotkeyCandidate = normalizeHotkey(
    settings?.resultHotkey,
    DEFAULT_SETTINGS.resultHotkey,
  );

  return {
    grpcAddress:
      typeof settings?.grpcAddress === "string" && settings.grpcAddress.trim()
        ? settings.grpcAddress.trim()
        : DEFAULT_SETTINGS.grpcAddress,
    pcmSampleRate:
      typeof settings?.pcmSampleRate === "number" && settings.pcmSampleRate > 0
        ? Math.round(settings.pcmSampleRate)
        : DEFAULT_SETTINGS.pcmSampleRate,
    datSampleRate:
      typeof settings?.datSampleRate === "number" && settings.datSampleRate > 0
        ? Math.round(settings.datSampleRate)
        : DEFAULT_SETTINGS.datSampleRate,
    uiThemePreference:
      settings?.uiThemePreference === "light" || settings?.uiThemePreference === "dark"
        ? settings.uiThemePreference
        : DEFAULT_SETTINGS.uiThemePreference,
    sourceHotkey,
    resultHotkey:
      resultHotkeyCandidate === sourceHotkey
        ? DEFAULT_SETTINGS.resultHotkey
        : resultHotkeyCandidate,
  };
}

async function writeState(state: PersistedState): Promise<void> {
  const statePath = getStatePath();
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

export class HostServiceStore {
  private cache: PersistedState | null = null;

  async load(): Promise<PersistedState> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const payload = JSON.parse(await readFile(getStatePath(), "utf8")) as Partial<PersistedState>;
      this.cache = {
        settings: normalizeSettings(payload.settings),
        lastWorkspacePath:
          typeof payload.lastWorkspacePath === "string" && payload.lastWorkspacePath
            ? payload.lastWorkspacePath
            : null,
      };
    } catch {
      this.cache = {
        settings: DEFAULT_SETTINGS,
        lastWorkspacePath: null,
      };
    }

    return this.cache;
  }

  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    const state = await this.load();
    state.settings = normalizeSettings(settings);
    await writeState(state);
    return state.settings;
  }

  async saveLastWorkspacePath(lastWorkspacePath: string | null): Promise<void> {
    const state = await this.load();
    state.lastWorkspacePath = lastWorkspacePath;
    await writeState(state);
  }
}
