import { describe, expect, it } from "vitest";
import { ApiError } from "../../apps/web/src/api/client";
import { ACCESS_LOOK_MS, lookAtAccess, verticalWords, websiteHref } from "../../apps/web/src/company-setup";

/**
 * First sign-in asks for approval (SIGNUP_MODE=approval, 6 November 2026): what the screens around a request rest on, free
 * of React. The look the waiting screen takes every 30 seconds must never break the page, and it goes Home by itself as soon
 * as there is an active company; what a stranger typed as a website becomes a link only when it is really one.
 */
const request = { status: "requested" as const, companyName: "Harbor Dental", email: "sam@stranger.test", emailedAt: null };

/** A stand-in for api.get: what each path answers; a function answers by throwing what it throws. */
function server(answers: Record<string, unknown | (() => never)>) {
  const asked: string[] = [];
  const get = async (path: string): Promise<unknown> => {
    asked.push(path);
    const answer = answers[path];
    return typeof answer === "function" ? (answer as () => never)() : answer;
  };
  return { get, asked };
}

describe("the waiting screen's look", () => {
  it("is every 30 seconds", () => {
    expect(ACCESS_LOOK_MS).toBe(30_000);
  });

  it("says Home as soon as there is an active company, and asks nothing more", async () => {
    const s = server({ "/api/v1/auth/me": { activeCompanyId: "co1" } });
    expect(await lookAtAccess(s.get)).toEqual({ home: true });
    expect(s.asked).toEqual(["/api/v1/auth/me"]);
  });

  it("reads where the request stands while there is none, so a decline reaches the screen without a reload", async () => {
    const declined = { ...request, status: "declined" as const };
    expect(await lookAtAccess(server({ "/api/v1/auth/me": { activeCompanyId: null }, "/api/v1/auth/config": { signup: { contact: "recruiting@its.example", request: declined } } }).get)).toEqual({ home: false, request: declined, contact: "recruiting@its.example" });
  });

  it("finds nothing, and never rejects, whatever goes wrong: an expired sign-in, a limit, no network, a page that is not JSON, an empty answer", async () => {
    const failures: Array<() => never> = [
      () => { throw new ApiError(401, "unauthorized", "Not signed in."); },
      () => { throw new ApiError(429, "rate_limited", "Too many requests."); },
      () => { throw new ApiError(500, "error", "Request failed (500)"); },
      () => { throw new TypeError("Failed to fetch"); },
      () => { throw new SyntaxError("Unexpected token < in JSON"); },
    ];
    for (const failure of failures) {
      const s = server({ "/api/v1/auth/me": failure });
      await expect(lookAtAccess(s.get)).resolves.toBeNull();
      // an expired sign-in is not asked about twice
      expect(s.asked).toEqual(["/api/v1/auth/me"]);
      // the second read failing is the same
      await expect(lookAtAccess(server({ "/api/v1/auth/me": { activeCompanyId: null }, "/api/v1/auth/config": failure }).get)).resolves.toBeNull();
    }
    await expect(lookAtAccess(server({ "/api/v1/auth/me": null, "/api/v1/auth/config": null }).get)).resolves.toBeNull();
  });

  it("never turns the screen back into the form: signed out, the configuration has no request, and that is a look that found nothing", async () => {
    expect(await lookAtAccess(server({ "/api/v1/auth/me": { activeCompanyId: null }, "/api/v1/auth/config": { signup: { mode: "approval", allowed: false, contact: "x@y.test", door: "none" } } }).get)).toBeNull();
  });
});

describe("what a stranger typed as a website", () => {
  it("links only as plain http or https, and the link is the parsed address", () => {
    expect(websiteHref("https://harbor.example")).toBe("https://harbor.example/");
    expect(websiteHref("http://harbor.example/about?x=1")).toBe("http://harbor.example/about?x=1");
    expect(websiteHref("  HTTPS://Harbor.Example  ")).toBe("https://harbor.example/");
  });

  it("stays plain text otherwise: no scheme, another scheme, a scheme hidden with a line break, or a name and password in front of the real host", () => {
    for (const typed of ["harbor.example", "www.harbor.example", "javascript:alert(1)", "JAVASCRIPT:alert(1)", "java\nscript:alert(1)", " javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x", "ftp://harbor.example", "mailto:a@b.test", "file:///etc/passwd", "//harbor.example", "https://good.example@evil.example", "https://user:pw@evil.example", "not a website", "", null, undefined]) {
      expect(websiteHref(typed), String(typed)).toBeNull();
    }
  });
});

describe("a kind of business", () => {
  it("reads in the form's own words, and one the form does not offer reads as it was sent", () => {
    expect(verticalWords("dental")).toBe("Dental practice or group");
    expect(verticalWords("professional_services")).toBe("Professional services");
    expect(verticalWords("beekeeping")).toBe("beekeeping");
  });
});
