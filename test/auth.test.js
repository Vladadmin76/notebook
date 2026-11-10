import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { validateInitData } from '../src/auth.js';

const TOKEN = '123456:TEST';
function sign(fields, token = TOKEN) {
  const p = new URLSearchParams(fields);
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  p.set('hash', createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}
const now = 1_700_000_000;
const user = JSON.stringify({ id: 42, first_name: 'Олег' });

test('верная подпись принимается', async () => {
  const u = await validateInitData(sign({ auth_date: String(now), user }), TOKEN, 86400, now + 10);
  assert.equal(u.id, 42);
});
test('чужой токен бота отклоняется', async () => {
  assert.equal(await validateInitData(sign({ auth_date: String(now), user }, 'x:y'), TOKEN, 86400, now), null);
});
test('подменённые данные отклоняются', async () => {
  const s = sign({ auth_date: String(now), user }).replace('42', '43');
  assert.equal(await validateInitData(s, TOKEN, 86400, now), null);
});
test('устаревшие данные отклоняются', async () => {
  assert.equal(await validateInitData(sign({ auth_date: String(now), user }), TOKEN, 86400, now + 90000), null);
});
test('пустое и мусор отклоняются', async () => {
  assert.equal(await validateInitData('', TOKEN), null);
  assert.equal(await validateInitData('hash=abc', TOKEN), null);
});
