/** Run async tasks with a fixed concurrency limit, preserving input order. A task that throws stops the rest from starting. */
export function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        next = items.length;
        throw err;
      }
    }
  }
  return Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker())).then(() => results);
}

/** A shared limit: at most `limit` of the scheduled tasks run at once, started in the order they were scheduled. */
export function limiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active++;
    queue.shift()!();
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push(() =>
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          }),
      );
      next();
    });
}
