/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */

/**
 * The job description as the job page shows it (plan D10): headings and bullet lists only, everything else plain text.
 * Descriptions come from the assistant (plain paragraphs today), an owner's edit, or a pasted ad, so the few shapes
 * people actually type are read: "## Heading", a line in **bold** or ending in a colon on its own, and lines starting
 * with -, *, • or 1. as list items. Nothing is ever passed through as markup: every block is text the page escapes, so
 * an ad pasted with HTML in it shows the tags as words and runs nothing.
 */
export type DescriptionBlock = { kind: "heading"; text: string } | { kind: "paragraph"; text: string } | { kind: "list"; ordered: boolean; items: string[] };

const HASH_HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const BOLD_LINE = /^\s*(?:\*\*|__)([^*_]{1,80}?)(?:\*\*|__)\s*:?\s*$/;
/** A short line ending in a colon ("What you will do:"): at most eight words and no sentence before it. */
const COLON_HEADING = /^\s*([A-Z][^.!?:]{1,60}):\s*$/;
const BULLET = /^\s*[-*•–·]\s+(.+)$/;
const NUMBERED = /^\s*\d{1,2}[.)]\s+(.+)$/;

/** Markdown emphasis and code marks taken out; the words stay. */
function plain(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/`([^`]*)`/g, "$1").replace(/\s+/g, " ").trim();
}

export function descriptionBlocks(text: string): DescriptionBlock[] {
  const blocks: DescriptionBlock[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const endPara = () => {
    if (para.length) blocks.push({ kind: "paragraph", text: para.join("\n") });
    para = [];
  };
  const endList = () => {
    if (list?.items.length) blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
    list = null;
  };
  for (const raw of (text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    if (!raw.trim()) {
      endPara();
      endList();
      continue;
    }
    const heading = raw.match(HASH_HEADING) ?? raw.match(BOLD_LINE) ?? raw.match(COLON_HEADING);
    const headingText = heading ? plain(heading[1]).replace(/:$/, "") : "";
    if (headingText && headingText.split(" ").length <= 8) {
      endPara();
      endList();
      blocks.push({ kind: "heading", text: headingText });
      continue;
    }
    const bullet = raw.match(BULLET);
    const numbered = bullet ? null : raw.match(NUMBERED);
    const item = bullet ?? numbered;
    if (item && plain(item[1])) {
      endPara();
      const ordered = !bullet;
      if (list && list.ordered !== ordered) endList();
      if (!list) list = { ordered, items: [] };
      list.items.push(plain(item[1]));
      continue;
    }
    if (list) {
      // An indented line under a list item carries on that item; anything else ends the list.
      if (/^\s{2,}\S/.test(raw)) {
        list.items[list.items.length - 1] = `${list.items[list.items.length - 1]} ${plain(raw)}`;
        continue;
      }
      endList();
    }
    para.push(plain(raw));
  }
  endPara();
  endList();
  return blocks;
}

/** The first words of the description, for the careers list and the link-preview text: no headings, no list marks. */
export function descriptionExcerpt(text: string, max = 180): string {
  const words = descriptionBlocks(text).flatMap((b) => (b.kind === "heading" ? [] : b.kind === "paragraph" ? [b.text] : b.items)).join(" ").replace(/\s+/g, " ").trim();
  if (words.length <= max) return words;
  const cut = words.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : words.slice(0, max)).replace(/[\s,;:.-]+$/, "")}…`;
}

/** The description as blocks under the page's own "About the job" heading, so its own headings are one level down. */
export function Description(props: { text: string }) {
  return (
    <div class="desc">
      {descriptionBlocks(props.text).map((b) => {
        if (b.kind === "heading") return <h3>{b.text}</h3>;
        if (b.kind === "paragraph") return <p>{b.text}</p>;
        return b.ordered ? <ol>{b.items.map((i) => <li>{i}</li>)}</ol> : <ul>{b.items.map((i) => <li>{i}</li>)}</ul>;
      })}
    </div>
  );
}
