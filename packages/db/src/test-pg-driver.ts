import { EventEmitter } from "node:events";

type Rows = { rows: Array<Record<string, unknown>> };
type Done = (err: Error | null, res?: Rows) => void;

/**
 * Test-only (pool.test.ts, pool-wiring.test.ts): stands in for pg.Client inside the real pg-pool. It records every
 * statement, counts a statement sent while another is still running on the same connection (what pg 8 warns about and
 * pg 9 refuses), and answers each one after 5 ms. With `refuseSet`, the server refuses the platform-mode SET.
 */
export function fakeDriver(opts: { refuseSet?: boolean } = {}) {
  class FakeClient extends EventEmitter {
    /** Every connection the pool opened through this driver. */
    static readonly made: FakeClient[] = [];
    readonly queries: string[] = [];
    overlaps = 0;
    ended = false;
    // pg-pool reads these two flags when a connection comes back, to decide whether it can be used again.
    _queryable = true;
    _ending = false;
    private running = 0;
    private connected = false;
    constructor() {
      super();
      FakeClient.made.push(this);
    }
    connect(cb: (err?: Error) => void): void {
      // Before any timer can run: pg-pool's connect timeout (50 ms in one test) must never win against a slow machine.
      process.nextTick(() => {
        this.connected = true;
        cb();
      });
    }
    /** pg-pool asks this when its connect timeout fires on a client that has no `connection` (pg-native's shape). */
    isConnected(): boolean {
      return this.connected && !this.ended;
    }
    end(cb?: () => void): void {
      this.ended = true;
      this._ending = true;
      this._queryable = false;
      if (cb) setImmediate(cb);
    }
    query(text: string, values?: unknown, cb?: Done): Promise<Rows> | undefined {
      const done = typeof values === "function" ? (values as Done) : cb;
      this.queries.push(text);
      if (this.running > 0) this.overlaps++;
      this.running++;
      const result = new Promise<Rows>((resolve, reject) => {
        setTimeout(() => {
          this.running--;
          if (opts.refuseSet && text.startsWith("SET ")) reject(new Error('permission denied to set parameter "app.platform"'));
          else resolve({ rows: [{ ok: 1 }] });
        }, 5);
      });
      if (!done) return result;
      result.then((res) => done(null, res), (err: Error) => done(err));
      return undefined;
    }
  }
  return { Client: FakeClient as never, clients: FakeClient.made };
}
