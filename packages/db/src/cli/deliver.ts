import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Hands secrets to the person without ever printing them (founder request, 22 Sep 2026, after a screenshot exposed
 * the two connection strings): each value goes to the clipboard in turn, the person pastes it into the 1Password
 * field named for it and presses Return, and the clipboard is cleared at the end, or after a timeout if nobody
 * answers. Nothing here writes a value to standard output, a log, or a file.
 */
export type Delivery = { name: string; value: string; where: string };
export type DeliveryIo = {
  copy(text: string): Promise<void>;
  clear(): Promise<void>;
  /** Waits for a line; resolves with null when the input ends without one (the window closed, or no terminal). */
  ask(prompt: string): Promise<string | null>;
  say(line: string): void;
  timeoutMs?: number;
};

export async function deliverToClipboard(values: Delivery[], io: DeliveryIo): Promise<{ delivered: string[]; timedOut: boolean }> {
  const timeoutMs = io.timeoutMs ?? 10 * 60_000;
  const delivered: string[] = [];
  io.say("Each value is placed on the clipboard in turn, never shown. If Universal Clipboard is on, it also reaches your other Apple devices until it is cleared.");
  for (const v of values) {
    await io.copy(v.value);
    io.say(`${v.name} is on the clipboard. In 1Password (vault: Recruiting OS Staging), paste it into the field ${v.name} of the item "Recruiting OS staging database". ${v.where}`);
    const answered = await Promise.race([io.ask(`Press Return here once ${v.name} is pasted: `).then((line) => line !== null), new Promise<false>((res) => setTimeout(() => res(false), timeoutMs).unref?.())]);
    if (!answered) {
      await io.clear();
      io.say(`No answer: the clipboard was cleared and ${v.name} was not delivered. Run the setup again to set fresh passwords and deliver again.`);
      return { delivered, timedOut: true };
    }
    delivered.push(v.name);
  }
  await io.clear();
  io.say("Clipboard cleared. Nothing was printed; the values exist only in 1Password now.");
  return { delivered, timedOut: false };
}

/** The clipboard on this Mac: the value travels on pbcopy's standard input, never as an argument. */
export function macClipboardIo(): DeliveryIo {
  const pipe = (text: string) =>
    new Promise<void>((resolve, reject) => {
      const p = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy exited with ${code}`))));
      p.stdin.end(text);
    });
  // Lines are queued as they arrive, so an answer typed (or piped) before the question is asked still counts, and a
  // closed input (the window closed, no terminal) answers null instead of throwing.
  const lines: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;
  let closed = false;
  let rl: ReturnType<typeof createInterface> | null = null;
  const ensure = () => {
    if (rl) return;
    rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (line) => { if (waiter) { const w = waiter; waiter = null; w(line); } else lines.push(line); });
    rl.on("close", () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(null); } });
  };
  return {
    copy: pipe,
    clear: () => pipe(""),
    ask: (prompt) => {
      ensure();
      process.stdout.write(prompt);
      if (lines.length) return Promise.resolve(lines.shift()!);
      if (closed) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => { waiter = resolve; });
    },
    say: (line) => console.log(line),
  };
}
