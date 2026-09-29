import type { AdapterStatus } from "../types";

/** The result of a malware scan of one file. `error` means the scan could not run; the file stays quarantined. */
export type ScanResult = { verdict: "clean" | "infected" | "error"; engine: string; signature?: string; detail?: string };

/**
 * Malware scanning of quarantined uploads (founder decision 2). A real engine is a real-data blocker, not a staging
 * blocker: the fake below stands in until one is authorized, and it is never reported as anything but `fake`.
 */
export interface MalwareScanner {
  readonly id: string;
  readonly status: AdapterStatus;
  scan(bytes: Uint8Array, meta: { filename: string; mime: string }): Promise<ScanResult>;
  /** A real engine answers whether it is reachable (the boot check calls this); the fake has nothing to check. Never throws. */
  check?(): Promise<AdapterStatus>;
}
