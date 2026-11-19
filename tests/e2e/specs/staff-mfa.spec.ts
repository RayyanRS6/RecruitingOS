import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { expectAccessible, signIn, signInWithoutSecondFactor, skipWithoutFakeSignIn } from "./helpers";

/**
 * The staff second factor in a real browser: Microsoft vouches for an ITS staff member, the authenticator page enrols
 * an app on the first sign-in, a backup is offered, and every later sign-in asks for a code. The code is computed here
 * exactly as an authenticator app would, from the key the page shows. Google is refused for a staff address.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}
function totp(secret: string, now = Date.now()): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const h = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1]! & 0x0f;
  const bin = ((h[o]! & 0x7f) << 24) | ((h[o + 1]! & 0xff) << 16) | ((h[o + 2]! & 0xff) << 8) | (h[o + 3]! & 0xff);
  return String(bin % 1_000_000).padStart(6, "0");
}

test.describe("staff second factor", () => {
  skipWithoutFakeSignIn();
  test("first sign-in enrols an authenticator, offers a backup, and the next sign-in asks for a code", async ({ page, baseURL }) => {
    const email = `staff-${Date.now().toString(36)}@identifiedtalent.com`;
    await signInWithoutSecondFactor(page, { email, name: "Sam Staff" });
    await expect(page.getByRole("heading", { name: "Set up your authenticator app" })).toBeVisible();
    await expectAccessible(page, "authenticator enrolment");
    const key = (await page.locator("#setup-key").textContent())!.replace(/\s+/g, "");
    expect(key.length).toBeGreaterThanOrEqual(32);
    // no session exists before the code
    expect((await page.request.get(`${baseURL}/api/v1/auth/me`)).status()).toBe(401);

    const wrong = totp(key) === "000000" ? "111111" : "000000";
    await page.getByLabel("Six-digit code").fill(wrong);
    await page.getByRole("button", { name: "Confirm and sign in" }).click();
    await expect(page.getByRole("alert")).toContainText("That code is not right");
    await expectAccessible(page, "authenticator enrolment with an error");

    await page.getByLabel("Six-digit code").fill(totp(key));
    await page.getByRole("button", { name: "Confirm and sign in" }).click();
    await expect(page.getByRole("heading", { name: "You are signed in." })).toBeVisible();
    await expectAccessible(page, "backup authenticator offer");
    const me = (await (await page.request.get(`${baseURL}/api/v1/auth/me`)).json()) as { auth: { provider: string; aal: string } };
    expect(me.auth).toMatchObject({ provider: "azure", aal: "aal2" });

    await page.getByRole("button", { name: "Not now" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/api/"));
    // the first page may still send the person on (a staff member with no company goes to the company details): let it
    // settle, or the next sign-in's page.goto is interrupted by that navigation on a loaded dev server
    await page.waitForLoadState("networkidle");

    // Sign out, sign in again: the enrolled authenticator is challenged and no key is shown.
    expect((await page.request.post(`${baseURL}/api/v1/auth/logout`)).ok()).toBeTruthy();
    await signInWithoutSecondFactor(page, { email, name: "Sam Staff" });
    await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
    await expect(page.locator("#setup-key")).toHaveCount(0);
    await expectAccessible(page, "authenticator code entry");
    await page.getByLabel("Six-digit code").fill(totp(key));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "You are signed in." })).toBeVisible();

    // The backup authenticator is enrolled while the level-2 token from this sign-in is still at hand.
    await page.getByRole("link", { name: "Add a backup authenticator" }).click();
    await expect(page.getByRole("heading", { name: "Add a backup authenticator" })).toBeVisible();
    await expectAccessible(page, "backup authenticator enrolment");
    const backupKey = (await page.locator("#setup-key").textContent())!.replace(/\s+/g, "");
    expect(backupKey).not.toBe(key);
    await page.getByLabel("Six-digit code").fill(totp(backupKey));
    await page.getByRole("button", { name: "Confirm backup authenticator" }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/api/"));
    const again = (await (await page.request.get(`${baseURL}/api/v1/auth/me`)).json()) as { auth: { aal: string } };
    expect(again.auth.aal).toBe("aal2");
  });

  test("five wrong codes end the attempt and no session exists afterwards", async ({ page, baseURL }) => {
    const email = `lockout-${Date.now().toString(36)}@identifiedtalent.com`;
    await signInWithoutSecondFactor(page, { email, name: "Lock Out" });
    const key = (await page.locator("#setup-key").textContent())!.replace(/\s+/g, "");
    const wrong = totp(key) === "000000" ? "111111" : "000000";
    for (let i = 1; i <= 4; i++) {
      await page.getByLabel("Six-digit code").fill(wrong);
      await page.getByRole("button", { name: "Confirm and sign in" }).click();
      await expect(page.getByRole("alert")).toContainText(i === 4 ? "last try" : "That code is not right");
    }
    await page.getByLabel("Six-digit code").fill(wrong);
    await page.getByRole("button", { name: "Confirm and sign in" }).click();
    await expect(page).toHaveURL(/\/login\?error=mfa_failed/);
    await expect(page.getByRole("alert")).toContainText("too many times");
    expect((await page.request.get(`${baseURL}/api/v1/auth/me`)).status()).toBe(401);
  });

  test("Google is refused for a staff address with plain guidance; Microsoft without a second factor continues on the authenticator page; with it, staff are signed in", async ({ page }) => {
    const staff = { email: `policy-${Date.now().toString(36)}@identifiedtalent.com`, name: "Pat Staff" };
    await signIn(page, { ...staff, provider: "google" });
    await expect(page.getByRole("alert").filter({ hasText: /Microsoft 365/ })).toBeVisible();
    await expectAccessible(page, "sign-in refused for a staff address");
    // a staff sign-in without a second factor is not refused: it continues on the authenticator page, with no session yet
    await signInWithoutSecondFactor(page, staff);
    await expect(page.getByRole("heading", { name: "Set up your authenticator app" })).toBeVisible();
    expect((await page.request.get("/api/v1/auth/me")).status()).toBe(401);
    await page.getByRole("button", { name: "Cancel and return to sign-in" }).click();
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, { ...staff, provider: "azure", aal2: true });
    await expect(page).not.toHaveURL(/\/login/);
    const me = (await (await page.request.get("/api/v1/auth/me")).json()) as { auth: { provider: string; aal: string; mfaVerifiedAt: string | null }; user: { platformRole: string } };
    expect(me.auth).toMatchObject({ provider: "azure", aal: "aal2" });
    expect(me.auth.mfaVerifiedAt).toBeTruthy();
    // a platform role is granted by an administrator, never by the sign-in itself: a new staff account starts without one
    expect(me.user.platformRole).toBe("none");
    await page.waitForLoadState("networkidle"); // the first page may still be redirecting
    await expectAccessible(page, "first page after a staff sign-in");
  });
});
