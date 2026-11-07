const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('../apps/web/node_modules/typescript');
const source = fs.readFileSync(require('node:path').join(__dirname, '../apps/web/src/lib/historyTheme.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const themeModule = { exports: {} };
new Function('exports', 'require', 'module', compiled.outputText)(themeModule.exports, require, themeModule);
const { historyTheme, historyThemeGroups, historyThemeColors, summarizeHistoryGroup } = themeModule.exports;

test('历史主题材汇总与筛选完全一致，不匹配附属概念', () => {
  const stocks = [
    { code: '001', reason: '大飞机', concepts: ['端侧AI'], amount: 10, change_pct: 10 },
    { code: '002', reason: '端侧AI', amount: 20, change_pct: 20 },
    { code: '003', reason: ' 端侧AI ', amount: 30, change_pct: 10 },
  ];
  const groups = historyThemeGroups([...stocks, stocks[0]]);
  for (const group of groups) {
    const visible = stocks.filter((stock) => historyTheme(stock) === group.label);
    assert.deepEqual(group.stocks, visible);
    assert.equal(group.count, visible.length);
  }
  assert.equal(groups.find((g) => g.label === '端侧AI').count, 2);
  assert.equal(groups.find((g) => g.label === '大飞机').count, 1);
  const ai = groups.find((g) => g.label === '端侧AI');
  assert.equal(ai.amount, 50);
  assert.equal(ai.avg_change_pct, 15);
  const filtered = summarizeHistoryGroup(ai, [stocks[1]]);
  assert.equal(filtered.count, 1);
  assert.equal(filtered.amount, 20);
  assert.equal(filtered.avg_change_pct, 20);
  const colors = historyThemeColors(groups);
  assert.notEqual(colors.get('端侧AI'), colors.get('大飞机'));
  assert.equal(historyTheme({ reason: ' ', industry: '光伏' }), '光伏');
});
