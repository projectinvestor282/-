'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/local-core.js');

test.beforeEach(() => core.clear());

test('versioned persistence safely recovers malformed storage', () => {
  const original = global.localStorage;
  global.localStorage = { getItem: () => '{broken', setItem: () => {}, removeItem: () => {} };
  try {
    assert.deepEqual(core.load(), { version: 1, watchlists: [], portfolios: [], transactions: [], alerts: [], settings: {}, cachedCandles: {} });
  } finally {
    if (original === undefined) delete global.localStorage;
    else global.localStorage = original;
  }
});

test('watchlist add avoids duplicates, remove and reorder preserve membership', () => {
  core.addToWatchlist('main', 'aapl');
  core.addToWatchlist('main', 'MSFT');
  core.addToWatchlist('main', 'AAPL');
  core.reorderWatchlist('main', ['MSFT', 'AAPL']);
  assert.deepEqual(core.load().watchlists[0].symbols, ['MSFT', 'AAPL']);
  core.removeFromWatchlist('main', 'msft');
  assert.deepEqual(core.load().watchlists[0].symbols, ['AAPL']);
  assert.throws(() => core.reorderWatchlist('main', ['NOPE']), /each existing symbol/);
});

test('buy/sell uses weighted average cost and fees for realized/unrealized P&L', () => {
  core.recordCashMovement('taxable', { type: 'deposit', amount: 500, currency: 'USD' });
  core.recordTransaction('taxable', { side: 'buy', symbol: 'XYZ', quantity: 10, price: 10, fees: 2, currency: 'USD' });
  const buy = core.recordTransaction('taxable', { side: 'buy', symbol: 'XYZ', quantity: 10, price: 20, fees: 2, currency: 'USD' });
  assert.equal(buy.position.averageCost, 15.2);
  const sell = core.recordTransaction('taxable', { side: 'sell', symbol: 'XYZ', quantity: 5, price: 25, fees: 1, currency: 'USD' });
  assert.equal(sell.realizedPnLDelta, 48);
  const summary = core.getPortfolioSummary('taxable', { XYZ: 30 });
  assert.equal(summary.positions.XYZ.unrealizedPnL, 222);
  assert.equal(summary.positions.XYZ.realizedPnL, 48);
  assert.equal(summary.positions.XYZ.quantity, 15);
  assert.equal(summary.cashBalance, 320);
  assert.equal(core.getPortfolioSummary('taxable').positions.XYZ.marketValue, null);
  core.recordCashMovement('taxable', { type: 'withdraw', amount: 100, currency: 'USD' });
  assert.equal(core.getPortfolioSummary('taxable').cashBalance, 220);
  assert.throws(() => core.recordCashMovement('taxable', { type: 'withdraw', amount: 221, currency: 'USD' }), /exceeds available cash/);
});

test('rejects invalid transactions and currency mismatch without changing state', () => {
  assert.throws(() => core.recordTransaction('p', { side: 'buy', symbol: 'ABC', quantity: 0, price: 5 }), /quantity/);
  assert.throws(() => core.recordTransaction('p', { side: 'buy', symbol: 'ABC', quantity: 1, price: -1 }), /price/);
  core.recordTransaction('p', { side: 'buy', symbol: 'ABC', quantity: 1, price: 5, currency: 'USD' });
  assert.throws(() => core.recordTransaction('p', { side: 'sell', symbol: 'ABC', quantity: 2, price: 6, currency: 'USD' }), /Cannot sell more/);
  assert.throws(() => core.recordTransaction('p', { side: 'buy', symbol: 'ABC', quantity: 1, price: 6, currency: 'EUR' }), /currency/);
  assert.equal(core.load().transactions.length, 1);
});

test('named portfolios keep independent balances and enforce their currency', () => {
  core.createPortfolio('usd-long', 'USD Long Term', 'USD');
  core.recordCashMovement('usd-long', { type: 'deposit', amount: 1000, currency: 'USD' });
  core.createPortfolio('eur-short', 'EUR Review', 'EUR');
  assert.equal(core.getPortfolioSummary('usd-long').cashBalance, 1000);
  assert.equal(core.getPortfolioSummary('eur-short').cashBalance, 0);
  assert.equal(core.getPortfolioSummary('eur-short').currency, 'EUR');
  assert.throws(() => core.recordCashMovement('usd-long', { type: 'deposit', amount: 10, currency: 'EUR' }), /currency/);
  assert.throws(() => core.createPortfolio('usd-long', 'Duplicate', 'USD'), /already exists/);
});

test('backup export/import round trips state and rejects invalid JSON', () => {
  core.addToWatchlist('main', 'NVDA');
  const backup = core.exportBackup();
  core.clear();
  assert.equal(core.importBackup(backup).watchlists[0].symbols[0], 'NVDA');
  assert.throws(() => core.importBackup('{'), /valid JSON/);
  assert.throws(() => core.importBackup({ version: 1 }), /Unsupported/);
});
