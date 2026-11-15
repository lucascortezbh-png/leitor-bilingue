// V3.6 usa os arquivos Bergamot já presentes em /v3-teste/vendor/ no mesmo
// GitHub Pages. A pasta v3-teste da V3.5 continua intacta.
function deadline(task,ms,label){
  let timeout;
  return Promise.race([
    Promise.resolve(task),
    new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error(`${label} não respondeu após ${Math.ceil(ms/1000)} segundos.`)),ms);})
  ]).finally(()=>clearTimeout(timeout));
}
const PACKAGE_BASE = new URL('./v3-teste/vendor/',import.meta.url);
let enginePromise;
const listeners=new Set();
function status(s){for(const cb of listeners){try{cb(s)}catch(e){console.warn(e)}}}
function readable(e){return e instanceof Error ? e.message : String(e);}

async function ensureLocalFiles(){
  if(!('serviceWorker' in navigator)) throw new Error('Este Safari não oferece Service Worker.');
  if(!globalThis.WebAssembly || !globalThis.Worker) throw new Error('WebAssembly ou Worker indisponível neste navegador.');
  status('Desativando o carregador antigo de CDN…');
  const swUrl=new URL('./sw-local.js?v=3',import.meta.url);
  await deadline(navigator.serviceWorker.register(swUrl.href,{scope:'./'}),20000,'Registro do Service Worker');
  await deadline(navigator.serviceWorker.ready,20000,'Ativação do Service Worker');
  const isCurrent=()=>navigator.serviceWorker.controller?.scriptURL?.includes('sw-local.js?v=3');
  if(!isCurrent()){
    await deadline(new Promise(resolve=>{
      const fn=()=>{if(isCurrent()){navigator.serviceWorker.removeEventListener('controllerchange',fn);resolve()}};
      navigator.serviceWorker.addEventListener('controllerchange',fn);fn();
    }),20000,'Substituição do Service Worker antigo');
  }
  const files=[
    ['translator.js',5000],
    ['worker/translator-worker.js',5000],
    ['worker/bergamot-translator-worker.js',5000],
    ['worker/bergamot-translator-worker.wasm',1000000],
  ];
  for(const [p,min] of files){
    status('Verificando arquivo local: '+p);
    const r=await deadline(fetch(new URL(p,PACKAGE_BASE),{cache:'no-store'}),20000,'Carregamento de '+p);
    if(!r.ok) throw new Error(`Arquivo ${p} ausente (HTTP ${r.status}). Execute PREPARAR_V3_3 no computador e envie a pasta completa com vendor.`);
    const ab=await r.arrayBuffer();
    if(ab.byteLength<min) throw new Error(`Arquivo ${p} inválido ou incompleto (${ab.byteLength} bytes).`);
  }
  status('Biblioteca local disponível. Preparando o Worker…');
}

export async function createLocalTranslator(onStage=()=>{}){
  listeners.add(onStage);
  if(!enginePromise){
    enginePromise=(async()=>{
      await ensureLocalFiles();
      const lib=await deadline(import('./v3-teste/vendor/translator.js'),20000,'Importação Bergamot');
      if(typeof lib.BatchTranslator!=='function') throw new Error('Biblioteca local não disponibilizou BatchTranslator.');
      const translator=new lib.BatchTranslator({
        workers:1,batchSize:1,cacheSize:128,pivotLanguage:'en',downloadTimeout:45000,
        workerUrl:new URL('worker/translator-worker.js',PACKAGE_BASE).href
      });
      return {
        translate:async text=>{
          status('Carregando modelos de idioma e traduzindo…');
          try{
            const reply=await deadline(translator.translate({from:'es',to:'pt',text,html:false}),120000,'Tradução/modelos');
            if(typeof reply?.target?.text!=='string') throw new Error('Resposta inválida do tradutor.');
            status('Tradução local concluída.');
            return reply.target.text;
          }catch(e){
            try{translator.delete()}catch{}
            enginePromise=null;
            throw e;
          }
        },dispose:()=>translator.delete()
      };
    })().catch(err=>{enginePromise=null;status('Falha: '+readable(err));throw err});
  }
  try{return await enginePromise}finally{listeners.delete(onStage)}
}
