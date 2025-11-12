import { listSchedules, removeSchedule, updateSchedule } from './store.js';
import { log } from './logger.js';

const DEFAULT_RETRY_DELAY_MS = parseInt(process.env.CRYER_SCHEDULE_RETRY_DELAY_MS || '300000', 10);

export function createScheduleRunner({
  dataDir,
  bind = '127.0.0.1',
  port = 8383,
  sharedKey = '',
  retryDelayMs = DEFAULT_RETRY_DELAY_MS
} = {}) {
  if (!dataDir) {
    throw new Error('createScheduleRunner: dataDir is required');
  }
  const advertiseUrl = `http://${bind}:${port}/v1/advertise`;
  const baseHeaders = {
    'Content-Type': 'application/json',
    'X-Cryer-Key': sharedKey
  };

  return async function runScheduleTick({ now = Date.now(), fetchImpl } = {}) {
    const effectiveFetch = fetchImpl || globalThis.fetch;
    if (typeof effectiveFetch !== 'function') {
      throw new Error('runScheduleTick: fetch implementation is not available');
    }

    const scheduleList = listSchedules(dataDir);
    for (const schedule of scheduleList) {
      if (!schedule) continue;
      const whenMs = Number(schedule.whenMs || 0);
      if (whenMs > now) continue;

      const attempt = Number(schedule.attemptCount || 0) + 1;
      const baseMeta = {
        id: schedule.id,
        serverKey: schedule.serverKey,
        reason: schedule.reason,
        attempt
      };

      log.info('schedule.trigger', baseMeta);

      try {
        const response = await effectiveFetch(advertiseUrl, {
          method: 'POST',
          headers: { ...baseHeaders },
          body: JSON.stringify({
            serverKey: schedule.serverKey,
            dryRun: false,
            autoScheduleIfThrottled: false
          })
        });

        if (response?.ok) {
          log.info('schedule.trigger_success', { ...baseMeta, status: response.status ?? null });
          removeSchedule(dataDir, schedule.id);
          continue;
        }

        const status = response?.status ?? null;
        const retryAt = now + retryDelayMs;
        const updated = updateSchedule(dataDir, schedule.id, {
          whenMs: retryAt,
          attemptCount: attempt,
          lastAttemptMs: now,
          lastError: status === null ? 'no response' : `status ${status}`
        });
        log.warn('schedule.retry_postponed', { ...baseMeta, status, retryAt });
        if (!updated) {
          log.warn('schedule.retry_missing_after_postpone', baseMeta);
        }
      } catch (error) {
        const retryAt = now + retryDelayMs;
        const updated = updateSchedule(dataDir, schedule.id, {
          whenMs: retryAt,
          attemptCount: attempt,
          lastAttemptMs: now,
          lastError: error?.message || String(error)
        });
        log.warn('schedule.retry_error', { ...baseMeta, error: error?.message || String(error), retryAt });
        if (!updated) {
          log.warn('schedule.retry_missing_after_error', baseMeta);
        }
      }
    }
  };
}

export default createScheduleRunner;
