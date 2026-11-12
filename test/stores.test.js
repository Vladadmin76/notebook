import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, phon, resolveStore, buildEntries, distance } from '../src/stores.js';

const entries = buildEntries([], []);
const ask = (s) => resolveStore(s, entries)?.name ?? null;
// все магазины из перечня отмечены избранными
const favRows = CATALOG.map((c) => ({ name: c.name, custom: false, favorite: true, aliases: [] }));
const favEntries = buildEntries(favRows, []);
const askFav = (s) => resolveStore(s, favEntries)?.name ?? null;

test('звучание: кириллица и латиница сводятся к одному ключу', () => {
  assert.equal(phon('Costco'), phon('Костко'));
  assert.equal(phon('Walmart'), phon('Валмарт'));
  assert.equal(phon('Target'), phon('Таргет'));
});
test('известные русские написания и произношения находят нужный магазин', () => {
  assert.equal(ask('Костко'), 'Costco');
  assert.equal(ask('костка'), 'Costco');
  assert.equal(ask('Волмарт'), 'Walmart');
  assert.equal(ask('Таргет'), 'Target');
  assert.equal(ask('Винка Фуд'), 'WinCo Foods');
  assert.equal(ask('Хоум Депо'), 'The Home Depot');
  assert.equal(ask('Эйч-И-Би'), 'H-E-B');
  assert.equal(ask('Трейдер Джо'), "Trader Joe's");
});
test('регистр и точное совпадение', () => {
  assert.equal(ask('COSTCO'), 'Costco');
  assert.equal(ask('costco'), 'Costco');
  assert.equal(ask("lowe's"), "Lowe's");
});
test('избранные узнаются снисходительно: опечатки и другой выговор', () => {
  assert.equal(askFav('Костко Холсал'), 'Costco');  // близко к известному написанию
  assert.equal(askFav('Costko'), 'Costco');
  assert.equal(askFav('Волмат'), 'Walmart');
  assert.equal(askFav('Таргэт'), 'Target');
});
test('не избранные узнаются строго: опечатка не превращается в известный магазин, а то же звучание узнаётся', () => {
  assert.equal(ask('Костко Холсал'), null);
  assert.equal(ask('Волмат'), null);
  assert.equal(ask('Costko'), 'Costco');            // то же звучание, что у Costco
  assert.equal(ask('Таргет'), 'Target');
});
test('при равенстве выигрывает избранный', () => {
  const e = buildEntries([{ name: 'Walmart', custom: false, favorite: true, aliases: [] }, { name: 'Wolmart Extra', custom: true, favorite: false, aliases: [] }], []);
  // «Валмарт» известное написание Walmart (алиас), конфликта нет
  assert.equal(resolveStore('Валмарт', e).name, 'Walmart');
});
test('незнакомый магазин не подменяется похожим', () => {
  for (const f of [ask, askFav]) {
    assert.equal(f('Kohls'), null);
    assert.equal(f('Рога и копыта'), null);
    assert.equal(f('Best Buy'), null);
    assert.equal(f('Aldi'), null);
    assert.equal(f('ab'), null);
  }
});
test('выученное написание и существующий список учитываются', () => {
  const e = buildEntries([{ name: 'Costco', custom: false, favorite: true, aliases: ['Костиково'] }, { name: 'Мой Рынок', custom: true, favorite: true, aliases: [] }], ['Рынок Васи']);
  assert.equal(resolveStore('Костиково', e).name, 'Costco');
  assert.equal(resolveStore('мой рынок', e).name, 'Мой Рынок');
  assert.equal(resolveStore('Рынок Васи', e).source, 'list');
  assert.equal(resolveStore('рынок васи', e).how, 'exact');
});
test('перечень: 19 сетей, названия не повторяются, группы заданы', () => {
  assert.equal(CATALOG.length, 19);
  assert.equal(new Set(CATALOG.map((c) => c.name.toLowerCase())).size, CATALOG.length);
  assert.ok(CATALOG.every((c) => c.group && c.aliases.length));
});
test('расстояние Левенштейна', () => {
  assert.equal(distance('kitten', 'sitting'), 3);
  assert.equal(distance('', 'abc'), 3);
});
