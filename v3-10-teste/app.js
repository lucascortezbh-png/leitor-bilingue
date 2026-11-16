// Leitor Bilíngue 3.10 — tradução por frases, revisão segmentada; mantém OCR, Bergamot e rolagem.
// Mantém o motor Bergamot da 3.3, OCR por página e arquivos locais em vendor/.
import {createLocalTranslator} from './engine.js?v=local3';
const $ = id => document.getElementById(id);
const original=$('original'),translated=$('translation'),status=$('status');
const fileEl=$('pdfFile'),pageNum=$('pageNum');
const btnPrev=$('prev'),btnNext=$('next'),btnGo=$('go'),btnReview=$('reviewOcr'),btnRetranslate=$('retranslatePage');
const SOURCE='spa',MAX_PAGES_IN_VIEW=5,EDGE=290;
let pdf=null,totalPages=0,current=0,opening=false,session=0,viewEpoch=0,loading=false,reviewing=false,ocrWorker=null;
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
 pageNum.disabled=!has||opening||reviewing;
 btnPrev.disabled=!has||opening||reviewing||current<=1;
 btnNext.disabled=!has||opening||reviewing||current>=totalPages;
 btnGo.disabled=!has||opening||reviewing;
 btnReview.disabled=!has||opening||loading||reviewing||!pageBlocks.size;
 btnRetranslate.disabled=!has||opening||loading||reviewing||!pageBlocks.size;
 figureButton.disabled=!has||opening||loading||reviewing||!pageBlocks.size;
 $('total').textContent='de '+totalPages;
}
function el(tag,cls,txt){const e=document.createElement(tag);if(cls)e.className=cls;if(txt!==undefined)e.textContent=txt;return e;}
// Divide o texto em frases completas, evitando cortar no meio por contagem
// de palavras. Preserva pontuação e não acrescenta palavras inventadas.
const utf8size=s=>new TextEncoder().encode(s).length;
function sentenceParts(input){
 const source=(input||'').replace(/\s+/g,' ').trim();
 if(!source)return [];
 const endings=[];let start=0;
 const abbrev=/^(sr|sra|srta|dr|dra|prof|profa|fig|p|pp|vol|núm|no|art|av|etc)$/i;
 for(let i=0;i<source.length;i++){
  const ch=source[i];if(!'.!?'.includes(ch))continue;
  let next=i+1;
  while(next<source.length&&/[”"’»)]/.test(source[next]))next++;
  if(next===source.length){endings.push(source.slice(start).trim());start=next;break;}
  if(!/\s/.test(source[next]))continue;
  const prior=source.slice(start,i).match(/([\p{L}]+)$/u)?.[1]||'';
  if(ch==='.'&&abbrev.test(prior))continue;
  let after=next;while(after<source.length&&/\s/.test(source[after]))after++;
  if(after>=source.length){endings.push(source.slice(start,next).trim());start=after;break;}
  if(!/[A-ZÁÉÍÓÚÜÑ¿¡“"0-9]/.test(source[after]))continue;
  endings.push(source.slice(start,next).trim());start=after;i=after-1;
 }
 if(start<source.length)endings.push(source.slice(start).trim());
 return endings.filter(Boolean);
}
function splitLong(input,max){
 const parts=[];let s=input.trim();
 while(utf8size(s)>max){
  let best=-1,score=-1;
  for(let i=0;i<s.length-1;i++){
   if(!/[\s,;:]/.test(s[i]))continue;
   const first=s.slice(0,i+1).trim(),byte=utf8size(first);
   if(byte>max||byte<max*.45)continue;
   const bonus=/[,;:]/.test(s[i])?max*.18:0;
   if(byte+bonus>score){score=byte+bonus;best=i+1;}
  }
  if(best<0){for(let i=0;i<s.length;i++){if(utf8size(s.slice(0,i+1))>max){best=Math.max(1,i);break;}}}
  if(best<=0)break;
  parts.push(s.slice(0,best).trim());s=s.slice(best).trim();
 }
 if(s)parts.push(s);
 return parts;
}
function chunks(input,max=310){
 return sentenceParts(input).flatMap(t=>utf8size(t)>max?splitLong(t,max):[t]);
}
// Revisão opcional: traduz cláusulas menores para testar recuperação de
// inícios de frases que o modelo local por vezes omite.
function precisionParts(input){
 const base=chunks(input,190),out=[];
 for(const s of base){
  if(utf8size(s)<85){out.push(s);continue;}
  const candidate=[];let start=0;
  for(let i=0;i<s.length;i++){
   if(s[i]!==','&&s[i]!==';'&&s[i]!==':')continue;
   const left=s.slice(start,i+1).trim();
   if(utf8size(left)>=38&&utf8size(s.slice(i+1).trim())>=30){candidate.push(left);start=i+1;}
  }
  if(candidate.length)out.push(...candidate,s.slice(start).trim());else out.push(s);
 }
 return out.filter(Boolean);
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

// Revisão OCR v3.9. O tamanho do canvas depende dos pontos do PDF, não da tela.
// O limite de pixels evita exceder a memória de aparelhos antigos.
const OCR_DPI={auto:185,regions:185,precision:225};
const OCR_MAX_PIXELS={auto:4300000,regions:4300000,precision:5500000};
const manualFigures=new Map();
const ocrMode=$('ocrMode'),figureButton=$('figureButton');
const figureDialog=$('figureDialog'),figureCanvas=$('figureCanvas'),figureHint=$('figureHint');
let manualPage=0,figureDragging=false,figureStart=null,figureSelection=null,figureDrawing=null;
function ocrViewport(page,mode){
 const base=page.getViewport({scale:1});
 const fixed=OCR_DPI[mode]||185;
 const pixelCap=OCR_MAX_PIXELS[mode]||4300000;
 const scale=Math.min(fixed/72,Math.sqrt(pixelCap/(base.width*base.height)));
 return page.getViewport({scale});
}
function boundedRect(r,w,h){
 const x=Math.max(0,Math.floor(r.left)),y=Math.max(0,Math.floor(r.top));
 const right=Math.min(w,Math.ceil(r.right)),bottom=Math.min(h,Math.ceil(r.bottom));
 return {left:x,top:y,width:Math.max(0,right-x),height:Math.max(0,bottom-y)};
}
function normRect(r,w,h){return {left:r.left/w,top:r.top/h,right:r.right/w,bottom:r.bottom/h};}
function absoluteRect(r,w,h){return {left:r.left*w,top:r.top*h,right:r.right*w,bottom:r.bottom*h};}
// Procura regiões grandes e coloridas. Marcadores de uma única palavra não
// podem ser classificados como fotografia (restrições de altura e largura).
function locateColorFigure(canvas){
 const w=canvas.width,h=canvas.height;
 const ctx=canvas.getContext('2d',{willReadFrequently:true});
 const {data}=ctx.getImageData(0,0,w,h);
 const step=Math.max(3,Math.round(w/430));
 const rows=Math.ceil(h/step),cols=Math.ceil(w/step);
 const hits=new Uint16Array(rows);
 const color=(x,y)=>{
   const i=(y*w+x)*4,r=data[i],g=data[i+1],b=data[i+2];
   return Math.max(r,g,b)-Math.min(r,g,b)>34 && Math.min(r,g,b)<245 && Math.max(r,g,b)>65;
 };
 for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){
   if(color(Math.min(w-1,x*step),Math.min(h-1,y*step)))hits[y]++;
 }
 const minHits=Math.max(5,Math.floor(cols*.025));
 const runs=[];let start=-1,last=-1;
 for(let y=0;y<rows;y++){
   if(hits[y]>=minHits){if(start<0)start=y;last=y;}
   else if(start>=0&&y-last>Math.max(3,Math.ceil(h*.01/step))){runs.push([start,last]);start=-1;}
 }
 if(start>=0)runs.push([start,last]);
 const candidates=[];
 for(const [begin,end] of runs){
   if((end-begin)*step<h*.09)continue;
   let x0=cols,x1=0;
   const colHits=new Uint16Array(cols);
   for(let y=begin;y<=end;y++)for(let x=0;x<cols;x++)if(color(Math.min(w-1,x*step),Math.min(h-1,y*step)))colHits[x]++;
   const minCol=Math.max(3,Math.floor((end-begin+1)*.045));
   for(let x=0;x<cols;x++)if(colHits[x]>=minCol){x0=Math.min(x0,x);x1=Math.max(x1,x);}
   if(x0>=x1)continue;
   const rect={left:Math.max(0,(x0-2)*step),right:Math.min(w,(x1+3)*step),top:Math.max(0,(begin-2)*step),bottom:Math.min(h,(end+3)*step)};
   const rw=rect.right-rect.left,rh=rect.bottom-rect.top;
   if(rw<w*.16||rw>w*.75||rh<h*.09||rh>h*.70)continue;
   if(rect.right>w*.81||w-rect.right<w*.15)continue; // texto legível precisa caber ao lado
   candidates.push({rect,score:rw*rh});
 }
 candidates.sort((a,b)=>b.score-a.score);
 return candidates.length?candidates[0].rect:null;
}
// Identifica espaços em branco onde é seguro cortar uma página longa em faixas.
// Não altera nem inventa palavras; só escolhe retângulos para passar ao OCR.
function splitHorizontalBands(canvas){
 const w=canvas.width,h=canvas.height;
 const {data}=canvas.getContext('2d',{willReadFrequently:true}).getImageData(0,0,w,h);
 const rows=Math.ceil(h/4),ink=new Uint16Array(rows),stepX=Math.max(3,Math.round(w/340));
 for(let ry=0;ry<rows;ry++)for(let x=0;x<w;x+=stepX){
  const y=Math.min(h-1,ry*4),i=(y*w+x)*4;
  if(data[i]<175&&data[i+1]<175&&data[i+2]<175)ink[ry]++;
 }
 const minInk=Math.max(2,Math.ceil(w/stepX*.007));
 const gaps=[];let begin=-1;
 for(let y=0;y<rows;y++){
  if(ink[y]<minInk){if(begin<0)begin=y;}
  else if(begin>=0){if(y-begin>=4)gaps.push({top:begin*4,bottom:y*4,mid:Math.round((begin+y)*2)});begin=-1;}
 }
 if(begin>=0)gaps.push({top:begin*4,bottom:h,mid:Math.round((begin*4+h)/2)});
 const cuts=[0],target=Math.min(4,Math.max(2,Math.round(h/1000)));
 for(let i=1;i<target;i++){
  const wanted=h*i/target;
  const choices=gaps.filter(g=>Math.abs(g.mid-wanted)<h*.13&&g.mid>h*.09&&g.mid<h*.91);
  choices.sort((a,b)=>Math.abs(a.mid-wanted)-Math.abs(b.mid-wanted));
  if(choices.length&&choices[0].mid-cuts[cuts.length-1]>h*.10)cuts.push(choices[0].mid);
 }
 cuts.push(h);
 const result=[];
 for(let i=0;i<cuts.length-1;i++){
  const r=boundedRect({left:0,top:cuts[i],right:w,bottom:cuts[i+1]},w,h);
  if(r.width>24&&r.height>30)result.push({rect:r,psm:'6',name:`bloco ${i+1}`});
 }
 return result;
}
function figureRegions(canvas,figure){
 const w=canvas.width,h=canvas.height;
 const top=figure.top,bottom=figure.bottom,left=figure.left,right=figure.right;
 const gap=Math.max(5,Math.round(w*.012));
 // Mantém as regiões sem sobreposição: linha(s) acima da foto, legenda, texto
 // ao lado (até ligeiramente abaixo da foto), e parágrafos seguintes.
 const captionStart=Math.max(0,Math.floor(top-h*.038));
 const bottomCut=Math.min(h,Math.ceil(bottom+h*.009));
 const rightX=Math.min(w,Math.ceil(right+gap));
 const regions=[
  {rect:boundedRect({left:0,top:0,right:w,bottom:captionStart},w,h),psm:'3',name:'texto superior'},
  {rect:boundedRect({left:0,top:captionStart,right:Math.min(w,right+2*gap),bottom:top},w,h),psm:'6',name:'legenda'},
  {rect:boundedRect({left:rightX,top:top,right:w,bottom:bottomCut},w,h),psm:'6',name:'texto ao lado da figura'},
  {rect:boundedRect({left:0,top:bottomCut,right:w,bottom:h},w,h),psm:'3',name:'texto inferior'},
 ];
 return regions.filter(r=>r.rect.width>60&&r.rect.height>24);
}
function qualityOfOCR(text){
 const txt=(text||'').trim();
 if(!txt)return 0;
 const letters=(txt.match(/[a-záéíóúüñç]/gi)||[]).length;
 const symbols=(txt.match(/[|_~<>\\^{}\[\]©]/g)||[]).length;
 const tokens=txt.split(/\s+/).filter(Boolean);
 const bad=tokens.filter(s=> /[a-záéíóúñ]{1,2}[|_\\][a-záéíóúñ]/i.test(s)|| /^[^a-záéíóúüñç\d]{2,}$/.test(s)).length;
 return (letters/Math.max(1,txt.length))*100 - (symbols/Math.max(1,txt.length))*80 -bad*4;
}
async function ocrRect(canvas,r,psm){
 await ocrWorker.setParameters({tessedit_pageseg_mode:psm,preserve_interword_spaces:'0'});
 const res=await ocrWorker.recognize(canvas,{rectangle:r});
 return (res?.data?.text||'').trim();
}
async function reviewPageOCR(page,n,tok,epoch,opts={}){
 if(!globalThis.Tesseract?.createWorker)throw new Error('Tesseract não carregou. Verifique a conexão.');
 if(!ocrWorker){setStatus('Inicializando OCR em espanhol…');ocrWorker=await Tesseract.createWorker(SOURCE,1);}
 const mode=opts.mode||'auto';
 const viewport=ocrViewport(page,mode),canvas=document.createElement('canvas');
 canvas.width=Math.round(viewport.width);canvas.height=Math.round(viewport.height);
 try{
  await page.render({canvasContext:canvas.getContext('2d',{alpha:false,willReadFrequently:true}),viewport}).promise;
  if(tok!==session||epoch!==viewEpoch)return null;
  const cached=manualFigures.get(n);
  const figure=cached?absoluteRect(cached,canvas.width,canvas.height):locateColorFigure(canvas);
  // Se a foto foi marcada, respeita sempre o retângulo escolhido pelo leitor.
  const sections=(figure?figureRegions(canvas,figure): mode==='regions'?splitHorizontalBands(canvas):[{rect:boundedRect({left:0,top:0,right:canvas.width,bottom:canvas.height},canvas.width,canvas.height),psm:'3',name:'página'}]);
  const outputs=[];let recognized=0,discarded=0;
  for(let i=0;i<sections.length;i++){
   if(tok!==session||epoch!==viewEpoch)return null;
   const section=sections[i];
   setStatus(`Página ${n}: OCR ${i+1}/${sections.length} (${section.name})…`);
   let value=await ocrRect(canvas,section.rect,section.psm);
   // Para trechos curtos, uma segunda leitura em modo de bloco é mais estável
   // do que aceitar linhas compostas por símbolos e ruído da fotografia.
   if(value&&qualityOfOCR(value)<30&&section.psm!=='6'){
    const retry=await ocrRect(canvas,section.rect,'6');
    if(qualityOfOCR(retry)>qualityOfOCR(value))value=retry;
   }
   if(!value)continue;
   if(qualityOfOCR(value)<15){discarded++;continue;}
   recognized++;
   outputs.push(...parseOCR(value));
  }
  if(!outputs.length)throw new Error('Não foi possível recuperar texto confiável. Tente marcar a figura manualmente.');
  return {texts:outputs,mode:cached?'OCR revisado · figura marcada':figure?'OCR revisado · figura separada':mode==='regions'?'OCR revisado · blocos':mode==='precision'?'OCR revisado · alta precisão':'OCR revisado',discarded,recognized};
 }finally{canvas.width=canvas.height=0;}
}
async function rerunCurrentPage(){
 if(!pdf||opening||loading||reviewing)return;
 reviewing=true;navigation();
 const n=current,old=pageBlocks.get(n);if(!old){reviewing=false;return;}
 const tok=session,epoch=viewEpoch,mode=ocrMode.value;
 btnReview.disabled=true;figureButton.disabled=true;
 let page;
 try{
  page=await pdf.getPage(n);
  const reviewed=await reviewPageOCR(page,n,tok,epoch,{mode});
  if(!reviewed||tok!==session||epoch!==viewEpoch||pageBlocks.get(n)!==old)return;
  if(!reviewed.texts.length)throw new Error('OCR não conseguiu recuperar texto desta página.');
  const leftPos=(original.scrollTop-old.left.offsetTop)/Math.max(1,old.left.offsetHeight);
  const rightPos=(translated.scrollTop-old.right.offsetTop)/Math.max(1,old.right.offsetHeight);
  const block=pageNodes(n,reviewed.texts,reviewed.mode);
  old.left.replaceWith(block.left);old.right.replaceWith(block.right);
  pageBlocks.set(n,block);
  translationQueue=translationQueue.filter(t=>t.block!==old);
  translationQueue.push({block,epoch,tok,revision:block.translationRevision,precise:false});
  if(leftPos>=0&&leftPos<=1)setScrollWithoutFeedback(original,block.left.offsetTop+leftPos*block.left.offsetHeight);
  if(rightPos>=0&&rightPos<=1)setScrollWithoutFeedback(translated,block.right.offsetTop+rightPos*block.right.offsetHeight);
  setStatus(`Página ${n}: ${reviewed.mode}. ${reviewed.discarded?'Trechos ilegíveis descartados. ':''}Preparando tradução…`);
  void drainTranslationQueue();
 }catch(e){
  if(tok===session&&epoch===viewEpoch)setStatus('Não foi possível revisar: '+(e?.message||String(e)));
 }finally{try{page?.cleanup()}catch{}reviewing=false;if(tok===session&&epoch===viewEpoch)navigation();}
}
btnReview.addEventListener('click',()=>void rerunCurrentPage());
// Interface de marcação manual para fotos preto-e-branco, diagramas ou quando
// a detecção de cor confundiu a figura com texto. A seleção fica só na sessão.
function paintFigureSelection(){
 const c=figureCanvas,ctx=c.getContext('2d');
 if(!figureDrawing)return;
 ctx.clearRect(0,0,c.width,c.height);
 ctx.drawImage(figureDrawing,0,0,c.width,c.height);
 if(figureSelection){
  const r=absoluteRect(figureSelection,c.width,c.height);
  ctx.fillStyle='rgba(18,98,157,.15)';ctx.strokeStyle='#0874b5';ctx.lineWidth=Math.max(2,c.width/280);
  ctx.fillRect(r.left,r.top,r.right-r.left,r.bottom-r.top);
  ctx.strokeRect(r.left,r.top,r.right-r.left,r.bottom-r.top);
 }
}
function relativePointer(evt){
 const b=figureCanvas.getBoundingClientRect();
 return {x:Math.max(0,Math.min(1,(evt.clientX-b.left)/b.width)),y:Math.max(0,Math.min(1,(evt.clientY-b.top)/b.height))};
}
function rectFromPoints(a,b){return {left:Math.min(a.x,b.x),top:Math.min(a.y,b.y),right:Math.max(a.x,b.x),bottom:Math.max(a.y,b.y)};}
figureCanvas.addEventListener('pointerdown',evt=>{
 if(!figureDrawing)return;
 evt.preventDefault();figureCanvas.setPointerCapture(evt.pointerId);
 figureStart=relativePointer(evt);figureSelection=null;figureDragging=true;
});
figureCanvas.addEventListener('pointermove',evt=>{
 if(!figureDragging||!figureStart)return;
 evt.preventDefault();figureSelection=rectFromPoints(figureStart,relativePointer(evt));paintFigureSelection();
});
function finishSelection(evt){
 if(!figureDragging)return;
 figureDragging=false;figureSelection=rectFromPoints(figureStart,relativePointer(evt));
 if((figureSelection.right-figureSelection.left)<.035||(figureSelection.bottom-figureSelection.top)<.025){figureSelection=null;figureHint.textContent='Selecione uma área maior que a imagem.';}
 else figureHint.textContent='Área marcada. Toque em Aplicar revisão para ignorar a figura.';
 paintFigureSelection();
}
figureCanvas.addEventListener('pointerup',finishSelection);
figureCanvas.addEventListener('pointercancel',()=>{figureDragging=false;});
function closeFigureDialog(){
 figureDialog.hidden=true;figureDrawing=null;figureSelection=null;figureStart=null;manualPage=0;
}
$('cancelFigure').addEventListener('click',closeFigureDialog);
$('applyFigure').addEventListener('click',()=>{
 if(!figureSelection||!manualPage)return;
 manualFigures.set(manualPage,figureSelection);
 closeFigureDialog();void rerunCurrentPage();
});
figureButton.addEventListener('click',async()=>{
 if(!pdf||opening||loading||current<1)return;
 const n=current,tok=session,epoch=viewEpoch;
 figureButton.disabled=true;let page;
 try{
  page=await pdf.getPage(n);
  const vp=page.getViewport({scale:1});
  const scale=Math.min(1.5,Math.sqrt(950000/(vp.width*vp.height)));
  const view=page.getViewport({scale});
  const c=document.createElement('canvas');c.width=Math.round(view.width);c.height=Math.round(view.height);
  await page.render({canvasContext:c.getContext('2d',{alpha:false}),viewport:view}).promise;
  if(tok!==session||epoch!==viewEpoch)return;
  figureDrawing=c;manualPage=n;figureSelection=manualFigures.get(n)||null;
  figureCanvas.width=c.width;figureCanvas.height=c.height;
  figureHint.textContent=`Página ${n}: arraste o dedo ou mouse ao redor da figura para ignorá-la no OCR.`;
  figureDialog.hidden=false;paintFigureSelection();
 }catch(e){setStatus('Não foi possível abrir a imagem da página: '+(e?.message||String(e)));}
 finally{try{page?.cleanup()}catch{}navigation();}
});

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
 return {left,right,outputs,texts,n,translationRevision:0};
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
 if(!pdf||opening||loading||reviewing||n<1||n>totalPages||pageBlocks.has(n))return false;
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
  navigation();
  if(texts.length)translationQueue.push({block,epoch,tok,revision:block.translationRevision,precise:false});
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
   navigation();
   updateCurrentPage();
   scheduleEdgeCheck();
  }
 }
}
// Permite refazer a tradução sem processar novamente o OCR.
// O botão atua só na página atual, evitando reprocessar um PDF grande.
btnRetranslate.addEventListener('click',()=>{
 if(!pdf||opening||loading||reviewing||current<1)return;
 const block=pageBlocks.get(current);if(!block||!block.texts.length)return;
 block.translationRevision++;
 for(const p of block.outputs)setTranslatedText(p,'Retraduzindo com trechos menores…','segment pending');
 translationQueue=translationQueue.filter(t=>t.block!==block);
 translationQueue.unshift({block,tok:session,epoch:viewEpoch,revision:block.translationRevision,precise:true});
 setStatus(`Página ${current}: conferindo tradução por partes menores…`);
 void drainTranslationQueue();
});
async function translateSegment(engine,text,precise){
 const pieces=precise?precisionParts(text):[text],result=[];
 for(const piece of pieces){
  const key=(precise?'es-pt-precise:':'es-pt:')+piece;
  let value=translationCache.get(key);
  if(value===undefined){
   value=await engine.translate(piece);
   if(typeof value!=='string'||!value.trim())throw new Error('Tradutor retornou trecho vazio.');
   translationCache.set(key,value);
   if(translationCache.size>250)translationCache.delete(translationCache.keys().next().value);
  }
  result.push(value.trim());
 }
 return result.join(' ').replace(/\s+([,;:.!?])/g,'$1').trim();
}
async function drainTranslationQueue(){
 if(translating)return;
 translating=true;
 try{
  while(translationQueue.length){
   const task=translationQueue.shift();
   if(task.tok!==session||task.epoch!==viewEpoch||pageBlocks.get(task.block.n)!==task.block)continue;
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
    if(task.tok!==session||task.epoch!==viewEpoch||pageBlocks.get(task.block.n)!==task.block||task.revision!==task.block.translationRevision)break;
    const p=task.block.outputs[i],text=task.block.texts[i];
    try{
     setTranslatedText(p,'Traduzindo localmente…');
     const result=await translateSegment(engine,text,!!task.precise);
     if(task.tok!==session||task.epoch!==viewEpoch||pageBlocks.get(task.block.n)!==task.block||task.revision!==task.block.translationRevision)break;
     setTranslatedText(p,result,'segment');
     setStatus(`Página ${task.block.n}/${totalPages}: ${i+1}/${task.block.texts.length} trechos traduzidos${task.precise?' · revisão detalhada':''} · sem MyMemory`);
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
 manualFigures.clear();closeFigureDialog();
 opening=true;loading=false;reviewing=false;
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
 if(!pdf||opening||reviewing||!Number.isInteger(n)||n<1||n>totalPages)return;
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
// Alterna apenas o layout, sem recarregar PDF, OCR ou tradução.
// A página e o progresso visível no painel ativo são guardados antes do reflow.
function viewportReadingAnchor(p){
 if(!pageBlocks.size)return null;
 const inset=Math.min(80,Math.max(18,p.clientHeight*.15));
 const point=p.scrollTop+inset;
 const nums=sortedPages();let chosen=nums[0];
 for(const n of nums){
  const b=pageBlocks.get(n),node=p===original?b.left:b.right;
  if(node.offsetTop<=point)chosen=n;else break;
 }
 const b=pageBlocks.get(chosen),node=p===original?b.left:b.right;
 return {page:chosen,fraction:Math.max(0,Math.min(1,(point-node.offsetTop)/Math.max(1,node.offsetHeight))),inset};
}
function switchViewMode(mode){
 const source=activePane,anchor=viewportReadingAnchor(source);
 $('panes').classList.toggle('mode-stacked',mode==='stacked');
 if(anchor){
  const block=pageBlocks.get(anchor.page);
  const node=source===original?block.left:block.right;
  const desired=node.offsetTop+node.offsetHeight*anchor.fraction-anchor.inset;
  setScrollWithoutFeedback(source,desired);
  alignPanes(source,source===original?translated:original);
  updateCurrentPage();
 }
 try{localStorage.setItem('leitor-bilingue-v36-view-mode',mode)}catch{}
}
const modeSelect=$('viewMode');
try{
 const saved=localStorage.getItem('leitor-bilingue-v36-view-mode');
 if(saved==='stacked')modeSelect.value='stacked';
}catch{}
$('panes').classList.toggle('mode-stacked',modeSelect.value==='stacked');
modeSelect.addEventListener('change',()=>switchViewMode(modeSelect.value));
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
 if(!pdf||opening||loading||reviewing||!pageBlocks.size)return;
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
