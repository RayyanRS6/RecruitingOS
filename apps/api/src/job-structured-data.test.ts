import { describe, expect, it } from "vitest";
import type { RolePacket } from "@ros/contracts";
import { jobPostingJsonLd, jobValidThrough, schemaEmploymentType, type JobPostingJsonLdInput } from "./pages/job-structured-data";

const packet = {
  identity: { title: "Registered Dental Hygienist", locations: [{ address1: "1 Main St", city: "Irvine", region: "CA", postalCode: "92618", country: "US" }], employmentType: "full_time", remotePolicy: "onsite" },
  compensation: { basis: "hourly", currency: "USD", min: 45, max: 55, discloseRange: true },
  description: { publicJobDescription: "Join a friendly practice in Irvine. You will provide preventive care and patient education." },
} as unknown as RolePacket;

const input: Omit<JobPostingJsonLdInput, "datePosted"> = { roleId: "role-1", companyName: "Brightline Dental Group", packet, jobUrl: "https://jobs.example.com/careers/brightline/jobs/role-1" };

describe("the job page's JobPosting structured data", () => {
  it("maps employment types to schema.org tokens", () => {
    expect(schemaEmploymentType("full_time")).toBe("FULL_TIME");
    expect(schemaEmploymentType("part_time")).toBe("PART_TIME");
    expect(schemaEmploymentType("contract")).toBe("CONTRACTOR");
    expect(schemaEmploymentType("temporary")).toBe("TEMPORARY");
    expect(schemaEmploymentType("internship")).toBe("INTERN");
    expect(schemaEmploymentType("per_diem")).toBe("PER_DIEM");
    expect(schemaEmploymentType("gig")).toBe("OTHER");
  });

  it("validThrough is only ever a real date: the closing day, else the day applications stopped, else a set closing date; an open job with none has none", () => {
    expect(jobValidThrough({})).toBeUndefined();
    expect(jobValidThrough({ closedAt: null, stoppedAt: null, closesOn: null })).toBeUndefined();
    expect(jobValidThrough({ closedAt: "2026-09-20T15:04:05.000Z" })).toBe("2026-09-20");
    expect(jobValidThrough({ stoppedAt: "2026-09-18T08:00:00.000Z" })).toBe("2026-09-18");
    expect(jobValidThrough({ closesOn: "2026-10-15" })).toBe("2026-10-15");
    // the closing day wins over everything; a stop wins over a planned date
    expect(jobValidThrough({ closedAt: "2026-09-20T15:04:05.000Z", stoppedAt: "2026-09-18T08:00:00.000Z", closesOn: "2026-10-15" })).toBe("2026-09-20");
    expect(jobValidThrough({ stoppedAt: "2026-09-18T08:00:00.000Z", closesOn: "2026-10-15" })).toBe("2026-09-18");
    // applications stopped by the closing date itself stop at the midnight after it, already the next day in UTC: the date is the last day
    expect(jobValidThrough({ stoppedAt: "2026-10-16T07:00:00.000Z", closesOn: "2026-10-15" })).toBe("2026-10-15");
  });

  it("an open job with a closing date tells Google that date", () => {
    const ld = jobPostingJsonLd({ ...input, datePosted: "2026-09-01", closesOn: "2026-10-31" });
    expect(ld.validThrough).toBe("2026-10-31");
    const stopped = jobPostingJsonLd({ ...input, datePosted: "2026-09-01", closesOn: "2026-10-31", stoppedAt: "2026-11-01T07:00:00.000Z" });
    expect(stopped.validThrough).toBe("2026-10-31");
  });

  it("names the company as the employer with its website and logo when known, and never emits CONTRACT or INTERNSHIP", () => {
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

  it("the pay range follows the page: the job record's choice by default, shown whenever the page must show it", () => {
    const hidden = { ...packet, compensation: { ...packet.compensation, discloseRange: false } } as RolePacket;
    expect(jobPostingJsonLd({ ...input, packet: hidden, datePosted: "2026-09-01" }).baseSalary).toBeUndefined();
    expect(jobPostingJsonLd({ ...input, packet: hidden, datePosted: "2026-09-01", showPay: true }).baseSalary).toMatchObject({ currency: "USD", value: { minValue: 45, maxValue: 55 } });
  });
});
