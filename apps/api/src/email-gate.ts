import { raiseAlertOnce } from "@ros/core";
import type { Db } from "@ros/db";

/**
 * The fake email adapter in production (staging before Postmark is set up): it keeps each email in the process's memory
 * and reports it sent, so the company check to ITS, every email to a candidate and every email to a hiring team goes
 * nowhere while the pages say it went. Both processes send email (the app some at once, the worker the outbox), so
 * whichever boots first warns and raises one `email.fake` alert, standing until a person resolves it; each later boot
 * only warns. Keyed off the adapter actually in use, not the variable's spelling: anything but "postmark" is the fake
 * (packages/integrations/src/registry.ts). Never outside production, and never fatal to the boot: a failure to raise is
 * logged.
 */
export async function checkEmailForProduction(db: Db, input: { nodeEnv: string; role: string; emailStatus: string; emailId: string }): Promise<{ raised: boolean }> {
  if (input.nodeEnv !== "production" || input.emailStatus !== "fake") return { raised: false };
  console.warn(`[email] production is running with the fake email adapter on the ${input.role}: no email is really sent. Set EMAIL_PROVIDER=postmark with POSTMARK_SERVER_TOKEN (to-do item 14, docs/spec/17-staging-handoff.md)`);
  try {
    const alert = await raiseAlertOnce(db, {
      kind: "email.fake",
      severity: "high",
      title: "Emails are not being sent",
      body: "Email is not set up yet, so no email leaves the system, even though the pages say it was sent. That includes the company check sent to ITS, every email to candidates (their links, interview times and updates) and every email to hiring teams. Set up Postmark (to-do item 14: EMAIL_PROVIDER=postmark and POSTMARK_SERVER_TOKEN in Vercel and on the Railway worker), then resolve this alert.",
      details: { provider: input.emailId, process: input.role },
    });
    return { raised: alert.created };
  } catch (err) {
    console.warn(`[email] could not raise the alert: ${err instanceof Error ? err.message : String(err)}`);
    return { raised: false };
  }
}
