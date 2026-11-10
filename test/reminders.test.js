import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inboxText, digestDue } from '../src/reminders.js';
import { utc } from '../src/timeutil.js';

test('склонение «ссылка» в напоминании о Входящих', () => {
  assert.match(inboxText(1), /лежит 1 неразобранная ссылка\./);
  assert.match(inboxText(3), /лежит 3 неразобранные ссылки\./);
  assert.match(inboxText(5), /лежит 5 неразобранных ссылок\./);
  assert.match(inboxText(11), /лежит 11 неразобранных ссылок\./);
  assert.match(inboxText(21), /лежит 21 неразобранная ссылка\./);
});

const at = (iso, tz = 'America/Chicago') => utc(iso).setZone(tz);
test('напоминание о «Входящих» уходит только в окне 12:00-14:00 и раз в сутки', () => {
  assert.equal(digestDue(at('2026-11-11T17:59:00.000Z'), null), false);        // 11:59 по Чикаго
  assert.equal(digestDue(at('2026-11-11T18:00:00.000Z'), null), true);         // 12:00
  assert.equal(digestDue(at('2026-11-11T19:30:00.000Z'), null), true);         // 13:30 (если в 12:00 таймер не сработал)
  assert.equal(digestDue(at('2026-11-11T20:00:00.000Z'), null), false);        // 14:00: поздно, ждём следующий день
  assert.equal(digestDue(at('2026-11-11T23:00:00.000Z'), null), false);        // 17:00: ссылка, добавленная вечером, не вызывает сообщения сразу
  assert.equal(digestDue(at('2026-11-11T18:05:00.000Z'), '2026-11-11'), false); // сегодня уже отправлено
  assert.equal(digestDue(at('2026-11-12T18:00:00.000Z'), '2026-11-11'), true);  // на следующий день снова
});
