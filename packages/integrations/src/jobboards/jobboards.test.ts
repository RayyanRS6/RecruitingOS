import { describe, expect, it } from "vitest";
import type { RolePacket } from "@ros/contracts";
import { CareersPageAdapter, EMAIL_IN_NOT_CONFIGURED, EmailInAdapter, GoogleJobsAdapter, jobPostingJsonLd, jobValidThrough, schemaEmploymentType } from "./native";
import { IndeedAdapter, LinkedInBasicJobsAdapter, ZipRecruiterAdapter, jobFeedJson, jobFeedXml, linkedInFeedXml, type FeedJob } from "./external";
import { FakeUrlVerifier, LINK_CHECK_MAX_BYTES, LINK_CHECK_REFUSED_DETAIL, LINK_CHECK_USER_AGENT, RealUrlVerifier, isNonPublicAddress, titleMatches } from "./verify";
import type { PostingInput } from "../types";

const packet = {
  identity: { title: "Registered Dental Hygienist", locations: [{ address1: "1 Main St", city: "Irvine", region: "CA", postalCode: "92618", country: "US" }], employmentType: "full_time", remotePolicy: "onsite" },
  compensation: { basis: "hourly", currency: "USD", min: 45, max: 55, ceiling: 58, discloseRange: true },
  description: { publicJobDescription: "Join a friendly practice in Irvine. You will provide preventive care and patient education." },
  screening: { questions: [{ key: "q1", question: "Do you hold an active RDH license?", kind: "eligibility" }], maxMinutes: 15 },
} as unknown as RolePacket;

const input: PostingInput = { roleId: "role-1", companyName: "Brightline Dental Group", companySlug: "brightline", packet, jobUrl: "https://jobs.example.com/careers/brightline/jobs/role-1", applyUrl: "https://jobs.example.com/a/abc123def456", intakeAddress: "apply-x@intake.example.com" };

describe("JobPosting structured data (docs/spec/20 item 4)", () => {
  it("maps employment types to schema.org tokens", () => {
    expect(schemaEmploymentType("full_time")).toBe("FULL_TIME");
    expect(schemaEmploymentType("part_time")).toBe("PART_TIME");
    expect(schemaEmploymentType("contract")).toBe("CONTRACTOR");
    expect(schemaEmploymentType("temporary")).toBe("TEMPORARY");
    expect(schemaEmploymentType("internship")).toBe("INTERN");
    expect(schemaEmploymentType("per_diem")).toBe("PER_DIEM");
    expect(schemaEmploymentType("gig")).toBe("OTHER");
  });

  it("validThrough is only ever a real date: the closing day, else the day applications stopped, else a set closing date; an open job with none has none (Wave 0 item 0.8)", () => {
    expect(jobValidThrough({})).toBeUndefined();
    expect(jobValidThrough({ closedAt: null, stoppedAt: null, closesOn: null })).toBeUndefined();
    expect(jobValidThrough({ closedAt: "2026-09-20T15:04:05.000Z" })).toBe("2026-09-20");
    expect(jobValidThrough({ stoppedAt: "2026-09-18T08:00:00.000Z" })).toBe("2026-09-18");
    expect(jobValidThrough({ closesOn: "2026-10-15" })).toBe("2026-10-15");
    // the closing day wins over everything; a stop wins over a planned date
    expect(jobValidThrough({ closedAt: "2026-09-20T15:04:05.000Z", stoppedAt: "2026-09-18T08:00:00.000Z", closesOn: "2026-10-15" })).toBe("2026-09-20");
    expect(jobValidThrough({ stoppedAt: "2026-09-18T08:00:00.000Z", closesOn: "2026-10-15" })).toBe("2026-09-18");
  });

  it("names the client company as the employer with its website and logo when known, and never emits CONTRACT or INTERNSHIP", () => {
    const ld = jobPostingJsonLd({ ...input, datePosted: "2026-09-01", companyWebsite: "https://brightline.example", companyLogoUrl: "https://brightline.example/logo.png" });
    expect(ld).toMatchObject({ "@type": "JobPosting", title: "Registered Dental Hygienist", datePosted: "2026-09-01", employmentType: "FULL_TIME", directApply: true, url: input.jobUrl });
    // an open job with no closing date carries no invented end date (JSON drops the undefined key)
    expect(JSON.parse(JSON.stringify(ld))).not.toHaveProperty("validThrough");
    expect(ld.hiringOrganization).toEqual({ "@type": "Organization", name: "Brightline Dental Group", sameAs: "https://brightline.example", logo: "https://brightline.example/logo.png" });
    expect(ld.jobLocation).toMatchObject({ "@type": "Place", address: { addressLocality: "Irvine", addressRegion: "CA", postalCode: "92618", addressCountry: "US" } });
    expect(ld.baseSalary).toMatchObject({ currency: "USD", value: { minValue: 45, maxValue: 55, unitText: "HOUR" } });
    const plain = jobPostingJsonLd({ ...input, packet: { ...packet, identity: { ...packet.identity, employmentType: "internship" } } as RolePacket, datePosted: "2026-09-01" });
    expect(plain.employmentType).toBe("INTERN");
    expect(plain.hiringOrganization).toEqual({ "@type": "Organization", name: "Brightline Dental Group" });
    const closed = jobPostingJsonLd({ ...input, datePosted: "2026-09-01", closedAt: "2026-09-15T00:00:00.000Z" });
    expect(closed.validThrough).toBe("2026-09-15");
    const paused = jobPostingJsonLd({ ...input, datePosted: "2026-09-01", stoppedAt: "2026-09-12T10:00:00.000Z" });
    expect(paused.validThrough).toBe("2026-09-12");
  });

  it("the pay range follows the page: the packet's choice by default, shown whenever the page must show it", () => {
    const hidden = { ...packet, compensation: { ...packet.compensation, discloseRange: false } } as RolePacket;
    expect(jobPostingJsonLd({ ...input, packet: hidden, datePosted: "2026-09-01" }).baseSalary).toBeUndefined();
    expect(jobPostingJsonLd({ ...input, packet: hidden, datePosted: "2026-09-01", showPay: true }).baseSalary).toMatchObject({ currency: "USD", value: { minValue: 45, maxValue: 55 } });
  });
});

describe("feeds (item 6)", () => {
  const job: FeedJob = { referenceNumber: "role-1", title: "Registered Dental Hygienist <RDH> & more", url: input.jobUrl, applyUrl: input.applyUrl, company: "Brightline \"Dental\" Group", city: "Irvine", state: "CA", country: "US", postalCode: "92618", description: "Line one ]]> injected <b>bold</b>", datePosted: "2026-09-01", validThrough: "2026-10-31", employmentType: "FULL_TIME", salary: { min: 45, max: 55, currency: "USD", basis: "hourly" }, category: "Dental", remote: false };
  const meta = { publisher: "Recruiting OS", publisherUrl: "https://jobs.example.com", lastBuildDate: new Date("2026-09-22T10:00:00Z") };

  it("escapes text in CDATA so angle brackets, quotes and a closing marker cannot break the document", () => {
    const xml = jobFeedXml([job], meta);
    expect(xml).toContain("<publisher><![CDATA[Recruiting OS]]></publisher>");
    expect(xml).toContain("<publisherurl><![CDATA[https://jobs.example.com]]></publisherurl>");
    expect(xml).toContain("<title><![CDATA[Registered Dental Hygienist <RDH> & more]]></title>");
    expect(xml).toContain("<company><![CDATA[Brightline \"Dental\" Group]]></company>");
    expect(xml).toContain("<description><![CDATA[Line one ]]]]><![CDATA[> injected <b>bold</b>]]></description>");
    expect(xml).not.toMatch(/\]\]> injected/);
    expect(xml).toContain("<referencenumber><![CDATA[role-1]]></referencenumber>");
    expect(xml).toContain("<url><![CDATA[https://jobs.example.com/careers/brightline/jobs/role-1]]></url>");
    expect(xml).toContain("<salary><![CDATA[USD 45-55 per hour]]></salary>");
    expect(xml).toContain("<jobtype><![CDATA[full-time]]></jobtype>");
    expect(xml).toContain("<expirationdate><![CDATA[2026-10-31]]></expirationdate>");
    expect(xml).toContain("<remote>no</remote>");
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<source>')).toBe(true);
    // every opened tag closes
    for (const tag of ["source", "job", "title", "date", "referencenumber", "url", "applyurl", "company", "city", "state", "country", "postalcode", "description", "salary", "jobtype", "category"]) {
      expect((xml.match(new RegExp(`<${tag}>`, "g")) ?? []).length, tag).toBe((xml.match(new RegExp(`</${tag}>`, "g")) ?? []).length);
    }
  });

  it("gives the same listing as JSON with the schema.org-shaped fields", () => {
    const j = jobFeedJson([job], meta) as { publisher: string; publisherUrl: string; lastBuildDate: string; jobs: Array<Record<string, unknown>> };
    expect(j.publisher).toBe("Recruiting OS");
    expect(j.lastBuildDate).toBe("2026-09-22T10:00:00.000Z");
    expect(j.jobs[0]).toMatchObject({ referenceNumber: "role-1", applyUrl: input.applyUrl, datePosted: "2026-09-01", validThrough: "2026-10-31", employmentType: "FULL_TIME", hiringOrganization: { name: "Brightline \"Dental\" Group" }, salary: { minValue: 45, maxValue: 55, currency: "USD", unitText: "HOUR" } });
  });

  it("leaves the expiration date out of both feeds when a job has none, instead of inventing one", () => {
    const open: FeedJob = { ...job, validThrough: undefined };
    const xml = jobFeedXml([open], meta);
    expect(xml).not.toContain("<expirationdate>");
    expect(xml).toContain("<category><![CDATA[Dental]]></category>\n    <remote>no</remote>");
    expect((jobFeedJson([open], meta) as { jobs: Array<Record<string, unknown>> }).jobs[0]).not.toHaveProperty("validThrough");
  });

  it("keeps the LinkedIn feed working, with the publisher URL and the same escaping", () => {
    const xml = linkedInFeedXml([{ partnerJobId: "role-1", company: "Brightline", title: "RDH ]]> x", description: "d", location: "Irvine, CA, US", applyUrl: input.applyUrl }], { publisherUrl: "https://jobs.example.com" });
    expect(xml).toContain("<publisherUrl><![CDATA[https://jobs.example.com]]></publisherUrl>");
    expect(xml).toContain("<title><![CDATA[RDH ]]]]><![CDATA[> x]]></title>");
  });
});

describe("board adapters (items 9, 10 and 12)", () => {
  it("the careers page and Google are never live by construction", async () => {
    const careers = await new CareersPageAdapter().publish(input);
    expect(careers).toMatchObject({ status: "ready_to_post", externalUrl: input.jobUrl });
    const google = await new GoogleJobsAdapter().publish(input);
    expect(google).toMatchObject({ status: "submitted_integration", externalUrl: input.jobUrl });
    expect(google.status === "submitted_integration" && google.instructions).toMatch(/Search Console/);
  });

  it("email-in is verified only with an inbound domain, and failed with its reason otherwise", async () => {
    expect(await new EmailInAdapter(false).publish(input)).toEqual({ status: "failed", error: EMAIL_IN_NOT_CONFIGURED, retryable: false });
    const live = await new EmailInAdapter(true).publish(input);
    expect(live).toMatchObject({ status: "live_verified", externalId: input.intakeAddress });
  });

  it("each board returns ready to post with numbered steps that carry the tracked link, the billing note and the URL to record", async () => {
    for (const [adapter, name] of [[new IndeedAdapter(), "Indeed"], [new ZipRecruiterAdapter(), "ZipRecruiter"], [new LinkedInBasicJobsAdapter(), "LinkedIn"]] as const) {
      const r = await adapter.publish(input);
      expect(r.status).toBe("ready_to_post");
      if (r.status !== "ready_to_post") throw new Error("unreachable");
      expect(r.instructions).toContain(name);
      expect(r.instructions).toContain(input.applyUrl);
      expect(r.instructions).toContain("Brightline Dental Group");
      expect(r.steps).toHaveLength(5);
      const all = r.steps!.join("\n");
      expect(all).toMatch(/Sign in/);
      expect(all).toContain("Brightline Dental Group");
      expect(all).toContain("Registered Dental Hygienist");
      expect(all).toContain(input.applyUrl);
      expect(all).toContain("apply-x@intake.example.com");
      expect(all).toMatch(new RegExp(`billed by ${name}`));
      expect(all).toMatch(/Record the public URL/);
      expect(all).not.toMatch(/api|scrape/i);
    }
  });
});

describe("URL verification (item 12)", () => {
  it("matches the title regardless of case, whitespace and markup", () => {
    expect(titleMatches("<h1>Registered   Dental\nHygienist</h1>", "registered dental hygienist")).toBe(true);
    expect(titleMatches("<title>RDH &amp; more</title>", "RDH & more")).toBe(true);
    expect(titleMatches("<script>var t = 'Registered Dental Hygienist'</script><p>Dentist</p>", "Registered Dental Hygienist")).toBe(false);
    expect(titleMatches("Front office coordinator", "Registered Dental Hygienist")).toBe(false);
    expect(titleMatches("anything", "")).toBe(false);
  });

  it("the fake answers from its script: a page judged by title, a verdict, and ok for anything unscripted", async () => {
    const fake = new FakeUrlVerifier();
    fake.set("https://board.example/1", { pageText: "<h1>Registered Dental Hygienist</h1>" });
    fake.set("https://board.example/2", { pageText: "<h1>Something else</h1>" });
    fake.set("https://board.example/3", { pageText: "Registered Dental Hygienist", status: 404 });
    fake.set("https://board.example/4", { ok: false, reason: "unreachable", detail: "timed out" });
    const title = { expectedTitle: "Registered Dental Hygienist" };
    expect(await fake.verify("https://board.example/1", title)).toEqual({ ok: true });
    expect(await fake.verify("https://board.example/2", title)).toMatchObject({ ok: false, reason: "title_mismatch" });
    expect(await fake.verify("https://board.example/3", title)).toMatchObject({ ok: false, reason: "status" });
    expect(await fake.verify("https://board.example/4", title)).toEqual({ ok: false, reason: "unreachable", detail: "timed out" });
    expect(await fake.verify("https://board.example/unscripted", title)).toEqual({ ok: true });
    expect(await new FakeUrlVerifier({ unknownUrls: "unreachable" }).verify("https://board.example/unscripted", title)).toMatchObject({ ok: false, reason: "unreachable" });
    expect(fake.calls).toHaveLength(5);
  });

  it("the real verifier fetches with its own user agent, follows redirects, reads a bounded body and reports why a page failed", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const pages: Record<string, () => Response> = {
      "https://board.example/ok": () => new Response("<html><title>Registered Dental Hygienist at Brightline</title></html>", { status: 200 }),
      "https://board.example/gone": () => new Response("gone", { status: 410 }),
      "https://board.example/other": () => new Response("<h1>Front office coordinator</h1>", { status: 200 }),
      "https://board.example/huge": () => new Response(`${"x".repeat(LINK_CHECK_MAX_BYTES + 10)}Registered Dental Hygienist`, { status: 200 }),
    };
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const key = String(url);
      seen.push({ url: key, init: init ?? {} });
      const page = pages[key];
      if (!page) throw new TypeError("fetch failed");
      return page();
    }) as unknown as typeof fetch;
    const real = new RealUrlVerifier(fetchFn, { resolveHost: async () => [{ address: "93.184.215.14", family: 4 }] });
    const title = { expectedTitle: "registered dental hygienist" };
    expect(await real.verify("https://board.example/ok", title)).toEqual({ ok: true });
    // redirects are followed by hand so every hop is checked
    expect(seen[0].init.redirect).toBe("manual");
    expect((seen[0].init.headers as Record<string, string>)["user-agent"]).toBe(LINK_CHECK_USER_AGENT);
    expect(seen[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(await real.verify("https://board.example/gone", title)).toMatchObject({ ok: false, reason: "status", detail: expect.stringContaining("410") });
    expect(await real.verify("https://board.example/other", title)).toMatchObject({ ok: false, reason: "title_mismatch" });
    expect(await real.verify("https://board.example/huge", title)).toMatchObject({ ok: false, reason: "title_mismatch" }); // the title sits past the read limit
    expect(await real.verify("https://board.example/down", title)).toMatchObject({ ok: false, reason: "unreachable", detail: "fetch failed" });
    expect(await real.verify("not a url", title)).toMatchObject({ ok: false, reason: "unreachable" });
    expect(await real.verify("ftp://board.example/x", title)).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("the real verifier never reaches a private, internal or odd address, directly, through DNS or through a redirect, and says nothing about why", async () => {
    const fetched: string[] = [];
    const pages: Record<string, () => Response> = {
      "https://board.example/moved": () => new Response(null, { status: 302, headers: { location: "http://10.0.0.7:8080/admin" } }),
      "https://board.example/to-metadata": () => new Response(null, { status: 301, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
      "https://board.example/to-http": () => new Response(null, { status: 302, headers: { location: "http://board.example/job" } }),
      "http://board.example/job": () => new Response("<h1>Registered Dental Hygienist</h1>", { status: 200 }),
      "https://board.example/loop": () => new Response(null, { status: 302, headers: { location: "https://board.example/loop" } }),
      "https://rebind.example/job": () => new Response("<h1>Registered Dental Hygienist</h1>", { status: 200 }),
    };
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      fetched.push(String(url));
      expect(init?.redirect).toBe("manual");
      const page = pages[String(url)];
      if (!page) throw new TypeError("fetch failed");
      return page();
    }) as unknown as typeof fetch;
    const dns: Record<string, string[]> = { "board.example": ["93.184.215.14"], "rebind.example": ["93.184.215.14", "127.0.0.1"], "metadata.example": ["169.254.169.254"], "six.example": ["fd00::1"] };
    const real = new RealUrlVerifier(fetchFn, { resolveHost: async (host) => (dns[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 })) });
    const title = { expectedTitle: "registered dental hygienist" };
    const refused = { ok: false, reason: "unreachable", detail: LINK_CHECK_REFUSED_DETAIL };
    for (const url of [
      "https://127.0.0.1/", "https://localhost/", "https://10.1.2.3/", "https://172.20.0.5/", "https://192.168.1.10/", "https://169.254.169.254/latest/meta-data/",
      "https://100.64.0.1/", "https://0.0.0.0/", "https://[::1]/", "https://[fd12::1]/", "https://[fe80::1]/", "https://[::ffff:10.0.0.1]/",
      "https://worker.railway.internal/healthz", "https://postgres/", "https://board.example:8443/job", "http://board.example/job", "https://user:pw@board.example/job",
      "https://metadata.example/", "https://six.example/", "https://rebind.example/job", "https://unknown.example/",
    ]) expect(await real.verify(url, title), url).toEqual(refused);
    // a public page that redirects inside is refused at the hop, never fetched there
    expect(await real.verify("https://board.example/moved", title)).toEqual(refused);
    expect(await real.verify("https://board.example/to-metadata", title)).toEqual(refused);
    expect(fetched.some((u) => /10\.0\.0\.7|169\.254/.test(u))).toBe(false);
    // a board may send the browser on to plain http on the standard port; a redirect loop gives up
    expect(await real.verify("https://board.example/to-http", title)).toEqual({ ok: true });
    expect(await real.verify("https://board.example/loop", title)).toMatchObject({ ok: false, reason: "unreachable" });
    expect(fetched.filter((u) => u === "https://board.example/loop").length).toBe(6);
    // nothing was ever fetched on a refused host
    expect(fetched.every((u) => u.startsWith("https://board.example/") || u === "http://board.example/job")).toBe(true);
  });

  it("classifies addresses: every private, local and reserved range is refused, public ones pass", () => {
    for (const a of ["10.0.0.1", "127.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::", "::1", "fc00::1", "fdff::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:192.168.1.1", "64:ff9b::10.0.0.1", "2001:db8::1", "not an address"]) expect(isNonPublicAddress(a), a).toBe(true);
    for (const a of ["93.184.215.14", "8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::8.8.8.8"]) expect(isNonPublicAddress(a), a).toBe(false);
  });
});
