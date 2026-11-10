// Contracts for S2; constants do not implement transport/deadline enforcement.
export const LIMITS = Object.freeze({
  mutationMs: 5000, dbDeadlineMs: 2000, dbBusyMs: 100, dbRetryBackoffsMs: [50, 150, 400] as const,
  requestBytes: 65536, responseBytes: 1048576, headersBytes: 16384,
  oauth: { totalMs: 10000, attempts: 2, attemptMs: 5000, backoffMs: 250, bytes: 65536 },
  get: { totalMs: 15000, attempts: 2, attemptMs: 7000, backoffMs: 500, retryAfterMs: 2000, bytes: 1048576 },
  post: { sessionMs: 60000, claimMs: 30000, wireMs: 20000, attempts: 1, redirects: 0, bytes: 1048576 },
  cert: { totalMs: 5000, attempts: 1, redirects: 0, bytes: 65536, cacheEntries: 32, ttlMs: 3600000 },
  compile: { totalMs: 60000, calls: 2, callMs: 30000, bytes: 65536, tokens: 2048, textChars: 2000 },
  agent: { totalMs: 30000, calls: 1, bytes: 32768, tokens: 1024, requestChars: 500 },
  recovery: { startupMs: 30000, tickMs: 20000, intervalMs: 30000, manualMs: 60000, scan: 100, gets: 10, manualIntervalMs: 60000 },
  maintenance: { leaseMs: 65000, renewalMs: 10000 },
  wireGet: { callbackAttempts: 4, callbackWindowMs: 60000, foregroundAttempts: 60, foregroundWindowMs: 60000, manualAttempts: 24, manualWindowMs: 3600000 },
  autoGet: { horizonMs: 86400000, attempts: 24, initialIntervalMs: 60000, laterIntervalMs: 300000 },
  readyMs: 1800000, reservationMs: 1800000, freshApprovalMs: 5000, shutdownMs: 5000,
  queue: 20, jobs: 1000, ownerBatch: 100, webhookBodyBytes: 262144, inboxBytes: 10485760, deliveries: 1000, pruneBatch: 100,
  idempotencyKeys: 100000, responseRetentionMs: 604800000, compilerLeaseMs: 65000, ledgerRows: 100000,
  session: { absoluteMs: 43200000, idleMs: 1800000 },
});
