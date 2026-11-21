type Job = { title: string; run: (signal: AbortSignal) => Promise<void> };
type PendingJob = Job & { done: () => void };

export class JobQueue {
  #pending: PendingJob[] = [];
  #running = false;
  readonly #controller = new AbortController();
  readonly #showQueued: (titles: string[]) => void;
  readonly #reportError: (error: unknown) => void;

  constructor(showQueued: (titles: string[]) => void, reportError: (error: unknown) => void) {
    this.#showQueued = showQueued;
    this.#reportError = reportError;
  }

  get signal() { return this.#controller.signal; }
  get busy() { return this.#running; }

  enqueue(job: Job) {
    if (this.signal.aborted) return Promise.resolve();
    return new Promise<void>((done) => {
      this.#pending.push({ ...job, done });
      if (this.#running) this.#publish();
      else void this.#drain();
    });
  }

  stop() {
    this.#controller.abort();
    for (const job of this.#pending.splice(0)) job.done();
    this.#publish();
  }

  #publish() { this.#showQueued(this.#pending.map(({ title }) => title)); }

  async #drain() {
    this.#running = true;
    try {
      for (let job = this.#pending.shift(); job; job = this.#pending.shift()) {
        this.#publish();
        try { await job.run(this.signal); }
        catch (error) { if (!this.signal.aborted) this.#reportError(error); }
        finally { job.done(); }
      }
    } finally { this.#running = false; }
  }
}
