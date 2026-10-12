/**
 * Node-only test helpers: the `node:sqlite` driver and a composer that wires it to the platform-neutral fakes
 * from `@custar/learner-core/fakes`. Do not import this from app code.
 */
export { NodeSqliteDriver } from './node-sqlite-driver';
export { createTestPorts, createTrustedClock } from './create-test-ports';
export type { CreateTestPortsOptions, TestPorts } from './create-test-ports';
