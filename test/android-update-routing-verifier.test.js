import test from 'node:test';
import assert from 'node:assert/strict';
import { forceDirectMetadataFailure } from '../scripts/verify-android-update-fallback.mjs';

test('isolated Android fallback changes only the direct callback and preserves fallback and cancellation guards', () => {
  const original = 'return UpdateCheckNetwork.run(() -> latestRelease(job), () -> {\nprepareNetwork(job);\nreturn latestRelease(job);\n}, job::check, () -> !proxyControl.state(false).manuallyDisabled);';
  const fixture = forceDirectMetadataFailure(original);
  assert.match(fixture, /throw new UpdateCheckNetwork\.Failure\("Isolated direct metadata failure fixture\."\)/);
  assert.equal(fixture.slice(fixture.indexOf('}, () -> {') + 1), original.slice(original.indexOf(', () -> {')));
  assert.match(original, /run\(\(\) -> latestRelease\(job\)/);
});

test('isolated Android fallback refuses missing or ambiguous injection points', () => {
  assert.throws(() => forceDirectMetadataFailure('unrelated updater'), /exactly one direct check callback/);
  assert.throws(() => forceDirectMetadataFailure('UpdateCheckNetwork.run(() -> latestRelease(job), () -> {'.repeat(2)), /exactly one direct check callback/);
});
