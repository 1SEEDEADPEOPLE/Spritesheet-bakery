import * as THREE from 'three';
import { GLTFLoader }    from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader }   from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

// ══════════════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════════════
let loadedScene = null, loadedName = '', currentGlbBlob = null;
let mixer = null, clips = [], selClipIdx = -1, liveAnim = false;
let bakeResMode = 'square'; // 'square' | 'custom'
let bakeWidth = 1024, bakeHeight = 1024, doCrop = true, exposure = 1.0;

// Scene objects: freestanding duplicated/placed models (extra soldiers, tiled ground pieces)
let sceneObjects = []; // {id,name,glbBlob,root,clips,mixer,selClipIdx,animMode,phaseOffset,posX,posY,posZ,rotX,rotY,rotZ,scale}
let sceneObjIdCounter = 0;
let selectedSceneObjId = null;
let sceneObjStep = 0.5, sceneObjRotStep = 15;
let dupAxis = 'z', dupDir = 1, dupAmount = 2.5;

let bakeMode = 'anim'; // 'anim' | 'manual'

let posOffX = 0, posOffY = 0, posOffZ = 0, posStep = 0.25;
let rotYaw = 0, rotPitch = 0, rotRoll = 0, snapStep = 10;
let anchorX = 0, anchorY = 0, anchorZ = 0, anchorStep = 0.25;
let groundOffset = new THREE.Vector3();

let isOrtho = true, loopOn = true, bgIdx = 0;
let previewMode = false, gridVisBeforePreview = true;
let liveFilterOn = false, lastPreviewMs = 0;

let playerFrames = [], playerIdx = 0, playerPlaying = false;
let playerFps = 12, playerRafId = null, playerLastMs = 0;

let filterType = 'none';
let pixelSize=48, pixelLevels=6, pixelOutline=false;
let gbDark='#0f380f', gbLight='#9bbc0f';
let bitDark='#000000', bitLight='#ffffff';
let silColor='#080604';
let comicLevels=4, comicEdge=28;
let celBands=4, celInkWidth=2, celHatch='off', celSat=1.6;
let sumieInk=0.65, sumieWash=20;
let ps1Chunk=4, ps1Bits=5, ps1Dither=true;
let neonDark='#05003c', neonLight='#00f0ff', neonBloom=1.0, neonScanlines=true;

let layoutMode = 'auto', layoutCustomCols = 8;

// Attachments (weapons/gear parented to soldier bones)
let soldierBones = new Map(); // boneName -> THREE.Bone
let attachments = []; // {id, name, glbBlob, root, boneName, posX,posY,posZ, rotX,rotY,rotZ, scale}
let attachIdCounter = 0;
let selectedAttachmentId = null;
let attachPosStep = 0.05, attachRotStep = 15;
let soldierRestHeight = 2; // captured at model load — see onGLTFLoaded

// Layered animation blend (legs from one clip, upper body from another)
let blendEnabled = false;
let blendLowerIdx = null, blendUpperIdx = null, blendSplitBone = null;
let blendLowerFilteredClip = null, blendUpperFilteredClip = null;
let blendLowerAction = null, blendUpperAction = null;

let manualFrames = [];
let frameIdCounter = 0;
let captureLocked = false;

const BGSETTINGS = [
  {color:'#0f0f0f',label:'DARK'},{color:'#1a1f2e',label:'NIGHT'},{color:'#262626',label:'MID'}
];

// ══════════════════════════════════════════════════════════════════════════
// RENDERER / SCENE / CAMERAS
// ══════════════════════════════════════════════════════════════════════════
const renderer = new THREE.WebGLRenderer({antialias:true, alpha:true, preserveDrawingBuffer:false});
renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('viewport').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(BGSETTINGS[0].color);
scene.add(new THREE.AmbientLight(0xffffff,0.55));
const sun = new THREE.DirectionalLight(0xffffff,1.15);
sun.position.set(4,9,5); sun.castShadow=true;
sun.shadow.mapSize.set(1024,1024);
sun.shadow.camera.near=0.1; sun.shadow.camera.far=30;
sun.shadow.camera.left=sun.shadow.camera.bottom=-5;
sun.shadow.camera.right=sun.shadow.camera.top=5;
scene.add(sun);
const fillLight = new THREE.DirectionalLight(0x5577bb,0.35);
fillLight.position.set(-3,3,-4); scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xffeecc,0.18);
rimLight.position.set(0,-2,-5); scene.add(rimLight);
const grid = new THREE.GridHelper(18,36,0x1a1a1a,0x141414);
scene.add(grid);

const pivot = new THREE.Group();
scene.add(pivot);

const anchorMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.045, 12, 12),
  new THREE.MeshBasicMaterial({color:0x00ff88})
);
anchorMarker.visible = false;
pivot.add(anchorMarker);

// Marker showing the currently-selected attachment's bone location
const boneMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.035, 10, 10),
  new THREE.MeshBasicMaterial({color:0x00ccff})
);
boneMarker.visible = false;

const perspCam = new THREE.PerspectiveCamera(45,1,0.01,300);
const orthoCam = new THREE.OrthographicCamera(-2,2,2,-2,0.01,300);
perspCam.position.set(0,1.5,4); orthoCam.position.set(0,1.5,4);
let cam = orthoCam;
const controls = new OrbitControls(cam, renderer.domElement);
controls.enableDamping=true; controls.dampingFactor=0.08;
controls.screenSpacePanning=true;
controls.target.set(0,0.8,0); controls.update();
const clock = new THREE.Clock();

// ══════════════════════════════════════════════════════════════════════════
// RESIZE
// ══════════════════════════════════════════════════════════════════════════
function resize(){
  const el=document.getElementById('viewport');
  const w=el.clientWidth, h=el.clientHeight;
  if(!w||!h) return;
  renderer.setSize(w,h,false);
  perspCam.aspect=w/h; perspCam.updateProjectionMatrix(); syncOrtho();
  updateFrameGuide();
}
function syncOrtho(){
  const el=document.getElementById('viewport');
  const w=el.clientWidth, h=el.clientHeight;
  if(!w||!h) return;
  const dist=Math.max(0.01,cam.position.distanceTo(controls.target));
  const hH=dist*Math.tan(THREE.MathUtils.degToRad(22.5))/orthoCam.zoom;
  orthoCam.top=hH; orthoCam.bottom=-hH;
  orthoCam.left=-hH*(w/h); orthoCam.right=hH*(w/h);
  orthoCam.updateProjectionMatrix();
}
function updateFrameGuide(){
  const el=document.getElementById('viewport');
  const w=el.clientWidth, h=el.clientHeight;
  const aspect=bakeWidth/bakeHeight;
  const margin=0.94;
  let rw,rh;
  if(aspect>=w/h){ rw=w*margin; rh=rw/aspect; if(rh>h*margin){ rh=h*margin; rw=rh*aspect; } }
  else { rh=h*margin; rw=rh*aspect; if(rw>w*margin){ rw=w*margin; rh=rw/aspect; } }
  const fg=document.getElementById('frame-guide');
  fg.style.width=rw+'px'; fg.style.height=rh+'px';
  fg.style.left=((w-rw)/2)+'px'; fg.style.top=((h-rh)/2)+'px';
}
new ResizeObserver(resize).observe(document.getElementById('viewport'));
resize();

// ══════════════════════════════════════════════════════════════════════════
// RENDER LOOP
// ══════════════════════════════════════════════════════════════════════════
function tick(){
  if(!loopOn) return;
  requestAnimationFrame(tick);
  const dt=clock.getDelta();
  if(mixer&&liveAnim) mixer.update(dt);
  updateSceneObjectAnimations(dt);
  controls.update();
  if(isOrtho) syncOrtho();
  renderer.render(scene,cam);
  if(liveFilterOn && loadedScene){
    const now=performance.now();
    if(now-lastPreviewMs>150){ lastPreviewMs=now; updateLivePreview(); }
  }
}
tick();

// ══════════════════════════════════════════════════════════════════════════
// CAMERA / BG / PREVIEW TOGGLES
// ══════════════════════════════════════════════════════════════════════════
document.getElementById('cam-btn').addEventListener('click',()=>{
  const pos=cam.position.clone(), tgt=controls.target.clone(), zoom=cam.zoom;
  isOrtho=!isOrtho; cam=isOrtho?orthoCam:perspCam;
  cam.position.copy(pos); cam.zoom=zoom;
  controls.object=cam; controls.target.copy(tgt); controls.update();
  document.getElementById('cam-btn').textContent=isOrtho?'ORTHO':'PERSP';
  document.getElementById('cam-btn').classList.toggle('on',!isOrtho);
  syncOrtho();
});
document.getElementById('bg-btn').addEventListener('click',()=>{
  bgIdx=(bgIdx+1)%BGSETTINGS.length;
  if(!previewMode) scene.background=new THREE.Color(BGSETTINGS[bgIdx].color);
  document.getElementById('bg-btn').textContent=BGSETTINGS[bgIdx].label;
});
document.getElementById('exp-slider').addEventListener('input',e=>{
  exposure=+e.target.value;
  renderer.toneMappingExposure=exposure;
  document.getElementById('exp-val').textContent=exposure.toFixed(2);
});

document.getElementById('preview-btn').addEventListener('click',()=>{
  previewMode=!previewMode;
  document.getElementById('preview-btn').classList.toggle('on',previewMode);
  document.getElementById('checker-bg').classList.toggle('show',previewMode);
  document.getElementById('frame-guide').classList.toggle('show',previewMode);
  if(previewMode){
    gridVisBeforePreview=grid.visible;
    grid.visible=false;
    scene.background=null;
  } else {
    grid.visible=gridVisBeforePreview;
    scene.background=new THREE.Color(BGSETTINGS[bgIdx].color);
  }
});

document.getElementById('live-filter-off').addEventListener('click',()=>{
  liveFilterOn=false; syncLiveBtns();
  document.getElementById('live-filter-canvas').classList.remove('show');
});
document.getElementById('live-filter-on').addEventListener('click',()=>{
  liveFilterOn=true; syncLiveBtns();
  document.getElementById('live-filter-canvas').classList.add('show');
});
function syncLiveBtns(){
  document.getElementById('live-filter-on').classList.toggle('on',liveFilterOn);
  document.getElementById('live-filter-off').classList.toggle('on',!liveFilterOn);
}

// ══════════════════════════════════════════════════════════════════════════
// MODE TOGGLE (ANIM / MANUAL)
// ══════════════════════════════════════════════════════════════════════════
document.getElementById('mode-anim').addEventListener('click',()=>{
  bakeMode='anim';
  document.getElementById('mode-anim').classList.add('on');
  document.getElementById('mode-manual').classList.remove('on');
  document.getElementById('manual-section').style.display='none';
  document.getElementById('frames-row').style.display='';
  anchorMarker.visible=false;
  updateAnimUIVisibility();
  if(blendEnabled) tryStartBlendPreview(); else playClip(selClipIdx);
});
document.getElementById('mode-manual').addEventListener('click',()=>{
  bakeMode='manual';
  document.getElementById('mode-manual').classList.add('on');
  document.getElementById('mode-anim').classList.remove('on');
  document.getElementById('manual-section').style.display='';
  document.getElementById('frames-row').style.display='none';
  anchorMarker.visible=!!loadedScene;
  // Blend is ANIM-only — manual mode needs a single clip to scrub through.
  if(blendEnabled){
    blendEnabled=false;
    document.getElementById('blend-off-btn').classList.add('on');
    document.getElementById('blend-on-btn').classList.remove('on');
    updateAnimUIVisibility();
    playClip(selClipIdx);
  }
  updateScrubVisibility();
});
function updateAnimUIVisibility(){
  document.getElementById('blend-toggle-row').style.display = bakeMode==='anim' ? '' : 'none';
  if(bakeMode==='manual'){
    document.getElementById('clip-row').style.display='';
    document.getElementById('blend-section').style.display='none';
  } else {
    document.getElementById('clip-row').style.display = blendEnabled ? 'none' : '';
    document.getElementById('blend-section').style.display = blendEnabled ? '' : 'none';
  }
}
function updateScrubVisibility(){
  const has = clips.length>0 && selClipIdx>=0;
  document.getElementById('scrub-row').style.display = (bakeMode==='manual' && has) ? '' : 'none';
}

// ══════════════════════════════════════════════════════════════════════════
// TRANSFORM: position offset + rotation anchor + rotation rig → pivot/model
// ══════════════════════════════════════════════════════════════════════════
function applyTransform(){
  if(!loadedScene) return;
  const anchor = new THREE.Vector3(anchorX,anchorY,anchorZ);
  const posOff = new THREE.Vector3(posOffX,posOffY,posOffZ);
  pivot.position.copy(groundOffset).add(posOff).add(anchor);
  loadedScene.position.copy(anchor).multiplyScalar(-1);
  pivot.rotation.set(
    THREE.MathUtils.degToRad(rotPitch),
    THREE.MathUtils.degToRad(rotYaw),
    THREE.MathUtils.degToRad(rotRoll),
    'YXZ'
  );
  const h=document.getElementById('cam-hud');
  const r=(rotYaw||rotPitch||rotRoll)?`Y:${rotYaw}° X:${rotPitch}° Z:${rotRoll}°  `:'';
  h.textContent=r+'DRAG · PINCH · SCROLL';
}
function updateRotDisplay(){
  document.getElementById('yaw-val').textContent=rotYaw+'°';
  document.getElementById('pitch-val').textContent=rotPitch+'°';
  document.getElementById('roll-val').textContent=rotRoll+'°';
}
function updateAnchorDisplay(){
  document.getElementById('anchor-x-val').textContent=anchorX.toFixed(2);
  document.getElementById('anchor-y-val').textContent=anchorY.toFixed(2);
  document.getElementById('anchor-z-val').textContent=anchorZ.toFixed(2);
}
function updatePosDisplay(){
  document.getElementById('pos-x-val').textContent=posOffX.toFixed(2);
  document.getElementById('pos-y-val').textContent=posOffY.toFixed(2);
  document.getElementById('pos-z-val').textContent=posOffZ.toFixed(2);
}

document.querySelectorAll('[data-pstep]').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('[data-pstep]').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); posStep=+b.dataset.pstep;
}));
document.querySelectorAll('[data-paxis]').forEach(btn=>btn.addEventListener('click',()=>{
  const dir=+btn.dataset.dir, ax=btn.dataset.paxis;
  if(ax==='x') posOffX=+((posOffX+posStep*dir).toFixed(3));
  if(ax==='y') posOffY=+((posOffY+posStep*dir).toFixed(3));
  if(ax==='z') posOffZ=+((posOffZ+posStep*dir).toFixed(3));
  applyTransform(); updatePosDisplay();
}));
document.getElementById('pos-reset').addEventListener('click',()=>{
  posOffX=posOffY=posOffZ=0; applyTransform(); updatePosDisplay();
});

document.querySelectorAll('[data-astep]').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('[data-astep]').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); anchorStep=+b.dataset.astep;
}));
document.querySelectorAll('[data-aaxis]').forEach(btn=>btn.addEventListener('click',()=>{
  const dir=+btn.dataset.dir, ax=btn.dataset.aaxis;
  if(ax==='x') anchorX=+((anchorX+anchorStep*dir).toFixed(3));
  if(ax==='y') anchorY=+((anchorY+anchorStep*dir).toFixed(3));
  if(ax==='z') anchorZ=+((anchorZ+anchorStep*dir).toFixed(3));
  applyTransform(); updateAnchorDisplay();
}));
document.getElementById('anchor-reset').addEventListener('click',()=>{
  anchorX=anchorY=anchorZ=0; applyTransform(); updateAnchorDisplay();
});

document.querySelectorAll('[data-axis]').forEach(btn=>btn.addEventListener('click',()=>{
  const dir=+btn.dataset.dir;
  if(btn.dataset.axis==='y') rotYaw+=snapStep*dir;
  if(btn.dataset.axis==='x') rotPitch+=snapStep*dir;
  if(btn.dataset.axis==='z') rotRoll+=snapStep*dir;
  applyTransform(); updateRotDisplay();
}));
document.getElementById('rot-reset').addEventListener('click',()=>{
  rotYaw=rotPitch=rotRoll=0; applyTransform(); updateRotDisplay();
});
document.querySelectorAll('[data-snap]').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('[data-snap]').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); snapStep=+b.dataset.snap;
}));

// ══════════════════════════════════════════════════════════════════════════
// GLTF LOAD
// ══════════════════════════════════════════════════════════════════════════
const draco=new DRACOLoader();
draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/libs/draco/gltf/');
const loader=new GLTFLoader(); loader.setDRACOLoader(draco);
const fbxLoader=new FBXLoader();

// Format detection so the same upload flow works for glTF/GLB and FBX (Mixamo's
// native export format) — returns a normalized {scene, animations} shape either
// way so nothing downstream needs to know which loader actually ran.
function detectFormat(name){
  return (name||'').split('.').pop().toLowerCase();
}
function loadGLBAsync(blob, nameHint){
  const ext=detectFormat(nameHint||blob.name||'');
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(blob);
    const cleanup=()=>URL.revokeObjectURL(url);
    if(ext==='fbx'){
      fbxLoader.load(url,obj=>{cleanup();resolve({scene:obj,animations:obj.animations||[]});},
        undefined,err=>{cleanup();reject(err);});
    } else {
      loader.load(url,gltf=>{cleanup();resolve({scene:gltf.scene,animations:gltf.animations||[]});},
        undefined,err=>{cleanup();reject(err);});
    }
  });
}
function loadFile(fileOrBlob, displayName){
  const name = displayName || fileOrBlob.name || 'model.glb';
  currentGlbBlob = fileOrBlob;
  loadGLBAsync(fileOrBlob, name).then(gltf=>onGLTFLoaded(name,gltf))
    .catch(err=>alert('Load failed: '+(err.message||err)));
}

function onGLTFLoaded(name,gltf){
  if(loadedScene) pivot.remove(loadedScene);
  if(mixer){mixer.stopAllAction();mixer=null;}
  loadedScene=gltf.scene; loadedName=name; clips=gltf.animations??[];
  loadedScene.traverse(n=>{if(n.isMesh){n.castShadow=true;n.receiveShadow=true;}});

  const box1=new THREE.Box3().setFromObject(loadedScene);
  const size1=box1.getSize(new THREE.Vector3());
  const maxD=Math.max(size1.x,size1.y,size1.z)||1;
  loadedScene.scale.setScalar(2/maxD);

  const box2=new THREE.Box3().setFromObject(loadedScene);
  const c2=box2.getCenter(new THREE.Vector3());
  groundOffset.set(-c2.x, -box2.min.y, -c2.z);

  rotYaw=rotPitch=rotRoll=0; posOffX=posOffY=posOffZ=0; anchorX=anchorY=anchorZ=0;
  pivot.rotation.set(0,0,0);
  updateRotDisplay(); updatePosDisplay(); updateAnchorDisplay();

  pivot.add(loadedScene);
  applyTransform();

  if(clips.length) mixer=new THREE.AnimationMixer(loadedScene);

  const box3=new THREE.Box3().setFromObject(loadedScene);
  const c3=box3.getCenter(new THREE.Vector3()),s3=box3.getSize(new THREE.Vector3());
  // Stable reference for weapon auto-scale: the model's actual Y-extent (height)
  // right after normalization — NOT the maxD used for the 2-unit scale target,
  // which is often wingspan-dominated on a T/A-pose rig and can be much larger
  // than true height. Captured once here so it doesn't drift with whatever
  // animation frame happens to be playing when an attachment is added later.
  soldierRestHeight = s3.y>0.0001 ? s3.y : 2;
  const d=Math.max(s3.x,s3.y,s3.z)*2.1;
  controls.target.copy(c3);
  const eye=new THREE.Vector3(c3.x,c3.y+s3.y*0.25,c3.z+d);
  orthoCam.position.copy(eye); perspCam.position.copy(eye);
  orthoCam.zoom=1; perspCam.zoom=1;
  controls.update(); syncOrtho();

  buildClipMenu();
  clearManualFrames();
  rebuildSoldierBones();
  clearAllAttachments();
  resetBlendState();
  clearAllSceneObjects();
  anchorMarker.visible = (bakeMode==='manual');

  document.getElementById('model-name').textContent=name;
  document.getElementById('upload-screen').classList.add('hidden');
  document.getElementById('scene-screen').classList.add('active');
  document.getElementById('bake-btn').disabled=false;
  resize();
}

function buildClipMenu(){
  const sel=document.getElementById('clip-sel');
  sel.innerHTML='<option value="-1">— static pose —</option>';
  clips.forEach((c,i)=>{
    const o=document.createElement('option');
    o.value=i; o.textContent=c.name||`Anim ${i+1}`; sel.appendChild(o);
  });
  if(clips.length){sel.value=0;playClip(0);}
  else{selClipIdx=-1;liveAnim=false;refreshPlayBtn();}
  updateScrubVisibility();
}
// Rebuilds the clip dropdown's option list only — unlike buildClipMenu(), this
// does NOT reset playback/selection. Used after importing extra clips so the
// currently playing/selected animation isn't interrupted.
function refreshClipMenuOptions(){
  const sel=document.getElementById('clip-sel');
  const prevValue=sel.value;
  sel.innerHTML='<option value="-1">— static pose —</option>';
  clips.forEach((c,i)=>{
    const o=document.createElement('option');
    o.value=i; o.textContent=c.name||`Anim ${i+1}`; sel.appendChild(o);
  });
  if(prevValue!==''&&+prevValue<clips.length){ sel.value=prevValue; }
  else if(clips.length){ sel.value=0; }
}
// Import animation clip(s) from a SEPARATE GLB that shares this soldier's rig
// (same bone names — e.g. both Mixamo-rigged). We only use the clip data from
// the imported file; its mesh/scene is discarded. Clips bind to the currently
// loaded skeleton purely by bone name, so this works across separate exports
// of the same character without needing a combined multi-clip GLB.
function importAnimationFile(file){
  if(!loadedScene){ alert('Load a soldier model first.'); return; }
  loadGLBAsync(file, file.name).then(gltf=>{
    const newClips=gltf.animations||[];
    if(!newClips.length){ alert(`"${file.name}" has no animation clips inside it.`); return; }
    let matched=0,total=0;
    newClips.forEach(c=>c.tracks.forEach(t=>{
      total++; if(soldierBones.has(t.name.split('.')[0])) matched++;
    }));
    if(total>0&&matched===0){
      const proceed=confirm(`"${file.name}" doesn't seem to match this model's skeleton — no bone names in its animation match this rig, so it likely won't move anything. Import anyway?`);
      if(!proceed) return;
    }
    newClips.forEach(c=>clips.push(c));
    refreshClipMenuOptions();
    if(blendEnabled) buildBlendMenus();
    alert(`Imported ${newClips.length} animation${newClips.length>1?'s':''} from "${file.name}".`);
  }).catch(err=>alert('Animation import failed: '+(err.message||err)));
}
document.getElementById('import-anim-btn').addEventListener('click',()=>document.getElementById('import-anim-input').click());
document.getElementById('import-anim-input').addEventListener('change',e=>{
  const f=e.target.files[0]; if(f) importAnimationFile(f); e.target.value='';
});
function playClip(idx){
  selClipIdx=idx;
  if(!mixer){liveAnim=false;refreshPlayBtn();updateScrubVisibility();return;}
  mixer.stopAllAction();
  if(idx>=0&&clips[idx]){mixer.clipAction(clips[idx]).reset().play();liveAnim=true;}
  else liveAnim=false;
  refreshPlayBtn();
  updateScrubVisibility();
  document.getElementById('time-scrub').value=0;
  document.getElementById('time-val').textContent='0%';
}
function refreshPlayBtn(){
  const btn=document.getElementById('play-btn');
  btn.textContent=liveAnim?'⏸':'▶';
  btn.classList.toggle('on',liveAnim);
}

// ══════════════════════════════════════════════════════════════════════════
// LAYERED ANIMATION BLEND — legs from one clip, upper body from another,
// split at a chosen bone. The two filtered clips drive disjoint bone sets
// so they can play back concurrently on the same mixer with no conflict.
// ══════════════════════════════════════════════════════════════════════════
function guessSpineBone(){
  const names=[...soldierBones.keys()];
  // Prefer the LOWEST spine bone (closest to hips) as the split point, since
  // "upper" = split bone + everything below it in the hierarchy (descendants).
  let hit=names.find(n=>/(^|[:_])spine$/i.test(n));
  if(hit) return hit;
  hit=names.find(n=>/spine/i.test(n));
  return hit||null;
}
function collectDescendantBoneNames(boneName){
  const result=new Set();
  const startBone=soldierBones.get(boneName);
  if(!startBone) return result;
  (function walk(obj){
    if(obj.isBone) result.add(obj.name);
    obj.children.forEach(walk);
  })(startBone);
  return result;
}
function filterClipTracks(clip,boneNameSet,tag){
  const tracks=clip.tracks.filter(t=>boneNameSet.has(t.name.split('.')[0]));
  return new THREE.AnimationClip((clip.name||'clip')+'_'+tag,clip.duration,tracks);
}
function rebuildBlendClips(){
  blendLowerFilteredClip=null; blendUpperFilteredClip=null;
  const lowerClip=clips[blendLowerIdx];
  const upperClip=clips[blendUpperIdx];
  if(!lowerClip||!upperClip||!blendSplitBone||!soldierBones.has(blendSplitBone)) return;
  const upperNames=collectDescendantBoneNames(blendSplitBone);
  const lowerNames=new Set([...soldierBones.keys()].filter(n=>!upperNames.has(n)));
  blendLowerFilteredClip=filterClipTracks(lowerClip,lowerNames,'lower');
  blendUpperFilteredClip=filterClipTracks(upperClip,upperNames,'upper');
}
function buildBlendMenus(){
  const lowerSel=document.getElementById('blend-lower-sel');
  const upperSel=document.getElementById('blend-upper-sel');
  lowerSel.innerHTML=''; upperSel.innerHTML='';
  clips.forEach((c,i)=>{
    const o1=document.createElement('option'); o1.value=i; o1.textContent=c.name||`Anim ${i+1}`; lowerSel.appendChild(o1);
    const o2=document.createElement('option'); o2.value=i; o2.textContent=c.name||`Anim ${i+1}`; upperSel.appendChild(o2);
  });
  if(blendLowerIdx==null||blendLowerIdx>=clips.length){
    const g=clips.findIndex(c=>/run|walk|jog|sprint/i.test(c.name||''));
    blendLowerIdx=g>=0?g:0;
  }
  if(blendUpperIdx==null||blendUpperIdx>=clips.length){
    const g=clips.findIndex(c=>/recoil|shoot|fire|aim/i.test(c.name||''));
    blendUpperIdx=g>=0?g:(clips.length>1?1:0);
  }
  lowerSel.value=blendLowerIdx; upperSel.value=blendUpperIdx;
  renderSplitBoneOptions('');
  if(!blendSplitBone||!soldierBones.has(blendSplitBone)){
    blendSplitBone=guessSpineBone();
  }
  document.getElementById('split-bone-sel').value=blendSplitBone||'';
}
function renderSplitBoneOptions(filter){
  const sel=document.getElementById('split-bone-sel');
  sel.innerHTML='';
  const f=(filter||'').toLowerCase();
  const names=[...soldierBones.keys()].sort();
  names.filter(n=>n.toLowerCase().includes(f)).forEach(n=>{
    const o=document.createElement('option'); o.value=n; o.textContent=n;
    sel.appendChild(o);
  });
  if(blendSplitBone) sel.value=blendSplitBone;
}
function tryStartBlendPreview(){
  if(!mixer||!blendEnabled) return;
  rebuildBlendClips();
  if(!blendLowerFilteredClip||!blendUpperFilteredClip){
    liveAnim=false; refreshBlendPlayBtn(); return;
  }
  mixer.stopAllAction();
  blendLowerAction=mixer.clipAction(blendLowerFilteredClip); blendLowerAction.reset().play();
  blendUpperAction=mixer.clipAction(blendUpperFilteredClip); blendUpperAction.reset().play();
  liveAnim=true;
  refreshBlendPlayBtn();
}
function refreshBlendPlayBtn(){
  const btn=document.getElementById('blend-play-btn');
  btn.textContent=liveAnim?'⏸':'▶';
  btn.classList.toggle('on',liveAnim);
}
function resetBlendState(){
  blendEnabled=false;
  blendLowerIdx=null; blendUpperIdx=null; blendSplitBone=null;
  blendLowerFilteredClip=null; blendUpperFilteredClip=null;
  blendLowerAction=null; blendUpperAction=null;
  document.getElementById('blend-off-btn').classList.add('on');
  document.getElementById('blend-on-btn').classList.remove('on');
  updateAnimUIVisibility();
}

document.getElementById('blend-off-btn').addEventListener('click',()=>{
  blendEnabled=false;
  document.getElementById('blend-off-btn').classList.add('on');
  document.getElementById('blend-on-btn').classList.remove('on');
  updateAnimUIVisibility();
  playClip(selClipIdx);
});
document.getElementById('blend-on-btn').addEventListener('click',()=>{
  if(clips.length<2){ alert('Need at least two animation clips loaded to blend.'); return; }
  blendEnabled=true;
  document.getElementById('blend-on-btn').classList.add('on');
  document.getElementById('blend-off-btn').classList.remove('on');
  updateAnimUIVisibility();
  buildBlendMenus();
  tryStartBlendPreview();
});
document.getElementById('blend-lower-sel').addEventListener('change',e=>{
  blendLowerIdx=+e.target.value;
  tryStartBlendPreview();
});
document.getElementById('blend-upper-sel').addEventListener('change',e=>{
  blendUpperIdx=+e.target.value;
  tryStartBlendPreview();
});
document.getElementById('split-bone-filter').addEventListener('input',e=>renderSplitBoneOptions(e.target.value));
document.getElementById('split-bone-sel').addEventListener('change',e=>{
  blendSplitBone=e.target.value;
  tryStartBlendPreview();
});
document.getElementById('blend-play-btn').addEventListener('click',()=>{
  if(!blendLowerAction||!blendUpperAction) return;
  liveAnim=!liveAnim;
  blendLowerAction.paused=!liveAnim;
  blendUpperAction.paused=!liveAnim;
  refreshBlendPlayBtn();
});

document.getElementById('clip-sel').addEventListener('change',e=>playClip(+e.target.value));
document.getElementById('play-btn').addEventListener('click',()=>{
  if(!mixer||selClipIdx<0) return;
  liveAnim=!liveAnim;
  const a=mixer.clipAction(clips[selClipIdx]); if(a) a.paused=!liveAnim;
  refreshPlayBtn();
});
document.getElementById('time-scrub').addEventListener('input',e=>{
  if(!mixer||selClipIdx<0) return;
  liveAnim=false; refreshPlayBtn();
  const clip=clips[selClipIdx];
  const frac=+e.target.value;
  const t=frac*clip.duration;
  mixer.stopAllAction();
  const a=mixer.clipAction(clip); a.reset().play(); mixer.update(t);
  loadedScene.updateMatrixWorld(true);
  document.getElementById('time-val').textContent=Math.round(frac*100)+'%';
});

// ══════════════════════════════════════════════════════════════════════════
// ATTACHMENTS — weapons/gear parented to soldier skeleton bones
// ══════════════════════════════════════════════════════════════════════════
function rebuildSoldierBones(){
  soldierBones = new Map();
  if(loadedScene){
    loadedScene.traverse(n=>{
      if(n.isSkinnedMesh && n.skeleton){
        n.skeleton.bones.forEach(b=>soldierBones.set(b.name,b));
      }
    });
  }
  document.getElementById('attachments-section').style.display = soldierBones.size>0 ? '' : 'none';
}
function guessHandBone(){
  const names=[...soldierBones.keys()];
  let hit=names.find(n=>/hand/i.test(n)&&/right/i.test(n));
  if(hit) return hit;
  hit=names.find(n=>/hand/i.test(n));
  return hit||null;
}
function getSelectedAttachment(){
  return attachments.find(a=>a.id===selectedAttachmentId)||null;
}
function applyAttachmentTransform(att){
  if(!att||!att.root) return;
  att.root.position.set(att.posX,att.posY,att.posZ);
  att.root.rotation.set(
    THREE.MathUtils.degToRad(att.rotX),
    THREE.MathUtils.degToRad(att.rotY),
    THREE.MathUtils.degToRad(att.rotZ)
  );
  att.root.scale.setScalar(att.scale);
}
function attachToBone(att,boneName){
  const bone=soldierBones.get(boneName);
  if(!bone||!att.root) return false;
  if(att.root.parent) att.root.parent.remove(att.root);
  bone.add(att.root);
  att.boneName=boneName;
  applyAttachmentTransform(att);
  return true;
}
function loadAttachmentFile(file){
  if(!loadedScene||soldierBones.size===0){ alert('Load a rigged soldier model first (needs a skeleton).'); return; }
  loadGLBAsync(file, file.name).then(gltf=>onAttachmentLoaded(file.name,file,gltf))
    .catch(err=>alert('Attachment load failed: '+(err.message||err)));
}
function onAttachmentLoaded(name,blob,gltf){
  const root=gltf.scene;
  root.traverse(n=>{if(n.isMesh){n.castShadow=true;n.receiveShadow=true;}});

  // Auto-fit an initial uniform scale so the weapon lands in a sane size
  // range next to the soldier. Raw GLB import scale varies a lot between
  // sources/tools — without this, a mismatched weapon can be effectively
  // invisible (microscopic or enormous) with no visual clue why.
  // Position/rotation are NOT touched here — only uniform scale, so this
  // never fights the manual grip-fitting controls.
  const box=new THREE.Box3().setFromObject(root);
  let initScale=1;
  if(!box.isEmpty()){
    const size=box.getSize(new THREE.Vector3());
    const maxDim=Math.max(size.x,size.y,size.z);
    if(maxDim>0.0001){
      const RATIO=0.5; // weapon's longest dimension ≈ half the soldier's actual height
      initScale=Math.min(100,Math.max(0.01,+((soldierRestHeight*RATIO)/maxDim).toFixed(4)));
    }
  } else {
    console.warn(`Attachment "${name}" has an empty bounding box — the GLB may have no visible geometry.`);
  }

  const id=attachIdCounter++;
  const att={id,name,glbBlob:blob,root,boneName:null,posX:0,posY:0,posZ:0,rotX:0,rotY:0,rotZ:0,scale:initScale};
  const guess=guessHandBone();
  if(guess) attachToBone(att,guess);
  attachments.push(att);
  selectedAttachmentId=id;
  renderAttachmentsList();
  renderAttachmentEditor();
}
function removeAttachment(id){
  const att=attachments.find(a=>a.id===id);
  if(att&&att.root&&att.root.parent) att.root.parent.remove(att.root);
  attachments=attachments.filter(a=>a.id!==id);
  if(selectedAttachmentId===id){
    selectedAttachmentId=attachments.length?attachments[0].id:null;
  }
  renderAttachmentsList();
  renderAttachmentEditor();
}
function clearAllAttachments(){
  attachments.forEach(att=>{ if(att.root&&att.root.parent) att.root.parent.remove(att.root); });
  attachments=[];
  selectedAttachmentId=null;
  renderAttachmentsList();
  renderAttachmentEditor();
}
function renderAttachmentsList(){
  const list=document.getElementById('attachments-list');
  list.innerHTML='';
  if(!attachments.length){
    list.innerHTML='<div class="attach-empty">No attachments yet</div>';
    return;
  }
  attachments.forEach(att=>{
    const row=document.createElement('div');
    row.className='attach-row'+(att.id===selectedAttachmentId?' selected':'');
    const info=document.createElement('div'); info.className='attach-info';
    const nm=document.createElement('div'); nm.className='attach-name'; nm.textContent=att.name;
    const bn=document.createElement('div'); bn.className='attach-bone'; bn.textContent=att.boneName||'(no bone selected)';
    info.appendChild(nm); info.appendChild(bn);
    row.appendChild(info);
    const del=document.createElement('button'); del.className='tbtn'; del.textContent='DEL';
    del.addEventListener('click',e=>{ e.stopPropagation(); removeAttachment(att.id); });
    row.appendChild(del);
    row.addEventListener('click',()=>{
      selectedAttachmentId=att.id;
      renderAttachmentsList();
      renderAttachmentEditor();
    });
    list.appendChild(row);
  });
}
function renderBoneOptions(filter){
  const sel=document.getElementById('bone-sel');
  const att=getSelectedAttachment();
  sel.innerHTML='';
  const f=(filter||'').toLowerCase();
  const names=[...soldierBones.keys()].sort();
  names.filter(n=>n.toLowerCase().includes(f)).forEach(n=>{
    const o=document.createElement('option'); o.value=n; o.textContent=n;
    sel.appendChild(o);
  });
  if(att&&att.boneName) sel.value=att.boneName;
}
function updateAttachDisplays(){
  const att=getSelectedAttachment(); if(!att) return;
  document.getElementById('afpos-x-val').textContent=att.posX.toFixed(2);
  document.getElementById('afpos-y-val').textContent=att.posY.toFixed(2);
  document.getElementById('afpos-z-val').textContent=att.posZ.toFixed(2);
  document.getElementById('afrot-x-val').textContent=att.rotX+'°';
  document.getElementById('afrot-y-val').textContent=att.rotY+'°';
  document.getElementById('afrot-z-val').textContent=att.rotZ+'°';
  document.getElementById('attach-scale').value=att.scale;
  document.getElementById('attach-scale-val').textContent=att.scale.toFixed(2);
}
function updateBoneMarker(){
  if(boneMarker.parent) boneMarker.parent.remove(boneMarker);
  const att=getSelectedAttachment();
  if(att&&att.boneName&&soldierBones.has(att.boneName)){
    soldierBones.get(att.boneName).add(boneMarker);
    boneMarker.position.set(0,0,0);
    boneMarker.visible=true;
  } else {
    boneMarker.visible=false;
  }
}
function renderAttachmentEditor(){
  const att=getSelectedAttachment();
  const editor=document.getElementById('attachment-editor');
  if(!att){ editor.style.display='none'; updateBoneMarker(); return; }
  editor.style.display='';
  renderBoneOptions(document.getElementById('bone-filter').value);
  updateAttachDisplays();
  updateBoneMarker();
}

document.getElementById('add-attachment-btn').addEventListener('click',()=>document.getElementById('attachment-file-input').click());
document.getElementById('attachment-file-input').addEventListener('change',e=>{
  const f=e.target.files[0]; if(f) loadAttachmentFile(f); e.target.value='';
});
document.getElementById('bone-filter').addEventListener('input',e=>renderBoneOptions(e.target.value));
document.getElementById('bone-sel').addEventListener('change',e=>{
  const att=getSelectedAttachment(); if(!att) return;
  attachToBone(att,e.target.value);
  renderAttachmentsList();
  updateBoneMarker();
});
document.querySelectorAll('[data-fstep]').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('[data-fstep]').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); attachPosStep=+b.dataset.fstep;
}));
document.querySelectorAll('[data-arstep]').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('[data-arstep]').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); attachRotStep=+b.dataset.arstep;
}));
document.querySelectorAll('[data-afaxis]').forEach(btn=>btn.addEventListener('click',()=>{
  const att=getSelectedAttachment(); if(!att) return;
  const dir=+btn.dataset.adir, ax=btn.dataset.afaxis;
  if(ax==='x') att.posX=+((att.posX+attachPosStep*dir).toFixed(3));
  if(ax==='y') att.posY=+((att.posY+attachPosStep*dir).toFixed(3));
  if(ax==='z') att.posZ=+((att.posZ+attachPosStep*dir).toFixed(3));
  applyAttachmentTransform(att); updateAttachDisplays();
}));
document.querySelectorAll('[data-arxis]').forEach(btn=>btn.addEventListener('click',()=>{
  const att=getSelectedAttachment(); if(!att) return;
  const dir=+btn.dataset.adir, ax=btn.dataset.arxis;
  if(ax==='x') att.rotX+=attachRotStep*dir;
  if(ax==='y') att.rotY+=attachRotStep*dir;
  if(ax==='z') att.rotZ+=attachRotStep*dir;
  applyAttachmentTransform(att); updateAttachDisplays();
}));
document.getElementById('attach-reset').addEventListener('click',()=>{
  const att=getSelectedAttachment(); if(!att) return;
  att.posX=att.posY=att.posZ=0; att.rotX=att.rotY=att.rotZ=0; att.scale=1;
  applyAttachmentTransform(att); updateAttachDisplays();
});
document.getElementById('attach-scale').addEventListener('input',e=>{
  const att=getSelectedAttachment(); if(!att) return;
  att.scale=+e.target.value;
  applyAttachmentTransform(att);
  document.getElementById('attach-scale-val').textContent=att.scale.toFixed(2);
});
document.getElementById('remove-attachment-btn').addEventListener('click',()=>{
  const att=getSelectedAttachment(); if(!att) return;
  removeAttachment(att.id);
});
async function restoreAttachments(attachmentsData){
  clearAllAttachments();
  if(!attachmentsData||!attachmentsData.length) return;
  for(const ad of attachmentsData){
    try{
      const gltf=await loadGLBAsync(ad.glbBlob, ad.name);
      const root=gltf.scene;
      root.traverse(n=>{if(n.isMesh){n.castShadow=true;n.receiveShadow=true;}});
      const id=attachIdCounter++;
      const att={id,name:ad.name,glbBlob:ad.glbBlob,root,boneName:null,
        posX:ad.posX,posY:ad.posY,posZ:ad.posZ,rotX:ad.rotX,rotY:ad.rotY,rotZ:ad.rotZ,scale:ad.scale};
      if(soldierBones.has(ad.boneName)){
        attachToBone(att,ad.boneName);
      } else {
        console.warn('Attachment bone not found on this model:',ad.name,ad.boneName);
      }
      attachments.push(att);
    }catch(e){
      console.warn('Failed to restore attachment',ad.name,e);
    }
  }
  selectedAttachmentId=attachments.length?attachments[0].id:null;
  renderAttachmentsList();
  renderAttachmentEditor();
}
function collectAttachmentsForSave(){
  return attachments.map(a=>({
    name:a.name, glbBlob:a.glbBlob, boneName:a.boneName,
    posX:a.posX,posY:a.posY,posZ:a.posZ,
    rotX:a.rotX,rotY:a.rotY,rotZ:a.rotZ,
    scale:a.scale
  }));
}

// ══════════════════════════════════════════════════════════════════════════
// SCENE OBJECTS — freestanding models placed anywhere in the scene (extra
// soldiers, duplicated ground/road tiles). Unlike attachments these are NOT
// bone-parented; each gets its own wrapping group with independent
// position/rotation/scale, added directly to the top-level scene so preview,
// live filter, and bake all pick them up automatically.
// ══════════════════════════════════════════════════════════════════════════
function normalizeSceneObject(gltfScene){
  gltfScene.traverse(n=>{if(n.isMesh){n.castShadow=true;n.receiveShadow=true;}});
  const box1=new THREE.Box3().setFromObject(gltfScene);
  const size1=box1.getSize(new THREE.Vector3());
  const maxD=Math.max(size1.x,size1.y,size1.z)||1;
  gltfScene.scale.setScalar(2/maxD);
  const box2=new THREE.Box3().setFromObject(gltfScene);
  const c2=box2.getCenter(new THREE.Vector3());
  gltfScene.position.set(-c2.x,-box2.min.y,-c2.z);
  const wrap=new THREE.Group();
  wrap.add(gltfScene);
  return wrap;
}
function applySceneObjTransform(obj){
  obj.root.position.set(obj.posX,obj.posY,obj.posZ);
  obj.root.rotation.set(
    THREE.MathUtils.degToRad(obj.rotX),
    THREE.MathUtils.degToRad(obj.rotY),
    THREE.MathUtils.degToRad(obj.rotZ)
  );
  obj.root.scale.setScalar(obj.scale);
}
function getSelectedSceneObj(){ return sceneObjects.find(o=>o.id===selectedSceneObjId)||null; }

function loadSceneObjectFile(file){
  loadGLBAsync(file, file.name).then(gltf=>onSceneObjectLoaded(file.name,file,gltf,{}))
    .catch(err=>alert('Scene object load failed: '+(err.message||err)));
}
function onSceneObjectLoaded(name,blob,gltf,offset){
  const wrap=normalizeSceneObject(gltf.scene);
  scene.add(wrap);
  const objClips=gltf.animations||[];
  const objMixer=objClips.length?new THREE.AnimationMixer(gltf.scene):null;
  const id=sceneObjIdCounter++;
  const obj={
    id,name,glbBlob:blob,root:wrap,clips:objClips,mixer:objMixer,
    selClipIdx:objClips.length?0:-1,
    animMode:'independent',phaseOffset:0,
    posX:offset.x||0,posY:offset.y||0,posZ:offset.z||0,
    rotX:0,rotY:0,rotZ:0,scale:1
  };
  applySceneObjTransform(obj);
  if(objMixer&&obj.selClipIdx>=0) objMixer.clipAction(objClips[obj.selClipIdx]).play();
  sceneObjects.push(obj);
  selectedSceneObjId=id;
  renderSceneObjList();
  renderSceneObjEditor();
}
function duplicatePrimaryModel(offset){
  if(!loadedScene){ alert('Load a model first.'); return; }
  const cloneScene=SkeletonUtils.clone(loadedScene);
  const wrap=new THREE.Group();
  wrap.add(cloneScene);
  scene.add(wrap);
  const objClips=clips; // AnimationClip data is immutable during playback — safe to share across mixers
  const objMixer=objClips.length?new THREE.AnimationMixer(cloneScene):null;
  const id=sceneObjIdCounter++;
  const startClipIdx=objClips.length?(selClipIdx>=0?selClipIdx:0):-1;
  const obj={
    id,name:(loadedName||'Model')+' copy',glbBlob:currentGlbBlob,root:wrap,
    clips:objClips,mixer:objMixer,selClipIdx:startClipIdx,
    animMode:'independent',phaseOffset:0,
    posX:offset.x||0,posY:offset.y||0,posZ:offset.z||0,
    rotX:0,rotY:0,rotZ:0,scale:1
  };
  applySceneObjTransform(obj);
  if(objMixer&&obj.selClipIdx>=0) objMixer.clipAction(objClips[obj.selClipIdx]).play();
  sceneObjects.push(obj);
  selectedSceneObjId=id;
  renderSceneObjList();
  renderSceneObjEditor();
}
function duplicateSceneObject(sourceId,offset){
  const src=sceneObjects.find(o=>o.id===sourceId);
  if(!src) return;
  const cloneScene=SkeletonUtils.clone(src.root.children[0]);
  const wrap=new THREE.Group();
  wrap.add(cloneScene);
  scene.add(wrap);
  const objMixer=src.clips.length?new THREE.AnimationMixer(cloneScene):null;
  const id=sceneObjIdCounter++;
  const obj={
    id,name:src.name+' copy',glbBlob:src.glbBlob,root:wrap,
    clips:src.clips,mixer:objMixer,selClipIdx:src.selClipIdx,
    animMode:src.animMode,phaseOffset:src.phaseOffset,
    posX:src.posX+(offset.x||0),posY:src.posY+(offset.y||0),posZ:src.posZ+(offset.z||0),
    rotX:src.rotX,rotY:src.rotY,rotZ:src.rotZ,scale:src.scale
  };
  applySceneObjTransform(obj);
  if(objMixer&&obj.selClipIdx>=0) objMixer.clipAction(src.clips[obj.selClipIdx]).play();
  sceneObjects.push(obj);
  selectedSceneObjId=id;
  renderSceneObjList();
  renderSceneObjEditor();
}
function removeSceneObject(id){
  const obj=sceneObjects.find(o=>o.id===id);
  if(obj){ scene.remove(obj.root); if(obj.mixer) obj.mixer.stopAllAction(); }
  sceneObjects=sceneObjects.filter(o=>o.id!==id);
  if(selectedSceneObjId===id) selectedSceneObjId=sceneObjects.length?sceneObjects[0].id:null;
  renderSceneObjList();
  renderSceneObjEditor();
}
function clearAllSceneObjects(){
  sceneObjects.forEach(o=>{ scene.remove(o.root); if(o.mixer) o.mixer.stopAllAction(); });
  sceneObjects=[];
  selectedSceneObjId=null;
  renderSceneObjList();
  renderSceneObjEditor();
}
function getDupOffsetPreset(){
  const v=dupAmount*dupDir;
  return { x: dupAxis==='x'?v:0, y: dupAxis==='y'?v:0, z: dupAxis==='z'?v:0 };
}
function renderSceneObjList(){
  const list=document.getElementById('scene-obj-list');
  list.innerHTML='';
  if(!sceneObjects.length){ list.innerHTML='<div class="attach-empty">No scene objects yet</div>'; return; }
  sceneObjects.forEach(obj=>{
    const row=document.createElement('div');
    row.className='attach-row'+(obj.id===selectedSceneObjId?' selected':'');
    const info=document.createElement('div'); info.className='attach-info';
    const nm=document.createElement('div'); nm.className='attach-name'; nm.textContent=obj.name;
    const sub=document.createElement('div'); sub.className='attach-bone';
    sub.textContent = obj.clips.length ? `${obj.clips.length} clip(s) · ${obj.animMode}` : 'static';
    info.appendChild(nm); info.appendChild(sub);
    row.appendChild(info);
    const del=document.createElement('button'); del.className='tbtn'; del.textContent='DEL';
    del.addEventListener('click',e=>{ e.stopPropagation(); removeSceneObject(obj.id); });
    row.appendChild(del);
    row.addEventListener('click',()=>{
      selectedSceneObjId=obj.id;
      renderSceneObjList();
      renderSceneObjEditor();
    });
    list.appendChild(row);
  });
}
function updateSceneObjDisplays(){
  const obj=getSelectedSceneObj(); if(!obj) return;
  document.getElementById('so-pos-x-val').textContent=obj.posX.toFixed(2);
  document.getElementById('so-pos-y-val').textContent=obj.posY.toFixed(2);
  document.getElementById('so-pos-z-val').textContent=obj.posZ.toFixed(2);
  document.getElementById('so-rot-x-val').textContent=obj.rotX+'°';
  document.getElementById('so-rot-y-val').textContent=obj.rotY+'°';
  document.getElementById('so-rot-z-val').textContent=obj.rotZ+'°';
  document.getElementById('scene-obj-scale').value=obj.scale;
  document.getElementById('scene-obj-scale-val').textContent=obj.scale.toFixed(2);
  document.getElementById('scene-obj-phase').value=obj.phaseOffset;
  document.getElementById('scene-obj-phase-val').textContent=Math.round(obj.phaseOffset*100)+'%';
  document.getElementById('scene-obj-mode-indep').classList.toggle('on',obj.animMode==='independent');
  document.getElementById('scene-obj-mode-locked').classList.toggle('on',obj.animMode==='locked');
}
function renderSceneObjEditor(){
  const obj=getSelectedSceneObj();
  const editor=document.getElementById('scene-obj-editor');
  if(!obj){ editor.style.display='none'; return; }
  editor.style.display='';
  const animRow=document.getElementById('scene-obj-anim-row');
  const modeRow=document.getElementById('scene-obj-mode-row');
  const phaseRow=document.getElementById('scene-obj-phase-row');
  if(obj.clips.length){
    animRow.style.display=''; modeRow.style.display='';
    const sel=document.getElementById('scene-obj-clip-sel');
    sel.innerHTML='<option value="-1">— static pose —</option>';
    obj.clips.forEach((c,i)=>{
      const o=document.createElement('option'); o.value=i; o.textContent=c.name||`Anim ${i+1}`; sel.appendChild(o);
    });
    sel.value=obj.selClipIdx;
    phaseRow.style.display = obj.animMode==='independent' ? '' : 'none';
  } else {
    animRow.style.display='none'; modeRow.style.display='none'; phaseRow.style.display='none';
  }
  updateSceneObjDisplays();
}

document.getElementById('add-scene-obj-btn').addEventListener('click',()=>document.getElementById('scene-obj-file-input').click());
document.getElementById('scene-obj-file-input').addEventListener('change',e=>{
  const f=e.target.files[0]; if(f) loadSceneObjectFile(f); e.target.value='';
});
document.querySelectorAll('[data-dupaxis]').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('[data-dupaxis]').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); dupAxis=b.dataset.dupaxis;
}));
document.getElementById('dup-dir-btn').addEventListener('click',()=>{
  dupDir=-dupDir;
  document.getElementById('dup-dir-btn').textContent=dupDir>0?'+':'−';
});
document.getElementById('dup-amount-input').addEventListener('input',e=>{ dupAmount=+e.target.value||0; });
document.getElementById('dup-primary-btn').addEventListener('click',()=>duplicatePrimaryModel(getDupOffsetPreset()));
document.getElementById('dup-this-scene-obj-btn').addEventListener('click',()=>{
  const obj=getSelectedSceneObj(); if(!obj) return;
  duplicateSceneObject(obj.id,getDupOffsetPreset());
});
document.getElementById('remove-scene-obj-btn').addEventListener('click',()=>{
  const obj=getSelectedSceneObj(); if(!obj) return;
  removeSceneObject(obj.id);
});
document.querySelectorAll('[data-sostep]').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('[data-sostep]').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); sceneObjStep=+b.dataset.sostep;
}));
document.querySelectorAll('[data-sorstep]').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('[data-sorstep]').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); sceneObjRotStep=+b.dataset.sorstep;
}));
document.querySelectorAll('[data-soaxis]').forEach(btn=>btn.addEventListener('click',()=>{
  const obj=getSelectedSceneObj(); if(!obj) return;
  const dir=+btn.dataset.sodir, ax=btn.dataset.soaxis;
  if(ax==='x') obj.posX=+((obj.posX+sceneObjStep*dir).toFixed(3));
  if(ax==='y') obj.posY=+((obj.posY+sceneObjStep*dir).toFixed(3));
  if(ax==='z') obj.posZ=+((obj.posZ+sceneObjStep*dir).toFixed(3));
  applySceneObjTransform(obj); updateSceneObjDisplays();
}));
document.querySelectorAll('[data-sorxis]').forEach(btn=>btn.addEventListener('click',()=>{
  const obj=getSelectedSceneObj(); if(!obj) return;
  const dir=+btn.dataset.sodir, ax=btn.dataset.sorxis;
  if(ax==='x') obj.rotX+=sceneObjRotStep*dir;
  if(ax==='y') obj.rotY+=sceneObjRotStep*dir;
  if(ax==='z') obj.rotZ+=sceneObjRotStep*dir;
  applySceneObjTransform(obj); updateSceneObjDisplays();
}));
document.getElementById('scene-obj-reset').addEventListener('click',()=>{
  const obj=getSelectedSceneObj(); if(!obj) return;
  obj.posX=obj.posY=obj.posZ=0; obj.rotX=obj.rotY=obj.rotZ=0; obj.scale=1;
  applySceneObjTransform(obj); updateSceneObjDisplays();
});
document.getElementById('scene-obj-scale').addEventListener('input',e=>{
  const obj=getSelectedSceneObj(); if(!obj) return;
  obj.scale=+e.target.value;
  applySceneObjTransform(obj);
  document.getElementById('scene-obj-scale-val').textContent=obj.scale.toFixed(2);
});
document.getElementById('scene-obj-clip-sel').addEventListener('change',e=>{
  const obj=getSelectedSceneObj(); if(!obj||!obj.mixer) return;
  obj.selClipIdx=+e.target.value;
  obj.mixer.stopAllAction();
  if(obj.selClipIdx>=0&&obj.clips[obj.selClipIdx]) obj.mixer.clipAction(obj.clips[obj.selClipIdx]).play();
});
document.getElementById('scene-obj-mode-indep').addEventListener('click',()=>{
  const obj=getSelectedSceneObj(); if(!obj) return;
  obj.animMode='independent';
  document.getElementById('scene-obj-mode-indep').classList.add('on');
  document.getElementById('scene-obj-mode-locked').classList.remove('on');
  document.getElementById('scene-obj-phase-row').style.display='';
});
document.getElementById('scene-obj-mode-locked').addEventListener('click',()=>{
  const obj=getSelectedSceneObj(); if(!obj) return;
  obj.animMode='locked';
  document.getElementById('scene-obj-mode-locked').classList.add('on');
  document.getElementById('scene-obj-mode-indep').classList.remove('on');
  document.getElementById('scene-obj-phase-row').style.display='none';
});
document.getElementById('scene-obj-phase').addEventListener('input',e=>{
  const obj=getSelectedSceneObj(); if(!obj) return;
  obj.phaseOffset=+e.target.value;
  document.getElementById('scene-obj-phase-val').textContent=Math.round(obj.phaseOffset*100)+'%';
});

// Live-preview per-frame animation update for scene objects (called from tick()).
function updateSceneObjectAnimations(dt){
  sceneObjects.forEach(obj=>{
    if(!obj.mixer||obj.selClipIdx<0||!obj.clips[obj.selClipIdx]) return;
    const clip=obj.clips[obj.selClipIdx];
    if(obj.animMode==='locked'){
      const primaryPhase=getPrimaryPhaseLive();
      if(primaryPhase==null) return;
      const a=obj.mixer.clipAction(clip);
      if(!a.isRunning()) a.play();
      a.time=primaryPhase*clip.duration;
      obj.mixer.update(0);
    } else {
      obj.mixer.update(dt);
    }
  });
}
function getPrimaryPhaseLive(){
  if(blendEnabled){
    if(!mixer||!blendLowerFilteredClip) return null;
    const a=mixer.existingAction?mixer.existingAction(blendLowerFilteredClip):null;
    if(!a) return null;
    const dur=blendLowerFilteredClip.duration||1;
    return ((a.time%dur)+dur)%dur/dur;
  }
  if(!mixer||selClipIdx<0||!clips[selClipIdx]) return null;
  const clip=clips[selClipIdx];
  const a=mixer.existingAction?mixer.existingAction(clip):null;
  if(!a) return null;
  const dur=clip.duration||1;
  return ((a.time%dur)+dur)%dur/dur;
}
// Deterministic per-frame posing for scene objects during bake().
// primaryPhase (0..1) and primaryDuration come from the frame loop in bake().
function poseSceneObjectsForBakeFrame(primaryPhase,primaryDuration){
  sceneObjects.forEach(obj=>{
    if(!obj.mixer||obj.selClipIdx<0||!obj.clips[obj.selClipIdx]) return;
    const clip=obj.clips[obj.selClipIdx];
    let objT;
    if(obj.animMode==='locked'){
      objT=primaryPhase*clip.duration;
    } else {
      const span=primaryDuration||1;
      objT=((primaryPhase*span)+obj.phaseOffset*clip.duration)%clip.duration;
    }
    obj.mixer.stopAllAction();
    const a=obj.mixer.clipAction(clip);
    a.reset().play(); a.time=objT; obj.mixer.update(0);
    obj.root.children[0].updateMatrixWorld(true);
  });
}

function collectSceneObjectsForSave(){
  return sceneObjects.map(o=>({
    name:o.name, glbBlob:o.glbBlob,
    posX:o.posX,posY:o.posY,posZ:o.posZ,
    rotX:o.rotX,rotY:o.rotY,rotZ:o.rotZ,
    scale:o.scale, selClipIdx:o.selClipIdx,
    animMode:o.animMode, phaseOffset:o.phaseOffset
  }));
}
async function restoreSceneObjects(dataArr){
  clearAllSceneObjects();
  if(!dataArr||!dataArr.length) return;
  for(const d of dataArr){
    try{
      const gltf=await loadGLBAsync(d.glbBlob, d.name);
      const wrap=normalizeSceneObject(gltf.scene);
      scene.add(wrap);
      const objClips=gltf.animations||[];
      const objMixer=objClips.length?new THREE.AnimationMixer(gltf.scene):null;
      const id=sceneObjIdCounter++;
      const obj={
        id,name:d.name,glbBlob:d.glbBlob,root:wrap,clips:objClips,mixer:objMixer,
        selClipIdx:d.selClipIdx??(objClips.length?0:-1),
        animMode:d.animMode??'independent', phaseOffset:d.phaseOffset??0,
        posX:d.posX??0,posY:d.posY??0,posZ:d.posZ??0,
        rotX:d.rotX??0,rotY:d.rotY??0,rotZ:d.rotZ??0,scale:d.scale??1
      };
      applySceneObjTransform(obj);
      if(objMixer&&obj.selClipIdx>=0) objMixer.clipAction(objClips[obj.selClipIdx]).play();
      sceneObjects.push(obj);
    }catch(e){ console.warn('Failed to restore scene object',d.name,e); }
  }
  selectedSceneObjId=sceneObjects.length?sceneObjects[0].id:null;
  renderSceneObjList();
  renderSceneObjEditor();
}

// ══════════════════════════════════════════════════════════════════════════
// FILE WIRING
// ══════════════════════════════════════════════════════════════════════════
const dropZone=document.getElementById('drop-zone');
const fileInput=document.getElementById('file-input');
dropZone.addEventListener('click',()=>fileInput.click());
dropZone.addEventListener('keydown',e=>e.key==='Enter'&&fileInput.click());
fileInput.addEventListener('change',e=>{const f=e.target.files[0];if(f)loadFile(f);e.target.value='';});
dropZone.addEventListener('dragover',e=>{e.preventDefault();dropZone.classList.add('drag');});
dropZone.addEventListener('dragleave',()=>dropZone.classList.remove('drag'));
dropZone.addEventListener('drop',e=>{e.preventDefault();dropZone.classList.remove('drag');const f=e.dataTransfer.files[0];if(f)loadFile(f);});
document.getElementById('new-btn').addEventListener('click',()=>{
  document.getElementById('upload-screen').classList.remove('hidden');
  document.getElementById('scene-screen').classList.remove('active');
});
document.getElementById('upload-proj-btn').addEventListener('click', openProjectsOverlay);

// ══════════════════════════════════════════════════════════════════════════
// BAKE SETTINGS UI
// ══════════════════════════════════════════════════════════════════════════
document.querySelectorAll('[data-r]').forEach(b=>b.addEventListener('click',()=>{
  if(captureLocked) return;
  document.querySelectorAll('[data-r]').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); bakeWidth=bakeHeight=+b.dataset.r;
}));
document.getElementById('res-mode-square').addEventListener('click',()=>{
  if(captureLocked) return;
  bakeResMode='square';
  document.getElementById('res-mode-square').classList.add('on');
  document.getElementById('res-mode-custom').classList.remove('on');
  document.getElementById('res-square-row').style.display='';
  document.getElementById('res-custom-row').style.display='none';
  document.getElementById('res-custom-presets-row').style.display='none';
  const activeSq=document.querySelector('[data-r].on');
  if(activeSq) bakeWidth=bakeHeight=+activeSq.dataset.r;
});
document.getElementById('res-mode-custom').addEventListener('click',()=>{
  if(captureLocked) return;
  bakeResMode='custom';
  document.getElementById('res-mode-custom').classList.add('on');
  document.getElementById('res-mode-square').classList.remove('on');
  document.getElementById('res-square-row').style.display='none';
  document.getElementById('res-custom-row').style.display='';
  document.getElementById('res-custom-presets-row').style.display='';
  document.getElementById('bake-width-input').value=bakeWidth;
  document.getElementById('bake-height-input').value=bakeHeight;
});
document.getElementById('bake-width-input').addEventListener('input',e=>{
  if(captureLocked) return;
  bakeWidth=Math.max(16,Math.min(4096,+e.target.value||512));
});
document.getElementById('bake-height-input').addEventListener('input',e=>{
  if(captureLocked) return;
  bakeHeight=Math.max(16,Math.min(4096,+e.target.value||512));
});
document.querySelectorAll('[data-wh]').forEach(b=>b.addEventListener('click',()=>{
  if(captureLocked) return;
  const [w,h]=b.dataset.wh.split('x').map(Number);
  bakeWidth=w; bakeHeight=h;
  document.getElementById('bake-width-input').value=w;
  document.getElementById('bake-height-input').value=h;
}));
document.getElementById('crop-on').addEventListener('click',()=>{doCrop=true;document.getElementById('crop-on').classList.add('on');document.getElementById('crop-off').classList.remove('on');});
document.getElementById('crop-off').addEventListener('click',()=>{doCrop=false;document.getElementById('crop-off').classList.add('on');document.getElementById('crop-on').classList.remove('on');});

document.querySelectorAll('[data-layout]').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('[data-layout]').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); layoutMode=b.dataset.layout;
  document.getElementById('layout-cols-input').style.display=layoutMode==='custom'?'':'none';
}));
document.getElementById('layout-cols-input').addEventListener('input',e=>{layoutCustomCols=Math.max(1,+e.target.value||8);});
function getLayoutCols(N){
  if(layoutMode==='auto') return Math.ceil(Math.sqrt(N));
  if(layoutMode==='1') return N;
  if(layoutMode==='custom') return Math.min(N,Math.max(1,layoutCustomCols));
  return Math.min(N,Math.max(1,+layoutMode));
}

// ══════════════════════════════════════════════════════════════════════════
// FILTER PARAM UI
// ══════════════════════════════════════════════════════════════════════════
function showFP(type){
  document.querySelectorAll('.fp').forEach(el=>el.classList.remove('show'));
  const fp=document.getElementById('fp-'+type);
  if(fp) fp.classList.add('show');
}
document.getElementById('filter-sel').addEventListener('change',e=>{filterType=e.target.value;showFP(filterType);});
document.querySelectorAll('[data-ps]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-ps]').forEach(x=>x.classList.remove('on'));b.classList.add('on');pixelSize=+b.dataset.ps;}));
document.querySelectorAll('[data-pl]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-pl]').forEach(x=>x.classList.remove('on'));b.classList.add('on');pixelLevels=+b.dataset.pl;}));
document.getElementById('px-out-off').addEventListener('click',()=>{pixelOutline=false;document.getElementById('px-out-off').classList.add('on');document.getElementById('px-out-on').classList.remove('on');});
document.getElementById('px-out-on').addEventListener('click',()=>{pixelOutline=true;document.getElementById('px-out-on').classList.add('on');document.getElementById('px-out-off').classList.remove('on');});

const GB_PRESETS={dmg:['#0f380f','#9bbc0f'],grey:['#111111','#cccccc'],amber:['#241100','#ffb300']};
document.querySelectorAll('[data-gbp]').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('[data-gbp]').forEach(x=>x.classList.remove('on')); b.classList.add('on');
  const [d,l]=GB_PRESETS[b.dataset.gbp];
  gbDark=d; gbLight=l;
  document.getElementById('gb-dark').value=d; document.getElementById('gb-light').value=l;
}));
document.getElementById('gb-dark').addEventListener('input',e=>gbDark=e.target.value);
document.getElementById('gb-light').addEventListener('input',e=>gbLight=e.target.value);
document.getElementById('bit-dark').addEventListener('input',e=>bitDark=e.target.value);
document.getElementById('bit-light').addEventListener('input',e=>bitLight=e.target.value);
document.getElementById('sil-color').addEventListener('input',e=>silColor=e.target.value);
document.querySelectorAll('[data-cl]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-cl]').forEach(x=>x.classList.remove('on'));b.classList.add('on');comicLevels=+b.dataset.cl;}));
document.querySelectorAll('[data-ce]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-ce]').forEach(x=>x.classList.remove('on'));b.classList.add('on');comicEdge=+b.dataset.ce;}));
document.querySelectorAll('[data-cb]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-cb]').forEach(x=>x.classList.remove('on'));b.classList.add('on');celBands=+b.dataset.cb;}));
document.querySelectorAll('[data-ciw]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-ciw]').forEach(x=>x.classList.remove('on'));b.classList.add('on');celInkWidth=+b.dataset.ciw;}));
document.querySelectorAll('[data-hatch]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-hatch]').forEach(x=>x.classList.remove('on'));b.classList.add('on');celHatch=b.dataset.hatch;}));
document.getElementById('cel-sat').addEventListener('input',e=>{celSat=+e.target.value;document.getElementById('cel-sat-val').textContent=celSat.toFixed(1);});
document.getElementById('sumie-ink').addEventListener('input',e=>{sumieInk=+e.target.value;document.getElementById('sumie-ink-val').textContent=sumieInk.toFixed(2);});
document.getElementById('sumie-wash').addEventListener('input',e=>{sumieWash=+e.target.value;document.getElementById('sumie-wash-val').textContent=sumieWash;});
document.querySelectorAll('[data-chunk]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-chunk]').forEach(x=>x.classList.remove('on'));b.classList.add('on');ps1Chunk=+b.dataset.chunk;}));
document.querySelectorAll('[data-pbits]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-pbits]').forEach(x=>x.classList.remove('on'));b.classList.add('on');ps1Bits=+b.dataset.pbits;}));
document.getElementById('ps1-dith-on').addEventListener('click',()=>{ps1Dither=true;document.getElementById('ps1-dith-on').classList.add('on');document.getElementById('ps1-dith-off').classList.remove('on');});
document.getElementById('ps1-dith-off').addEventListener('click',()=>{ps1Dither=false;document.getElementById('ps1-dith-off').classList.add('on');document.getElementById('ps1-dith-on').classList.remove('on');});
document.getElementById('neon-dark').addEventListener('input',e=>neonDark=e.target.value);
document.getElementById('neon-light').addEventListener('input',e=>neonLight=e.target.value);
document.getElementById('neon-bloom').addEventListener('input',e=>{neonBloom=+e.target.value;document.getElementById('neon-bloom-val').textContent=neonBloom.toFixed(1);});
document.getElementById('neon-scan-on').addEventListener('click',()=>{neonScanlines=true;document.getElementById('neon-scan-on').classList.add('on');document.getElementById('neon-scan-off').classList.remove('on');});
document.getElementById('neon-scan-off').addEventListener('click',()=>{neonScanlines=false;document.getElementById('neon-scan-off').classList.add('on');document.getElementById('neon-scan-on').classList.remove('on');});

// ══════════════════════════════════════════════════════════════════════════
// SQUARE-FRAME RENDER HELPER (shared: capture, live preview)
// ══════════════════════════════════════════════════════════════════════════
function renderFrameAtRes(width, height, opts={}){
  const r=new THREE.WebGLRenderer({antialias:!opts.fast,alpha:true,preserveDrawingBuffer:true,premultipliedAlpha:false});
  r.setPixelRatio(1); r.setSize(width,height,true);
  r.outputColorSpace=THREE.SRGBColorSpace;
  r.toneMapping=THREE.ACESFilmicToneMapping;
  r.toneMappingExposure=exposure;
  r.shadowMap.enabled=!opts.fast; r.shadowMap.type=THREE.PCFSoftShadowMap;
  const aspect=width/height;
  let bc;
  if(isOrtho){const hH=Math.abs(orthoCam.top)||2;bc=new THREE.OrthographicCamera(-hH*aspect,hH*aspect,hH,-hH,0.01,300);}
  else{bc=new THREE.PerspectiveCamera(45,aspect,0.01,300);}
  bc.position.copy(cam.position);
  bc.quaternion.copy(cam.quaternion);
  bc.updateProjectionMatrix();
  const savedBG=scene.background; scene.background=null;
  const savedGrid=grid.visible; grid.visible=false;
  const savedMarker=anchorMarker.visible; anchorMarker.visible=false;
  const savedBoneMarker=boneMarker.visible; boneMarker.visible=false;
  r.render(scene,bc);
  const gl=r.getContext();
  const stride=width*4;
  const buf=new Uint8Array(width*height*4);
  gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,buf);
  const pix=new Uint8ClampedArray(width*height*4);
  for(let row=0;row<height;row++){
    const src=(height-1-row)*stride;
    pix.set(buf.subarray(src,src+stride),row*stride);
  }
  scene.background=savedBG; grid.visible=savedGrid; anchorMarker.visible=savedMarker; boneMarker.visible=savedBoneMarker;
  r.dispose();
  return pix;
}

// ══════════════════════════════════════════════════════════════════════════
// LIVE FILTER PREVIEW (PIP)
// ══════════════════════════════════════════════════════════════════════════
function updateLivePreview(){
  if(!loadedScene||!liveFilterOn) return;
  // Preview at the actual target aspect ratio (capped to 200px on the longer side)
  // so a portrait bake shows a tall preview, not a misleading square one.
  const aspect=bakeWidth/bakeHeight;
  let pw,ph;
  if(aspect>=1){ pw=200; ph=Math.max(1,Math.round(200/aspect)); }
  else { ph=200; pw=Math.max(1,Math.round(200*aspect)); }
  const pix=renderFrameAtRes(pw,ph,{fast:true});
  let cx=0,cy=0,cw=pw,ch=ph;
  if(doCrop){
    const b=alphaBounds(pix,pw,ph);
    if(b){const PAD=2;cx=Math.max(0,b.x0-PAD);cy=Math.max(0,b.y0-PAD);cw=Math.min(pw,b.x1+PAD+1)-cx;ch=Math.min(ph,b.y1+PAD+1)-cy;}
  }
  const cropped=cropPixels(pix,pw,cx,cy,cw,ch);
  const filtered=filterType==='none'?new ImageData(new Uint8ClampedArray(cropped),cw,ch):applyFilter(cropped,cw,ch);
  const canvas=document.getElementById('live-filter-canvas');
  canvas.width=filtered.width; canvas.height=filtered.height;
  canvas.getContext('2d').putImageData(filtered,0,0);
}

// ══════════════════════════════════════════════════════════════════════════
// MANUAL CAPTURE
// ══════════════════════════════════════════════════════════════════════════
document.getElementById('capture-btn').addEventListener('click',()=>{
  if(!loadedScene) return;
  const pix=renderFrameAtRes(bakeWidth,bakeHeight);
  manualFrames.push({id:frameIdCounter++, pix});
  captureLocked=true;
  setResControlsLocked(true);
  document.getElementById('res-lock-note').style.display='';
  renderFilmstrip();
});
document.getElementById('clear-frames-btn').addEventListener('click',clearManualFrames);
function clearManualFrames(){
  manualFrames=[];
  renderFilmstrip();
  captureLocked=false;
  setResControlsLocked(false);
  document.getElementById('res-lock-note').style.display='none';
}
function setResControlsLocked(locked){
  document.querySelectorAll('[data-r]').forEach(b=>b.disabled=locked);
  document.getElementById('res-mode-square').disabled=locked;
  document.getElementById('res-mode-custom').disabled=locked;
  document.getElementById('bake-width-input').disabled=locked;
  document.getElementById('bake-height-input').disabled=locked;
  document.querySelectorAll('[data-wh]').forEach(b=>b.disabled=locked);
}
function renderFilmstrip(){
  const strip=document.getElementById('filmstrip');
  strip.innerHTML='';
  const aspect=bakeWidth/bakeHeight;
  const thumbMax=64;
  const thumbW=aspect>=1?thumbMax:Math.max(1,Math.round(thumbMax*aspect));
  const thumbH=aspect>=1?Math.max(1,Math.round(thumbMax/aspect)):thumbMax;
  manualFrames.forEach(f=>{
    const wrap=document.createElement('div'); wrap.className='fs-item';
    const thumb=document.createElement('canvas'); thumb.width=thumbW; thumb.height=thumbH;
    const full=document.createElement('canvas'); full.width=bakeWidth; full.height=bakeHeight;
    full.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(f.pix),bakeWidth,bakeHeight),0,0);
    thumb.getContext('2d').drawImage(full,0,0,thumbW,thumbH);
    const del=document.createElement('div'); del.className='fs-del'; del.textContent='×';
    del.addEventListener('click',()=>{
      manualFrames=manualFrames.filter(x=>x.id!==f.id);
      renderFilmstrip();
      if(manualFrames.length===0){
        captureLocked=false;
        setResControlsLocked(false);
        document.getElementById('res-lock-note').style.display='none';
      }
    });
    wrap.appendChild(thumb); wrap.appendChild(del);
    strip.appendChild(wrap);
  });
}

// ══════════════════════════════════════════════════════════════════════════
// BAKE
// ══════════════════════════════════════════════════════════════════════════
document.getElementById('bake-btn').addEventListener('click',bake);

async function bake(){
  if(!loadedScene) return;

  let N, clip=null, rawFrames=[];
  let bakeBlend=false, lowerClipForBake=null, upperClipForBake=null;

  if(bakeMode==='manual'){
    if(manualFrames.length===0){ alert('Capture at least one frame first.'); return; }
    N=manualFrames.length;
    rawFrames=manualFrames.map(f=>f.pix);
  } else {
    N=Math.min(256,Math.max(1,+document.getElementById('n-frames').value||12));
    if(blendEnabled){
      rebuildBlendClips();
      if(!blendLowerFilteredClip||!blendUpperFilteredClip){
        alert('Blend needs both a LOWER and UPPER clip and a valid split bone.');
        return;
      }
      bakeBlend=true;
      lowerClipForBake=blendLowerFilteredClip;
      upperClipForBake=blendUpperFilteredClip;
    } else {
      clip=(selClipIdx>=0&&clips[selClipIdx])?clips[selClipIdx]:null;
    }
  }

  const memMB=(N*bakeWidth*bakeHeight*4)/(1024*1024);
  if(memMB>120&&!confirm(`~${memMB.toFixed(0)} MB RAM needed. Continue?`)) return;

  loopOn=false; liveAnim=false;
  if(mixer) mixer.stopAllAction();
  grid.visible=false;
  const wasMarkerVisible=anchorMarker.visible; anchorMarker.visible=false;
  const wasBoneMarkerVisible=boneMarker.visible; boneMarker.visible=false;

  const progOv=document.getElementById('prog-overlay');
  const fillEl=document.getElementById('prog-fill');
  const lblEl=document.getElementById('prog-lbl');
  const titEl=document.getElementById('prog-title');
  progOv.classList.add('show');

  // Reference duration used to pace scene-object animation sync (see below).
  const primaryDurationForPhase = bakeBlend ? lowerClipForBake.duration : (clip?clip.duration:1);

  if(bakeMode==='anim'){
    titEl.textContent='RENDERING'; fillEl.style.width='0%'; lblEl.textContent=`0 / ${N}`;
    await yld();
    const br=new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true,premultipliedAlpha:false});
    br.setPixelRatio(1); br.setSize(bakeWidth,bakeHeight,true);
    br.outputColorSpace=THREE.SRGBColorSpace;
    br.toneMapping=THREE.ACESFilmicToneMapping;
    br.toneMappingExposure=exposure;
    br.shadowMap.enabled=true; br.shadowMap.type=THREE.PCFSoftShadowMap;

    const bakeAspect=bakeWidth/bakeHeight;
    let bakeCam;
    if(isOrtho){const hH=Math.abs(orthoCam.top)||2;bakeCam=new THREE.OrthographicCamera(-hH*bakeAspect,hH*bakeAspect,hH,-hH,0.01,300);}
    else{bakeCam=new THREE.PerspectiveCamera(45,bakeAspect,0.01,300);}
    bakeCam.position.copy(cam.position);
    bakeCam.quaternion.copy(cam.quaternion);
    bakeCam.updateProjectionMatrix();

    const savedBG=scene.background; scene.background=null;
    const stride=bakeWidth*4;
    const readBuf=new Uint8Array(bakeWidth*bakeHeight*4);
    const gl=br.getContext();

    for(let i=0;i<N;i++){
      if(bakeBlend&&mixer){
        const lowerTime=(i/N)*lowerClipForBake.duration;
        const upperTime=upperClipForBake.duration>0?(lowerTime%upperClipForBake.duration):0;
        mixer.stopAllAction();
        const la=mixer.clipAction(lowerClipForBake);
        const ua=mixer.clipAction(upperClipForBake);
        la.reset().play(); ua.reset().play();
        la.time=lowerTime; ua.time=upperTime;
        mixer.update(0);
        loadedScene.updateMatrixWorld(true);
      } else if(clip&&mixer){
        const t=(i/N)*clip.duration;
        mixer.stopAllAction();
        const a=mixer.clipAction(clip);
        a.reset().play(); mixer.update(t);
        loadedScene.updateMatrixWorld(true);
      }
      poseSceneObjectsForBakeFrame(i/N, primaryDurationForPhase);
      br.render(scene,bakeCam);
      gl.readPixels(0,0,bakeWidth,bakeHeight,gl.RGBA,gl.UNSIGNED_BYTE,readBuf);
      const pix=new Uint8ClampedArray(bakeWidth*bakeHeight*4);
      for(let row=0;row<bakeHeight;row++){
        const src=(bakeHeight-1-row)*stride;
        pix.set(readBuf.subarray(src,src+stride),row*stride);
      }
      rawFrames.push(pix);
      fillEl.style.width=`${((i+1)/N*100).toFixed(0)}%`;
      lblEl.textContent=`${i+1} / ${N}`;
      await yld();
    }
    scene.background=savedBG;
    br.dispose();
  }

  grid.visible=true;
  anchorMarker.visible=wasMarkerVisible;
  boneMarker.visible=wasBoneMarkerVisible;
  applyTransform();

  titEl.textContent='PROCESSING'; fillEl.style.width='0%'; await yld();
  let cropU={x0:bakeWidth,y0:bakeHeight,x1:-1,y1:-1};
  if(doCrop){
    for(const p of rawFrames){
      const b=alphaBounds(p,bakeWidth,bakeHeight);
      if(b){cropU.x0=Math.min(cropU.x0,b.x0);cropU.y0=Math.min(cropU.y0,b.y0);cropU.x1=Math.max(cropU.x1,b.x1);cropU.y1=Math.max(cropU.y1,b.y1);}
    }
  }
  let cx=0,cy=0,cw=bakeWidth,ch=bakeHeight;
  if(doCrop&&cropU.x1>=cropU.x0){
    const PAD=2;
    cx=Math.max(0,cropU.x0-PAD); cy=Math.max(0,cropU.y0-PAD);
    cw=Math.min(bakeWidth,cropU.x1+PAD+1)-cx;
    ch=Math.min(bakeHeight,cropU.y1+PAD+1)-cy;
  }

  const pFrames=[];
  let filtW=cw, filtH=ch;
  for(let i=0;i<N;i++){
    const cropped=cropPixels(rawFrames[i],bakeWidth,cx,cy,cw,ch);
    rawFrames[i]=null;
    const filtered=applyFilter(cropped,cw,ch);
    filtW=filtered.width; filtH=filtered.height;
    const fc=document.createElement('canvas');
    fc.width=filtW; fc.height=filtH;
    fc.getContext('2d').putImageData(filtered,0,0);
    pFrames.push(fc);
    fillEl.style.width=`${((i+1)/N*100).toFixed(0)}%`;
    lblEl.textContent=`${i+1} / ${N}`;
    if(i%4===3) await yld();
  }

  const cols=getLayoutCols(N), rows=Math.ceil(N/cols);
  const sheetW=filtW*cols, sheetH=filtH*rows;
  const sheet=document.createElement('canvas');
  sheet.width=sheetW; sheet.height=sheetH;
  const ctx=sheet.getContext('2d');
  ctx.clearRect(0,0,sheetW,sheetH);
  for(let i=0;i<N;i++) ctx.drawImage(pFrames[i],(i%cols)*filtW,Math.floor(i/cols)*filtH);

  const fps = bakeBlend
    ? Math.max(1,Math.round(N/lowerClipForBake.duration))
    : (clip?Math.max(1,Math.round(N/clip.duration)):12);
  const manifest={
    frameCount:N,frameWidth:filtW,frameHeight:filtH,columns:cols,rows,fps,
    mode:bakeMode,
    ...(bakeMode==='anim'
      ? (bakeBlend
          ? {
              blend:true,
              lowerClipName:clips[blendLowerIdx]?.name??null,
              upperClipName:clips[blendUpperIdx]?.name??null,
              splitBone:blendSplitBone,
              lowerDuration:+lowerClipForBake.duration.toFixed(4),
              upperDuration:+upperClipForBake.duration.toFixed(4)
            }
          : {clipName:clip?.name??null,clipDuration:clip?+clip.duration.toFixed(4):null}
        )
      : {}),
    bakeWidth,bakeHeight,autoCrop:doCrop,filter:filterType,
    generated:new Date().toISOString()
  };

  const base=loadedName.replace(/\.[^.]+$/,'');
  const mslug=bakeMode==='manual'?'_manual':'';
  const fslug=filterType!=='none'?'_'+filterType:'';
  const pngName=`${base}${mslug}${fslug}.png`;
  const jsonName=`${base}${mslug}${fslug}.json`;

  progOv.classList.remove('show');
  document.getElementById('res-meta').innerHTML=`${N} frames &nbsp;·&nbsp; ${filtW}×${filtH}px &nbsp;·&nbsp; ${fps}fps<br>${cols}×${rows} grid · sheet ${sheetW}×${sheetH}px`;
  const warnEl=document.getElementById('sheet-warn');
  if(Math.max(sheetW,sheetH)>8192){warnEl.textContent=`⚠ Sheet is ${sheetW}×${sheetH}px — may exceed texture limits`;warnEl.style.display='';}
  else warnEl.style.display='none';

  sheet.toBlob(async (blob)=>{
    const pngURL=URL.createObjectURL(blob);
    document.getElementById('sheet-strip').src=pngURL;
    document.getElementById('dl-png').href=pngURL;
    document.getElementById('dl-png').download=pngName;

    const jsonBlob=new Blob([JSON.stringify(manifest,null,2)],{type:'application/json'});
    const jsonURL=URL.createObjectURL(jsonBlob);
    document.getElementById('dl-json').href=jsonURL;
    document.getElementById('dl-json').download=jsonName;

    const shareBtn=document.getElementById('share-btn');
    const pngFile=new File([blob],pngName,{type:'image/png'});
    const jsonFile=new File([jsonBlob],jsonName,{type:'application/json'});
    if(navigator.canShare && navigator.canShare({files:[pngFile,jsonFile]})){
      shareBtn.style.display='';
      shareBtn.onclick=()=>navigator.share({files:[pngFile,jsonFile],title:pngName}).catch(()=>{});
    } else if(navigator.canShare && navigator.canShare({files:[pngFile]})){
      shareBtn.style.display='';
      shareBtn.onclick=()=>navigator.share({files:[pngFile],title:pngName}).catch(()=>{});
    } else {
      shareBtn.style.display='none';
    }
  },'image/png');

  startPlayer(pFrames,fps);
  document.getElementById('result-overlay').classList.add('show');
  clock.getDelta(); loopOn=true; tick();
  if(bakeMode==='anim'){ if(blendEnabled) tryStartBlendPreview(); else playClip(selClipIdx); }

  autoSaveProject();
}

// ══════════════════════════════════════════════════════════════════════════
// PLAYER
// ══════════════════════════════════════════════════════════════════════════
function startPlayer(frames,fps){
  playerFrames=frames; playerFps=fps; playerIdx=0; playerPlaying=true;
  const fw=frames[0]?.width||64,fh=frames[0]?.height||64;
  const pc=document.getElementById('player-canvas');
  pc.width=fw; pc.height=fh;
  const maxW=Math.min(280,Math.floor(window.innerWidth*0.8)),maxH=220;
  let sc=Math.min(maxW/fw,maxH/fh);
  if(fw<=128&&fh<=128) sc=Math.max(1,Math.floor(sc));
  pc.style.width=Math.round(fw*sc)+'px'; pc.style.height=Math.round(fh*sc)+'px';
  document.getElementById('fps-slider').value=fps;
  document.getElementById('fps-val').textContent=fps;
  document.getElementById('player-play-btn').textContent='⏸';
  document.getElementById('player-play-btn').classList.add('on');
  drawPlayerFrame(0);
  cancelAnimationFrame(playerRafId);
  playerLastMs=performance.now();
  playerRafId=requestAnimationFrame(playerTick);
}
function playerTick(ms){
  if(!playerPlaying||!playerFrames.length) return;
  playerRafId=requestAnimationFrame(playerTick);
  if(ms-playerLastMs>=1000/playerFps){playerIdx=(playerIdx+1)%playerFrames.length;drawPlayerFrame(playerIdx);playerLastMs=ms;}
}
function drawPlayerFrame(idx){
  const pc=document.getElementById('player-canvas');
  const pctx=pc.getContext('2d');
  pctx.clearRect(0,0,pc.width,pc.height);
  if(playerFrames[idx]) pctx.drawImage(playerFrames[idx],0,0);
  document.getElementById('frame-ctr').textContent=`${idx+1} / ${playerFrames.length}`;
}
document.getElementById('player-play-btn').addEventListener('click',()=>{
  playerPlaying=!playerPlaying;
  const btn=document.getElementById('player-play-btn');
  if(playerPlaying){btn.textContent='⏸';btn.classList.add('on');playerLastMs=performance.now();playerRafId=requestAnimationFrame(playerTick);}
  else{btn.textContent='▶';btn.classList.remove('on');cancelAnimationFrame(playerRafId);}
});
document.getElementById('fps-slider').addEventListener('input',e=>{playerFps=+e.target.value;document.getElementById('fps-val').textContent=playerFps;});
document.getElementById('back-btn').addEventListener('click',()=>{
  cancelAnimationFrame(playerRafId); playerPlaying=false;
  document.getElementById('result-overlay').classList.remove('show');
});

// ══════════════════════════════════════════════════════════════════════════
// FILTERS
// ══════════════════════════════════════════════════════════════════════════
function hexRgb(h){return[parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)];}

function applyFilter(pix,w,h){
  switch(filterType){
    case 'pixel':      return filterPixelArt(pix,w,h,pixelSize,pixelLevels,pixelOutline);
    case 'gameboy':    return filterGameBoy(pix,w,h,gbDark,gbLight);
    case '1bit':       return filter1Bit(pix,w,h,bitDark,bitLight);
    case 'silhouette': return filterSilhouette(pix,w,h,silColor);
    case 'comic':      return filterComic(pix,w,h,comicLevels,comicEdge);
    case 'cel':        return filterCelShade(pix,w,h,celBands,celInkWidth,celHatch,celSat);
    case 'sumie':      return filterSumie(pix,w,h,sumieInk,sumieWash);
    case 'ps1':        return filterPS1(pix,w,h,ps1Chunk,ps1Bits,ps1Dither);
    case 'neon':       return filterNeon(pix,w,h,neonDark,neonLight,neonBloom,neonScanlines);
    default:           return new ImageData(new Uint8ClampedArray(pix),w,h);
  }
}
function quantize(v,levels){const s=255/(levels-1);return Math.min(255,Math.max(0,Math.round(Math.round(v/s)*s)));}

function filterPixelArt(pix,srcW,srcH,tH,levels,outline){
  const ar=srcW/srcH, tW=Math.max(1,Math.round(tH*ar));
  const out=new Uint8ClampedArray(tW*tH*4);
  const xR=srcW/tW, yR=srcH/tH;
  for(let ty=0;ty<tH;ty++) for(let tx=0;tx<tW;tx++){
    const sx0=Math.floor(tx*xR),sx1=Math.min(srcW,Math.ceil((tx+1)*xR));
    const sy0=Math.floor(ty*yR),sy1=Math.min(srcH,Math.ceil((ty+1)*yR));
    let r=0,g=0,b=0,a=0,cnt=0;
    for(let sy=sy0;sy<sy1;sy++) for(let sx=sx0;sx<sx1;sx++){
      const i=(sy*srcW+sx)*4;r+=pix[i];g+=pix[i+1];b+=pix[i+2];a+=pix[i+3];cnt++;
    }
    const n=cnt||1,di=(ty*tW+tx)*4,aa=a/n;
    if(aa<64){out[di]=out[di+1]=out[di+2]=out[di+3]=0;}
    else{out[di]=quantize(r/n,levels);out[di+1]=quantize(g/n,levels);out[di+2]=quantize(b/n,levels);out[di+3]=255;}
  }
  if(outline){
    for(let ty=0;ty<tH;ty++) for(let tx=0;tx<tW;tx++){
      const di=(ty*tW+tx)*4;if(out[di+3]===0) continue;
      let border=false;
      for(let dy=-1;dy<=1&&!border;dy++) for(let dx=-1;dx<=1&&!border;dx++){
        if(!dx&&!dy) continue;
        const nx=tx+dx,ny=ty+dy;
        if(nx<0||ny<0||nx>=tW||ny>=tH||out[(ny*tW+nx)*4+3]===0) border=true;
      }
      if(border){out[di]=Math.round(out[di]*0.1);out[di+1]=Math.round(out[di+1]*0.1);out[di+2]=Math.round(out[di+2]*0.1);}
    }
  }
  return new ImageData(out,tW,tH);
}
function filterGameBoy(pix,w,h,darkH,lightH){
  const dark=hexRgb(darkH),light=hexRgb(lightH);
  const pal=[];
  for(let i=0;i<4;i++){const t=i/3;pal.push([Math.round(dark[0]+(light[0]-dark[0])*t),Math.round(dark[1]+(light[1]-dark[1])*t),Math.round(dark[2]+(light[2]-dark[2])*t)]);}
  const out=new Uint8ClampedArray(pix.length);
  for(let i=0;i<pix.length;i+=4){
    if(pix[i+3]<4){out.set([0,0,0,0],i);continue;}
    const lum=0.299*pix[i]+0.587*pix[i+1]+0.114*pix[i+2];
    const [r,g,b]=pal[Math.min(3,Math.floor(lum/64))];
    out[i]=r;out[i+1]=g;out[i+2]=b;out[i+3]=255;
  }
  return new ImageData(out,w,h);
}

const BAYER8=[0,32,8,40,2,34,10,42,48,16,56,24,50,18,58,26,12,44,4,36,14,46,6,38,60,28,52,20,62,30,54,22,3,35,11,43,1,33,9,41,51,19,59,27,49,17,57,25,15,47,7,39,13,45,5,37,63,31,55,23,61,29,53,21].map(v=>v/64*255);
function filter1Bit(pix,w,h,darkH,lightH){
  const dark=hexRgb(darkH),light=hexRgb(lightH);
  const out=new Uint8ClampedArray(pix.length);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=(y*w+x)*4;if(pix[i+3]<4){out.set([0,0,0,0],i);continue;}
    const lum=0.299*pix[i]+0.587*pix[i+1]+0.114*pix[i+2];
    const col=lum>BAYER8[(y%8)*8+(x%8)]?light:dark;
    out[i]=col[0];out[i+1]=col[1];out[i+2]=col[2];out[i+3]=255;
  }
  return new ImageData(out,w,h);
}
function filterSilhouette(pix,w,h,fillH){
  const [r,g,b]=hexRgb(fillH);
  const out=new Uint8ClampedArray(pix.length);
  for(let i=0;i<pix.length;i+=4){
    if(pix[i+3]<4){out.set([0,0,0,0],i);continue;}
    out[i]=r;out[i+1]=g;out[i+2]=b;out[i+3]=255;
  }
  return new ImageData(out,w,h);
}

function filterComic(pix,w,h,levels,thresh){
  const out=new Uint8ClampedArray(pix.length);
  for(let i=0;i<pix.length;i+=4){
    if(pix[i+3]<4){out.set([0,0,0,0],i);continue;}
    out[i]=quantize(pix[i],levels);out[i+1]=quantize(pix[i+1],levels);out[i+2]=quantize(pix[i+2],levels);out[i+3]=pix[i+3];
  }
  const gray=new Float32Array(w*h);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){const i=(y*w+x)*4;gray[y*w+x]=pix[i+3]<4?0:0.299*pix[i]+0.587*pix[i+1]+0.114*pix[i+2];}
  const KX=[-1,0,1,-2,0,2,-1,0,1],KY=[-1,-2,-1,0,0,0,1,2,1];
  for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++){
    let gx=0,gy=0;
    for(let ky=0;ky<3;ky++) for(let kx=0;kx<3;kx++){const g=gray[(y+ky-1)*w+(x+kx-1)];gx+=g*KX[ky*3+kx];gy+=g*KY[ky*3+kx];}
    const mag=Math.sqrt(gx*gx+gy*gy),di=(y*w+x)*4;
    if(out[di+3]>4&&mag>thresh){
      const t=Math.min(1,(mag-thresh)/80);
      out[di]=Math.round(out[di]*(1-t));out[di+1]=Math.round(out[di+1]*(1-t));out[di+2]=Math.round(out[di+2]*(1-t));
    }
  }
  return new ImageData(out,w,h);
}

function filterCelShade(pix,w,h,bands,inkW,hatch,sat){
  const sat_pix=new Uint8ClampedArray(pix.length);
  for(let i=0;i<pix.length;i+=4){
    if(pix[i+3]<4){sat_pix.set([0,0,0,0],i);continue;}
    const r=pix[i],g=pix[i+1],b=pix[i+2];
    const lum=0.299*r+0.587*g+0.114*b;
    sat_pix[i]=Math.min(255,Math.max(0,Math.round(lum+(r-lum)*sat)));
    sat_pix[i+1]=Math.min(255,Math.max(0,Math.round(lum+(g-lum)*sat)));
    sat_pix[i+2]=Math.min(255,Math.max(0,Math.round(lum+(b-lum)*sat)));
    sat_pix[i+3]=pix[i+3];
  }
  const out=new Uint8ClampedArray(sat_pix.length);
  const step=255/bands;
  for(let i=0;i<sat_pix.length;i+=4){
    if(sat_pix[i+3]<4){out.set([0,0,0,0],i);continue;}
    const lum=Math.max(1,0.299*sat_pix[i]+0.587*sat_pix[i+1]+0.114*sat_pix[i+2]);
    const qlum=Math.floor(lum/step)*step+step*0.5;
    const ratio=Math.min(2.5,qlum/lum);
    out[i]=Math.min(255,Math.round(sat_pix[i]*ratio));
    out[i+1]=Math.min(255,Math.round(sat_pix[i+1]*ratio));
    out[i+2]=Math.min(255,Math.round(sat_pix[i+2]*ratio));
    out[i+3]=sat_pix[i+3];
  }
  if(hatch!=='off'){
    const density=hatch==='heavy'?3:5;
    const darkFactor=hatch==='heavy'?0.38:0.58;
    for(let y=0;y<h;y++) for(let x=0;x<w;x++){
      const i=(y*w+x)*4;if(out[i+3]<4) continue;
      const lum=0.299*pix[i]+0.587*pix[i+1]+0.114*pix[i+2];
      if(lum>step) continue;
      const line1=(x+y)%density===0;
      const line2=hatch==='heavy'&&(x-y+w*2)%density===0;
      if(line1||line2){out[i]=Math.round(out[i]*darkFactor);out[i+1]=Math.round(out[i+1]*darkFactor);out[i+2]=Math.round(out[i+2]*darkFactor);}
    }
  }
  const gray=new Float32Array(w*h);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){const i=(y*w+x)*4;gray[y*w+x]=pix[i+3]<4?0:0.299*pix[i]+0.587*pix[i+1]+0.114*pix[i+2];}
  const KX=[-1,0,1,-2,0,2,-1,0,1],KY=[-1,-2,-1,0,0,0,1,2,1];
  let edge=new Float32Array(w*h);
  for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++){
    let gx=0,gy=0;
    for(let ky=0;ky<3;ky++) for(let kx=0;kx<3;kx++){const g=gray[(y+ky-1)*w+(x+kx-1)];gx+=g*KX[ky*3+kx];gy+=g*KY[ky*3+kx];}
    edge[y*w+x]=Math.sqrt(gx*gx+gy*gy);
  }
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=(y*w+x)*4;if(pix[i+3]<4) continue;
    const e=(x===0||pix[(y*w+x-1)*4+3]<4)||(x===w-1||pix[(y*w+x+1)*4+3]<4)||
            (y===0||pix[((y-1)*w+x)*4+3]<4)||(y===h-1||pix[((y+1)*w+x)*4+3]<4);
    if(e) edge[y*w+x]=999;
  }
  for(let pass=0;pass<inkW-1;pass++){
    const d=new Float32Array(w*h);
    for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++){
      let mx=edge[y*w+x];
      for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){const v=edge[(y+dy)*w+(x+dx)];if(v>mx)mx=v;}
      d[y*w+x]=mx;
    }
    edge=d;
  }
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const di=(y*w+x)*4,mag=edge[y*w+x];
    if(out[di+3]>4&&mag>18){
      const t=Math.min(1,(mag-18)/35);
      out[di]=Math.round(out[di]*(1-t));out[di+1]=Math.round(out[di+1]*(1-t));out[di+2]=Math.round(out[di+2]*(1-t));
    }
  }
  return new ImageData(out,w,h);
}

function filterSumie(pix,w,h,inkAmt,washAmt){
  const out=new Uint8ClampedArray(pix.length);
  for(let i=0;i<pix.length;i+=4){
    if(pix[i+3]<4){out.set([0,0,0,0],i);continue;}
    const r=pix[i],g=pix[i+1],b=pix[i+2];
    const lum=0.299*r+0.587*g+0.114*b;
    out[i]=Math.min(255,Math.round(lum+(r-lum)*0.25+washAmt));
    out[i+1]=Math.min(255,Math.round(lum+(g-lum)*0.25+washAmt));
    out[i+2]=Math.min(255,Math.round(lum+(b-lum)*0.25+washAmt));
    out[i+3]=pix[i+3];
  }
  const gray=new Float32Array(w*h);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){const i=(y*w+x)*4;gray[y*w+x]=pix[i+3]<4?0:0.299*pix[i]+0.587*pix[i+1]+0.114*pix[i+2];}
  const KX=[-1,0,1,-2,0,2,-1,0,1],KY=[-1,-2,-1,0,0,0,1,2,1];
  const edge=new Float32Array(w*h);
  for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++){
    let gx=0,gy=0;
    for(let ky=0;ky<3;ky++) for(let kx=0;kx<3;kx++){const g=gray[(y+ky-1)*w+(x+kx-1)];gx+=g*KX[ky*3+kx];gy+=g*KY[ky*3+kx];}
    edge[y*w+x]=Math.sqrt(gx*gx+gy*gy);
  }
  const d1=new Float32Array(w*h),d2=new Float32Array(w*h);
  for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++){
    let mx=edge[y*w+x];
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){const v=edge[(y+dy)*w+(x+dx)];if(v>mx)mx=v;}
    d1[y*w+x]=mx;
  }
  for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++){
    let mx=d1[y*w+x];
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){const v=d1[(y+dy)*w+(x+dx)];if(v>mx)mx=v;}
    d2[y*w+x]=mx;
  }
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const di=(y*w+x)*4;if(out[di+3]<4) continue;
    const e=(x===0||pix[(y*w+x-1)*4+3]<4)||(x===w-1||pix[(y*w+x+1)*4+3]<4)||
            (y===0||pix[((y-1)*w+x)*4+3]<4)||(y===h-1||pix[((y+1)*w+x)*4+3]<4);
    if(e) d2[y*w+x]=999;
  }
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const di=(y*w+x)*4,mag=d2[y*w+x];
    if(out[di+3]>4&&mag>12){
      const t=Math.min(1,(mag-12)/45)*inkAmt;
      out[di]=Math.round(out[di]*(1-t)+15*t);out[di+1]=Math.round(out[di+1]*(1-t)+10*t);out[di+2]=Math.round(out[di+2]*(1-t)+5*t);
    }
  }
  return new ImageData(out,w,h);
}

const BAYER4=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5].map(v=>(v/16-0.5)*16);
function filterPS1(pix,w,h,chunk,bits,dither){
  const dW=Math.max(1,Math.round(w/chunk)),dH=Math.max(1,Math.round(h/chunk));
  const small=new Uint8ClampedArray(dW*dH*4);
  for(let y=0;y<dH;y++) for(let x=0;x<dW;x++){
    const sx=Math.floor(x*w/dW),sy=Math.floor(y*h/dH);
    const si=(sy*w+sx)*4,di=(y*dW+x)*4;
    small[di]=pix[si];small[di+1]=pix[si+1];small[di+2]=pix[si+2];small[di+3]=pix[si+3];
  }
  const levels=1<<bits,step=255/(levels-1);
  for(let y=0;y<dH;y++) for(let x=0;x<dW;x++){
    const i=(y*dW+x)*4;if(small[i+3]<32){small[i]=small[i+1]=small[i+2]=small[i+3]=0;continue;}
    const noise=dither?BAYER4[(y%4)*4+(x%4)]:0;
    const q=v=>Math.min(255,Math.max(0,Math.round((v+noise)/step)*step));
    small[i]=q(small[i]);small[i+1]=q(small[i+1]);small[i+2]=q(small[i+2]);small[i+3]=255;
  }
  if(chunk===1) return new ImageData(small,w,h);
  const out=new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const sx=Math.floor(x*dW/w),sy=Math.floor(y*dH/h);
    const si=(sy*dW+sx)*4,di=(y*w+x)*4;
    out[di]=small[si];out[di+1]=small[si+1];out[di+2]=small[si+2];out[di+3]=small[si+3];
  }
  return new ImageData(out,w,h);
}

function filterNeon(pix,w,h,darkH,lightH,bloom,scanlines){
  const dark=hexRgb(darkH),light=hexRgb(lightH);
  const out=new Uint8ClampedArray(pix.length);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=(y*w+x)*4;if(pix[i+3]<4){out.set([0,0,0,0],i);continue;}
    const lum=0.299*pix[i]+0.587*pix[i+1]+0.114*pix[i+2];
    const c=lum<128?Math.max(0,(lum-55)*1.9):Math.min(255,128+(lum-128)*1.7);
    const t=c/255;
    const bloomBoost=(bloom>0&&t>0.72)?1+(t-0.72)*3*bloom*0.35:1;
    const scan=(scanlines&&y%2===0)?0.82:1.0;
    for(let ch=0;ch<3;ch++){out[i+ch]=Math.min(255,Math.max(0,Math.round((dark[ch]+(light[ch]-dark[ch])*t)*scan*bloomBoost)));}
    out[i+3]=pix[i+3];
  }
  return new ImageData(out,w,h);
}

// ══════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════
function cropPixels(src,srcW,cx,cy,cw,ch){
  const out=new Uint8ClampedArray(cw*ch*4),rb=cw*4;
  for(let row=0;row<ch;row++){const s=((cy+row)*srcW+cx)*4;out.set(src.subarray(s,s+rb),row*rb);}
  return out;
}
function alphaBounds(pix,w,h){
  let x0=w,y0=h,x1=-1,y1=-1;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    if(pix[(y*w+x)*4+3]>6){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}
  }
  return x1<0?null:{x0,y0,x1,y1};
}
function yld(){return new Promise(r=>setTimeout(r,0));}

// ══════════════════════════════════════════════════════════════════════════
// PROJECTS — IndexedDB persistence
// ══════════════════════════════════════════════════════════════════════════
let dbPromise=null;
function openDB(){
  if(dbPromise) return dbPromise;
  dbPromise=new Promise((resolve,reject)=>{
    const req=indexedDB.open('sprite-baker-db',1);
    req.onupgradeneeded=()=>{req.result.createObjectStore('projects',{keyPath:'id'});};
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
  return dbPromise;
}
function collectSettings(){
  return {
    bakeMode,bakeResMode,bakeWidth,bakeHeight,doCrop,exposure,
    posOffX,posOffY,posOffZ,posStep,
    rotYaw,rotPitch,rotRoll,snapStep,
    anchorX,anchorY,anchorZ,anchorStep,
    isOrtho,bgIdx,
    layoutMode,layoutCustomCols,
    filterType,
    pixelSize,pixelLevels,pixelOutline,
    gbDark,gbLight,bitDark,bitLight,silColor,
    comicLevels,comicEdge,
    celBands,celInkWidth,celHatch,celSat,
    sumieInk,sumieWash,
    ps1Chunk,ps1Bits,ps1Dither,
    neonDark,neonLight,neonBloom,neonScanlines,
    selClipIdx,
    blendEnabled,blendLowerIdx,blendUpperIdx,blendSplitBone
  };
}
function applySettings(s){
  if(!s) return;
  bakeMode=s.bakeMode??'anim'; bakeResMode=s.bakeResMode??'square';
  bakeWidth=s.bakeWidth??1024; bakeHeight=s.bakeHeight??1024; doCrop=s.doCrop??true; exposure=s.exposure??1.0;
  posOffX=s.posOffX??0; posOffY=s.posOffY??0; posOffZ=s.posOffZ??0; posStep=s.posStep??0.25;
  rotYaw=s.rotYaw??0; rotPitch=s.rotPitch??0; rotRoll=s.rotRoll??0; snapStep=s.snapStep??10;
  anchorX=s.anchorX??0; anchorY=s.anchorY??0; anchorZ=s.anchorZ??0; anchorStep=s.anchorStep??0.25;
  isOrtho=s.isOrtho??true; bgIdx=s.bgIdx??0;
  layoutMode=s.layoutMode??'auto'; layoutCustomCols=s.layoutCustomCols??8;
  filterType=s.filterType??'none';
  pixelSize=s.pixelSize??48; pixelLevels=s.pixelLevels??6; pixelOutline=s.pixelOutline??false;
  gbDark=s.gbDark??'#0f380f'; gbLight=s.gbLight??'#9bbc0f';
  bitDark=s.bitDark??'#000000'; bitLight=s.bitLight??'#ffffff';
  silColor=s.silColor??'#080604';
  comicLevels=s.comicLevels??4; comicEdge=s.comicEdge??28;
  celBands=s.celBands??4; celInkWidth=s.celInkWidth??2; celHatch=s.celHatch??'off'; celSat=s.celSat??1.6;
  sumieInk=s.sumieInk??0.65; sumieWash=s.sumieWash??20;
  ps1Chunk=s.ps1Chunk??4; ps1Bits=s.ps1Bits??5; ps1Dither=s.ps1Dither??true;
  neonDark=s.neonDark??'#05003c'; neonLight=s.neonLight??'#00f0ff'; neonBloom=s.neonBloom??1.0; neonScanlines=s.neonScanlines??true;
  blendEnabled=s.blendEnabled??false;
  blendLowerIdx=(s.blendLowerIdx!=null)?s.blendLowerIdx:null;
  blendUpperIdx=(s.blendUpperIdx!=null)?s.blendUpperIdx:null;
  blendSplitBone=s.blendSplitBone??null;

  syncUIFromState();
  applyTransform();
  updateRotDisplay(); updatePosDisplay(); updateAnchorDisplay();
  renderer.toneMappingExposure=exposure;

  if(s.selClipIdx!==undefined && clips.length){
    document.getElementById('clip-sel').value=s.selClipIdx;
    if(!blendEnabled) playClip(s.selClipIdx);
  }
  if(blendEnabled && clips.length){
    buildBlendMenus();
    tryStartBlendPreview();
  }
}
function syncBtnGroup(selector,attr,value){
  document.querySelectorAll(selector).forEach(b=>{
    b.classList.toggle('on', String(b.dataset[attr])===String(value));
  });
}
function syncUIFromState(){
  document.getElementById('mode-anim').classList.toggle('on',bakeMode==='anim');
  document.getElementById('mode-manual').classList.toggle('on',bakeMode==='manual');
  document.getElementById('blend-on-btn').classList.toggle('on',blendEnabled);
  document.getElementById('blend-off-btn').classList.toggle('on',!blendEnabled);
  updateAnimUIVisibility();
  document.getElementById('manual-section').style.display=bakeMode==='manual'?'':'none';
  document.getElementById('frames-row').style.display=bakeMode==='manual'?'none':'';
  syncBtnGroup('[data-r]','r', bakeResMode==='square' ? bakeWidth : -1);
  document.getElementById('res-mode-square').classList.toggle('on',bakeResMode==='square');
  document.getElementById('res-mode-custom').classList.toggle('on',bakeResMode==='custom');
  document.getElementById('res-square-row').style.display = bakeResMode==='square' ? '' : 'none';
  document.getElementById('res-custom-row').style.display = bakeResMode==='custom' ? '' : 'none';
  document.getElementById('res-custom-presets-row').style.display = bakeResMode==='custom' ? '' : 'none';
  document.getElementById('bake-width-input').value=bakeWidth;
  document.getElementById('bake-height-input').value=bakeHeight;
  document.getElementById('crop-on').classList.toggle('on',doCrop);
  document.getElementById('crop-off').classList.toggle('on',!doCrop);
  document.getElementById('exp-slider').value=exposure;
  document.getElementById('exp-val').textContent=exposure.toFixed(2);
  syncBtnGroup('[data-pstep]','pstep',posStep);
  syncBtnGroup('[data-astep]','astep',anchorStep);
  syncBtnGroup('[data-snap]','snap',snapStep);
  syncBtnGroup('[data-layout]','layout',layoutMode);
  document.getElementById('layout-cols-input').value=layoutCustomCols;
  document.getElementById('layout-cols-input').style.display=layoutMode==='custom'?'':'none';
  document.getElementById('filter-sel').value=filterType;
  showFP(filterType);
  syncBtnGroup('[data-ps]','ps',pixelSize);
  syncBtnGroup('[data-pl]','pl',pixelLevels);
  document.getElementById('px-out-on').classList.toggle('on',pixelOutline);
  document.getElementById('px-out-off').classList.toggle('on',!pixelOutline);
  document.getElementById('gb-dark').value=gbDark; document.getElementById('gb-light').value=gbLight;
  document.getElementById('bit-dark').value=bitDark; document.getElementById('bit-light').value=bitLight;
  document.getElementById('sil-color').value=silColor;
  syncBtnGroup('[data-cl]','cl',comicLevels);
  syncBtnGroup('[data-ce]','ce',comicEdge);
  syncBtnGroup('[data-cb]','cb',celBands);
  syncBtnGroup('[data-ciw]','ciw',celInkWidth);
  syncBtnGroup('[data-hatch]','hatch',celHatch);
  document.getElementById('cel-sat').value=celSat; document.getElementById('cel-sat-val').textContent=celSat.toFixed(1);
  document.getElementById('sumie-ink').value=sumieInk; document.getElementById('sumie-ink-val').textContent=sumieInk.toFixed(2);
  document.getElementById('sumie-wash').value=sumieWash; document.getElementById('sumie-wash-val').textContent=sumieWash;
  syncBtnGroup('[data-chunk]','chunk',ps1Chunk);
  syncBtnGroup('[data-pbits]','pbits',ps1Bits);
  document.getElementById('ps1-dith-on').classList.toggle('on',ps1Dither);
  document.getElementById('ps1-dith-off').classList.toggle('on',!ps1Dither);
  document.getElementById('neon-dark').value=neonDark; document.getElementById('neon-light').value=neonLight;
  document.getElementById('neon-bloom').value=neonBloom; document.getElementById('neon-bloom-val').textContent=neonBloom.toFixed(1);
  document.getElementById('neon-scan-on').classList.toggle('on',neonScanlines);
  document.getElementById('neon-scan-off').classList.toggle('on',!neonScanlines);
  anchorMarker.visible = (bakeMode==='manual' && !!loadedScene);
}

async function saveProjectAs(name){
  if(!currentGlbBlob){ alert('No model loaded.'); return; }
  const db=await openDB();
  const id=(name&&name.trim())||loadedName||('project-'+Date.now());
  const rec={id, name:id, savedAt:Date.now(), glbBlob:currentGlbBlob, glbName:loadedName, settings:collectSettings(), attachmentsData:collectAttachmentsForSave(), sceneObjectsData:collectSceneObjectsForSave()};
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('projects','readwrite');
    tx.objectStore('projects').put(rec);
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
  });
}
async function autoSaveProject(){
  try{ await saveProjectAs(loadedName); }catch(e){ console.warn('autosave failed',e); }
}
async function listProjectsDB(){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('projects','readonly');
    const req=tx.objectStore('projects').getAll();
    req.onsuccess=()=>resolve(req.result.sort((a,b)=>b.savedAt-a.savedAt));
    req.onerror=()=>reject(req.error);
  });
}
async function loadProjectDB(id){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('projects','readonly');
    const req=tx.objectStore('projects').get(id);
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
async function deleteProjectDB(id){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('projects','readwrite');
    tx.objectStore('projects').delete(id);
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
  });
}

function fmtDate(ts){
  const d=new Date(ts);
  return d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' '+d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
}
async function refreshProjectsList(){
  const list=document.getElementById('projects-list');
  list.innerHTML='<div class="proj-empty">Loading…</div>';
  const projects=await listProjectsDB();
  if(!projects.length){ list.innerHTML='<div class="proj-empty">No saved projects yet</div>'; return; }
  list.innerHTML='';
  projects.forEach(p=>{
    const row=document.createElement('div'); row.className='proj-row';
    const info=document.createElement('div'); info.className='pinfo';
    const pname=document.createElement('div'); pname.className='pname'; pname.textContent=p.name;
    const pdate=document.createElement('div'); pdate.className='pdate'; pdate.textContent=fmtDate(p.savedAt);
    info.appendChild(pname); info.appendChild(pdate);
    const loadBtn=document.createElement('button'); loadBtn.className='tbtn on'; loadBtn.textContent='LOAD';
    loadBtn.addEventListener('click',()=>loadProjectAndApply(p.id));
    const delBtn=document.createElement('button'); delBtn.className='tbtn'; delBtn.textContent='DEL';
    delBtn.addEventListener('click',async()=>{
      if(confirm(`Delete project "${p.name}"?`)){ await deleteProjectDB(p.id); refreshProjectsList(); }
    });
    row.appendChild(info); row.appendChild(loadBtn); row.appendChild(delBtn);
    list.appendChild(row);
  });
}
async function loadProjectAndApply(id){
  const rec=await loadProjectDB(id);
  if(!rec) return;
  loadFile(rec.glbBlob, rec.glbName||rec.name);
  const check=setInterval(()=>{
    if(loadedScene){
      clearInterval(check);
      applySettings(rec.settings);
      restoreAttachments(rec.attachmentsData);
      restoreSceneObjects(rec.sceneObjectsData);
    }
  },50);
  closeProjectsOverlay();
}
function openProjectsOverlay(){
  document.getElementById('projects-overlay').classList.add('show');
  refreshProjectsList();
}
function closeProjectsOverlay(){
  document.getElementById('projects-overlay').classList.remove('show');
}
document.getElementById('proj-btn').addEventListener('click', openProjectsOverlay);
document.getElementById('projects-close-btn').addEventListener('click', closeProjectsOverlay);
document.getElementById('save-proj-btn').addEventListener('click', async ()=>{
  const name=document.getElementById('save-name-input').value.trim();
  await saveProjectAs(name);
  document.getElementById('save-name-input').value='';
  refreshProjectsList();
});
