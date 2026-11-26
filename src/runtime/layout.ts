/** Apply only source-proved constraints already present in the generated view.
 * Measurements never inspect business content or create skeleton structure. */
export function acquireLayoutConstraints(root:HTMLElement|ShadowRoot):()=>void{
 const document=root.ownerDocument,window=document.defaultView;
 if(!window)return()=>{};
 const targets=[...root.querySelectorAll<HTMLElement>('[data-sk-viewport-bottom]')].filter(node=>{
  const raw=node.dataset.skViewportBottom,offset=Number(raw);return !!raw?.trim()&&Number.isFinite(offset)&&Math.abs(offset)<=100000;
 });
 if(!targets.length)return()=>{};
 let disposed=false,frame=0;
 const positions=new WeakMap<HTMLElement,number>();
 for(const target of targets){const offset=Number(target.dataset.skViewportBottom);target.style.height=`max(0px, calc(100vh - var(--sk-viewport-top, 0px) - ${offset}px))`;}
 const update=()=>{
  frame=0;if(disposed)return;
  for(const target of targets){
   if(!target.isConnected||!target.getClientRects().length)continue;
   const top=Math.round(target.getBoundingClientRect().top*1000)/1000;
   if(positions.get(target)===top)continue;
   positions.set(target,top);target.style.setProperty('--sk-viewport-top',`${top}px`);
  }
 };
 const schedule=()=>{if(!disposed&&!frame)frame=window.requestAnimationFrame(update);};
 const ancestors=new Set<Element>();
 for(const target of targets){
  let parent:Element|null=target.parentElement;
  while(parent){
   ancestors.add(parent);
   const tree=parent.getRootNode();parent=parent.parentElement??(tree.nodeType===11&&'host'in tree?(tree as ShadowRoot).host:null);
  }
 }
 const resize=typeof window.ResizeObserver==='function'?new window.ResizeObserver(schedule):undefined;
 for(const element of [...targets,...ancestors])resize?.observe(element);
 const mutation=typeof window.MutationObserver==='function'?new window.MutationObserver(schedule):undefined;
 for(const element of ancestors)mutation?.observe(element,{attributes:true,attributeFilter:['class','style','hidden'],childList:true});
 window.addEventListener('resize',schedule);
 void document.fonts?.ready.then(schedule).catch(()=>{});
 update();
 return()=>{disposed=true;resize?.disconnect();mutation?.disconnect();window.removeEventListener('resize',schedule);if(frame)window.cancelAnimationFrame(frame);};
}
