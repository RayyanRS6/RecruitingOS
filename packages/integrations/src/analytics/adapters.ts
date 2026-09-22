import { redactObject } from "@ros/contracts";
import type { AnalyticsAdapter, ProductEvent } from "./types";

/** Development and tests: records events in memory. */
export class FakeAnalyticsAdapter implements AnalyticsAdapter {
  readonly id = "fake-analytics";
  readonly status = "fake" as const;
  readonly captured: ProductEvent[] = [];
  async capture(event: ProductEvent): Promise<void> {
    this.captured.push(event);
  }
}

/**
 * PostHog, server side only (never a browser script on candidate pages). Live when a project key is configured.
 * The distinct id is the keyed subject reference; no person profile is created for candidates.
 */
export class PostHogServerAdapter implements AnalyticsAdapter {
  readonly id = "posthog";
  readonly status: "live" | "not_connected";
  constructor(private key: string | undefined, private host = "https://us.i.posthog.com", private fetchImpl: typeof fetch = fetch) {
    this.status = key ? "live" : "not_connected";
  }
  async capture(event: ProductEvent): Promise<void> {
    if (!this.key) return;
    try {
      await this.fetchImpl(`${this.host}/capture/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: this.key, event: event.name, distinct_id: event.subjectRef, timestamp: event.at, properties: redactObject({ ...event.properties, company_ref: event.companyRef, $process_person_profile: false }) }),
      });
    } catch {
      /* analytics failures never affect the product */
    }
  }
}
