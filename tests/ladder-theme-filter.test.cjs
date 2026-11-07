const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../apps/web/node_modules/typescript');
const source = fs.readFileSync(path.join(__dirname, '../apps/web/src/lib/ladderThemeFilter.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const mod = { exports: {} };
new Function('exports', 'require', 'module', compiled.outputText)(mod.exports, require, mod);
const { displayedLadderTheme, ladderThemeOptions } = mod.exports;

test('题材按当前展示状态的个股生成，数量去重降序且选择必有对应股票', () => {
  const stocks = [
    { code: '1', reason: '光伏', status: '成' },
    { code: '2', reason: '光伏 ', status: '成' },
    { code: '2', reason: '光伏 ', status: '成' },
    { code: '3', reason: '端侧AI', status: '成', concepts: ['3D打印'] },
    { code: '4', reason: '3D打印', status: '败' },
  ];
  const eligible = stocks.filter(s => s.status === '成');
  const options = ladderThemeOptions(eligible);
  assert.deepEqual(options.map(o => [o.value, o.count]), [['光伏', 2], ['端侧AI', 1]]);
  for (const option of options) {
    const matches = eligible.filter(s => displayedLadderTheme(s) === option.value);
    assert.equal(new Set(matches.map(s => s.code)).size, option.count);
    assert.ok(matches.length > 0);
  }
  assert.equal(ladderThemeOptions(stocks).find(o => o.value === '3D打印').count, 1);
});
