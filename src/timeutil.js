import { DateTime } from 'luxon';

export const WEEKDAYS_RU = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const WD_SHORT = ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС'];
const RRULE_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export const utc = (iso) => DateTime.fromISO(iso, { zone: 'utc' });
export const isoUtc = (dt) => dt.toUTC().toISO(); // формат вида 2026-11-10T14:00:00.000Z, совместим с Date.toISOString()

// «Сейчас» в поясе человека для подсказки модели
export function localNowInfo(tz, nowIsoUtc) {
  const d = utc(nowIsoUtc).setZone(tz).setLocale('ru');
  return { nowLocal: d.toFormat("yyyy-MM-dd'T'HH:mm:ss"), weekday: WEEKDAYS_RU[d.weekday - 1] };
}

// ---------- повторы (RRULE, RFC 5545) ----------
export function buildRrule(weekdays, intervalWeeks) {
  return `FREQ=WEEKLY;INTERVAL=${intervalWeeks};BYDAY=${weekdays.map((n) => RRULE_DAYS[n - 1]).join(',')}`;
}
export function parseRrule(rrule) {
  const interval = Number(/INTERVAL=(\d+)/.exec(rrule)?.[1] ?? 1);
  const days = (/BYDAY=([A-Z,]+)/.exec(rrule)?.[1] ?? '').split(',').map((d) => RRULE_DAYS.indexOf(d) + 1).filter((n) => n > 0);
  return { weekdays: days, intervalWeeks: interval };
}

// Ближайшее срабатывание строго после afterIso. Считаем в местном времени, поэтому 9:00 остаётся 9:00 и после перехода на летнее время.
export function nextRecurrence({ afterIso, tz, localTime, weekdays, intervalWeeks, anchorDate }) {
  const after = utc(afterIso).setZone(tz);
  const [hh, mm] = localTime.split(':').map(Number);
  const anchorMonday = DateTime.fromISO(anchorDate, { zone: tz }).startOf('week');
  const span = 7 * intervalWeeks + 7;
  for (let i = 0; i <= span; i++) {
    const day = after.startOf('day').plus({ days: i });
    if (!weekdays.includes(day.weekday)) continue;
    const weeks = Math.round(day.startOf('week').diff(anchorMonday, 'weeks').weeks);
    if (((weeks % intervalWeeks) + intervalWeeks) % intervalWeeks !== 0) continue;
    const cand = day.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
    if (cand > after) return isoUtc(cand);
  }
  return null;
}

// ---------- план напоминания по ответу модели ----------
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function planReminder(remind, tz, nowIso) {
  if (!remind) return null;
  const now = utc(nowIso).setZone(tz);

  if (remind.repeat) {
    const weekdays = [...new Set(remind.repeat.weekdays.filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))].sort((a, b) => a - b);
    if (!weekdays.length) return null;
    const intervalWeeks = clamp(Number.isInteger(remind.repeat.interval_weeks) ? remind.repeat.interval_weeks : 1, 1, 52);
    const tm = remind.at ? /T(\d{2}:\d{2})/.exec(remind.at)?.[1] : null;
    const localTime = tm && TIME_RE.test(tm) ? tm : '09:00';
    // «Раз в N недель» отсчитываем от недели первого срабатывания
    const first = nextRecurrence({ afterIso: nowIso, tz, localTime, weekdays, intervalWeeks: 1, anchorDate: now.toISODate() });
    if (!first) return null;
    const anchorDate = utc(first).setZone(tz).toISODate();
    const remindAt = nextRecurrence({ afterIso: nowIso, tz, localTime, weekdays, intervalWeeks, anchorDate });
    if (!remindAt) return null;
    return { remindAt, tz, rrule: buildRrule(weekdays, intervalWeeks), localTime, anchorDate };
  }

  if (Number.isInteger(remind.in_minutes) && remind.in_minutes > 0 && remind.in_minutes <= 60 * 24 * 365) {
    return { remindAt: isoUtc(now.plus({ minutes: remind.in_minutes })), tz };
  }

  if (remind.at) {
    let local = DateTime.fromISO(remind.at, { zone: tz });
    if (!local.isValid) return null;
    if (local <= now) {
      if (!local.hasSame(now, 'day')) return null;   // дата в прошлом: напоминание не ставим
      local = local.plus({ days: 1 });               // время сегодня уже прошло: значит завтра
    }
    if (local > now.plus({ years: 2 })) return null;
    return { remindAt: isoUtc(local), tz };
  }
  return null;
}

// ---------- человеческий вид ----------
export function formatWhen(iso, tz, nowIso) {
  const d = utc(iso).setZone(tz).setLocale('ru');
  const now = utc(nowIso).setZone(tz);
  const t = d.toFormat('H:mm');
  if (d.hasSame(now, 'day')) return `сегодня в ${t}`;
  if (d.hasSame(now.plus({ days: 1 }), 'day')) return `завтра в ${t}`;
  return `${d.toFormat('d MMMM')} в ${t}`;
}

export function describeRepeat(rrule, localTime) {
  const { weekdays, intervalWeeks } = parseRrule(rrule);
  let days;
  if (weekdays.length === 7) days = 'каждый день';
  else if (weekdays.join() === '1,2,3,4,5') days = 'по будням';
  else days = `по дням: ${weekdays.map((n) => WD_SHORT[n - 1].toLowerCase()).join(', ')}`;
  const every = intervalWeeks > 1 ? `, раз в ${intervalWeeks} нед.` : '';
  return `${days}${every} в ${localTime}`;
}

export const snoozeHour = (nowIso) => isoUtc(utc(nowIso).plus({ hours: 1 }));
export function tomorrowNine(tz, nowIso) {
  return isoUtc(utc(nowIso).setZone(tz).plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 }));
}
