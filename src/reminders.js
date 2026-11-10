import * as db from './db.js';
import { nextRecurrence, parseRrule } from './timeutil.js';
import { escapeHtml } from './util.js';

const BATCH = 15; // на бесплатном тарифе Workers ограничено число внешних запросов за один вызов

export const reminderKeyboard = (id) => ({ inline_keyboard: [
  [{ text: '✅ Готово', callback_data: `rd:${id}` }],
  [{ text: 'Отложить на 1 час', callback_data: `rs:${id}:h` }, { text: 'До завтра 9:00', callback_data: `rs:${id}:t` }],
] });

// Вызывается внешним таймером раз в минуту. Возвращает число отправленных.
export async function processTick(env, api, nowIso = new Date().toISOString()) {
  const D = env.DB;
  const due = await db.dueReminders(D, nowIso, BATCH);
  let sent = 0;

  for (const r of due) {
    if (r.ustatus === 'blocked') { await db.cancelReminder(D, r.id); continue; }

    // Для повторов считаем следующее срабатывание после «сейчас» (пропущенные не догоняем)
    let next = null;
    if (r.rrule) {
      const { weekdays, intervalWeeks } = parseRrule(r.rrule);
      next = nextRecurrence({ afterIso: nowIso, tz: r.tz, localTime: r.local_time, weekdays, intervalWeeks, anchorDate: r.anchor_date });
    }
    if (!(await db.claimReminder(D, r, next, nowIso))) continue; // уже взят параллельным вызовом

    try {
      await api.sendMessage(r.user_id, `🔔 Напоминание: ${escapeHtml(r.msg ?? '')}`,
        { parse_mode: 'HTML', reply_markup: reminderKeyboard(r.id) });
      sent++;
    } catch (e) {
      const code = e?.error_code;
      if (code === 403 || code === 400) await db.cancelReminder(D, r.id);  // бот заблокирован или чата нет: больше не пытаемся
      else await db.revertReminder(D, r);                                   // временный сбой: повторим на следующей минуте
      console.error('reminder send failed', r.id, code ?? e?.message);
    }
  }
  return sent;
}
