import { useEffect, useState, type CSSProperties } from "react";

import type { UiThemePreference } from "@shared/contracts";

export type SystemThemeMode = "light" | "dark";

function readSystemTheme(): SystemThemeMode {
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }

  return "light";
}

export function useSystemTheme(): SystemThemeMode {
  const [mode, setMode] = useState<SystemThemeMode>(() => readSystemTheme());

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const syncTheme = () => setMode(mediaQuery.matches ? "dark" : "light");
    syncTheme();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", syncTheme);
      return () => mediaQuery.removeEventListener("change", syncTheme);
    }

    mediaQuery.addListener(syncTheme);
    return () => mediaQuery.removeListener(syncTheme);
  }, []);

  return mode;
}

export function resolveUiThemeMode(
  preference: UiThemePreference,
  systemTheme: SystemThemeMode,
): SystemThemeMode {
  return preference === "system" ? systemTheme : preference;
}

export function buildUiThemeStyle(mode: SystemThemeMode): CSSProperties {
  if (mode === "dark") {
    return {
      "--app-bg": "#060606",
      "--body-top": "rgba(255, 255, 255, 0.035)",
      "--body-radial": "rgba(255, 255, 255, 0.05)",
      "--panel-bg": "rgba(14, 14, 14, 0.84)",
      "--panel-bg-strong": "rgba(20, 20, 20, 0.96)",
      "--panel-border": "rgba(255, 255, 255, 0.09)",
      "--canvas-border": "rgba(255, 255, 255, 0.11)",
      "--text-primary": "#f5f5f2",
      "--text-secondary": "#cbcbc4",
      "--text-tertiary": "#8e8e87",
      "--accent": "#f1f1ec",
      "--accent-soft": "rgba(255, 255, 255, 0.08)",
      "--accent-strong": "#ffffff",
      "--success-soft": "rgba(255, 255, 255, 0.1)",
      "--warning-soft": "rgba(255, 255, 255, 0.12)",
      "--error-soft": "rgba(255, 255, 255, 0.12)",
      "--shadow": "0 18px 32px rgba(0, 0, 0, 0.28)",
      "--theme-switcher-thumb": "#f5f5f2",
      "--theme-switcher-thumb-shadow": "0 8px 18px rgba(0, 0, 0, 0.22)",
      colorScheme: "dark",
    } as CSSProperties;
  }

  return {
    "--app-bg": "#efebe4",
    "--body-top": "rgba(255, 255, 255, 0.84)",
    "--body-radial": "rgba(255, 255, 255, 0.92)",
    "--panel-bg": "rgba(253, 251, 247, 0.76)",
    "--panel-bg-strong": "rgba(255, 255, 255, 0.94)",
    "--panel-border": "rgba(28, 35, 49, 0.1)",
    "--canvas-border": "rgba(20, 25, 36, 0.14)",
    "--text-primary": "#302920",
    "--text-secondary": "#665b50",
    "--text-tertiary": "#8d8174",
    "--accent": "#2c2a27",
    "--accent-soft": "rgba(32, 32, 32, 0.08)",
    "--accent-strong": "#171512",
    "--success-soft": "rgba(24, 24, 24, 0.08)",
    "--warning-soft": "rgba(24, 24, 24, 0.1)",
    "--error-soft": "rgba(24, 24, 24, 0.1)",
    "--shadow": "0 12px 28px rgba(32, 24, 15, 0.08)",
    "--theme-switcher-thumb": "#ffffff",
    "--theme-switcher-thumb-shadow": "0 8px 20px rgba(27, 23, 18, 0.08)",
    colorScheme: "light",
  } as CSSProperties;
}
