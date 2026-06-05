import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isProcessAlive, sleep } from "./process_lib.js";

/**
 * Shared building block for the simple JSON-file stores: memory.json,
 * backlog.json. Mirrors the locking + mtime-invalidation discipline that
 * `StateStore` got in v0.10.8 — without it, an autopilot daemon, the CLI,
 * and the MCP server can all race against each other and silently lose
 * writes (last-writer-wins, with no fingerprint check the other processes
 * keep reading their stale cache forever).
 *
 * Concurrency model — identical to StateStore:
 *   • In-process: a Promise chain (`writeLock`) serializes mutations.
 *   • Cross-process: each mutation grabs a sidecar lock file (`<file>.lock`)
 *     via O_CREAT|O_EXCL. Stale locks (PID dead) are reclaimed on retry.
 *     Release verifies the lock still carries our UUID before unlinking,
 *     so we never nuke another process's freshly-acquired lock.
 *   • Atomic writes: tmp file + rename.
 *   • Cross-process freshness: every read() stat-checks mtime and reloads
 *     from disk if another process wrote since we last cached.
 *
 * Why not just reuse StateStore? Different schema, different file, different
 * write cadence. Memory and backlog are read-heavy / write-light; folding
 * them into orqlaude-state.json would force the giant plan blob to be
 * rewritten on every memory.remember() — defeating the whole point of
 * keeping them in separate files.
 */

export interface JsonStoreOpts<T> {
  filePath: string;
  empty: T;
  /**
   * Optional validator/migrator. Receives whatever was parsed (may be an
   * older schema) and returns the canonical shape. Default: pass through.
   */
  migrate?: (raw: unknown) => T;
}

/**
 * v0.12.1: bumped from 5s → 15s. The original 5s could fire spuriously
 * during a busy autopilot tick (which runs several reads + writes in
 * sequence under the same lock). A longer ceiling reduces false-positive
 * "lock timeout" errors; legitimate deadlocks still surface, just later.
 */
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_RETRY_BASE_MS = 30;

export class JsonStore<T> {
  private filePath: string;
  private lockPath: string;
  private empty: T;
  private migrate: (raw: unknown) => T;
  private cache: T | null = null;
  /**
   * Fingerprint of the file as we last cached it. mtime alone is
   * insufficient because many filesystems (HFS+, ext4 on older kernels,
   * Windows FAT32) only have second-level mtime granularity. If two
   * writers commit within the same second, the second writer's mtime
   * could equal the first, and other readers would think their cache is
   * fresh. Pairing mtime with file SIZE makes same-second collisions
   * extremely unlikely — JSON state files almost never come out the
   * same length twice in a row.
   */
  private cacheMtimeMs: number | null = null;
  private cacheSize: number | null = null;
  private writeLock: Promise<void> = Promise.resolve();
  private currentLockToken: string | null = null;

  constructor(opts: JsonStoreOpts<T>) {
    this.filePath = opts.filePath;
    this.lockPath = `${opts.filePath}.lock`;
    this.empty = opts.empty;
    this.migrate = opts.migrate ?? ((x) => x as T);
  }

  /** Read path: serialized through writeLock, stat-checks mtime to defeat
   *  cross-process staleness. */
  async read<R>(reader: (state: T) => R): Promise<R> {
    let release: () => void = () => {};
    const next = new Promise<void>((res) => (release = res));
    const prev = this.writeLock;
    this.writeLock = prev.then(() => next);
    await prev;
    try {
      const stale = await this.cacheIsStale();
      const state = stale ? await this.loadFresh() : this.cache!;
      return reader(state);
    } finally {
      release();
    }
  }

  /** Mutate under both in-process and cross-process locks. Always reloads
   *  from disk inside the lock before applying the mutator. Rolls back the
   *  in-memory cache on throw. */
  async update<R>(mutator: (state: T) => R | Promise<R>): Promise<R> {
    let release: () => void = () => {};
    const next = new Promise<void>((res) => (release = res));
    const prev = this.writeLock;
    this.writeLock = prev.then(() => next);
    await prev;
    try {
      await this.acquireFileLock();
      const fresh = await this.loadFresh();
      const snapshot = structuredClone(fresh);
      try {
        const result = await mutator(fresh);
        await this.persist(fresh);
        return result;
      } catch (err) {
        this.cache = snapshot;
        throw err;
      } finally {
        await this.releaseFileLock();
      }
    } finally {
      release();
    }
  }

  private async loadFresh(): Promise<T> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        // Corrupt file - rare but possible if a previous writer crashed
        // mid-rename. Fall through to EMPTY so the daemon doesn't crash on
        // boot; the next write will overwrite atomically.
        process.stderr.write(
          `[orqlaude] ${path.basename(this.filePath)}: malformed JSON (${(err as Error).message}); starting from empty\n`
        );
        this.cache = structuredClone(this.empty);
        this.cacheMtimeMs = null;
        return this.cache;
      }
      const migrated = this.migrate(parsed);
      this.cache = migrated;
      try {
        const stat = await fs.stat(this.filePath);
        this.cacheMtimeMs = stat.mtimeMs;
        this.cacheSize = stat.size;
      } catch {
        this.cacheMtimeMs = null;
        this.cacheSize = null;
      }
      return migrated;
    } catch (err: any) {
      if (err.code === "ENOENT") {
        this.cache = structuredClone(this.empty);
        this.cacheMtimeMs = null;
        this.cacheSize = null;
        return this.cache;
      }
      throw err;
    }
  }

  private async cacheIsStale(): Promise<boolean> {
    if (!this.cache || this.cacheMtimeMs === null) return true;
    try {
      const stat = await fs.stat(this.filePath);
      // Both mtime AND size must match. See the cacheSize field comment for
      // why mtime alone is insufficient on coarse-grained filesystems.
      return stat.mtimeMs !== this.cacheMtimeMs || stat.size !== this.cacheSize;
    } catch (err: any) {
      return err.code === "ENOENT";
    }
  }

  private async acquireFileLock(): Promise<void> {
    await fs.mkdir(path.dirname(this.lockPath), { recursive: true });
    const start = Date.now();
    const token = randomUUID();
    while (Date.now() - start < LOCK_TIMEOUT_MS) {
      try {
        const fh = await fs.open(this.lockPath, "wx", 0o600);
        await fh.write(`${process.pid}\n${token}\n${Date.now()}\n`);
        await fh.close();
        // Verify the file we just created STILL carries our token. The
        // O_EXCL guarantees only one writer wins the create-race for a
        // given moment, but a paranoid sanity-check defends against
        // pathological filesystems (NFS, some Docker volume drivers)
        // where O_EXCL semantics are unreliable.
        try {
          const verify = (await fs.readFile(this.lockPath, "utf8")).split("\n")[1]?.trim();
          if (verify !== token) {
            // Someone else owns it. Back off; do NOT delete (it's theirs).
            await sleep(LOCK_RETRY_BASE_MS + Math.random() * LOCK_RETRY_BASE_MS);
            continue;
          }
        } catch {
          // File was unlinked from under us — extremely unlikely, retry.
          await sleep(LOCK_RETRY_BASE_MS);
          continue;
        }
        this.currentLockToken = token;
        return;
      } catch (err: any) {
        if (err.code !== "EEXIST") throw err;
        try {
          const held = (await fs.readFile(this.lockPath, "utf8")).split("\n")[0]?.trim();
          const heldPid = parseInt(held ?? "", 10);
          if (Number.isFinite(heldPid) && !isProcessAlive(heldPid)) {
            try {
              const recheck = (await fs.readFile(this.lockPath, "utf8")).split("\n")[0]?.trim();
              if (recheck === String(heldPid)) {
                await fs.unlink(this.lockPath).catch(() => {});
              }
            } catch {
              /* race: file gone; retry will succeed */
            }
            continue;
          }
        } catch {
          /* race: file rewritten; retry */
        }
        await sleep(LOCK_RETRY_BASE_MS + Math.random() * LOCK_RETRY_BASE_MS);
      }
    }
    throw new Error(
      `orqlaude: could not acquire ${path.basename(this.lockPath)} within ${LOCK_TIMEOUT_MS}ms`
    );
  }

  private async releaseFileLock(): Promise<void> {
    const myToken = this.currentLockToken;
    this.currentLockToken = null;
    if (!myToken) {
      await fs.unlink(this.lockPath).catch(() => {});
      return;
    }
    try {
      const content = await fs.readFile(this.lockPath, "utf8");
      const heldToken = content.split("\n")[1]?.trim();
      if (heldToken !== myToken) return;
      await fs.unlink(this.lockPath);
    } catch {
      /* already gone */
    }
  }

  private async persist(state: T): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
    this.cache = state;
    try {
      const stat = await fs.stat(this.filePath);
      this.cacheMtimeMs = stat.mtimeMs;
      this.cacheSize = stat.size;
    } catch {
      this.cacheMtimeMs = null;
      this.cacheSize = null;
    }
  }
}
