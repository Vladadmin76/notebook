import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs, googleCalendarUrl, signIcs, verifyIcs } from '../src/ics.js';

test('разовое событие: UTC, сигнал в момент события, экранирование', () => {
  const ics = buildIcs({ uid: 'n1r1', text: 'Позвонить; Ивану, срочно', remindAtIso: '2026-11-11T15:00:00.000Z', tz: 'America/Chicago', rrule: null });
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /DTSTART:20261111T150000Z/);
  assert.match(ics, /BEGIN:VALARM/);
  assert.match(ics, /TRIGGER:PT0S/);
  assert.ok(ics.includes('SUMMARY:Позвонить\; Ивану\\, срочно'));
  assert.ok(ics.endsWith('\r\n'));
  assert.ok(!ics.includes('RRULE'));
});
test('повтор: время в местном поясе и правило', () => {
  const ics = buildIcs({ uid: 'n2r2', text: 'Планерка', remindAtIso: '2026-11-11T16:30:00.000Z', tz: 'America/Chicago', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE' });
  assert.match(ics, /DTSTART;TZID=America\/Chicago:20261111T103000/);
  assert.match(ics, /RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;WKST=MO/);
});
test('длинные строки переносятся до 75 байт', () => {
  const ics = buildIcs({ uid: 'n3', text: 'очень длинный текст '.repeat(10), remindAtIso: '2026-11-11T15:00:00.000Z', tz: 'UTC', rrule: null });
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
});
test('ссылка Google Календаря', () => {
  const u = googleCalendarUrl({ text: 'Врач', remindAtIso: '2026-11-11T15:00:00.000Z', tz: 'UTC', rrule: null });
  assert.match(u, /calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
  assert.match(u, /dates=20261111T150000Z%2F20261111T151500Z/);
});
test('подпись ссылки: верная проходит, чужая и просроченная нет', async () => {
  const now = 1_700_000_000, exp = now + 600;
  const sig = await signIcs('tok', 5, 42, exp);
  assert.equal(await verifyIcs('tok', 5, 42, exp, sig, now), true);
  assert.equal(await verifyIcs('tok', 6, 42, exp, sig, now), false);   // другая заметка
  assert.equal(await verifyIcs('tok', 5, 43, exp, sig, now), false);   // другой человек
  assert.equal(await verifyIcs('other', 5, 42, exp, sig, now), false); // другой токен бота
  assert.equal(await verifyIcs('tok', 5, 42, exp, sig, exp + 1), false); // срок вышел
});
