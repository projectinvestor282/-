'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');
const { createSQLiteStore } = require('../electron/sqlite-store.cjs');

async function setup() {
  const SQL = await initSqlJs({ locateFile: name => require.resolve(`sql.js/dist/${name}`) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockmind-sqlite-'));
  return { SQL, dir, file: path.join(dir, 'stockmind.sqlite3') };
}

test('SQLite store persists normalized application state across reopen', async () => {
  const { SQL, dir, file } = await setup();
  const expected = {
    version: 1,
    watchlists: [{ id: 'main', name: 'Основной', symbols: ['SBER', 'GAZP'] }],
    portfolios: [{ id: 'default', name: 'Портфель', currency: 'RUB', cashBalance: 1200, positions: { SBER: { quantity: 3, averageCost: 280, realizedPnL: 0, fees: 0 } } }],
    transactions: [
      { id: 't1', portfolioId: 'default', symbol: 'SBER', side: 'buy', quantity: 3, price: 280, fees: 0, currency: 'RUB', date: '2026-11-07', realizedPnL: 0 },
      { id: 't2', portfolioId: 'default', symbol: 'CASH', side: 'deposit', quantity: 2040, price: 1, fees: 0, currency: 'RUB', date: '2026-11-07', realizedPnL: 0 }
    ],
    alerts: [{ id: 'a1', symbol: 'SBER', condition: 'above', threshold: 300, enabled: true, lastTriggered: null }],
    settings: { theme: 'dark', selectedSymbol: 'SBER' },
    cachedCandles: { SBER: { candles: [{ time: 1, open: 1, high: 2, low: 1, close: 2, volume: 4 }], savedAt: '2026-11-07T00:00:00.000Z', exchange:'moex',currency:'RUB',provider:'moex-iss',interval:'1d',days:30 }, AAPL: { candles:[{time:2,open:100,high:101,low:99,close:100,volume:10}],savedAt:'2026-11-07T00:00:00.000Z',exchange:'us',currency:'USD',provider:'alpha-vantage',interval:'1d',days:30 } }
  };
  let store = createSQLiteStore(SQL, file);
  assert.deepEqual(store.load().watchlists, []);
  store.save(expected);
  assert.deepEqual(store.load(), expected);
  store.close();
  store = createSQLiteStore(SQL, file);
  assert.deepEqual(store.load(), expected);
  assert.ok(fs.statSync(file).size > 0);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SQLite constraints reject invalid transaction rows without deleting old state', async () => {
  const { SQL, dir, file } = await setup();
  const store = createSQLiteStore(SQL, file);
  const base = { version: 1, watchlists: [], portfolios: [], transactions: [], alerts: [], settings: {}, cachedCandles: {} };
  store.save({ ...base, watchlists: [{ id: 'w', name: 'Keep', symbols: ['SBER'] }] });
  assert.throws(() => store.save({ ...base, transactions: [{ id:'bad', portfolioId:'p', symbol:'SBER', side:'buy', quantity:-1, price:1, fees:0, currency:'RUB', date:'2026-01-01', realizedPnL:0 }] }));
  assert.equal(store.load().watchlists[0].id, 'w');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SQLite clear removes persisted application state across reopen',async()=>{const {SQL,dir,file}=await setup();let store=createSQLiteStore(SQL,file);store.save({version:1,watchlists:[{id:'w',name:'Watch',symbols:['SBER']}],portfolios:[{id:'p',name:'P',currency:'RUB',cashBalance:100,positions:{}}],transactions:[],alerts:[{id:'a',symbol:'SBER',condition:'above',threshold:200,enabled:true}],settings:{fxRates:{rates:{RUB:1}}},cachedCandles:{SBER:{candles:[{time:1,open:1,high:2,low:1,close:2,volume:3}],savedAt:'2026-01-01'}}});assert.deepEqual(store.clear(),{ok:true});assert.deepEqual(store.load(),{version:1,watchlists:[],portfolios:[],transactions:[],alerts:[],settings:{},cachedCandles:{}});store.close();store=createSQLiteStore(SQL,file);assert.deepEqual(store.load(),{version:1,watchlists:[],portfolios:[],transactions:[],alerts:[],settings:{},cachedCandles:{}});store.close();fs.rmSync(dir,{recursive:true,force:true});});

test('schema upgrades the prior buy/sell-only database without losing records', async () => {
  const { SQL, dir, file } = await setup();
  let old = new SQL.Database();
  old.run('CREATE TABLE portfolios(id TEXT PRIMARY KEY,name TEXT,currency TEXT,positions_json TEXT NOT NULL)');
  old.run("INSERT INTO portfolios VALUES('p','Legacy','RUB','{}')");
  old.run("CREATE TABLE transactions(id TEXT PRIMARY KEY, portfolio_id TEXT NOT NULL,symbol TEXT NOT NULL,side TEXT NOT NULL CHECK(side IN ('buy','sell')),quantity REAL NOT NULL CHECK(quantity>0),price REAL NOT NULL CHECK(price>=0),fees REAL NOT NULL DEFAULT 0 CHECK(fees>=0),currency TEXT NOT NULL,date TEXT NOT NULL,realized_pnl REAL NOT NULL DEFAULT 0)");
  old.run("INSERT INTO transactions VALUES('t','p','SBER','buy',2,100,0,'RUB','2026-01-01',0)");
  fs.writeFileSync(file, Buffer.from(old.export())); old.close();
  const store=createSQLiteStore(SQL,file);
  assert.equal(store.load().transactions[0].symbol,'SBER');
  assert.equal(store.load().portfolios[0].cashBalance,0);
  const state=store.load();state.transactions.push({id:'cash',portfolioId:'p',symbol:'CASH',side:'deposit',quantity:100,price:1,fees:0,currency:'RUB',date:'2026-01-02',realizedPnL:0});
  state.portfolios[0].cashBalance=100;store.save(state);
  assert.equal(store.load().transactions.length,2);assert.equal(store.load().portfolios[0].cashBalance,100);
  store.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('legacy price-alert schema migrates and stores new indicator rules',async()=>{
 const {SQL,dir,file}=await setup();const old=new SQL.Database();old.run("CREATE TABLE alerts(id TEXT PRIMARY KEY,symbol TEXT NOT NULL,condition TEXT NOT NULL CHECK(condition IN ('above','below')),threshold REAL NOT NULL CHECK(threshold>=0),enabled INTEGER NOT NULL,last_triggered TEXT)");old.run("INSERT INTO alerts VALUES('old','SBER','above',300,1,NULL)");fs.writeFileSync(file,Buffer.from(old.export()));old.close();const store=createSQLiteStore(SQL,file);assert.equal(store.load().alerts[0].condition,'above');const s=store.load();s.alerts.push({id:'new',symbol:'GAZP',condition:'rsi_below',threshold:30,enabled:true,lastTriggered:null});s.settings.alertHistory=[{id:'hist',observed:28}];store.save(s);store.close();const reopened=createSQLiteStore(SQL,file);assert.equal(reopened.load().alerts[1].condition,'rsi_below');assert.deepEqual(reopened.load().settings.alertHistory,[{id:'hist',observed:28}]);reopened.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('legacy candle arrays load while rich exchange metadata survives SQLite reopen',async()=>{const {SQL,dir,file}=await setup();const old=new SQL.Database();old.run('CREATE TABLE cached_candles(symbol TEXT PRIMARY KEY,data_json TEXT NOT NULL,saved_at TEXT NOT NULL)');old.run('INSERT INTO cached_candles VALUES(?,?,?)',['OLD',JSON.stringify([{time:1,open:1,high:2,low:1,close:2,volume:3}]),'2026-01-01T00:00:00.000Z']);fs.writeFileSync(file,Buffer.from(old.export()));old.close();const store=createSQLiteStore(SQL,file);const state=store.load();assert.equal(state.cachedCandles.OLD.candles.length,1);assert.equal(state.cachedCandles.OLD.savedAt,'2026-01-01T00:00:00.000Z');state.cachedCandles.AAPL={candles:[{time:2,open:100,high:101,low:99,close:100,volume:1}],savedAt:'2026-01-02T00:00:00.000Z',exchange:'us',currency:'USD',provider:'alpha-vantage'};store.save(state);store.close();const reopened=createSQLiteStore(SQL,file);assert.equal(reopened.load().cachedCandles.AAPL.exchange,'us');assert.equal(reopened.load().cachedCandles.AAPL.currency,'USD');reopened.close();fs.rmSync(dir,{recursive:true,force:true});});
