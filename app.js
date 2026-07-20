import * as THREE from 'three';
import { GLTFLoader }    from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader }   from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ══════════════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════════════
let loadedScene = null, loadedName = '', currentGlbBlob = null;
let mixer = null, clips = [], selClipIdx = -1, liveAnim = false;
let bakeRes = 1024, doCrop = true, exposure = 1.0;

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
  const side=Math.min(w,h)*0.94;
  const fg=document.getElementById('frame-guide');
  fg.style.width=side+'px'; fg.style.height=side+'px';
  fg.style.left=((w-side)/2)+'px'; fg.style.top=((h-side)/2)+'px';
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
});
document.getElementById('mode-manual').addEventListener('click',()=>{
  bakeMode='manual';
  document.getElementById('mode-manual').classList.add('on');
  document.getElementById('mode-anim').classList.remove('on');
  document.getElementById('manual-section').style.display='';
  document.getElementById('frames-row').style.display='none';
  anchorMarker.visible=!!loadedScene;
  updateScrubVisibility();
});
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

function loadFile(fileOrBlob, displayName){
  const name = displayName || fileOrBlob.name || 'model.glb';
  currentGlbBlob = fileOrBlob;
  const url=URL.createObjectURL(fileOrBlob);
  loader.load(url,gltf=>{URL.revokeObjectURL(url);onGLTFLoaded(name,gltf);},
    undefined,err=>{URL.revokeObjectURL(url);alert('Load failed: '+(err.message||err));});
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
function loadGLBAsync(blob){
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(blob);
    loader.load(url,gltf=>{URL.revokeObjectURL(url);resolve(gltf);},
      undefined,err=>{URL.revokeObjectURL(url);reject(err);});
  });
}
function loadAttachmentFile(file){
  if(!loadedScene||soldierBones.size===0){ alert('Load a rigged soldier model first (needs a skeleton).'); return; }
  loadGLBAsync(file).then(gltf=>onAttachmentLoaded(file.name,file,gltf))
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
      initScale=Math.min(20,Math.max(0.01,+((soldierRestHeight*RATIO)/maxDim).toFixed(4)));
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
      const gltf=await loadGLBAsync(ad.glbBlob);
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
  b.classList.add('on'); bakeRes=+b.dataset.r;
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
function renderSquareFrameAtRes(res, opts={}){
  const r=new THREE.WebGLRenderer({antialias:!opts.fast,alpha:true,preserveDrawingBuffer:true,premultipliedAlpha:false});
  r.setPixelRatio(1); r.setSize(res,res,true);
  r.outputColorSpace=THREE.SRGBColorSpace;
  r.toneMapping=THREE.ACESFilmicToneMapping;
  r.toneMappingExposure=exposure;
  r.shadowMap.enabled=!opts.fast; r.shadowMap.type=THREE.PCFSoftShadowMap;
  let bc;
  if(isOrtho){const hH=Math.abs(orthoCam.top)||2;bc=new THREE.OrthographicCamera(-hH,hH,hH,-hH,0.01,300);}
  else{bc=new THREE.PerspectiveCamera(45,1.0,0.01,300);}
  bc.position.copy(cam.position);
  bc.quaternion.copy(cam.quaternion);
  bc.updateProjectionMatrix();
  const savedBG=scene.background; scene.background=null;
  const savedGrid=grid.visible; grid.visible=false;
  const savedMarker=anchorMarker.visible; anchorMarker.visible=false;
  const savedBoneMarker=boneMarker.visible; boneMarker.visible=false;
  r.render(scene,bc);
  const gl=r.getContext();
  const stride=res*4;
  const buf=new Uint8Array(res*res*4);
  gl.readPixels(0,0,res,res,gl.RGBA,gl.UNSIGNED_BYTE,buf);
  const pix=new Uint8ClampedArray(res*res*4);
  for(let row=0;row<res;row++){
    const src=(res-1-row)*stride;
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
  const res=200;
  const pix=renderSquareFrameAtRes(res,{fast:true});
  let cx=0,cy=0,cw=res,ch=res;
  if(doCrop){
    const b=alphaBounds(pix,res,res);
    if(b){const PAD=2;cx=Math.max(0,b.x0-PAD);cy=Math.max(0,b.y0-PAD);cw=Math.min(res,b.x1+PAD+1)-cx;ch=Math.min(res,b.y1+PAD+1)-cy;}
  }
  const cropped=cropPixels(pix,res,cx,cy,cw,ch);
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
  const pix=renderSquareFrameAtRes(bakeRes);
  manualFrames.push({id:frameIdCounter++, pix});
  captureLocked=true;
  document.querySelectorAll('[data-r]').forEach(b=>b.disabled=true);
  document.getElementById('res-lock-note').style.display='';
  renderFilmstrip();
});
document.getElementById('clear-frames-btn').addEventListener('click',clearManualFrames);
function clearManualFrames(){
  manualFrames=[];
  renderFilmstrip();
  captureLocked=false;
  document.querySelectorAll('[data-r]').forEach(b=>b.disabled=false);
  document.getElementById('res-lock-note').style.display='none';
}
function renderFilmstrip(){
  const strip=document.getElementById('filmstrip');
  strip.innerHTML='';
  manualFrames.forEach(f=>{
    const wrap=document.createElement('div'); wrap.className='fs-item';
    const thumb=document.createElement('canvas'); thumb.width=64; thumb.height=64;
    const full=document.createElement('canvas'); full.width=bakeRes; full.height=bakeRes;
    full.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(f.pix),bakeRes,bakeRes),0,0);
    thumb.getContext('2d').drawImage(full,0,0,64,64);
    const del=document.createElement('div'); del.className='fs-del'; del.textContent='×';
    del.addEventListener('click',()=>{
      manualFrames=manualFrames.filter(x=>x.id!==f.id);
      renderFilmstrip();
      if(manualFrames.length===0){
        captureLocked=false;
        document.querySelectorAll('[data-r]').forEach(b=>b.disabled=false);
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

  if(bakeMode==='manual'){
    if(manualFrames.length===0){ alert('Capture at least one frame first.'); return; }
    N=manualFrames.length;
    rawFrames=manualFrames.map(f=>f.pix);
  } else {
    N=Math.min(256,Math.max(1,+document.getElementById('n-frames').value||12));
    clip=(selClipIdx>=0&&clips[selClipIdx])?clips[selClipIdx]:null;
  }

  const memMB=(N*bakeRes*bakeRes*4)/(1024*1024);
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

  if(bakeMode==='anim'){
    titEl.textContent='RENDERING'; fillEl.style.width='0%'; lblEl.textContent=`0 / ${N}`;
    await yld();
    const br=new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true,premultipliedAlpha:false});
    br.setPixelRatio(1); br.setSize(bakeRes,bakeRes,true);
    br.outputColorSpace=THREE.SRGBColorSpace;
    br.toneMapping=THREE.ACESFilmicToneMapping;
    br.toneMappingExposure=exposure;
    br.shadowMap.enabled=true; br.shadowMap.type=THREE.PCFSoftShadowMap;

    let bakeCam;
    if(isOrtho){const hH=Math.abs(orthoCam.top)||2;bakeCam=new THREE.OrthographicCamera(-hH,hH,hH,-hH,0.01,300);}
    else{bakeCam=new THREE.PerspectiveCamera(45,1.0,0.01,300);}
    bakeCam.position.copy(cam.position);
    bakeCam.quaternion.copy(cam.quaternion);
    bakeCam.updateProjectionMatrix();

    const savedBG=scene.background; scene.background=null;
    const stride=bakeRes*4;
    const readBuf=new Uint8Array(bakeRes*bakeRes*4);
    const gl=br.getContext();

    for(let i=0;i<N;i++){
      if(clip&&mixer){
        const t=(i/N)*clip.duration;
        mixer.stopAllAction();
        const a=mixer.clipAction(clip);
        a.reset().play(); mixer.update(t);
        loadedScene.updateMatrixWorld(true);
      }
      br.render(scene,bakeCam);
      gl.readPixels(0,0,bakeRes,bakeRes,gl.RGBA,gl.UNSIGNED_BYTE,readBuf);
      const pix=new Uint8ClampedArray(bakeRes*bakeRes*4);
      for(let row=0;row<bakeRes;row++){
        const src=(bakeRes-1-row)*stride;
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
  let cropU={x0:bakeRes,y0:bakeRes,x1:-1,y1:-1};
  if(doCrop){
    for(const p of rawFrames){
      const b=alphaBounds(p,bakeRes,bakeRes);
      if(b){cropU.x0=Math.min(cropU.x0,b.x0);cropU.y0=Math.min(cropU.y0,b.y0);cropU.x1=Math.max(cropU.x1,b.x1);cropU.y1=Math.max(cropU.y1,b.y1);}
    }
  }
  let cx=0,cy=0,cw=bakeRes,ch=bakeRes;
  if(doCrop&&cropU.x1>=cropU.x0){
    const PAD=2;
    cx=Math.max(0,cropU.x0-PAD); cy=Math.max(0,cropU.y0-PAD);
    cw=Math.min(bakeRes,cropU.x1+PAD+1)-cx;
    ch=Math.min(bakeRes,cropU.y1+PAD+1)-cy;
  }

  const pFrames=[];
  let filtW=cw, filtH=ch;
  for(let i=0;i<N;i++){
    const cropped=cropPixels(rawFrames[i],bakeRes,cx,cy,cw,ch);
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

  const fps=clip?Math.max(1,Math.round(N/clip.duration)):12;
  const manifest={
    frameCount:N,frameWidth:filtW,frameHeight:filtH,columns:cols,rows,fps,
    mode:bakeMode,
    ...(bakeMode==='anim'?{clipName:clip?.name??null,clipDuration:clip?+clip.duration.toFixed(4):null}:{}),
    bakeRes,autoCrop:doCrop,filter:filterType,
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
  if(bakeMode==='anim') playClip(selClipIdx);

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
    bakeMode,bakeRes,doCrop,exposure,
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
    selClipIdx
  };
}
function applySettings(s){
  if(!s) return;
  bakeMode=s.bakeMode??'anim'; bakeRes=s.bakeRes??1024; doCrop=s.doCrop??true; exposure=s.exposure??1.0;
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

  syncUIFromState();
  applyTransform();
  updateRotDisplay(); updatePosDisplay(); updateAnchorDisplay();
  renderer.toneMappingExposure=exposure;

  if(s.selClipIdx!==undefined && clips.length){
    document.getElementById('clip-sel').value=s.selClipIdx;
    playClip(s.selClipIdx);
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
  document.getElementById('manual-section').style.display=bakeMode==='manual'?'':'none';
  document.getElementById('frames-row').style.display=bakeMode==='manual'?'none':'';
  syncBtnGroup('[data-r]','r',bakeRes);
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
  const rec={id, name:id, savedAt:Date.now(), glbBlob:currentGlbBlob, glbName:loadedName, settings:collectSettings(), attachmentsData:collectAttachmentsForSave()};
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
