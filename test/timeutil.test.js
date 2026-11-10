import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReminder, nextRecurrence, buildRrule, parseRrule, formatWhen, describeRepeat } from '../src/timeutil.js';

const TZ = 'America/Chicago';
// 10 ноября 2026, вторник, 13:57 по Чикаго (UTC-6) = 19:57 UTC
const NOW = '2026-11-10T19:57:00.000Z';

test('«завтра в 9» превращается в UTC с учётом пояса', () => {
  const p = planReminder({ at: '2026-11-11T09:00:00', in_minutes: null, repeat: null }, TZ, NOW);
  assert.equal(p.remindAt, '2026-11-11T15:00:00.000Z');
});
test('«через 3 минуты» считается от текущего момента', () => {
  const p = planReminder({ at: null, in_minutes: 3, repeat: null }, TZ, NOW);
  assert.equal(p.remindAt, '2026-11-10T20:00:00.000Z');
});
test('время сегодня уже прошло: переносится на завтра', () => {
  const p = planReminder({ at: '2026-11-10T09:00:00', in_minutes: null, repeat: null }, TZ, NOW);
  assert.equal(p.remindAt, '2026-11-11T15:00:00.000Z');
});
test('дата в прошлом: напоминание не ставится', () => {
  assert.equal(planReminder({ at: '2026-11-01T09:00:00', in_minutes: null, repeat: null }, TZ, NOW), null);
});
test('«каждый понедельник в 9»: первое срабатывание в ближайший понедельник', () => {
  const p = planReminder({ at: '2026-11-10T09:00:00', in_minutes: null, repeat: { weekdays: [1], interval_weeks: 1 } }, TZ, NOW);
  assert.equal(p.remindAt, '2026-11-16T15:00:00.000Z');
  assert.equal(p.rrule, 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO');
});
test('повтор остаётся 9:00 по местному времени после перехода на летнее время', () => {
  // зимой Чикаго UTC-6, с 8 марта 2026 летом UTC-5: девять утра = 15:00 UTC зимой и 14:00 UTC летом
  const base = { tz: TZ, localTime: '09:00', weekdays: [1], intervalWeeks: 1, anchorDate: '2026-03-02' };
  assert.equal(nextRecurrence({ ...base, afterIso: '2026-03-02T15:00:01.000Z' }), '2026-03-09T14:00:00.000Z');
  assert.equal(nextRecurrence({ ...base, afterIso: '2026-02-23T15:00:01.000Z' }), '2026-03-02T15:00:00.000Z');
});
test('«раз в две недели по пятницам» пропускает нечётные недели', () => {
  const p = planReminder({ at: null, in_minutes: null, repeat: { weekdays: [5], interval_weeks: 2 } }, TZ, NOW); // ближайшая пятница 13 ноября
  assert.equal(p.remindAt, '2026-11-13T15:00:00.000Z');
  const next = nextRecurrence({ afterIso: p.remindAt, tz: TZ, localTime: '09:00', weekdays: [5], intervalWeeks: 2, anchorDate: p.anchorDate });
  assert.equal(next, '2026-11-27T15:00:00.000Z');
});
test('«по будням» пропускает выходные', () => {
  const fri = nextRecurrence({ afterIso: '2026-11-13T15:00:01.000Z', tz: TZ, localTime: '09:00', weekdays: [1, 2, 3, 4, 5], intervalWeeks: 1, anchorDate: '2026-11-09' });
  assert.equal(fri, '2026-11-16T15:00:00.000Z');
});
test('rrule туда и обратно, описание по-русски', () => {
  const r = buildRrule([1, 3], 2);
  assert.deepEqual(parseRrule(r), { weekdays: [1, 3], intervalWeeks: 2 });
  assert.match(describeRepeat(buildRrule([1, 2, 3, 4, 5], 1), '09:00'), /по будням в 09:00/);
});
test('формат даты для ответа', () => {
  assert.equal(formatWhen('2026-11-11T15:00:00.000Z', TZ, NOW), 'завтра в 9:00');
  assert.equal(formatWhen('2026-11-20T15:00:00.000Z', TZ, NOW), '20 ноября в 9:00');
});

test('«через 2 минуты» округляется до ближайшей минуты', () => {
  const early = planReminder({ at: null, in_minutes: 2, repeat: null }, TZ, '2026-11-10T19:57:20.000Z'); // 19:59:20 -> 19:59:00
  const late = planReminder({ at: null, in_minutes: 2, repeat: null }, TZ, '2026-11-10T19:57:50.000Z');  // 19:59:50 -> 20:00:00
  assert.equal(early.remindAt, '2026-11-10T19:59:00.000Z');
  assert.equal(late.remindAt, '2026-11-10T20:00:00.000Z');
});
