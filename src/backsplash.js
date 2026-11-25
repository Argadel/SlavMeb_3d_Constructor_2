// Geometry in metres, in the same wall coordinates as module placement.
export const PANEL_THICKNESS_MM=6;
export const DEFAULT_PANEL_HEIGHT=600;
export function normalizePanelHeight(value){
  const n=Number(value);
  return Number.isFinite(n)&&n>0?Math.max(50,Math.min(1200,Math.round(n))):DEFAULT_PANEL_HEIGHT;
}
const WALLS=['north','east','south','west'];
const EPS=1e-6;
export function layoutBacksplash(items,room,getModule,getSpan,height=600,topThickness=38,includeStove=false){
  const runs=[];
  for(const wallId of WALLS){
    const half=(wallId==='north'||wallId==='south'?room.width:room.depth)/2000;
    const pieces=items.filter(i=>i.wallId===wallId).flatMap(i=>{
      const m=getModule(i.moduleId,i);
      if(!m||m.category!=='lower'||m.worktop===false)return [];
      const span=getSpan(i,m),sign=wallId==='south'||wallId==='west'?-1:1;
      const center=i.coord+sign*span.offsetX;
      const bottom=(m.height+(i.elevation||0)+topThickness)/1000;
      const top=Math.min(room.height/1000,bottom+normalizePanelHeight(height)/1000);
      const left=Math.max(-half,center-span.width/2),right=Math.min(half,center+span.width/2);
      return right-left>EPS&&top-bottom>EPS?[{wallId,left,right,bottom,top}]:[];
    });
    if(includeStove){
      const worktops=[...pieces];
      for(const i of items.filter(i=>i.wallId===wallId)){
        const m=getModule(i.moduleId,i);
        if(!m?.isAppliance||m.kind!=='stove')continue;
        // Cover the reserved stove installation zone, including user-set side gaps.
        const halfWidth=(m.width+2*(m.sideGap||0))/2000;
        const left=Math.max(-half,i.coord-halfWidth),right=Math.min(half,i.coord+halfWidth);
        const bottom=(m.height+(i.elevation||0))/1000;
        const adjacent=worktops.filter(p=>Math.abs(p.right-left)<=.02||Math.abs(p.left-right)<=.02)
          .sort((a,b)=>Math.abs(a.bottom-bottom)-Math.abs(b.bottom-bottom));
        const neighbor=adjacent[0];
        const top=Math.min(room.height/1000,neighbor&&neighbor.top>bottom+EPS?neighbor.top:bottom+normalizePanelHeight(height)/1000);
        // During an invalid drag the appliance may overlap a worktop. Do not
        // draw coplanar panels over that worktop; retain only the free intervals.
        let free=[[left,right]];
        for(const p of pieces){
          free=free.flatMap(([l,r])=>p.right<=l+EPS||p.left>=r-EPS?[[l,r]]:[[l,Math.min(r,p.left)],[Math.max(l,p.right),r]].filter(([a,b])=>b-a>EPS));
        }
        if(top-bottom>EPS)for(const [l,r] of free)if(r-l>EPS)pieces.push({wallId,left:l,right:r,bottom,top});
      }
    }
    pieces.sort((a,b)=>a.bottom-b.bottom||a.top-b.top||a.left-b.left);
    for(const p of pieces){
      const last=runs[runs.length-1];
      // A 2 mm seam can arise between two worktops due to the initial 20 mm
      // placement gap and two 9 mm overhangs; do not bridge larger free gaps.
      if(last&&last.wallId===wallId&&Math.abs(last.bottom-p.bottom)<EPS&&Math.abs(last.top-p.top)<EPS&&p.left<=last.right+.003){
        last.right=Math.max(last.right,p.right);
      }else runs.push({...p});
    }
  }
  // Butt joints: north/south run to the corner, east/west stop 6 mm short
  // where a perpendicular panel actually occupies that same corner.
  const W=room.width/2000,D=room.depth/2000,t=PANEL_THICKNESS_MM/1000;
  for(const r of runs){
    if(r.wallId!=='east'&&r.wallId!=='west')continue;
    const atX=r.wallId==='east'?W:-W;
    const meets=(wall)=>runs.some(p=>p.wallId===wall&&p.left<=atX+EPS&&p.right>=atX-EPS&&Math.abs(p.bottom-r.bottom)<EPS&&Math.abs(p.top-r.top)<EPS);
    if(r.left<=-D+EPS&&meets('north'))r.left=Math.max(r.left,-D+t);
    if(r.right>=D-EPS&&meets('south'))r.right=Math.min(r.right,D-t);
  }
  const result=runs.filter(r=>r.right-r.left>EPS).map(r=>({...r,width:r.right-r.left,height:r.top-r.bottom,coord:(r.left+r.right)/2}));
  // When panel pieces have different bottom heights, use a common physical UV
  // origin for adjacent pieces to keep the decor continuous across the stove.
  if(includeStove){
    const remaining=new Set(result);
    while(remaining.size){
      const first=remaining.values().next().value,group=[first];remaining.delete(first);
      for(let j=0;j<group.length;j++){
        const a=group[j];
        for(const b of remaining){
          if(a.wallId===b.wallId&&a.left<=b.right+.003&&b.left<=a.right+.003&&a.bottom<=b.top+EPS&&b.bottom<=a.top+EPS){group.push(b);remaining.delete(b);}
        }
      }
      if(group.length<2)continue;
      const min=Math.min(...group.map(r=>r.left)),max=Math.max(...group.map(r=>r.right)),bottom=Math.min(...group.map(r=>r.bottom));
      for(const r of group){
        const reverse=r.wallId==='south'||r.wallId==='west';
        // UV +X follows the mesh's local X, reversed on south/west walls.
        r.textureAnchor={x:reverse?max-r.right:r.left-min,y:r.bottom-bottom,width:max-min};
      }
    }
  }
  return result;
}
// Direction of the structure, not the aspect ratio of the image. Vertical
// stripes have greater variation across x than across y. Sampling at several
// pixel distances is more robust to JPEG noise and fine-grain detail.
export function hasVerticalGrain(pixels,w,h){
  const lum=(x,y)=>{const i=(y*w+x)*4;return .299*pixels[i]+.587*pixels[i+1]+.114*pixels[i+2];};
  let gx=0,gy=0;
  for(const step of [1,3,5]){
    for(let y=step;y<h-step;y+=2)for(let x=step;x<w-step;x+=2){
      gx+=Math.abs(lum(x+step,y)-lum(x-step,y));
      gy+=Math.abs(lum(x,y+step)-lum(x,y-step));
    }
  }
  return gx>gy*1.18&&gx>0;
}
export function panelTextureTransform(width,height,iw,ih,physicalHeight,rotate,offset=[0,0],anchor=null){
  const ph=physicalHeight||1,pw=ph*((iw>0&&ih>0)?iw/ih:1);
  const sx=rotate?height/pw:width/pw,sy=rotate?width/ph:height/ph;
  const x=anchor?.x||0,y=anchor?.y||0,total=anchor?.width||width;
  return {sx,sy,rotation:rotate?Math.PI/2:0,
    ox:(offset[0]||0)+(rotate?y/pw:x/pw),
    oy:(offset[1]||0)+(rotate?(total-x)/ph:y/ph)};
}
