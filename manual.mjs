import {MAX_AGE,time,validOdds} from './value.mjs';

export const WORKFLOW_URL='https://github.com/ComixDesignner/nba-prediction-engine/actions/workflows/nba-betting-refresh.yml';
export const RECEIPT_FILE='data/betting-refresh-v1.json';
export const VERSION='nba-betting-refresh/v1';
export const WAIT_MS=10*60_000;
export const ERRORS=Object.freeze({
  provider_unavailable:'The sportsbook provider did not return a usable response.',
  forecast_unavailable:'The latest forecast feed did not pass validation.'
});
const keys=(x,list)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===list.length&&
  list.every(k=>Object.hasOwn(x,k));

export const idleReceipt=()=>({version:VERSION,attempt:null,last_success:null});
export function validReceipt(receipt) {
  if (!keys(receipt,['version','attempt','last_success'])||receipt.version!==VERSION) return false;
  const {attempt,last_success:last}=receipt;
  if(attempt===null) return last===null;
  if(!keys(attempt,['finished_at','status','reason'])||!Number.isFinite(time(attempt.finished_at))) return false;
  if(last!==null&&(!keys(last,['snapshot','remaining_credits'])||!validOdds(last.snapshot)||
      last.snapshot.status==='unavailable'||time(last.snapshot.captured_at)>time(attempt.finished_at)||
      !(last.remaining_credits===null||Number.isSafeInteger(last.remaining_credits)&&
        last.remaining_credits>=0&&last.remaining_credits<=1e10))) return false;
  if(attempt.status==='success') return attempt.reason===null&&last!==null;
  return attempt.status==='failed'&&Object.hasOwn(ERRORS,attempt.reason);
}

export function quoteState(receipt,now) {
  const snapshot=receipt?.last_success?.snapshot;
  if(!snapshot) return 'unavailable';
  const age=now-time(snapshot.captured_at);
  if(age<0||age>MAX_AGE) return 'stale';
  if(snapshot.status==='no_markets') return 'no_markets';
  return snapshot.quotes.some(q=>now>=time(q.retrieved_at)&&now-time(q.updated_at)<=MAX_AGE&&now<time(q.tip_at))
    ? 'current':'stale';
}

export function waitingForResult(pendingAt,receipt,now) {
  if(pendingAt===null) return null;
  if(time(receipt?.attempt?.finished_at)>=pendingAt) return 'finished';
  return now-pendingAt>=WAIT_MS?'timed_out':'waiting';
}
