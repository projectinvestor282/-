'use strict';
const https=require('node:https');
const zlib=require('node:zlib');
const API='https://api.gdeltproject.org/api/v2/doc/doc';
const PUBLICATIONS=Object.freeze({economist:{name:'The Economist',domain:'economist.com'},ft:{name:'Financial Times',domain:'ft.com'},cnbc:{name:'CNBC',domain:'cnbc.com'},reuters:{name:'Reuters',domain:'reuters.com'}});
function retryAfterMs(value,now=Date.now()){
  if(value==null)return null;
  const n=Number(value);if(Number.isFinite(n)&&n>=0)return n*1000;
  const date=Date.parse(String(value));return Number.isFinite(date)?Math.max(0,date-now):null;
}
function requestJson(url,timeout=15000){return new Promise((resolve,reject)=>{
  const req=https.get(url,{headers:{'User-Agent':'StockMind/1.0 (+desktop local client)','Accept':'application/json','Accept-Encoding':'gzip'}},res=>{
    if(res.statusCode<200||res.statusCode>=300){res.resume();const error=new Error(`GDELT HTTP ${res.statusCode}`);error.statusCode=res.statusCode;error.retryAfterMs=retryAfterMs(res.headers['retry-after']);return reject(error);}
    const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>2_000_000){req.destroy(new Error('News response too large'));return;}chunks.push(chunk);});
    res.on('end',()=>{const body=Buffer.concat(chunks),done=bytes=>{try{resolve(JSON.parse(bytes.toString('utf8')));}catch(_){reject(new Error('GDELT returned invalid JSON'));}};if(res.headers['content-encoding']==='gzip')zlib.gunzip(body,(err,data)=>err?reject(new Error('GDELT returned invalid compressed data')):done(data));else done(body);});
  });
  req.setTimeout(timeout,()=>req.destroy(new Error('News request timed out')));req.on('error',reject);
});}
function categorize(title=''){const s=title.toLowerCase();if(/earnings|quarter|revenue|profit|stocks?|shares?|market|investor|fund|bank|econom/.test(s))return 'Markets';if(/oil|gas|energy|crude|solar|power/.test(s))return 'Energy';if(/technology|tech|artificial intelligence|\bai\b|chip|semiconductor/.test(s))return 'Technology';return 'World';}
function parseDate(value){if(typeof value!=='string')return null;const m=value.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?(\d{2})?Z?$/);if(m){const iso=`${m[1]}-${m[2]}-${m[3]}T${m[4]||'00'}:${m[5]||'00'}:${m[6]||'00'}Z`;const ms=Date.parse(iso);return Number.isFinite(ms)?new Date(ms).toISOString():null;}const ms=Date.parse(value);return Number.isFinite(ms)?new Date(ms).toISOString():null;}
function normalizeArticles(raw){const rows=Array.isArray(raw?.articles)?raw.articles:[];return rows.map(a=>{if(!a||typeof a!=='object')return null;const url=String(a.url||'');const title=String(a.title||'').trim();const publishedAt=parseDate(a.seendate);if(!title||!publishedAt||!/^https?:\/\//i.test(url))return null;let domain=String(a.domain||'');try{domain=new URL(url).hostname.replace(/^www\./,'');}catch(_){return null;}return {id:`gdelt:${url}`,title,link:url,publishedAt,summary:'',source:domain,sourceCountry:String(a.sourcecountry||''),language:String(a.language||''),category:categorize(title),feedId:'gdelt-doc',provider:'GDELT',cached:false};}).filter(Boolean);}
function wait(ms){return new Promise(r=>setTimeout(r,ms));}
function createNewsProvider(options={}){
  const get=options.requestJson||requestJson,sleep=options.delay||wait,now=options.now||Date.now;
  const minInterval=Math.max(5000,Number(options.minIntervalMs)||5500),retryDefault=Math.max(5000,Number(options.rateLimitCooldownMs)||60000);
  let nextRequestAt=0,cooldownUntil=0,queue=Promise.resolve();const inFlight=new Map();
  function scheduledGet(url){const task=queue.catch(()=>{}).then(async()=>{const due=Math.max(nextRequestAt,cooldownUntil),delay=due-now();if(delay>0)await sleep(delay);nextRequestAt=now()+minInterval;return get(url);});queue=task.then(()=>undefined,()=>undefined);return task;}
  async function fetchLatest(search='',publication=''){
    search=String(search||'').trim().slice(0,100);publication=String(publication||'').trim().toLowerCase();if(publication&&!PUBLICATIONS[publication])throw new Error('Unknown news publication');const dedupeKey=`${search.toLowerCase()}|${publication}`;if(inFlight.has(dedupeKey))return inFlight.get(dedupeKey);if(now()<cooldownUntil)throw new Error(`Лента GDELT ограничила частоту запросов. Повторите после ${new Date(cooldownUntil).toLocaleTimeString()}; показывается сохранённый кэш.`);
    const work=(async()=>{
      const words=search?`"${search.replace(/["\\]/g,' ').replace(/\s+/g,' ').trim()}"`:'(stocks OR shares OR finance OR markets OR companies)';const query=publication?`${words} domain:${PUBLICATIONS[publication].domain}`:words;
      const url=new URL(API);url.searchParams.set('query',query);url.searchParams.set('mode','ArtList');url.searchParams.set('format','json');url.searchParams.set('timespan','1d');url.searchParams.set('maxrecords','20');url.searchParams.set('sort','HybridRel');
      let response,lastError;
      for(let attempt=0;attempt<3;attempt++){
        try{response=await scheduledGet(url.href);break;}
        catch(error){lastError=error;if(error.statusCode===429){cooldownUntil=now()+Math.max(retryDefault,error.retryAfterMs||0);const retryAt=new Date(cooldownUntil).toLocaleTimeString();throw new Error(`Лента GDELT ограничила частоту запросов. Повторите после ${retryAt}; показывается сохранённый кэш.`);}if(attempt===2||![500,502,503,504].includes(error.statusCode))throw error;await sleep(Math.min(10000,1000*2**attempt));}
      }
      if(!response)throw lastError||new Error('News provider did not respond');
      return {articles:normalizeArticles(response).map(a=>({...a,publication:publication||null})),fetchedAt:new Date(now()).toISOString(),source:'GDELT DOC · links to original publishers',query,publication:publication||null,errors:[],cached:false};
    })();
    inFlight.set(dedupeKey,work);try{return await work;}finally{if(inFlight.get(dedupeKey)===work)inFlight.delete(dedupeKey);}
  }
  return {id:'gdelt-doc',name:'GDELT DOC API',capabilities:{articleSearch:true,headlines:true,fullText:false,apiKeyRequired:false,publications:Object.keys(PUBLICATIONS)},fetchLatest};
}
module.exports={API,PUBLICATIONS,retryAfterMs,categorize,parseDate,normalizeArticles,createNewsProvider};
