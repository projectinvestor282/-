'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const a = require('../src/analytics-core.js');
const close = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected}`);

test('SMA uses trailing arithmetic means and nulls before warmup', () => {
  assert.deepEqual(a.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  assert.deepEqual(a.sma([4], 2), [null]);
});

test('EMA seeds with period SMA and applies alpha 2/(period+1)', () => {
  const result = a.ema([1, 2, 3, 4, 5], 3);
  assert.deepEqual(result.slice(0, 2), [null, null]);
  close(result[2], 2); close(result[3], 3); close(result[4], 4);
  assert.deepEqual(a.ema([1, 2], 3), [null, null]);
});

test('Wilder RSI returns 100 for all gains, 0 for losses, and 50 for flat', () => {
  assert.deepEqual(a.rsi([1, 2, 3, 4], 3), [null, null, null, 100]);
  assert.equal(a.rsi([4, 3, 2, 1], 3)[3], 0);
  assert.equal(a.rsi([5, 5, 5, 5], 3)[3], 50);
  assert.equal(a.rsi([1, 2, 3], 3)[2], null);
});

test('Bollinger bands use population standard deviation', () => {
  const b = a.bollinger([1, 2, 3], 3, 2);
  assert.equal(b.middle[1], null); close(b.middle[2], 2);
  close(b.upper[2], 2 + 2 * Math.sqrt(2 / 3));
  close(b.lower[2], 2 - 2 * Math.sqrt(2 / 3));
});

test('ATR uses true range and Wilder smoothing', () => {
  const records = [
    { high: 10, low: 8, close: 9 },
    { high: 12, low: 9, close: 11 },
    { high: 13, low: 10, close: 12 },
    { high: 12, low: 8, close: 9 }
  ];
  const out = a.atr(records, 2);
  assert.deepEqual(out.slice(0, 2), [null, null]);
  close(out[2], 3); // TRs 3, 3
  close(out[3], 3.5); // (3*(2-1)+4)/2
  assert.deepEqual(a.atr(records.slice(0, 2), 2), [null, null]);
});

test('MACD aligns EMA warmups and computes signal and histogram', () => {
  const result = a.macd([1, 2, 3, 4, 5, 6], 2, 3, 2);
  assert.deepEqual(result.macd.slice(0, 2), [null, null]);
  close(result.macd[2], 0.5);
  assert.equal(result.signal[2], null);
  close(result.signal[3], 0.5);
  close(result.histogram[4], 0);
  assert.deepEqual(a.macd([1, 2], 2, 3, 2).histogram, [null, null]);
});

test('WMA, VWAP, Stochastic, CCI, ROC, Momentum, ADX, and OBV return tested values', () => {
  close(a.wma([1, 2, 3], 3)[2], 14 / 6);
  const records = [
    { high: 10, low: 5, close: 8, volume: 2 },
    { high: 12, low: 6, close: 10, volume: 3 },
    { high: 11, low: 7, close: 9, volume: 5 },
    { high: 14, low: 8, close: 13, volume: 4 },
    { high: 15, low: 9, close: 14, volume: 6 }
  ];
  const v = a.vwap(records); close(v[0], (10 + 5 + 8) / 3); assert.ok(v[4] > v[0]);
  const st = a.stochastic(records, 3, 2); assert.equal(st.k[1], null); close(st.k[2], (9 - 5) / (12 - 5) * 100); assert.ok(st.d[3] !== null);
  assert.equal(a.cci([{ high: 2, low: 0, close: 1 }, { high: 2, low: 0, close: 1 }], 2)[1], 0);
  close(a.roc([10, 12, 15], 2)[2], 50); assert.equal(a.momentum([10, 12, 15], 2)[2], 5);
  const dx = a.adx(records, 2); assert.equal(dx.adx[2], null); assert.ok(Number.isFinite(dx.adx[3]));
  assert.deepEqual(a.obv([{ close: 10, volume: 5 }, { close: 11, volume: 3 }, { close: 9, volume: 4 }]), [0, 3, -1]);
});

test('daily change provides absolute and percentage change, guarding zero base', () => {
  assert.deepEqual(a.dailyChange(110, 100), { change: 10, percent: 10 });
  assert.deepEqual(a.dailyChange(2, 0), { change: 2, percent: null });
});

test('screen combines inclusive price/change/volume bounds and sector', () => {
  const rows = [
    { ticker: 'A', price: 10, change: 2, volume: 100, sector: 'Tech' },
    { ticker: 'B', price: 12, change: -1, volume: 200, sector: 'Tech' },
    { ticker: 'C', price: 10, change: 2, volume: 100, sector: 'Energy' },
    { ticker: 'D', price: 10, change: 2, sector: 'Tech' }
  ];
  assert.deepEqual(a.screen(rows, { minPrice: 10, maxPrice: 10, minChange: 2, minVolume: 100, maxVolume: 100, sector: 'Tech' }), [rows[0]]);
  assert.deepEqual(a.screen(rows, { logic: 'or', minPrice: 12, sector: 'Energy' }), [rows[1], rows[2]]);
  assert.deepEqual(a.screen(rows, {}), rows);
});

test('maximum drawdown reports peak-to-trough loss and CSV neutralizes formulas', () => {
  assert.deepEqual(a.maxDrawdown([100, 120, 90, 105, 60]), { percent: 50, peakIndex: 1, troughIndex: 4 });
  assert.deepEqual(a.maxDrawdown([]), { percent: null, peakIndex: null, troughIndex: null });
  assert.equal(a.toCsv([{ ticker: '=cmd', price: 12.5, name: 'A; "B"' }], [
    { key: 'ticker', label: 'Тикер', text: true }, { key: 'price', label: 'Цена' }, { key: 'name', label: 'Компания', text: true }
  ]), '"Тикер";"Цена";"Компания"\r\n"\'=cmd";"12.5";"A; ""B"""');
  assert.equal(a.toCsv([{ price: '=HYPERLINK("x")', change: -2 }], [{ key: 'price', label: 'Цена', number: true }, { key: 'change', label: 'Изменение', number: true }]), '"Цена";"Изменение"\r\n"\'=HYPERLINK(""x"")";"-2"');
  assert.throws(() => a.toCsv([], [], ';;'), TypeError);
});

test('invalid parameters fail explicitly', () => {
  assert.throws(() => a.sma([1, NaN], 2), TypeError);
  assert.throws(() => a.ema([1], 0), TypeError);
  assert.throws(() => a.atr([{ high: 1, low: 2, close: 1 }], 1), TypeError);
  assert.throws(() => a.macd([1, 2], 3, 2, 1), TypeError);
});
