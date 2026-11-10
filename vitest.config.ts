import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/unit/**/*.test.ts', 'tests/integration/db.*.test.ts'], maxWorkers: 1, fileParallelism: false, testTimeout: 5000 } });
