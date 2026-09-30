import { fingerprint } from "@ros/contracts";
import type { CalendarProvider } from "../calendar/types";

/** Tells the provider a credential is no longer to be honoured. Providers that cannot revoke report ok:false and the deletion proceeds anyway. */
export interface CredentialRevoker {
  readonly provider: string;
  revoke(value: string): Promise<{ ok: boolean; error?: string }>;
}

/**
 * Revocation at the calendar provider itself (Google's token revocation endpoint, for example). This is what a
 * customer is promised when they disconnect a calendar: the grant ends in their Google account, not only in our store.
 */
export class CalendarCredentialRevoker implements CredentialRevoker {
  constructor(private readonly calendar: Pick<CalendarProvider, "provider" | "revoke">) {}
  get provider(): string {
    return this.calendar.provider;
  }
  async revoke(value: string): Promise<{ ok: boolean; error?: string }> {
    try {
      return await this.calendar.revoke({ refreshToken: value });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Development and tests: records that a revocation happened (by fingerprint, never the value) and can be told to fail. */
export class FakeCredentialRevoker implements CredentialRevoker {
  readonly calls: Array<{ fingerprint: string; at: string }> = [];
  failNext = false;
  constructor(readonly provider: string) {}
  async revoke(value: string): Promise<{ ok: boolean; error?: string }> {
    this.calls.push({ fingerprint: fingerprint(value), at: new Date().toISOString() });
    if (this.failNext) {
      this.failNext = false;
      return { ok: false, error: "provider refused the revocation (fake)" };
    }
    return { ok: true };
  }
}
