export function calculateDiscount(furniture,worktop,promo,modules=[]){
  const base=furniture+worktop;
  const rate=promo?.active?Math.min(100,Math.max(0,Number(promo.percent)||0)):0;
  const eligible=promo?.target==='furniture'?furniture:promo?.target==='worktop'?worktop:promo?.target==='category'?modules.filter(m=>m.category===promo.scope).reduce((s,m)=>s+m.price,0):promo?.target==='article'?modules.filter(m=>m.id===promo.scope).reduce((s,m)=>s+m.price,0):base;
  const saving=Math.round(eligible*rate/100);
  return {base,saving,total:base-saving};
}

// ISO dates are calendar dates, not timestamps: avoid timezone shifts.
export function formatPromoPeriod(promo){
  if(!promo?.active)return '';
  const display=value=>{
    const match=typeof value==='string'&&/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return match?`${match[3]}.${match[2]}.${match[1]}`:'';
  };
  const start=display(promo.start), end=display(promo.end);
  if(start&&end)return `С ${start} по ${end}`;
  if(start)return `С ${start}`;
  if(end)return `До ${end}`;
  return '';
}
