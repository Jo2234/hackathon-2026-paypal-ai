import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/integration/race.*.test.ts'], maxWorkers: 1, fileParallelism: false, testTimeout: 30000 } });
