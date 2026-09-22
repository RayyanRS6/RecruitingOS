/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { getContext } from "hono/context-storage";
import type { Vars } from "../middleware/session";

/** The nonce the policy middleware issued for this request; empty outside a request (unit renders). */
export function currentNonce(): string {
  try { return getContext<Vars>().get("nonce") ?? ""; } catch { return ""; }
}

/**
 * Candidate-facing pages are server-rendered, mobile-first, and need no JavaScript.
 * The design tokens mirror packages/ui so the candidate sees the same product the owner does.
 */
export const CSS = `
:root{--bg:#F5F7F6;--bg2:#FFFFFF;--ink:#17211E;--ink2:#4A5854;--ink3:#5F6D68;--line:#D6DEDA;--accent:#2F4BE0;--accent-ink:#2238B8;--soft:#E5E9FF;--warn:#8A4A00;--warn-bg:#F7E6D0;--radius:10px}
@media(prefers-color-scheme:dark){:root{--bg:#121816;--bg2:#182120;--ink:#E5ECE9;--ink2:#B0BDB8;--ink3:#7F8D88;--line:#2B3835;--accent:#7F93FF;--accent-ink:#A6B4FF;--soft:#1E2650;--warn:#E8B57C;--warn-bg:#3A2A14}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 "IBM Plex Sans",-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 18px 64px}
h1{font-size:28px;line-height:1.15;margin:0 0 6px;letter-spacing:-.01em}h2{font-size:18px;margin:26px 0 8px}p{margin:0 0 12px;color:var(--ink2)}
.meta{color:var(--ink3);font-size:14px;margin-bottom:18px}.chips{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 18px}
.chip{background:var(--soft);color:var(--accent-ink);border-radius:999px;padding:4px 10px;font-size:13px;font-weight:600}
.card{background:var(--bg2);border:1px solid var(--line);border-radius:var(--radius);padding:18px;margin:14px 0}
label{display:block;font-weight:600;margin:14px 0 6px}input[type=text],input[type=email],input[type=tel],textarea,select{width:100%;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--bg2);color:var(--ink);font:inherit}
.check{display:flex;gap:10px;align-items:flex-start;margin:12px 0;font-weight:400}.check input{margin-top:4px;width:18px;height:18px}
.btn{display:inline-block;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:14px 20px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;width:100%;text-align:center}
.btn:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.notice{font-size:13px;color:var(--ink3);border-left:3px solid var(--line);padding:6px 12px;margin:14px 0}
.steps{padding-left:20px;color:var(--ink2)}.steps li{margin:6px 0}
.status{display:grid;gap:8px}.status div{display:flex;justify-content:space-between;border-bottom:1px solid var(--line);padding:8px 0}
.err{background:var(--warn-bg);color:var(--warn);border-radius:8px;padding:12px;margin:12px 0}
a{color:var(--accent-ink)}small{color:var(--ink3)}
`;

/** JSON for a script element: "<", ">" and the line separators are escaped so owner-written text can never close the element. */
export function safeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export const Layout: FC<{ title: string; children?: unknown; jsonLd?: Record<string, unknown>; nonce?: string }> = (props) => {
  const nonce = props.nonce ?? currentNonce();
  return (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{props.title}</title>
      <style nonce={nonce} dangerouslySetInnerHTML={{ __html: CSS }} />
      {props.jsonLd ? <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: safeJsonLd(props.jsonLd) }} /> : null}
    </head>
    <body>
      <main>{props.children}</main>
    </body>
  </html>
);
};
