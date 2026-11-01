import assert from 'node:assert/strict';
import test from 'node:test';
import { difficultyClass } from './build-song-db.ts';

test('难度别名只将第 3 槽位的 INS 与 BYD 区分', () => {
  assert.equal(difficultyClass(3), 'BYD');
  assert.equal(difficultyClass(3, 1), 'INS');
  assert.equal(difficultyClass(4), 'ETR');
  assert.throws(() => difficultyClass(3, 2), /未知难度别名/);
});
