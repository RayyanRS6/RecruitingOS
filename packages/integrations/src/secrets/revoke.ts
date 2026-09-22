import { fingerprint } from "@ros/contracts";

/** Tells the provider a credential is no longer to be honoured. Providers that cannot revoke report ok:false and the deletion proceeds anyway. */
export interface CredentialRevoker {
  readonly provider: string;
  revoke(value: string): Promise<{ ok: boolean; error?: string }>;
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
