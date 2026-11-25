// Planning objects, never saleable SKUs. Sizes include the doors and controls.
export const APPLIANCES = [
  {id:'appliance-stove',name:'Кухонная плита',width:600,depth:600,height:850,kind:'stove'},
  {id:'appliance-fridge',name:'Холодильник',width:600,depth:650,height:1850,kind:'fridge'}
].map(a=>({...a,category:'appliances',family:a.id,sku:a.name,wallMount:'floor',worktop:false,isAppliance:true,price:0,sideGap:0,backGap:0,topGap:0}));
export const APPLIANCE_FIELDS=['width','depth','height','sideGap','backGap','topGap'];
export function applianceLimits(m){return {width:[300,m.kind==='stove'?1200:1500],depth:[300,1000],height:m.kind==='stove'?[500,1200]:[400,2500],sideGap:[0,300],backGap:[0,300],topGap:[0,300]};}
export function normalizeAppliance(m,values={}){
  const out={};const limits=applianceLimits(m);
  for(const k of APPLIANCE_FIELDS){const v=values?.[k];const n=v!==''&&v!==null&&v!==undefined&&Number.isFinite(Number(v))?Math.round(Number(v)):m[k];out[k]=Math.max(limits[k][0],Math.min(limits[k][1],n));}
  return out;
}
export const placementWidthMM=m=>m.width+(m.isAppliance?2*m.sideGap:0);
export const placementHeightMM=m=>m.height+(m.isAppliance?m.topGap:0);
export function fitsRoom(m,room,wallId){
  const along=wallId==='north'||wallId==='south'?room.width:room.depth;
  const across=wallId==='north'||wallId==='south'?room.depth:room.width;
  return placementWidthMM(m)<=along&&placementHeightMM(m)<=room.height&&m.depth+(m.backGap||0)<=across;
}
