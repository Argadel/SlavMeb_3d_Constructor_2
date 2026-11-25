// A neutral satin aluminium finish, not a photograph of a lit metal sheet.
// The small-scale vertical grain is periodic and contains no baked reflections.
export const ALUMINUM_TILE = Object.freeze({width:512,height:256,widthM:.24,heightM:.48});
export function makeAluminumGrain(){
  const {width:w,height:h}=ALUMINUM_TILE;
  let seed=0x5c1a71;
  const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const columns=Array.from({length:w},()=>({grain:(rand()-.5)*10,phase:rand()*Math.PI*2,amp:rand()*2.5,frequency:1+Math.floor(rand()*3)}));
  const color=new Uint8Array(w*h*4),roughness=new Uint8Array(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const c=columns[x];
    const fine=c.grain+c.amp*Math.sin(2*Math.PI*y/h*c.frequency+c.phase)+(rand()-.5)*3;
    const grey=Math.round(153+fine),r=Math.round(101+fine*1.6);
    const i=(y*w+x)*4;
    color.set([grey,grey+1,grey+2,255],i);
    roughness.set([r,r,r,255],i);
  }
  return {color,roughness};
}
// BoxGeometry uses X/Y on its front/back, Z/Y on its sides, X/Z on top/bottom.
// Per-face UVs keep the grain scale consistent even when one material is shared
// by multiple doors of different heights (e.g. an oven cabinet).
export function aluminumFaceScale(face,w,h,d){
  const u=face<2?d:w,v=face===2||face===3?d:h;
  return [u/ALUMINUM_TILE.widthM,v/ALUMINUM_TILE.heightM];
}
