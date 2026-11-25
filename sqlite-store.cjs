'use strict';
const fs = require('node:fs');
const path = require('node:path');

const EMPTY = () => ({version:1,watchlists:[],portfolios:[],transactions:[],alerts:[],settings:{},cachedCandles:{}});
function createSQLiteStore(SQL, file) {
  const dir=path.dirname(file);fs.mkdirSync(dir,{recursive:true});
  let db=fs.existsSync(file)?new SQL.Database(fs.readFileSync(file)):new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  db.run('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  db.run('CREATE TABLE IF NOT EXISTS app_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.run('CREATE TABLE IF NOT EXISTS watchlists(id TEXT PRIMARY KEY, name TEXT NOT NULL, symbols_json TEXT NOT NULL)');
  db.run('CREATE TABLE IF NOT EXISTS portfolios(id TEXT PRIMARY KEY, name TEXT, currency TEXT, cash_balance REAL NOT NULL DEFAULT 0, positions_json TEXT NOT NULL)');
  const pinfo=db.prepare('PRAGMA table_info(portfolios)');let hasCash=false;while(pinfo.step())if(pinfo.getAsObject().name==='cash_balance')hasCash=true;pinfo.free();if(!hasCash)db.run('ALTER TABLE portfolios ADD COLUMN cash_balance REAL NOT NULL DEFAULT 0');
  db.run('CREATE TABLE IF NOT EXISTS transactions(id TEXT PRIMARY KEY, portfolio_id TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN (\'buy\',\'sell\',\'deposit\',\'withdraw\')), quantity REAL NOT NULL CHECK(quantity>0), price REAL NOT NULL CHECK(price>=0), fees REAL NOT NULL DEFAULT 0 CHECK(fees>=0), currency TEXT NOT NULL, date TEXT NOT NULL, realized_pnl REAL NOT NULL DEFAULT 0)');
  const schemaRows=db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'");
  if(schemaRows[0]?.values?.[0]?.[0]&&!String(schemaRows[0].values[0][0]).includes("'deposit'")){
    db.run('ALTER TABLE transactions RENAME TO transactions_v1');
    db.run("CREATE TABLE transactions(id TEXT PRIMARY KEY, portfolio_id TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN ('buy','sell','deposit','withdraw')), quantity REAL NOT NULL CHECK(quantity>0), price REAL NOT NULL CHECK(price>=0), fees REAL NOT NULL DEFAULT 0 CHECK(fees>=0), currency TEXT NOT NULL, date TEXT NOT NULL, realized_pnl REAL NOT NULL DEFAULT 0)");
    db.run('INSERT INTO transactions SELECT * FROM transactions_v1');db.run('DROP TABLE transactions_v1');
  }
  db.run('CREATE INDEX IF NOT EXISTS idx_transactions_portfolio_date ON transactions(portfolio_id,date)');
  db.run("CREATE TABLE IF NOT EXISTS alerts(id TEXT PRIMARY KEY, symbol TEXT NOT NULL, condition TEXT NOT NULL CHECK(condition IN ('above','below','change_above','change_below','volume_above','rsi_above','rsi_below')), threshold REAL NOT NULL, enabled INTEGER NOT NULL, last_triggered TEXT)");
  const alertSchema=db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='alerts'");
  if(alertSchema[0]?.values?.[0]?.[0]&&!String(alertSchema[0].values[0][0]).includes("'change_above'")){
    db.run('ALTER TABLE alerts RENAME TO alerts_v1');
    db.run("CREATE TABLE alerts(id TEXT PRIMARY KEY, symbol TEXT NOT NULL, condition TEXT NOT NULL CHECK(condition IN ('above','below','change_above','change_below','volume_above','rsi_above','rsi_below')), threshold REAL NOT NULL, enabled INTEGER NOT NULL, last_triggered TEXT)");
    db.run('INSERT INTO alerts SELECT * FROM alerts_v1');db.run('DROP TABLE alerts_v1');
  }
  db.run('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL)');
  db.run('CREATE TABLE IF NOT EXISTS cached_candles(symbol TEXT PRIMARY KEY, data_json TEXT NOT NULL, saved_at TEXT NOT NULL)');
  db.run('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,?)',[new Date().toISOString()]);
  db.run('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(2,?)',[new Date().toISOString()]);
  db.run('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(3,?)',[new Date().toISOString()]);
  function persist(){const temp=`${file}.${process.pid}.${Date.now()}.tmp`;let fd=null;try{fd=fs.openSync(temp,'w',0o600);fs.writeFileSync(fd,Buffer.from(db.export()));fs.fsyncSync(fd);fs.closeSync(fd);fd=null;fs.renameSync(temp,file);}catch(error){if(fd!==null)try{fs.closeSync(fd)}catch(_){}try{fs.unlinkSync(temp)}catch(_){}throw error;}}
  function select(sql,params=[]){const st=db.prepare(sql);try{st.bind(params);const a=[];while(st.step())a.push(st.getAsObject());return a;}finally{st.free();}}
  function load(){
    const s=EMPTY();
    s.watchlists=select('SELECT id,name,symbols_json FROM watchlists').map(r=>({id:r.id,name:r.name,symbols:JSON.parse(r.symbols_json)}));
    s.portfolios=select('SELECT id,name,currency,cash_balance,positions_json FROM portfolios').map(r=>({id:r.id,...(r.name?{name:r.name}:{}),...(r.currency?{currency:r.currency}:{}),cashBalance:r.cash_balance||0,positions:JSON.parse(r.positions_json)}));
    s.transactions=select('SELECT id,portfolio_id,symbol,side,quantity,price,fees,currency,date,realized_pnl FROM transactions').map(r=>({id:r.id,portfolioId:r.portfolio_id,symbol:r.symbol,side:r.side,quantity:r.quantity,price:r.price,fees:r.fees,currency:r.currency,date:r.date,realizedPnL:r.realized_pnl}));
    s.alerts=select('SELECT id,symbol,condition,threshold,enabled,last_triggered FROM alerts').map(r=>({id:r.id,symbol:r.symbol,condition:r.condition,threshold:r.threshold,enabled:!!r.enabled,lastTriggered:r.last_triggered||null}));
    select('SELECT key,value_json FROM settings').forEach(r=>s.settings[r.key]=JSON.parse(r.value_json));
    select('SELECT symbol,data_json,saved_at FROM cached_candles').forEach(r=>{const stored=JSON.parse(r.data_json);const record=Array.isArray(stored)?{candles:stored}:stored;s.cachedCandles[r.symbol]={...record,candles:Array.isArray(record?.candles)?record.candles:[],savedAt:record?.savedAt||r.saved_at};});
    return s;
  }
  function save(s){
    if(!s||!Array.isArray(s.watchlists)||!Array.isArray(s.portfolios)||!Array.isArray(s.transactions)||!Array.isArray(s.alerts)||!s.settings||typeof s.settings!=='object'||!s.cachedCandles||typeof s.cachedCandles!=='object')throw new TypeError('Invalid StockMind state');
    db.run('BEGIN IMMEDIATE');
    try{
      ['watchlists','portfolios','transactions','alerts','settings','cached_candles'].forEach(t=>db.run(`DELETE FROM ${t}`));
      for(const w of s.watchlists) db.run('INSERT INTO watchlists(id,name,symbols_json) VALUES(?,?,?)',[String(w.id),String(w.name||w.id),JSON.stringify(w.symbols||[])]);
      for(const p of s.portfolios) db.run('INSERT INTO portfolios(id,name,currency,cash_balance,positions_json) VALUES(?,?,?,?,?)',[String(p.id),p.name||null,p.currency||null,Number(p.cashBalance||0),JSON.stringify(p.positions||{})]);
      for(const t of s.transactions) db.run('INSERT INTO transactions(id,portfolio_id,symbol,side,quantity,price,fees,currency,date,realized_pnl) VALUES(?,?,?,?,?,?,?,?,?,?)',[String(t.id),String(t.portfolioId),String(t.symbol),String(t.side),Number(t.quantity),Number(t.price),Number(t.fees||0),String(t.currency||'RUB'),String(t.date||new Date().toISOString()),Number(t.realizedPnL||0)]);
      for(const a of s.alerts) db.run('INSERT INTO alerts(id,symbol,condition,threshold,enabled,last_triggered) VALUES(?,?,?,?,?,?)',[String(a.id),String(a.symbol),String(a.condition),Number(a.threshold),a.enabled?1:0,a.lastTriggered||null]);
      for(const [k,v] of Object.entries(s.settings)) db.run('INSERT INTO settings(key,value_json) VALUES(?,?)',[k,JSON.stringify(v)]);
      for(const [symbol,v] of Object.entries(s.cachedCandles)){const record={...v,candles:v.candles||[],savedAt:v.savedAt||new Date().toISOString()};db.run('INSERT INTO cached_candles(symbol,data_json,saved_at) VALUES(?,?,?)',[symbol,JSON.stringify(record),String(record.savedAt)]);}
      db.run('COMMIT');persist();return {ok:true};
    }catch(e){try{db.run('ROLLBACK')}catch(_){}throw e;}
  }
  function clear(){db.run('BEGIN IMMEDIATE');try{['watchlists','portfolios','transactions','alerts','settings','cached_candles','app_meta'].forEach(t=>db.run(`DELETE FROM ${t}`));db.run('COMMIT');persist();return {ok:true};}catch(e){try{db.run('ROLLBACK')}catch(_){}throw e;}}
  function close(){if(db){persist();db.close();db=null;}}
  persist();
  return {file,load,save,clear,close,get db(){return db;}};
}
module.exports={createSQLiteStore};
