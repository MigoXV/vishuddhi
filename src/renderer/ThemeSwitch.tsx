import type { CSSProperties } from "react";

import type { UiThemePreference } from "@shared/contracts";

const OPTIONS: Array<{ value: UiThemePreference; label: string }> = [
  { value: "system", label: "系统" },
  { value: "light", label: "白" },
  { value: "dark", label: "黑" },
];

interface ThemeSwitchProps {
  value: UiThemePreference;
  onChange(nextValue: UiThemePreference): void;
  compact?: boolean;
}

export function ThemeSwitch({
  value,
  onChange,
  compact = false,
}: ThemeSwitchProps) {
  const currentIndex = Math.max(
    OPTIONS.findIndex((option) => option.value === value),
    0,
  );

  return (
    <div
      className={`theme-switch ${compact ? "compact" : ""}`}
      style={{ "--theme-switch-index": currentIndex } as CSSProperties}
      role="tablist"
      aria-label="主题切换"
    >
      <div className="theme-switch-thumb" aria-hidden="true" />
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`theme-switch-option ${value === option.value ? "active" : ""}`}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
