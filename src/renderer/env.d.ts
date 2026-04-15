/// <reference types="vite/client" />

import type { HostBridge } from "@shared/contracts";

declare global {
  interface Window {
    vishuddhiHost?: HostBridge;
  }
}

export {};
