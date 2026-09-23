import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Hands secrets to the person without ever printing them (founder request, 22 Sep 2026, after a screenshot exposed
 * the two connection strings): each value goes to the clipboard in turn, the person pastes it into the 1Password
 * field named for it and confirms by typing "pasted", and the clipboard is cleared afterwards: at the end, after a
 * timeout, when the input closes, when the copy fails, or when the process is interrupted (Ctrl-C, the window
 * closing). Nothing here writes a value to standard output, a log, or a file. Keystrokes typed before a prompt
 * appears are ignored, so a stray Return cannot confirm a paste that never happened.
 */
export type Delivery = { name: string; value: string; where: string };
export type DeliveryIo = {
  copy(text: string): Promise<void>;
  clear(): Promise<void>;
  /** Waits for a line typed after the prompt; resolves with null when the input ends without one. */
  ask(prompt: string): Promise<string | null>;
  say(line: string): void;
  /** Releases the input so the process can end. */
  close(): void;
  timeoutMs?: number;
};

const CONFIRM = "pasted";

export async function deliverToClipboard(values: Delivery[], io: DeliveryIo): Promise<{ delivered: string[]; timedOut: boolean }> {
  const timeoutMs = io.timeoutMs ?? 10 * 60_000;
  const delivered: string[] = [];
  let cleared = false;
  const clear = async () => {
    if (cleared) return;
    cleared = true;
    await io.clear();
  };
  try {
    io.say("Each value is placed on the clipboard in turn, never shown. If a clipboard-history app is installed (Raycast, Alfred, Paste, Maccy), pause it now and clear its history afterwards: it would record the value. If Universal Clipboard is on, the value also reaches your other Apple devices until it is cleared.");
    for (const v of values) {
      await io.copy(v.value);
      io.say(`${v.name} is on the clipboard. In 1Password (vault: Recruiting OS Staging), paste it into the field ${v.name} of the item "Recruiting OS staging database". ${v.where}`);
      const deadline = Date.now() + timeoutMs;
      let confirmed = false;
      while (!confirmed) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const line = await Promise.race([io.ask(`Type ${CONFIRM} and press Return once ${v.name} is in 1Password: `), new Promise<undefined>((res) => setTimeout(() => res(undefined), remaining).unref?.())]);
        if (line === undefined) break; // timed out
        if (line === null) break; // input closed
        if (line.trim().toLowerCase() === CONFIRM) confirmed = true;
        else io.say(`Not yet: ${v.name} is still on the clipboard. Paste it into 1Password, then type ${CONFIRM} and press Return.`);
      }
      if (!confirmed) {
        await clear();
        io.say(`No confirmation: the clipboard was cleared and ${v.name} was not delivered. Run the setup again to set fresh passwords and deliver again.`);
        return { delivered, timedOut: true };
      }
      delivered.push(v.name);
    }
    await clear();
    io.say("Clipboard cleared. Nothing was printed. If a clipboard-history app is installed, clear its history too.");
    return { delivered, timedOut: false };
  } finally {
    await clear().catch(() => undefined);
    io.close();
  }
}

/** The clipboard on this Mac: the value travels on pbcopy's standard input, never as an argument. */
export function macClipboardIo(): DeliveryIo {
  const pipe = (text: string) =>
    new Promise<void>((resolve, reject) => {
      const p = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
      p.on("error", reject);
      p.stdin.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy exited with ${code}`))));
      p.stdin.end(text);
    });
  // An interrupted process still clears the clipboard, synchronously, before it dies.
  const onSignal = (signal: NodeJS.Signals) => {
    try { spawnSync("pbcopy", [], { input: "" }); } catch { /* nothing more can be done */ }
    console.log(`\nInterrupted (${signal}): the clipboard was cleared. Run the setup again to set fresh passwords and deliver again.`);
    process.exit(1);
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of signals) process.on(s, onSignal);
  // Lines count only when typed after the current prompt: anything buffered earlier is discarded. A closed input
  // (the window closed, no terminal) answers null instead of throwing.
  let waiter: ((line: string | null) => void) | null = null;
  let closed = false;
  let rl: ReturnType<typeof createInterface> | null = null;
  // Reading starts now, before the first value is copied, so keystrokes already in the terminal's buffer are
  // consumed and dropped while no prompt is waiting.
  rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => { if (waiter) { const w = waiter; waiter = null; w(line); } });
  rl.on("close", () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(null); } });
  return {
    copy: pipe,
    clear: () => pipe(""),
    ask: (prompt) => {
      process.stdout.write(prompt);
      if (closed) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => { waiter = resolve; });
    },
    say: (line) => console.log(line),
    close: () => {
      for (const s of signals) process.off(s, onSignal);
      rl?.close();
      process.stdin.pause();
    },
    timeoutMs: process.env.ROS_DELIVERY_TIMEOUT_MS ? Number(process.env.ROS_DELIVERY_TIMEOUT_MS) : undefined,
  };
}
