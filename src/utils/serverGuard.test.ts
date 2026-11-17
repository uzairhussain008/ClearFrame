import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BoundedJobQueue,
  SlidingWindowRateLimiter,
  selectEvictionsForBudget,
} from './serverGuard';

test('SlidingWindowRateLimiter allows up to maxRequests then blocks until window passes', () => {
  const limiter = new SlidingWindowRateLimiter({
    windowMs: 60_000,
    maxRequests: 3,
    maxKeys: 50,
  });

  const t0 = 1_000_000;
  assert.equal(limiter.check('1.2.3.4', t0).allowed, true);
  assert.equal(limiter.check('1.2.3.4', t0 + 100).allowed, true);
  assert.equal(limiter.check('1.2.3.4', t0 + 200).allowed, true);

  const blocked = limiter.check('1.2.3.4', t0 + 500);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfterSec >= 59 && blocked.retryAfterSec <= 60);

  // Separate IP is unaffected
  assert.equal(limiter.check('5.6.7.8', t0 + 500).allowed, true);

  // Window expires cleanly
  const afterWindow = limiter.check('1.2.3.4', t0 + 60_001);
  assert.equal(afterWindow.allowed, true);
});

test('SlidingWindowRateLimiter bounds memory under 30k unique IP flood', () => {
  const limiter = new SlidingWindowRateLimiter({
    windowMs: 60_000,
    maxRequests: 5,
    maxKeys: 100,
  });

  const t0 = 2_000_000;
  for (let i = 0; i < 350; i += 1) {
    assert.equal(limiter.check(`10.0.${Math.floor(i / 255)}.${i % 255}`, t0 + i).allowed, true);
  }
  assert.ok(limiter.getTrackedKeyCount() <= 100);
});

test('BoundedJobQueue caps concurrent jobs, tracks queue positions, and drains FIFO', async () => {
  const queue = new BoundedJobQueue({
    maxConcurrent: 2,
    maxQueued: 2,
    maxQueuedPerOwner: 2,
  });

  const started: string[] = [];
  const resolvers = new Map<string, () => void>();

  const makeTask = (id: string, ownerKey = 'ip-a') => ({
    id,
    ownerKey,
    onStart: () => {
      started.push(id);
    },
    run: () =>
      new Promise<void>((resolve) => {
        resolvers.set(id, resolve);
      }),
  });

  const r1 = queue.enqueue(makeTask('job-1', 'ip-1'));
  const r2 = queue.enqueue(makeTask('job-2', 'ip-2'));
  const r3 = queue.enqueue(makeTask('job-3', 'ip-3'));
  const r4 = queue.enqueue(makeTask('job-4', 'ip-4'));
  const r5 = queue.enqueue(makeTask('job-5', 'ip-5'));

  assert.equal(r1.accepted, true);
  assert.equal(r1.startedImmediately, true);
  assert.equal(r2.accepted, true);
  assert.equal(r2.startedImmediately, true);
  assert.equal(r3.accepted, true);
  assert.equal(r3.startedImmediately, false);
  assert.equal(r3.queuePosition, 1);
  assert.equal(r4.accepted, true);
  assert.equal(r4.queuePosition, 2);
  assert.equal(r5.accepted, false);
  assert.equal(r5.reason, 'queue_full');

  assert.deepEqual(started, ['job-1', 'job-2']);
  assert.equal(queue.getQueuePosition('job-4'), 2);

  // Finish job-1 -> job-3 should start immediately
  resolvers.get('job-1')?.();
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(started, ['job-1', 'job-2', 'job-3']);
  assert.equal(queue.getQueuePosition('job-4'), 1);

  // Finish remaining
  resolvers.get('job-2')?.();
  resolvers.get('job-3')?.();
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(started, ['job-1', 'job-2', 'job-3', 'job-4']);
  resolvers.get('job-4')?.();
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(queue.getStats(), { active: 0, queued: 0, maxConcurrent: 2, maxQueued: 2 });
});

test('BoundedJobQueue enforces per-owner queue cap so one IP cannot monopolize queue', () => {
  const queue = new BoundedJobQueue({
    maxConcurrent: 1,
    maxQueued: 10,
    maxQueuedPerOwner: 2,
  });

  const blockers: Array<() => void> = [];
  const createBlocking = (id: string, ownerKey: string) => ({
    id,
    ownerKey,
    run: () => new Promise<void>((resolve) => blockers.push(resolve)),
  });

  assert.equal(queue.enqueue(createBlocking('j1', 'spam-ip')).accepted, true); // running
  assert.equal(queue.enqueue(createBlocking('j2', 'spam-ip')).accepted, true); // queued 1
  assert.equal(queue.enqueue(createBlocking('j3', 'spam-ip')).accepted, true); // queued 2
  const blocked = queue.enqueue(createBlocking('j4', 'spam-ip'));
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.reason, 'owner_limit');

  // Other users can still enqueue
  assert.equal(queue.enqueue(createBlocking('j5', 'other-ip')).accepted, true);

  for (const done of blockers) done();
});

test('selectEvictionsForBudget evicts oldest unprotected files first and never touches protected files', () => {
  const artifacts = [
    { id: 'old-protected', sizeBytes: 500, createdAt: 100, protected: true },
    { id: 'old-idle', sizeBytes: 400, createdAt: 200, protected: false },
    { id: 'mid-idle', sizeBytes: 400, createdAt: 300, protected: false },
    { id: 'new-idle', sizeBytes: 300, createdAt: 400, protected: false },
  ];

  // Total 1600, incoming 300, budget 1200 -> need to free 700 -> evicts old-idle + mid-idle (800)
  const plan = selectEvictionsForBudget(artifacts, 300, 1200);
  assert.equal(plan.allowed, true);
  assert.deepEqual(plan.evictIds, ['old-idle', 'mid-idle']);
  assert.equal(plan.projectedBytes, 1100);

  // If incoming doesn't fit even after evicting all unprotected files -> reject cleanly
  const impossible = selectEvictionsForBudget(artifacts, 900, 1200);
  assert.equal(impossible.allowed, false);
});
