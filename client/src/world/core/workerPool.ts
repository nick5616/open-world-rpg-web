// Pool of generation workers (spec 12: min(hardwareConcurrency - 2, 4)) with
// a priority queue. The chunk manager re-prioritises every few frames as the
// camera moves, and drops queued work nobody wants any more, so a sprint
// across the map never leaves the workers busy with tiles that are already
// behind the player. Jobs are deduplicated by key.
//
// Worker construction is injected so the queue logic is unit-testable with
// fake workers (workerPool.test.ts).

import type { InitMsg, JobMsg, JobType, ResultMsg } from './protocol';

export interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  terminate(): void;
}

/** Job without its id (the pool assigns ids). */
export type JobSpec = JobMsg extends infer J ? (J extends { id: number } ? Omit<J, 'id'> : never) : never;

interface Pending {
  id: number;
  key: string;
  job: JobSpec;
  priority: number;
  resolve: (r: ResultMsg | null) => void;
  reject: (e: Error) => void;
  promise: Promise<ResultMsg | null>;
  queuedAt: number;
}

export function poolSize(hardwareConcurrency: number | undefined): number {
  // Leave two cores for the main thread and the browser/GPU process.
  return Math.max(1, Math.min((hardwareConcurrency ?? 4) - 2, 4));
}

export class WorkerPool {
  private workers: WorkerLike[] = [];
  private busy: (Pending | null)[] = [];
  private queue: Pending[] = [];
  private byKey = new Map<string, Pending>();
  private nextId = 1;
  /** Completed jobs per type: count and total worker-side ms (for the HUD and benchmark). */
  readonly done: Record<JobType, { n: number; ms: number }> = {
    atlas: { n: 0, ms: 0 },
    tile: { n: 0, ms: 0 },
    cave: { n: 0, ms: 0 },
    scatter: { n: 0, ms: 0 },
    grass: { n: 0, ms: 0 },
    hash: { n: 0, ms: 0 },
    evict: { n: 0, ms: 0 },
  };

  constructor(
    private readonly factory: () => WorkerLike,
    readonly size: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Start the workers and wait until every one has loaded the wasm (and atlas). */
  async start(init: InitMsg): Promise<void> {
    await Promise.all(
      Array.from({ length: this.size }, (_, i) => {
        const w = this.factory();
        this.workers[i] = w;
        this.busy[i] = null;
        return new Promise<void>((resolve, reject) => {
          w.onmessage = (e: MessageEvent<ResultMsg>) => {
            if (e.data.type === 'ready') {
              w.onmessage = (ev: MessageEvent<ResultMsg>) => this.onResult(i, ev.data);
              resolve();
            } else if (e.data.type === 'error') reject(new Error(e.data.message));
          };
          w.onerror = (e) => reject(new Error(e.message));
          w.postMessage(init);
        });
      }),
    );
    for (let i = 0; i < this.size; i++) {
      this.workers[i].onerror = (e) => console.error('[world] worker error', e.message);
    }
  }

  get queued(): number {
    return this.queue.length;
  }
  get inFlight(): number {
    return this.busy.filter(Boolean).length;
  }
  has(key: string): boolean {
    return this.byKey.has(key);
  }

  /**
   * Queue a job. Lower priority = sooner. Submitting a key that is already
   * queued only updates its priority and returns the same promise. Resolves
   * null when cancelled before a worker picked it up.
   */
  submit(key: string, job: JobSpec, priority: number): Promise<ResultMsg | null> {
    const existing = this.byKey.get(key);
    if (existing) {
      existing.priority = Math.min(existing.priority, priority);
      return existing.promise;
    }
    let resolve!: Pending['resolve'];
    let reject!: Pending['reject'];
    const promise = new Promise<ResultMsg | null>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const p: Pending = { id: this.nextId++, key, job, priority, resolve, reject, promise, queuedAt: this.now() };
    this.byKey.set(key, p);
    this.queue.push(p);
    this.pump();
    return promise;
  }

  setPriority(key: string, priority: number): void {
    const p = this.byKey.get(key);
    if (p) p.priority = priority;
  }

  /** Drop a queued job (no effect once a worker has started it). */
  cancel(key: string): void {
    const p = this.byKey.get(key);
    if (!p) return;
    const i = this.queue.indexOf(p);
    if (i < 0) return; // in flight
    this.queue.splice(i, 1);
    this.byKey.delete(key);
    p.resolve(null);
  }

  /** Cancel every queued job whose key fails the predicate. */
  retain(keep: (key: string) => boolean): number {
    // One pass (cancel() per key would be O(n^2) on a long queue).
    const dropped: Pending[] = [];
    this.queue = this.queue.filter((p) => {
      if (keep(p.key)) return true;
      dropped.push(p);
      return false;
    });
    for (const p of dropped) {
      this.byKey.delete(p.key);
      p.resolve(null);
    }
    return dropped.length;
  }

  private pump(): void {
    for (let i = 0; i < this.workers.length && this.queue.length; i++) {
      if (this.busy[i]) continue;
      let best = 0;
      for (let k = 1; k < this.queue.length; k++) if (this.queue[k].priority < this.queue[best].priority) best = k;
      const p = this.queue.splice(best, 1)[0];
      this.busy[i] = p;
      this.workers[i].postMessage({ ...p.job, id: p.id } as JobMsg);
    }
  }

  private onResult(i: number, r: ResultMsg): void {
    const p = this.busy[i];
    this.busy[i] = null;
    if (p) {
      this.byKey.delete(p.key);
      if (r.type === 'error') p.reject(new Error(r.message));
      else {
        const ms = 'genMs' in r ? r.genMs + ('meshMs' in r ? r.meshMs : 0) : 'ms' in r ? r.ms : 0;
        const d = this.done[p.job.type];
        d.n++;
        d.ms += ms;
        p.resolve(r);
      }
    }
    this.pump();
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
    for (const p of [...this.queue, ...this.busy.filter((b): b is Pending => !!b)]) p.resolve(null);
    this.queue = [];
    this.byKey.clear();
    this.workers = [];
  }
}
