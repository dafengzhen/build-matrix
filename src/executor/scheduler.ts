import type { PlannedTask } from '../core/types.js';
import type { SchedulingInfo } from './types.js';

export interface ScheduledTask {
  readonly index: number;
  readonly queue: ResourceQueue;
}

interface ResourceQueue {
  active: number;
  readonly indices: number[];
  readonly limit: number;
  next: number;
}

/** Keep runnable queue heads in a min-heap ordered by invocation index. */
export class StageScheduler {
  readonly #ready: ResourceQueue[] = [];

  constructor(
    invocations: readonly { readonly selected: boolean; readonly task: PlannedTask }[],
    { maxConcurrency, resourceLimits }: SchedulingInfo,
  ) {
    const queues = new Map<string | undefined, ResourceQueue>();
    invocations.forEach(({ selected, task }, index) => {
      if (!selected) {
        return;
      }
      const group = task.resourceGroup;
      const existing = queues.get(group);
      if (existing !== undefined) {
        existing.indices.push(index);
        return;
      }
      const queue = {
        active: 0,
        indices: [index],
        limit: group === undefined ? maxConcurrency : resourceLimits[group],
        next: 0,
      };
      queues.set(group, queue);
      // Queue heads arrive in increasing order, so each push preserves the heap.
      this.#ready.push(queue);
    });
  }

  complete({ queue }: ScheduledTask): void {
    queue.active--;
    if (queue.active !== queue.limit - 1 || queue.next === queue.indices.length) {
      return;
    }
    let slot = this.#ready.length;
    while (slot > 0) {
      const parent = Math.floor((slot - 1) / 2);
      const candidate = this.#ready[parent];
      if (head(candidate) < head(queue)) {
        break;
      }
      this.#ready[slot] = candidate;
      slot = parent;
    }
    this.#ready[slot] = queue;
  }

  take(): ScheduledTask | undefined {
    const queue = this.#ready[0];
    if (queue === undefined) {
      return undefined;
    }
    const index = queue.indices[queue.next++];
    queue.active++;
    if (queue.active < queue.limit && queue.next < queue.indices.length) {
      this.#moveDown(queue);
    } else {
      const tail = this.#ready.pop()!;
      if (this.#ready.length > 0) {
        this.#moveDown(tail);
      }
    }
    return { index, queue };
  }

  #moveDown(queue: ResourceQueue): void {
    const heap = this.#ready;
    let slot = 0;
    let child = 1;
    while (child < heap.length) {
      const right = child + 1;
      if (right < heap.length && head(heap[right]) < head(heap[child])) {
        child = right;
      }
      if (head(queue) < head(heap[child])) {
        break;
      }
      heap[slot] = heap[child];
      slot = child;
      child = 2 * slot + 1;
    }
    heap[slot] = queue;
  }
}

function head({ indices, next }: ResourceQueue): number {
  return indices[next];
}
