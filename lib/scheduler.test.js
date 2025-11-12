import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { addSchedule, listSchedules } from './store.js';
import { createScheduleRunner } from './scheduler.js';

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cryer-schedule-'));
}

test('failed advertise call postpones schedule for retry', async () => {
  const dataDir = createTempDir();
  const initialWhen = Date.now() - 10_000;
  const schedule = addSchedule(dataDir, { serverKey: 'alpha', whenMs: initialWhen, reason: 'test' });

  let attempts = 0;
  const runner = createScheduleRunner({
    dataDir,
    bind: '127.0.0.1',
    port: 9999,
    sharedKey: 'k',
    retryDelayMs: 50
  });

  const firstAttemptNow = Date.now();

  await runner({
    now: firstAttemptNow,
    fetchImpl: async () => {
      attempts += 1;
      return { ok: false, status: 503 };
    }
  });

  const afterFailure = listSchedules(dataDir);
  assert.equal(afterFailure.length, 1);
  const updated = afterFailure[0];
  assert.equal(updated.id, schedule.id);
  assert.equal(updated.attemptCount, 1);
  assert.ok(updated.whenMs >= firstAttemptNow + 50);
  assert.ok(typeof updated.lastAttemptMs === 'number');
  assert.equal(attempts, 1);

  await runner({
    now: updated.whenMs + 1,
    fetchImpl: async () => {
      attempts += 1;
      return { ok: true, status: 200 };
    }
  });

  const finalList = listSchedules(dataDir);
  assert.equal(finalList.length, 0);
  assert.equal(attempts, 2);
});
