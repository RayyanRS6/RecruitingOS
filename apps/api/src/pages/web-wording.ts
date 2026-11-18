import { HUMAN_KEYWORD, replaceSentences } from "@ros/agents";

/**
 * Words written for an email, read on a web page: "Reply HUMAN at any time", "This message was sent by the hiring
 * team…". On the AI interview's own pages a person is one press away, so those sentences give way to the page's own way
 * of reaching one. The stored wording (the job record, the transcript) is left as it is; only what the page shows
 * changes. The legal AI notice is never touched.
 */

/** What the AI interview's pages say instead, wherever the "I'd rather talk to a person" button is on the page. */
export const PERSON_ON_THE_WEB = "Press \"I'd rather talk to a person\" at any time.";
/** And on an AI interview that has closed, where the button is gone. */
export const PERSON_BY_EMAIL = "To reach a person, reply to any of our emails.";

/** Sentences meant only for an email: the reply keyword, and an email's own footer. */
const EMAIL_ONLY: RegExp[] = [HUMAN_KEYWORD, /^This (?:message|email|text) (?:was|is) (?:sent|written)\b/i];

/**
 * `text` with every sentence meant only for an email taken out. `instead` takes the place of the first one (once), so a
 * line that told the candidate how to reach a person still does. Line breaks are kept.
 */
export function forTheWeb(text: string, instead: string | null = null): string {
  return replaceSentences(text, EMAIL_ONLY, instead);
}
