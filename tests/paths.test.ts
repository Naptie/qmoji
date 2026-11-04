import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { dataRoot, resolveDataPath, safeFileName } from '../src/paths.ts';

test('resolveDataPath resolves a stored path inside the data directory', () => {
  const resolved = resolveDataPath('data/global/abc.jpg');
  assert.equal(resolved, path.join(dataRoot, 'global', 'abc.jpg'));
});

test('resolveDataPath accepts a path without the leading data segment', () => {
  assert.equal(resolveDataPath('global/abc.jpg'), path.join(dataRoot, 'global', 'abc.jpg'));
});

test('resolveDataPath accepts Windows-style separators', () => {
  assert.equal(resolveDataPath('data\\global\\abc.jpg'), path.join(dataRoot, 'global', 'abc.jpg'));
});

test('resolveDataPath refuses to escape the data directory', () => {
  const escaped = resolveDataPath('../../etc/passwd');
  assert.ok(
    escaped.startsWith(dataRoot),
    `expected the result to stay under ${dataRoot}, got ${escaped}`
  );

  const sneaky = resolveDataPath('data/global/../../../../etc/passwd');
  assert.ok(sneaky.startsWith(dataRoot), `expected the result to stay under ${dataRoot}`);
});

test('safeFileName strips every directory component', () => {
  assert.equal(safeFileName('abc.jpg'), 'abc.jpg');
  assert.equal(safeFileName('../../abc.jpg'), 'abc.jpg');
  assert.equal(safeFileName('/etc/passwd'), 'passwd');
  assert.equal(safeFileName('a\\b\\abc.jpg'), 'abc.jpg');
});

test('safeFileName always returns something usable', () => {
  assert.equal(safeFileName(''), 'image');
  assert.equal(safeFileName('..'), 'image');
  assert.equal(safeFileName('.'), 'image');
  assert.equal(safeFileName('../..'), 'image');
});
