// Файл календаря (.ics, RFC 5545) с событием и сигналом (VALARM), ссылка для Google Календаря и подпись одноразовых ссылок.
import { utc, parseRrule } from './timeutil.js';

const pad = (n) => String(n).padStart(2, '0');
const fmtUtc = (dt) => `${dt.year}${pad(dt.month)}${pad(dt.day)}T${pad(dt.hour)}${pad(dt.minute)}${pad(dt.second)}Z`;
const fmtLocal = (dt) => `${dt.year}${pad(dt.month)}${pad(dt.day)}T${pad(dt.hour)}${pad(dt.minute)}${pad(dt.second)}`;

const escapeText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Строки в .ics не длиннее 75 байт: длинные переносятся с пробелом в начале следующей
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '';
  for (const ch of line) {
    const limit = out.length ? 74 : 75;
    if (enc.encode(cur + ch).length > limit) { out.push(cur); cur = ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function buildIcs({ uid, text, remindAtIso, tz, rrule }) {
  const start = utc(remindAtIso);
  const end = start.plus({ minutes: 15 });
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Блокнот//RU', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${uid}@notes.fixtorllc.com`, `DTSTAMP:${fmtUtc(utc(new Date().toISOString()))}`];
  if (rrule) {
    // Повтор считается в местном времени, чтобы 9:00 оставалось 9:00 при смене зимнего и летнего времени
    const ls = start.setZone(tz), le = end.setZone(tz);
    lines.push(`DTSTART;TZID=${tz}:${fmtLocal(ls)}`, `DTEND;TZID=${tz}:${fmtLocal(le)}`, `RRULE:${rrule};WKST=MO`);
  } else {
    lines.push(`DTSTART:${fmtUtc(start)}`, `DTEND:${fmtUtc(end)}`);
  }
  lines.push(`SUMMARY:${escapeText(text)}`, 'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(text)}`, 'TRIGGER:PT0S', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function googleCalendarUrl({ text, remindAtIso, tz, rrule }) {
  const start = utc(remindAtIso), end = start.plus({ minutes: 15 });
  const p = new URLSearchParams({ action: 'TEMPLATE', text });
  if (rrule) {
    p.set('dates', `${fmtLocal(start.setZone(tz))}/${fmtLocal(end.setZone(tz))}`);
    p.set('ctz', tz);
    p.set('recur', `RRULE:${rrule}`);
  } else {
    p.set('dates', `${fmtUtc(start)}/${fmtUtc(end)}`);
  }
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

// ---------- подпись ссылки на .ics (ссылка открывается во внешнем браузере, где нет входа через Telegram) ----------
const enc = new TextEncoder();
async function hmacHex(keyData, msg) {
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function signIcs(botToken, noteId, userId, exp) {
  const secret = await crypto.subtle.digest('SHA-256', enc.encode(`ics-link:${botToken}`));
  return (await hmacHex(secret, `${noteId}.${userId}.${exp}`)).slice(0, 40);
}
export async function verifyIcs(botToken, noteId, userId, exp, sig, nowSec = Math.floor(Date.now() / 1000)) {
  if (!Number.isInteger(exp) || exp < nowSec) return false;
  const good = await signIcs(botToken, noteId, userId, exp);
  if (good.length !== String(sig).length) return false;
  let r = 0;
  for (let i = 0; i < good.length; i++) r |= good.charCodeAt(i) ^ String(sig).charCodeAt(i);
  return r === 0;
}
