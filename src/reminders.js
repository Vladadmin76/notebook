import * as db from './db.js';
import { nextRecurrence, parseRrule, nextIntervalSlot, isoUtc } from './timeutil.js';
import { escapeHtml } from './util.js';
import { utc } from './timeutil.js';
import { DIGEST_HOUR, DIGEST_WINDOW_HOURS, INBOX_NAME } from './config.js';

const BATCH = 15;
const NAG_BATCH = 8;   // повторения «пока не нажато Готово» за один вызов
const NAG_EVERY_SEC = 60; // на бесплатном тарифе Workers ограничено число внешних запросов за один вызов

// У напоминаний «каждые N часов» только «Готово»: расписание жёсткое, откладывать нечего
export const intervalKeyboard = (id) => ({ inline_keyboard: [[{ text: '✅ Готово', callback_data: `rd:${id}` }]] });

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
    if (r.int_minutes) {
      next = nextIntervalSlot({ afterIso: nowIso, tz: r.tz, from: r.win_from, to: r.win_to, everyMinutes: r.int_minutes, weekdays: String(r.int_days).split(',').map(Number) });
    } else if (r.rrule) {
      const { weekdays, intervalWeeks } = parseRrule(r.rrule);
      next = nextRecurrence({ afterIso: nowIso, tz: r.tz, localTime: r.local_time, weekdays, intervalWeeks, anchorDate: r.anchor_date });
    }
    if (!(await db.claimReminder(D, r, next, nowIso))) continue; // уже взят параллельным вызовом

    try {
      if (r.int_minutes) { await sendIntervalSlot(D, api, r, nowIso, next); sent++; continue; }
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
  sent += await processNags(env, api, nowIso);
  return sent;
}

const tryDelete = (api, chatId, msgId) => (msgId ? api.deleteMessage(chatId, msgId).catch(() => {}) : Promise.resolve());

// Срок «каждые N часов»: прежнее сообщение заменяется новым; в настойчивом режиме начинается повтор каждую минуту
async function sendIntervalSlot(D, api, r, nowIso, next) {
  await tryDelete(api, r.user_id, r.nag_msg);
  const m = await api.sendMessage(r.user_id, `🔔 Напоминание: ${escapeHtml(r.msg ?? '')}`, { parse_mode: 'HTML', reply_markup: intervalKeyboard(r.id) });
  if (!r.nag) { await db.setNagMsg(D, r.id, m.message_id); return; }
  // Повторяем до следующего срока расписания, даже если до него вся ночь: время выбирает сам человек. Когда срок наступит, начнётся новый цикл.
  const until = next ?? isoUtc(utc(nowIso).plus({ years: 1 }));
  await db.startNag(D, r.id, m.message_id, isoUtc(utc(nowIso).plus({ seconds: NAG_EVERY_SEC })), until);
}

// Повторы «пока не нажато Готово»: каждую минуту старое сообщение удаляется и приходит новое
export async function processNags(env, api, nowIso = new Date().toISOString()) {
  const D = env.DB;
  let n = 0;
  for (const r of await db.dueNags(D, nowIso, NAG_BATCH)) {
    if (r.ustatus === 'blocked') { await db.cancelReminder(D, r.id); continue; }
    if (nowIso >= r.nag_until) { await db.expireNag(D, r.id); continue; }
    const next = isoUtc(utc(nowIso).plus({ seconds: NAG_EVERY_SEC }));
    if (!(await db.claimNag(D, r, next))) continue;
    try {
      await tryDelete(api, r.user_id, r.nag_msg);
      const m = await api.sendMessage(r.user_id, `🔔 Напоминание: ${escapeHtml(r.msg ?? '')}`, { parse_mode: 'HTML', reply_markup: intervalKeyboard(r.id) });
      await db.setNagMsg(D, r.id, m.message_id);
      n++;
    } catch (e) {
      const code = e?.error_code;
      if (code === 403 || code === 400) await db.cancelReminder(D, r.id);
      console.error('nag send failed', r.id, code ?? e?.message);
    }
  }
  return n;
}

const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
export const inboxText = (n) => `📥 Во «Входящих» лежит ${n} ${plural(n, 'неразобранная ссылка', 'неразобранные ссылки', 'неразобранных ссылок')}. Выберите для них папки.`;

// Время напоминания: с 12:00 до 14:00 по местному времени и не больше одного раза в сутки.
// Сообщение в 12:00 называет всё, что лежит во «Входящих» на этот момент; ссылку, добавленную позже, бот сразу не «догоняет».
export function digestDue(local, lastSentOn) {
  if (local.hour < DIGEST_HOUR || local.hour >= DIGEST_HOUR + DIGEST_WINDOW_HOURS) return false;
  return lastSentOn !== local.toISODate();
}

// Раз в сутки в 12:00 по местному времени напоминаем о неразобранных ссылках. Когда папка пуста, людей в выборке нет.
export async function processInboxDigests(env, api, nowIso = new Date().toISOString()) {
  const D = env.DB;
  const appUrl = env.PUBLIC_URL ?? 'https://notes.fixtorllc.com';
  let sent = 0;
  for (const u of await db.inboxDigestCandidates(D)) {
    if (sent >= 10) break; // лимит запросов за один вызов
    const local = utc(nowIso).setZone(u.tz);
    if (!digestDue(local, u.inbox_digest_on)) continue;
    const today = local.toISODate();
    if (!(await db.claimDigest(D, u.id, today))) continue;
    try {
      await api.sendMessage(u.id, inboxText(u.c), { reply_markup: { inline_keyboard: [[{ text: `Открыть «${INBOX_NAME}»`, web_app: { url: `${appUrl}/?open=inbox` } }]] } });
      sent++;
    } catch (e) { console.error('digest send failed', u.id, e?.error_code ?? e?.message); }
  }
  return sent;
}
