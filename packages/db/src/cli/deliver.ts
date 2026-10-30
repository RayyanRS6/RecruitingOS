import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { DbEnvironment } from "./environment";

/**
 * Hands secrets to the person without ever printing them (founder request, 22 Sep 2026, after a screenshot exposed
 * the two connection strings): each value goes to the clipboard in turn, the person pastes it into the 1Password
 * field named for it and confirms by typing "pasted", and the clipboard is cleared afterwards: at the end, after a
 * timeout, when the input closes, when the copy fails, or when the process is interrupted (Ctrl-C, the window
 * closing). Nothing here writes a value to standard output, a log, or a file. Keystrokes typed before a prompt
 * appears are ignored, so a stray Return cannot confirm a paste that never happened. The vault and item named are
 * the environment's (ROS_DB_ENV, environment.ts); without one, nothing is delivered.
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
  /** What this computer's clipboard does with a value besides the paste (history, other devices): said before the first copy and after the clear. */
  notes?: { before: string; after: string };
};
export type DeliveryTarget = Pick<DbEnvironment, "name" | "vault" | "item">;

const CONFIRM = "pasted";

export async function deliverToClipboard(values: Delivery[], io: DeliveryIo, target: DeliveryTarget): Promise<{ delivered: string[]; timedOut: boolean }> {
  const timeoutMs = io.timeoutMs ?? 10 * 60_000;
  const delivered: string[] = [];
  let cleared = false;
  const clear = async () => {
    if (cleared) return;
    cleared = true;
    await io.clear();
  };
  try {
    if (!target?.vault || !target.item) throw new Error("deliver: the environment (ROS_DB_ENV) must be named before anything is delivered; nothing was put on the clipboard");
    io.say(`Each value is placed on the clipboard in turn, never shown.${io.notes ? ` ${io.notes.before}` : ""}`);
    for (const v of values) {
      await io.copy(v.value);
      io.say(`${v.name} is on the clipboard. In 1Password (vault: ${target.vault}), paste it into the field ${v.name} of the item "${target.item}". ${v.where}`);
      const deadline = Date.now() + timeoutMs;
      let confirmed = false;
      while (!confirmed) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const line = await Promise.race([io.ask(`Type ${CONFIRM} and press Return once ${v.name} is in 1Password (paste it there, never into this window): `), new Promise<undefined>((res) => setTimeout(() => res(undefined), remaining).unref?.())]);
        if (line === undefined) break; // timed out
        if (line === null) break; // input closed
        if (line.trim().toLowerCase() === CONFIRM) confirmed = true;
        // A long answer is most likely the value pasted here by mistake, which the terminal has already shown.
        else if (line.trim().length > 12) io.say(`Not yet: that was not ${CONFIRM}. If it was ${v.name} itself, this window shows it now: take no screenshot, and close the window once the setup ends. ${v.name} is still on the clipboard. Paste it into 1Password, then type ${CONFIRM} and press Return.`);
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
    io.say(`Clipboard cleared. Nothing was printed.${io.notes ? ` ${io.notes.after}` : ""}`);
    return { delivered, timedOut: false };
  } finally {
    await clear().catch(() => undefined);
    io.close();
  }
}

type Clipboard = { copy(text: string): Promise<void>; clear(): Promise<void>; /** Synchronous, for a process that is about to end. */ clearNow(): void };

/**
 * The person at this console: the clipboard, the prompts, and clearing on an interruption. Lines count only when
 * typed after the current prompt: anything buffered earlier is discarded. A closed input (the window closed, no
 * terminal) answers null instead of throwing.
 */
function consoleIo(clipboard: Clipboard, notes: { before: string; after: string }): DeliveryIo {
  // An interrupted process still clears the clipboard, synchronously, before it dies.
  const onSignal = (signal: NodeJS.Signals) => {
    try { clipboard.clearNow(); } catch { /* nothing more can be done */ }
    console.log(`\nInterrupted (${signal}): the clipboard was cleared. Run the setup again to set fresh passwords and deliver again.`);
    process.exit(1);
  };
  // SIGHUP is also what Windows sends when the console window closes; SIGBREAK is Ctrl-Break there.
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"];
  for (const s of signals) process.on(s, onSignal);
  let waiter: ((line: string | null) => void) | null = null;
  let closed = false;
  // Reading starts now, before the first value is copied, so keystrokes already in the terminal's buffer are
  // consumed and dropped while no prompt is waiting.
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => { if (waiter) { const w = waiter; waiter = null; w(line); } });
  rl.on("close", () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(null); } });
  return {
    copy: clipboard.copy,
    clear: clipboard.clear,
    ask: (prompt) => {
      process.stdout.write(prompt);
      if (closed) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => { waiter = resolve; });
    },
    say: (line) => console.log(line),
    close: () => {
      for (const s of signals) process.off(s, onSignal);
      rl.close();
      process.stdin.pause();
    },
    timeoutMs: process.env.ROS_DELIVERY_TIMEOUT_MS ? Number(process.env.ROS_DELIVERY_TIMEOUT_MS) : undefined,
    notes,
  };
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
  return consoleIo(
    { copy: pipe, clear: () => pipe(""), clearNow: () => { spawnSync("pbcopy", [], { input: "" }); } },
    {
      before: "If a clipboard-history app is installed (Raycast, Alfred, Paste, Maccy), pause it now and clear its history afterwards: it would record the value. If Universal Clipboard is on, the value also reaches your other Apple devices until it is cleared.",
      after: "If a clipboard-history app is installed, clear its history too.",
    },
  );
}

/** scripts/lib/clipboard.ps1, from this file's place in the repository. */
export const CLIPBOARD_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "scripts", "lib", "clipboard.ps1");

/**
 * The arguments that run scripts/lib/clipboard.ps1 in Windows PowerShell 5.1 (single-threaded apartment, which the
 * clipboard needs). The command carries no value: for `set`, the value arrives on standard input as base64 of its
 * UTF-8, so no console code page can change it. The script's own refusal (no Windows clipboard API that keeps a
 * value out of history) is one line on standard error starting "clipboard: ", and the exit code is 1. Progress
 * records are off: with its streams redirected, PowerShell would write them to standard error as CLIXML.
 */
export function windowsClipboardArgs(action: "set" | "clear", script: string = CLIPBOARD_SCRIPT): string[] {
  const body = action === "set" ? "Set-SecretClipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())))" : "Clear-SecretClipboard";
  const command = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; try { . '${script.replace(/'/g, "''")}'; ${body} } catch { [Console]::Error.WriteLine('clipboard: ' + $_.Exception.Message); exit 1 }; exit 0`;
  return ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")];
}

/**
 * The clipboard on Windows, through scripts/lib/clipboard.ps1: each value is kept out of clipboard history (Win+V) and
 * cloud clipboard sync, and a computer that cannot do that refuses instead of copying the value anyway. Only the
 * helper's own "clipboard: " lines reach the person (they never carry a value); anything else PowerShell writes is
 * dropped.
 */
export function windowsClipboardIo(script: string = CLIPBOARD_SCRIPT): DeliveryIo {
  const run = (action: "set" | "clear", text = "") =>
    new Promise<void>((resolve, reject) => {
      const p = spawn("powershell.exe", windowsClipboardArgs(action, script), { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
      let errors = "";
      p.stderr.setEncoding("utf8");
      p.stderr.on("data", (chunk: string) => { errors += chunk; });
      p.on("error", reject);
      p.stdin.on("error", reject);
      p.on("close", (code) => {
        if (code === 0) return resolve();
        for (const line of errors.split(/\r?\n/)) if (line.startsWith("clipboard: ")) console.error(line);
        reject(new Error(`the Windows clipboard helper exited with ${code}`));
      });
      p.stdin.end(action === "set" ? Buffer.from(text, "utf8").toString("base64") : "");
    });
  return consoleIo(
    { copy: (text) => run("set", text), clear: () => run("clear"), clearNow: () => { spawnSync("powershell.exe", windowsClipboardArgs("clear", script), { stdio: "ignore", windowsHide: true, timeout: 20_000 }); } },
    {
      before: "Windows keeps each one out of clipboard history (Win+V) and off your other devices. If another clipboard manager is installed (Ditto, ClipClip and the like), pause it now and clear its history afterwards: it would record the value.",
      after: "Press Win+V to check that neither value is listed there.",
    },
  );
}

/** The clipboard of the computer this runs on. */
export function clipboardIoForThisComputer(platform: string = process.platform): DeliveryIo {
  return platform === "win32" ? windowsClipboardIo() : macClipboardIo();
}
