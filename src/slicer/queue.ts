/**
 * One slice or export at a time: PrusaSlicer already uses every core, so two runs side by side
 * only make both slower. Queries are short and skip the queue.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;

  get pending(): number {
    return this.waiting;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.waiting++;
    const next = this.tail.then(task, task);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next.finally(() => {
      this.waiting--;
    });
  }
}
