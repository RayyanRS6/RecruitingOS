import { FakeEmailAdapter, FakeSmsAdapter } from "./email/fake";
import { PostmarkEmailAdapter } from "./email/postmark";
import { CareersPageAdapter, EmailInAdapter, GoogleJobsAdapter } from "./jobboards/native";
import { IndeedAdapter, LinkedInBasicJobsAdapter, ZipRecruiterAdapter } from "./jobboards/external";
import { BlsOewsAdapter } from "./comp/bls";
import { TwilioSmsAdapter } from "./sms/twilio";
import { LocalStorageAdapter, MemoryStorageAdapter } from "./storage/local";
import { MemorySecretStore } from "./secrets/memory";
import { SupabaseVaultSecretStore } from "./secrets/vault";
import type { SecretStore, SqlExecutor } from "./secrets/types";
import { FakeAnalyticsAdapter, PostHogServerAdapter } from "./analytics/adapters";
import { FakeCredentialRevoker, type CredentialRevoker } from "./secrets/revoke";
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
  secrets: SecretStore;
  /** Provider-side revocation by provider key (google, microsoft, ...). Fakes in development; real ones arrive with each adapter. */
  revokers: Record<string, CredentialRevoker>;
  /** Managed sign-in (D19): Supabase Auth in production, an in-process fake issuer elsewhere. */
  identity: IdentityProvider;
  /** Calendar providers by key (google first, D2/correction 3); the fake speaks the same interface in development. */
  calendars: Record<string, CalendarProvider>;
  analytics: AnalyticsAdapter;
  /** Salt for the keyed analytics identifiers; never the same across environments. */
  analyticsSalt: string;
  env: { fromDomain: string; fromAddress: string; replyTo: string; intakeDomain: string; appBaseUrl: string; productName: string };
  statuses(): Array<{ kind: string; provider: string; status: AdapterStatus }>;
};

/** Every adapter reports its real state (founder decision F4): nothing is labeled live without a verified connection. */
export function createIntegrations(env: Record<string, string | undefined> = process.env, opts: { memoryStorage?: boolean; secretsExecutor?: SqlExecutor } = {}): Integrations {
  const appBaseUrl = env.APP_BASE_URL ?? "http://localhost:3001";
  const fromDomain = env.EMAIL_FROM_DOMAIN ?? "mail.localhost";
  const intakeDomain = env.EMAIL_INTAKE_DOMAIN ?? "intake.localhost";
  const email: EmailAdapter = env.EMAIL_PROVIDER === "postmark" ? new PostmarkEmailAdapter(env.POSTMARK_SERVER_TOKEN) : new FakeEmailAdapter();
  const sms: SmsAdapter = env.SMS_PROVIDER === "twilio" ? new TwilioSmsAdapter({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID, from: env.TWILIO_FROM_NUMBER }) : new FakeSmsAdapter();
  const emailInConfigured = env.EMAIL_PROVIDER === "postmark" && !!env.POSTMARK_INBOUND_SECRET && !intakeDomain.endsWith("localhost");
  const boards: JobBoardAdapter[] = [
    new CareersPageAdapter(),
    new GoogleJobsAdapter(),
    new EmailInAdapter(emailInConfigured),
    new LinkedInBasicJobsAdapter(`${appBaseUrl}/feeds/linkedin.xml`),
    new IndeedAdapter({ clientId: env.INDEED_CLIENT_ID, clientSecret: env.INDEED_CLIENT_SECRET }),
    new ZipRecruiterAdapter(env.ZIPRECRUITER_API_KEY),
  ];
  const jobBoards = Object.fromEntries(boards.map((b) => [b.channel, b]));
  const comp = new BlsOewsAdapter(env.BLS_API_KEY, fetch, env.COMP_BLS_ENABLED !== "false");
  const storage: StorageAdapter = opts.memoryStorage || env.STORAGE_PROVIDER === "memory" ? new MemoryStorageAdapter() : new LocalStorageAdapter(env.STORAGE_DIR ?? "./.data/files");
  const secrets: SecretStore = env.SECRET_STORE === "vault" && opts.secretsExecutor ? new SupabaseVaultSecretStore(opts.secretsExecutor) : new MemorySecretStore();
  const revokers: Record<string, CredentialRevoker> = Object.fromEntries(["google", "microsoft", "fake"].map((p) => [p, new FakeCredentialRevoker(p)]));
  const identity: IdentityProvider = env.AUTH_PROVIDER === "supabase"
    ? new SupabaseIdentityProvider({ url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY, jwtSecret: env.SUPABASE_JWT_SECRET, providers: (env.AUTH_SIGNIN_PROVIDERS ?? "azure,google").split(",").map((s) => s.trim()).filter(Boolean) })
    : new FakeIdentityProvider({ apiBaseUrl: appBaseUrl });
  const calendars: Record<string, CalendarProvider> = env.CALENDAR_PROVIDER === "google"
    ? { google: new GoogleCalendarProvider({ clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET }) }
    : { google: new FakeGoogleCalendarProvider({ apiBaseUrl: appBaseUrl }) };
  const analytics: AnalyticsAdapter = env.ANALYTICS_PROVIDER === "posthog" ? new PostHogServerAdapter(env.POSTHOG_PROJECT_API_KEY, env.POSTHOG_HOST) : new FakeAnalyticsAdapter();
  return {
    email,
    sms,
    jobBoards,
    comp,
    storage,
    secrets,
    revokers,
    identity,
    calendars,
    analytics,
    analyticsSalt: env.ANALYTICS_SALT ?? "dev-only-analytics-salt",
    env: { fromDomain, fromAddress: env.EMAIL_FROM_ADDRESS ?? `updates@${fromDomain}`, replyTo: env.EMAIL_REPLY_TO ?? env.ITS_QUEUE_EMAIL ?? `updates@${fromDomain}`, intakeDomain, appBaseUrl, productName: env.PRODUCT_NAME ?? "Recruiting OS" },
    statuses: () => [
      { kind: "email", provider: email.id, status: email.status },
      { kind: "sms", provider: sms.id, status: sms.status },
      ...boards.map((b) => ({ kind: "jobboard", provider: b.channel, status: b.status })),
      { kind: "comp", provider: comp.id, status: comp.status },
      { kind: "storage", provider: storage.id, status: "live" as const },
      { kind: "secrets", provider: secrets.id, status: secrets.status },
      { kind: "identity", provider: identity.id, status: identity.status },
      ...Object.values(calendars).map((cal) => ({ kind: "calendar", provider: cal.provider, status: cal.status })),
      { kind: "analytics", provider: analytics.id, status: analytics.status },
    ],
  };
}
