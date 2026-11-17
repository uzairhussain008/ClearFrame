export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export class SlidingWindowRateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly maxKeys: number;
  private readonly buckets = new Map<string, number[]>();

  constructor(options: { windowMs: number; maxRequests: number; maxKeys?: number }) {
    this.windowMs = Math.max(1000, options.windowMs);
    this.maxRequests = Math.max(1, options.maxRequests);
    this.maxKeys = Math.max(100, options.maxKeys ?? 20_000);
  }

  check(key: string, now: number = Date.now()): RateLimitDecision {
    const normalizedKey = key || 'unknown';
    const cutoff = now - this.windowMs;
    const existing = this.buckets.get(normalizedKey);
    const recent = existing ? existing.filter((ts) => ts > cutoff) : [];

    if (recent.length >= this.maxRequests) {
      // Refresh LRU insertion order and store pruned timestamps
      this.buckets.delete(normalizedKey);
      this.buckets.set(normalizedKey, recent);
      const oldestTs = recent[0];
      const retryAfterMs = Math.max(1000, oldestTs + this.windowMs - now);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.ceil(retryAfterMs / 1000),
      };
    }

    recent.push(now);
    this.buckets.delete(normalizedKey);
    this.buckets.set(normalizedKey, recent);

    if (this.buckets.size > this.maxKeys) {
      this.prune(now);
    }

    return {
      allowed: true,
      remaining: Math.max(0, this.maxRequests - recent.length),
      retryAfterSec: 0,
    };
  }

  prune(now: number = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.buckets.entries()) {
      const valid = timestamps.filter((ts) => ts > cutoff);
      if (valid.length === 0) {
        this.buckets.delete(key);
      } else if (valid.length !== timestamps.length) {
        this.buckets.set(key, valid);
      }
    }
    // If still above maxKeys under extreme unique-IP burst, evict oldest entries FIFO
    while (this.buckets.size > this.maxKeys) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey === undefined) break;
      this.buckets.delete(oldestKey);
    }
  }

  getTrackedKeyCount(): number {
    return this.buckets.size;
  }
}

export interface QueuedTask<T> {
  id: string;
  ownerKey?: string;
  run: () => Promise<T>;
  onStart?: () => void;
  onSettled?: () => void;
}

export class BoundedJobQueue<T = void> {
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly maxQueuedPerOwner: number;
  private readonly running = new Set<string>();
  private readonly queue: Array<QueuedTask<T>> = [];

  constructor(options: {
    maxConcurrent: number;
    maxQueued: number;
    maxQueuedPerOwner?: number;
  }) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent);
    this.maxQueued = Math.max(0, options.maxQueued);
    this.maxQueuedPerOwner = Math.max(1, options.maxQueuedPerOwner ?? 4);
  }

  enqueue(task: QueuedTask<T>): {
    accepted: boolean;
    reason?: 'queue_full' | 'owner_limit';
    startedImmediately: boolean;
    queuePosition: number;
  } {
    if (task.ownerKey) {
      const ownerWaitingCount = this.queue.filter((item) => item.ownerKey === task.ownerKey).length;
      if (ownerWaitingCount >= this.maxQueuedPerOwner) {
        return {
          accepted: false,
          reason: 'owner_limit',
          startedImmediately: false,
          queuePosition: 0,
        };
      }
    }

    if (this.running.size < this.maxConcurrent && this.queue.length === 0) {
      this.startTask(task);
      return {
        accepted: true,
        startedImmediately: true,
        queuePosition: 0,
      };
    }

    if (this.queue.length >= this.maxQueued) {
      return {
        accepted: false,
        reason: 'queue_full',
        startedImmediately: false,
        queuePosition: 0,
      };
    }

    this.queue.push(task);
    return {
      accepted: true,
      startedImmediately: false,
      queuePosition: this.queue.length,
    };
  }

  getQueuePosition(id: string): number {
    const idx = this.queue.findIndex((item) => item.id === id);
    return idx >= 0 ? idx + 1 : 0;
  }

  getStats(): { active: number; queued: number; maxConcurrent: number; maxQueued: number } {
    return {
      active: this.running.size,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
    };
  }

  private startTask(task: QueuedTask<T>): void {
    this.running.add(task.id);
    try {
      task.onStart?.();
    } catch {
      // Ignore callback error before run
    }

    let taskPromise: Promise<T>;
    try {
      taskPromise = Promise.resolve(task.run());
    } catch (err) {
      taskPromise = Promise.reject(err);
    }

    taskPromise
      .catch(() => {
        // Task errors are handled inside task.run()
      })
      .finally(() => {
        this.running.delete(task.id);
        try {
          task.onSettled?.();
        } catch {
          // Ignore cleanup errors
        }
        this.drain();
      });
  }

  private drain(): void {
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        this.startTask(next);
      }
    }
  }
}

export interface StorageArtifact {
  id: string;
  sizeBytes: number;
  createdAt: number;
  protected: boolean;
}

/**
 * Pure planner that selects oldest unprotected artifacts to delete in order
 * to bring disk usage back under budget before accepting a new upload/job.
 */
export function selectEvictionsForBudget(
  artifacts: StorageArtifact[],
  incomingBytes: number,
  maxBudgetBytes: number
): {
  allowed: boolean;
  evictIds: string[];
  projectedBytes: number;
} {
  const safeIncoming = Math.max(0, incomingBytes);
  const currentTotal = artifacts.reduce((sum, item) => sum + Math.max(0, item.sizeBytes), 0);

  if (currentTotal + safeIncoming <= maxBudgetBytes) {
    return {
      allowed: true,
      evictIds: [],
      projectedBytes: currentTotal + safeIncoming,
    };
  }

  const evictable = artifacts
    .filter((item) => !item.protected)
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt);

  const evictIds: string[] = [];
  let freedBytes = 0;

  for (const item of evictable) {
    if (currentTotal - freedBytes + safeIncoming <= maxBudgetBytes) {
      break;
    }
    evictIds.push(item.id);
    freedBytes += Math.max(0, item.sizeBytes);
  }

  const projectedBytes = currentTotal - freedBytes + safeIncoming;
  return {
    allowed: projectedBytes <= maxBudgetBytes,
    evictIds,
    projectedBytes,
  };
}
