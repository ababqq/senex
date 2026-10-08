/** Rebuild the standalone, network-free AG-966 cover experiment with the production renderer. */
import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
const script = await build({
  stdin: {
    contents: `
import {projectCoverUrl,COVER_STYLES} from './src/shared/project-cover.ts';
import {coverFromBrief} from './src/shared/project-library.ts';
const input=document.querySelector('input'); let palette=null;
const cards=document.querySelector('#cards');
function draw(){const brief=input.value||'Untitled project';document.querySelector('#default').src=projectCoverUrl();cards.replaceChildren();
 for(const style of COVER_STYLES){const cover=coverFromBrief(brief,style.id);if(palette!==null)cover.palette=palette;
 const card=document.createElement('article');const title=document.createElement('h2');title.textContent=style.label;card.append(title);
 const img=document.createElement('img');img.src=projectCoverUrl(cover);img.className='hero';card.append(img);
 const row=document.createElement('div');row.className='row';const avatar=document.createElement('img');avatar.src=img.src;row.append(avatar);const name=document.createElement('span');name.textContent=brief;row.append(name);card.append(row);cards.append(card);
 }}
input.addEventListener('input',draw);document.querySelectorAll('[data-palette]').forEach(button=>button.onclick=()=>{palette=button.dataset.palette==='auto'?null:Number(button.dataset.palette);document.querySelectorAll('[data-palette]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));draw();});
document.querySelectorAll('[data-example]').forEach(b=>b.onclick=()=>{input.value=b.dataset.example;draw();});draw();
`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
});
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Genex · Project cover experiments</title><style>
@font-face{font-family:Geist;src:url('../../src/renderer/fonts/GeistMono-variable.woff2')}*{box-sizing:border-box}body{margin:0;background:#131316;color:#e6e6e8;font:14px/1.5 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:52px 32px}header{display:flex;justify-content:space-between;align-items:start;gap:32px}.eyebrow{font:11px Geist,monospace;color:#97959e;letter-spacing:.12em;text-transform:uppercase}h1{font-size:32px;font-weight:450;letter-spacing:-1px;margin:12px 0}p{color:#a09fa9;max-width:640px;margin:0 0 24px}.default{flex:none;text-align:center}.default img{display:block;width:64px;height:64px;border-radius:50%;margin:0 auto 8px}.default small{color:#9897a1}label{display:block;color:#a09fa9;font-size:12px;margin-bottom:8px}input{width:100%;padding:14px;background:#202025;color:#f4f4f6;border:1px solid #48444f;border-radius:10px;font:14px Geist,monospace;outline-color:#969dcc}.examples,.palettes{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}button{cursor:pointer;background:#242329;color:#aeacb7;border:1px solid #38353f;border-radius:6px;padding:7px 10px;font:12px system-ui}button:hover,button[aria-pressed=true]{background:#3b3646;color:white;border-color:#696178}#cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;margin-top:36px}h2{font-size:14px;font-weight:500;margin:0 0 14px}.hero{width:100%;aspect-ratio:1;border-radius:14px;outline:1px solid #ffffff18;image-rendering:auto}.row{display:flex;gap:10px;align-items:center;margin-top:16px;padding:10px;background:#242328;border-radius:8px;min-width:0}.row img{width:28px;height:28px;border-radius:50%;outline:1px solid #ffffff20}.row span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}footer{border-top:1px solid #ffffff15;margin-top:36px;padding-top:18px;color:#77747f;font-size:12px}@media(max-width:750px){#cards{grid-template-columns:1fr}main{padding:28px 20px}header{display:block}.default{display:none}}
</style><main><header><div><div class="eyebrow">Genex / AG-966 / exploration</div><h1>A small world for every project.</h1><p>Procedural cover directions, using the same renderer as the sidebar. Change the brief or palette to explore. These are experiments, not final artwork.</p></div><div class="default"><img id="default" alt="Default project image"><small>Before the first brief</small></div></header><label for="brief">First project brief</label><input id="brief" value="A snowy temple on a floating island" maxlength="500"><div class="examples"><button data-example="A snowy temple on a floating island">Ice temple</button><button data-example="A neon drift racing project">Night drive</button><button data-example="A quiet fishing village">Fishing village</button><button data-example="A desert kingdom at sunset">Desert kingdom</button></div><div class="palettes" aria-label="Color palette"><button data-palette="auto" aria-pressed="true">From brief</button><button data-palette="0">Violet dusk</button><button data-palette="1">Cold blue</button><button data-palette="2">Sage mist</button><button data-palette="3">Rose sand</button></div><section id="cards"></section><footer>Local SVG geometry · no model calls · no tokens · no network · deterministic from the brief. The row previews show the actual 28px circular crop.</footer></main><script>${script.outputFiles[0].text}</script></html>`;
await writeFile("design/experiments/ag-966-covers.html", html);
