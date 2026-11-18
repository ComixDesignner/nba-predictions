import {validateFeed,freshness,formatTip} from './site.js';
import {BOOKS,combinations,parlay,rank,straightBets,time} from './value.mjs';
import {ERRORS,RECEIPT_FILE,WORKFLOW_URL,quoteState,validReceipt,waitingForResult} from './manual.mjs';

const byId=id=>document.getElementById('bet-'+id);
const enc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const percent=x=>(100*x).toFixed(1)+'%';
const signed=x=>(x>0?'+':'')+x;
const money=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
const dollars=x=>money.format(x);
const stamp=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',
  second:'2-digit',timeZone:'America/New_York'});
const et=s=>stamp.format(new Date(s))+' ET';
const message=text=>'<p class="empty">'+enc(text)+'</p>';
const facts=entries=>'<dl class="bet-prices">'+entries.map(([key,value])=>
  '<div><dt>'+enc(key)+'</dt><dd>'+enc(value)+'</dd></div>').join('')+'</dl>';
const state={predictions:null,receipt:null,busy:false,attempted:false,resultReadFailed:false,waitingAt:null,
  timedOut:false,lastOpened:0,selected:new Map(),builderKey:null};
const label=(team,teams)=>teams.get(team)?.code??team;
const match=(row,teams)=>label(row.quote.away,teams)+' at '+label(row.quote.home,teams);
const bookName=book=>BOOKS[book];
const returns=(r,stake)=>stake>0?[['Total if won',dollars(r.grossIfWin)],['Net if won',dollars(r.profitIfWin)],
  ['Loss if lost',dollars(r.lossIfLose)],['Expected total',dollars(r.expectedGross)],['Expected net',dollars(r.expectedProfit)]]:[];
const valueText=r=>percent(r.ev)+' ('+dollars(r.ev)+' per $1)';

function straightCard(r,teams,stake) {
  const props=[['Model win chance',percent(r.probability)],['Moneyline',signed(r.american)+' · '+r.decimal.toFixed(3)],
    ['Break-even',percent(r.breakEven)],['No-vig market',percent(r.marketNoVig)],
    ['Probability edge',signed((100*r.edge).toFixed(1))+' pp'],['EV',valueText(r)],
    ['Stress-case EV',percent(r.evLow)+' to '+percent(r.evHigh)],
    [r.model==='V1'?'PA3 estimate':'V1 estimate',r.other===null?'Unavailable':percent(r.other)],...returns(r,stake)];
  const source=r.quote.timestamp_basis==='market'?'Market update':'Book update';
  return '<article class="bet-card"><h4>'+enc(teams.get(r.team)?.name??r.team)+'</h4><p>'+
    enc(match(r,teams)+' · '+formatTip(r.quote.tip_at)+' · '+bookName(r.book))+'</p>'+facts(props)+
    '<p>'+enc(source+' '+et(r.quote.updated_at)+' · Fetched '+et(r.quote.retrieved_at))+'</p>'+
    '<p>'+enc(r.forecast.version+' · Forecast '+et(r.forecast.recordedAt))+'</p><p>'+
    (r.pass?'Passes the exploratory EV screen.':'Falls short of the exploratory EV screen.')+'</p></article>';
}

function parlayCard(r,teams,stake) {
  const props=[['Approximate hit chance',percent(r.probability)],['Dependence range',percent(r.dependence.low)+' to '+percent(r.dependence.high)],
    ['Theoretical odds',signed(r.american)+' · '+r.decimal.toFixed(3)],
    ['Break-even at that payout',percent(r.breakEven)],['Scenario EV',valueText(r)],
    ['Stress-case EV',percent(r.evLow)+' to '+percent(r.evHigh)],
    ['EV under dependence bounds',percent(r.dependence.low*r.decimal-1)+' to '+percent(r.dependence.high*r.decimal-1)],
    ['EV splitting stake on legs',percent(r.splitEv)],...returns(r,stake)];
  if(stake>0) props.push(['Expected net as separate straights',dollars(r.splitExpectedProfit)]);
  const title=r.legs.map(l=>label(l.team,teams)).join(' + ');
  const comparison=Math.abs(r.splitEv-r.ev)<1e-8?'Equal estimated EV under independence.':
    r.splitEv>r.ev?'Equal-split straights have higher estimated EV at these inputs.':
      'The parlay has higher estimated EV at the theoretical payout under independence.';
  return '<article class="bet-card"><h4>'+enc(title)+'</h4><p>'+enc(bookName(r.book)+' · Theoretical payout')+
    '</p><p>'+enc(r.legs.map(l=>label(l.team,teams)+' '+percent(l.probability)+' in '+match(l,teams)).join(' · '))+
    '</p>'+facts(props)+'<p>'+enc(comparison)+'</p><p>'+enc('Quote snapshot '+et(r.legs[0].quote.retrieved_at)+' · '+r.legs[0].forecast.version)+'</p>'+
    (r.probability<.15?'<p>Low estimated hit chance. A larger payout comes with frequent losses.</p>':'')+'</article>';
}

async function readJson(path,validate) {
  const r=await fetch(new URL(path,import.meta.url),{cache:'no-store',credentials:'same-origin',
    redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!r.ok) throw new Error('Feed unavailable');
  const value=await r.json();
  if(!validate(value)) throw new Error('Feed validation failed');
  return value;
}

function drawBuilder(rows,teams,book,stake,model) {
  const grouped=new Map();
  for(const row of rows) {
    if(!grouped.has(row.event)) grouped.set(row.event,[]);
    grouped.get(row.event).push(row);
  }
  const builderKey=JSON.stringify([book,model,...rows.map(r=>[r.key,r.probability])]);
  if(builderKey!==state.builderKey) {
    state.builderKey=builderKey;
    byId('builder').innerHTML=!book?message('Select a sportsbook to build a parlay.'):
      !rows.length?message('Eligible forecasts and current odds for this book are unavailable.'):
      [...grouped].map(([event,options])=>'<label class="bet-builder-game">'+enc(match(options[0],teams))+
        '<select data-game="'+enc(event)+'"><option value="">Skip game</option>'+
        options.map(r=>'<option value="'+enc(r.key)+'"'+(state.selected.get(event)===r.key?' selected':'')+'>'+
          enc(label(r.team,teams)+' · '+percent(r.probability))+'</option>').join('')+'</select></label>').join('');
  }
  const selected=rows.filter(r=>state.selected.get(r.event)===r.key);
  byId('winners').disabled=!book||grouped.size<2;
  byId('clear').disabled=state.selected.size===0;
  byId('combination').innerHTML=message('Select at least two eligible games.');
  if(selected.length>=2) {
    try { byId('combination').innerHTML=parlayCard(parlay(selected,stake),teams,stake); }
    catch { byId('combination').innerHTML=message('Choose up to 12 games with no team appearing twice and contemporaneous quotes.'); }
  }
  byId('winners').onclick=()=>{
    state.selected.clear();
    for(const [event,options] of grouped) {
      const favorite=options.find(r=>r.probability>.5);
      if(favorite) state.selected.set(event,favorite.key);
    }
    state.builderKey=null;
    draw();
  };
}

function drawRefresh(now) {
  const last=state.receipt?.last_success;
  const attempt=state.receipt?.attempt;
  const wait=waitingForResult(state.waitingAt,state.receipt,now);
  if(wait==='finished'||wait==='timed_out') {
    state.timedOut=wait==='timed_out';
    state.waitingAt=null;
  }
  const waiting=wait==='waiting';
  const button=byId('refresh');
  button.toggleAttribute('data-waiting',waiting);
  const status=byId('refresh-result');
  let text='Opens the private GitHub workflow for a signed-in refresh.';
  let error=false;
  if(waiting) text='In GitHub, choose Run workflow on main. Waiting for published results…';
  else if(state.timedOut) {text='No new result reached the site. Check the private GitHub run for its status.';error=true;}
  else if(state.resultReadFailed) {text='Could not check for new results. Showing the last validated snapshot, if available.';error=true;}
  else if(attempt?.status==='failed') {text=ERRORS[attempt.reason]+' Attempt finished '+et(attempt.finished_at)+'.';error=true;}
  else if(attempt?.status==='success') text='Latest refresh succeeded.';
  byId('last').textContent=last?'Last successful odds refresh '+et(last.snapshot.captured_at):'No successful odds refresh yet';
  byId('credits').textContent=last?.remaining_credits==null?'API credits unavailable':
    last.remaining_credits.toLocaleString('en-US')+' monthly credits remaining at last refresh';
  if(status.textContent!==text) status.textContent=text;
  status.toggleAttribute('data-error',error);
}

function draw() {
  const now=Date.now();
  const {predictions,receipt}=state;
  const odds=receipt?.last_success?.snapshot;
  const fresh=predictions&&freshness(predictions,new Date(now))==='current';
  const quoteStatus=quoteState(receipt,now);
  drawRefresh(now);
  const teams=new Map((predictions?.teams??[]).map(t=>[t.id,t]));
  const notice=byId('status');
  let unavailable='';
  if(!state.attempted) unavailable='Checking published picks…';
  else if (!fresh) unavailable='Current V1 and PA3 forecast data unavailable.';
  else if (quoteStatus==='unavailable') unavailable='Sportsbook odds unavailable. Use Refresh Picks to request them.';
  else if (quoteStatus==='no_markets') unavailable='The last refresh found no eligible sportsbook markets.';
  else if (quoteStatus==='stale') unavailable='Picks are stale. Refresh odds to run a current analysis.';
  const input=byId('stake');
  const stake=input.validity.valid?Number(input.value)||0:0;
  const model=byId('model').value;
  const all=unavailable?[]:straightBets(predictions,odds,model,stake,now);
  const books=unavailable?[]:[...new Set(odds.quotes.map(q=>q.book))].sort();
  const bookSelect=byId('book');
  const chosen=bookSelect.value;
  if(books.join(',')!==bookSelect.dataset.books) {
    bookSelect.innerHTML='<option value="">All books</option>'+books.map(b=>'<option value="'+enc(b)+'">'+enc(bookName(b))+'</option>').join('');
    bookSelect.value=books.includes(chosen)?chosen:'';
    bookSelect.dataset.books=books.join(',');
  }
  const book=bookSelect.value;
  const rows=book?all.filter(r=>r.book===book):all;
  const missing=fresh?predictions.games.filter(g=>g.status==='scheduled'&&time(g.tip_at_utc)>now&&
    !rows.some(r=>r.event===g.id)).length:0;
  notice.textContent=unavailable||('Picks are current. Quotes expire after five minutes.'+
    (missing?' '+missing+' upcoming games lack an eligible forecast or current quote for this selection.':''));
  notice.toggleAttribute('data-warning',!!unavailable);
  byId('value').textContent=rows.length
    ? (rows.some(r=>r.pass)?'Some estimates pass the stress screen. Prospective profitability remains unverified.':'No positive-value bets found under the stress screen.'):'';
  const sort=byId('sort').value;
  const straight=rank(rows,sort);
  const cards=straight.map(r=>straightCard(r,teams,stake));
  byId('straights').innerHTML=cards.length?'<div class="bet-list">'+cards.slice(0,8).join('')+'</div>'+
    (cards.length>8?'<details><summary>Show all '+cards.length+' priced sides</summary><div class="bet-list">'+cards.slice(8).join('')+'</div></details>':''):
    message('No eligible straight bets to compare.');
  const combo=rank(combinations(rows,Number(byId('legs').value),stake,byId('filter').value),sort).slice(0,6);
  byId('parlays').innerHTML=combo.length?'<div class="bet-list">'+combo.map(r=>parlayCard(r,teams,stake)).join('')+'</div>':
    message('No eligible combinations to compare.');
  drawBuilder(book?rows:[],teams,book,stake,model);
}

async function readPublishedResults() {
  if (state.busy||location.hash!=='#betting'||document.hidden) return;
  state.busy=true;
  const [predictions,result]=await Promise.allSettled([
    readJson('./data/predictions.json',validateFeed),readJson('./'+RECEIPT_FILE,validReceipt)]);
  state.predictions=predictions.status==='fulfilled'?predictions.value:null;
  state.resultReadFailed=result.status!=='fulfilled';
  if(result.status==='fulfilled') {
    const old=time(state.receipt?.attempt?.finished_at);
    const next=time(result.value.attempt?.finished_at);
    if(!Number.isFinite(old)||Number.isFinite(next)&&next>=old) state.receipt=result.value;
  }
  state.busy=false;
  state.attempted=true;
  draw();
}

for(const id of ['model','book','sort','legs','filter','stake']) byId(id).addEventListener('change',()=>{
  if(id==='book') state.selected.clear();
  draw();
});
byId('builder').addEventListener('change',event=>{
  const id=event.target.dataset.game;
  if (!id) return;
  if (event.target.value) state.selected.set(id,event.target.value);
  else state.selected.delete(id);
  draw();
});
byId('clear').addEventListener('click',()=>{state.selected.clear();state.builderKey=null;draw();});
byId('refresh').href=WORKFLOW_URL;
byId('refresh').addEventListener('click',event=>{
  const now=Date.now();
  if(now-state.lastOpened<10_000) {event.preventDefault();return;}
  state.lastOpened=now;
  state.waitingAt??=now;
  state.timedOut=false;
  draw();
  readPublishedResults();
});
window.addEventListener('hashchange',readPublishedResults);
document.addEventListener('visibilitychange',readPublishedResults);
// These intervals only read the previously published same-origin files and age them out.
setInterval(()=>{
  if(state.waitingAt!==null) readPublishedResults();
  else if(location.hash==='#betting'&&!document.hidden) draw();
},15_000);
readPublishedResults();
