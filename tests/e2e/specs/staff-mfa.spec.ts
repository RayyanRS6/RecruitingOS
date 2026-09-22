import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./helpers";

/**
 * The staff second factor in a real browser (founder approval, 22 September 2026): Microsoft vouches for an ITS staff
 * member, the authenticator page enrols an app on the first sign-in, a backup is offered, and every later sign-in asks
 * for a code. The code is computed here exactly as an authenticator app would, from the key the page shows.
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

/** Microsoft sign-in through the fake consent page, without the second factor the fake would otherwise assert. */
async function microsoftSignInWithoutSecondFactor(page: Page, email: string) {
  await page.goto("/login");
  await page.getByRole("link", { name: "Continue with Microsoft" }).click();
  await expect(page.getByRole("heading", { name: /Sign in with/ })).toBeVisible();
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByLabel("Name").fill("Sam Staff");
  const mfa = page.getByLabel("Second factor verified (TOTP)");
  if (await mfa.isChecked()) await mfa.uncheck();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(/\/api\/v1\/auth\/mfa/);
}

test.describe("staff second factor", () => {
  test("first sign-in enrols an authenticator, offers a backup, and the next sign-in asks for a code", async ({ page, baseURL }) => {
    const email = `staff-${Date.now().toString(36)}@identifiedtalent.com`;
    await microsoftSignInWithoutSecondFactor(page, email);
    await expect(page.getByRole("heading", { name: "Set up your authenticator app" })).toBeVisible();
    await expectAccessible(page, "authenticator enrolment");
    const key = (await page.locator("#setup-key").textContent())!.replace(/\s+/g, "");
    expect(key.length).toBeGreaterThanOrEqual(32);

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

    // Sign out, sign in again: the enrolled authenticator is challenged and no key is shown.
    expect((await page.request.post(`${baseURL}/api/v1/auth/logout`)).ok()).toBeTruthy();
    await microsoftSignInWithoutSecondFactor(page, email);
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
});
