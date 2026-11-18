// Phase 5 public contract and shared arithmetic. Never calls the provider.
export const VERSION = 'nba-betting/v1';
export const PROVIDER = 'the-odds-api';
export const MAX_AGE = 5 * 60_000;
export const STRESS_PP = .05;
export const BOOKS = Object.freeze({draftkings:'DraftKings', fanduel:'FanDuel',
  betmgm:'BetMGM', caesars:'Caesars', betonlineag:'BetOnline.ag', betrivers:'BetRivers',
  espnbet:'ESPN BET', thescorebet:'theScore Bet', hardrockbet:'Hard Rock Bet', fanatics:'Fanatics'});
export const DEFAULT_BOOKS = ['draftkings','fanduel','betmgm','caesars','betrivers','fanatics','hardrockbet'];
const bookAllowed = id => Object.hasOwn(BOOKS, id);
const id = x => typeof x === 'string' && /^\d{6,15}$/.test(x);
const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) &&
  Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x,k));
export const time = s => typeof s === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(s) ? Date.parse(s) : NaN;
const timed = s => Number.isFinite(time(s));
const probability = p => Number.isFinite(p) && p>=0 && p<=1;
export const american = a => Number.isInteger(a) && Math.abs(a)>=100 && Math.abs(a)<=1e6;
export const clamp01 = x => Math.max(0, Math.min(1, x));

export function toDecimal(a) {
  if (!american(a)) throw new RangeError('Invalid American moneyline');
  return a>0 ? 1+a/100 : 1+100/-a;
}
export function toAmerican(d) {
  if (!Number.isFinite(d) || d<=1) throw new RangeError('Invalid decimal price');
  return Math.round(d>=2 ? 100*(d-1) : -100/(d-1));
}
export function price(p, decimal, stake=0) {
  if (!probability(p) || !Number.isFinite(decimal) || decimal<=1 ||
      !Number.isFinite(stake) || stake<0 || stake>1e6) throw new RangeError('Invalid probability, price or stake');
  const ev = p*decimal-1;
  return {probability:p, decimal, breakEven:1/decimal, edge:p-1/decimal, ev,
    grossIfWin:stake*decimal, profitIfWin:stake*(decimal-1), lossIfLose:-stake,
    expectedGross:stake*p*decimal, expectedProfit:stake*ev};
}
export function noVig(home,away) {
  const h=1/toDecimal(home),a=1/toDecimal(away);
  return {home:h/(h+a), away:a/(h+a), hold:h+a-1};
}
export function bounds(ps) {
  if (!Array.isArray(ps) || !ps.length || !ps.every(probability)) throw new TypeError('Invalid marginals');
  return {low:Math.max(0,ps.reduce((a,b)=>a+b,0)-ps.length+1), high:Math.min(...ps)};
}
export function validQuote(q) {
  return exact(q,['event_id','provider_event_id','book','market','tip_at','home','away','home_ml','away_ml',
    'updated_at','retrieved_at','timestamp_basis']) && id(q.event_id) &&
    typeof q.provider_event_id==='string' && /^[A-Za-z0-9_-]{8,80}$/.test(q.provider_event_id) &&
    bookAllowed(q.book) && q.market==='h2h' && timed(q.tip_at) && id(q.home) && id(q.away) && q.home!==q.away &&
    american(q.home_ml) && american(q.away_ml) && timed(q.updated_at) && timed(q.retrieved_at) &&
    ['market','book'].includes(q.timestamp_basis) && time(q.updated_at)<=time(q.retrieved_at) &&
    time(q.retrieved_at)<time(q.tip_at);
}
export function validOdds(feed) {
  if (!exact(feed,['version','provider','status','captured_at','quotes']) || feed.version!==VERSION ||
      feed.provider!==PROVIDER || !['available','unavailable','no_markets'].includes(feed.status) ||
      !timed(feed.captured_at) || !Array.isArray(feed.quotes) || feed.quotes.length>600) return false;
  if ((feed.status==='available')!==Boolean(feed.quotes.length)) return false;
  const keys=new Set();
  const providerIds=new Map();
  for (const q of feed.quotes) {
    if (!validQuote(q) || time(q.retrieved_at)!==time(feed.captured_at) ||
        time(q.retrieved_at)-time(q.updated_at)>MAX_AGE) return false;
    const key=q.event_id+':'+q.book;
    if (keys.has(key) || (providerIds.has(q.provider_event_id)&&providerIds.get(q.provider_event_id)!==q.event_id)) return false;
    keys.add(key);
    providerIds.set(q.provider_event_id,q.event_id);
  }
  return true;
}
export function available(q,game,now) {
  return validQuote(q) && game?.status==='scheduled' && q.event_id===game.id && q.home===game.home && q.away===game.away &&
    time(q.tip_at)===time(game.tip_at_utc) && now<time(q.tip_at) &&
    now>=time(q.retrieved_at) && now-time(q.updated_at)<=MAX_AGE && now-time(q.retrieved_at)<=MAX_AGE;
}
function forecast(game, model, side, quote) {
  if (!['V1','PA3'].includes(model)) return null;
  const f=game.forecasts?.[model], stamp=time(f?.recorded_at_utc), tip=time(game.tip_at_utc);
  const p=f?.[side+'_probability'];
  const expected={V1:'V1_reference',PA3:'PA3_roster'}[model];
  if (!probability(p) || f.model_version!==expected || !probability(f.home_probability) ||
      !probability(f.away_probability) || Math.abs(f.home_probability+f.away_probability-1)>1e-9 ||
      !(stamp<=time(quote.retrieved_at)&&tip-stamp>=90*60_000&&tip-stamp<=24*60*60_000)) return null;
  return {p, version:f.model_version, recordedAt:f.recorded_at_utc};
}
export function straightBets(predictions, odds, model, stake, now=Date.now()) {
  if (!validOdds(odds) || !Array.isArray(predictions?.games)) return [];
  const games=new Map(predictions.games.map(g=>[g.id,g]));
  return odds.quotes.flatMap(q=>{
    const g=games.get(q.event_id);
    if (!available(q,g,now)) return [];
    const market=noVig(q.home_ml,q.away_ml);
    return ['home','away'].flatMap(side=>{
      const f=forecast(g,model,side,q);
      if (!f) return [];
      const alt=forecast(g,model==='PA3'?'V1':'PA3',side,q);
      const other=alt?.p ?? null;
      const decimal=toDecimal(q[side+'_ml']);
      const opposite=toDecimal(q[(side==='home'?'away':'home')+'_ml']);
      const low=clamp01(Math.min(f.p,other??f.p)-STRESS_PP), high=clamp01(Math.max(f.p,other??f.p)+STRESS_PP);
      const r=price(f.p,decimal,stake);
      const evLow=low*decimal-1;
      return [{...r,model,forecast:f,other,low,high,evLow,evHigh:high*decimal-1,
        pass:other!==null&&r.ev>=.02&&evLow>0,marketNoVig:market[side], side,
        american:q[side+'_ml'],event:q.event_id,team:q[side],book:q.book,quote:q,
        favorite:decimal<opposite,underdog:decimal>opposite,key:q.event_id+':'+q.book+':'+side}];
    });
  });
}
const product = ps=>ps.reduce((a,b)=>a*b,1);
export function parlay(legs, stake=0) {
  if (legs.length<2 || legs.length>12 || new Set(legs.map(x=>x.event)).size!==legs.length ||
      new Set(legs.map(x=>x.book)).size!==1 || new Set(legs.map(x=>x.model)).size!==1 ||
      new Set(legs.flatMap(x=>[x.quote.home,x.quote.away])).size!==2*legs.length)
    throw new RangeError('Parlays require different games, disjoint teams, one book and one model');
  const captured=legs.map(l=>time(l.quote.retrieved_at));
  if (Math.max(...captured)-Math.min(...captured)>60_000) throw new RangeError('Quotes not contemporaneous');
  const r=price(product(legs.map(l=>l.probability)),product(legs.map(l=>l.decimal)),stake);
  const dependence=bounds(legs.map(l=>l.probability));
  const jointStress=[product(legs.map(l=>l.low)),product(legs.map(l=>l.high))];
  const evLow=jointStress[0]*r.decimal-1, evHigh=jointStress[1]*r.decimal-1;
  const gate=legs.every(l=>l.other!==null)&&r.ev>=.02&&evLow>0;
  const splitEv=legs.reduce((a,l)=>a+l.ev,0)/legs.length;
  return {...r,american:toAmerican(r.decimal),book:legs[0].book,model:legs[0].model,legs,jointStress,dependence,
    evLow,evHigh,pass:false,scenarioPositive:gate,
    payoutBasis:'theoretical_same_book_product',jointBasis:'independence_approximation',
    splitEv,splitExpectedProfit:stake*splitEv,
    key:legs.map(l=>l.key).sort().join('|')};
}
export function rank(rows,by='ev') {
  if (!['ev','probability','evLow'].includes(by)) throw new RangeError('Unknown sort');
  return [...rows].sort((a,b)=>b[by]-a[by]||b.ev-a.ev||a.key.localeCompare(b.key));
}
export function combinations(rows,n,stake=0,filter='all') {
  if (![2,3].includes(n)) throw new RangeError('Automatic comparison only supports 2 or 3 legs');
  const out=[];
  for(const book of new Set(rows.map(x=>x.book))) {
    const pool=rows.filter(x=>x.book===book && (filter==='all' || (filter==='favorites'&&x.favorite) ||
      (filter==='underdogs'&&x.underdog&&x.ev>0)));
    function walk(cursor, chosen) {
      if (chosen.length===n) {out.push(parlay(chosen,stake));return;}
      for(let i=cursor;i<=pool.length-(n-chosen.length);i++) {
        const q=pool[i];
        if(chosen.some(l=>l.event===q.event||[l.quote.home,l.quote.away].some(t=>[q.quote.home,q.quote.away].includes(t)))) continue;
        if(chosen.some(l=>Math.abs(time(l.quote.retrieved_at)-time(q.quote.retrieved_at))>60_000)) continue;
        walk(i+1,[...chosen,q]);
      }
    }
    walk(0,[]);
  }
  return out;
}
