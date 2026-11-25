(function (root) {
  'use strict';

  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const periodOk = (n) => Number.isInteger(n) && n > 0;
  const valuesOk = (xs) => Array.isArray(xs) && xs.every(isNum);
  const nulls = (n) => Array(n).fill(null);

  function sma(values, period) {
    if (!valuesOk(values) || !periodOk(period)) throw new TypeError('values must be finite numbers and period a positive integer');
    const out = nulls(values.length);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function ema(values, period) {
    if (!valuesOk(values) || !periodOk(period)) throw new TypeError('values must be finite numbers and period a positive integer');
    const out = nulls(values.length);
    if (values.length < period) return out;
    let current = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    out[period - 1] = current;
    const alpha = 2 / (period + 1);
    for (let i = period; i < values.length; i++) {
      current = alpha * values[i] + (1 - alpha) * current;
      out[i] = current;
    }
    return out;
  }

  // Wilder RSI: initial mean gain/loss, then Wilder's recursive smoothing.
  function rsi(closes, period) {
    if (!valuesOk(closes) || !periodOk(period)) throw new TypeError('closes must be finite numbers and period a positive integer');
    const out = nulls(closes.length);
    if (closes.length <= period) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) gain += d; else loss -= d;
    }
    gain /= period; loss /= period;
    const score = (g, l) => l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
    out[period] = score(gain, loss);
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      gain = (gain * (period - 1) + Math.max(d, 0)) / period;
      loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
      out[i] = score(gain, loss);
    }
    return out;
  }

  function bollinger(values, period, deviations) {
    if (!valuesOk(values) || !periodOk(period) || !isNum(deviations === undefined ? 2 : deviations) || (deviations === undefined ? 2 : deviations) < 0) throw new TypeError('invalid Bollinger band arguments');
    const k = deviations === undefined ? 2 : deviations;
    const middle = nulls(values.length), upper = nulls(values.length), lower = nulls(values.length);
    for (let i = period - 1; i < values.length; i++) {
      const window = values.slice(i - period + 1, i + 1);
      const mean = window.reduce((a, b) => a + b, 0) / period;
      const variance = window.reduce((a, x) => a + (x - mean) ** 2, 0) / period;
      const sd = Math.sqrt(variance);
      middle[i] = mean; upper[i] = mean + k * sd; lower[i] = mean - k * sd;
    }
    return { middle, upper, lower };
  }

  function trueRanges(records) {
    return records.map((r, i) => i === 0 ? null : Math.max(r.high - r.low, Math.abs(r.high - records[i - 1].close), Math.abs(r.low - records[i - 1].close)));
  }
  function validateOhlc(records) {
    if (!Array.isArray(records) || records.some(r => !r || !['high','low','close'].every(k => isNum(r[k])) || r.high < r.low)) throw new TypeError('records must contain valid high, low, close values');
  }
  function atr(records, period) {
    validateOhlc(records);
    if (!periodOk(period)) throw new TypeError('period must be a positive integer');
    const trs = trueRanges(records), out = nulls(records.length);
    if (records.length <= period) return out;
    let current = trs.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
    out[period] = current;
    for (let i = period + 1; i < records.length; i++) {
      current = (current * (period - 1) + trs[i]) / period;
      out[i] = current;
    }
    return out;
  }

  function macd(values, fastPeriod, slowPeriod, signalPeriod) {
    fastPeriod = fastPeriod === undefined ? 12 : fastPeriod;
    slowPeriod = slowPeriod === undefined ? 26 : slowPeriod;
    signalPeriod = signalPeriod === undefined ? 9 : signalPeriod;
    if (!periodOk(fastPeriod) || !periodOk(slowPeriod) || !periodOk(signalPeriod) || fastPeriod >= slowPeriod) throw new TypeError('MACD requires positive integer periods and fastPeriod < slowPeriod');
    const fast = ema(values, fastPeriod), slow = ema(values, slowPeriod);
    const line = nulls(values.length);
    for (let i = 0; i < values.length; i++) if (fast[i] !== null && slow[i] !== null) line[i] = fast[i] - slow[i];
    const validLine = line.filter(x => x !== null);
    const signalValues = ema(validLine, signalPeriod);
    const signal = nulls(values.length), histogram = nulls(values.length);
    let j = 0;
    for (let i = 0; i < line.length; i++) if (line[i] !== null) {
      signal[i] = signalValues[j++];
      if (signal[i] !== null) histogram[i] = line[i] - signal[i];
    }
    return { macd: line, signal, histogram };
  }

  function wma(values, period) {
    if (!valuesOk(values) || !periodOk(period)) throw new TypeError('invalid WMA arguments');
    const out = nulls(values.length), divisor = period * (period + 1) / 2;
    for (let i = period - 1; i < values.length; i++) { let sum = 0; for (let j = 0; j < period; j++) sum += values[i - period + 1 + j] * (j + 1); out[i] = sum / divisor; }
    return out;
  }

  function vwap(records) {
    if (!Array.isArray(records) || records.some(r => !r || !['high','low','close','volume'].every(k => isNum(r[k])) || r.volume < 0)) throw new TypeError('VWAP requires valid OHLCV records');
    let pv = 0, volume = 0;
    return records.map(r => { pv += ((r.high + r.low + r.close) / 3) * r.volume; volume += r.volume; return volume ? pv / volume : null; });
  }

  function stochastic(records, kPeriod, dPeriod) {
    validateOhlc(records); kPeriod = kPeriod === undefined ? 14 : kPeriod; dPeriod = dPeriod === undefined ? 3 : dPeriod;
    if (!periodOk(kPeriod) || !periodOk(dPeriod)) throw new TypeError('invalid stochastic periods');
    const k = nulls(records.length), d = nulls(records.length);
    for (let i = kPeriod - 1; i < records.length; i++) { const w = records.slice(i - kPeriod + 1, i + 1), hi = Math.max(...w.map(x => x.high)), lo = Math.min(...w.map(x => x.low)); k[i] = hi === lo ? 50 : (records[i].close - lo) / (hi - lo) * 100; }
    for (let i = kPeriod + dPeriod - 2; i < records.length; i++) d[i] = k.slice(i - dPeriod + 1, i + 1).reduce((a, b) => a + b, 0) / dPeriod;
    return { k, d };
  }

  function cci(records, period) {
    validateOhlc(records); if (!periodOk(period)) throw new TypeError('period must be a positive integer');
    const tp = records.map(r => (r.high + r.low + r.close) / 3), out = nulls(records.length);
    for (let i = period - 1; i < records.length; i++) { const w = tp.slice(i - period + 1, i + 1), mean = w.reduce((a, b) => a + b, 0) / period, dev = w.reduce((a, v) => a + Math.abs(v - mean), 0) / period; out[i] = dev === 0 ? 0 : (tp[i] - mean) / (0.015 * dev); }
    return out;
  }

  function roc(values, period) {
    if (!valuesOk(values) || !periodOk(period)) throw new TypeError('invalid ROC arguments');
    const out = nulls(values.length); for (let i = period; i < values.length; i++) out[i] = values[i - period] === 0 ? null : (values[i] - values[i - period]) / values[i - period] * 100; return out;
  }
  function momentum(values, period) {
    if (!valuesOk(values) || !periodOk(period)) throw new TypeError('invalid momentum arguments');
    const out = nulls(values.length); for (let i = period; i < values.length; i++) out[i] = values[i] - values[i - period]; return out;
  }

  function adx(records, period) {
    validateOhlc(records); if (!periodOk(period)) throw new TypeError('period must be a positive integer');
    const n = records.length, plusDI = nulls(n), minusDI = nulls(n), dx = nulls(n), adxValues = nulls(n), tr = trueRanges(records);
    if (n < period * 2) return { adx: adxValues, plusDI, minusDI };
    let smTR = 0, smPlus = 0, smMinus = 0;
    for (let i = 1; i <= period; i++) { const up=records[i].high-records[i-1].high, down=records[i-1].low-records[i].low; smTR+=tr[i]; smPlus+=up>down&&up>0?up:0; smMinus+=down>up&&down>0?down:0; }
    const makeDx = i => { plusDI[i]=smTR?100*smPlus/smTR:0; minusDI[i]=smTR?100*smMinus/smTR:0; const d=plusDI[i]+minusDI[i]; dx[i]=d?100*Math.abs(plusDI[i]-minusDI[i])/d:0; };
    makeDx(period);
    for(let i=period+1;i<n;i++){const up=records[i].high-records[i-1].high,down=records[i-1].low-records[i].low;smTR=smTR-smTR/period+tr[i];smPlus=smPlus-smPlus/period+(up>down&&up>0?up:0);smMinus=smMinus-smMinus/period+(down>up&&down>0?down:0);makeDx(i);}
    const first=period*2-1; if(first<n){let mean=0;for(let i=period;i<=first;i++)mean+=dx[i];mean/=period;adxValues[first]=mean;for(let i=first+1;i<n;i++)adxValues[i]=(adxValues[i-1]*(period-1)+dx[i])/period;}
    return { adx: adxValues, plusDI, minusDI };
  }

  function obv(records) {
    if (!Array.isArray(records) || records.some(r => !r || !isNum(r.close) || !isNum(r.volume) || r.volume < 0)) throw new TypeError('OBV requires close and non-negative volume');
    let value = 0; return records.map((r, i) => { if (i) value += r.close > records[i-1].close ? r.volume : r.close < records[i-1].close ? -r.volume : 0; return value; });
  }

  function dailyChange(current, previous) {
    if (!isNum(current) || !isNum(previous)) throw new TypeError('prices must be finite numbers');
    const change = current - previous;
    return { change, percent: previous === 0 ? null : change / previous * 100 };
  }

  // Inclusive bounds. Missing/null fields are ignored; an explicitly requested
  // filter cannot match a record when the corresponding field is unavailable.
  function screen(records, filters) {
    if (!Array.isArray(records)) throw new TypeError('records must be an array');
    filters = filters || {};
    const bounds = [['minPrice','price','min'],['maxPrice','price','max'],['minChange','change','min'],['maxChange','change','max'],['minVolume','volume','min'],['maxVolume','volume','max']];
    return records.filter(r => {
      if (!r || typeof r !== 'object') return false;
      const conditions = [];
      for (const [filter, field, direction] of bounds) {
        if (isNum(filters[filter])) {
          const v = r[field];
          conditions.push(isNum(v) && (direction === 'min' ? v >= filters[filter] : v <= filters[filter]));
        }
      }
      if (filters.sector !== undefined && filters.sector !== null && filters.sector !== '') conditions.push(r.sector === filters.sector);
      if (!conditions.length) return true;
      return filters.logic === 'or' ? conditions.some(Boolean) : conditions.every(Boolean);
    });
  }

  function maxDrawdown(values) {
    if (!valuesOk(values)) throw new TypeError('values must be finite numbers');
    if (!values.length) return { percent: null, peakIndex: null, troughIndex: null };
    let peak = values[0], peakIndex = 0, worst = 0, worstPeak = 0, troughIndex = 0;
    for (let i = 0; i < values.length; i++) {
      if (values[i] > peak) { peak = values[i]; peakIndex = i; }
      const drawdown = peak > 0 ? (peak - values[i]) / peak : 0;
      if (drawdown > worst) { worst = drawdown; worstPeak = peakIndex; troughIndex = i; }
    }
    return { percent: worst * 100, peakIndex: worstPeak, troughIndex };
  }

  function toCsv(records, columns, separator = ';') {
    if (!Array.isArray(records) || !Array.isArray(columns) || typeof separator !== 'string' || separator.length !== 1) throw new TypeError('invalid CSV arguments');
    const cell = (value, column) => {
      let s = value == null ? '' : String(value);
      const safeNumber = column?.number === true && typeof value === 'number' && Number.isFinite(value);
      if (!safeNumber && /^[\s]*[=+\-@]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    return [columns.map(c => cell(c.label, { text: true })), ...records.map(row => columns.map(c => cell(row?.[c.key], c)))].map(row => row.join(separator)).join('\r\n');
  }

  const api = { sma, ema, wma, vwap, rsi, bollinger, atr, macd, stochastic, cci, roc, momentum, adx, obv, dailyChange, screen, maxDrawdown, toCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.StockMindAnalytics = api;
})(typeof window !== 'undefined' ? window : globalThis);
