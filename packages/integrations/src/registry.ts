import { FakeEmailAdapter, FakeSmsAdapter } from "./email/fake";
import { PostmarkEmailAdapter } from "./email/postmark";
import { CareersPageAdapter, EmailInAdapter, GoogleJobsAdapter } from "./jobboards/native";
import { IndeedAdapter, LinkedInBasicJobsAdapter, ZipRecruiterAdapter } from "./jobboards/external";
import { BlsOewsAdapter } from "./comp/bls";
import { TwilioSmsAdapter } from "./sms/twilio";
import { LocalStorageAdapter, MemoryStorageAdapter } from "./storage/local";
import { GrantSigner } from "./storage/grants";
import { SupabaseStorageAdapter } from "./storage/supabase";
import { FakeMalwareScanner } from "./scanning/fake";
import type { MalwareScanner } from "./scanning/types";
import { MemorySecretStore } from "./secrets/memory";
import { SupabaseVaultSecretStore } from "./secrets/vault";
import type { SecretStore, SqlExecutor } from "./secrets/types";
import { FakeAnalyticsAdapter, PostHogServerAdapter } from "./analytics/adapters";
import { CalendarCredentialRevoker, FakeCredentialRevoker, type CredentialRevoker } from "./secrets/revoke";
import { FakeIdentityProvider } from "./identity/fake";
import { SupabaseIdentityProvider } from "./identity/supabase";
import type { IdentityProvider } from "./identity/types";
import { FakeGoogleCalendarProvider } from "./calendar/fake-google";
import { GoogleCalendarProvider } from "./calendar/google";
import type { CalendarProvider } from "./calendar/types";
import type { AnalyticsAdapter } from "./analytics/types";
import type { CompAdapter, EmailAdapter, JobBoardAdapter, SmsAdapter, StorageAdapter, AdapterStatus } from "./types";

export type Integrations = {
  email: EmailAdapter;
  sms: SmsAdapter;
  jobBoards: Record<string, JobBoardAdapter>;
  comp: CompAdapter;
  storage: StorageAdapter;
  /** Malware scanning of quarantined uploads; a fake until a real engine is authorized (real-data blocker). */
  scanner: MalwareScanner;
  secrets: SecretStore;
  /** Provider-side revocation by provider key (google, ...): the real provider's revocation endpoint when that provider is configured, a fake otherwise. */
  revokers: Record<string, CredentialRevoker>;
  /** Managed sign-in (D19): Supabase Auth in production, an in-process fake issuer elsewhere. */
  identity: IdentityProvider;
  /** Calendar providers by key (google first, D2/correction 3); the fake speaks the same interface in development. */
  calendars: Record<string, CalendarProvider>;
  analytics: AnalyticsAdapter;
  /** Salt for the keyed analytics identifiers; never the same across environments. */
  analyticsSalt: string;
  env: { fromDomain: string; fromAddress: string; replyTo: string; intakeDomain: string; appBaseUrl: string; productName: string };
  /** The clock the outbox stamps its jobs with. The app points it at the workflow engine's clock, so a message queued now is due now on the clock that runs the queue (tests move that clock). */
  clock: () => Date;
  statuses(): Array<{ kind: string; provider: string; status: AdapterStatus }>;
};

/** Every adapter reports its real state (founder decision F4): nothing is labeled live without a verified connection. */
export function createIntegrations(env: Record<string, string | undefined> = process.env, opts: { memoryStorage?: boolean; secretsExecutor?: SqlExecutor } = {}): Integrations {
  const appBaseUrl = env.APP_BASE_URL ?? "http://localhost:3000";
  const fromDomain = env.EMAIL_FROM_DOMAIN ?? "mail.localhost";
  const intakeDomain = env.EMAIL_INTAKE_DOMAIN ?? "intake.localhost";
  const email: EmailAdapter = env.EMAIL_PROVIDER === "postmark" ? new PostmarkEmailAdapter(env.POSTMARK_SERVER_TOKEN) : new FakeEmailAdapter();
  const sms: SmsAdapter = env.SMS_PROVIDER === "twilio" ? new TwilioSmsAdapter({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID, from: env.TWILIO_FROM_NUMBER }) : new FakeSmsAdapter();
  const emailInConfigured = env.EMAIL_PROVIDER === "postmark" && !!env.POSTMARK_INBOUND_SECRET && !intakeDomain.endsWith("localhost");
  const boards: JobBoardAdapter[] = [
    new CareersPageAdapter(),
    new GoogleJobsAdapter(),
    new EmailInAdapter(emailInConfigured),
    // Manual boards until a partner integration is verified (F4): no credential is read for them yet.
    new LinkedInBasicJobsAdapter(),
    new IndeedAdapter(),
    new ZipRecruiterAdapter(),
  ];
  const jobBoards = Object.fromEntries(boards.map((b) => [b.channel, b]));
  const comp = new BlsOewsAdapter(env.BLS_API_KEY, fetch, env.COMP_BLS_ENABLED !== "false");
  const storage = createStorage(env, opts, appBaseUrl);
  const scanner: MalwareScanner = createScanner(env);
  const secrets: SecretStore = env.SECRET_STORE === "vault" && opts.secretsExecutor ? new SupabaseVaultSecretStore(opts.secretsExecutor) : new MemorySecretStore();
  const identity: IdentityProvider = env.AUTH_PROVIDER === "supabase"
    ? new SupabaseIdentityProvider({ url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY, jwtSecret: env.SUPABASE_JWT_SECRET, providers: (env.AUTH_SIGNIN_PROVIDERS ?? "azure,google").split(",").map((s) => s.trim()).filter(Boolean) })
    : new FakeIdentityProvider({ apiBaseUrl: appBaseUrl });
  const realCalendars = env.CALENDAR_PROVIDER === "google";
  const calendars: Record<string, CalendarProvider> = realCalendars
    ? { google: new GoogleCalendarProvider({ clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET }) }
    : { google: new FakeGoogleCalendarProvider({ apiBaseUrl: appBaseUrl }) };
  // With a real calendar provider, disconnecting revokes the grant at the provider (Google's revocation endpoint), so
  // "revoked" is only ever recorded when the provider confirmed it. The fake revoker exists for development and tests.
  const revokers: Record<string, CredentialRevoker> = realCalendars
    ? { google: new CalendarCredentialRevoker(calendars.google) }
    : Object.fromEntries(["google", "fake"].map((p) => [p, new FakeCredentialRevoker(p)]));
  const analytics: AnalyticsAdapter = env.ANALYTICS_PROVIDER === "posthog" ? new PostHogServerAdapter(env.POSTHOG_PROJECT_API_KEY, env.POSTHOG_HOST) : new FakeAnalyticsAdapter();
  return {
    email,
    sms,
    jobBoards,
    comp,
    storage,
    scanner,
    secrets,
    revokers,
    identity,
    calendars,
    analytics,
    analyticsSalt: env.ANALYTICS_SALT ?? "dev-only-analytics-salt",
    env: { fromDomain, fromAddress: env.EMAIL_FROM_ADDRESS ?? `updates@${fromDomain}`, replyTo: env.EMAIL_REPLY_TO ?? env.ITS_QUEUE_EMAIL ?? `updates@${fromDomain}`, intakeDomain, appBaseUrl, productName: env.PRODUCT_NAME ?? "Recruiting OS" },
    clock: () => new Date(),
    statuses: () => [
      { kind: "email", provider: email.id, status: email.status },
      { kind: "sms", provider: sms.id, status: sms.status },
      ...boards.map((b) => ({ kind: "jobboard", provider: b.channel, status: b.status })),
      { kind: "comp", provider: comp.id, status: comp.status },
      { kind: "storage", provider: storage.id, status: storage.status },
      { kind: "scanner", provider: scanner.id, status: scanner.status },
      { kind: "secrets", provider: secrets.id, status: secrets.status },
      { kind: "identity", provider: identity.id, status: identity.status },
      ...Object.values(calendars).map((cal) => ({ kind: "calendar", provider: cal.provider, status: cal.status })),
      { kind: "analytics", provider: analytics.id, status: analytics.status },
    ],
  };
}

/**
 * Storage by STORAGE_PROVIDER: `memory` (tests), `local` (development, files under STORAGE_DIR), `supabase` (staging and
 * production, decision 2). Anything else is refused rather than silently falling back to the disk. Configuration
 * errors name the variable, never a value.
 */
function createStorage(env: Record<string, string | undefined>, opts: { memoryStorage?: boolean }, appBaseUrl: string): StorageAdapter {
  const provider = opts.memoryStorage ? "memory" : (env.STORAGE_PROVIDER ?? "local");
  const signer = new GrantSigner(env.SESSION_SECRET ?? "dev-only-session-secret", appBaseUrl);
  if (provider === "memory") return new MemoryStorageAdapter(signer);
  if (provider === "local") return new LocalStorageAdapter(env.STORAGE_DIR ?? "./.data/files", signer);
  if (provider === "supabase") {
    const missing = ["STORAGE_S3_ENDPOINT", "STORAGE_S3_REGION", "STORAGE_BUCKET", "STORAGE_S3_ACCESS_KEY_ID", "STORAGE_S3_SECRET_ACCESS_KEY"].filter((k) => !env[k]);
    if (missing.length) throw new Error(`STORAGE_PROVIDER=supabase needs ${missing.join(", ")}`);
    return new SupabaseStorageAdapter({ endpoint: env.STORAGE_S3_ENDPOINT!, region: env.STORAGE_S3_REGION!, bucket: env.STORAGE_BUCKET!, accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID!, secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY! });
  }
  throw new Error(`STORAGE_PROVIDER=${provider} is not a known storage provider (memory, local, supabase)`);
}

function createScanner(env: Record<string, string | undefined>): MalwareScanner {
  const provider = env.SCAN_PROVIDER ?? "fake";
  if (provider === "fake") return new FakeMalwareScanner();
  throw new Error(`SCAN_PROVIDER=${provider} is not a known scanner (fake); a real engine is a real-data gate, not yet authorized`);
}
