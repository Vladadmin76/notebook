import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inboxText } from '../src/reminders.js';

test('склонение «ссылка» в напоминании о Входящих', () => {
  assert.match(inboxText(1), /лежит 1 неразобранная ссылка\./);
  assert.match(inboxText(3), /лежит 3 неразобранные ссылки\./);
  assert.match(inboxText(5), /лежит 5 неразобранных ссылок\./);
  assert.match(inboxText(11), /лежит 11 неразобранных ссылок\./);
  assert.match(inboxText(21), /лежит 21 неразобранная ссылка\./);
});
