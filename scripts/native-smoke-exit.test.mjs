import assert from 'node:assert/strict';
import test from 'node:test';

import { assertNormalClose } from './native-smoke-exit.mjs';

const closed = { requestExitCode: 0, closeMainWindowAccepted: 'True', exited: true, exitCode: 0 };

test('normal close requires a successful request and zero application exit code', () => {
  assert.doesNotThrow(() => assertNormalClose(closed));
});

for (const [field, value] of [
  ['requestExitCode', 1],
  ['closeMainWindowAccepted', 'False'],
  ['exited', false],
  ['exitCode', 1],
  ['exitCode', null],
]) {
  test(`normal close rejects ${field}=${value}`, () => {
    assert.throws(() => assertNormalClose({ ...closed, [field]: value }));
  });
}
