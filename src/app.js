import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CATALOG, FACADE_MATERIALS, COUNTERTOP_MATERIALS } from '../data/catalog.js';
import { layoutModuleDimensions, wallPoint } from './dimensions.js';
import { FACADE_THICKNESS_MM, WORKTOP_DEPTH_MM, moduleDepthMM, bodyWallGapMM, installedFrontMM, facadeCenterMM } from './module-depth.js';
import { layoutBacksplash, normalizePanelHeight, hasVerticalGrain, panelTextureTransform, PANEL_THICKNESS_MM, DEFAULT_PANEL_HEIGHT } from './backsplash.js';

import { APPLIANCES, APPLIANCE_FIELDS, applianceLimits, normalizeAppliance, placementWidthMM, placementHeightMM, fitsRoom } from './appliances.js';
import { layoutWorktopRuns, calculateWorktopOrder } from './worktop-order.js';
import { WORKTOP_STOCK_PRICES } from '../data/worktop-prices.js';
import { calculateDiscount, formatPromoPeriod } from './pricing.js';

const MM = 0.001;
const fmt = new Intl.NumberFormat('ru-RU');
const WALL_NAMES = { north:'Северная', east:'Правая', south:'Южная', west:'Левая' };
const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_UPPER_ELEVATION = 1450;
const COUNTERTOP_THICKNESS = 38;
const FACADE_THICKNESS = FACADE_THICKNESS_MM * MM;
const WORKTOP_DEPTH = WORKTOP_DEPTH_MM * MM;
const AVAILABLE_COUNTERTOPS = COUNTERTOP_MATERIALS.filter(m=>(m.thicknesses||[COUNTERTOP_THICKNESS]).includes(COUNTERTOP_THICKNESS));

const MODULE_CATEGORIES = [
  {id:'lower', label:'Нижние'},
  {id:'upper720', label:'Верхние 720'},
  {id:'upper900', label:'Верхние 900'},
  {id:'antresol', label:'Антресоли'},
  {id:'pantry', label:'Пеналы'},
  {id:'appliances', label:'Бытовая техника'},
];

const state = {
  room: { width: 3200, depth: 3000, height: 2600 },
  materialId: FACADE_MATERIALS[0].id, // fallback/default for first module
  countertopMaterialId: AVAILABLE_COUNTERTOPS[0].id,
  orderWorktop: false,
  items: [],
  selectedId: null,
  nextId: 1,
  mode: 'room',
  moduleTab: 'lower',
  moduleSearch: '',
  catalogSelections: {},
  showFacades: true,
  showDimensions: false,
  backsplashEnabled: false,
  backsplashOverStove: false,
  backsplashHeight: DEFAULT_PANEL_HEIGHT,
  backsplashMaterialId: null, // null = follow countertop automatically
};

const viewport = document.getElementById('viewport');
const room2d = document.getElementById('room-2d');
const planSvg = document.getElementById('room-plan-svg');
const planGroup = document.getElementById('plan-room-group');
const planStage = document.getElementById('plan-stage');
const loading = document.getElementById('loading');
const dragStatus = document.getElementById('drag-status');

let scene, camera, renderer, controls, roomGroup, modulesGroup, directionArrowsGroup, selectionBox;
let walls = [];
let backsplashGroup;
let backsplashRuns=[];
let backsplashKey="";
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const floorPlane = new THREE.Plane(new THREE.Vector3(0,1,0), 0);
let drag = null;
let planDrag = null;
let planPan = null;
let planView = null;
let planCamera = null;
let toastTimer = null;
let floorTexture = null;
let wallTexture = null;
let materialModalType = null;
let materialModalCategory = 'all';
let materialModalSearch = '';
// One renderer for the entire catalogue, not one WebGL context per card.
let catalogPreviewRenderer = null;
let catalogPreviewScene = null;
const catalogPreviewCache = new Map();
let catalogPreviewFrame = null;
let catalogPreviewQueue = [];
let dimensionFrameKey = '';
const dimensionSvg = document.getElementById('module-dimensions');



const worktopPlanCache=new Map();
let currentStockPrices=WORKTOP_STOCK_PRICES;
let currentPromo=null, pricingSignature='', pricingBusy=false;
async function refreshPricing(){
  if(pricingBusy)return;pricingBusy=true;
  try{
    const r=await fetch('./api/prices',{cache:'no-store'});if(!r.ok)throw Error('price API');
    const data=await r.json();
    if(!CATALOG.every(m=>Number.isInteger(data.prices?.[m.id])&&data.prices[m.id]>0)||![1000,1500].every(n=>Number.isInteger(data.worktops?.[n])&&data.worktops[n]>0))throw Error('invalid prices');
    const signature=JSON.stringify([data.revision,data.promo?.active]);
    document.getElementById('pricing-status').textContent='';
    if(signature===pricingSignature)return;
    // Do not overwrite dimensions the customer is currently typing.
    if(drag || document.activeElement?.matches('input, textarea, select, [contenteditable=true]'))return;
    for(const m of CATALOG)m.price=data.prices[m.id];
    currentStockPrices=[1000,1500].map(length=>({length,price:data.worktops[length]}));
    currentPromo=data.promo;pricingSignature=signature;worktopPlanCache.clear();updateSidebar();
  }catch(e){document.getElementById('pricing-status').textContent='Не удалось обновить цены. Расчёт предварительный.';}
  finally{pricingBusy=false;}
}
initUI();
init2DPlan();
try {
  init3D();
  restoreLocal();
  rebuildAll();
  render2DPlan({fit:true});
  setWorkspaceMode(state.mode || 'room');
  loading.classList.add('hidden');
} catch (e) {
  console.error(e);
  loading.classList.add('hidden');
  document.getElementById('webgl-error').classList.remove('hidden');
}
refreshPricing();setInterval(refreshPricing,5000);window.addEventListener('focus',refreshPricing);

function initUI(){
  document.querySelectorAll('.workspace-tab').forEach(btn => {
    btn.onclick = () => setWorkspaceMode(btn.dataset.mode);
  });
  document.getElementById('go-modules').onclick = () => setWorkspaceMode('modules');

  renderModuleTabs();
  renderCatalog();

  const moduleSearchInput=document.getElementById('module-search');
  if(moduleSearchInput){
    moduleSearchInput.value=state.moduleSearch || '';
    moduleSearchInput.oninput = e => {
      state.moduleSearch = e.target.value.trim();
      renderCatalog();
      saveLocal();
    };
  }

  document.getElementById('facade-category').onchange = renderFacadeOptions;
  document.getElementById('facade-select').onchange = () => {
    const item=findItem(state.selectedId);
    if(!item||getModule(item.moduleId,item).isAppliance) return;
    item.materialId=document.getElementById('facade-select').value;
    state.materialId=item.materialId;
    syncSelectedMaterialUI(); rebuildModules(); saveLocal();
  };
  document.getElementById('facade-open').onclick = () => openMaterialModal('facade');
  document.getElementById('countertop-open').onclick = () => openMaterialModal('countertop');
  document.getElementById('toggle-worktop-order').onclick=()=>{
    state.orderWorktop=!state.orderWorktop;
    updateSidebar(); saveLocal();
  };
  document.getElementById('material-modal-close').onclick = closeMaterialModal;
  document.querySelectorAll('[data-material-close]').forEach(el => el.onclick = closeMaterialModal);
  document.getElementById('material-search').oninput = e => { materialModalSearch=e.target.value.trim().toLowerCase(); renderMaterialModal(); };
  document.addEventListener('keydown', e => { if(e.key==='Escape' && !document.getElementById('material-modal').classList.contains('hidden')) closeMaterialModal(); });
  document.getElementById('apply-facade-all').onclick = () => {
    const item=findItem(state.selectedId); if(!item||getModule(item.moduleId,item).isAppliance) return;
    state.items.filter(i=>!getModule(i.moduleId,i).isAppliance).forEach(i=>i.materialId=item.materialId);
    state.materialId=item.materialId; rebuildModules(); saveLocal(); syncSelectedMaterialUI();
    showToast('Фасад применён','Выбранный декор установлен на все модули кухни.');
  };
  document.getElementById('countertop-category').onchange = () => renderCountertopOptions(false);
  document.getElementById('countertop-select').onchange = () => {
    state.countertopMaterialId=document.getElementById('countertop-select').value;
    syncCountertopUI(); rebuildModules(); saveLocal();
  };
  renderFacadeOptions();
  renderCountertopOptions(true);
  syncSelectedMaterialUI();
  syncCountertopUI();
  syncWorktopOrderUI();
  document.getElementById('toggle-backsplash').onclick=()=>{
    state.backsplashEnabled=!state.backsplashEnabled;
    syncBacksplashUI(); refreshBacksplash(); saveLocal();
  };
  document.getElementById('toggle-backsplash-stove').onclick=()=>{
    state.backsplashOverStove=!state.backsplashOverStove;
    syncBacksplashUI(); refreshBacksplash(); saveLocal();
  };
  document.getElementById('backsplash-open').onclick=()=>openMaterialModal('backsplash');
  document.getElementById('backsplash-inherit').onclick=()=>setBacksplashMaterial(null);
  const panelHeightInput=document.getElementById('backsplash-height');
  const applyPanelHeight=()=>{
    state.backsplashHeight=normalizePanelHeight(panelHeightInput.value);
    panelHeightInput.value=state.backsplashHeight;
    syncBacksplashUI(); refreshBacksplash(); saveLocal();
  };
  panelHeightInput.onchange=applyPanelHeight;
  panelHeightInput.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();applyPanelHeight();}});
  syncBacksplashUI();

  const applyRoomFromFields = ({notify=true}={}) => {
    const w = clamp(+document.getElementById('room-width').value || 3200, 1800, 8000);
    const d = clamp(+document.getElementById('room-depth').value || 3000, 1800, 8000);
    const h = clamp(+document.getElementById('room-height').value || 2600, 2200, 4200);
    if(!setRoomDimensions(w,d,h,{resetCamera: state.mode === 'modules', fitPlan:true}))return;
    if(notify) showToast('Изменения применены', `Размеры помещения: ${Math.round(w)} × ${Math.round(d)} × ${Math.round(h)} мм.`);
  };
  document.getElementById('apply-room').onclick = () => applyRoomFromFields({notify:true});
  document.getElementById('plan-fit').onclick = () => resetPlanViewport();
  ['room-width','room-depth','room-height'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if(e.key === 'Enter') applyRoomFromFields({notify:true});
    });
  });

  document.getElementById('reset-view').onclick = resetView;
  document.getElementById('toggle-facades').onclick = () => {
    state.showFacades=!state.showFacades;
    applyFacadeVisibility(); syncViewToggles(); saveLocal();
  };
  document.getElementById('toggle-dimensions').onclick = () => {
    state.showDimensions=!state.showDimensions;
    syncViewToggles(); saveLocal();
  };
  syncViewToggles();
  document.getElementById('apply-appliance').onclick=applyApplianceFields;
  document.querySelectorAll('[data-appliance-field]').forEach(input=>input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();applyApplianceFields();}}));
  document.getElementById('delete-selected').onclick = deleteSelected;
  document.addEventListener('keydown', onDeleteKey);
  document.getElementById('apply-selection-height').onclick = applySelectedHeightFromField;
  document.getElementById('selection-height').addEventListener('keydown', e => {
    if(e.key === 'Enter') applySelectedHeightFromField();
  });

  document.getElementById('toast-close').onclick = hideToast;
  document.getElementById('clear-project').onclick = () => {
    if (!state.items.length || confirm('Очистить тестовый проект?')) {
      state.items = []; state.selectedId = null; rebuildModules(); saveLocal();
    }
  };
  document.getElementById('save-project').onclick = () => {
    saveLocal();
    const b = document.getElementById('save-project');
    const old = b.textContent; b.textContent = 'Сохранено ✓';
    setTimeout(()=>b.textContent=old,1200);
  };
}

function showToast(title, text, timeout=3200){
  const toast=document.getElementById('toast');
  document.getElementById('toast-title').textContent=title;
  document.getElementById('toast-text').textContent=text;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(hideToast,timeout);
}
function hideToast(){
  clearTimeout(toastTimer);
  document.getElementById('toast').classList.add('hidden');
}

function renderModuleTabs(){
  const root=document.getElementById('module-tabs');
  root.innerHTML='';
  MODULE_CATEGORIES.forEach(cat=>{
    const count=getCatalogGroups(cat.id).length;
    const b=document.createElement('button');
    b.type='button';
    b.className='module-tab'+(state.moduleTab===cat.id?' active':'');
    b.innerHTML=`${cat.label}<span class="module-tab-count">${count}</span>`;
    b.onclick=()=>{state.moduleTab=cat.id;renderModuleTabs();renderCatalog();saveLocal();};
    root.appendChild(b);
  });
}

function renderCatalog(){
  const catalog=document.getElementById('catalog');
  catalog.innerHTML='';
  catalogPreviewQueue=[];
  const query=(state.moduleSearch||'').trim().toLowerCase();
  const groups=getCatalogGroups(state.moduleTab).filter(group=>matchesCatalogGroup(group, query));
  if(!groups.length){
    const cat=MODULE_CATEGORIES.find(c=>c.id===state.moduleTab);
    catalog.innerHTML=`<div class="catalog-empty">В категории «${cat?.label||''}» пока нет подходящих модулей.${query?'<small>Попробуйте изменить запрос или переключить тип модулей.</small>':''}</div>`;
    return;
  }
  groups.forEach(group => {
    const selectedId=getSelectedCatalogModuleId(group);
    const selectedModule=group.variants.find(v=>v.id===selectedId) || group.variants[0];
    const card = document.createElement('div');
    card.className = 'catalog-card catalog-card-compact';
    const optionOptions = group.variants.map(v=>`<option value="${v.id}" ${v.id===selectedModule.id?'selected':''}>${getModuleOptionLabel(v)}</option>`).join('');
    card.innerHTML = `
      <div class="catalog-preview catalog-preview-large"><img class="catalog-model-image" alt="" decoding="async" hidden><span class="catalog-preview-status">Загрузка превью…</span></div>
      <div class="catalog-main catalog-main-compact">
        <div class="catalog-name catalog-name-compact">${group.label}</div>
        ${selectedModule.isAppliance?'':`<div class="catalog-option-row catalog-option-row-compact">
          <select class="catalog-size-select" ${group.variants.length===1?'disabled':''} aria-label="Размер модуля">${optionOptions}</select>
        </div>`}
      </div>
      <button class="btn btn-primary btn-full catalog-btn">${selectedModule.isAppliance?'Добавить в проект':'Добавить модуль'}</button>`;
    const select=card.querySelector('.catalog-size-select');
    if(select){
      select.onchange = e => {
        state.catalogSelections[getCatalogSelectionKey(group)] = e.target.value;
        renderCatalog();
        saveLocal();
      };
    }
    card.querySelector('button').onclick = () => addModule(selectedModule.id);
    catalog.appendChild(card);
    queueCatalogPreview(card.querySelector('.catalog-preview'), selectedModule);
  });
}

function getCatalogGroups(category){
  const modules=[...CATALOG,...APPLIANCES].filter(m=>m.category===category);
  const groups=[];
  const map=new Map();
  modules.forEach(module=>{
    const key=`${category}::${module.family || module.id}`;
    if(!map.has(key)){
      map.set(key,{
        key,
        category,
        family:module.family || module.id,
        label:getModuleGroupLabel(module),
        variants:[]
      });
      groups.push(map.get(key));
    }
    map.get(key).variants.push(module);
  });
  groups.forEach(group=>group.variants.sort(compareModuleVariants));
  return groups;
}

function getCatalogSelectionKey(group){
  return group.key;
}

function getSelectedCatalogModuleId(group){
  const selected=state.catalogSelections[getCatalogSelectionKey(group)];
  if(selected && group.variants.some(v=>v.id===selected)) return selected;
  const fallback=group.variants[0]?.id || null;
  if(fallback) state.catalogSelections[getCatalogSelectionKey(group)] = fallback;
  return fallback;
}

function getModuleGroupLabel(module){
  if(module.name) return module.name;
  return module.sku || 'Модуль';
}

function compareModuleVariants(a,b){
  return (a.width-b.width) || (a.depth-b.depth) || (a.height-b.height) || String(a.id).localeCompare(String(b.id), 'ru');
}

function getModuleOptionLabel(module){
  const dims=[];
  if(module.width) dims.push(`Ш${module.width}`);
  if(module.depth) dims.push(`Г${moduleDepthMM(module)}`);
  if(module.height) dims.push(`В${module.height}`);
  return dims.join(' × ') + ' мм';
}

function matchesCatalogGroup(group, query){
  if(!query) return true;
  const groupText=[group.label, ...group.variants.map(v=>[
    v.name,
    v.sku,
    v.id,
    v.family,
    String(v.width),
    String(v.depth),
    String(moduleDepthMM(v)),
    String(installedFrontMM(v)),
    String(v.height),
    `${v.width} ${v.depth} ${v.height}`,
    `${v.width}x${v.depth}x${v.height}`,
    `${v.width}×${v.depth}×${v.height}`
  ].join(' '))].join(' ').toLowerCase();
  return groupText.includes(query);
}

// Render the very same cabinet meshes that are placed in the project.
// Only preview materials, camera and isolated placement differ from the project.
function queueCatalogPreview(host, module){
  const cached=catalogPreviewCache.get(module.id);
  if(cached){applyCatalogPreview(host,cached);return;}
  catalogPreviewQueue.push({host,module});
  if(catalogPreviewFrame===null) catalogPreviewFrame=requestAnimationFrame(processCatalogPreviews);
}

function applyCatalogPreview(host,url){
  if(!host.isConnected) return;
  const img=host.querySelector('.catalog-model-image');
  img.src=url;img.hidden=false;
  host.querySelector('.catalog-preview-status').hidden=true;
}

function processCatalogPreviews(){
  catalogPreviewFrame=null;
  // At most one new model per frame; switching categories discards old requests.
  while(catalogPreviewQueue.length){
    const {host,module}=catalogPreviewQueue.shift();
    if(!host.isConnected) continue;
    try{
      let url=catalogPreviewCache.get(module.id);
      if(!url){
        url=renderCatalogModel(module);
        catalogPreviewCache.set(module.id,url);
        // Bound memory usage as the catalogue grows.
        if(catalogPreviewCache.size>200) catalogPreviewCache.delete(catalogPreviewCache.keys().next().value);
      }
      applyCatalogPreview(host,url);
    }catch(error){
      console.warn('Не удалось отрисовать превью модуля',module.id,error);
      host.querySelector('.catalog-preview-status').textContent='Превью недоступно';
    }
    break;
  }
  if(catalogPreviewQueue.length) catalogPreviewFrame=requestAnimationFrame(processCatalogPreviews);
}

function renderCatalogModel(module){
  const width=480,height=264,aspect=width/height;
  if(!catalogPreviewRenderer){
    catalogPreviewRenderer=new THREE.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});
    catalogPreviewRenderer.setPixelRatio(1);
    catalogPreviewRenderer.setSize(width,height,false);
    catalogPreviewRenderer.setClearColor(0xffffff,0);
    catalogPreviewRenderer.outputColorSpace=THREE.SRGBColorSpace;
    catalogPreviewRenderer.toneMapping=THREE.NoToneMapping;
    catalogPreviewScene=new THREE.Scene();
    const ambient=new THREE.HemisphereLight(0xffffff,0xbdb5ab,1.35);
    const key=new THREE.DirectionalLight(0xffffff,1.8);
    key.position.set(-3,5,6);
    const fill=new THREE.DirectionalLight(0xffffff,.65);
    fill.position.set(4,3,-2);
    catalogPreviewScene.add(ambient,key,fill);
  }
  const item={uid:'catalog-preview',moduleId:module.id,wallId:'north',coord:0,elevation:0};
  const model=buildModule(item,{preview:true});
  catalogPreviewScene.add(model);
  try{
    model.updateMatrixWorld(true);
    const bounds=new THREE.Box3().setFromObject(model);
    const center=bounds.getCenter(new THREE.Vector3());
    const size=bounds.getSize(new THREE.Vector3());
    const distance=Math.max(size.length()*3,1);
    const view=new THREE.Vector3(.75,.48,1.35).normalize();
    const cam=new THREE.OrthographicCamera(-1,1,1,-1,.01,distance*4);
    cam.position.copy(center).addScaledVector(view,distance);
    cam.lookAt(center);cam.updateMatrixWorld(true);
    // Fit the complete cabinet, including its handle and worktop, in the image.
    let halfW=0,halfH=0;
    for(const x of [bounds.min.x,bounds.max.x])
      for(const y of [bounds.min.y,bounds.max.y])
        for(const z of [bounds.min.z,bounds.max.z]){
          const p=new THREE.Vector3(x,y,z).applyMatrix4(cam.matrixWorldInverse);
          halfW=Math.max(halfW,Math.abs(p.x));halfH=Math.max(halfH,Math.abs(p.y));
        }
    const fit=Math.max(halfH,halfW/aspect)*1.13;
    cam.left=-fit*aspect;cam.right=fit*aspect;cam.top=fit;cam.bottom=-fit;
    cam.updateProjectionMatrix();
    catalogPreviewRenderer.render(catalogPreviewScene,cam);
    return catalogPreviewRenderer.domElement.toDataURL('image/png');
  }finally{
    catalogPreviewScene.remove(model);
    const materials=new Set();
    model.traverse(o=>{if(o.isMesh){o.geometry.dispose();materials.add(o.material);}});
    materials.forEach(m=>m.dispose());
  }
}

function setWorkspaceMode(mode){
  state.mode = mode === 'modules' ? 'modules' : 'room';
  document.querySelectorAll('.workspace-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.mode===state.mode));
  document.getElementById('room-panel').classList.toggle('hidden', state.mode!=='room');
  document.getElementById('modules-panel').classList.toggle('hidden', state.mode!=='modules');
  document.getElementById('room-right-panel').classList.toggle('hidden', state.mode!=='room');
  document.getElementById('modules-right-panel').classList.toggle('hidden', state.mode!=='modules');
  room2d.classList.toggle('hidden', state.mode!=='room');
  viewport.classList.toggle('hidden', state.mode!=='modules');
  document.getElementById('reset-view').classList.toggle('hidden', state.mode!=='modules');
  if(state.mode==='room'){
    render2DPlan();
  }else{
    requestAnimationFrame(()=>{ onResize(); rebuildAll(); resetView(); });
  }
  saveLocal();
}

function setRoomDimensions(w,d,h,{resetCamera=false,fitPlan=false}={}){
  const previousRoom={...state.room},previousPositions=state.items.map(i=>({coord:i.coord,elevation:i.elevation}));
  state.room.width=Math.round(clamp(w,1800,8000));
  state.room.depth=Math.round(clamp(d,1800,8000));
  state.room.height=Math.round(clamp(h,2200,4200));
  syncRoomFields();
  state.items.forEach(item=>clampItemToWall(item));
  if(!validateRoomAppliances(previousRoom,previousPositions))return false;
  rebuildAll();
  if(fitPlan) planView=null;
  render2DPlan({fit:fitPlan});
  saveLocal();
  if(resetCamera && camera) resetView();
  return true;
}

function syncRoomFields(){
  document.getElementById('room-width').value=state.room.width;
  document.getElementById('room-depth').value=state.room.depth;
  document.getElementById('room-height').value=state.room.height;
  document.getElementById('room-summary-width').textContent=state.room.width+' мм';
  document.getElementById('room-summary-depth').textContent=state.room.depth+' мм';
  document.getElementById('room-summary-height').textContent=state.room.height+' мм';
}

/* ================= 2D ROOM EDITOR ================= */
function init2DPlan(){
  resetPlanViewport();
  planSvg.addEventListener('pointerdown', onPlanCanvasPointerDown);
  planSvg.addEventListener('pointermove', onPlanPointerMove);
  planSvg.addEventListener('pointerup', onPlanPointerUp);
  planSvg.addEventListener('pointerleave', onPlanPointerUp);
  planSvg.addEventListener('pointercancel', onPlanPointerUp);
  planSvg.addEventListener('wheel', onPlanWheel, {passive:false});
  planSvg.addEventListener('contextmenu', e=>e.preventDefault());
  window.addEventListener('resize', ()=>{ if(state.mode==='room') { render2DPlan(); applyPlanViewport(); } });
}

function fitPlanView(){
  const W=state.room.width,D=state.room.depth;
  const scale=Math.min(720/W, 470/D);
  const rw=W*scale,rh=D*scale;
  planView={left:500-rw/2,right:500+rw/2,top:350-rh/2,bottom:350+rh/2,scale};
}

function ensurePlanCamera(){
  if(!planCamera) planCamera={cx:500,cy:350,zoom:1};
}
function applyPlanViewport(){
  ensurePlanCamera();
  planCamera.zoom=clamp(planCamera.zoom,0.35,4.0);
  const vw=1000/planCamera.zoom,vh=700/planCamera.zoom;
  // Сетка большая и не привязана к размеру комнаты. Ограничение только защитное,
  // чтобы пользователь не ушёл на десятки экранов от проекта.
  planCamera.cx=clamp(planCamera.cx,-9000+vw/2,9000-vw/2);
  planCamera.cy=clamp(planCamera.cy,-9000+vh/2,9000-vh/2);
  planSvg.setAttribute('viewBox',`${planCamera.cx-vw/2} ${planCamera.cy-vh/2} ${vw} ${vh}`);
}
function resetPlanViewport(){
  planCamera={cx:500,cy:350,zoom:1};
  applyPlanViewport();
}

function render2DPlan({fit=false}={}){
  if(!planGroup)return;
  if(fit || !planView) fitPlanView();
  planGroup.innerHTML='';
  const W=state.room.width,D=state.room.depth;
  const {left:x,right,top:y,bottom,scale}=planView;
  const rw=right-x,rh=bottom-y;

  svgEl('rect',{x,y,width:rw,height:rh,class:'plan-room-fill'});
  svgEl('text',{x:x+rw/2,y:y+rh/2,class:'plan-room-label'},`Комната ${W} × ${D} мм · высота ${state.room.height} мм`);

  const walls={
    north:{x1:x,y1:y,x2:right,y2:y,hx:x+rw/2,hy:y},
    south:{x1:x,y1:bottom,x2:right,y2:bottom,hx:x+rw/2,hy:bottom},
    west:{x1:x,y1:y,x2:x,y2:bottom,hx:x,hy:y+rh/2},
    east:{x1:right,y1:y,x2:right,y2:bottom,hx:right,hy:y+rh/2},
  };
  Object.entries(walls).forEach(([id,g])=>{
    const line=svgEl('line',{x1:g.x1,y1:g.y1,x2:g.x2,y2:g.y2,class:'plan-wall','data-wall':id});
    const handle=svgEl('circle',{cx:g.hx,cy:g.hy,r:9,class:'plan-handle','data-wall':id});
    [line,handle].forEach(el=>el.addEventListener('pointerdown',e=>onPlanPointerDown(e,id,scale)));
  });
  drawHorizontalDimension(x,y-32,rw,W);
  drawHorizontalDimension(x,bottom+32,rw,W);
  drawVerticalDimension(x-66,y,rh,D);
  drawVerticalDimension(right+66,y,rh,D);
  applyPlanViewport();
}

function drawHorizontalDimension(x,y,w,value){
  svgEl('line',{x1:x,y1:y,x2:x+w,y2:y,class:'plan-dim-line'});
  svgEl('line',{x1:x,y1:y-6,x2:x,y2:y+6,class:'plan-dim-tick'});
  svgEl('line',{x1:x+w,y1:y-6,x2:x+w,y2:y+6,class:'plan-dim-tick'});
  const bw=76,bh=27;
  svgEl('rect',{x:x+w/2-bw/2,y:y-bh/2,width:bw,height:bh,rx:6,class:'plan-dim-bg'});
  svgEl('text',{x:x+w/2,y,class:'plan-dim-text'},String(value));
}
function drawVerticalDimension(x,y,h,value){
  svgEl('line',{x1:x,y1:y,x2:x,y2:y+h,class:'plan-dim-line'});
  svgEl('line',{x1:x-6,y1:y,x2:x+6,y2:y,class:'plan-dim-tick'});
  svgEl('line',{x1:x-6,y1:y+h,x2:x+6,y2:y+h,class:'plan-dim-tick'});
  const bw=76,bh=27;
  svgEl('rect',{x:x-bw/2,y:y+h/2-bh/2,width:bw,height:bh,rx:6,class:'plan-dim-bg'});
  svgEl('text',{x,y:y+h/2,class:'plan-dim-text'},String(value));
}
function svgEl(tag,attrs={},text=''){
  const el=document.createElementNS(SVG_NS,tag);
  Object.entries(attrs).forEach(([k,v])=>el.setAttribute(k,String(v)));
  if(text)el.textContent=text;
  planGroup.appendChild(el);
  return el;
}
function planPoint(e){
  const r=planSvg.getBoundingClientRect();
  const viewBox=planSvg.viewBox.baseVal;
  const vx=viewBox && viewBox.width ? viewBox.x : 0;
  const vy=viewBox && viewBox.height ? viewBox.y : 0;
  const vw=viewBox && viewBox.width ? viewBox.width : 1000;
  const vh=viewBox && viewBox.height ? viewBox.height : 700;
  return {x:vx+((e.clientX-r.left)/r.width)*vw,y:vy+((e.clientY-r.top)/r.height)*vh};
}
function onPlanCanvasPointerDown(e){
  // Навигация по плану — ПКМ, как в 3D. ЛКМ остаётся для изменения стен.
  if(e.button!==2) return;
  e.preventDefault();
  ensurePlanCamera();
  const r=planSvg.getBoundingClientRect();
  const viewBox=planSvg.viewBox.baseVal;
  planPan={
    pointerId:e.pointerId,
    startClientX:e.clientX,
    startClientY:e.clientY,
    startCamera:{...planCamera},
    worldPerPxX:viewBox.width/Math.max(r.width,1),
    worldPerPxY:viewBox.height/Math.max(r.height,1)
  };
  planSvg.setPointerCapture?.(e.pointerId);
  planStage.classList.add('panning');
}
function onPlanWheel(e){
  if(state.mode!=='room') return;
  e.preventDefault();
  ensurePlanCamera();
  const before=planPoint(e);
  const factor=e.deltaY>0?0.92:1.08;
  const nextZoom=clamp(planCamera.zoom*factor,0.35,4.0);
  const prevZoom=planCamera.zoom;
  if(nextZoom===prevZoom) return;
  planCamera.zoom=nextZoom;
  const nextVw=1000/planCamera.zoom, nextVh=700/planCamera.zoom;
  const rx=(before.x-(planCamera.cx-(1000/prevZoom)/2))/((1000/prevZoom));
  const ry=(before.y-(planCamera.cy-(700/prevZoom)/2))/((700/prevZoom));
  planCamera.cx=before.x-(rx*nextVw-nextVw/2);
  planCamera.cy=before.y-(ry*nextVh-nextVh/2);
  applyPlanViewport();
}
function onPlanPointerDown(e,wall,scale){
  if(e.button!==0) return;
  e.preventDefault(); e.stopPropagation();
  const p=planPoint(e);
  planDrag={wall,startX:p.x,startY:p.y,scale,startView:{...planView}};
  planSvg.setPointerCapture?.(e.pointerId);
  document.querySelectorAll(`[data-wall="${wall}"]`).forEach(el=>el.classList.add('dragging'));
}
function onPlanPointerMove(e){
  if(planPan){
    const dx=e.clientX-planPan.startClientX;
    const dy=e.clientY-planPan.startClientY;
    planCamera.cx=planPan.startCamera.cx-dx*planPan.worldPerPxX;
    planCamera.cy=planPan.startCamera.cy-dy*planPan.worldPerPxY;
    applyPlanViewport();
    return;
  }
  if(!planDrag)return;
  const p=planPoint(e);
  const previousRoom={...state.room},previousPositions=state.items.map(i=>({coord:i.coord,elevation:i.elevation}));
  const v={...planDrag.startView};
  const scale=planDrag.scale;

  if(planDrag.wall==='east'){
    const width=Math.round(clamp((p.x-v.left)/scale,1800,8000)/10)*10;
    v.right=v.left+width*scale;
    state.room.width=width;
  }
  if(planDrag.wall==='west'){
    const width=Math.round(clamp((v.right-p.x)/scale,1800,8000)/10)*10;
    v.left=v.right-width*scale;
    state.room.width=width;
  }
  if(planDrag.wall==='south'){
    const depth=Math.round(clamp((p.y-v.top)/scale,1800,8000)/10)*10;
    v.bottom=v.top+depth*scale;
    state.room.depth=depth;
  }
  if(planDrag.wall==='north'){
    const depth=Math.round(clamp((v.bottom-p.y)/scale,1800,8000)/10)*10;
    v.top=v.bottom-depth*scale;
    state.room.depth=depth;
  }

  state.items.forEach(item=>clampItemToWall(item));
  if(!validateRoomAppliances(previousRoom,previousPositions))return;
  planView=v;
  syncRoomFields();
  buildRoom(); rebuildModules(); updateRoomLabel(); render2DPlan();
}
function onPlanPointerUp(){
  if(planPan){
    planPan=null;
    planStage.classList.remove('panning');
  }
  if(!planDrag)return;
  planDrag=null;
  document.querySelectorAll('.plan-wall,.plan-handle').forEach(el=>el.classList.remove('dragging'));
  saveLocal();
}

/* ================= 3D ================= */
function init3D(){
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xece8e1);
  const hostRect = viewport.parentElement.getBoundingClientRect();
  const initW = Math.max(480, hostRect.width || viewport.clientWidth || 900);
  const initH = Math.max(420, hostRect.height || viewport.clientHeight || 650);
  camera = new THREE.PerspectiveCamera(44, initW/initH, .05, 50);
  renderer = new THREE.WebGLRenderer({antialias:true, alpha:false});
  renderer.setSize(initW, initH);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.8));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  viewport.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = .07;
  controls.maxPolarAngle = Math.PI/2.02;
  controls.minPolarAngle = .17;
  controls.minDistance = 1.2;
  controls.maxDistance = 12;
  controls.target.set(0, 1.05, 0);

  const hemi = new THREE.HemisphereLight(0xfffcf7, 0xb9b3aa, 0.64);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff5e8, 1.75);
  sun.position.set(4.5, 6.5, 5.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048,2048);
  sun.shadow.bias = -0.00015;
  sun.shadow.normalBias = 0.025;
  sun.shadow.camera.left=-6;sun.shadow.camera.right=6;sun.shadow.camera.top=6;sun.shadow.camera.bottom=-6;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xdbe7f2, .28);
  fill.position.set(-4,3,-3);
  scene.add(fill);

  floorTexture = new THREE.TextureLoader().load('./assets/textures/floor-laminate.jpg',()=>{
    if(roomGroup) buildRoom();
  });
  floorTexture.wrapS=floorTexture.wrapT=THREE.RepeatWrapping;
  floorTexture.colorSpace=THREE.SRGBColorSpace;
  floorTexture.anisotropy=Math.min(renderer.capabilities.getMaxAnisotropy(),8);

  wallTexture = new THREE.TextureLoader().load('./assets/textures/wall-plaster.png',()=>{
    if(roomGroup) buildRoom();
  });
  wallTexture.wrapS=wallTexture.wrapT=THREE.RepeatWrapping;
  wallTexture.colorSpace=THREE.SRGBColorSpace;
  wallTexture.anisotropy=Math.min(renderer.capabilities.getMaxAnisotropy(),8);

  roomGroup = new THREE.Group(); scene.add(roomGroup);
  modulesGroup = new THREE.Group(); scene.add(modulesGroup);
  backsplashGroup = new THREE.Group(); scene.add(backsplashGroup);
  directionArrowsGroup = new THREE.Group(); scene.add(directionArrowsGroup);
  selectionBox = new THREE.BoxHelper(new THREE.Object3D(), 0xc82026);
  selectionBox.visible = false; scene.add(selectionBox);

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('resize', onResize);
  resetView();
  animate();
}

function resetView(){
  if(!camera)return;
  const W=state.room.width*MM,D=state.room.depth*MM,H=state.room.height*MM;
  const vfov=THREE.MathUtils.degToRad(camera.fov);
  const distForHeight=H/(2*Math.tan(vfov/2));
  const distForWidth=W/(2*Math.tan(vfov/2)*Math.max(camera.aspect,.5));
  const dist=Math.max(distForHeight,distForWidth)+.9;
  const targetY=Math.min(H*.46,1.35);
  camera.position.set(0, Math.min(H*.62,1.95), D/2+dist);
  controls.target.set(0,targetY,0);
  controls.update();
  updateWallVisibility(true);
}

function rebuildAll(){
  buildRoom();
  rebuildModules();
  updateRoomLabel();
}

function buildRoom(){
  if(!roomGroup)return;
  clearGroup(roomGroup);
  walls = [];
  const W=state.room.width*MM, D=state.room.depth*MM, H=state.room.height*MM;

  if(floorTexture){
    floorTexture.repeat.set(Math.max(1,W/1.4),Math.max(1,D/1.7));
    floorTexture.needsUpdate=true;
  }
  const floorMat = new THREE.MeshStandardMaterial({map:floorTexture || null,color:floorTexture?0xffffff:0xd9dde0,roughness:.88,metalness:0});
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W,D), floorMat);
  floor.rotation.x=-Math.PI/2; floor.receiveShadow=true; floor.userData.kind='floor';
  roomGroup.add(floor);
  roomGroup.add(createExtendedGrid(W,D,1.0,.1));

  const wallMat = () => new THREE.MeshStandardMaterial({
    map: wallTexture || null,
    color: wallTexture ? 0xffffff : 0xf4f2ee,
    roughness: .96,
    metalness: 0,
    emissive: 0xffffff,
    emissiveIntensity: .14,
    transparent: true,
    opacity: 1,
    side: THREE.DoubleSide
  });
  // Room dimensions are the clear INTERNAL dimensions, as on the 2D plan.
  // Wall solids extend outward; their inner faces coincide with the placement planes.
  const thickness=.035;
  createWall('north', new THREE.BoxGeometry(W+2*thickness,H,thickness), new THREE.Vector3(0,H/2,-D/2-thickness/2), wallMat());
  createWall('south', new THREE.BoxGeometry(W+2*thickness,H,thickness), new THREE.Vector3(0,H/2, D/2+thickness/2), wallMat());
  createWall('west', new THREE.BoxGeometry(thickness,H,D), new THREE.Vector3(-W/2-thickness/2,H/2,0), wallMat());
  createWall('east', new THREE.BoxGeometry(thickness,H,D), new THREE.Vector3( W/2+thickness/2,H/2,0), wallMat());
}

function createExtendedGrid(W,D,margin=1,step=.1){
  const x0=-W/2-margin,x1=W/2+margin,z0=-D/2-margin,z1=D/2+margin;
  const minor=[],major=[];
  const push=(arr,a,b,c,d)=>arr.push(a,.004,b,c,.004,d);
  const startX=Math.floor(x0/step)*step,endX=Math.ceil(x1/step)*step;
  const startZ=Math.floor(z0/step)*step,endZ=Math.ceil(z1/step)*step;
  let i=0;
  for(let x=startX;x<=endX+.0001;x+=step){
    const arr=Math.abs(Math.round(x/step))%5===0?major:minor;push(arr,x,z0,x,z1);i++;
  }
  for(let z=startZ;z<=endZ+.0001;z+=step){
    const arr=Math.abs(Math.round(z/step))%5===0?major:minor;push(arr,x0,z,x1,z);
  }
  const g=new THREE.Group();
  const make=(positions,color,opacity)=>{
    const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    const mat=new THREE.LineBasicMaterial({color,transparent:true,opacity});
    return new THREE.LineSegments(geo,mat);
  };
  g.add(make(minor,0xc7cdd3,.36));
  g.add(make(major,0x9da5ad,.46));
  return g;
}

function createWall(id, geom, pos, mat){
  // Equal physical texel scale on every wall face, regardless of room proportions.
  // BoxGeometry creates 4 UV vertices per face in +X,-X,+Y,-Y,+Z,-Z order.
  const {width:w,height:h,depth:d}=geom.parameters;
  const uv=geom.getAttribute('uv');
  const tileMeters=1.8;
  const faceSizes=[[d,h],[d,h],[w,d],[w,d],[w,h],[w,h]];
  for(let f=0;f<6;f++){
    const [uSize,vSize]=faceSizes[f];
    for(let i=f*4;i<f*4+4;i++) uv.setXY(i,uv.getX(i)*uSize/tileMeters,uv.getY(i)*vSize/tileMeters);
  }
  uv.needsUpdate=true;
  const mesh=new THREE.Mesh(geom,mat); mesh.position.copy(pos); mesh.receiveShadow=true; mesh.userData.wallId=id;
  roomGroup.add(mesh);
  const edges=new THREE.LineSegments(new THREE.EdgesGeometry(geom),new THREE.LineBasicMaterial({color:0xb9b2aa,transparent:true,opacity:.28}));
  edges.position.copy(pos); roomGroup.add(edges);
  walls.push({id,mesh,edges});
}

/* ================= MODULES ================= */
function addModule(moduleId){
  const m = getModule(moduleId);
  if(m.isAppliance && !['north','east','south','west'].some(w=>fitsRoom(m,state.room,w))){showToast('Техника не помещается','Проверьте размеры помещения.');return;}
  if(m.category==='pantry' && m.height>state.room.height){
    showToast('Пенал выше помещения',`Высота пенала ${m.height} мм. Выберите меньший размер или увеличьте высоту помещения.`);
    return;
  }
  const wallId='north';
  const sameRow=state.items.filter(i=>i.wallId===wallId && getModule(i.moduleId,i)?.wallMount===m.wallMount);
  // Use actual widths when placing different sizes of the same cabinet.
  // Retain the original 20 mm initial spacing and the existing drag/snap logic.
  const half=placementWidthMM(m)*MM/2, wallStart=-state.room.width*MM/2, wallEnd=-wallStart;
  let pos=wallStart+half;
  const intervals=sameRow.map(i=>{
    const w=placementWidthMM(getModule(i.moduleId,i))*MM/2;
    return {left:i.coord-w,right:i.coord+w};
  }).sort((a,b)=>a.left-b.left);
  for(const interval of intervals){
    if(pos+half+.02<=interval.left+1e-9) break;
    if(pos-half<interval.right+.02-1e-9) pos=interval.right+.02+half;
  }
  // Keep the existing clamped fallback if the initial wall has no free slot.
  if(pos+half>wallEnd+1e-9) pos=wallStart+half+sameRow.length*(m.width*MM+.02);
  const lastFurniture=state.items.filter(i=>!getModule(i.moduleId,i).isAppliance).at(-1);
  const inheritedMaterialId = lastFurniture
    ? (lastFurniture.materialId || state.materialId || FACADE_MATERIALS[0].id)
    : (state.materialId || FACADE_MATERIALS[0].id);
  const item={
    uid:'m'+state.nextId++,moduleId,wallId,coord:pos,
    elevation:m.wallMount==='wall' ? (m.defaultElevation || DEFAULT_UPPER_ELEVATION) : 0,
    materialId: inheritedMaterialId,
    lastValid:null,
    ...(m.isAppliance?{appliance:normalizeAppliance(m)}:{})
  };
  clampItemToWall(item);
  state.items.push(item);
  if(hasCollision(item.uid)){
    // The original default position may be blocked by a perpendicular cabinet.
    // Keep north as first choice; find another free position before creating an overlap.
    let placed=false;
    for(const candidateWall of ['north','east','south','west']){
      if(m.isAppliance&&!fitsRoom(m,state.room,candidateWall))continue;
      item.wallId=candidateWall;
      const halfWall=wallLength(candidateWall)/2;
      const start=-halfWall+half,end=halfWall-half;
      for(let c=start;c<=end+1e-9;c+=.01){
        item.coord=Math.min(c,end);
        if(!hasCollision(item.uid)){placed=true;break;}
      }
      if(!placed&&end>=start){item.coord=end;placed=!hasCollision(item.uid);}
      if(placed)break;
    }
    if(!placed){
      state.items.pop();
      showToast('Нет свободного места','Переместите модули или измените размеры помещения.');
      return;
    }
  }
  state.selectedId=item.uid;
  rebuildModules(); saveLocal();
  revealSelectedSettings();
}

function rebuildModules(){
  if(!modulesGroup)return;
  clearGroup(modulesGroup);
  state.items.forEach(item=>{
    const g=buildModule(item);
    modulesGroup.add(g);
  });
  applyFacadeVisibility();
  refreshBacksplash();
  dimensionFrameKey='';
  refreshSelectionBox();
  refreshDirectionArrow();
  updateSidebar();
}

function refreshDirectionArrow(){
  if(!directionArrowsGroup) return;
  clearGroup(directionArrowsGroup);
  const item=findItem(state.selectedId);
  if(!item) return;
  const m=getModule(item.moduleId,item);
  if(!m) return;
  const arrow=buildFrontDirectionArrow(item,m);
  directionArrowsGroup.add(arrow);
}

function buildModule(item,{preview=false}={}){
  const m=getModule(item.moduleId,item);
  if(m.isAppliance) return buildAppliance(item,m,preview);
  if(m.category==='pantry') return buildPantryModule(item,m,preview);
  if(m.wallMount==='wall') return buildUpperModule(item,m,preview);
  return buildLowerModule(item,m,preview);
}

function commonModuleMaterials(materialId,preview=false){
  return {
    body:new THREE.MeshStandardMaterial({color:0xe5e1da,roughness:.78}),
    inside:new THREE.MeshStandardMaterial({color:0xf0ede7,roughness:.82}),
    handle:new THREE.MeshStandardMaterial({color:0x343536,roughness:.42,metalness:.42}),
    plinth:new THREE.MeshStandardMaterial({color:0xc7c2bb,roughness:.8}),
    top:preview ? new THREE.MeshStandardMaterial({color:0xeeedea,roughness:.52}) : createCountertopMaterial(state.countertopMaterialId),
    facade:preview ? new THREE.MeshStandardMaterial({color:0xc82026,roughness:.68}) : createFacadeMaterial(materialId)
  };
}

function getLowerWorktopSpan(item,m){
  // Keep the small 9 mm side overhang only on exposed cabinet ends.
  // When another floor module touches this module, both worktops stop exactly
  // at the joint instead of overlapping in the same plane (z-fighting).
  const W=m.width*MM;
  const leftEdge=item.coord-W/2;
  const rightEdge=item.coord+W/2;
  const overhang=.009;
  const tolerance=.012;
  let leftBlocked=false,rightBlocked=false,leftSpace=overhang,rightSpace=overhang;

  state.items.forEach(other=>{
    if(other.uid===item.uid || other.wallId!==item.wallId) return;
    const om=getModule(other.moduleId,other);
    if(!om || om.wallMount==='wall') return;
    const oHalf=placementWidthMM(om)*MM/2;
    const oLeft=other.coord-oHalf;
    const oRight=other.coord+oHalf;
    if(om.isAppliance){
      if(oRight<=leftEdge+1e-7)leftSpace=Math.min(leftSpace,Math.max(0,leftEdge-oRight));
      if(oLeft>=rightEdge-1e-7)rightSpace=Math.min(rightSpace,Math.max(0,oLeft-rightEdge));
    }
    if(Math.abs(oRight-leftEdge)<=tolerance) leftBlocked=true;
    if(Math.abs(oLeft-rightEdge)<=tolerance) rightBlocked=true;
  });

  // Limit the overhang to the actual free space before the perpendicular wall.
  const wallHalf=wallLength(item.wallId)/2;
  const leftExt=leftBlocked?0:Math.min(leftSpace,Math.max(0,leftEdge+wallHalf));
  const rightExt=rightBlocked?0:Math.min(rightSpace,Math.max(0,wallHalf-rightEdge));
  // Along south/west walls local +X runs opposite to the stored world coordinate.
  const localSign=(item.wallId==='south'||item.wallId==='west')?-1:1;
  return {
    width:W+leftExt+rightExt,
    offsetX:localSign*(rightExt-leftExt)/2
  };
}

// Update the actual worktop during dragging as well as after drop. Reuse
// the material and adjust the physical texture footprint without reloading it.
function refreshWorktopSpans(){
  if(!modulesGroup) return;
  for(const item of state.items){
    const m=getModule(item.moduleId,item);
    if(!m || m.category!=='lower') continue;
    const mesh=getModuleObject(item.uid)?.children.find(o=>o.userData.part==='worktop');
    if(!mesh) continue;
    const span=getLowerWorktopSpan(item,m);
    const dims=mesh.geometry.parameters;
    if(Math.abs(dims.width-span.width)>1e-8){
      const old=mesh.geometry;
      mesh.geometry=new THREE.BoxGeometry(span.width,dims.height,dims.depth);
      old.dispose();
      configureCountertopTextureScale(mesh.material,span.width,dims.depth);
    }
    mesh.position.x=span.offsetX;
    mesh.updateMatrixWorld(true);
  }
}

// Separate, non-selectable group: panel meshes never enter module raycasting,
// collision detection, catalogue thumbnails or the module bill of materials.
function disposeBacksplashMesh(mesh){
  mesh.geometry.dispose();
  mesh.material.userData.disposed=true;
  mesh.material.map?.dispose();
  mesh.material.dispose();
  mesh.parent?.remove(mesh);
}
function refreshBacksplash(){
  if(!backsplashGroup)return;
  const runs=state.backsplashEnabled?layoutBacksplash(state.items,state.room,getModule,getLowerWorktopSpan,state.backsplashHeight,COUNTERTOP_THICKNESS,state.backsplashOverStove):[];
  const def=getBacksplashMaterial();
  const key=JSON.stringify([def.id,state.room.width,state.room.depth,runs]);
  if(key===backsplashKey)return;
  backsplashKey=key;
  backsplashRuns=runs;
  // Reuse meshes/materials during dragging instead of allocating textures at every pointer event.
  const old=[...backsplashGroup.children];
  const used=new Set();
  for(const r of runs){
    let mesh=old.find(o=>!used.has(o)&&o.userData.wallId===r.wallId&&o.userData.decorId===def.id);
    if(mesh){
      used.add(mesh);
      const p=mesh.geometry.parameters;
      if(Math.abs(p.width-r.width)>1e-8||Math.abs(p.height-r.height)>1e-8){
        mesh.geometry.dispose();mesh.geometry=new THREE.BoxGeometry(r.width,r.height,PANEL_THICKNESS_MM*MM);
      }
    }else{
      const mat=createDecorMaterial(def,'backsplash');
      mesh=new THREE.Mesh(new THREE.BoxGeometry(r.width,r.height,PANEL_THICKNESS_MM*MM),mat);
      mesh.userData.wallId=r.wallId;mesh.userData.decorId=def.id;
      mesh.receiveShadow=true;
      backsplashGroup.add(mesh);
    }
    mesh.material.userData.panelFootprint={w:r.width,h:r.height,anchor:r.textureAnchor};
    applyBacksplashTextureScale(mesh.material.map,mesh.material,def);
    // Position with the back at the internal wall plane, and the bottom at the worktop top.
    applyWallTransform(mesh,{wallId:r.wallId,coord:r.coord,elevation:(r.bottom+r.height/2)/MM});
    mesh.translateZ(PANEL_THICKNESS_MM*MM/2);
    mesh.updateMatrixWorld(true);
  }
  for(const o of old)if(!used.has(o))disposeBacksplashMesh(o);
  syncBacksplashSummary();
}
function applyBacksplashTextureScale(tex,mat,def){
  const f=mat.userData.panelFootprint;if(!tex||!f)return;
  const img=tex.image;
  const iw=img?.naturalWidth||img?.width||0,ih=img?.naturalHeight||img?.height||0;
  if(tex.userData.panelRotate===undefined){
    let vertical=false;
    // Only the panel texture is transformed. Already-horizontal procedural grain
    // stays horizontal. Real images are checked in their native proportions.
    if(def.panelGrain==='vertical')vertical=true;
    else if(def.panelGrain!=='horizontal'&&iw>0&&ih>0){
      try{
        const c=document.createElement('canvas');const scale=Math.min(1,192/Math.max(iw,ih));
        c.width=Math.max(12,Math.round(iw*scale));c.height=Math.max(12,Math.round(ih*scale));
        const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0,c.width,c.height);
        vertical=hasVerticalGrain(ctx.getImageData(0,0,c.width,c.height).data,c.width,c.height);
      }catch(e){/* Unreadable source retains its native direction. */}
    }
    tex.userData.panelRotate=vertical;
  }
  const t=panelTextureTransform(f.w,f.h,iw,ih,def.texturePhysicalHeight,tex.userData.panelRotate,def.textureOffset,f.anchor);
  tex.wrapS=tex.wrapT=THREE.RepeatWrapping;
  tex.center.set(0,0);tex.repeat.set(t.sx,t.sy);tex.rotation=t.rotation;tex.offset.set(t.ox,t.oy);
  tex.updateMatrix();
}
function getBacksplashMaterial(){
  return getCountertopMaterial(state.backsplashMaterialId ?? state.countertopMaterialId);
}
function setBacksplashMaterial(id){
  if(id!==null&&!AVAILABLE_COUNTERTOPS.some(m=>m.id===id))return false;
  state.backsplashMaterialId=id;
  syncBacksplashUI(); refreshBacksplash(); saveLocal();
  return true;
}
function syncBacksplashUI(){
  const def=getBacksplashMaterial();
  document.getElementById('toggle-backsplash').setAttribute('aria-pressed',String(state.backsplashEnabled));
  document.getElementById('toggle-backsplash-stove').setAttribute('aria-pressed',String(state.backsplashOverStove));
  document.getElementById('backsplash-options').classList.toggle('hidden',!state.backsplashEnabled);
  const heightInput=document.getElementById('backsplash-height');
  if(document.activeElement!==heightInput)heightInput.value=state.backsplashHeight;
  document.getElementById('backsplash-decor').textContent=`${def.code?'№ '+def.code+' ':''}${def.name}`;
  document.getElementById('backsplash-preview').style.background=previewCss(def);
  const inherited=state.backsplashMaterialId===null;
  document.getElementById('backsplash-decor-mode').textContent=inherited?'Как у столешницы · автоматически':'Выбран отдельно';
  document.getElementById('backsplash-inherit').classList.toggle('hidden',inherited);
  syncBacksplashSummary();
}
function syncBacksplashSummary(){
  const def=getBacksplashMaterial(),runs=backsplashRuns;
  document.getElementById('project-backsplash-status').textContent=state.backsplashEnabled?(runs.length?'Добавлена':state.backsplashOverStove?'Нет столешниц или плит':'Нет столешниц'):'Не выбрана';
  document.getElementById('project-backsplash-details').classList.toggle('hidden',!state.backsplashEnabled);
  document.getElementById('project-backsplash-decor').textContent=`${def.supplier} · ${def.code?'№ '+def.code+' ':''}${def.name}`;
  document.getElementById('project-backsplash-height').textContent=`${state.backsplashHeight} / ${PANEL_THICKNESS_MM} мм`;
  document.getElementById('project-backsplash-length').textContent=fmt.format(Math.round(runs.reduce((s,r)=>s+r.width,0)/MM))+' мм';
  document.getElementById('project-backsplash-area').textContent=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:3}).format(runs.reduce((s,r)=>s+r.width*r.height,0))+' м²';
  const root=document.getElementById('project-backsplash-runs');root.replaceChildren();
  for(const r of runs){const line=document.createElement('div');line.textContent=`${WALL_NAMES[r.wallId]}: ${fmt.format(Math.round(r.width/MM))} × ${fmt.format(Math.round(r.height/MM))} мм`;root.appendChild(line);}
}

// The same geometry is used for the catalogue render and the placed object.
// All controls, handles and door surfaces stay inside the entered envelope.
function buildAppliance(item,m,preview=false){
  const g=new THREE.Group();g.userData.itemId=item.uid;g.userData.moduleId=m.id;
  const W=m.width*MM,H=m.height*MM,D=m.depth*MM,Z=preview?0:m.backGap*MM;
  const steel=new THREE.MeshStandardMaterial({color:0xbfc5c8,roughness:.48,metalness:.25});
  const door=new THREE.MeshStandardMaterial({color:0xd6dadd,roughness:.42,metalness:.18});
  const dark=new THREE.MeshStandardMaterial({color:0x25292c,roughness:.48});
  const glass=new THREE.MeshStandardMaterial({color:0x151d24,roughness:.18,metalness:.35});
  const trim=new THREE.MeshStandardMaterial({color:0x91999e,roughness:.45,metalness:.4});
  const front=Math.min(.025,D*.08),handle=Math.min(.018,front*.7);
  const box=(w,h,d,x,y,z,mat)=>addBox(g,w,h,d,x,y,z+Z,mat,'appliance');
  if(m.kind==='fridge'){
    box(W,H,D-front,0,H/2,(D-front)/2,steel);
    const seam=H*.31,edge=.004,gap=.005,doorD=front-handle;
    box(W-2*edge,H-seam-2*edge-gap,doorD,0,(H+seam)/2-gap/2,D-front+doorD/2,door);
    box(W-2*edge,seam-2*edge-gap,doorD,0,seam/2,D-front+doorD/2,door);
    // Recessed horizontal grips above and below the freezer seam.
    for(const y of [seam-.025,seam+.025])box(W*.65,.009,handle,0,y,D-handle/2,dark);
    // Badge is mounted on the door, not coplanar with its front surface.
    box(W*.18,.012,.002,W*.32,H*.91,D-handle+.001,trim);
  }else{
    const top=Math.min(.025,H*.05),base=H*.08;
    box(W,H-top-base,D-front,0,(H-top+base)/2,(D-front)/2,steel);
    box(W-.012,base,D-front,0,base/2,(D-front)/2,dark);
    box(W,top-.003,D,0,H-top/2-.0015,D/2,dark);
    const panelH=H*.16,ovenH=H*.65,ovenY=base+ovenH/2;
    box(W-.008,panelH,front-handle,0,H-top-panelH/2,D-front+(front-handle)/2,steel);
    box(W-.012,ovenH,front-handle,0,ovenY,D-front+(front-handle)/2,dark);
    box(W*.79,ovenH*.65,.003,0,ovenY-.025,D-handle-.0015,glass);
    box(W*.82,.017,handle,0,ovenY+ovenH*.36,D-handle/2,trim);
    for(let i=0;i<4;i++)box(W*.065,panelH*.29,handle,(i-1.5)*W*.22,H-top-panelH/2,D-handle/2,dark);
    // Four flat hotplates inset into the cooktop surface, not beyond its height.
    for(const x of [-W*.25,W*.25])for(const z of [D*.25,D*.75]){
      const r=Math.min(W*.18,D*.17);
      const disk=new THREE.Mesh(new THREE.CylinderGeometry(r,r,.002,32),trim);
      disk.position.set(x,H-.002,Z+z);disk.userData.part='appliance';g.add(disk);
      const inner=new THREE.Mesh(new THREE.CylinderGeometry(r*.88,r*.88,.001,32),dark);
      inner.position.set(x,H-.0005,Z+z);inner.userData.part='appliance';g.add(inner);
    }
  }
  if(!preview)applyWallTransform(g,item);
  tagModuleMeshes(g,item.uid);return g;
}

function buildLowerModule(item,m,preview=false){
  const g=new THREE.Group();g.userData.itemId=item.uid;g.userData.moduleId=m.id;
  const W=m.width*MM,D=m.depth*MM,carc=m.carcassHeight*MM,plinth=m.plinthHeight*MM,board=.016;
  const mat=commonModuleMaterials(item.materialId,preview);
  const y0=plinth;
  const bodyOffsetZ=bodyWallGapMM(m)*MM;
  const front=installedFrontMM(m)*MM;
  addBox(g,board,carc,D,-W/2+board/2,y0+carc/2,bodyOffsetZ + D/2,mat.body,'carcass');
  addBox(g,board,carc,D, W/2-board/2,y0+carc/2,bodyOffsetZ + D/2,mat.body,'carcass');
  addBox(g,W-2*board,board,D,0,y0+board/2,bodyOffsetZ + D/2,mat.body,'carcass');
  addBox(g,W-2*board,board,D-.025,0,y0+carc*.52,bodyOffsetZ + (D-.025)/2,mat.inside,'shelf');
  addBox(g,W-.03,plinth-.018,.018,0,plinth/2-.006,bodyOffsetZ + D-.015,mat.plinth,'plinth');
  const fh=m.facadeHeight*MM;
  const facade=addBox(g,W-.006,fh,FACADE_THICKNESS,0,y0+fh/2-.003,facadeCenterMM(m)*MM,mat.facade,'facade');facade.userData.isFacade=true;
  addBox(g,Math.min(.32,W*.48),.018,.024,0,y0+fh-.055,front+.0085,mat.handle,'handle');
  const worktopSpan=preview ? {width:W+.018,offsetX:0} : getLowerWorktopSpan(item,m);
  addBox(g,worktopSpan.width,COUNTERTOP_THICKNESS*MM,WORKTOP_DEPTH,worktopSpan.offsetX,(m.height*MM)+COUNTERTOP_THICKNESS*MM/2,WORKTOP_DEPTH/2,mat.top,'worktop');
  if(!preview) applyWallTransform(g,item);
  tagModuleMeshes(g,item.uid);
  return g;
}

function buildUpperModule(item,m,preview=false){
  const g=new THREE.Group();g.userData.itemId=item.uid;g.userData.moduleId=m.id;
  const W=m.width*MM,D=m.depth*MM,H=m.height*MM,board=.016;
  const mat=commonModuleMaterials(item.materialId,preview);
  addBox(g,board,H,D,-W/2+board/2,H/2,D/2,mat.body,'carcass');
  addBox(g,board,H,D, W/2-board/2,H/2,D/2,mat.body,'carcass');
  addBox(g,W-2*board,board,D,0,board/2,D/2,mat.body,'carcass');
  addBox(g,W-2*board,board,D,0,H-board/2,D/2,mat.body,'carcass');
  const shelfCount=Math.max(0,m.shelves||0);
  for(let i=1;i<=shelfCount;i++){
    const sy=H*(i/(shelfCount+1));
    addBox(g,W-2*board,board,D-.025,0,sy,(D-.025)/2,mat.inside,'shelf');
  }
  const fh=H-.008;
  if((m.doors||1)===1){
    const f=addBox(g,W-.008,fh,FACADE_THICKNESS,0,H/2,facadeCenterMM(m)*MM,mat.facade,'facade');
    f.userData.isFacade=true;
  }else{
    const gap=.004,fw=(W-gap*3)/2;
    const f1=addBox(g,fw,fh,FACADE_THICKNESS,-fw/2-gap/2,H/2,facadeCenterMM(m)*MM,mat.facade,'facade');
    const f2=addBox(g,fw,fh,FACADE_THICKNESS, fw/2+gap/2,H/2,facadeCenterMM(m)*MM,mat.facade,'facade');
    f1.userData.isFacade=f2.userData.isFacade=true;
  }
  if(!preview) applyWallTransform(g,item);
  tagModuleMeshes(g,item.uid);
  return g;
}

function buildPantryModule(item,m,preview=false){
  const g=new THREE.Group();g.userData.itemId=item.uid;g.userData.moduleId=m.id;
  const W=m.width*MM,D=m.depth*MM,H=m.height*MM,plinth=(m.plinthHeight||100)*MM,board=.016;
  const mat=commonModuleMaterials(item.materialId,preview);
  const bodyH=H-plinth;
  const y0=plinth;
  addBox(g,board,bodyH,D,-W/2+board/2,y0+bodyH/2,D/2,mat.body,'carcass');
  addBox(g,board,bodyH,D, W/2-board/2,y0+bodyH/2,D/2,mat.body,'carcass');
  addBox(g,W-2*board,board,D,0,y0+board/2,D/2,mat.body,'carcass');
  addBox(g,W-2*board,board,D,0,H-board/2,D/2,mat.body,'carcass');
  addBox(g,W-.03,plinth-.018,.018,0,plinth/2-.006,D-.015,mat.plinth,'plinth');

  // Высоты фасадов пеналов ПД_2Д из прайса. Нижняя дверь 713 мм,
  // верхняя меняется по высоте пенала. Прежняя ниша и горизонтальные ручки сохранены.
  const ovenH=.595;
  const lowerH=m.lowerFacadeHeight*MM;
  const upperH=m.upperFacadeHeight*MM;
  const lowerBottom=y0+.0035;
  const upperBottom=H-.0035-upperH;
  const ovenY=(lowerBottom+lowerH+upperBottom)/2;

  const lowerFacade=addBox(g,W-.008,lowerH,FACADE_THICKNESS,0,lowerBottom+lowerH/2,facadeCenterMM(m)*MM,mat.facade,'facade');
  lowerFacade.userData.isFacade=true;
  addBox(g,Math.min(.26,W*.42),.018,.022,0,lowerBottom+lowerH-.055,installedFrontMM(m)*MM+.0085,mat.handle,'handle');

  const ovenBody=new THREE.MeshStandardMaterial({color:0x202224,roughness:.28,metalness:.35});
  const ovenGlass=new THREE.MeshStandardMaterial({color:0x090b0d,roughness:.16,metalness:.12});
  addBox(g,W-.06,ovenH,.50,0,ovenY,.25,ovenBody,'appliance');
  addBox(g,W-.10,ovenH-.10,.018,0,ovenY-.015,installedFrontMM(m)*MM-.009,ovenGlass,'appliance');
  addBox(g,W-.13,.038,.024,0,ovenY+ovenH/2-.055,installedFrontMM(m)*MM+.010,mat.handle,'appliance-handle');

  const upperFacade=addBox(g,W-.008,upperH,FACADE_THICKNESS,0,upperBottom+upperH/2,facadeCenterMM(m)*MM,mat.facade,'facade');
  upperFacade.userData.isFacade=true;
  addBox(g,Math.min(.26,W*.42),.018,.022,0,upperBottom+.055,installedFrontMM(m)*MM+.0085,mat.handle,'handle');

  addBox(g,W-2*board,board,D-.025,0,upperBottom,(D-.025)/2,mat.inside,'shelf');
  if(!preview) applyWallTransform(g,item);
  tagModuleMeshes(g,item.uid);
  return g;
}

function buildFrontDirectionArrow(item,m){
  const g=new THREE.Group();
  g.userData.directionArrowFor=item.uid;

  const depth=Math.max(installedFrontMM(m),m.worktop?WORKTOP_DEPTH_MM:0)*MM;
  const mat=new THREE.MeshBasicMaterial({
    color:0xffffff,
    transparent:true,
    opacity:.54,
    side:THREE.DoubleSide,
    depthWrite:false,
    depthTest:true
  });

  // Плоская стрелка-направление. Локальное +Z — лицевая сторона модуля.
  // Важно: геометрия стрелки строится около собственного нуля, а затем весь
  // указатель выносится перед фасадом. Так она не может «протянуться» через корпус.
  const halfShaft=.025;
  const halfHead=.065;
  const shaftLength=.070;
  const headLength=.075;
  const shape=new THREE.Shape();
  shape.moveTo(-halfShaft,0);
  shape.lineTo( halfShaft,0);
  shape.lineTo( halfShaft,shaftLength);
  shape.lineTo( halfHead,shaftLength);
  shape.lineTo(0,shaftLength+headLength);
  shape.lineTo(-halfHead,shaftLength);
  shape.lineTo(-halfShaft,shaftLength);
  shape.closePath();

  const arrow=new THREE.Mesh(new THREE.ShapeGeometry(shape),mat);
  // ShapeGeometry лежит в XY; поворачиваем её в XZ, чтобы стрелка указывала
  // от фасада наружу. Для настенных модулей опускаем её на 35 мм ниже нижней
  // кромки — визуально она отделена от корпуса и не сливается с фасадом.
  arrow.rotation.x=Math.PI/2;
  arrow.position.set(0, m.wallMount==='wall' ? -.035 : .012, depth+.11);
  arrow.castShadow=false;
  arrow.receiveShadow=false;
  arrow.renderOrder=20;
  arrow.userData.uiOnly=true;
  g.add(arrow);

  applyWallTransform(g,item);
  return g;
}

function tagModuleMeshes(g,uid){
  g.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;o.userData.itemId=uid;}});
}
function addBox(group,w,h,d,x,y,z,mat,part){
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);
  mesh.position.set(x,y,z);mesh.userData.part=part;
  // Countertop decor must keep a believable real-world scale.
  // Store the actual worktop footprint so the texture loader can calculate
  // repeat values from the source image aspect ratio instead of squeezing
  // or tiling the image a fixed 2.2 times on every module.
  if(part==='worktop') configureCountertopTextureScale(mat,w,d);
  if(part==='facade') configureFacadeTextureScale(mat,w,h);
  group.add(mesh);return mesh;
}

function createFacadeMaterial(materialId){
  const def=FACADE_MATERIALS.find(m=>m.id===materialId)||FACADE_MATERIALS[0];
  return createDecorMaterial(def,'facade');
}

function createCountertopMaterial(materialId){
  const def=getCountertopMaterial(materialId);
  return createDecorMaterial(def,'countertop');
}

function createDecorMaterial(def,usage){
  const mat=new THREE.MeshStandardMaterial({color:0xffffff,roughness:def.roughness ?? (usage==='countertop'?.5:.68)});
  mat.userData.decorDef=def;
  mat.userData.decorUsage=usage;
  // Always start with a local procedural fallback so the constructor remains usable offline.
  mat.map=getProceduralDecorTexture(def,usage);
  mat.color.set(0xffffff);

  // If the manufacturer exposes a real decor image, try to replace the fallback asynchronously.
  // Cross-origin restrictions are handled gracefully: on error the procedural texture remains.
  if(def?.texture && typeof THREE!=='undefined'){
    try{
      const loader=new THREE.TextureLoader();
      if(loader.setCrossOrigin) loader.setCrossOrigin('anonymous');
      loader.load(def.texture,(tex)=>{
        if(usage==='backsplash' && mat.userData.disposed){tex.dispose();return;}
        if(usage==='backsplash' && mat.map)mat.map.dispose();
        tex.wrapS=tex.wrapT=THREE.RepeatWrapping;
        applyDecorTextureScale(tex,mat,def,usage);
        if('colorSpace' in tex && THREE.SRGBColorSpace){tex.colorSpace=THREE.SRGBColorSpace;}
        else if(THREE.sRGBEncoding){tex.encoding=THREE.sRGBEncoding;}
        if(renderer?.capabilities?.getMaxAnisotropy) tex.anisotropy=Math.min(renderer.capabilities.getMaxAnisotropy(),8);
        mat.map=tex;
        mat.needsUpdate=true;
      },undefined,()=>{});
    }catch(e){}
  }
  return mat;
}

function configureCountertopTextureScale(mat,w,d){
  if(!mat?.userData) return;
  mat.userData.worktopFootprint={w,d};
  if(mat.map){
    applyDecorTextureScale(mat.map,mat,mat.userData.decorDef||{},'countertop');
    mat.map.needsUpdate=true;
  }
}

function configureFacadeTextureScale(mat,w,h){
  if(!mat?.userData) return;
  // Keep one physical decor scale across all fronts. Previously every door
  // displayed the entire source image, so a 300 mm upper door squeezed the
  // same amount of pattern into half the width of a 600 mm lower front.
  mat.userData.facadeFootprint={w,h};
  if(mat.map){
    applyDecorTextureScale(mat.map,mat,mat.userData.decorDef||{},'facade');
    mat.map.needsUpdate=true;
  }
}

function applyDecorTextureScale(tex,mat,def,usage){
  if(!tex) return;
  tex.wrapS=tex.wrapT=THREE.RepeatWrapping;
  if(usage==='backsplash'){
    applyBacksplashTextureScale(tex,mat,def);
    return;
  }
  if(usage==='facade'){
    const footprint=mat?.userData?.facadeFootprint;
    // 0.545 m reproduces the already approved look of the ~600 mm lower front
    // (the previous default was repeatX=1.1 there). Narrower doors now show a
    // proportionally smaller crop instead of compressing the whole texture.
    const physicalWidth=def.texturePhysicalWidth||.545;
    const repeatX=footprint?Math.max(.08,footprint.w/physicalWidth):1.1;
    tex.repeat.set(repeatX,1);
    const off=def.facadeTextureOffset||[0,0];
    tex.offset.set(off[0]||0,off[1]||0);
    return;
  }
  if(usage!=='countertop'){
    tex.repeat.set(1.1,1);
    return;
  }

  const footprint=mat?.userData?.worktopFootprint;
  if(!footprint){
    // Temporary value used until the material is attached to a worktop mesh.
    tex.repeat.set(.45,.60);
    return;
  }

  // Treat the source decor as a large physical slab rather than a small tile.
  // One source-image height corresponds to ~1 metre by default; width follows
  // the real image aspect ratio. This preserves proportions and gives large,
  // calm marble veins instead of several repeated mini-patterns per cabinet.
  const image=tex.image;
  const iw=image?.naturalWidth||image?.videoWidth||image?.width||0;
  const ih=image?.naturalHeight||image?.videoHeight||image?.height||0;
  const aspect=(iw>0&&ih>0)?iw/ih:(def.textureAspect||1.45);
  const physicalHeight=def.texturePhysicalHeight||1.0;
  const physicalWidth=physicalHeight*aspect;
  const repeatX=Math.max(.08,footprint.w/physicalWidth);
  const repeatY=Math.max(.08,footprint.d/physicalHeight);
  tex.repeat.set(repeatX,repeatY);

  const off=def.textureOffset||[0,0];
  tex.offset.set(off[0]||0,off[1]||0);
}

function getProceduralDecorTexture(def,usage){
  const c=document.createElement('canvas');c.width=256;c.height=256;
  const x=c.getContext('2d');
  x.fillStyle=def.color||'#aaa';x.fillRect(0,0,256,256);
  const rgb=hexRgb(def.color||'#aaaaaa');
  if(def.type==='wood' || def.category==='wood'){
    for(let i=0;i<38;i++){
      const y=(i*23+13)%256;
      x.strokeStyle=`rgba(${Math.max(0,rgb[0]-35)},${Math.max(0,rgb[1]-30)},${Math.max(0,rgb[2]-25)},${.08+(i%4)*.025})`;
      x.lineWidth=1+(i%3)*.45;x.beginPath();x.moveTo(0,y);
      for(let xx=0;xx<=256;xx+=16)x.lineTo(xx,y+Math.sin((xx+i*11)/28)*5);
      x.stroke();
    }
  }else if(['stone','industrial','dark','fantasy'].includes(def.type)||['stone','industrial','dark','fantasy'].includes(def.category)){
    for(let i=0;i<36;i++){
      x.fillStyle=`rgba(255,255,255,${.018+(i%5)*.008})`;
      x.beginPath();x.arc((i*71)%256,(i*43)%256,3+(i%11),0,Math.PI*2);x.fill();
    }
    for(let i=0;i<12;i++){
      x.strokeStyle=`rgba(40,40,40,${.025+(i%3)*.018})`;x.lineWidth=.8+(i%2);x.beginPath();
      x.moveTo(-20,(i*31)%256);x.bezierCurveTo(70,(i*17)%256,180,(i*53)%256,280,(i*29)%256);x.stroke();
    }
  }
  const tex=new THREE.CanvasTexture(c);tex.wrapS=tex.wrapT=THREE.RepeatWrapping;tex.repeat.set(usage==='countertop'?.6:1.1,usage==='countertop'?.6:1);
  if('colorSpace' in tex && THREE.SRGBColorSpace){tex.colorSpace=THREE.SRGBColorSpace;}else if(THREE.sRGBEncoding){tex.encoding=THREE.sRGBEncoding;}
  return tex;
}

function hexRgb(hex){
  const h=hex.replace('#','');const n=parseInt(h.length===3?h.split('').map(c=>c+c).join(''):h,16);return[(n>>16)&255,(n>>8)&255,n&255];
}

function createWoodTexture(base){
  const c=document.createElement('canvas');c.width=256;c.height=256;
  const ctx=c.getContext('2d');ctx.fillStyle=base;ctx.fillRect(0,0,256,256);
  const grad=ctx.createLinearGradient(0,0,256,0);grad.addColorStop(0,'rgba(255,255,255,.05)');grad.addColorStop(.5,'rgba(0,0,0,.05)');grad.addColorStop(1,'rgba(255,255,255,.04)');ctx.fillStyle=grad;ctx.fillRect(0,0,256,256);
  ctx.lineWidth=1;
  for(let i=0;i<42;i++){
    const y=(i*6+Math.sin(i*1.7)*3)%256;ctx.strokeStyle=`rgba(75,48,25,${.035+(i%5)*.01})`;ctx.beginPath();
    for(let x=0;x<=256;x+=8){const yy=y+Math.sin(x*.055+i)*1.8+Math.sin(x*.013+i*.7)*3;if(x===0)ctx.moveTo(x,yy);else ctx.lineTo(x,yy)}ctx.stroke();
  }
  const tex=new THREE.CanvasTexture(c);tex.wrapS=tex.wrapT=THREE.RepeatWrapping;tex.repeat.set(1.15,1);tex.colorSpace=THREE.SRGBColorSpace;tex.anisotropy=Math.min(renderer.capabilities.getMaxAnisotropy(),8);return tex;
}

function applyWallTransform(g,item){
  const W=state.room.width*MM,D=state.room.depth*MM;
  const y=(item.elevation||0)*MM;
  if(item.wallId==='north'){g.position.set(item.coord,y,-D/2);g.rotation.y=0;}
  if(item.wallId==='south'){g.position.set(item.coord,y, D/2);g.rotation.y=Math.PI;}
  if(item.wallId==='west'){g.position.set(-W/2,y,item.coord);g.rotation.y=Math.PI/2;}
  if(item.wallId==='east'){g.position.set( W/2,y,item.coord);g.rotation.y=-Math.PI/2;}
}

/* ================= 3D DRAG ================= */
function onPointerDown(e){
  if(e.button!==0)return;
  setPointer(e);raycaster.setFromCamera(pointer,camera);
  const meshes=[];modulesGroup.traverseVisible(o=>{if(o.isMesh)meshes.push(o)});
  const hit=raycaster.intersectObjects(meshes,false)[0];
  if(!hit){state.selectedId=null;refreshSelectionBox();refreshDirectionArrow();updateSidebar();return;}
  const id=hit.object.userData.itemId,item=findItem(id),m=getModule(item.moduleId,item);
  state.selectedId=id;refreshSelectionBox();refreshDirectionArrow();updateSidebar();
  revealSelectedSettings();
  // Keep the actual grab point: projecting a click on the countertop down to
  // the floor shifts the pointer towards a different wall near a corner.
  const obj=getModuleObject(id);
  const localHit=obj.worldToLocal(hit.point.clone());
  drag={
    id,
    floorGrabPlane:m.wallMount==='floor'?new THREE.Plane(new THREE.Vector3(0,1,0),-hit.point.y):null,
    grabLocalX:localHit.x,
    grabDepth:Math.max(0,localHit.z),
    start:{wallId:item.wallId,coord:item.coord,elevation:item.elevation||0},
    lastValid:{wallId:item.wallId,coord:item.coord,elevation:item.elevation||0},
    grabYOffset:m.wallMount==='wall' ? hit.point.y-(item.elevation||0)*MM : 0,
    valid:true
  };
  controls.enabled=false;
  renderer.domElement.setPointerCapture(e.pointerId);
  dragStatus.classList.remove('hidden');
}

function onPointerMove(e){
  if(!drag)return;
  setPointer(e);raycaster.setFromCamera(pointer,camera);
  const item=findItem(drag.id),m=getModule(item.moduleId,item);
  const pFloor=new THREE.Vector3();
  const isFloor=m.wallMount==='floor';
  const hasFloor=raycaster.ray.intersectPlane(isFloor?drag.floorGrabPlane:floorPlane,pFloor);
  let wallId=item.wallId;
  if(hasFloor) wallId=floorWallForPoint(pFloor,item.wallId,isFloor?drag.grabDepth:0);
  item.wallId=wallId;

  if(m.wallMount==='wall'){
    const wallTarget=intersectAvailableWallRay(item.wallId);
    if(wallTarget){
      wallId=wallTarget.wallId;
      item.wallId=wallId;
      item.coord=(wallId==='north'||wallId==='south')?wallTarget.point.x:wallTarget.point.z;
      const rawElevation=(wallTarget.point.y-drag.grabYOffset)/MM;
      item.elevation=snapElevation(item,m,rawElevation);
    }
  }else if(hasFloor){
    const sign=wallId==='south'||wallId==='west'?-1:1;
    item.coord=((wallId==='north'||wallId==='south')?pFloor.x:pFloor.z)-sign*drag.grabLocalX;
  }

  item.coord=snapCoord(item,m);
  clampItemToWall(item);
  const obj=getModuleObject(item.uid);applyWallTransform(obj,item);obj.updateMatrixWorld(true);
  refreshWorktopSpans();
  refreshBacksplash();
  if(directionArrowsGroup && state.selectedId===item.uid && directionArrowsGroup.children[0]){
    applyWallTransform(directionArrowsGroup.children[0],item);
    directionArrowsGroup.children[0].updateMatrixWorld(true);
  }
  const valid=!hasCollision(item.uid);
  drag.valid=valid;
  if(valid)drag.lastValid={wallId:item.wallId,coord:item.coord,elevation:item.elevation||0};
  setInvalidVisual(obj,!valid);
  dragStatus.textContent=valid?'Положение допустимо':'Здесь модуль пересекается с другим';
  dragStatus.classList.toggle('invalid',!valid);
  refreshSelectionBox();updateSidebar();
}

function onPointerUp(){
  if(!drag)return;
  const item=findItem(drag.id);
  if(!drag.valid){
    item.wallId=drag.lastValid.wallId;item.coord=drag.lastValid.coord;item.elevation=drag.lastValid.elevation;
  }
  drag=null;controls.enabled=true;dragStatus.classList.add('hidden');dragStatus.classList.remove('invalid');
  rebuildModules();saveLocal();
}

function intersectWallRay(wallId){
  const W=state.room.width*MM,D=state.room.depth*MM;
  let plane;
  if(wallId==='north') plane=new THREE.Plane(new THREE.Vector3(0,0,1),D/2);
  if(wallId==='south') plane=new THREE.Plane(new THREE.Vector3(0,0,1),-D/2);
  if(wallId==='west') plane=new THREE.Plane(new THREE.Vector3(1,0,0),W/2);
  if(wallId==='east') plane=new THREE.Plane(new THREE.Vector3(1,0,0),-W/2);
  const hit=new THREE.Vector3();return raycaster.ray.intersectPlane(plane,hit)?hit:null;
}
function getHiddenWallIdByCamera(){
  if(!camera) return 'south';
  const x=camera.position.x,z=camera.position.z;
  if(Math.abs(z)>=Math.abs(x)) return z>=0?'south':'north';
  return x>=0?'east':'west';
}
function isPointOnWallArea(wallId,point,tolerance=.02){
  const W=state.room.width*MM,D=state.room.depth*MM,H=state.room.height*MM;
  if(point.y < -tolerance || point.y > H + tolerance) return false;
  if(wallId==='north' || wallId==='south') return point.x >= -W/2-tolerance && point.x <= W/2+tolerance;
  return point.z >= -D/2-tolerance && point.z <= D/2+tolerance;
}
function intersectAvailableWallRay(preferredWallId){
  const hidden=getHiddenWallIdByCamera();
  const candidates=[];
  ['north','south','west','east'].forEach((wallId)=>{
    if(wallId===hidden) return;
    const point=intersectWallRay(wallId);
    if(!point || !isPointOnWallArea(wallId,point,.03)) return;
    const distance=raycaster.ray.origin.distanceTo(point);
    const score=distance + (wallId===preferredWallId ? -0.05 : 0);
    candidates.push({wallId,point:point.clone(),score});
  });
  candidates.sort((a,b)=>a.score-b.score);
  if(candidates[0]) return candidates[0];
  if(preferredWallId){
    const point=intersectWallRay(preferredWallId);
    if(point) return {wallId:preferredWallId,point:point.clone(),score:0};
  }
  return null;
}

function wallDistancesForPoint(p){
  const W=state.room.width*MM,D=state.room.depth*MM;
  return [
    {id:'north',dist:Math.abs(p.z+D/2)}, {id:'south',dist:Math.abs(p.z-D/2)},
    {id:'west',dist:Math.abs(p.x+W/2)}, {id:'east',dist:Math.abs(p.x-W/2)}
  ];
}

function nearestWallForPoint(p){
  const list=wallDistancesForPoint(p);
  list.sort((a,b)=>a.dist-b.dist);return list[0];
}

function floorWallForPoint(p,currentWallId,grabDepth=0){
  // Compare the pointer to the depth at which the user actually grabbed the
  // module, not to the bare wall. This matters for a 600 mm worktop at a corner.
  const list=wallDistancesForPoint(p).map(w=>({...w,score:Math.abs(w.dist-grabDepth)})).sort((a,b)=>a.score-b.score);
  const nearest=list[0];
  const current=list.find(w=>w.id===currentWallId);
  const hysteresis=.18;
  if(current && current.score<=nearest.score+hysteresis) return current.id;
  return nearest.id;
}

function snapCoord(item,m){
  const half=placementWidthMM(m)*MM/2,threshold=.13;
  const limit=Math.max(0,wallLength(item.wallId)/2-half);
  const raw=item.coord;
  const base=clamp(Math.round(raw/.05)*.05,-limit,limit);
  const candidates=[];
  const y0=item.elevation||0,y1=y0+m.height;
  for(const o of state.items){
    if(o.uid===item.uid||o.wallId!==item.wallId)continue;
    const om=getModule(o.moduleId,o);
    // Floor and hanging rows must not pull each other sideways. Separate
    // hanging rows at different elevations must not compete either.
    if(!om||om.wallMount!==m.wallMount)continue;
    const oy=o.elevation||0;
    if(m.wallMount==='wall'&&Math.min(y1,oy+om.height)-Math.max(y0,oy)<=0)continue;
    const oh=placementWidthMM(om)*MM/2;
    for(const t of [o.coord+oh+half,o.coord-oh-half]){
      if(t<-limit-1e-9||t>limit+1e-9)continue;
      const distance=Math.abs(raw-t);
      if(distance<=threshold+1e-9)candidates.push({t:clamp(t,-limit,limit),distance});
    }
  }
  // Evaluate the closest real joint first. The old sequential snap could
  // overwrite a correct joint with a different one or pull outside the wall.
  candidates.sort((a,b)=>a.distance-b.distance);
  for(const {t} of candidates){
    item.coord=t;
    // Worktop spans are computed with this candidate in place; touching
    // neighbours lose their inner 9 mm overhangs before collision checking.
    if(!hasCollision(item.uid)){item.coord=raw;return t;}
  }
  item.coord=raw;
  return base;
}
function snapElevation(item,m,rawMm){
  const {min,max}=getElevationBounds(m);
  let e=Math.round(rawMm/10)*10;
  const standard=clamp(m.defaultElevation||DEFAULT_UPPER_ELEVATION,min,max);
  if(Math.abs(e-standard)<70)e=standard;
  state.items.filter(o=>o.uid!==item.uid&&o.wallId===item.wallId&&getModule(o.moduleId,o)?.wallMount==='wall').forEach(o=>{
    if(Math.abs(e-(o.elevation||0))<55)e=o.elevation||0;
  });
  return clamp(e,min,max);
}

function getElevationBounds(m){
  const ceilingMax=Math.max(0,state.room.height-m.height);
  const preferredMin=m.minElevation ?? 600;
  const min=Math.min(preferredMin,ceilingMax);
  return {min,max:ceilingMax};
}

function clampItemToWall(item){
  const m=getModule(item.moduleId,item),half=placementWidthMM(m)*MM/2;
  const len=(item.wallId==='north'||item.wallId==='south')?state.room.width*MM:state.room.depth*MM;
  item.coord=half>len/2?0:clamp(item.coord,-len/2+half,len/2-half);
  if(m.wallMount==='wall'){
    const {min,max}=getElevationBounds(m);
    item.elevation=Math.round(clamp(item.elevation ?? m.defaultElevation ?? DEFAULT_UPPER_ELEVATION,min,max));
  }else item.elevation=0;
}

function validateRoomAppliances(previousRoom,previousPositions){
  if(!state.items.some(i=>getModule(i.moduleId,i).isAppliance&&hasCollision(i.uid)))return true;
  state.room=previousRoom;
  state.items.forEach((i,n)=>Object.assign(i,previousPositions[n]));
  syncRoomFields();showToast('Размеры помещения не изменены','Освободите место для техники с учётом её монтажных зазоров.');return false;
}
function hasCollision(uid){
  const item=findItem(uid);if(!item)return false;
  const m=getModule(item.moduleId,item);
  if(m.isAppliance&&!fitsRoom(m,state.room,item.wallId))return true;
  const boxes=logicalCollisionBoxes(item);
  for(const other of state.items){
    if(other.uid===uid)continue;
    const otherBoxes=logicalCollisionBoxes(other);
    if(boxes.some(a=>otherBoxes.some(b=>a.intersectsBox(b))))return true;
  }
  return false;
}
function logicalCollisionBoxes(item){
  const m=getModule(item.moduleId,item),W=placementWidthMM(m)*MM,H=placementHeightMM(m)*MM;
  const roomW=state.room.width*MM,roomD=state.room.depth*MM,y=(item.elevation||0)*MM;
  // Coordinates match applyWallTransform. Shrink by just 0.05 mm to allow exact butt joints.
  const make=(w,h,d,x,z,yCenter)=>{
    const c=item.coord, side=item.wallId==='south'||item.wallId==='west'?-1:1;
    let center,size;
    if(item.wallId==='north'){center=new THREE.Vector3(c+x,yCenter,-roomD/2+z);size=new THREE.Vector3(w,h,d);}
    if(item.wallId==='south'){center=new THREE.Vector3(c-x,yCenter,roomD/2-z);size=new THREE.Vector3(w,h,d);}
    if(item.wallId==='west'){center=new THREE.Vector3(-roomW/2+z,yCenter,c+side*x);size=new THREE.Vector3(d,h,w);}
    if(item.wallId==='east'){center=new THREE.Vector3(roomW/2-z,yCenter,c+side*x);size=new THREE.Vector3(d,h,w);}
    return new THREE.Box3().setFromCenterAndSize(center,size).expandByScalar(-.00005);
  };
  const D=installedFrontMM(m)*MM;
  const boxes=[make(W,H,D,0,D/2,y+H/2)];
  if(m.worktop){
    const span=getLowerWorktopSpan(item,m),t=COUNTERTOP_THICKNESS*MM;
    boxes.push(make(span.width,t,WORKTOP_DEPTH,span.offsetX,WORKTOP_DEPTH/2,y+H+t/2));
  }
  return boxes;
}
function setInvalidVisual(obj,invalid){
  obj.traverse(o=>{if(o.isMesh){o.material.transparent=invalid;o.material.opacity=invalid?.62:1;}});
}
function setPointer(e){
  const r=renderer.domElement.getBoundingClientRect();
  pointer.x=((e.clientX-r.left)/r.width)*2-1;pointer.y=-((e.clientY-r.top)/r.height)*2+1;
}

/* ================= SIDEBAR ================= */
function refreshSelectionBox(){
  const o=getModuleObject(state.selectedId);
  if(o){selectionBox.setFromObject(o);selectionBox.visible=true;}else selectionBox.visible=false;
}

// Scroll only the desktop sidebar, never the 3D canvas or the whole page.
// Called on explicit selection/add, not on continuous drag or field updates.
function revealSelectedSettings(){
  const panel=document.querySelector('.panel-left');
  const section=document.getElementById('selected-module-section');
  if(!panel?.getBoundingClientRect||!section?.getBoundingClientRect||panel.scrollHeight<=panel.clientHeight+1)return;
  const p=panel.getBoundingClientRect(),s=section.getBoundingClientRect();
  const top=p.top+panel.clientTop+12,bottom=p.top+panel.clientTop+panel.clientHeight-12;
  if(s.top<top||s.top+Math.min(s.height,160)>bottom){
    panel.scrollTop+=s.top-top;
  }
}

function updateSidebar(){
  const furniture=state.items.filter(i=>!getModule(i.moduleId,i).isAppliance);
  const count=furniture.length,moduleTotal=furniture.reduce((s,i)=>s+getModule(i.moduleId,i).price,0);
  const order=getWorktopOrder();
  const quote=calculateDiscount(moduleTotal,state.orderWorktop?order.cost:0,currentPromo,furniture.map(i=>getModule(i.moduleId,i)));
  const total=quote.total;
  const promoBox=document.getElementById('active-promo');
  const promoActive=Boolean(currentPromo?.active);
  promoBox.classList.toggle('hidden',!promoActive);
  document.getElementById('active-promo-percent').textContent=promoActive?`−${currentPromo.percent}%`:'';
  document.getElementById('active-promo-name').textContent=promoActive?currentPromo.name:'';
  document.getElementById('active-promo-target').textContent=promoActive?(currentPromo.target==='furniture'?'На мебель':currentPromo.target==='worktop'?'На столешницы':currentPromo.target==='category'?('На категорию: '+(MODULE_CATEGORIES.find(c=>c.id===currentPromo.scope)?.label||currentPromo.scope)):currentPromo.target==='article'?('На '+(CATALOG.find(m=>m.id===currentPromo.scope)?.sku||currentPromo.scope)):'На весь заказ'):'';
  const promoPeriod=document.getElementById('active-promo-period');
  const periodText=formatPromoPeriod(currentPromo);
  promoPeriod.textContent=periodText;
  promoPeriod.classList.toggle('hidden',!periodText);
  syncCountertopUI();
  syncWorktopOrderUI(order);
  document.getElementById('module-count').textContent=count;
  document.getElementById('total-price').textContent=fmt.format(total)+' ₽';

  const empty=document.getElementById('selection-empty');
  const sel=document.getElementById('selection');
  const settingsEmpty=document.getElementById('module-settings-empty');
  const settings=document.getElementById('module-settings');
  const heightSetting=document.getElementById('module-height-setting');
  const floorNote=document.getElementById('floor-module-note');
  const elevationRow=document.getElementById('selection-elevation-row');
  const item=findItem(state.selectedId);

  if(item){
    const m=getModule(item.moduleId,item);

    const appliance=m.isAppliance===true;
    document.getElementById('appliance-settings').classList.toggle('hidden',!appliance);
    document.getElementById('furniture-facade-setting').classList.toggle('hidden',appliance);
    document.querySelector('.selection-color-row').classList.toggle('hidden',appliance);
    document.getElementById('selection-depth-label').textContent=appliance?'Глубина техники':'Глубина корпуса';
    document.getElementById('delete-selected').textContent=appliance?'Удалить технику':'Удалить модуль';
    if(appliance)syncApplianceFields(item,m);
    // Правая панель — только характеристики.
    empty.classList.add('hidden');
    sel.classList.remove('hidden');
    document.getElementById('selection-name').textContent=m.name;
    document.getElementById('selection-meta').textContent=appliance?`Ш${m.width} × Г${m.depth} × В${m.height} мм · Только для планирования`:`${m.sku} · арт. ${m.id} · Ш${m.width} × Г${moduleDepthMM(m)} × В${m.height} мм · ${fmt.format(m.price)} ₽`;
    document.getElementById('selection-depth').textContent=m.depth+' мм';
    document.getElementById('selection-installed-depth').textContent=(m.worktop?WORKTOP_DEPTH_MM:installedFrontMM(m))+' мм';
    document.getElementById('selection-mount').textContent=m.wallMount==='wall'?'Настенный':'Напольный';
    const matDef=getFacadeMaterial(item.materialId);
    document.getElementById('selection-color-name').textContent=matDef.name;
    document.getElementById('selection-color-dot').style.background=matDef.color;
    document.getElementById('selection-wall').textContent=WALL_NAMES[item.wallId];
    document.getElementById('selection-offset').textContent=Math.round((item.coord+wallLength(item.wallId)/2)*1000)+' мм от края';
    if(m.wallMount==='wall'){
      elevationRow.classList.remove('hidden');
      document.getElementById('selection-elevation').textContent=Math.round(item.elevation||0)+' мм';
    }else{
      elevationRow.classList.add('hidden');
    }

    // Левая панель — только изменяемые параметры и действия.
    settingsEmpty.classList.add('hidden');
    settings.classList.remove('hidden');
    document.getElementById('module-settings-name').textContent=appliance?m.name:`${m.name} · ${m.sku}`;
    syncSelectedMaterialUI();
    if(m.wallMount==='wall'){
      heightSetting.classList.remove('hidden');
      floorNote.classList.add('hidden');
      const input=document.getElementById('selection-height');
      const bounds=getElevationBounds(m);
      input.min=String(bounds.min);
      input.max=String(bounds.max);
      input.value=String(Math.round(item.elevation||0));
      input.title=`Допустимый диапазон: ${bounds.min}–${bounds.max} мм`;
    }else{
      heightSetting.classList.add('hidden');
      floorNote.classList.toggle('hidden',appliance);
    }
  }else{
    empty.classList.remove('hidden');
    sel.classList.add('hidden');
    settingsEmpty.classList.remove('hidden');
    settings.classList.add('hidden');
    heightSetting.classList.add('hidden');
    floorNote.classList.add('hidden');
    elevationRow.classList.add('hidden');
    syncSelectedMaterialUI();
  }

  const spec=document.getElementById('spec');
  if(!count){spec.innerHTML='<div class="empty-state">Смета пока пуста.</div>';return;}
  const groups=new Map();furniture.forEach(i=>{const m=getModule(i.moduleId,i);groups.set(m.id,(groups.get(m.id)||0)+1)});
  let html='';groups.forEach((q,id)=>{const m=getModule(id);html+=`<div class="spec-row"><div><b>${m.sku}</b><small class="spec-article">Арт. ${m.id}</small><small>По прайсу: ${m.width}×${m.depth}×${m.height} мм · ×${q}</small><small>Габаритная глубина: ${moduleDepthMM(m)} мм</small></div><b>${fmt.format(m.price*q)} ₽</b></div>`});
  if(state.orderWorktop&&order.lines.length){
    const decor=getCountertopMaterial(state.countertopMaterialId);
    html+=`<div class="worktop-spec"><div class="spec-row worktop-subtotal"><div>Модули</div><b>${fmt.format(moduleTotal)} ₽</b></div><div class="worktop-spec-title">Столешница СКИФ</div><small>${decor.code?'№ '+decor.code+' ':''}${decor.name} · ${WORKTOP_DEPTH_MM} × ${COUNTERTOP_THICKNESS} мм</small><small>Длина в проекте: ${fmt.format(order.length)} мм</small>`;
    for(const line of order.lines){html+=`<div class="spec-row"><div><b>${line.length} мм · ×${line.quantity}</b><small>${fmt.format(line.price)} ₽ / шт.</small></div><b>${fmt.format(line.cost)} ₽</b></div>`;}
    html+=`<div class="spec-row worktop-subtotal"><div>Столешница, всего</div><b>${fmt.format(order.cost)} ₽</b></div><small>Предварительные цены. Пропил 4 мм учтён в раскрое; услуги распила и обработки торцов не включены.</small></div>`;
  }else if(order.length){
    html+=`<div class="worktop-spec"><small>Столешница не включена в стоимость.</small></div>`;
  }
  if(quote.saving>0)html+=`<div class="promo-summary"><div class="spec-row promo-saving"><span>Скидка ${currentPromo.percent}%</span><b>−${fmt.format(quote.saving)} ₽</b></div><div class="spec-row promo-row-old promo-row-old-bottom"><span>Без скидки</span><b class="old-price">${fmt.format(quote.base)} ₽</b></div></div>`;
  html+=`<div class="spec-total"><span>Итого</span><span>${fmt.format(total)} ₽</span></div>`;spec.innerHTML=html;
}

function syncApplianceFields(item,m){
  const limits=applianceLimits(m);
  for(const k of APPLIANCE_FIELDS){const el=document.getElementById('appliance-'+k);el.min=limits[k][0];el.max=limits[k][1];if(document.activeElement!==el||el.dataset.item!==item.uid)el.value=m[k];el.dataset.item=item.uid;}
  document.getElementById('appliance-reserved').textContent=`Место под технику: ${placementWidthMM(m)} × ${m.depth+m.backGap} × ${placementHeightMM(m)} мм`;
}
function applyApplianceFields(){
  const item=findItem(state.selectedId);if(!item||drag)return;
  const base=getModule(item.moduleId);if(!base.isAppliance)return;
  const old=item.appliance,oldCoord=item.coord;
  const raw=Object.fromEntries(APPLIANCE_FIELDS.map(k=>[k,document.getElementById('appliance-'+k).value]));
  const limits=applianceLimits(base);
  if(APPLIANCE_FIELDS.some(k=>raw[k]===''||!Number.isFinite(Number(raw[k]))||Number(raw[k])<limits[k][0]||Number(raw[k])>limits[k][1])){showToast('Проверьте размеры','Введите значения в допустимом диапазоне.');return;}
  item.appliance=normalizeAppliance(base,raw);clampItemToWall(item);
  if(hasCollision(item.uid)){
    item.appliance=old;item.coord=oldCoord;
    for(const k of APPLIANCE_FIELDS)document.getElementById('appliance-'+k).value=getModule(item.moduleId,item)[k];
    showToast('Размеры не применены','Техника с указанными зазорами не помещается. Освободите место и повторите.');return;
  }
  for(const k of APPLIANCE_FIELDS)document.getElementById('appliance-'+k).value=item.appliance[k];
  rebuildModules();saveLocal();showToast('Размеры применены','Габариты техники обновлены.');
}
function applySelectedHeightFromField(){
  const item=findItem(state.selectedId);if(!item)return;
  const m=getModule(item.moduleId,item);if(m.wallMount!=='wall')return;
  const old=item.elevation||m.defaultElevation||DEFAULT_UPPER_ELEVATION;
  const raw=+document.getElementById('selection-height').value;
  const {min,max}=getElevationBounds(m);
  item.elevation=Math.round(clamp(raw,min,max));
  if(hasCollision(item.uid)){
    item.elevation=old;
    showToast('Высота не применена','На этой высоте модуль пересекается с другим элементом.');
  }else if(raw>max){
    showToast('Высота скорректирована',`Модуль ограничен потолком. Максимальный низ: ${max} мм.`);
  }else if(raw<min){
    showToast('Высота скорректирована',`Минимальная высота для этого модуля: ${min} мм.`);
  }else{
    showToast('Высота применена',`Низ модуля: ${item.elevation} мм от пола.`);
  }
  rebuildModules();saveLocal();
}

function onDeleteKey(e){
  if(e.key!=='Delete'||e.defaultPrevented||e.repeat||e.isComposing||e.ctrlKey||e.metaKey||e.altKey||e.shiftKey) return;
  if(state.mode!=='modules'||drag||!findItem(state.selectedId)) return;
  if(!document.getElementById('material-modal').classList.contains('hidden')) return;
  // Delete must retain its ordinary behavior in form controls and editable text.
  const target=e.target;
  if(target?.isContentEditable||target?.closest?.('input,textarea,select,[role="textbox"],[role="combobox"]')) return;
  e.preventDefault();
  deleteSelected();
}

function deleteSelected(){
  if(!state.selectedId)return;state.items=state.items.filter(i=>i.uid!==state.selectedId);state.selectedId=null;rebuildModules();saveLocal();
}

/* ================= HELPERS / PERSISTENCE ================= */
function updateRoomLabel(){
  document.getElementById('room-label').textContent=`Комната ${state.room.width} × ${state.room.depth} × ${state.room.height} мм`;
  syncRoomFields();
}
function wallLength(id){return (id==='north'||id==='south')?state.room.width*MM:state.room.depth*MM;}
function getModule(id,item){
  const appliance=APPLIANCES.find(m=>m.id===id);
  return appliance?{...appliance,...normalizeAppliance(appliance,item?.appliance)}:CATALOG.find(m=>m.id===id);
}
function findItem(uid){return state.items.find(i=>i.uid===uid)||null;}
function getModuleObject(uid){return modulesGroup?.children.find(c=>c.userData.itemId===uid)||null;}
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function clearGroup(g){
  while(g.children.length){
    const o=g.children.pop();
    o.traverse?.(x=>{if(x.geometry)x.geometry.dispose?.();});
  }
}


function openMaterialModal(type){
  if(type==='facade' && (!findItem(state.selectedId)||getModule(findItem(state.selectedId).moduleId).isAppliance)){
    showToast('Сначала выберите модуль','Нажмите на модуль в 3D, затем выберите фасад.');
    return;
  }
  materialModalType=type;
  materialModalCategory='all';
  materialModalSearch='';
  const search=document.getElementById('material-search'); if(search) search.value='';
  const modal=document.getElementById('material-modal');
  modal.classList.remove('hidden'); modal.setAttribute('aria-hidden','false');
  document.body.classList.add('material-modal-open');
  renderMaterialModal();
  setTimeout(()=>search?.focus(),50);
}
function closeMaterialModal(){
  const modal=document.getElementById('material-modal');
  modal.classList.add('hidden'); modal.setAttribute('aria-hidden','true');
  document.body.classList.remove('material-modal-open');
  materialModalType=null;
}
function materialCategoryDefs(type){
  return type==='facade'
    ? [
        ['all','Все'],['wood','Древесные'],['fantasy','Фентезийные'],['solid','Фоновые']
      ]
    : [
        ['all','Все'],['light','Светлые'],['stone','Камень и мрамор'],['wood','Дерево'],['industrial','Бетон и индустриальные'],['dark','Тёмные'],['color','Цветные']
      ];
}
function materialMatchesSearch(m,q){
  if(!q) return true;
  return `${m.code||''} ${m.name||''} ${m.supplier||''}`.toLowerCase().includes(q);
}
function renderMaterialModal(){
  if(!materialModalType) return;
  const isPanel=materialModalType==='backsplash';
  const isTop=materialModalType==='countertop'||isPanel;
  const title=document.getElementById('material-modal-title');
  const sub=document.getElementById('material-modal-subtitle');
  title.textContent=isPanel?'Выберите декор стеновой панели':isTop?'Выберите столешницу':'Выберите фасад';
  sub.textContent=isPanel?'СКИФ · декоры из каталога столешниц · наличие панели уточняется':isTop?'СКИФ · каталог декоров':'Томлесдрев · ЛДСП';

  const categories=materialCategoryDefs(materialModalType);
  const catWrap=document.getElementById('material-category-chips');
  catWrap.innerHTML=categories.map(([id,label])=>`<button type="button" class="material-filter-chip${materialModalCategory===id?' active':''}" data-material-category="${id}">${label}</button>`).join('');
  catWrap.querySelectorAll('[data-material-category]').forEach(btn=>{
    btn.onclick=()=>{materialModalCategory=btn.dataset.materialCategory;renderMaterialModal();};
  });

  let list=(isTop?AVAILABLE_COUNTERTOPS:FACADE_MATERIALS).filter(m=>{
    if(materialModalCategory!=='all' && m.category!==materialModalCategory) return false;
    return materialMatchesSearch(m,materialModalSearch);
  });

  const currentId=isPanel?getBacksplashMaterial().id:isTop?state.countertopMaterialId:(findItem(state.selectedId)?.materialId||state.materialId);
  const count=document.getElementById('material-modal-count');
  count.textContent=`Найдено: ${list.length}`;
  const grid=document.getElementById('material-modal-grid');
  if(!list.length){
    grid.innerHTML='<div class="material-modal-empty">В этой категории нет декоров с выбранными параметрами.</div>';
    return;
  }
  grid.innerHTML=list.map(m=>{
    const meta=isTop
      ? `${m.code?'№ '+m.code+' · ':''}${m.supplier}`
      : `${m.supplier} · ЛДСП`;
    const details=isTop&&!isPanel ? [
      m.collection,
      m.surface,
      m.embossing ? `тиснение: ${m.embossing}` : null,
      m.length ? `${m.length} мм` : null,
      m.widths?.length ? `ширина ${m.widths.join('/')} мм` : null,
      m.specDetails?.replace(/ · (?:6\/16\/25\/38\/60|6\/38) мм/g,'') || null
    ].filter(Boolean).join(' · ') : '';
    const badges=[];
    if(m.texture) badges.push('<span>Реальная текстура</span>');
    if(m.isNew) badges.push('<span>Новинка</span>');
    if(m.exclusive) badges.push('<span>Эксклюзив</span>');
    if(m.length4200&&!isPanel) badges.push('<span>4,2 м</span>');
    return `<button type="button" class="material-card${m.id===currentId?' active':''}" data-material-id="${m.id}">
      <i class="material-card-preview"></i>
      <span class="material-card-info"><b>${isTop && m.code?'№ '+m.code+' — ':''}${m.name}</b><small>${meta}</small>${details?`<small class="material-card-details">${details}</small>`:''}${badges.length?`<em>${badges.join('')}</em>`:''}</span>
      <span class="material-card-check">✓</span>
    </button>`;
  }).join('');
  grid.querySelectorAll('[data-material-id]').forEach(card=>{
    const materialId=card.dataset.materialId;
    const material=(isTop?AVAILABLE_COUNTERTOPS:FACADE_MATERIALS).find(m=>m.id===materialId);
    const preview=card.querySelector('.material-card-preview');
    if(preview && material) preview.style.background=previewCss(material);
    card.onclick=()=>selectMaterialFromModal(materialId);
  });
}
function selectMaterialFromModal(id){
  if(materialModalType==='backsplash'){
    if(!setBacksplashMaterial(id))return;
    closeMaterialModal();
    showToast('Декор стеновой панели выбран',getBacksplashMaterial().name);
    return;
  }
  if(materialModalType==='facade'){
    const item=findItem(state.selectedId); if(!item||getModule(item.moduleId,item).isAppliance) return;
    item.materialId=id; state.materialId=id;
    document.getElementById('facade-select').value=id;
    syncSelectedMaterialUI(); rebuildModules(); saveLocal();
    closeMaterialModal();
    showToast('Фасад выбран',getFacadeMaterial(id).name);
    return;
  }
  if(materialModalType==='countertop'){
    const def=AVAILABLE_COUNTERTOPS.find(m=>m.id===id);
    if(!def) return;
    state.countertopMaterialId=id;
    document.getElementById('countertop-select').value=id;
    syncCountertopUI(); rebuildModules(); saveLocal();
    closeMaterialModal();
    showToast('Столешница выбрана',`${def.code?'№ '+def.code+' — ':''}${def.name}`);
  }
}

function getFacadeMaterial(materialId){
  return FACADE_MATERIALS.find(m=>m.id===materialId)||FACADE_MATERIALS[0];
}
function getCountertopMaterial(materialId){
  return AVAILABLE_COUNTERTOPS.find(m=>m.id===materialId)||AVAILABLE_COUNTERTOPS[0];
}
function previewCss(def){
  const c=def?.color||'#aaa';
  if(def?.texture) return `url("${def.texture}") center / cover no-repeat, ${c}`;
  if(def?.type==='wood'||def?.category==='wood') return `linear-gradient(100deg,rgba(255,255,255,.10),rgba(0,0,0,.06)),repeating-linear-gradient(6deg,${c} 0 8px,rgba(60,35,20,.10) 9px 10px,${c} 12px 21px)`;
  if(['stone','industrial','dark','fantasy'].includes(def?.type)||['stone','industrial','dark','fantasy'].includes(def?.category)) return `radial-gradient(circle at 25% 30%,rgba(255,255,255,.22),transparent 22%),radial-gradient(circle at 70% 60%,rgba(0,0,0,.10),transparent 28%),${c}`;
  return c;
}
function renderFacadeOptions(){
  const sel=document.getElementById('facade-select'); if(!sel)return;
  const cat=document.getElementById('facade-category').value;
  const item=findItem(state.selectedId); const current=item?.materialId || state.materialId;
  const list=FACADE_MATERIALS.filter(m=>cat==='all'||m.category===cat);
  sel.innerHTML=list.map(m=>`<option value="${m.id}">${m.name}</option>`).join('');
  if(list.some(m=>m.id===current))sel.value=current;
  sel.disabled=!item;
}
function renderCountertopOptions(ensureCompatible=false){
  const sel=document.getElementById('countertop-select'); if(!sel)return;
  const cat=document.getElementById('countertop-category').value;
  const list=AVAILABLE_COUNTERTOPS.filter(m=>cat==='all'||m.category===cat);
  if(!list.length){sel.innerHTML='<option value="">Нет подходящих декоров</option>';sel.disabled=true;return;}
  sel.disabled=false;
  if(ensureCompatible && !list.some(m=>m.id===state.countertopMaterialId)) state.countertopMaterialId=list[0].id;
  sel.innerHTML=list.map(m=>`<option value="${m.id}">${m.code?'№ '+m.code+' — ':''}${m.name}</option>`).join('');
  if(list.some(m=>m.id===state.countertopMaterialId))sel.value=state.countertopMaterialId; else sel.value=list[0].id;
  if(!list.some(m=>m.id===state.countertopMaterialId)) state.countertopMaterialId=sel.value;
  syncCountertopUI();
}
function syncSelectedMaterialUI(){
  const item=findItem(state.selectedId);
  const furnitureSelected=item&&!getModule(item.moduleId,item).isAppliance;
  const def=furnitureSelected?getFacadeMaterial(item.materialId):getFacadeMaterial(state.materialId);
  const name=document.getElementById('material-name');if(name)name.textContent=item?def.name:'Выберите модуль, чтобы изменить фасад';
  const preview=document.getElementById('facade-preview');if(preview)preview.style.background=previewCss(def);
  const sel=document.getElementById('facade-select');if(sel){sel.disabled=!furnitureSelected;if(furnitureSelected && [...sel.options].some(o=>o.value===item.materialId))sel.value=item.materialId;}
  const all=document.getElementById('apply-facade-all');if(all)all.disabled=!furnitureSelected;
  const open=document.getElementById('facade-open');if(open)open.disabled=!furnitureSelected;
}
function getWorktopOrder(){
  const runs=layoutWorktopRuns(state.items,state.room,getModule,getLowerWorktopSpan);
  if(!state.orderWorktop)return {runs,lines:[],length:runs.reduce((s,r)=>s+r.length,0),cost:0};
  const key=JSON.stringify(runs.map(r=>[r.wallId,r.level,r.length,r.joints]));
  if(worktopPlanCache.has(key))return worktopPlanCache.get(key);
  const order=calculateWorktopOrder(runs,currentStockPrices);
  if(worktopPlanCache.size>=64)worktopPlanCache.delete(worktopPlanCache.keys().next().value);
  worktopPlanCache.set(key,order);return order;
}
function syncWorktopOrderUI(order=getWorktopOrder()){
  const enabled=state.orderWorktop;
  document.getElementById('toggle-worktop-order').setAttribute('aria-pressed',String(enabled));
  document.getElementById('worktop-order-note').textContent=enabled?'Заготовки подбираются по всему проекту. Остатки используются повторно. Цены предварительные.':'Столешница отображается в проекте, но не входит в стоимость гарнитура.';
  document.getElementById('project-worktop-order-status').textContent=enabled?(order.lines.length?'Включён в смету':'Нет нижних модулей'):'Не включён';
  const root=document.getElementById('worktop-order-preview');
  root.classList.toggle('hidden',!enabled);
  root.replaceChildren();
  if(!enabled)return;
  if(!order.lines.length){root.textContent='Добавьте нижние модули для расчёта.';return;}
  for(const line of order.lines){const row=document.createElement('div');row.className='worktop-order-row';const a=document.createElement('span');a.textContent=`${line.quantity} × ${line.length} мм`;const b=document.createElement('b');b.textContent=`${fmt.format(line.cost)} ₽`;row.append(a,b);root.append(row);}
  const sum=document.createElement('div');sum.className='worktop-order-row worktop-order-total';const label=document.createElement('span');label.textContent='Столешница';const value=document.createElement('b');value.textContent=`${fmt.format(order.cost)} ₽`;sum.append(label,value);root.append(sum);
}

function syncCountertopUI(){
  const def=getCountertopMaterial(state.countertopMaterialId);
  const n=document.getElementById('countertop-name');if(n)n.textContent=`${def.code?'№ '+def.code+' ':''}${def.name}`;
  const m=document.getElementById('countertop-meta');if(m)m.textContent=`${def.supplier} · ${COUNTERTOP_THICKNESS} мм`;
  const p=document.getElementById('countertop-preview');if(p)p.style.background=previewCss(def);
  const rn=document.getElementById('project-countertop-name');if(rn)rn.textContent=`${def.code?'№ '+def.code+' ':''}${def.name}`;
  syncBacksplashUI();
}

function saveLocal(){
  try{localStorage.setItem('slavnaya-kitchen-mvp',JSON.stringify({room:state.room,materialId:state.materialId,countertopMaterialId:state.countertopMaterialId,countertopThickness:COUNTERTOP_THICKNESS,orderWorktop:state.orderWorktop,items:state.items,nextId:state.nextId,mode:state.mode,moduleTab:state.moduleTab,moduleSearch:state.moduleSearch,catalogSelections:state.catalogSelections,showFacades:state.showFacades,showDimensions:state.showDimensions,backsplashEnabled:state.backsplashEnabled,backsplashOverStove:state.backsplashOverStove,backsplashHeight:state.backsplashHeight,backsplashMaterialId:state.backsplashMaterialId}));}catch(e){}
}
function restoreLocal(){
  try{
    const raw=localStorage.getItem('slavnaya-kitchen-mvp');if(!raw)return;
    const data=JSON.parse(raw);if(data.room)state.room={...state.room,...data.room};
    if(FACADE_MATERIALS.some(m=>m.id===data.materialId))state.materialId=data.materialId;
    if(AVAILABLE_COUNTERTOPS.some(m=>m.id===data.countertopMaterialId))state.countertopMaterialId=data.countertopMaterialId;
    if(Array.isArray(data.items)){
      state.items=data.items.filter(i=>getModule(i.moduleId,i)).map(i=>{
        const m=getModule(i.moduleId,i);
        const materialId=FACADE_MATERIALS.some(mat=>mat.id===i.materialId) ? i.materialId : (data.materialId || FACADE_MATERIALS[0].id);
        return {...i,...(m.isAppliance?{appliance:normalizeAppliance(m,i.appliance)}:{}),materialId,elevation:m.wallMount==='wall'?(i.elevation ?? m.defaultElevation ?? DEFAULT_UPPER_ELEVATION):0};
      });
    }
    state.orderWorktop=data.orderWorktop===true;
    if(typeof data.showFacades==='boolean')state.showFacades=data.showFacades;
    if(typeof data.showDimensions==='boolean')state.showDimensions=data.showDimensions;
    if(typeof data.backsplashEnabled==='boolean')state.backsplashEnabled=data.backsplashEnabled;
    state.backsplashOverStove=data.backsplashOverStove===true;
    if(data.backsplashHeight!==undefined)state.backsplashHeight=normalizePanelHeight(data.backsplashHeight);
    state.backsplashMaterialId=AVAILABLE_COUNTERTOPS.some(m=>m.id===data.backsplashMaterialId)?data.backsplashMaterialId:null;
    syncViewToggles();
    if(typeof data.moduleSearch === 'string') state.moduleSearch=data.moduleSearch;
    if(data.catalogSelections && typeof data.catalogSelections==='object') state.catalogSelections={...data.catalogSelections};
    state.nextId=data.nextId||1;if(data.mode)state.mode=data.mode;if(data.moduleTab)state.moduleTab=data.moduleTab;
    syncRoomFields();renderModuleTabs();renderCatalog();
    const moduleSearchInput=document.getElementById('module-search');
    if(moduleSearchInput) moduleSearchInput.value=state.moduleSearch || '';
    renderFacadeOptions();renderCountertopOptions(true);
    syncSelectedMaterialUI();syncCountertopUI();
  }catch(e){console.warn('Не удалось восстановить локальный проект',e)}
}

function updateWallVisibility(immediate=false){
  if(!walls.length||!camera)return;
  const x=camera.position.x,z=camera.position.z;
  let nearest;
  if(Math.abs(z)>=Math.abs(x)) nearest=z>=0?'south':'north';
  else nearest=x>=0?'east':'west';
  for(const w of walls){
    const hidden=w.id===nearest;
    const target=hidden?.025:1,edgeTarget=hidden?.01:.25;
    if(immediate){w.mesh.material.opacity=target;w.edges.material.opacity=edgeTarget;}
    else{
      w.mesh.material.opacity+=(target-w.mesh.material.opacity)*.14;
      w.edges.material.opacity+=(edgeTarget-w.edges.material.opacity)*.14;
    }
    w.mesh.material.depthWrite=!hidden;
  }
  const label=document.getElementById('wall-label');
  if(label)label.textContent=`Скрыта ближайшая стена: ${WALL_NAMES[nearest].toLowerCase()}`;
}

function onResize(){
  if(!renderer)return;
  const r=viewport.parentElement.getBoundingClientRect();
  const w=Math.max(1,r.width),h=Math.max(1,r.height);
  camera.aspect=w/h;camera.updateProjectionMatrix();renderer.setSize(w,h);
}
function animate(){requestAnimationFrame(animate);controls.update();updateWallVisibility();renderer.render(scene,camera);renderModuleDimensions();}

/* ================= VIEW OPTIONS ================= */
function applyFacadeVisibility(){
  if(!modulesGroup)return;
  modulesGroup.traverse(o=>{
    if(o.isMesh && (o.userData.part==='facade'||o.userData.part==='handle')) o.visible=state.showFacades;
  });
}
function syncViewToggles(){
  document.getElementById('toggle-facades').setAttribute('aria-pressed',String(state.showFacades));
  document.getElementById('toggle-dimensions').setAttribute('aria-pressed',String(state.showDimensions));
  dimensionSvg.classList.toggle('hidden',!state.showDimensions);
  dimensionFrameKey='';
  if(!state.showDimensions)dimensionSvg.replaceChildren();
}
function dimensionEl(tag,attrs,text){
  const el=document.createElementNS(SVG_NS,tag);
  for(const [key,value] of Object.entries(attrs||{}))el.setAttribute(key,String(value));
  if(text!==undefined)el.textContent=String(text);
  return el;
}
function projectDimensionPoint(wallId,p,w,h){
  const world=wallPoint(wallId,p,state.room);
  const v=new THREE.Vector3(...world).project(camera);
  if(!Number.isFinite(v.x)||!Number.isFinite(v.y)||!Number.isFinite(v.z)||v.z < -1||v.z > 1)return null;
  return {x:(v.x+1)*w/2,y:(1-v.y)*h/2};
}
function drawProjectedDimension(root,dim,w,h){
  const project=p=>projectDimensionPoint(dim.wallId,p,w,h);
  const a=project(dim.a),b=project(dim.b);
  if(!a||!b)return;
  const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);
  if(len<4)return; // near edge-on; rotate camera to read the true measurement
  if(Math.max(a.x,b.x)<-30||Math.min(a.x,b.x)>w+30||Math.max(a.y,b.y)<-30||Math.min(a.y,b.y)>h+30)return;
  const ux=dx/len,uy=dy/len;
  let nx=-uy,ny=ux;
  const mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
  // Label on the outside of the dimension line, even when the camera looks from the opposite side.
  const outside=project(dim.outside);
  if(outside && (outside.x-mid.x)*nx+(outside.y-mid.y)*ny<0){nx=-nx;ny=-ny;}
  const g=dimensionEl('g',{'data-dimension':dim.kind,'data-module-ids':dim.ids.join(',' )});
  const line=(p,q,cls)=>g.appendChild(dimensionEl('line',{x1:p.x,y1:p.y,x2:q.x,y2:q.y,class:cls}));
  for(const [p,q] of dim.extensions){const pp=project(p),qq=project(q);if(pp&&qq)line(pp,qq,'module-dim-ext');}
  line(a,b,'module-dim-line');
  const tipSize=Math.min(6,len*.24),half=tipSize*.34;
  const arrow=(tip,sign)=>{
    const x=tip.x+sign*ux*tipSize,y=tip.y+sign*uy*tipSize;
    const pts=`${tip.x},${tip.y} ${x-uy*half},${y+ux*half} ${x+uy*half},${y-ux*half}`;
    g.appendChild(dimensionEl('polygon',{points:pts,class:'module-dim-arrow'}));
  };
  arrow(a,1);arrow(b,-1);
  let angle=Math.atan2(dy,dx)*180/Math.PI;
  if(angle>90)angle-=180;if(angle< -90)angle+=180;
  const tx=mid.x+nx*10,ty=mid.y+ny*10;
  g.appendChild(dimensionEl('text',{x:tx,y:ty,transform:`rotate(${angle} ${tx} ${ty})`,class:'module-dim-label'},dim.value));
  root.appendChild(g);
}
function renderModuleDimensions(){
  if(!state.showDimensions||state.mode!=='modules'||!camera||!renderer)return;
  const w=viewport.clientWidth,h=viewport.clientHeight;if(!w||!h)return;
  // During camera damping or dragging, reproject the same real wall coordinates.
  // No dimension meshes enter the furniture scene, raycaster, collision checks or price calculation.
  const key=[w,h,...camera.matrixWorld.elements,...camera.projectionMatrix.elements,state.room.width,state.room.depth,state.room.height,...state.items.map(i=>`${i.uid}/${i.moduleId}/${i.wallId}/${i.coord}/${i.elevation}/${JSON.stringify(i.appliance||null)}`)].join('|');
  if(key===dimensionFrameKey)return;
  dimensionFrameKey=key;
  dimensionSvg.setAttribute('viewBox',`0 0 ${w} ${h}`);
  const fragment=document.createDocumentFragment();
  const dims=layoutModuleDimensions(state.items,state.room,getModule,COUNTERTOP_THICKNESS);
  for(const dim of dims)drawProjectedDimension(fragment,dim,w,h);
  dimensionSvg.replaceChildren(fragment);
}
