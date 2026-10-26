import assert from 'node:assert/strict';

export function assertNormalClose(result) {
  assert.equal(result.requestExitCode, 0);
  assert.equal(result.closeMainWindowAccepted, 'True');
  assert.equal(result.exited, true);
  assert.equal(result.exitCode, 0);
}
