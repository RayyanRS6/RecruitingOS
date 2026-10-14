import { raiseAlertOnce, resolveAlertsOfKind } from "@ros/core";
import type { Db } from "@ros/db";

/**
 * The real-data gate for résumé scanning (docs/readiness/20 blocker 8, OPS item 4): the fake scanner calls everything
 * but the test string clean, so a production worker running it warns and raises one `scanner.fake` alert, standing
 * until a person resolves it. Raised by the worker only, the one process that scans (the app never opens a quarantined
 * file), and never outside production. A failure to raise is logged, never fatal to the boot.
 */
export async function checkScannerForProduction(db: Db, input: { nodeEnv: string; role: string; scannerStatus: string; scannerId: string }): Promise<{ raised: boolean }> {
  if (input.nodeEnv !== "production" || input.role !== "worker") return { raised: false };
  if (input.scannerStatus !== "fake") {
    // a real engine is in use: an alert from before it was set up is over, so a later lapse is a new one
    await resolveAlertsOfKind(db, "scanner.fake", { reason: `a real malware engine (${input.scannerId}) is in use` }).catch((err) => console.warn(`[scanner] could not resolve the earlier alert: ${err instanceof Error ? err.message : String(err)}`));
    return { raised: false };
  }
  console.warn("[scanner] production is running with the fake malware scanner; real candidate files need SCAN_PROVIDER=clamav (docs/runbooks/resume-storage.md)");
  try {
    const alert = await raiseAlertOnce(db, { kind: "scanner.fake", severity: "high", title: "Résumé scanning is the fake engine", body: "SCAN_PROVIDER is fake: uploaded files are only checked by type and signature, not for malware. Real candidate files must wait for a real engine. Run ClamAV on Railway and set SCAN_PROVIDER=clamav with CLAMAV_HOST (docs/runbooks/resume-storage.md), then resolve this alert.", details: { provider: input.scannerId } });
    return { raised: alert.created };
  } catch (err) {
    console.warn(`[scanner] could not raise the alert: ${err instanceof Error ? err.message : String(err)}`);
    return { raised: false };
  }
}
