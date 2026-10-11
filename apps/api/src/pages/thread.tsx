/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { and, desc, eq, gte, inArray, like, or } from "drizzle-orm";
import { DecisionWording } from "@ros/contracts";
import { decisionTemplateKey } from "@ros/agents";
import { communications, type Queryable } from "@ros/db";

/**
 * The conversation about one application as the candidate sees it on their status page (plan G7): every message that
 * actually reached them and their own replies by email or text, oldest first. A message still waiting in the outbox,
 * held for the company check, taken back with Undo or never delivered is not listed. The screening conversation's
 * answers stay on its own page. There is no reply box: the status link never expires, so a reply goes by email, where
 * the address it comes from is the proof of who wrote it.
 */

/** Messages shown at most; older ones are counted, not listed. */
export const THREAD_LIMIT = 30;
const REACHED = ["sent", "delivered"];

export type ThreadMessage = { id: string; from: "team" | "candidate"; channel: "email" | "sms"; subject: string | null; text: string; at: string };

/** The latest messages about the application (at most THREAD_LIMIT), oldest first, and whether older ones were left out. */
export async function threadOf(q: Queryable, applicationId: string): Promise<{ messages: ThreadMessage[]; more: boolean }> {
  const rows = await q
    .select({ id: communications.id, direction: communications.direction, channel: communications.channel, subject: communications.subject, bodyText: communications.bodyText, createdAt: communications.createdAt })
    .from(communications)
    .where(and(eq(communications.applicationId, applicationId), inArray(communications.channel, ["email", "sms"]), or(and(eq(communications.direction, "outbound"), inArray(communications.status, REACHED)), eq(communications.direction, "inbound"))))
    .orderBy(desc(communications.createdAt), desc(communications.id))
    .limit(THREAD_LIMIT + 1);
  const messages = rows.slice(0, THREAD_LIMIT).reverse().map((r): ThreadMessage => {
    const mine = r.direction === "inbound";
    return { id: r.id, from: mine ? "candidate" : "team", channel: r.channel === "sms" ? "sms" : "email", subject: mine ? null : r.subject, text: mine ? ownWords(r.bodyText) : r.bodyText.trim(), at: r.createdAt };
  });
  return { messages, more: rows.length > THREAD_LIMIT };
}

/**
 * The candidate's own words in a reply, without the earlier messages their email program quoted under it ("On … wrote:",
 * lines starting with ">", "-----Original Message-----", an Outlook "From: … Sent: …" block). The whole reply when
 * nothing would be left.
 */
export function ownWords(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const outlook = (i: number) => /^From:\s/.test(lines[i].trim()) && lines.slice(i + 1, i + 4).some((l) => /^(Sent|Date):\s/.test(l.trim()));
  let cut = -1;
  for (let i = 0; i < lines.length && cut < 0; i++) {
    const l = lines[i].trim();
    if (/^>/.test(l) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(l) || outlook(i)) cut = i;
    else if (/\bwrote:$/.test(l)) cut = /^On\b/.test(l) ? i : i > 0 && /^On\b/.test(lines[i - 1].trim()) ? i - 1 : i;
  }
  const mine = (cut < 0 ? lines : lines.slice(0, cut)).join("\n").trim();
  return mine || text.trim();
}

const WORDING_BY_TEMPLATE = new Map<string, DecisionWording>(DecisionWording.options.map((w) => [decisionTemplateKey(w), w]));

/** The approved wording a decision message used (plan G6), from the template it was recorded under; null for any other message. */
export function wordingOfTemplate(templateKey: string | null | undefined): DecisionWording | null {
  if (!templateKey?.startsWith("disposition:")) return null;
  // A decision message recorded before the wordings existed used the standard one.
  return WORDING_BY_TEMPLATE.get(templateKey) ?? "v1";
}

/**
 * The wording of the decision message that reached the candidate for the decision made at `decidedAt`, or null when no
 * message told them (a person told them themselves, or the decision predates tracking).
 */
export async function toldWording(q: Queryable, input: { applicationId: string; decidedAt: string }): Promise<DecisionWording | null> {
  const [row] = await q
    .select({ templateKey: communications.templateKey })
    .from(communications)
    .where(and(eq(communications.applicationId, input.applicationId), eq(communications.direction, "outbound"), like(communications.templateKey, "disposition:%"), inArray(communications.status, REACHED), gte(communications.createdAt, input.decidedAt)))
    .orderBy(desc(communications.createdAt))
    .limit(1);
  return wordingOfTemplate(row?.templateKey);
}

/**
 * The messages as a conversation, in the look of the screening conversation: the hiring team's on the left in a light
 * box, the candidate's own on the right in near-black. Each says who wrote it and when, in words a screen reader reads
 * too; an email shows its subject.
 */
export const THREAD_CSS = `
.thread { display: flex; flex-direction: column; gap: 10px; margin: 20px 0; padding: 0; list-style: none; }
.msg { max-width: 88%; padding: 12px 16px; border-radius: 16px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.assistant, .msg.team { align-self: flex-start; background: var(--ground); border: 1px solid var(--line); color: var(--ink); border-bottom-left-radius: 6px; }
.msg.candidate { align-self: flex-end; background: var(--ink); color: var(--ground); border-bottom-right-radius: 6px; }
.msg.candidate p, .msg.candidate strong { color: inherit; }
.msg.system { align-self: center; background: transparent; color: var(--ink-3); font-size: 14px; }
.msg-head { margin: 0 0 4px; color: var(--ink-3); font-size: 13.5px; font-weight: 600; white-space: normal; }
.msg-head time { font-weight: 400; }
.msg-subject { margin: 0 0 6px; color: var(--ink); font-weight: 600; white-space: normal; }
.msg-body { margin: 0; color: inherit; }
@media (max-width: 600px) { .msg { max-width: 94%; } }
`;

/** "Oct 9, 2026, 3:04 PM PDT" in the candidate's time zone (the company's when theirs is not known). */
function when(at: string, timeZone: string): string {
  const d = new Date(at);
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
  }
}

export function MessageThread(props: { messages: ThreadMessage[]; more: boolean; companyName: string; timeZone: string }) {
  if (!props.messages.length) return null;
  return (
    <section aria-labelledby="messages">
      <h2 id="messages">Messages about your application</h2>
      <p class="meta">What we sent you and what you wrote back, oldest first{props.more ? `; the latest ${THREAD_LIMIT} are shown` : ""}. To write to the team, reply to any of our emails.</p>
      <ol class="thread">
        {props.messages.map((m) => {
          const who = m.from === "candidate" ? "You" : props.companyName;
          return (
            <li class={`msg ${m.from}`}>
              <p class="msg-head">{who}{m.channel === "sms" ? " (text message)" : ""}<span aria-hidden="true"> · </span><span class="sr-only">, </span><time datetime={new Date(m.at).toISOString()}>{when(m.at, props.timeZone)}</time></p>
              {m.subject ? <p class="msg-subject">{m.subject}</p> : null}
              <p class="msg-body">{m.text}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
