# 12. Account setup checklist (governing version, 15 September 2026; corrections of 18 September applied)

This version records the founder's consolidated decisions of 15 September 2026 and replaces the 14 September draft wherever they conflict. Nothing here is created by Claude. Nadine or Paul opens every account and enters every secret; Claude receives code context, environment-variable names, test results, and non-secret project references only, and never passwords, authentication codes, API keys, recovery codes, or secret values.

## 1. Current ITS account and domain facts (recorded)

| Fact | Status | Evidence |
|---|---|---|
| ITS does not use Google Workspace. | Recorded (founder) | No Google MX or DKIM records exist for the domain (public DNS, 18 Sep 2026). |
| `identifiedtalent.com` is registered with GoDaddy. | Confirmed | WHOIS: registrar GoDaddy.com, LLC; created 20 Jun 2014; expires 20 Jun 2027. |
| ITS controls its DNS. | Confirmed | Name servers `ns47.domaincontrol.com`, `ns48.domaincontrol.com` (GoDaddy DNS). |
| Paul is the current super administrator with administrative access to company systems; Nadine is not currently a super administrator. | Recorded (founder) | To be confirmed in each admin console during step 2 of the sequence. |
| Accountable human owners of the Recruiting OS infrastructure: Nadine and Paul. | Decided | Applies to every service in §5. |
| Claude is the developer; no human developer or contractor needs an account now. | Decided | See §3. |
| **Email provider serving `identifiedtalent.com`** | **Expected: Microsoft 365 through GoDaddy, with Proofpoint Essentials filtering. Pending Paul's confirmation in the GoDaddy Email and Office dashboard or the Microsoft 365 admin center. Not marked confirmed until verified inside the account.** | MX records point to Proofpoint Essentials (`mx1-us1.ppe-hosted.com`, `mx2-us1.ppe-hosted.com`), the filtering service GoDaddy sells as "Advanced Email Security"; SPF is `v=spf1 a:dispatch-us.ppe-hosted.com include:secureserver.net -all` (Proofpoint plus GoDaddy); `autodiscover` points to `autodiscover.outlook.com`; `lyncdiscover` and `sip` point to Microsoft's `online.lync.com`; the TXT record `MS=ms93572196` is a Microsoft 365 domain-verification record. Public-DNS conclusion: expected Microsoft 365 provided through GoDaddy, with mail filtered by Proofpoint Essentials; not Google Workspace. Nothing else waits on this confirmation. |
| DMARC on the root domain | Absent | No `_dmarc.identifiedtalent.com` record exists. The product's own sending subdomain will carry its own DMARC; adding a root DMARC record is a separate hygiene item for Nadine's review (§6). |
| DKIM on the root domain | Not visible | Microsoft 365's `selector1` and `selector2` DKIM CNAMEs are not published. Not required for the product; noted for ITS's own deliverability. |
| Website | Live on GoDaddy hosting | `identifiedtalent.com` A record `160.153.0.190`; `www` is a CNAME to the root. |
| `app.identifiedtalent.com` | **In use by another vendor; preserved** | CNAME to `whitelabel.ludicrous.cloud`. Not altered or repurposed until ITS separately identifies the service and decides whether it is still needed. The application uses `recruiting.identifiedtalent.com` (A8, approved 18 Sep). |
| `hire.`, `apply.`, `jobs.` | Unused | No records exist; free to reserve. |
| Other existing records to preserve | | `_acme-challenge` TXT (certificate validation for an existing service), the Microsoft verification TXT, SPF, MX. No CAA record. |

Consequences: the required mailboxes are created in Microsoft 365, not Google Workspace; the company's email system is not migrated; ITS's Microsoft 365 tenant already gives Nadine and Paul Entra identities with MFA, which the product's authentication can use for staff sign-in; Google Cloud is used only for the Calendar API, under an ITS-controlled identity model (§8).

## 2. Human ownership and the service identity

- Two named human owners on every critical service that supports multiple administrators: **Nadine** and **Paul**.
- `platform@identifiedtalent.com` is a real, licensed Microsoft 365 mailbox used only for automated notifications, provider correspondence, security alerts, calendar-integration administration, operational system notifications, and non-human service ownership where a provider requires a login.
- `platform@` may not replace Nadine or Paul as an accountable owner, be the only owner of a critical service, be a Google Workspace super administrator, be a shared human login, be the only recovery path, or obscure which person acted.
- Named human accounts are used wherever a provider supports them.

## 3. Human developer and contractor access

No developer or contractor mailbox is created now. Claude has no account and never receives production credentials. If a human developer or contractor is hired later: a named ITS-issued address; access only to the services and environment required; staging by default; MFA required; date and purpose recorded; access removed when the engagement ends; any staging credential the person could have seen rotated. No generic accounts such as `developer@identifiedtalent.com`.

## 4. Email addresses (create or confirm in Microsoft 365)

| Address | Type | Delivery |
|---|---|---|
| `platform@identifiedtalent.com` | Licensed user mailbox (operational; owned by ITS; MFA; recovery per §7) | Monitored by Nadine and Paul through a shared-mailbox permission or rule |
| `billing@identifiedtalent.com` | Distribution group or shared mailbox | Nadine and the ITS bookkeeper |
| `support@identifiedtalent.com` | Shared mailbox (members can read and reply) | Nadine and the designated ITS recruiter on duty |
| `privacy@identifiedtalent.com` | Shared mailbox, separate from support | Nadine and the person responsible for privacy requests |
| `security@identifiedtalent.com` | Distribution group | Nadine and Paul |
| `dev-alerts@identifiedtalent.com` | Distribution group | Nadine initially |
| `recruiting-replies@identifiedtalent.com` | Shared mailbox | Nadine and the designated ITS recruiter on duty |

Privacy and security requests never depend on the general support inbox. Shared mailboxes are free in Microsoft 365 and allow monitoring and reply-as; distribution groups are forward-only. Proofpoint filtering applies to all of them because they sit on the root domain.

## 5. Ownership rules for every service

Nadine and Paul are the accountable human owners; billing goes to `billing@`; security alerts to `security@`; MFA required; recovery under ITS control; United States regions where selectable; least privilege; spend alerts before the first live deployment; every owner, administrator, member, credential, plan, region, and recovery method recorded in the service record card. No personal Gmail accounts, contractor addresses, or Claude sessions as owners. For services that do not support two equal owners, the record card documents the primary owner, secondary administrator, recovery process, emergency-access procedure, and the provider-specific limitation.

## 6. Domain registrar and DNS (GoDaddy)

Before any DNS change:

1. Confirm Nadine and Paul have separate named GoDaddy access. GoDaddy supports this through **Delegate Access** (Account → Delegate Access → Invite): Paul's account invites Nadine's own GoDaddy account with "Products, Domains and Purchase" access; no password is shared.
2. Enable two-step verification for both human administrators (authenticator app).
3. Confirm the account's recovery email and phone are ITS-controlled (an ITS mailbox and an ITS phone), not a personal or former-employee contact.
4. Store the emergency recovery information in the `Domain and DNS` and `Recovery and Emergency` vaults.
5. Export the complete DNS zone (GoDaddy DNS → Export) and store it in the `Domain and DNS` vault with the date.
6. Record: registrar (GoDaddy), name servers (`ns47`/`ns48.domaincontrol.com`), MX (Proofpoint `ppe-hosted.com`), SPF (Proofpoint plus `secureserver.net`), DKIM (not published), DMARC (absent), website records (A `160.153.0.190`, `www` CNAME), Microsoft records (`autodiscover`, `lyncdiscover`, `sip`, `MS=` TXT), `_acme-challenge` TXT, `app` CNAME to `whitelabel.ludicrous.cloud`.
7. Confirm which records support the website (A and `www`) and company email (MX, SPF, Microsoft records).
8. Do not change the name servers. Do not overwrite existing MX, SPF, DKIM, or DMARC records. Do not touch `app`, `_acme-challenge`, or the Microsoft records.
9. Every proposed change is prepared for Nadine's review before it is applied (the list is in `13-account-creation-worksheet.md`, appendix B).

The project must not risk interrupting the ITS website or email. All product records live on new subdomains.

## 7. Approved hostnames

| Hostname | Purpose | Status |
|---|---|---|
| `hire.identifiedtalent.com` | Outbound product email | Reserved; unused today |
| `apply.identifiedtalent.com` | Inbound application email | Reserved; unused today |
| `jobs.identifiedtalent.com` | Hosted job pages | Reserved; unused today |
| `recruiting.identifiedtalent.com` | Customer and staff application | **Approved 18 Sep (A8)**; unused today |
| `app.identifiedtalent.com` | Existing vendor service | Preserved as is (CNAME to `whitelabel.ludicrous.cloud`); not touched by this project |

No record is configured until the zone export is stored and the relevant provider supplies the exact values.

## 8. Password vault: 1Password Business

Named human accounts for Nadine and Paul; `platform@` is not a shared human vault account. Vaults: `Recruiting OS Accounts`, `Recruiting OS Production`, `Recruiting OS Staging`, `Domain and DNS`, `Recovery and Emergency`. Access: production, staging, accounts and recovery, domain and DNS all Nadine and Paul only initially; human developers may receive staging later; no contractor receives production by default. Digital backup codes in 1Password; one sealed offline recovery package in a secure physical location controlled by ITS.

## 9. Google Cloud ownership without Google Workspace (corrected 18 Sep)

Google Cloud is used only for the Google Calendar API. Ownership model: **Cloud Identity Free** on `identifiedtalent.com` (managed Google accounts for the domain without Gmail or Workspace; free for up to 50 users), which creates a Google Cloud organization resource owned by ITS. Setup: **Nadine (or Paul) is the initial Cloud Identity administrator**, signing up with her own ITS address (`nadine@identifiedtalent.com`; Google sends the verification mail to that Microsoft 365 mailbox); verify the domain with one TXT record in GoDaddy (appendix B in `13`); then create the second managed account so that **Nadine and Paul are the two named human Organization Administrators**. `platform@identifiedtalent.com` may be added later as an operational identity with only the minimum role a task requires; it is never a Cloud Identity super administrator and never used by a person. Provider limitation: Google requires the first sign-up to use a mailbox on the domain that can receive mail; an ITS Microsoft 365 mailbox satisfies this, so no bootstrap through `platform@` is needed. If a provider ever forces a service-identity bootstrap, that access is temporary: full administration is transferred to Nadine and Paul immediately, the super-admin role is removed from `platform@`, and the change is verified before any production resource is created. Neither Gmail nor Workspace email is enabled; ITS email stays on Microsoft 365.

## 10. Calendar provider decision (approved 18 Sep)

**Google Calendar is the first external calendar provider**, with the complete manual availability and ICS fallback. Each design partner's calendar platform is recorded during pilot onboarding. The provider interface is built so Microsoft Calendar can be added without rewriting the scheduling domain. Microsoft Calendar follows when a design partner requires it, when ITS begins running its own searches through the product, or when Google Calendar no longer covers the pilot cohort. Both integrations are not built simultaneously unless a live design partner requires Microsoft. OAuth verification never blocks the pilot.

## 10a. Microsoft Entra: two separate uses (corrected 18 Sep)

- **Microsoft Entra authentication, required for release 1.** A minimal app registration in ITS's existing Microsoft 365 tenant for Microsoft identity sign-in: ITS staff authentication and Supabase Auth's Microsoft provider (customers on Microsoft may sign in with it too). Scopes: OpenID Connect identity only (`openid`, `profile`, `email`, and the default delegated `User.Read` profile read). No calendar scope is requested through this registration; a combined registration would require a documented architecture decision, and none is planned.
- **Microsoft Calendar integration, deferred.** `Calendars.ReadWrite` is not requested until Microsoft Calendar becomes an approved provider (§10). It will be a separate registration.

## 11. Authentication (D19, approved)

Supabase Auth replaces the internal magic-link system: Google and Microsoft sign-in, email-based recovery, required TOTP MFA for ITS recruiters and platform administrators, MFA for customer administrators before general release, session revocation on removal, rate limiting, suspicious-login monitoring, shorter administrative sessions. ITS staff sign in with their Microsoft 365 accounts through the Entra sign-in registration in §10a, plus TOTP. Built 18 Sep (slice 5 step 4) against a fake issuer: the PKCE flow, token verification, the Microsoft-plus-second-factor rule for staff, short staff sessions and break-glass gating are in code and tested; connecting the real Supabase project is configuration (`AUTH_PROVIDER=supabase`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, optional `SUPABASE_JWT_SECRET`). Candidates never create accounts: expiring, signed, single-purpose links with cryptographically secure non-sequential identifiers, one application or action each, revocable, unable to reach another candidate or application, no sensitive information in the URL, every access recorded. Break-glass stays disabled until MFA enforcement, expiration, immutable audit logging, and notification are verified.

## 12. Sequence

1. Confirm the current ITS email provider (Paul: GoDaddy Email & Office dashboard or the Microsoft 365 admin center; expected: Microsoft 365 through GoDaddy with Proofpoint Essentials).
2. Confirm Nadine's and Paul's administrative roles in Microsoft 365, GoDaddy, and any other company system.
3. Add Nadine as an administrator where the provider permits it (Microsoft 365: Global Administrator; GoDaddy: delegate access).
4. Secure GoDaddy: named human access, MFA, ITS-controlled recovery, documented DNS.
5. Export the existing DNS zone.
6. Create the mailboxes and groups in §4.
7. Create 1Password Business and the five vaults.
8. Create the GitHub organization and private repository.
9. Create Supabase staging and production.
9a. Create the Microsoft Entra app registration for sign-in only (§10a) and configure Supabase Auth's Microsoft provider with it; configure the Google sign-in provider from the Google Cloud project once it exists (step 14).
10. Create Vercel and connect the private GitHub repository.
11. Create Trigger.dev staging and production.
12. Create Postmark staging and production.
13. Configure Postmark DNS only after reviewing the existing email DNS.
14. Create Google Cloud projects for the Calendar integration (§9).
15. Create Sentry.
16. Create PostHog.
17. Create Anthropic staging and production workspaces with spend limits.
18. Create Twilio and begin A2P 10DLC registration.
19. Defer the Microsoft Entra **calendar** registration (`Calendars.ReadWrite`) until Microsoft Calendar is an approved provider (§10). The sign-in registration in step 9a is not deferred.
20. Record all non-secret project identifiers and environment-variable names.

The per-service worksheet with signup URLs, roles, environment names, DNS records, environment-variable names, verification, revocation, and rotation is `13-account-creation-worksheet.md`.
