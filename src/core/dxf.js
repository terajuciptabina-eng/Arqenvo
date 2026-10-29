/** Minimal standards-based ASCII DXF R12 export for 2D floor-plan exchange.
 * Exports model geometry in metres on named layers. It is not an IFC/BIM exchange file.
 */
const pair=(code,value)=>String(code)+"\n"+String(value)+"\n";
const line=(layer,a,b)=>pair(0,"LINE")+pair(8,layer)+pair(10,a.x)+pair(20,a.y)+pair(30,0)+pair(11,b.x)+pair(21,b.y)+pair(31,0);
const polyline=(layer,points)=>points.map((p,i)=>line(layer,p,points[(i+1)%points.length])).join("");
const textEntity=(el)=>String(el.text??"Text").split("\n").map((value,index)=>pair(0,"TEXT")+pair(8,"A-TEXT")+pair(10,el.position.x)+pair(20,el.position.y-index*Math.max(.001,Number(el.textSizeMm)||2.5)/1000*1.25)+pair(30,0)+pair(40,Math.max(.001,Number(el.textSizeMm)||2.5)/1000)+pair(1,value.slice(0,255))).join("");
const rectangle=(cx,cy,width,depth,rotation=0)=>{const c=Math.cos(rotation),s=Math.sin(rotation);return [[-width/2,-depth/2],[width/2,-depth/2],[width/2,depth/2],[-width/2,depth/2]].map(([x,y])=>({x:cx+x*c-y*s,y:cy+x*s+y*c}))};
export function exportFloorPlanDxf(project,{storyId=project?.stories?.[0]?.id}={}){
 if(!project||!Array.isArray(project.elements)||!Array.isArray(project.stories))throw new TypeError("A valid project model is required");
 if(!project.stories.some(s=>s.id===storyId))throw new RangeError("Requested story does not exist");
 let entities="";
 for(const el of project.elements){
  if(el.storyId!==storyId)continue;
  if(el.type==="wall"||el.type==="beam")entities+=line(el.type==="wall"?"A-WALL":"A-BEAM",el.start,el.end);
  else if(el.type==="slab"&&Array.isArray(el.boundary)&&el.boundary.length>=3)entities+=polyline("A-SLAB",el.boundary);
  else if(el.type==="column"&&el.position&&el.width>0&&el.depth>0)entities+=polyline("A-COLS",rectangle(el.position.x,el.position.y,el.width,el.depth,el.rotation||0));
  else if(el.type==="dimension"&&el.start&&el.end)entities+=line("A-DIMS",el.start,el.end);
  else if(el.type==="text"&&el.position&&Number.isFinite(el.position.x)&&Number.isFinite(el.position.y))entities+=textEntity(el);
  else if(el.type==="room"&&Array.isArray(el.boundary)&&el.boundary.length>=3)entities+=polyline("A-ROOM",el.boundary);
 }
 const header=pair(0,"SECTION")+pair(2,"HEADER")+pair(9,"$ACADVER")+pair(1,"AC1009")+pair(9,"$INSUNITS")+pair(70,6)+pair(0,"ENDSEC");
 const layers=[["0",7],["A-WALL",7],["A-BEAM",4],["A-SLAB",8],["A-COLS",1],["A-DIMS",3],["A-ROOM",5],["A-TEXT",7]];
 const table=pair(0,"SECTION")+pair(2,"TABLES")+pair(0,"TABLE")+pair(2,"LAYER")+pair(70,layers.length)+layers.map(([name,color])=>pair(0,"LAYER")+pair(2,name)+pair(70,0)+pair(62,color)+pair(6,"CONTINUOUS")).join("")+pair(0,"ENDTAB")+pair(0,"ENDSEC");
 return header+table+pair(0,"SECTION")+pair(2,"ENTITIES")+entities+pair(0,"ENDSEC")+pair(0,"EOF");
}
