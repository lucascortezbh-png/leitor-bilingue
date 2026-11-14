// Leitor Bilíngue 3.5 — rolagem contínua estável; gestos controlam a sincronização.
// Mantém o motor Bergamot da 3.3, OCR por página e arquivos locais em vendor/.
import {createLocalTranslator} from './engine.js?v=local3';
const $ = id => document.getElementById(id);
const original=$('original'),translated=$('translation'),status=$('status');
const fileEl=$('pdfFile'),pageNum=$('pageNum');
const btnPrev=$('prev'),btnNext=$('next'),btnGo=$('go');
const SOURCE='spa',MAX_PAGES_IN_VIEW=5,EDGE=290;
let pdf=null,totalPages=0,current=0,opening=false,session=0,viewEpoch=0,loading=false,ocrWorker=null;
let userRequestedPage=false,initialFillCount=0,autoLoadArmed=false,activePane=original;
// Eventos de scroll disparados por ajustes feitos pelo aplicativo não são gestos.
const silentScrollTargets=new WeakMap();
function setScrollWithoutFeedback(p,position){
 const limit=Math.max(0,p.scrollHeight-p.clientHeight);
 const target=Math.max(0,Math.min(limit,position));
 if(Math.abs(p.scrollTop-target)<0.5)return;
 silentScrollTargets.set(p,target);
 p.scrollTop=target;
}
function consumeSilentScroll(p){
 if(!silentScrollTargets.has(p))return false;
 const target=silentScrollTargets.get(p);
 silentScrollTargets.delete(p);
 return Math.abs(p.scrollTop-target)<2;
}
function topTextAnchor(p){
 const bounds=p.getBoundingClientRect(),cut=bounds.top+12;
 for(const node of p.querySelectorAll('.mark, .segment, .empty')){
  const r=node.getBoundingClientRect();
  if(r.bottom>cut&&r.top<bounds.bottom)return {node,top:r.top};
 }
 return null;
}
function setTranslatedText(node,value,css){
 // Preserva a posição do trecho já visível quando uma tradução anterior cresce.
 const anchor=topTextAnchor(translated);
 node.textContent=value;
 if(css)node.className=css;
 if(anchor&&anchor.node.isConnected){
  const displacement=anchor.node.getBoundingClientRect().top-anchor.top;
  if(Math.abs(displacement)>1)setScrollWithoutFeedback(translated,translated.scrollTop+displacement);
 }
}
const pageBlocks=new Map(),translationCache=new Map();
let translationQueue=[],translating=false;
const setStatus=msg=>{status.textContent=msg;};
function navigation(){
 const has=!!pdf;
 pageNum.disabled=!has||opening;
 btnPrev.disabled=!has||opening||current<=1;
 btnNext.disabled=!has||opening||current>=totalPages;
 btnGo.disabled=!has||opening;
 $('total').textContent='de '+totalPages;
}
function el(tag,cls,txt){const e=document.createElement(tag);if(cls)e.className=cls;if(txt!==undefined)e.textContent=txt;return e;}
function chunks(input,max=460){
 const result=[];let part='';const enc=new TextEncoder();
 for(const word of input.replace(/\s+/g,' ').trim().split(' ')){
  if(!word)continue;
  const candidate=part?part+' '+word:word;
  if(enc.encode(candidate).length<=max){part=candidate;continue;}
  if(part)result.push(part);part='';let piece='';
  for(const ch of word){if(enc.encode(piece+ch).length>max){if(piece)result.push(piece);piece='';}piece+=ch;}
  part=piece;
 }
 if(part)result.push(part);return result;
}
function parseItems(items){
 const lines=[];
 for(const item of items){
  const str=(item.str||'').trim();if(!str)continue;
  const y=item.transform?.[5]??0,x=item.transform?.[4]??0;
  const height=Math.max(6,Math.abs(item.height||item.transform?.[3]||12));
  let line=lines.find(l=>Math.abs(l.y-y)<2.5);
  if(!line){line={y,height,spans:[]};lines.push(line);}
  line.spans.push({x,str});
 }
 lines.sort((a,b)=>b.y-a.y);
 let paragraphs=[],part='',prior=null;
 for(const line of lines){
  const text=line.spans.sort((a,b)=>a.x-b.x).map(v=>v.str).join(' ');
  if(prior&&Math.abs(prior.y-line.y)>Math.max(15,prior.height*1.6)){
   if(part)paragraphs.push(part);part=text;
  }else if(part.endsWith('-'))part=part.slice(0,-1)+text;
  else part+=(part?' ':'')+text;
  prior=line;
 }
 if(part)paragraphs.push(part);
 return paragraphs.flatMap(p=>chunks(p));
}
function parseOCR(text){return (text||'').replace(/\r/g,'').split(/\n\s*\n/g).flatMap(p=>chunks(p));}
async function recognize(page,n,tok,epoch){
 if(!globalThis.Tesseract?.createWorker)throw new Error('O módulo OCR não carregou. Confira a conexão.');
 if(!ocrWorker){
  setStatus('Carregando OCR em espanhol…');
  ocrWorker=await Tesseract.createWorker(SOURCE,1,{logger:m=>{
   if(session===tok&&viewEpoch===epoch&&m.status==='recognizing text')
    setStatus(`Reconhecendo página ${n}: ${Math.round(100*m.progress)}%`);
  }});
 }
 const base=page.getViewport({scale:1});
 const scale=Math.min(2.1,Math.sqrt(2400000/(base.width*base.height)));
 const viewport=page.getViewport({scale});
 const canvas=document.createElement('canvas');
 canvas.width=Math.round(viewport.width);canvas.height=Math.round(viewport.height);
 try{
  await page.render({canvasContext:canvas.getContext('2d',{alpha:false}),viewport}).promise;
  if(session!==tok||viewEpoch!==epoch)return [];
  const ret=await ocrWorker.recognize(canvas);
  return parseOCR(ret?.data?.text);
 }finally{canvas.width=canvas.height=0;}
}
function sortedPages(){return Array.from(pageBlocks.keys()).sort((a,b)=>a-b);}
function resetText(){
 pageBlocks.clear();translationQueue=[];
 original.replaceChildren(el('p','empty','Carregando página…'));
 translated.replaceChildren(el('p','empty','Preparando tradução…'));
 activePane=original;setScrollWithoutFeedback(original,0);setScrollWithoutFeedback(translated,0);
 initialFillCount=0;autoLoadArmed=false;
}
function pageNodes(n,texts,mode){
 const left=el('section','page-block'),right=el('section','page-block');
 left.dataset.page=String(n);right.dataset.page=String(n);
 left.append(el('div','mark',`PÁGINA ${n} · ${mode}`));
 right.append(el('div','mark',`PÁGINA ${n}`));
 const outputs=[];
 if(!texts.length){
  left.append(el('p','empty','Nenhum texto encontrado nesta página.'));
  right.append(el('p','empty','Sem tradução nesta página.'));
 }else{
  texts.forEach((text,i)=>{
   const a=el('p','segment',text),b=el('p','segment pending','Aguardando tradução local…');
   a.dataset.index=String(i);b.dataset.index=String(i);
   left.append(a);right.append(b);outputs.push(b);
  });
 }
 return {left,right,outputs,texts,n};
}
function trimPages(direction){
 while(pageBlocks.size>MAX_PAGES_IN_VIEW){
  const nums=sortedPages();
  const remove=direction==='prepend'?nums[nums.length-1]:nums[0];
  const block=pageBlocks.get(remove);
  const oldLeftHeight=original.scrollHeight,oldRightHeight=translated.scrollHeight;
  const oldLeftTop=original.scrollTop,oldRightTop=translated.scrollTop;
  const wasAbove=direction!=='prepend';
  block.left.remove();block.right.remove();pageBlocks.delete(remove);
  if(wasAbove){
   setScrollWithoutFeedback(original,Math.max(0,oldLeftTop-(oldLeftHeight-original.scrollHeight)));
   setScrollWithoutFeedback(translated,Math.max(0,oldRightTop-(oldRightHeight-translated.scrollHeight)));
  }
 }
}
function insertPage(block,direction){
 const empty=pageBlocks.size===0;
 if(empty){original.replaceChildren();translated.replaceChildren();}
 if(direction==='prepend'&&!empty){
  // Retém o texto que estava visível quando adicionamos a página anterior.
  const oldLeftHeight=original.scrollHeight,oldRightHeight=translated.scrollHeight;
  const oldLeftTop=original.scrollTop,oldRightTop=translated.scrollTop;
  original.prepend(block.left);translated.prepend(block.right);
  setScrollWithoutFeedback(original,oldLeftTop+original.scrollHeight-oldLeftHeight);
  setScrollWithoutFeedback(translated,oldRightTop+translated.scrollHeight-oldRightHeight);
 }else{original.append(block.left);translated.append(block.right);}
 pageBlocks.set(block.n,block);
 trimPages(direction);
}
async function loadPage(n,direction='append',epoch=viewEpoch){
 if(!pdf||opening||loading||n<1||n>totalPages||pageBlocks.has(n))return false;
 loading=true;const tok=session;let page=null;
 setStatus(`Carregando página ${n}/${totalPages}…`);
 try{
  page=await pdf.getPage(n);
  const content=await page.getTextContent();
  if(tok!==session||epoch!==viewEpoch)return false;
  let texts=parseItems(content.items),mode='Texto';
  if(!texts.length){
   mode='OCR';setStatus(`Página ${n}: imagem digitalizada. Iniciando OCR…`);
   texts=await recognize(page,n,tok,epoch);
  }
  if(tok!==session||epoch!==viewEpoch)return false;
  const block=pageNodes(n,texts,mode);
  insertPage(block,direction);
  if(texts.length)translationQueue.push({block,epoch,tok});
  else setStatus(`Página ${n}/${totalPages}: não foi possível reconhecer texto.`);
  if(current===0){current=n;pageNum.value=String(n);navigation();}
  void drainTranslationQueue();
  return true;
 }catch(err){
  if(tok===session&&epoch===viewEpoch){
   const block=pageNodes(n,[],'Erro');
   block.left.append(el('p','failed',err.message||String(err)));
   insertPage(block,direction);
   setStatus(`Falha ao carregar página ${n}: ${err.message||String(err)}`);
  }
  return false;
 }finally{
  try{page?.cleanup()}catch{}
  if(tok===session&&epoch===viewEpoch){
   loading=false;
   updateCurrentPage();
   scheduleEdgeCheck();
  }
 }
}
async function drainTranslationQueue(){
 if(translating)return;
 translating=true;
 try{
  while(translationQueue.length){
   const task=translationQueue.shift();
   if(task.tok!==session||task.epoch!==viewEpoch||!pageBlocks.has(task.block.n))continue;
   let engine;
   try{
    engine=await createLocalTranslator(stage=>{
     if(task.tok===session&&task.epoch===viewEpoch)setStatus('Tradutor local: '+stage);
    });
   }catch(err){
    if(task.tok!==session||task.epoch!==viewEpoch)continue;
    for(const p of task.block.outputs){setTranslatedText(p,'Tradutor local não carregou.','segment failed');}
    setStatus('Bergamot indisponível: '+(err?.message||String(err)));
    continue;
   }
   for(let i=0;i<task.block.texts.length;i++){
    if(task.tok!==session||task.epoch!==viewEpoch||!pageBlocks.has(task.block.n))break;
    const p=task.block.outputs[i],text=task.block.texts[i],key='es-pt:'+text;
    try{
     setTranslatedText(p,'Traduzindo localmente…');
     let result=translationCache.get(key);
     if(!result){
      result=await engine.translate(text);
      translationCache.set(key,result);
      if(translationCache.size>250)translationCache.delete(translationCache.keys().next().value);
     }
     if(task.tok!==session||task.epoch!==viewEpoch||!pageBlocks.has(task.block.n))break;
     setTranslatedText(p,result,'segment');
     setStatus(`Página ${task.block.n}/${totalPages}: ${i+1}/${task.block.texts.length} trechos traduzidos · sem MyMemory`);
    }catch(err){
     if(task.tok!==session||task.epoch!==viewEpoch)break;
     setTranslatedText(p,'Erro de tradução local: '+(err?.message||String(err)),'segment failed');setStatus('O tradutor local falhou. Não foi usado serviço remoto.');
     break;
    }
    await new Promise(r=>setTimeout(r,0));
   }
  }
 }finally{translating=false;}
}
async function openFile(file){
 const tok=++session;viewEpoch++;
 opening=true;loading=false;
 resetText();pdf&&setStatus('Substituindo PDF anterior…');
 if(pdf){try{await pdf.destroy()}catch{}pdf=null;}
 current=0;totalPages=0;navigation();setStatus('Abrindo '+file.name+'…');
 try{
  if(!globalThis.pdfjsLib)throw new Error('PDF.js não carregou: confira a conexão.');
  pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const data=new Uint8Array(await file.arrayBuffer());
  const doc=await pdfjsLib.getDocument({data}).promise;
  if(tok!==session){await doc.destroy();return;}
  pdf=doc;totalPages=doc.numPages;current=1;pageNum.value='1';opening=false;navigation();
  await loadPage(1,'append',viewEpoch);
 }catch(err){
  if(tok===session){opening=false;navigation();setStatus('Não foi possível abrir: '+(err.message||String(err)));}
 }
}
async function jumpToPage(n){
 if(!pdf||opening||!Number.isInteger(n)||n<1||n>totalPages)return;
 ++viewEpoch;loading=false;
 resetText();current=n;pageNum.value=String(n);navigation();
 await loadPage(n,'append',viewEpoch);
}
fileEl.addEventListener('change',e=>{const f=e.target.files?.[0];if(f)void openFile(f);});
btnNext.onclick=()=>void jumpToPage(current+1);
btnPrev.onclick=()=>void jumpToPage(current-1);
btnGo.onclick=()=>void jumpToPage(Number(pageNum.value));
$('testEngine').onclick=async()=>{
 const button=$('testEngine'),label=$('teststatus');button.disabled=true;
 const progress=stage=>{label.textContent='Diagnóstico: '+stage;setStatus('Bergamot: '+stage);};
 progress('iniciando teste espanhol → português…');
 try{
  const engine=await createLocalTranslator(progress);
  progress('Biblioteca carregada; baixando modelos e traduzindo a frase…');
  const result=await engine.translate('La arquitectura y el urbanismo estudian las ciudades.');
  label.textContent='Tradução concluída: '+result;
  setStatus('Bergamot respondeu ao teste. Agora podemos avaliar a tradução do PDF.');
 }catch(e){
  label.textContent='Falha no teste Bergamot: '+(e?.message||String(e));
  setStatus('Bergamot não completou o teste; a versão 2 continua independente.');
 }finally{button.disabled=false;}
};
// Sincronização unidirecional: somente a coluna escolhida por um gesto
// pode mover a outra. Assim a tradução chegando de forma assíncrona não
// aciona um scroll de volta, causando saltos ou movimento involuntário.
let edgeScheduled=false;
function alignPanes(from,to){
 if(!pageBlocks.size)return;
 const nums=sortedPages();let chosen=nums[0];
 const point=from.scrollTop+14;
 for(const n of nums){
  const block=pageBlocks.get(n),node=from===original?block.left:block.right;
  if(node.offsetTop<=point)chosen=n;else break;
 }
 const block=pageBlocks.get(chosen);
 const src=from===original?block.left:block.right;
 const dest=to===original?block.left:block.right;
 const fraction=Math.min(1,Math.max(0,(point-src.offsetTop)/Math.max(1,src.offsetHeight)));
 const target=Math.max(0,dest.offsetTop+dest.offsetHeight*fraction-14);
 setScrollWithoutFeedback(to,target);
}
function updateCurrentPage(){
 if(!pageBlocks.size)return;
 const p=activePane,pt=p.scrollTop+Math.min(p.clientHeight*.24,110);
 let visible=sortedPages()[0];
 for(const n of sortedPages()){
  const node=p===original?pageBlocks.get(n).left:pageBlocks.get(n).right;
  if(node.offsetTop<=pt)visible=n;else break;
 }
 if(current!==visible){current=visible;if(document.activeElement!==pageNum)pageNum.value=String(visible);navigation();}
}
function scheduleEdgeCheck(){
 if(edgeScheduled)return;
 edgeScheduled=true;
 requestAnimationFrame(()=>{edgeScheduled=false;void maybeLoadMore();});
}
async function maybeLoadMore(){
 if(!pdf||opening||loading||!pageBlocks.size)return;
 const p=activePane,nums=sortedPages();
 const bottomGap=p.scrollHeight-p.scrollTop-p.clientHeight;
 const topGap=p.scrollTop;
 if(bottomGap<EDGE&&nums[nums.length-1]<totalPages&&(autoLoadArmed||initialFillCount<2)){
  if(!autoLoadArmed)initialFillCount++;
  autoLoadArmed=false;
  await loadPage(nums[nums.length-1]+1,'append',viewEpoch);
 }else if(topGap<EDGE&&nums[0]>1&&autoLoadArmed){
  autoLoadArmed=false;
  await loadPage(nums[0]-1,'prepend',viewEpoch);
 }
}
function bindScroll(p,other){
 const select=()=>{activePane=p;};
 const scrollingGesture=()=>{select();autoLoadArmed=true;scheduleEdgeCheck();};
 p.addEventListener('touchstart',select,{passive:true});
 p.addEventListener('touchmove',scrollingGesture,{passive:true});
 p.addEventListener('wheel',scrollingGesture,{passive:true});
 p.addEventListener('pointerdown',select,{passive:true});
 p.addEventListener('keydown',select);
 p.addEventListener('scroll',()=>{
  if(consumeSilentScroll(p))return;
  if(p!==activePane)return;
  alignPanes(p,other);
  updateCurrentPage();scheduleEdgeCheck();
 },{passive:true});
}
bindScroll(original,translated);bindScroll(translated,original);
navigation();
