'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const original = $('original'), translation = $('translation');
  const status = $('status'), consent = $('consent'), source = $('source'), target = $('target');
  const input = $('pdfFile'), sample = $('sample'), nextButton = $('nextPage');
  const pageInput = $('pageInput'), jumpButton = $('jumpPage'), pageTotal = $('pageTotal');
  const encoder = new TextEncoder();
  const MAX_BYTES = 440;
  const KEEP_PAGES = 7;
  const OCR_LANG = { es:'spa', en:'eng', fr:'fra', de:'deu', it:'ita', pt:'por', ja:'jpn', 'zh-CN':'chi_sim', ru:'rus', ar:'ara' };

  let doc = null, filename = '', nextPageNumber = 1, totalPages = 0;
  let blocks = [], pages = [], queued = [], running = false, loadingPage = false;
  let generation = 0, activeLoad = 0, observer = null, translated = 0;
  let ignoredScroll = false, lastStatus = '';
  let ocrWorker = null, ocrWorkerLang = '', ocrWorkerPromise = null;
  const memoryCache = new Map();

  function setStatus(msg) { lastStatus = msg; status.textContent = msg; }
  function make(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function yieldToUI() { return new Promise(r => setTimeout(r, 0)); }
  function chunks(str, maxBytes = MAX_BYTES) {
    const out=[]; let cur='';
    for (const word of (str || '').trim().split(/\s+/u)) {
      if (!word) continue;
      if (encoder.encode(cur ? cur+' '+word : word).length <= maxBytes) { cur=cur?cur+' '+word:word; continue; }
      if(cur) {out.push(cur);cur='';}
      let part='';
      for(const c of word) {
        if(encoder.encode(part+c).length>maxBytes) {if(part)out.push(part);part='';}
        part+=c;
      }
      cur=part;
    }
    if(cur)out.push(cur);
    return out;
  }
  function textFromPage(items) {
    const lines=[];
    for(const item of items) {
      const str=(item.str||'').trim();if(!str)continue;
      const y=item.transform?.[5]??0,x=item.transform?.[4]??0;
      const height=Math.max(6,Math.abs(item.height||item.transform?.[3]||11));
      let line=lines.find(l=>Math.abs(l.y-y)<=2.2);
      if(!line) {line={y,height,spans:[]};lines.push(line);}
      line.spans.push({x,str});
    }
    lines.sort((a,b)=>b.y-a.y);
    const ordered=lines.map(l=>({y:l.y,height:l.height,text:l.spans.sort((a,b)=>a.x-b.x).map(s=>s.str).join(' ').replace(/\s+/g,' ').trim()})).filter(l=>l.text);
    if(!ordered.length)return [];
    const paragraphs=[];let para=ordered[0].text;
    for(let i=1;i<ordered.length;i++) {
      const a=ordered[i-1],b=ordered[i];
      if(Math.abs(a.y-b.y)>Math.max(15,a.height*1.55)) {paragraphs.push(para);para=b.text;}
      else if(para.endsWith('-'))para=para.slice(0,-1)+b.text;
      else para+=' '+b.text;
    }
    paragraphs.push(para);
    return paragraphs.flatMap(p=>chunks(p));
  }
  function textFromOCR(text) {
    // Basic grouping of OCR lines and blank-line-separated paragraphs.
    return (text||'').replace(/\r/g,'').split(/\n\s*\n/g).flatMap(p=>chunks(p));
  }
  function initObserver() {
    observer?.disconnect();
    observer = new IntersectionObserver(entries=>{
      if(!consent.checked)return;
      for(const e of entries)if(e.isIntersecting)enqueue(+e.target.dataset.index);
    },{root:original,rootMargin:'260px 0px 260px 0px',threshold:0});
  }
  function clearReading() {
    generation++;
    queued=[]; blocks=[]; pages=[];translated=0;
    initObserver();
    original.replaceChildren();translation.replaceChildren();
    original.scrollTop=0;translation.scrollTop=0;
  }
  function setNavigation() {
    nextButton.disabled=!doc || loadingPage || nextPageNumber>totalPages;
    jumpButton.disabled=!doc || loadingPage;
    pageInput.disabled=!doc || loadingPage;
    pageInput.max=String(totalPages||1);
    pageTotal.textContent=doc?`de ${totalPages}`:'de 0';
  }
  async function cleanupDoc() {
    const old=doc;doc=null;
    if(old)try{await old.destroy();}catch{}
  }
  async function openBytes(bytes,name) {
    activeLoad++;
    const load=activeLoad;
    clearReading();await cleanupDoc();
    filename=name;nextPageNumber=1;totalPages=0;loadingPage=false;
    setNavigation();
    if(!globalThis.pdfjsLib) {setStatus('Leitor PDF não carregou. Confira a conexão.');return;}
    try {
      setStatus('Abrindo PDF…');
      pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const opened=await pdfjsLib.getDocument({data:bytes}).promise;
      if(load!==activeLoad) {await opened.destroy();return;}
      doc=opened;totalPages=opened.numPages;
      pageInput.value='1';setNavigation();
      setStatus(`${name}: ${totalPages} páginas. Leitura e OCR sob demanda.`);
      await loadNextPage();
    } catch(err) {setStatus('Erro ao abrir o PDF: '+(err?.message||'arquivo inválido'));console.error(err);}
  }
  async function getOcrWorker(lang, currentLoad) {
    if(!globalThis.Tesseract?.createWorker)throw new Error('Biblioteca OCR indisponível. Verifique a internet.');
    if(ocrWorker&&ocrWorkerLang===lang)return ocrWorker;
    if(ocrWorkerPromise&&ocrWorkerLang===lang)return ocrWorkerPromise;
    if(ocrWorkerPromise) {try{await ocrWorkerPromise;}catch{}}
    if(ocrWorker) {try{await ocrWorker.terminate();}catch{}ocrWorker=null;}
    ocrWorkerLang=lang;
    setStatus('Baixando modelo de reconhecimento '+lang+' (primeira vez pode demorar)…');
    ocrWorkerPromise=Tesseract.createWorker(lang,1,{
      logger:m=>{
        if(currentLoad!==activeLoad)return;
        if(m.status==='recognizing text')setStatus(`Reconhecendo imagem: ${Math.round((m.progress||0)*100)}% · página ${nextPageNumber-1}/${totalPages}`);
      }
    });
    try {ocrWorker=await ocrWorkerPromise;return ocrWorker;}
    catch(e){ocrWorkerLang='';throw e;}
    finally{ocrWorkerPromise=null;}
  }
  async function ocrPage(page,p,currentLoad) {
    const lang=OCR_LANG[source.value]||'spa';
    const base=page.getViewport({scale:1});
    // Keep the canvas below 2.8 megapixels to reduce iPhone memory consumption.
    const scale=Math.min(2.2,Math.sqrt(2800000/(base.width*base.height)));
    const viewport=page.getViewport({scale});
    const canvas=document.createElement('canvas');
    canvas.width=Math.round(viewport.width);canvas.height=Math.round(viewport.height);
    const ctx=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
    if(!ctx)throw new Error('O aparelho não conseguiu criar a imagem para OCR.');
    try {
      setStatus(`Página ${p}/${totalPages}: preparando imagem para OCR…`);
      await page.render({canvasContext:ctx,viewport}).promise;
      if(currentLoad!==activeLoad)return [];
      const worker=await getOcrWorker(lang,currentLoad);
      if(currentLoad!==activeLoad)return [];
      setStatus(`Página ${p}/${totalPages}: reconhecendo texto da imagem…`);
      const ret=await worker.recognize(canvas);
      return textFromOCR(ret?.data?.text);
    } finally {canvas.width=0;canvas.height=0;}
  }
  function addPage(p,texts,mode,error) {
    const group={number:p,left:[],right:[],indexes:[]};
    const leftMark=make('div','page-mark',`PÁGINA ${p}${mode==='ocr'?' · OCR':''}`);
    const rightMark=make('div','page-mark',`PÁGINA ${p}`);
    original.append(leftMark);translation.append(rightMark);
    group.left.push(leftMark);group.right.push(rightMark);
    if(!texts.length) {
      const msg=error?'Erro no reconhecimento: '+error:'Nenhum texto encontrado nesta página. Use Próxima página para continuar.';
      const a=make('p','empty',msg),b=make('p','empty','Sem texto para traduzir nesta página.');
      original.append(a);translation.append(b);
      group.left.push(a);group.right.push(b);
    }
    for(const t of texts) {
      const id=blocks.length;
      const left=make('p','segment',t),right=make('p','segment pending','Aguardando tradução…');
      left.dataset.index=String(id);right.dataset.index=String(id);
      original.append(left);translation.append(right);
      group.left.push(left);group.right.push(right);group.indexes.push(id);
      blocks.push({text:t,left,right,state:'idle'});
      observer.observe(left);
    }
    pages.push(group);
    // Drop old DOM pages to keep very long PDFs usable on phones.
    while(pages.length>KEEP_PAGES) {
      const old=pages.shift();
      const beforeL=original.scrollHeight,beforeR=translation.scrollHeight;
      old.indexes.forEach(i=>{const b=blocks[i];if(b){observer.unobserve(b.left);b.state='discarded';blocks[i]=null;}});
      old.left.forEach(n=>n.remove());old.right.forEach(n=>n.remove());
      original.scrollTop=Math.max(0,original.scrollTop-(beforeL-original.scrollHeight));
      translation.scrollTop=Math.max(0,translation.scrollTop-(beforeR-translation.scrollHeight));
    }
  }
  async function loadNextPage() {
    if(!doc||loadingPage||nextPageNumber>totalPages)return;
    const pdf=doc, token=activeLoad, n=nextPageNumber++;
    loadingPage=true;setNavigation();
    let page=null, mode='texto', texts=[],error='';
    try {
      setStatus(`${filename}: lendo página ${n} de ${totalPages}…`);
      page=await pdf.getPage(n);
      const content=await page.getTextContent();
      if(token!==activeLoad)return;
      texts=textFromPage(content.items);
      if(!texts.length){mode='ocr';texts=await ocrPage(page,n,token);}
      if(token!==activeLoad)return;
    } catch(err) {error=err?.message||String(err);console.error('Falha ao carregar página',n,err);}
    finally {page?.cleanup();loadingPage=false;setNavigation();}
    if(token!==activeLoad)return;
    addPage(n,texts,mode,error);
    pageInput.value=String(n);
    setStatus(error?`Página ${n}/${totalPages}: ${error}`:`Página ${n}/${totalPages} · ${texts.length} trecho(s) · ${mode==='ocr'?'texto reconhecido por OCR':'texto extraído'}. Role para traduzir ou avançar.`);
    if(consent.checked)translateVisible();
  }
  async function jumpToPage() {
    if(!doc||loadingPage)return;
    const n=Number(pageInput.value);
    if(!Number.isInteger(n)||n<1||n>totalPages){setStatus(`Informe uma página entre 1 e ${totalPages}.`);return;}
    clearReading();nextPageNumber=n;setNavigation();await loadNextPage();
  }
  function hash(s){let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return(h>>>0).toString(36)+'-'+s.length;}
  async function getTranslation(text,src,dst) {
    if(src===dst)return text;
    const key=`${src}|${dst}|${text}`;
    if(memoryCache.has(key))return memoryCache.get(key);
    try{const cached=localStorage.getItem('lb:'+hash(key));if(cached){memoryCache.set(key,cached);return cached;}}catch{}
    const qs=new URLSearchParams({q:text,langpair:`${src}|${dst}`});
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),16000);
    try{
      const response=await fetch('https://api.mymemory.translated.net/get?'+qs,{signal:controller.signal});
      if(!response.ok)throw new Error('serviço indisponível ('+response.status+')');
      const payload=await response.json();
      if(+payload.responseStatus!==200||!payload.responseData?.translatedText||payload.quotaFinished)
        throw new Error(payload.responseDetails||'limite diário atingido ou idioma não atendido');
      const decoded=document.createElement('textarea');decoded.innerHTML=payload.responseData.translatedText;
      const translatedText=decoded.value;
      memoryCache.set(key,translatedText);
      try{if(text.length<400)localStorage.setItem('lb:'+hash(key),translatedText);}catch{}
      return translatedText;
    } finally{clearTimeout(timer);}
  }
  function enqueue(id) {
    const b=blocks[id];
    if(!b||b.state!=='idle'||!consent.checked)return;
    b.state='queued';queued.push({id,generation});drain();
  }
  async function drain() {
    if(running)return;
    running=true;
    try{
      while(queued.length&&consent.checked) {
        const job=queued.shift();if(job.generation!==generation)continue;
        const b=blocks[job.id];if(!b||b.state!=='queued')continue;
        b.state='working';b.right.textContent='Traduzindo…';
        const src=source.value,dst=target.value;
        try{
          const result=await getTranslation(b.text,src,dst);
          if(job.generation!==generation||src!==source.value||dst!==target.value||!b.right.isConnected)continue;
          b.right.textContent=result;b.right.classList.remove('pending','failed');b.state='done';translated++;
        }catch(err){
          if(job.generation!==generation||!b.right.isConnected)continue;
          b.right.textContent='Tradução indisponível: '+(err?.message||'erro de conexão');
          b.right.classList.remove('pending');b.right.classList.add('failed');b.state='failed';
          setStatus('Alguns trechos não foram traduzidos. Verifique a internet ou limite gratuito.');
        }
        await new Promise(r=>setTimeout(r,90));
      }
    } finally {running=false;if(queued.length&&consent.checked)setTimeout(drain,0);}
  }
  function translateVisible() {
    if(!consent.checked)return;
    const top=original.scrollTop-400,bottom=original.scrollTop+original.clientHeight+400;
    for(const b of blocks)if(b&&b.left.isConnected&&b.left.offsetTop+b.left.offsetHeight>=top&&b.left.offsetTop<=bottom)enqueue(+b.left.dataset.index);
  }
  function onLanguageChange() {
    generation++;queued=[];translated=0;
    for(const b of blocks)if(b){b.state='idle';b.right.textContent='Aguardando tradução…';b.right.classList.remove('failed');b.right.classList.add('pending');}
    if(consent.checked)translateVisible();
    setStatus('Idioma atualizado. O OCR das próximas páginas usará o idioma de origem escolhido.');
  }
  function onScroll(from,to) {
    let scrollTimer;
    from.addEventListener('scroll',()=>{
      if(ignoredScroll)return;
      const list=from.querySelectorAll('p.segment');
      if(list.length) {
        const pos=from.scrollTop,children=Array.from(list);
        let chosen=children[0];for(const n of children){if(n.offsetTop<=pos+30)chosen=n;else break;}
        const other=to.querySelector(`p.segment[data-index="${chosen.dataset.index}"]`);
        if(other){
          const ratio=Math.max(0,Math.min(1,(pos-chosen.offsetTop)/Math.max(1,chosen.offsetHeight)));
          ignoredScroll=true;to.scrollTop=other.offsetTop+ratio*other.offsetHeight;
          setTimeout(()=>{ignoredScroll=false;},60);
        }
      }
      translateVisible();
      // Only load the next PDF page after a real scroll, not automatically at startup.
      clearTimeout(scrollTimer);
      scrollTimer=setTimeout(()=>{
        if(from.scrollTop>25 && from.scrollTop+from.clientHeight>=from.scrollHeight-100 && !loadingPage)loadNextPage();
      },130);
    },{passive:true});
  }
  input.addEventListener('change',async()=>{
    const file=input.files?.[0];if(!file)return;
    if(!/\.pdf$/i.test(file.name)&&file.type!=='application/pdf'){setStatus('Selecione um arquivo PDF.');return;}
    await openBytes(await file.arrayBuffer(),file.name);
  });
  sample.addEventListener('click',async()=>{
    try {const response=await fetch('./exemplo.pdf');if(!response.ok)throw new Error('HTTP '+response.status);
      await openBytes(await response.arrayBuffer(),'exemplo.pdf');}
    catch(err){setStatus('Não foi possível abrir o PDF de exemplo: '+err.message);}
  });
  nextButton.addEventListener('click',loadNextPage);
  jumpButton.addEventListener('click',jumpToPage);
  pageInput.addEventListener('keydown',event=>{if(event.key==='Enter')jumpToPage();});
  source.addEventListener('change',onLanguageChange);
  target.addEventListener('change',onLanguageChange);
  consent.addEventListener('change',()=>{
    if(consent.checked){translateVisible();setStatus('Tradução ativada; os trechos visíveis serão enviados ao MyMemory.');}
    else{queued=[];setStatus('Tradução pausada. O reconhecimento OCR continua local no aparelho.');}
  });
  onScroll(original,translation);onScroll(translation,original);
  initObserver();setNavigation();
  if('serviceWorker' in navigator&&location.protocol.startsWith('http'))
    window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
})();
