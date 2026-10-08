/** Independent custom runtime: not the starter or installStudio. Same deterministic content on each backend. */
export function optimizationProject(backend, instanced = false) {
  return `import * as THREE from ${JSON.stringify(backend === "webgl" ? "three" : "three/webgpu")};
const renderer = ${backend === "webgl" ? "new THREE.WebGLRenderer({antialias:false,preserveDrawingBuffer:true})" : `new THREE.WebGPURenderer({antialias:false,forceWebGL:${backend === "fallback"}})`};
${backend !== "webgl" ? "await renderer.init();" : ""}
renderer.setPixelRatio(1);renderer.setSize(960,600,false);document.body.appendChild(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color(0x1b253b);
const camera=new THREE.PerspectiveCamera(55,960/600,0.1,100);camera.position.set(0,0,16);camera.lookAt(0,0,0);
const geometry=new THREE.BoxGeometry(.7,.7,.7),material=new THREE.MeshBasicMaterial({color:0x61cde8});
const group=new THREE.Group();scene.add(group);
const transforms=[];for(let y=0;y<8;y++)for(let x=0;x<8;x++)transforms.push(new THREE.Matrix4().makeTranslation(x-3.5,y-3.5,0));
${instanced ? 'const batch=new THREE.InstancedMesh(geometry,material,64);batch.userData.tag="blocks";transforms.forEach((m,i)=>batch.setMatrixAt(i,m));group.add(batch);' : 'for(const m of transforms){const mesh=new THREE.Mesh(geometry,material);mesh.userData.tag="blocks";mesh.applyMatrix4(m);group.add(mesh);}'}
const hudScene=new THREE.Scene(),hudCamera=new THREE.OrthographicCamera(-1,1,1,-1,0,10);hudCamera.position.z=1;
const hud=new THREE.Mesh(new THREE.PlaneGeometry(.1,.1),new THREE.MeshBasicMaterial({color:0xffffff,depthTest:false}));hudScene.add(hud);
let running=false,frame=0,seed=1234;const keys=new Set();
function draw(){renderer.render(scene,camera);const clear=renderer.autoClear;renderer.autoClear=false;renderer.render(hudScene,hudCamera);renderer.autoClear=clear;}
function loop(){requestAnimationFrame(loop);if(running){frame++;draw();}}requestAnimationFrame(loop);
window.__studio={
 inspect:()=>({scene,renderer,camera}),seed:n=>{seed=n;frame=0;running=false;keys.clear();return true;},start:()=>{running=true;return true;},pause:()=>{running=false;return true;},
 step:ms=>{frame+=Math.max(1,Math.round(ms/(1000/60)));draw();return true;},
 state:()=>({seed,frame,entities:64,held:[...keys],running,score:0,error:null}),
 debugCamera:name=>{if(name!=="default")return{ok:false};draw();return{ok:true};},cameras:()=>["default"],eyes:()=>[],demos:()=>[],audio:()=>({enabled:false}),
 injectInput:a=>{for(const k of a.down??[])keys.add(k);for(const k of a.up??[])keys.delete(k);return true;},
 capture:()=>{draw();return renderer.domElement.toDataURL("image/png");}
};draw();window.fixtureReady=true;
`;
}
export const optimizationHTML = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}canvas{width:960px;height:600px}</style><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/webgpu":"/vendor/three.webgpu.js","three/tsl":"/vendor/three.tsl.js"}}</script></head><body><script type="module" src="src/main.js"></script></body></html>`;
