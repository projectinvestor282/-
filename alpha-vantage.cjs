'use strict';
const https = require('node:https');
const zlib = require('node:zlib');
const ENDPOINT = 'https://www.alphavantage.co/query';
const DAY = 86400;

function requestJson(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'StockMind/1.0', Accept: 'application/json', 'Accept-Encoding': 'gzip' } }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return reject(new Error(`Alpha Vantage HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        const finish = bytes => {
          try { resolve(JSON.parse(bytes.toString('utf8'))); }
          catch (_) { reject(new Error('Alpha Vantage returned invalid JSON')); }
        };
        if (res.headers['content-encoding'] === 'gzip') zlib.gunzip(data, (err, bytes) => err ? reject(new Error('Alpha Vantage returned invalid compressed data')) : finish(bytes));
        else finish(data);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Alpha Vantage request timed out')));
    req.on('error', error => reject(new Error(error?.message === 'Alpha Vantage request timed out' ? error.message : 'Alpha Vantage request failed')));
  });
}
function getParam(params, name) { return params && typeof params.get === 'function' ? params.get(name) : params?.[name]; }
function validDate(s) { if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(`${s}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s; }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function makeStat(candles) {
  if (!candles.length) return {};
  const first = candles[0], last = candles[candles.length - 1];
  const high = Math.max(...candles.map(c => c.high)), low = Math.min(...candles.map(c => c.low));
  const volume = candles.reduce((a, c) => a + c.volume, 0), change = +(last.close - first.open).toFixed(2);
  return { last: last.close, open: first.open, high, low, volume, change, changePct: first.open ? +((last.close - first.open) / first.open * 100).toFixed(2) : 0, count: candles.length };
}
function createAlphaVantageProvider(options = {}) {
  const getKey = options.getApiKey || (() => process.env.ALPHA_VANTAGE_API_KEY || '');
  const getJson = options.requestJson || requestJson;
  const now = options.now || Date.now;
  const ttl = Number.isFinite(options.cacheTtlMs) ? Math.max(0, options.cacheTtlMs) : 10 * 60 * 1000;
  const cache = new Map(), pending = new Map();
  async function fetchCandles(params = {}) {
    const ticker = String(getParam(params, 'ticker') ?? '').trim().toUpperCase();
    const interval = String(getParam(params, 'interval') ?? '1d');
    const from = getParam(params, 'from') || '1900-01-01';
    const till = getParam(params, 'till') || new Date(now()).toISOString().slice(0, 10);
    if (!/^[A-Z0-9.-]{1,20}$/.test(ticker)) throw new Error('Invalid ticker');
    if (interval !== '1d') throw new Error('Alpha Vantage supports daily interval 1d only');
    if (!validDate(from) || !validDate(till) || from > till) throw new Error('Invalid date range');
    let key;
    try { key = await getKey(); } catch (_) { throw new Error('Alpha Vantage API key is unavailable'); }
    if (typeof key !== 'string' || !key.trim()) throw new Error('Alpha Vantage API key is required');
    key = key.trim();
    // Compact free-tier data provides at most the latest 100 daily bars.
    const cacheKey = `${ticker}|${from}|${till}`;
    const time = Number(now());
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > time) { cache.delete(cacheKey); cache.set(cacheKey, hit); return clone(hit.value); }
    if (hit) cache.delete(cacheKey);
    if (pending.has(cacheKey)) return clone(await pending.get(cacheKey));
    const work = (async () => {
      const url = `${ENDPOINT}?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(ticker)}&outputsize=compact&apikey=${encodeURIComponent(key)}`;
      let data;
      try { data = await getJson(url); } catch (error) { if (/^Alpha Vantage/.test(error?.message || '')) throw error; throw new Error('Alpha Vantage request failed'); }
      for (const field of ['Error Message', 'Note', 'Information']) {
        if (data && typeof data[field] === 'string' && data[field]) {
          const original = data[field].replaceAll(key, '[ключ скрыт]').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240);
          const msg = /call frequency|rate limit|quota|thank you for using|higher API call frequency|25 api requests per day/i.test(data[field])
            ? 'Лимит Alpha Vantage достигнут (бесплатный тариф ограничен запросами в сутки); попробуй позже или проверь квоту на сайте провайдера.'
            : `Alpha Vantage отклонил запрос: ${original}`;
          throw new Error(msg);
        }
      }
      const series = data?.['Time Series (Daily)'];
      if (!series || typeof series !== 'object' || Array.isArray(series)) throw new Error('Alpha Vantage response is missing daily candle data');
      const candles = Object.entries(series).map(([date, row]) => {
        if (!validDate(date) || !row || typeof row !== 'object') return null;
        const vals = ['1. open', '2. high', '3. low', '4. close', '5. volume'].map(k => Number(row[k]));
        if (!vals.every(Number.isFinite)) return null;
        return { time: Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000), open: vals[0], high: vals[1], low: vals[2], close: vals[3], volume: vals[4] };
      }).filter(c => c && c.time >= Date.parse(`${from}T00:00:00Z`) / 1000 && c.time <= Date.parse(`${till}T00:00:00Z`) / 1000).sort((a, b) => a.time - b.time).slice(-100);
      const result = { candles, stat: makeStat(candles), provider: 'alpha-vantage', exchange: 'us', currency: 'USD', interval: '1d', from, till, limited: true, maxRows: 100 };
      if (ttl > 0) { cache.set(cacheKey, { value: result, expires: Number(now()) + ttl }); while (cache.size > 20) cache.delete(cache.keys().next().value); }
      return result;
    })();
    pending.set(cacheKey, work);
    try { return clone(await work); } finally { if (pending.get(cacheKey) === work) pending.delete(cacheKey); }
  }
  return { id: 'alpha-vantage', fetchCandles };
}
module.exports = { ENDPOINT, requestJson, createAlphaVantageProvider };
