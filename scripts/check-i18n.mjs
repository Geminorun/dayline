import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const base = 'packages/locales/src',
  catalogs = {};
const placeholders = (s) =>
  [...new Set(s.match(/\{[A-Za-z]\w*\}/g) ?? [])].sort();
for (const group of ['shared', 'ui', 'server']) {
  const dictionaries = {};
  for (const lang of ['zh-CN', 'en']) {
    dictionaries[lang] = {};
    for (const file of fs
      .readdirSync(`${base}/${group}/${lang}`)
      .filter((f) => f.endsWith('.json'))) {
      const values = JSON.parse(
        fs.readFileSync(`${base}/${group}/${lang}/${file}`, 'utf8'),
      );
      for (const [key, text] of Object.entries(values)) {
        assert.equal(
          typeof text,
          'string',
          `${group}/${lang}/${key} must be text`,
        );
        assert(text.trim(), `${key} must not be empty`);
        if (key in dictionaries[lang])
          assert.equal(dictionaries[lang][key], text, `Conflicting ${key}`);
        dictionaries[lang][key] = text;
      }
    }
  }
  assert.deepEqual(
    Object.keys(dictionaries.en).sort(),
    Object.keys(dictionaries['zh-CN']).sort(),
    `${group} locale keys differ`,
  );
  for (const key of Object.keys(dictionaries.en))
    assert.deepEqual(
      placeholders(dictionaries.en[key]),
      placeholders(dictionaries['zh-CN'][key]),
      `${key} interpolation arguments differ`,
    );
  catalogs[group] = dictionaries;
}
for (const [group, dictionaries] of Object.entries(catalogs)) {
  for (const [key, value] of Object.entries(dictionaries.en))
    assert(
      !/\p{Script=Han}/u.test(value),
      `${group}/en/${key} still contains Chinese text`,
    );
}
const pages = JSON.parse(
  fs.readFileSync('apps/miniapp/src/pages.json', 'utf8'),
);
const titles = [
  ...pages.pages.map((p) => p.style.navigationBarTitleText),
  ...pages.tabBar.list.map((p) => p.text),
];
for (const language of ['zh-CN', 'en']) {
  const filename = language === 'zh-CN' ? 'zh-Hans' : 'en';
  const native = JSON.parse(
    fs.readFileSync(`apps/miniapp/src/locale/${filename}.json`, 'utf8'),
  );
  for (const title of titles) {
    assert(/^%[\w.]+%$/.test(title), `Untranslated native title: ${title}`);
    const key = title.slice(1, -1);
    assert.equal(
      native[key],
      catalogs.ui[language][key],
      `Native title differs: ${language}/${key}`,
    );
  }
}
const all = Object.assign({}, ...Object.values(catalogs).map((v) => v.en));
// A label must not also be the parent namespace of another label.
for (const key of Object.keys(all)) {
  for (
    let end = key.lastIndexOf('.');
    end > 0;
    end = key.lastIndexOf('.', end - 1)
  ) {
    assert(!(key.slice(0, end) in all), `Message namespace collides: ${key}`);
  }
}
let calls = 0;
function visit(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['generated', 'node_modules', 'dist'].includes(f.name)) continue;
    const name = path.join(dir, f.name);
    if (f.isDirectory()) visit(name);
    else if (/\.(?:vue|ts)$/.test(name)) {
      const text = fs.readFileSync(name, 'utf8');
      for (const match of text.matchAll(/\b(?:tr|msg)\(\s*['"]([^'"]+)['"]/g)) {
        assert(match[1] in all, `${name}: missing message ${match[1]}`);
        calls++;
      }
    }
  }
}
for (const d of [
  'apps/web/src',
  'apps/miniapp/src',
  'apps/api/src',
  'packages/api-client/src',
  'packages/contracts/src',
])
  visit(d);
console.log(
  `i18n: ${Object.keys(all).length} messages, ${calls} references; locale keys and interpolation arguments match.`,
);
