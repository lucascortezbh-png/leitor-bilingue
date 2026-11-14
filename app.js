'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const original = $('original'), translation = $('translation');
  const status = $('status'), consent = $('consent'), source = $('source'), target = $('target');
  const input = $('pdfFile'), sample = $('sample');
  const encoder = new TextEncoder();
  let blocks = [], queued = [], running = false, generation = 0, loadToken = 0, loading = false;
  let observer = null, countDone = 0, ignoredScroll = false;
  const memoryCache = new Map();
  const MAX_BYTES = 440; // MyMemory accepts at most 500 UTF-8 bytes in q.

  function setStatus(message) { status.textContent = message; }
  function make(tag, className, value) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (value !== undefined) el.textContent = value;
    return el;
  }
  function chunks(text, maxBytes = MAX_BYTES) {
    const result = [];
    let current = '';
    // Splits on spaces, guaranteeing each request respects the UTF-8 byte limit.
    for (const word of text.trim().split(/\s+/u)) {
      if (!word) continue;
      const proposed = current ? current + ' ' + word : word;
      if (encoder.encode(proposed).length <= maxBytes) { current = proposed; continue; }
      if (current) { result.push(current); current = ''; }
      if (encoder.encode(word).length <= maxBytes) { current = word; continue; }
      // Rare word without spaces: split safely by Unicode code points.
      let part = '';
      for (const char of word) {
        if (encoder.encode(part + char).length > maxBytes) { if (part) result.push(part); part = ''; }
        part += char;
      }
      current = part;
    }
    if (current) result.push(current);
    return result;
  }
  function textFromPage(items) {
    // PDF text extraction is heuristic: works best on selectable-text, single-column PDFs.
    const lines = [];
    for (const it of items) {
      const str = (it.str || '').trim();
      if (!str) continue;
      const y = it.transform?.[5] ?? 0, x = it.transform?.[4] ?? 0;
      const height = Math.max(6, Math.abs(it.height || it.transform?.[3] || 11));
      let line = lines.find(l => Math.abs(l.y - y) <= 2.2);
      if (!line) { line = { y, height, spans: [] }; lines.push(line); }
      line.spans.push({x, str});
    }
    lines.sort((a,b) => b.y-a.y);
    const cleaned = lines.map(l => ({
      y:l.y, height:l.height,
      text:l.spans.sort((a,b)=>a.x-b.x).map(s=>s.str).join(' ').replace(/\s+/g,' ').trim()
    })).filter(l=>l.text);
    if (!cleaned.length) return [];
    const paragraphs = [];
    let paragraph = cleaned[0].text;
    for (let i = 1; i < cleaned.length; i++) {
      const previous = cleaned[i-1], line = cleaned[i];
      const gap = Math.abs(previous.y-line.y);
      const newPara = gap > Math.max(15, previous.height*1.55);
      if (newPara) { paragraphs.push(paragraph); paragraph = line.text; }
      else if (paragraph.endsWith('-')) paragraph = paragraph.slice(0,-1) + line.text;
      else paragraph += ' ' + line.text;
    }
    paragraphs.push(paragraph);
    return paragraphs.flatMap(p=>chunks(p, MAX_BYTES));
  }
  function reset() {
    generation += 1; loadToken += 1;
    blocks = []; queued = []; running = false; countDone = 0;
    observer?.disconnect();
    original.replaceChildren(); translation.replaceChildren();
    observer = new IntersectionObserver(entries => {
      if (!consent.checked) return;
      for (const entry of entries) {
        if (entry.isIntersecting) enqueue(Number(entry.target.dataset.index));
      }
    }, {root:original, rootMargin:'450px 0px 450px 0px', threshold:0});
  }
  function insertPage(pageNumber, texts) {
    if (!texts.length) return;
    original.append(make('div','page-mark',`PÁGINA ${pageNumber}`));
    translation.append(make('div','page-mark',`PÁGINA ${pageNumber}`));
    for (const text of texts) {
      const index = blocks.length;
      const left = make('p','segment',text);
      left.dataset.index = index;
      const right = make('p','segment pending','Aguardando tradução…');
      right.dataset.index = index;
      original.append(left); translation.append(right);
      blocks.push({text, left, right, state:'idle'});
      observer.observe(left);
    }
  }
  async function readPDF(arrayBuffer, name) {
    if (!globalThis.pdfjsLib) {
      setStatus('Não foi possível carregar o leitor de PDF. Verifique a conexão à internet.'); return;
    }
    const myLoad = loadToken;
    try {
      loading = true;
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const doc = await pdfjsLib.getDocument({data:arrayBuffer}).promise;
      if (loadToken !== myLoad) return;
      setStatus(`Lendo ${name} (${doc.numPages} página(s))…`);
      for (let p=1; p<=doc.numPages; p++) {
        if (loadToken !== myLoad) return;
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        if (loadToken !== myLoad) return;
        insertPage(p, textFromPage(content.items));
        page.cleanup();
        setStatus(`PDF: ${name} · página ${p}/${doc.numPages} · ${blocks.length} trecho(s) · ${countDone} traduzido(s)`);
        // Yield to the browser: users can start reading while subsequent pages load.
        await new Promise(resolve=>setTimeout(resolve,0));
      }
      if (!blocks.length) {
        original.append(make('p','empty','Este PDF não possui texto extraível. PDFs digitalizados precisam de OCR, ainda não disponível neste protótipo.'));
        translation.append(make('p','empty','Sem texto para traduzir.'));
      } else if (!consent.checked) {
        setStatus(`PDF carregado: ${blocks.length} trecho(s). Marque a autorização para iniciar a tradução.`);
      }
    } catch(err) {
      console.error(err);
      setStatus(`Erro ao abrir PDF: ${err?.message || 'arquivo inválido ou protegido'}`);
      if (!blocks.length) original.append(make('p','empty','Não foi possível extrair o texto deste arquivo.'));
    } finally { if (myLoad === loadToken) loading = false; }
  }
  function enqueue(index) {
    const block = blocks[index];
    if (!block || block.state !== 'idle' || !consent.checked) return;
    block.state = 'queued'; queued.push({index, generation});
    drain();
  }
  async function getTranslation(text, src, dst) {
    if (src === dst) return text;
    const key = `${src}|${dst}|${text}`;
    if (memoryCache.has(key)) return memoryCache.get(key);
    // Cache only short passages on this device; avoid storing document files remotely.
    try {
      const cached = localStorage.getItem('lb:' + hash(key));
      if (cached) { memoryCache.set(key,cached); return cached; }
    } catch {}
    const params = new URLSearchParams({q:text, langpair:`${src}|${dst}`});
    const controller = new AbortController();
    const timer = setTimeout(()=>controller.abort(),16000);
    try {
      const response = await fetch(`https://api.mymemory.translated.net/get?${params}`, {signal:controller.signal});
      if (!response.ok) throw new Error(`servidor de tradução indisponível (${response.status})`);
      const payload = await response.json();
      if (Number(payload.responseStatus) !== 200 || !payload.responseData?.translatedText || payload.quotaFinished) {
        throw new Error(payload.responseDetails || 'limite diário alcançado ou idioma não atendido');
      }
      const decoded = document.createElement('textarea');
      decoded.innerHTML = payload.responseData.translatedText;
      const value = decoded.value;
      memoryCache.set(key,value);
      try { if (text.length < 400) localStorage.setItem('lb:' + hash(key),value); } catch {}
      return value;
    } finally { clearTimeout(timer); }
  }
  function hash(str) {
    let h = 2166136261;
    for (let i=0;i<str.length;i++) h=Math.imul(h^str.charCodeAt(i),16777619);
    return (h>>>0).toString(36) + '-' + str.length;
  }
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queued.length && consent.checked) {
        const job = queued.shift();
        if (job.generation !== generation) continue;
        const b = blocks[job.index];
        if (!b || b.state !== 'queued') continue;
        b.state = 'working'; b.right.textContent = 'Traduzindo…';
        const src=source.value,dst=target.value;
        try {
          const result = await getTranslation(b.text,src,dst);
          if (job.generation !== generation || src !== source.value || dst !== target.value) continue;
          b.right.textContent = result;
          b.right.classList.remove('pending','failed'); b.state='done'; countDone++;
          setStatus(`${countDone} de ${blocks.length} trechos traduzidos${loading?' · lendo mais páginas…':''}`);
        } catch(err) {
          if (job.generation !== generation) continue;
          b.right.textContent = `Não foi possível traduzir este trecho. ${err?.message || 'Tente novamente.'}`;
          b.right.classList.remove('pending'); b.right.classList.add('failed'); b.state='failed';
          setStatus('Tradução interrompida para um trecho. Verifique a conexão ou o limite gratuito.');
        }
        await new Promise(resolve=>setTimeout(resolve,100)); // gentler to a free public API
      }
    } finally { running=false; if (queued.length && consent.checked) setTimeout(drain,0); }
  }
  function translateVisible() {
    if (!consent.checked) {setStatus('Marque a autorização para iniciar a tradução.');return;}
    const top = original.scrollTop, bottom=top+original.clientHeight+500;
    for(let i=0;i<blocks.length;i++) {
      const b=blocks[i];
      if (b.left.offsetTop + b.left.offsetHeight >= top-500 && b.left.offsetTop<=bottom) enqueue(i);
    }
  }
  function onLanguageChange() {
    generation++;
    queued=[]; countDone=0;
    for (const b of blocks) {b.state='idle';b.right.textContent='Aguardando tradução…';b.right.classList.remove('failed');b.right.classList.add('pending');}
    if (consent.checked) translateVisible();
  }
  async function openBytes(buffer,name) {reset(); await readPDF(buffer,name);}
  input.addEventListener('change',async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {setStatus('Escolha um PDF.');return;}
    await openBytes(await file.arrayBuffer(),file.name);
  });
  sample.addEventListener('click',async()=>{
    try {const res=await fetch('./exemplo.pdf'); if(!res.ok)throw new Error(`HTTP ${res.status}`);
      await openBytes(await res.arrayBuffer(),'exemplo.pdf');
    } catch {setStatus('Exemplo indisponível. Use Abrir PDF para selecionar o arquivo de teste.');}
  });
  source.addEventListener('change',onLanguageChange);
  target.addEventListener('change',onLanguageChange);
  consent.addEventListener('change',()=>{
    if (consent.checked) translateVisible();
    else {queued=[]; setStatus('Tradução pausada. Seu PDF permanece aberto.');}
  });
  function linkScroll(from,to) {
    from.addEventListener('scroll',()=>{
      if (ignoredScroll) return;
      const list=from.querySelectorAll('p.segment');
      if (!list.length) return;
      const pos=from.scrollTop;
      let chosen=list[0];
      for (const item of list) {if(item.offsetTop <= pos+30) chosen=item; else break;}
      const other=to.querySelector(`p.segment[data-index="${chosen.dataset.index}"]`);
      if (!other) return;
      const ratio=Math.max(0,Math.min(1,(pos-chosen.offsetTop)/Math.max(1,chosen.offsetHeight)));
      ignoredScroll=true;
      to.scrollTop=other.offsetTop + ratio*other.offsetHeight;
      setTimeout(()=>{ignoredScroll=false;},60);
      if(from===original) translateVisible();
    },{passive:true});
  }
  linkScroll(original,translation); linkScroll(translation,original);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
  }
})();
