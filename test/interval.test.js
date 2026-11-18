import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextIntervalSlot, normalizeInterval, describeInterval, planReminder, utc } from '../src/timeutil.js';
import { parseModelReply } from '../src/deepseek.js';

const TZ = 'America/Chicago';
const local = (iso) => utc(iso).setZone(TZ).toFormat("ccc HH:mm");
const slot = (afterLocal, extra = {}) => nextIntervalSlot({
  afterIso: new Date(new Date(`${afterLocal}Z`).getTime() + 6 * 3600e3).toISOString(), // местное Чикаго (зима, UTC-6) → UTC
  tz: TZ, from: '08:00', to: '20:00', everyMinutes: 120, weekdays: [1, 2, 3, 4, 5, 6], ...extra,
});

test('срок: до начала окна — начало окна; внутри окна — следующий шаг; ровно в срок — следующий', () => {
  assert.equal(local(slot('2026-11-16T07:00:00')), 'Mon 08:00');
  assert.equal(local(slot('2026-11-16T08:00:00')), 'Mon 10:00');
  assert.equal(local(slot('2026-11-16T09:30:00')), 'Mon 10:00');
});
test('срок: последний срок дня не позже конца окна, дальше следующий рабочий день; воскресенье пропускается', () => {
  assert.equal(local(slot('2026-11-16T19:00:00')), 'Mon 20:00');
  assert.equal(local(slot('2026-11-16T20:00:00')), 'Tue 08:00');
  assert.equal(local(slot('2026-11-21T20:05:00')), 'Mon 08:00'); // суббота вечером → понедельник
  assert.equal(local(slot('2026-11-21T20:05:00', { weekdays: [1, 2, 3, 4, 5, 6, 7] })), 'Sun 08:00'); // с воскресеньем
});
test('срок: окно, не кратное шагу, и круглые сутки', () => {
  assert.equal(local(slot('2026-11-16T19:00:00', { to: '20:30' })), 'Mon 20:00');
  assert.equal(local(slot('2026-11-16T23:30:00', { from: '00:00', to: '23:59' })), 'Tue 00:00');
  assert.equal(local(slot('2026-11-16T21:00:00', { from: '00:00', to: '23:59', everyMinutes: 180 })), 'Tue 00:00'); // 21:00 строго после 21:00 нет: следующий 00:00
});
test('срок: переход на зимнее время не сдвигает местные часы окна', () => {
  // 1 ноября 2026 в США конец летнего времени; 8:00 остаётся 8:00 по местным часам
  const sun = nextIntervalSlot({ afterIso: '2026-11-01T05:30:00.000Z', tz: TZ, from: '08:00', to: '20:00', everyMinutes: 120, weekdays: [1, 2, 3, 4, 5, 6, 7] });
  assert.equal(utc(sun).setZone(TZ).toFormat('ccc HH:mm'), 'Sun 08:00');
});

test('нормализация расписания: шаг не короче 10 минут, плохие значения заменяются, настойчивый режим по умолчанию', () => {
  assert.deepEqual(normalizeInterval({ every_minutes: 1 }), { everyMinutes: 10, from: '09:00', to: '21:00', weekdays: [1, 2, 3, 4, 5, 6, 7], nag: true });
  assert.equal(normalizeInterval({ every_minutes: 120, from: '8:00', to: '20:00' }).from, '08:00');
  assert.equal(normalizeInterval({ every_minutes: 120, from: '20:00', to: '08:00' }).to, '23:59'); // окно «до утра» обрезается концом суток
  assert.equal(normalizeInterval({ every_minutes: 120, nag: false }).nag, false);
  assert.deepEqual(normalizeInterval({ every_minutes: 60, weekdays: [6, 1, 1, 9, 'x'] }).weekdays, [1, 6]);
  assert.equal(normalizeInterval({ every_minutes: 'abc' }), null);
  assert.equal(normalizeInterval(null), null);
});

test('описание расписания человеческим языком', () => {
  assert.equal(describeInterval({ everyMinutes: 120, from: '08:00', to: '20:00', weekdays: [1, 2, 3, 4, 5, 6] }), 'каждые 2 часа, с 8:00 до 20:00, с понедельника по субботу');
  assert.equal(describeInterval({ everyMinutes: 60, from: '00:00', to: '23:59', weekdays: [1, 2, 3, 4, 5, 6, 7] }), 'каждый час, круглые сутки, каждый день');
  assert.equal(describeInterval({ everyMinutes: 45, from: '09:00', to: '21:00', weekdays: [1, 2, 3, 4, 5] }), 'каждые 45 мин, с 9:00 до 21:00, по будням');
  assert.equal(describeInterval({ everyMinutes: 360, from: '09:00', to: '21:00', weekdays: [1, 3] }), 'каждые 6 часов, с 9:00 до 21:00, пн, ср');
});

test('план напоминания: расписание даёт первый срок и параметры', () => {
  const plan = planReminder({ at: null, in_minutes: null, repeat: null, interval: { every_minutes: 120, from: '08:00', to: '20:00', weekdays: [1, 2, 3, 4, 5, 6], nag: true } }, TZ, '2026-11-16T14:30:00.000Z'); // 8:30 по Чикаго
  assert.equal(utc(plan.remindAt).setZone(TZ).toFormat('ccc HH:mm'), 'Mon 10:00');
  assert.equal(plan.interval.everyMinutes, 120);
  assert.equal(plan.interval.nag, true);
  assert.equal(planReminder({ interval: { every_minutes: 'x' } }, TZ, '2026-11-16T14:30:00.000Z'), null);
});

test('ответ модели: расписание «каждые 2 часа» проходит разбор', () => {
  const reply = JSON.stringify({ notes: [{ text: 'Пить воду.', folder: 'Задачи', new_folder: false, remind: { at: null, in_minutes: null, repeat: null,
    interval: { every_minutes: 120, from: '08:00', to: '20:00', weekdays: [1, 2, 3, 4, 5, 6], nag: true }, text: 'Попить воды' } }], shopping: [], request: null });
  const r = parseModelReply(reply, ['Идеи', 'Задачи', 'Разное'], 'напоминай пить воду каждые 2 часа с 8 до 20 с понедельника по субботу');
  assert.deepEqual(r.notes[0].remind.interval, { every_minutes: 120, from: '08:00', to: '20:00', weekdays: [1, 2, 3, 4, 5, 6], nag: true });
  assert.equal(r.notes[0].remind.text, 'Попить воды');
});
