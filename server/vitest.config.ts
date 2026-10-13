import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://gest:gest@localhost:5432/gestionale_test', NODE_ENV: 'test' }, fileParallelism: false, testTimeout: 30000 } });
