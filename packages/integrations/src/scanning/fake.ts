import type { MalwareScanner, ScanResult } from "./types";

/**
 * The EICAR test file: a harmless, industry-standard string every real engine detects. The fake recognises it (anywhere
 * in the first 128 bytes, with optional trailing whitespace, as the standard specifies) so the quarantine, rejection
 * and audit paths can be exercised end to end without any malware. Everything else is "clean" from a fake, which is
 * why the status stays `fake` and why real candidate files wait for a real engine.
 */
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export class FakeMalwareScanner implements MalwareScanner {
  readonly id = "fake_scanner";
  readonly status = "fake" as const;
  /** Tests may force an engine failure to prove the file stays quarantined. */
  failNext = false;
  async scan(bytes: Uint8Array): Promise<ScanResult> {
    if (this.failNext) {
      this.failNext = false;
      return { verdict: "error", engine: this.id, detail: "scanner unavailable" };
    }
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 128));
    if (head.includes(EICAR)) return { verdict: "infected", engine: this.id, signature: "EICAR-Test-File" };
    return { verdict: "clean", engine: this.id };
  }
}

export { EICAR as EICAR_TEST_STRING };
