import { createConnection, type Socket } from "node:net";
import type { AdapterStatus } from "../types";
import type { MalwareScanner, ScanResult } from "./types";

/**
 * ClamAV over the clamd TCP protocol (audit remediation H6; docs/runbooks/resume-storage.md, "Running ClamAV on
 * Railway"). One connection per scan: the `zINSTREAM` command, the file in chunks each preceded by its length as a
 * four-byte big-endian integer, a zero-length chunk to finish, then one null-terminated reply:
 *
 *   stream: OK                      the file is clean
 *   stream: <signature> FOUND       malware, named
 *   <text> ERROR                    clamd refused (for example the stream size limit)
 *
 * A refused connection, a closed socket or a timeout is a scanner outage, reported as `error`: the quarantine step
 * keeps the file where it is and retries. The file's bytes are sent to clamd and nowhere else; nothing is logged.
 */
export type ClamAvOptions = {
  host: string;
  /** clamd's TCP port; the official image listens on 3310. */
  port?: number;
  /** Connection, write and reply timeout in milliseconds. A large file over private networking finishes well within the default. */
  timeoutMs?: number;
  /** Bytes per INSTREAM chunk; clamd's default StreamMaxLength allows 25 MB in total. */
  chunkSize?: number;
};

export const CLAMAV_DEFAULT_PORT = 3310;
export const CLAMAV_DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CHUNK = 64 * 1024;

/** One clamd reply, classified. Exported so the mapping is tested without a socket. */
export function parseClamdReply(reply: string, engine = "clamav"): ScanResult {
  const text = reply.replace(/\0+$/, "").trim();
  if (/^stream:\s*OK$/i.test(text)) return { verdict: "clean", engine };
  const found = text.match(/^stream:\s*(.+?)\s+FOUND$/i);
  if (found) return { verdict: "infected", engine, signature: found[1]!.trim() };
  if (/ERROR$/i.test(text)) return { verdict: "error", engine, detail: text.slice(0, 200) };
  return { verdict: "error", engine, detail: text ? `unexpected reply: ${text.slice(0, 200)}` : "empty reply" };
}

export class ClamAvScanner implements MalwareScanner {
  readonly id = "clamav";
  /** `not_connected` until a PING has been answered; the boot check calls `check()`, and every scan updates it. */
  status: AdapterStatus = "not_connected";
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly chunkSize: number;

  constructor(opts: ClamAvOptions) {
    if (!opts.host) throw new Error("SCAN_PROVIDER=clamav needs CLAMAV_HOST (the clamd service's private hostname)");
    this.host = opts.host;
    this.port = opts.port ?? CLAMAV_DEFAULT_PORT;
    this.timeoutMs = opts.timeoutMs ?? CLAMAV_DEFAULT_TIMEOUT_MS;
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
  }

  /** PING at boot and on demand: `live` when clamd answers PONG, `not_connected` otherwise. Never throws. */
  async check(): Promise<AdapterStatus> {
    try {
      const reply = await this.exchange((socket) => { socket.write("zPING\0"); });
      this.status = /^PONG/i.test(reply.replace(/\0+$/, "").trim()) ? "live" : "not_connected";
    } catch {
      this.status = "not_connected";
    }
    return this.status;
  }

  /** The file's name and type are not sent to clamd: the engine judges bytes, and a name is a person's to keep. */
  async scan(bytes: Uint8Array, _meta?: { filename: string; mime: string }): Promise<ScanResult> {
    let reply: string;
    try {
      reply = await this.exchange((socket) => {
        socket.write("zINSTREAM\0");
        for (let offset = 0; offset < bytes.length; offset += this.chunkSize) {
          const chunk = bytes.subarray(offset, Math.min(offset + this.chunkSize, bytes.length));
          const length = Buffer.alloc(4);
          length.writeUInt32BE(chunk.length, 0);
          socket.write(length);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4)); // a zero-length chunk ends the stream
      });
    } catch (err) {
      this.status = "not_connected";
      return { verdict: "error", engine: this.id, detail: `scanner unavailable: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) };
    }
    const result = parseClamdReply(reply, this.id);
    if (result.verdict !== "error") this.status = "live";
    return result;
  }

  /** Opens a connection, lets `send` write the command, and resolves with clamd's first null-terminated reply. */
  private exchange(send: (socket: Socket) => void): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const chunks: Buffer[] = [];
      const socket = createConnection({ host: this.host, port: this.port });
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        fn();
      };
      socket.setTimeout(this.timeoutMs, () => finish(() => reject(new Error(`clamd at ${this.host}:${this.port} did not answer within ${this.timeoutMs} ms`))));
      socket.on("error", (err) => finish(() => reject(new Error(`clamd at ${this.host}:${this.port}: ${err.message}`))));
      socket.on("connect", () => {
        try {
          send(socket);
        } catch (err) {
          finish(() => reject(err instanceof Error ? err : new Error(String(err))));
        }
      });
      socket.on("data", (data: Buffer) => {
        chunks.push(data);
        const text = Buffer.concat(chunks).toString("utf8");
        if (text.includes("\0")) finish(() => resolve(text.slice(0, text.indexOf("\0"))));
      });
      socket.on("close", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (text.trim()) finish(() => resolve(text));
        else finish(() => reject(new Error(`clamd at ${this.host}:${this.port} closed the connection without a reply`)));
      });
    });
  }
}
