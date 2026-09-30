import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ClamAvScanner, parseClamdReply } from "./clamav";
import { EICAR_TEST_STRING } from "./fake";

/**
 * A stand-in clamd speaking the real wire protocol: null-terminated commands, INSTREAM chunks with four-byte
 * big-endian lengths, a zero-length chunk to finish, one null-terminated reply. What it received is kept so the
 * framing can be checked byte for byte.
 */
type FakeClamd = { server: Server; port: number; received: Buffer[]; commands: string[]; close(): Promise<void> };

function fakeClamd(opts: { reply?: (bytes: Buffer) => string; silent?: boolean } = {}): Promise<FakeClamd> {
  const received: Buffer[] = [];
  const commands: string[] = [];
  const reply = opts.reply ?? ((bytes) => (bytes.toString("latin1").includes(EICAR_TEST_STRING) ? "stream: Win.Test.EICAR_HDB-1 FOUND" : "stream: OK"));
  const server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    let command: string | null = null;
    let payload = Buffer.alloc(0);
    socket.on("data", (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (command === null) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        command = buffer.subarray(0, end).toString("utf8");
        commands.push(command);
        buffer = buffer.subarray(end + 1);
        if (command === "zPING") {
          if (!opts.silent) socket.end("PONG\0");
          return;
        }
      }
      if (command !== "zINSTREAM") return;
      for (;;) {
        if (buffer.length < 4) return;
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          received.push(payload);
          if (!opts.silent) socket.end(`${reply(payload)}\0`);
          return;
        }
        if (buffer.length < 4 + length) return;
        payload = Buffer.concat([payload, buffer.subarray(4, 4 + length)]);
        buffer = buffer.subarray(4 + length);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port, received, commands, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

describe("ClamAV over the clamd protocol", () => {
  const open: FakeClamd[] = [];
  afterEach(async () => {
    for (const f of open.splice(0)) await f.close();
  });

  it("classifies clamd's replies", () => {
    expect(parseClamdReply("stream: OK\0")).toEqual({ verdict: "clean", engine: "clamav" });
    expect(parseClamdReply("stream: Eicar-Test-Signature FOUND")).toEqual({ verdict: "infected", engine: "clamav", signature: "Eicar-Test-Signature" });
    expect(parseClamdReply("INSTREAM size limit exceeded. ERROR\0")).toMatchObject({ verdict: "error", detail: "INSTREAM size limit exceeded. ERROR" });
    expect(parseClamdReply("")).toMatchObject({ verdict: "error", detail: "empty reply" });
    expect(parseClamdReply("something else")).toMatchObject({ verdict: "error", detail: "unexpected reply: something else" });
  });

  it("streams the file in framed chunks and reads OK as clean", async () => {
    const clamd = await fakeClamd();
    open.push(clamd);
    const scanner = new ClamAvScanner({ host: "127.0.0.1", port: clamd.port, timeoutMs: 2000, chunkSize: 7 });
    expect(scanner.status).toBe("not_connected");
    const bytes = new TextEncoder().encode("%PDF-1.4 a perfectly ordinary résumé, longer than one chunk");
    expect(await scanner.scan(bytes, { filename: "resume.pdf", mime: "application/pdf" })).toEqual({ verdict: "clean", engine: "clamav" });
    expect(scanner.status).toBe("live");
    expect(clamd.commands).toEqual(["zINSTREAM"]);
    expect(clamd.received).toHaveLength(1);
    expect(Buffer.from(clamd.received[0]).equals(Buffer.from(bytes))).toBe(true);
  });

  it("reads FOUND as infected with the signature named", async () => {
    const clamd = await fakeClamd();
    open.push(clamd);
    const scanner = new ClamAvScanner({ host: "127.0.0.1", port: clamd.port, timeoutMs: 2000 });
    const result = await scanner.scan(new TextEncoder().encode(`${EICAR_TEST_STRING}\n`), { filename: "eicar.txt", mime: "text/plain" });
    expect(result).toEqual({ verdict: "infected", engine: "clamav", signature: "Win.Test.EICAR_HDB-1" });
    expect(scanner.status).toBe("live");
  });

  it("reads ERROR as a scan that could not run, so the file stays quarantined", async () => {
    const clamd = await fakeClamd({ reply: () => "INSTREAM size limit exceeded. ERROR" });
    open.push(clamd);
    const scanner = new ClamAvScanner({ host: "127.0.0.1", port: clamd.port, timeoutMs: 2000 });
    const result = await scanner.scan(new Uint8Array([1, 2, 3]), { filename: "x.bin", mime: "application/octet-stream" });
    expect(result).toMatchObject({ verdict: "error", engine: "clamav" });
    expect(result.detail).toContain("ERROR");
  });

  it("PING is the boot check: live when clamd answers, not_connected when nothing listens", async () => {
    const clamd = await fakeClamd();
    open.push(clamd);
    const scanner = new ClamAvScanner({ host: "127.0.0.1", port: clamd.port, timeoutMs: 2000 });
    expect(await scanner.check()).toBe("live");
    expect(scanner.status).toBe("live");
    const port = clamd.port;
    await clamd.close();
    open.pop();
    const down = new ClamAvScanner({ host: "127.0.0.1", port, timeoutMs: 2000 });
    expect(await down.check()).toBe("not_connected");
    const result = await down.scan(new Uint8Array([1]), { filename: "x", mime: "text/plain" });
    expect(result.verdict).toBe("error");
    expect(result.detail).toContain("scanner unavailable");
    expect(down.status).toBe("not_connected");
  });

  it("a clamd that never answers is a timeout, reported as an outage", async () => {
    const clamd = await fakeClamd({ silent: true });
    open.push(clamd);
    const scanner = new ClamAvScanner({ host: "127.0.0.1", port: clamd.port, timeoutMs: 200 });
    const result = await scanner.scan(new Uint8Array([1, 2, 3]), { filename: "x", mime: "text/plain" });
    expect(result.verdict).toBe("error");
    expect(result.detail).toContain("did not answer within 200 ms");
    expect(await scanner.check()).toBe("not_connected");
  });

  it("refuses to be built without a host", () => {
    expect(() => new ClamAvScanner({ host: "" })).toThrow(/CLAMAV_HOST/);
  });
});
