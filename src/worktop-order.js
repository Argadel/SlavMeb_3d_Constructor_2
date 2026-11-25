import { WORKTOP_STOCK_PRICES } from '../data/worktop-prices.js';
const WALLS=['north','east','south','west'];
// Use actual worktop spans (metres), including exposed side overhangs.
// As in the existing backsplash layout, a seam up to 3 mm is treated as a row.
export function layoutWorktopRuns(items,room,getModule,getSpan){
  const runs=[];
  for(const wallId of WALLS){
    const half=(wallId==='north'||wallId==='south'?room.width:room.depth)/2000;
    const pieces=items.filter(i=>i.wallId===wallId).flatMap(i=>{
      const m=getModule(i.moduleId,i);
      if(!m||m.category!=='lower'||m.worktop===false)return [];
      const span=getSpan(i,m),sign=(wallId==='south'||wallId==='west')?-1:1;
      const center=i.coord+sign*span.offsetX;
      const left=Math.max(-half,center-span.width/2),right=Math.min(half,center+span.width/2);
      return right>left+1e-8?[{wallId,left,right,level:m.height+(i.elevation||0)}]:[];
    }).sort((a,b)=>a.level-b.level||a.left-b.left);
    for(const p of pieces){
      const last=runs.at(-1);
      if(last&&last.wallId===p.wallId&&last.level===p.level&&p.left<=last.right+.003+1e-8){
        if(p.right>last.right+1e-8){last.joints.push((last.right+p.left)/2);last.right=p.right;}
      }else runs.push({...p,joints:[]});
    }
  }
  return runs.map(r=>{
    const length=Math.ceil((r.right-r.left)*1000-1e-6);
    const joints=[...new Set(r.joints.map(x=>Math.round((x-r.left)*1000)))].filter(x=>x>0&&x<length).sort((a,b)=>a-b);
    return {...r,length,joints};
  });
}
// All lengths in mm. A full-length part needs no crosscut. Otherwise reserve
// 4 mm between pieces; a final trim may run off the stock edge.
// An exact full-length piece needs no cut.
export const WORKTOP_KERF_MM=4;
const SEARCH_LIMIT=8000;
function canFit(stock,used,length,n){
  const end=used+(n?WORKTOP_KERF_MM:0)+length;
  return end<=stock;
}
function remainder(bin){return Math.max(0,bin.stock-bin.used-WORKTOP_KERF_MM);}
function cuts(bin){return bin.parts.length-(bin.used===bin.stock?1:0);}
function objective(bins,partCount,offJoint){return [bins.reduce((s,b)=>s+b.price,0),partCount,offJoint,bins.length,bins.reduce((s,b)=>s+remainder(b),0)];}
function better(a,b){for(let i=0;i<a.length;i++){if(a[i]!==b[i])return a[i]<b[i];}return false;}
export function calculateWorktopOrder(runs,prices=WORKTOP_STOCK_PRICES){
  const stocks=[...prices].sort((a,b)=>a.length-b.length);
  const max=stocks.at(-1).length;
  // Intact short runs are mandatory. Longer runs may need a joint; prefer
  // cabinet boundaries when the price and number of joints are equal.
  const details=runs.map((r,i)=>({...r,id:i+1,length:Math.max(0,Math.ceil(r.length))})).filter(r=>r.length>0);
  const tasks=[...details].sort((a,b)=>Number(a.length>max)-Number(b.length>max)||b.length-a.length||a.id-b.id);
  for(const r of tasks)r.ends=[...new Set([...(r.joints||[]).filter(x=>Number.isInteger(x)&&x>0&&x<r.length),r.length])].sort((a,b)=>a-b);
  const makePart=(r,start,end)=>({runId:r.id,start,end,length:end-start,nonStandardJoint:end<r.length&&!r.ends.includes(end)});
  const bins=[];let partCount=0,offJoint=0,best=null,bestScore=null,nodes=0,limited=false;
  const snapshot=()=>{const score=objective(bins,partCount,offJoint);if(!bestScore||better(score,bestScore)){bestScore=score;best=bins.map(b=>({...b,parts:b.parts.map(p=>({...p}))}));}};
  const add=(bin,part)=>{const old=bin.used;bin.used+=part.length+(bin.parts.length?WORKTOP_KERF_MM:0);bin.parts.push(part);partCount++;offJoint+=Number(part.nonStandardJoint);return old;};
  const undo=(bin,old)=>{const p=bin.parts.pop();bin.used=old;partCount--;offJoint-=Number(p.nonStandardJoint);};
  const fresh=s=>({stock:s.length,price:s.price,used:0,parts:[]});
  // Valid baseline: cheapest stock combination for each individual run,
  // even if the joint is not at a cabinet boundary. Never require the user
  // to pay more solely because of the new cross-run optimizer.
  for(const r of tasks){
    const [a,b]=stocks;let choice=null;
    for(let n=0;n<=Math.ceil(r.length/a.length);n++){
      const k=Math.max(0,Math.ceil((r.length-n*a.length)/b.length));
      const score=[n*a.price+k*b.price,n+k,n*a.length+k*b.length];
      if(!choice||better(score,choice.score))choice={score,stock:[...Array(n).fill(a),...Array(k).fill(b)]};
    }
    // Do not split a run that fits one blank.
    if(r.length<=max)choice={stock:[stocks.filter(s=>s.length>=r.length).sort((a,b)=>a.price-b.price||a.length-b.length)[0]]};
    let start=0;
    for(const [i,s] of choice.stock.entries()){
      if(start===r.length)break;
      const after=choice.stock.slice(i+1).reduce((sum,p)=>sum+p.length,0);
      const lo=Math.max(start+1,r.length-after),hi=Math.min(r.length,start+s.length);
      const remainingPieces=choice.stock.length-i;
      const balanced=Math.max(lo,Math.min(hi,start+Math.ceil((r.length-start)/remainingPieces)));
      const near=r.ends.filter(e=>e>=lo&&e<=hi&&(e===r.length||r.length-e>=Math.max(1,remainingPieces-1))).sort((a,b)=>Math.abs(a-balanced)-Math.abs(b-balanced));
      const end=near[0]??balanced;
      const part=makePart(r,start,end);const bin=fresh(s);bins.push(bin);add(bin,part);start=end;
    }
    if(start!==r.length)throw Error('Incomplete worktop baseline');
  }
  snapshot();bins.length=0;partCount=0;offJoint=0;
  // Greedy reuse plan gives the search another inexpensive starting point.
  for(const r of tasks){let start=0;while(start<r.length){
    const remaining=r.length-start;
    const candidates=bins.map(b=>({b,cap:b.stock-b.used-WORKTOP_KERF_MM})).filter(x=>x.cap>=remaining).sort((a,b)=>a.cap-b.cap);
    let bin=candidates[0]?.b;
    if(!bin){const s=stocks.filter(s=>s.length>=Math.min(remaining,max)).sort((a,b)=>a.price-b.price||a.length-b.length)[0];bin=fresh(s);bins.push(bin);}
    const cap=bin.stock-bin.used-(bin.parts.length?WORKTOP_KERF_MM:0);
    const end=Math.min(r.length,start+cap);add(bin,makePart(r,start,end));start=end;
  }}
  snapshot();bins.length=0;partCount=0;offJoint=0;
  function candidateEnds(r,start,cap){
    const remaining=r.length-start;
    if(remaining<=cap)return [r.length];
    if(r.length<=max||cap<=0)return [];
    const hi=start+cap;
    const candidates=[...r.ends.filter(e=>e>start&&e<=hi),hi];
    // Candidate lengths also include balanced cuts and lengths leaving an
    // exact stock-sized remainder. This is a bounded heuristic for long runs.
    for(const s of stocks){
      for(let n=1;n<=Math.ceil(remaining/s.length);n++){
        const e=r.length-n*s.length;if(e>start&&e<=hi)candidates.push(e);
      }
      const n=Math.ceil(remaining/s.length);const e=start+Math.ceil(remaining/n);if(e<=hi)candidates.push(e);
    }
    return [...new Set(candidates)].sort((a,b)=>Number(!r.ends.includes(a))-Number(!r.ends.includes(b))||b-a);
  }
  const suffix=Array(tasks.length+1).fill(0);for(let i=tasks.length-1;i>=0;i--)suffix[i]=suffix[i+1]+tasks[i].length;
  const unit=Math.min(...stocks.map(s=>s.price/s.length));
  const memo=new Map();
  function search(i,start,cost){
    if(++nodes>SEARCH_LIMIT){limited=true;return;}
    if(i===tasks.length){snapshot();return;}
    const remaining=suffix[i]-start;
    // Optimistic lower bound: ignore kerf and the indivisibility of pieces.
    const free=bins.reduce((s,b)=>s+b.stock-b.used,0);
    const lowerCost=cost+Math.max(0,remaining-free)*unit;
    if(lowerCost>bestScore[0]+1e-6)return;
    if(lowerCost>=bestScore[0]-1e-6&&partCount+Math.ceil((tasks[i].length-start)/max)+(tasks.length-i-1)>bestScore[1])return;
    const key=`${i}:${start}:${bins.map(b=>`${b.stock}/${b.price}/${b.used}`).sort().join(',')}`;
    const seen=memo.get(key);if(seen&&(seen[0]<partCount||(seen[0]===partCount&&seen[1]<=offJoint)))return;memo.set(key,[partCount,offJoint]);
    const r=tasks[i];
    const tried=new Set();
    for(const b of bins){
      const k=`${b.stock}/${b.price}/${b.used}`;
      if(tried.has(k))continue;tried.add(k);
      for(const end of candidateEnds(r,start,b.stock-b.used-WORKTOP_KERF_MM)){
        const part=makePart(r,start,end),nextI=end===r.length?i+1:i,nextStart=end===r.length?0:end;
        if(!canFit(b.stock,b.used,part.length,b.parts.length))continue;
        const old=add(b,part);search(nextI,nextStart,cost);undo(b,old);if(limited)return;
      }
    }
    for(const s of stocks){
      if(cost+s.price>bestScore[0])continue;
      for(const end of candidateEnds(r,start,s.length)){
        const part=makePart(r,start,end),nextI=end===r.length?i+1:i,nextStart=end===r.length?0:end;
        const b=fresh(s);bins.push(b);add(b,part);search(nextI,nextStart,cost+s.price);undo(b,0);bins.pop();if(limited)return;
      }
    }
  }
  search(0,0,0);
  const blanks=best.map((b,i)=>({id:i+1,length:b.stock,price:b.price,parts:b.parts,cuts:cuts(b),kerf:b.stock-b.parts.reduce((s,p)=>s+p.length,0)-remainder(b),waste:remainder(b)}));
  const lines=stocks.map(s=>({...s,quantity:blanks.filter(b=>b.length===s.length).length})).filter(s=>s.quantity).map(s=>({...s,cost:s.quantity*s.price}));
  return {runs:details.map(({ends,...r})=>r),blanks,lines,length:details.reduce((s,r)=>s+r.length,0),stockLength:blanks.reduce((s,b)=>s+b.length,0),cost:bestScore[0],kerf:blanks.reduce((s,b)=>s+b.kerf,0),waste:blanks.reduce((s,b)=>s+b.waste,0),seams:bestScore[1]-details.length,nonStandardJoints:bestScore[2],optimal:!limited&&tasks.every(r=>r.length<=max)};
}
