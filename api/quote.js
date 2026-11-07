// Vercel 서버 함수: GET /api/quote?s=005930,AAPL
// Yahoo Finance 차트 API에서 현재가와 전일 종가를 받아 와 돌려준다. (브라우저가 직접 부르면 CORS로 막혀서 서버가 대신 부른다)
// 응답: { "005930": { sym:"005930.KS", price, prev, cur:"KRW", name, t:<거래소 시각(초)> }, "ZZZZ": { error:"not_found" } }
const SYM = /^[A-Z0-9][A-Z0-9.^=-]{0,14}$/;
const KR = /^\d{4}[0-9A-Z]{2}$/; // 한국 종목코드(6자리). 코스피(.KS)와 코스닥(.KQ)을 모두 찾는다.
const UA = 'Mozilla/5.0 (compatible; Fincore/0.3)';

async function chart(sym) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=5d&interval=1d';
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (r.status === 404) return null;           // 없는 종목
  if (!r.ok) throw new Error('upstream ' + r.status);
  const res = (await r.json())?.chart?.result?.[0];
  const m = res && res.meta;
  if (!m || !(m.regularMarketPrice > 0)) return null;
  const ts = res.timestamp || [], cl = res.indicators?.quote?.[0]?.close || [], off = m.gmtoffset || 0;
  const day = t => Math.floor((t + off) / 86400), bars = [];
  ts.forEach((t, i) => { if (cl[i] != null) bars.push([t, cl[i]]); });
  // 전일 종가: 마지막 일봉이 오늘 것이면 그 앞 일봉, 아니면(장 시작 전) 마지막 일봉
  let prev = null;
  if (bars.length) {
    const last = bars[bars.length - 1];
    prev = day(last[0]) === day(m.regularMarketTime) ? (bars.length > 1 ? bars[bars.length - 2][1] : m.chartPreviousClose) : last[1];
  }
  return { sym: m.symbol, price: m.regularMarketPrice, prev: prev > 0 ? prev : null, cur: m.currency, name: m.longName || m.shortName || '', t: m.regularMarketTime || 0 };
}

module.exports = async (req, res) => {
  const raw = String((req.query && req.query.s) || '').toUpperCase();
  const list = [...new Set(raw.split(',').map(x => x.trim()).filter(Boolean))].slice(0, 30);
  if (!list.length) { res.status(400).json({ error: 'no_symbol' }); return; }
  const out = {};
  await Promise.all(list.map(async s => {
    if (!SYM.test(s)) { out[s] = { error: 'bad_symbol' }; return; }
    try {
      let q = null;
      if (KR.test(s)) {
        // 같은 코드가 .KS에 옛 기록으로 남아 있는 경우가 있어서, 둘 다 조회해 시세 시각이 더 최근인 쪽을 쓴다.
        const got = (await Promise.all([s + '.KS', s + '.KQ'].map(c => chart(c).catch(() => null)))).filter(Boolean);
        got.sort((a, b) => b.t - a.t); q = got[0] || null;
      } else q = await chart(s);
      out[s] = q || { error: 'not_found' };
    } catch (e) { out[s] = { error: 'fetch_failed' }; }
  }));
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
  res.status(200).json(out);
};
