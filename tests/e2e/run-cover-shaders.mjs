/** Production cover spheres and the legacy host shader compiler in an isolated, credential-disabled Electron. */
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../scripts/electron-runtime.mjs";
import { sourceIdentity } from "../../scripts/studio-dev/files.mjs";
const out = path.resolve(".studio-dev/cover-shaders");
await mkdir(out, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "studio-cover-shaders-"));
await build({
  entryPoints: ["tests/e2e/cover-shader-fixture.tsx"],
  outfile: path.join(out, "fixture.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
});
await build({
  entryPoints: ["src/main/project-cover-renderer.ts"],
  outfile: path.join(out, "host.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  external: ["electron"],
});
await writeFile(
  path.join(out, "index.html"),
  `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="../../dist/renderer/theme.css"><div id="root"></div><script src="fixture.js"></script>`,
);
const bootstrap = path.join(out, "check.cjs");
await writeFile(
  bootstrap,
  `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const {renderProjectCover}=require('./host.cjs');
app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(path.join(profile, "session"))});
const checks=[],report={source:${JSON.stringify(sourceIdentity(process.cwd()))},profile:${JSON.stringify(profile)},provider:'none',electron:process.versions.electron,checks};
function check(name,ok,detail){checks.push({name,ok,detail});console.log((ok?'PASS ':'FAIL ')+name);}
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:800,height:650,x:-12000,y:-12000,show:false,focusable:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});win.showInactive();
 const wc=win.webContents, js=code=>wc.executeJavaScript(code,true), wait=ms=>new Promise(r=>setTimeout(r,ms));
 async function paint(){await wc.capturePage();await wait(160);}
 async function until(code){for(let i=0;i<40;i++){await paint();if(await js(code))return true;}return false;}
 async function move(selector){const p=await js('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');wc.sendInputEvent({type:'mouseMove',...p});await paint();}
 try{
  await win.loadFile(${JSON.stringify(path.join(out, "index.html"))});
  const row=i=>'#row-'+i+' canvas';
  const time=i=>js('Number(document.querySelector('+JSON.stringify(row(i))+')?.dataset.time??NaN)');
  const frames=i=>js('Number(document.querySelector('+JSON.stringify(row(i))+')?.dataset.frames??0)');
  const pixel=(i,x,y)=>js('(()=>{const c=document.querySelector('+JSON.stringify(row(i))+'),g=c.getContext("2d");return [...g.getImageData(Math.round(c.width*'+x+'),Math.round(c.height*'+y+'),1,1).data];})()');
  check('every visible row paints its own sphere',await until('[...document.querySelectorAll("#rows canvas")].slice(0,6).every(c=>c.dataset.painted)'));
  check('a recipe paints a lit sphere: opaque centre, clear corner',(await pixel(3,0.5,0.5))[3]===255 && (await pixel(3,0.02,0.02))[3]===0,{centre:await pixel(3,0.5,0.5),corner:await pixel(3,0.02,0.02)});
  const t0=await time(0),r0=await time(1),f1=await frames(1);await wait(1000);await paint();
  const t1=await time(0);
  check('the selected sphere rests without hover or focus',t1===t0,{advanced:t1-t0,expected:0});
  check('a resting row holds one frame',await time(1)===r0&&await frames(1)===f1,{frames:await frames(1)});
  const f0=await frames(0);await wait(1000);await paint();const perSecond=(await frames(0))-f0;
  check('an idle selection schedules no animation',perSecond===0,{frames:perSecond,interval:'1000ms plus capture'});
  const held=await time(1);await move('#row-1');await wait(120);
  const early=await time(1);
  check('hover picks up from the held frame, easing in',early>held&&early-held<0.8,{held,early});
  const s0=await time(0);await wait(900);await paint();
  check('only the hovered row turns',(await time(0))===s0&&(await time(1))>early+0.5);
  await move('h1');await wait(700);const leftAt=await time(1);await wait(600);await paint();
  check('leaving eases out and holds that exact frame',await time(1)===leftAt,{leftAt,after:await time(1)});
  check('the 44px search cover shares the project clock',await js('document.querySelector("#search-cover canvas").dataset.time')===(await time(1)).toFixed(3));
  await js('window.coverFixture.remount()');await until('!!document.querySelector("#row-1 canvas")?.dataset.painted');
  check('remounting a row keeps its frame',await time(1)===leftAt,{before:leftAt,after:await time(1)});
  wc.debugger.attach('1.3');await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await js('document.querySelector("#row-1").focus()');wc.sendInputEvent({type:'keyDown',keyCode:'Tab'});wc.sendInputEvent({type:'keyUp',keyCode:'Tab'});
  const k0=await time(2);await wait(800);await paint();
  check('keyboard focus turns a cover',await js('document.activeElement.id')==='row-2'&&(await time(2))>k0,{active:await js('document.activeElement.id')});
  await js('document.activeElement.blur()');
  check('28px sidebar, 44px search and pointer cursor preserved',await js('document.querySelector("#row-1 .project-avatar").getBoundingClientRect().width===28 && document.querySelector("#search-cover .project-avatar").getBoundingClientRect().width===44 && getComputedStyle(document.querySelector("#row-1")).cursor==="pointer"'));
  check('uploaded image has no sphere canvas',await js('!!document.querySelector("#uploaded img") && !document.querySelector("#uploaded canvas")'));
  await js('document.querySelector("#row-0").focus()');await wait(300);
  await js('document.querySelector("#rows").scrollTop=880');await paint();
  check('legacy custom covers still compile: lens field and sphere',await until('!!document.querySelector("#row-21 canvas")?.dataset.painted && !!document.querySelector("#row-22 canvas")?.dataset.painted') && await js('!!document.querySelector("#row-21 .project-cover-lens") && !document.querySelector("#row-22 .project-cover-lens")'));
  check('a project without a saved look paints too',await until('!!document.querySelector("#row-23 canvas")?.dataset.painted'));
  await js('(()=>{const rows=document.querySelector("#rows");rows.style.height="540px";rows.scrollTop+=document.querySelector("#row-30").getBoundingClientRect().top-rows.getBoundingClientRect().top})()');await paint();
  check('every orb family compiles and paints a lit ball',await until('[...Array(12).keys()].every(k=>document.querySelector("#row-"+(30+k)+" canvas")?.dataset.painted)') && (await Promise.all([...Array(12).keys()].map(k=>pixel(30+k,0.5,0.5)))).every(p=>p[3]>0),{centres:await Promise.all([...Array(12).keys()].map(k=>pixel(30+k,0.5,0.5)))});
  check('Voxel drops the ring its blocks would break',await js('(()=>{const v=document.querySelector("#row-38 .project-avatar"),p=document.querySelector("#row-32 .project-avatar");return v.dataset.edge==="ragged"&&getComputedStyle(v).outlineStyle==="none"&&getComputedStyle(p).outlineStyle!=="none"})()'));
  fs.writeFileSync(${JSON.stringify(path.join(out, "orbs.png"))},(await wc.capturePage()).toPNG());
  await js('(()=>{const rows=document.querySelector("#rows");rows.style.height="240px";rows.scrollTop=880})()');await paint();
  const hidden0=await time(0);await wait(800);await paint();
  check('an off-screen focused sphere stops where it is',await time(0)===hidden0);
  await js('document.querySelector("#rows").scrollTop=0');await wait(500);await paint();
  check('scrolling the focused cover back resumes the turn',(await time(0))>hidden0);
  fs.writeFileSync(${JSON.stringify(path.join(out, "covers.png"))},(await wc.capturePage()).toPNG());
  await js('window.coverFixture.setCover(4,{kind:"recipe",family:"ember",palette:"lava",seed:9})');
  check('a new look replaces the old one on the same canvas',await until('document.querySelector("#row-4 canvas").dataset.painted==="recipe:ember:lava:9:"'));
  await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await wait(400);
  const m0=await time(0);await wait(800);await paint();
  check('reduced motion keeps still frames and stops motion',await time(0)===m0&&await js('!!document.querySelector("#row-0 canvas").dataset.painted'));
  fs.writeFileSync(${JSON.stringify(path.join(out, "reduced.png"))},(await wc.capturePage()).toPNG());
  await wc.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});await wait(600);await paint();
  check('motion preference change resumes the focused cover',(await time(0))>m0);
  await move('#row-0');
  await js('document.querySelector("main").inert=true');await wait(300);const i0=await time(0);await wait(700);await paint();
  check('an inert sidebar stops its spheres',await time(0)===i0);
  await js('document.querySelector("main").inert=false');await move('h1');await move('#row-0');await wait(600);await paint();check('removing inert lets the hovered cover resume',(await time(0))>i0);
  await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:false});wc.setBackgroundThrottling(true);
  win.hide();await wait(500);const h0=await time(0);await wait(600);
  check('a hidden app stops animation',await js('document.hidden')&&await time(0)===h0,{hidden:await js('document.hidden')});wc.setBackgroundThrottling(false);win.showInactive();await paint();
  await wait(400);
  await js('window.__gl.forEach(gl=>gl.getExtension("WEBGL_lose_context")?.loseContext())');await wait(300);
  const lost=await frames(0);await wait(700);await paint();
  check('a lost GPU keeps every painted frame without a retry loop',await frames(0)===lost&&(await pixel(0,0.5,0.5))[3]===255,{frames:[lost,await frames(0)]});
  const png=await renderProjectCover(await js('window.coverFixture.legacySurface'),23);check('host still compiles and bakes a legacy PNG',png.startsWith('data:image/png;base64,')&&png.length>500);
  fs.writeFileSync(${JSON.stringify(path.join(out, "host-cover.png"))},Buffer.from(png.split(',')[1],'base64'));
  let failure='';try{await renderProjectCover('return vec2(1.0);',23);}catch(e){failure=e.message;}
  check('host rejects type-invalid GLSL with an actionable compiler error',/compile|link/.test(failure),failure);
  await js('window.coverFixture.unmount()');check('unmount removes every sphere',await js('!document.querySelector("canvas")'));
  await win.loadFile(${JSON.stringify(path.join(out, "index.html"))});
  check('a restart shows every resting row from its saved still and compiles nothing',await until('[...document.querySelectorAll("#rows canvas")].slice(0,6).every(c=>c.dataset.still==="1")') && await js('window.__links')===0,{links:await js('window.__links'),stills:await js('[...document.querySelectorAll("#rows canvas")].slice(0,6).map(c=>c.dataset.still??"")')});
  const restored=await time(3);await move('#row-3');await wait(700);await paint();
  check('hovering a restored row compiles and turns it from the saved frame',await js('window.__links')>0&&(await time(3))>restored,{links:await js('window.__links'),restored,after:await time(3)});
  await win.loadFile(${JSON.stringify(path.join(out, "index.html"))},{query:{fallback:'1'}});await paint();
  check('without a GPU the rows keep their stills and never draw with it',await until('document.querySelector("#row-0 img")?.naturalWidth>0 && document.querySelector("#row-21 img")?.naturalWidth>0') && await js('[...document.querySelectorAll("canvas")].every(c=>!c.dataset.painted||c.dataset.still==="1")'),{stills:await js('[...document.querySelectorAll("canvas")].filter(c=>c.dataset.still).length')});
  fs.writeFileSync(${JSON.stringify(path.join(out, "fallback.png"))},(await wc.capturePage()).toPNG());
 }catch(e){check('runner completed',false,String(e.stack));}
 fs.writeFileSync(${JSON.stringify(path.join(out, "report.json"))},JSON.stringify(report,null,2));
 win.destroy();app.exit(checks.some(c=>!c.ok)?1:0);
});
`,
);
const child = spawn(resolveElectron(), fixtureElectronArgs([bootstrap]), {
  env: fixtureElectronEnv(),
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (b) => {
    output += b;
    process.stdout.write(b);
  });
const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
try {
  const code = await new Promise((resolve, reject) => {
    child.on("exit", resolve);
    child.on("error", reject);
  });
  await writeFile(path.join(out, "run.log"), output);
  process.exitCode = code === 0 ? 0 : 1;
  console.log(path.join(out, "report.json"));
} finally {
  clearTimeout(timer);
  await rm(profile, { recursive: true, force: true });
}
