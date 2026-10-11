/**
 * Words written for an email or a text, read on a web page (polish list): "Reply HUMAN at any time", "This message was
 * sent by the hiring team…", "Reply STOP to opt out". On the conversation's own pages a person is one press away, so
 * those sentences give way to the page's own way of reaching one. The stored wording (the packet, the transcript) is
 * left as it is; only what the page shows changes. The legal AI notice is never touched.
 */

/** What the conversation's pages say instead, wherever the "I'd rather talk to a person" button is on the page. */
export const PERSON_ON_THE_WEB = "Press \"I'd rather talk to a person\" at any time.";
/** And on a conversation that has closed, where the button is gone. */
export const PERSON_BY_EMAIL = "To reach a person, reply to any of our emails.";

const EMAIL_ONLY: RegExp[] = [
  // the HUMAN keyword, by reply or by text: on a web page the button does it
  /\b(?:[Rr]epl(?:y|ying)|[Tt]ext(?:ing)?|[Ss]end(?:ing)?)\b.*\bHUMAN\b/,
  // the texting keywords
  /\b(?:[Rr]eply|[Tt]ext)\s+STOP\b|\bSTOP to (?:opt out|end texts)\b/,
  // an email's own footer
  /^This (?:message|email|text) (?:was|is) (?:sent|written)\b/i,
];

/**
 * `text` with every sentence meant only for an email or a text taken out. `instead` takes the place of the first one
 * (once), so a line that told the candidate how to reach a person still does. Line breaks are kept.
 */
export function forTheWeb(text: string, instead: string | null = null): string {
  let used = false;
  const lines = text.split("\n").map((line) =>
    line
      .split(/(?<=[.!?])\s+/)
      .flatMap((sentence) => {
        if (!EMAIL_ONLY.some((re) => re.test(sentence.trim()))) return [sentence];
        if (instead && !used) {
          used = true;
          return [instead];
        }
        return [];
      })
      .join(" ")
      .trimEnd(),
  );
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
