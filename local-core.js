(function (root) {
  'use strict';

  var VERSION = 1;
  var STORAGE_KEY = 'stockmind.local.v' + VERSION;
  var COLLECTIONS = ['watchlists', 'portfolios', 'transactions', 'alerts', 'settings', 'cachedCandles'];

  function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }
  function finite(value, label, options) {
    var n = typeof value === 'number' ? value : Number(value);
    options = options || {};
    if (!Number.isFinite(n) || (options.positive && n <= 0) || (options.nonNegative && n < 0)) {
      throw new TypeError(label + ' must be a ' + (options.positive ? 'positive' : 'finite') + ' number');
    }
    return n;
  }
  function text(value, label) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(label + ' must be a non-empty string');
    return value.trim();
  }
  function emptyState() {
    return { version: VERSION, watchlists: [], portfolios: [], transactions: [], alerts: [], settings: {}, cachedCandles: {} };
  }
  function sanitizeState(value) {
    var state = emptyState();
    if (!isObject(value)) return state;
    COLLECTIONS.forEach(function (key) {
      if (key === 'settings' || key === 'cachedCandles') state[key] = isObject(value[key]) ? value[key] : {};
      else state[key] = Array.isArray(value[key]) ? value[key] : [];
    });
    state.version = VERSION;
    return state;
  }
  function migrate(parsed) {
    if (!isObject(parsed)) return emptyState();
    // Version 0/legacy records are retained only when their collection shape is safe.
    return sanitizeState(parsed.data && isObject(parsed.data) ? parsed.data : parsed);
  }
  function safeStorage() {
    try { return root && root.localStorage ? root.localStorage : null; } catch (_) { return null; }
  }
  var memoryState = emptyState();
  var api = {
    version: VERSION,
    storageKey: STORAGE_KEY,
    load: function () {
      try {
        if (root && root.StockMindDb && typeof root.StockMindDb.loadState === 'function') {
          var dbValue = root.StockMindDb.loadState();
          if (isObject(dbValue) && !dbValue._error) { memoryState = migrate(dbValue); return clone(memoryState); }
        }
      } catch (_) { /* Development and recovery fall back to browser storage. */ }
      var storage = safeStorage();
      if (!storage) return clone(memoryState);
      try {
        var raw = storage.getItem(STORAGE_KEY);
        if (!raw) { memoryState = emptyState(); return clone(memoryState); }
        var migrated = migrate(JSON.parse(raw));
        memoryState = migrated;
        if (!isObject(JSON.parse(raw)) || JSON.parse(raw).version !== VERSION) api.save(migrated);
        return clone(migrated);
      } catch (_) { return clone(memoryState); }
    },
    save: function (value) {
      var state = sanitizeState(value);
      memoryState = state;
      try {
        if (root && root.StockMindDb && typeof root.StockMindDb.saveState === 'function') {
          var result = root.StockMindDb.saveState(state);
          if (result && result.ok === false) throw new Error(result.error || 'SQLite save failed');
          return clone(state);
        }
      } catch (e) {
        // Do not pretend persistence succeeded if the desktop database is present but failed.
        if (root && root.StockMindDb) throw e;
      }
      var storage = safeStorage();
      if (storage) {
        try { storage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* Memory fallback remains usable. */ }
      }
      return clone(state);
    },
    clear: function () {
      memoryState = emptyState();
      var storage = safeStorage();
      if (storage) { try { storage.removeItem(STORAGE_KEY); } catch (_) { /* ignore */ } }
      return clone(memoryState);
    },
    addToWatchlist: function (watchlistId, symbol, label) {
      var state = api.load();
      watchlistId = text(watchlistId, 'watchlistId'); symbol = text(symbol, 'symbol').toUpperCase();
      var list = state.watchlists.find(function (item) { return item && item.id === watchlistId; });
      if (!list) { list = { id: watchlistId, name: label || watchlistId, symbols: [] }; state.watchlists.push(list); }
      if (!Array.isArray(list.symbols)) list.symbols = [];
      if (!list.symbols.some(function (item) { return (typeof item === 'string' ? item : item && item.symbol) === symbol; })) list.symbols.push(symbol);
      return api.save(state);
    },
    removeFromWatchlist: function (watchlistId, symbol) {
      var state = api.load();
      var list = state.watchlists.find(function (item) { return item && item.id === watchlistId; });
      if (list && Array.isArray(list.symbols)) list.symbols = list.symbols.filter(function (item) { return (typeof item === 'string' ? item : item && item.symbol) !== String(symbol).toUpperCase(); });
      return api.save(state);
    },
    reorderWatchlist: function (watchlistId, orderedSymbols) {
      if (!Array.isArray(orderedSymbols)) throw new TypeError('orderedSymbols must be an array');
      var state = api.load();
      var list = state.watchlists.find(function (item) { return item && item.id === watchlistId; });
      if (!list) throw new RangeError('Watchlist not found');
      var existing = Array.isArray(list.symbols) ? list.symbols : [];
      var map = new Map(existing.map(function (v) { var s = typeof v === 'string' ? v : v && v.symbol; return [String(s).toUpperCase(), v]; }));
      var order = orderedSymbols.map(function (s) { return text(s, 'symbol').toUpperCase(); });
      if (order.length !== map.size || new Set(order).size !== order.length || order.some(function (s) { return !map.has(s); })) throw new RangeError('Order must contain each existing symbol exactly once');
      list.symbols = order.map(function (s) { return map.get(s); });
      return api.save(state);
    },
    createPortfolio: function (id, name, currency) {
      id = text(id, 'portfolio id'); name = text(name, 'portfolio name'); currency = text(currency || 'RUB', 'currency').toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError('currency must be a three-letter code');
      var state = api.load();
      if (state.portfolios.some(function (p) { return p && p.id === id; })) throw new RangeError('Portfolio id already exists');
      state.portfolios.push({ id: id, name: name, currency: currency, cashBalance: 0, positions: {} });
      return api.save(state);
    },
    recordTransaction: function (portfolioId, transaction) {
      portfolioId = text(portfolioId, 'portfolioId');
      if (!isObject(transaction)) throw new TypeError('transaction must be an object');
      var side = String(transaction.side || transaction.type || '').toLowerCase();
      if (side !== 'buy' && side !== 'sell') throw new TypeError('side must be buy or sell');
      var symbol = text(transaction.symbol, 'symbol').toUpperCase();
      var quantity = finite(transaction.quantity, 'quantity', { positive: true });
      var price = finite(transaction.price, 'price', { nonNegative: true });
      var fees = finite(transaction.fees == null ? 0 : transaction.fees, 'fees', { nonNegative: true });
      var currency = text(transaction.currency || 'USD', 'currency').toUpperCase();
      var state = api.load();
      var portfolio = state.portfolios.find(function (p) { return p && p.id === portfolioId; });
      if (!portfolio) { portfolio = { id: portfolioId, currency: currency, positions: {} }; state.portfolios.push(portfolio); }
      portfolio.positions = isObject(portfolio.positions) ? portfolio.positions : {};
      if (portfolio.currency && portfolio.currency.toUpperCase() !== currency) throw new TypeError('Transaction currency must match portfolio currency');
      portfolio.cashBalance = finite(portfolio.cashBalance || 0, 'cash balance');
      var position = portfolio.positions[symbol] || { quantity: 0, averageCost: 0, realizedPnL: 0, fees: 0 };
      var priorQty = finite(position.quantity || 0, 'position quantity', { nonNegative: true });
      var averageCost = finite(position.averageCost || 0, 'averageCost', { nonNegative: true });
      var realized = finite(position.realizedPnL || 0, 'realizedPnL');
      if (side === 'sell' && quantity > priorQty + 1e-10) throw new RangeError('Cannot sell more shares than are held');
      var realizedDelta = 0;
      if (side === 'buy') {
        var newQty = priorQty + quantity;
        averageCost = (priorQty * averageCost + quantity * price + fees) / newQty;
        priorQty = newQty;
        portfolio.cashBalance -= quantity * price + fees;
      } else {
        realizedDelta = (price - averageCost) * quantity - fees;
        realized += realizedDelta;
        priorQty = Math.max(0, priorQty - quantity);
        portfolio.cashBalance += quantity * price - fees;
        if (priorQty === 0) averageCost = 0;
      }
      position.quantity = priorQty;
      position.averageCost = averageCost;
      position.realizedPnL = realized;
      position.fees = finite(position.fees || 0, 'position fees', { nonNegative: true }) + fees;
      portfolio.positions[symbol] = position;
      var entry = { id: transaction.id || ('txn-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)), portfolioId: portfolioId, symbol: symbol, side: side, quantity: quantity, price: price, fees: fees, currency: currency, date: transaction.date || new Date().toISOString(), realizedPnL: realizedDelta };
      state.transactions.push(entry);
      api.save(state);
      return { transaction: clone(entry), position: clone(position), realizedPnLDelta: realizedDelta };
    },
    recordCashMovement: function (portfolioId, movement) {
      portfolioId = text(portfolioId, 'portfolioId');
      if (!isObject(movement)) throw new TypeError('movement must be an object');
      var type = String(movement.type || '').toLowerCase();
      if (type !== 'deposit' && type !== 'withdraw') throw new TypeError('type must be deposit or withdraw');
      var amount = finite(movement.amount, 'amount', { positive: true });
      var currency = text(movement.currency || 'RUB', 'currency').toUpperCase();
      var state = api.load();
      var portfolio = state.portfolios.find(function (p) { return p && p.id === portfolioId; });
      if (!portfolio) { portfolio = { id: portfolioId, currency: currency, cashBalance: 0, positions: {} }; state.portfolios.push(portfolio); }
      if (portfolio.currency && portfolio.currency.toUpperCase() !== currency) throw new TypeError('Movement currency must match portfolio currency');
      portfolio.cashBalance = finite(portfolio.cashBalance || 0, 'cash balance');
      if (type === 'withdraw' && amount > portfolio.cashBalance) throw new RangeError('Withdrawal exceeds available cash');
      portfolio.cashBalance += type === 'deposit' ? amount : -amount;
      var entry = { id: movement.id || ('txn-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)), portfolioId: portfolioId, symbol: 'CASH', side: type, quantity: amount, price: 1, fees: 0, currency: currency, date: movement.date || new Date().toISOString(), realizedPnL: 0 };
      state.transactions.push(entry); api.save(state);
      return { transaction: clone(entry), cashBalance: portfolio.cashBalance };
    },
    getPortfolioSummary: function (portfolioId, marketPrices) {
      var state = api.load();
      var portfolio = state.portfolios.find(function (p) { return p && p.id === portfolioId; });
      if (!portfolio) throw new RangeError('Portfolio not found');
      marketPrices = isObject(marketPrices) ? marketPrices : {};
      var positions = {};
      Object.keys(portfolio.positions || {}).forEach(function (symbol) {
        var p = portfolio.positions[symbol];
        var qty = finite(p.quantity || 0, 'position quantity', { nonNegative: true });
        var price = marketPrices[symbol];
        var hasPrice = price !== undefined && price !== null && Number.isFinite(Number(price)) && Number(price) >= 0;
        var marketValue = hasPrice ? qty * Number(price) : null;
        positions[symbol] = { quantity: qty, averageCost: p.averageCost || 0, costBasis: qty * (p.averageCost || 0), marketPrice: hasPrice ? Number(price) : null, marketValue: marketValue, realizedPnL: p.realizedPnL || 0, unrealizedPnL: hasPrice ? marketValue - qty * (p.averageCost || 0) : null, currency: portfolio.currency || null };
      });
      return { id: portfolio.id, currency: portfolio.currency || null, cashBalance: finite(portfolio.cashBalance || 0, 'cash balance'), positions: positions };
    },
    exportBackup: function () { return JSON.stringify({ format: 'stockmind-local-backup', version: VERSION, exportedAt: new Date().toISOString(), data: api.load() }, null, 2); },
    importBackup: function (input) {
      var parsed;
      try { parsed = typeof input === 'string' ? JSON.parse(input) : input; } catch (_) { throw new TypeError('Backup is not valid JSON'); }
      if (!isObject(parsed) || !isObject(parsed.data) || (parsed.format && parsed.format !== 'stockmind-local-backup')) throw new TypeError('Unsupported backup format');
      var imported = sanitizeState(migrate(parsed.data));
      return api.save(imported);
    }
  };

  root.StockMindCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
