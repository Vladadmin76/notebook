import { nowIso, randomToken } from './util.js';
import { START_FOLDERS, DEFAULT_TZ } from './config.js';

export const getUser = (db, id) => db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();

export const findUserByLabel = (db, label) =>
  db.prepare('SELECT * FROM users WHERE label = ? COLLATE NOCASE').bind(label).first();

export const listUsers = (db) =>
  db.prepare('SELECT id, name, label, tz, is_admin, status, created_at FROM users ORDER BY created_at').all()
    .then((r) => r.results);

export async function createAdmin(db, id, name) {
  const now = nowIso();
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO users (id, name, label, tz, is_admin, status, created_at)
                VALUES (?, ?, 'Админ', ?, 1, 'active', ?)`).bind(id, name, DEFAULT_TZ, now),
    ...START_FOLDERS.map((f) =>
      db.prepare('INSERT OR IGNORE INTO folders (user_id, name, created_at) VALUES (?, ?, ?)').bind(id, f, now)),
  ]);
  return getUser(db, id);
}

export async function setStatus(db, id, status) {
  await db.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, id).run();
  if (status === 'blocked') await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
}

export async function removeUser(db, id) {
  // каскадом уходят папки, заметки, напоминания, сессии
  await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
}

export const audit = (db, actor, action, target) =>
  db.prepare('INSERT INTO audit (at, actor, action, target) VALUES (?, ?, ?, ?)')
    .bind(nowIso(), actor, action, target ?? null).run();

// ---------- приглашения ----------

export async function createInvite(db, label, createdBy) {
  const code = randomToken(24);
  await db.prepare('INSERT INTO invites (code, label, created_by, created_at) VALUES (?, ?, ?, ?)')
    .bind(code, label, createdBy, nowIso()).run();
  return code;
}

export const getInvite = (db, code) => db.prepare('SELECT * FROM invites WHERE code = ?').bind(code).first();

export const listOpenInvites = (db) =>
  db.prepare('SELECT code, label, claimed_at FROM invites WHERE used_by IS NULL AND revoked_at IS NULL ORDER BY created_at')
    .all().then((r) => r.results);

export async function revokeInvitesByLabel(db, label) {
  const r = await db.prepare(
    `UPDATE invites SET revoked_at = ? WHERE label = ? COLLATE NOCASE AND used_by IS NULL AND revoked_at IS NULL`)
    .bind(nowIso(), label).run();
  return r.meta.changes;
}

export function inviteState(inv) {
  if (!inv) return 'missing';
  if (inv.revoked_at) return 'revoked';
  if (inv.used_by) return 'used';
  return 'open';
}

// Кнопка «Подключить бота» на странице: закрепляем часовой пояс и выдаём токен для deep link.
// Приглашение НЕ гасится: оно погаснет только когда человек нажмёт Start в боте.
export async function claimInvite(db, code, tz) {
  const token = randomToken(18);
  await db.prepare(`UPDATE invites SET claim_token = ?, claim_tz = ?, claimed_at = ?
                    WHERE code = ? AND used_by IS NULL AND revoked_at IS NULL`)
    .bind(token, tz, nowIso(), code).run();
  return token;
}

// Человек нажал Start с токеном: создаём пользователя и гасим приглашение.
export async function redeemClaim(db, token, tgId, tgName) {
  const inv = await db.prepare('SELECT * FROM invites WHERE claim_token = ?').bind(token).first();
  if (!inv) return { error: 'unknown' };
  if (inv.revoked_at) return { error: 'revoked' };
  if (inv.used_by) return { error: 'used' };
  if (await findUserByLabel(db, inv.label)) return { error: 'label_taken' };

  const now = nowIso();
  // Условие used_by IS NULL защищает от гонки: приглашение сработает только один раз.
  const upd = await db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL')
    .bind(tgId, now, inv.code).run();
  if (upd.meta.changes !== 1) return { error: 'used' };

  await db.batch([
    db.prepare(`INSERT INTO users (id, name, label, tz, is_admin, status, created_at)
                VALUES (?, ?, ?, ?, 0, 'active', ?)`).bind(tgId, tgName, inv.label, inv.claim_tz || DEFAULT_TZ, now),
    ...START_FOLDERS.map((f) =>
      db.prepare('INSERT INTO folders (user_id, name, created_at) VALUES (?, ?, ?)').bind(tgId, f, now)),
  ]);
  return { user: await getUser(db, tgId) };
}
