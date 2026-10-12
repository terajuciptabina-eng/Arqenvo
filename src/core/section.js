/** Section extraction helpers for orthographic building sections.
 * Coordinates in metres; output is derived data and never mutates the model.
 */
const finitePoint=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y);
const cross=(a,b)=>a.x*b.y-a.y*b.x;
const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
const dot=(a,b)=>a.x*b.x+a.y*b.y;
const distance=(a,b)=>Math.hypot(b.x-a.x,b.y-a.y);
function intersectSegment(a,b,c,d,epsilon=1e-8){
  const r=sub(b,a),s=sub(d,c),den=cross(r,s),q=sub(c,a);
  if(Math.abs(den)<=epsilon)return null;
  const t=cross(q,s)/den,u=cross(q,r)/den;
  if(t < -epsilon||t>1+epsilon||u < -epsilon||u>1+epsilon)return null;
  return {t:Math.max(0,Math.min(1,t)),u:Math.max(0,Math.min(1,u))};
}
function wallFootprint(w){
  const dx=w.end.x-w.start.x,dy=w.end.y-w.start.y,len=Math.hypot(dx,dy);
  if(len<=1e-8||!(w.thickness>0))return [];
  const nx=-dy/len*w.thickness/2,ny=dx/len*w.thickness/2;
  return [{x:w.start.x+nx,y:w.start.y+ny},{x:w.end.x+nx,y:w.end.y+ny},{x:w.end.x-nx,y:w.end.y-ny},{x:w.start.x-nx,y:w.start.y-ny}];
}
function polygonIntersections(a,b,poly){
  const hits=[];
  for(let i=0;i<poly.length;i++){
    const hit=intersectSegment(a,b,poly[i],poly[(i+1)%poly.length]);
    if(hit)hits.push(hit.t);
  }
  return [...new Set(hits.map(t=>Number(t.toFixed(8))))].sort((x,y)=>x-y);
}
function insidePolygon(p,poly){
  let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const a=poly[i],b=poly[j];
    if(((a.y>p.y)!==(b.y>p.y))&&p.x<(b.x-a.x)* (p.y-a.y)/((b.y-a.y)||Number.EPSILON)+a.x)inside=!inside;
  }
  return inside;
}
/** Intersect a vertical section plane with supported model elements.
 * The section line is horizontal in plan; returned stations are distances along it.
 */
export function extractSection(project,{start,end,storyId=null,tolerance=0.01}={}){
  if(!finitePoint(start)||!finitePoint(end)||distance(start,end)<=1e-8)throw new TypeError("Section requires distinct finite start and end points");
  if(!(tolerance>0))throw new RangeError("Section tolerance must be positive");
  const length=distance(start,end),direction={x:(end.x-start.x)/length,y:(end.y-start.y)/length};
  const at=t=>({x:start.x+(end.x-start.x)*t,y:start.y+(end.y-start.y)*t});
  const results=[];
  for(const el of project?.elements??[]){
    if(storyId&&el.storyId!==storyId)continue;
    const story=project.stories?.find(s=>s.id===el.storyId),base=story?.elevation??0;
    if(el.type==="wall"){
      const footprint=wallFootprint(el);if(!footprint.length)continue;
      const cuts=polygonIntersections(start,end,footprint);
      for(let i=0;i<cuts.length-1;i++){
        const lo=cuts[i],hi=cuts[i+1];if((hi-lo)*length<tolerance)continue;
        const mid=at((lo+hi)/2);if(!insidePolygon(mid,footprint))continue;
        const from=lo*length,to=hi*length,z0=base+(el.baseOffset||0);
        const openings=(el.openings||[]).filter(o=>{const center=(o.offset+o.width/2);const wallLen=distance(el.start,el.end);if(!wallLen)return false;const wx=el.start.x+(el.end.x-el.start.x)*center/wallLen,wy=el.start.y+(el.end.y-el.start.y)*center/wallLen;return distance(mid,{x:wx,y:wy})<=el.thickness/2+tolerance&&o.offset<wallLen&&o.offset+o.width>0});
        const solids=[];let z=0;
        const holes=openings.map(o=>[Math.max(0,o.sill||0),Math.min(el.height,(o.sill||0)+o.height)]).filter(v=>v[1]>v[0]).sort((a,b)=>a[0]-b[0]);
        for(const hole of holes){const last=solids[solids.length-1];if(last&&hole[0]<=last[1])last[1]=Math.max(last[1],hole[1]);else if(hole[0]>z)solids.push([z,hole[0]]);z=Math.max(z,hole[1])}
        if(z<el.height)solids.push([z,el.height]);
        for(const [bottom,top] of solids)results.push({elementId:el.id,type:"wall",stationStart:from,stationEnd:to,elevationStart:z0+bottom,elevationEnd:z0+top,material:el.buildingMaterial||""});
      }
    }else if(el.type==="slab"){
      const poly=el.boundary||[],cuts=polygonIntersections(start,end,poly);
      for(let i=0;i<cuts.length-1;i++){const lo=cuts[i],hi=cuts[i+1];if((hi-lo)*length<tolerance)continue;if(insidePolygon(at((lo+hi)/2),poly))results.push({elementId:el.id,type:"slab",stationStart:lo*length,stationEnd:hi*length,elevationStart:base+(el.elevation||0),elevationEnd:base+(el.elevation||0)+(el.thickness||0),material:el.buildingMaterial||""})}
    }else if(el.type==="column"){
      const angle=el.rotation||0,c=Math.cos(angle),s=Math.sin(angle),hx=el.width/2,hy=el.depth/2;
      const poly=[[-hx,-hy],[hx,-hy],[hx,hy],[-hx,hy]].map(([x,y])=>({x:el.position.x+x*c-y*s,y:el.position.y+x*s+y*c}));
      const cuts=polygonIntersections(start,end,poly);
      for(let i=0;i<cuts.length-1;i++){const lo=cuts[i],hi=cuts[i+1];if((hi-lo)*length<tolerance||!insidePolygon(at((lo+hi)/2),poly))continue;results.push({elementId:el.id,type:"column",stationStart:lo*length,stationEnd:hi*length,elevationStart:base,elevationEnd:base+(el.height||story?.height||3),material:el.buildingMaterial||""})}
    }else if(el.type==="beam"){
      const hit=intersectSegment(start,end,el.start,el.end);
      if(hit){const station=hit.t*length;results.push({elementId:el.id,type:"beam",stationStart:station,stationEnd:station,elevationStart:base+(el.elevation||0),elevationEnd:base+(el.elevation||0)+(el.depth||0),material:el.buildingMaterial||""})}
    }
  }
  return results.sort((a,b)=>a.stationStart-b.stationStart||a.elevationStart-b.elevationStart);
}
