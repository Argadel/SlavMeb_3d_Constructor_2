// Real dimensions in the wall's horizontal coordinate and world height (metres).
// Each width belongs to a particular catalogue SKU; adjacent cabinets of equal
// height/elevation share a vertical measurement, as on a dimensioned elevation.
export function wallPoint(wallId,p,room){
  const W=room.width/2000,D=room.depth/2000,offset=.008;
  switch(wallId){
    case 'north':return [p.u,p.y,-D+offset];
    case 'south':return [p.u,p.y,D-offset];
    case 'west':return [-W+offset,p.y,p.u];
    case 'east':return [W-offset,p.y,p.u];
    default:return [p.u,p.y,-D+offset];
  }
}
export function layoutModuleDimensions(items,room,getModule,worktopThickness=38){
  const dimensions=[];
  const point=(u,y)=>({u,y});
  const near=(a,b)=>Math.abs(a-b)<.0001;
  for(const wallId of ['north','east','south','west']){
    const wallHalf=(wallId==='north'||wallId==='south'?room.width:room.depth)/2000;
    const blocks=items.filter(i=>i.wallId===wallId).map(i=>{
      const m=getModule(i.moduleId,i);if(!m)return null;
      const height=m.height+(m.category==='lower'&&m.worktop!==false?worktopThickness:0);
      const bottom=(i.elevation||0)/1000;
      return {id:i.uid,left:i.coord-m.width/2000,right:i.coord+m.width/2000,bottom,top:bottom+height/1000,height,width:m.width};
    }).filter(Boolean).sort((a,b)=>a.left-b.left||a.bottom-b.bottom);
    // Draw nominal widths for every cabinet (not decorative worktop overhangs).
    for(const b of blocks){
      const y=b.top+.075;
      dimensions.push({wallId,kind:'width',ids:[b.id],value:b.width,a:point(b.left,y),b:point(b.right,y),outside:point((b.left+b.right)/2,y+.07),extensions:[[point(b.left,b.top+.007),point(b.left,y+.012)],[point(b.right,b.top+.007),point(b.right,y+.012)]]});
    }
    const groups=[];
    for(const b of blocks){
      const row=groups.find(g=>near(g.bottom,b.bottom)&&near(g.top,b.top)&&b.left<=g.right+.025&&b.left>=g.right-.001);
      if(row){row.right=Math.max(row.right,b.right);row.ids.push(b.id);}
      else groups.push({...b,ids:[b.id]});
    }
    // Use the freer outer side of a row. If the run fills the wall, move its
    // dimension just inside the edge instead of drawing through a corner.
    for(const g of groups){
      let leftGap=Math.max(0,g.left+wallHalf),rightGap=Math.max(0,wallHalf-g.right);
      for(const b of blocks){
        if(g.ids.includes(b.id)||b.top<=g.bottom+.001||b.bottom>=g.top-.001)continue;
        if(b.right<=g.left+.001)leftGap=Math.min(leftGap,Math.max(0,g.left-b.right));
        if(b.left>=g.right-.001)rightGap=Math.min(rightGap,Math.max(0,b.left-g.right));
      }
      const useLeft=leftGap>=.095||leftGap>=rightGap;
      const edge=useLeft?g.left:g.right,sign=useLeft?-1:1,gap=useLeft?leftGap:rightGap;
      const u=gap>=.035?edge+sign*Math.min(.075,gap*.65):edge-sign*.045;
      const outsideSign=u===edge?sign:Math.sign(u-edge);
      dimensions.push({wallId,kind:'height',ids:g.ids,value:g.height,a:point(u,g.bottom),b:point(u,g.top),outside:point(u+outsideSign*.07,(g.bottom+g.top)/2),extensions:[[point(edge,g.bottom),point(u+outsideSign*.012,g.bottom)],[point(edge,g.top),point(u+outsideSign*.012,g.top)]]});
    }
  }
  return dimensions;
}
