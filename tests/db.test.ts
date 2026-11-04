import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// db.ts opens the database at import time, so the location has to be set
// before it is loaded — hence the dynamic import.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmoji-db-'));
process.env.QMOJI_DB_PATH = path.join(tmpDir, 'qmoji.db');

const db = await import('../src/db.ts');

test.after(() => {
  db.closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// The module opens one database for the whole file, so every test starts from
// an empty table.
test.beforeEach(() => {
  db.default.prepare('DELETE FROM images').run();
});

const insert = (name: string, filePath: string, userId: string, savedBy = '1') =>
  db.insertImage(name, filePath, userId, savedBy);

test('countImagesByFilePath counts every row that points at a file', () => {
  insert('a', 'data/global/x.jpg', 'global');
  insert('b', 'data/global/x.jpg', 'global');
  insert('c', 'data/global/y.jpg', 'global');

  assert.equal(db.countImagesByFilePath('data/global/x.jpg'), 2);
  assert.equal(db.countImagesByFilePath('data/global/y.jpg'), 1);
  assert.equal(db.countImagesByFilePath('data/global/none.jpg'), 0);
});

test('a shared file keeps its reference count while a sibling row exists', () => {
  // This is the regression that used to create dead rows: the old guard asked
  // "does my own scope still reference this file?", which missed rows in
  // other scopes and unlinked the file out from under them.
  const first = insert('shared', 'data/global/shared.jpg', 'global');
  const second = insert('shared', 'data/global/shared.jpg', 'global');

  assert.equal(db.countImagesByFilePath('data/global/shared.jpg'), 2);

  db.deleteImageById(first.id);
  assert.equal(
    db.countImagesByFilePath('data/global/shared.jpg'),
    1,
    'the file must still be referenced by the surviving row'
  );

  db.deleteImageById(second.id);
  assert.equal(
    db.countImagesByFilePath('data/global/shared.jpg'),
    0,
    'the file may be unlinked once the last row is gone'
  );
});

test('getImagesByUser only returns the scopes that were asked for', () => {
  insert('u', 'data/111/u.jpg', '111');
  insert('g', 'data/chat-222/g.jpg', 'chat-222');
  insert('glob', 'data/global/glob.jpg', 'global');

  const userOnly = db.getImagesByUser('111', null, false);
  assert.deepEqual(
    userOnly.map((row) => row.user_id),
    ['111']
  );

  const groupOnly = db.getImagesByUser(null, '222', false);
  assert.deepEqual(
    groupOnly.map((row) => row.user_id),
    ['chat-222']
  );

  const withGlobal = db.getImagesByUser('111', '222', true);
  assert.deepEqual(withGlobal.map((row) => row.user_id).sort(), ['111', 'chat-222', 'global']);
});

test('getImagesByUser never matches a placeholder scope', () => {
  insert('u', 'data/111/u.jpg', '111');
  // The old implementation always queried `chat-${groupId}`, so a null group
  // id produced the literal scope "chat-null" — a value that could never
  // match, but that made the query look like it covered a group scope.
  assert.deepEqual(db.getImagesByUser(null, null, false), []);
  assert.deepEqual(db.getImagesByUser('111', null, false).length, 1);
});

test('getImagesByNameAndUser filters by name and scope', () => {
  insert('mine', 'data/111/mine.jpg', '111');
  insert('mine', 'data/chat-222/mine.jpg', 'chat-222');
  insert('mine', 'data/global/mine.jpg', 'global');
  insert('other', 'data/111/other.jpg', '111');

  assert.equal(db.getImagesByNameAndUser('mine', '111').length, 1);
  assert.equal(db.getImagesByNameAndUser('mine', '111', '222').length, 2);
  assert.equal(db.getImagesByNameAndUser('mine', '111', '222', true).length, 3);
  assert.equal(db.getImagesByNameAndUser('nope', '111').length, 0);
});

test('updateImageScope moves a row and its path together', () => {
  const row = insert('move', 'data/111/move.jpg', '111');

  assert.ok(db.updateImageScope(row.id, 'global', 'data/global/move.jpg'));

  const moved = db.getImageById(row.id);
  assert.equal(moved?.user_id, 'global');
  assert.equal(moved?.file_path, 'data/global/move.jpg');
  assert.equal(db.countImagesByFilePath('data/111/move.jpg'), 0);
  assert.equal(db.countImagesByFilePath('data/global/move.jpg'), 1);
});

test('clearImagesByNameAndUserId only removes the matching rows', () => {
  insert('twin', 'data/111/twin.jpg', '111');
  insert('twin', 'data/111/twin2.jpg', '111');
  insert('twin', 'data/chat-222/twin.jpg', 'chat-222');

  assert.equal(db.clearImagesByNameAndUserId('twin', '111'), 2);
  assert.equal(db.getImagesByNameAndUser('twin', '111').length, 0);
  assert.equal(db.getImagesByNameAndUser('twin', 'chat-222').length, 1);
});

test('deleteImagesBySavedBy removes every row of that user across scopes', () => {
  insert('by', 'data/111/by.jpg', '111', 'author');
  insert('by', 'data/global/by.jpg', 'global', 'author');
  insert('by', 'data/111/keep.jpg', '111', 'someone-else');

  assert.equal(db.deleteImagesBySavedBy('author'), 2);
  assert.equal(db.getImagesBySavedBy('author').length, 0);
  assert.equal(db.getImagesBySavedBy('someone-else').length, 1);
});

test('incrementUseCount only touches the given row', () => {
  const row = insert('use', 'data/global/use.jpg', 'global');

  db.incrementUseCount(row.id);
  db.incrementUseCount(row.id);

  assert.equal(db.getImageById(row.id)?.use_count, 2);
});
