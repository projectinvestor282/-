'use strict';
const https = require('node:https');
const zlib = require('node:zlib');

// MOEX ISS candlestick intervals; do not map unsupported durations to guessed values.
const INTERVALS = Object.freeze({'1m':1,'10m':10,'60m':60,'1d':24,'1w':7,'1M':31});
function requestJson(url, timeoutMs=15000) {
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'User-Agent':'StockMind/1.0','Accept':'application/json','Accept-Encoding':'gzip'}},res=>{
      if(res.statusCode<200||res.statusCode>=300){res.resume();return reject(new Error(`MOEX HTTP ${res.statusCode}`));}
      const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>25_000_000){req.destroy(new Error('MOEX response too large'));return;}chunks.push(chunk);});
      res.on('end',()=>{const body=Buffer.concat(chunks),done=bytes=>{try{resolve(JSON.parse(bytes.toString('utf8')));}catch(_){reject(new Error('MOEX returned invalid JSON'));}};if(res.headers['content-encoding']==='gzip')zlib.gunzip(body,(err,data)=>err?reject(new Error('MOEX returned invalid compressed data')):done(data));else done(body);});
    });
    req.setTimeout(timeoutMs,()=>req.destroy(new Error('MOEX request timed out')));req.on('error',reject);
  });
}
function clone(x){return JSON.parse(JSON.stringify(x));}
function createMoexIssProvider(options={}) {
  const getJson=options.requestJson||requestJson;
  const sleep=options.sleep||((ms)=>new Promise(resolve=>setTimeout(resolve,ms)));
  const now=options.now||Date.now,cacheTtl=Number.isFinite(options.cacheTtlMs)?Math.max(0,options.cacheTtlMs):60_000;
  const cache=new Map(),pending=new Map();
  async function getWithRetry(url){for(let attempt=0;attempt<3;attempt++){try{return await getJson(url);}catch(error){if(attempt===2)throw error;await sleep(250*(2**attempt));}}}
  function parsePage(data){const cols=data?.candles?.columns||[],rows=data?.candles?.data||[];const ix=Object.fromEntries(['open','high','low','close','volume','begin'].map(k=>[k,cols.indexOf(k)]));if(rows.length&&Object.values(ix).some(i=>i<0))throw new Error('MOEX candle response is missing required fields');const candles=[];for(const row of rows){const time=Math.floor(new Date(row[ix.begin]).getTime()/1000),candle={time,open:+row[ix.open],high:+row[ix.high],low:+row[ix.low],close:+row[ix.close],volume:+row[ix.volume]||0};if(Number.isFinite(time)&&['open','high','low','close','volume'].every(k=>Number.isFinite(candle[k])))candles.push(candle);}return candles;}
  function makeUrl(ticker,interval,from,till,start){return `https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities/${encodeURIComponent(ticker)}/candles.json?from=${encodeURIComponent(from)}&till=${encodeURIComponent(till)}&interval=${INTERVALS[interval]}&start=${start}&iss.meta=off`;}
  async function fetchUncached(ticker,interval,from,till){
    const first=parsePage(await getWithRetry(makeUrl(ticker,interval,from,till,0))),all=[...first];
    if(first.length===500){for(let page=1;page<20;page+=6){const starts=Array.from({length:Math.min(6,20-page)},(_,i)=>(page+i)*500);const pages=await Promise.all(starts.map(start=>getWithRetry(makeUrl(ticker,interval,from,till,start)).then(parsePage)));for(const rows of pages)all.push(...rows);if(pages.some(rows=>rows.length<500))break;}}
    all.sort((a,b)=>a.time-b.time);const stat={};if(all.length){const firstCandle=all[0],last=all[all.length-1];stat.last=last.close;stat.open=firstCandle.open;stat.high=Math.max(...all.map(x=>x.high));stat.low=Math.min(...all.map(x=>x.low));stat.volume=all.reduce((sum,x)=>sum+x.volume,0);stat.change=+(last.close-firstCandle.open).toFixed(2);stat.changePct=firstCandle.open?+((last.close-firstCandle.open)/firstCandle.open*100).toFixed(2):0;stat.count=all.length;}
    return {candles:all,stat,provider:'moex-iss',exchange:'moex',currency:'RUB',interval,from,till};
  }
  return {id:'moex-iss',name:'MOEX ISS',capabilities:{historicalCandles:true,streaming:false,marketWideSync:false},async fetchCandles(params){
    const ticker=(params.get('ticker')||'').trim().toUpperCase(),interval=params.get('interval')||'60m';if(!ticker||!/^[A-Z0-9._-]{1,20}$/.test(ticker)||!INTERVALS[interval])throw new Error('Unsupported ticker or interval');
    const from=params.get('from')||new Date(now()-30*864e5).toISOString().slice(0,10),till=params.get('till')||new Date(now()).toISOString().slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(till)||from>till)throw new Error('Invalid date range');
    const key=`${ticker}|${interval}|${from}|${till}`,time=now(),hit=cache.get(key);if(hit&&hit.expires>time){cache.delete(key);cache.set(key,hit);return clone(hit.value);}if(hit)cache.delete(key);if(pending.has(key))return clone(await pending.get(key));
    const work=fetchUncached(ticker,interval,from,till);pending.set(key,work);try{const value=await work;if(cacheTtl&&value.candles.length){cache.set(key,{value,expires:now()+cacheTtl});while(cache.size>16)cache.delete(cache.keys().next().value);}return clone(value);}finally{if(pending.get(key)===work)pending.delete(key);}
  }};
}
module.exports={INTERVALS,requestJson,createMoexIssProvider};
