import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { app } from "electron";

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
  return path.join(app.getPath("userData"), "settings.json");
}

function normalizeHotkey(
  value: string | null | undefined,
  fallback: string,
): string {
  const nextValue = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9]$/.test(nextValue) ? nextValue : fallback;
}

function normalizeSettings(value: Partial<AppSettings> | null | undefined): AppSettings {
  const sourceHotkey = normalizeHotkey(
    value?.sourceHotkey,
    DEFAULT_SETTINGS.sourceHotkey,
  );
  const resultHotkeyCandidate = normalizeHotkey(
    value?.resultHotkey,
    DEFAULT_SETTINGS.resultHotkey,
  );

  return {
    grpcAddress:
      typeof value?.grpcAddress === "string" && value.grpcAddress.trim()
        ? value.grpcAddress.trim()
        : DEFAULT_SETTINGS.grpcAddress,
    pcmSampleRate:
      typeof value?.pcmSampleRate === "number" && value.pcmSampleRate > 0
        ? Math.round(value.pcmSampleRate)
        : DEFAULT_SETTINGS.pcmSampleRate,
    datSampleRate:
      typeof value?.datSampleRate === "number" && value.datSampleRate > 0
        ? Math.round(value.datSampleRate)
        : DEFAULT_SETTINGS.datSampleRate,
    uiThemePreference:
      value?.uiThemePreference === "light" || value?.uiThemePreference === "dark"
        ? value.uiThemePreference
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

export class SessionStore {
  private cache: PersistedState | null = null;

  async load(): Promise<PersistedState> {
    if (this.cache) {
      return this.cache;
    }

    const statePath = getStatePath();
    try {
      const payload = JSON.parse(await readFile(statePath, "utf8")) as Partial<PersistedState>;
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

  async getSettings(): Promise<AppSettings> {
    return (await this.load()).settings;
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

export function getDefaultSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS };
}
