// V3.2 experimental: remove opção não serializável na inicialização do Worker
// por Service Worker de escopo restrito. Não usa MyMemory nem serviços de tradução.
// Os arquivos do pacote são obtidos de CDNs públicos; os modelos são baixados
// pelo Bergamot. Textos a traduzir permanecem no navegador.
function deadline(task,ms,label){
  let timeout;
  return Promise.race([
    Promise.resolve(task),
    new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error(`${label} não respondeu após ${Math.ceil(ms/1000)} segundos.`)),ms);})
  ]).finally(()=>clearTimeout(timeout));
}
const PACKAGE_BASE = new URL('./vendor/',import.meta.url);
let enginePromise;
let listeners=new Set();
function status(s){for(const cb of listeners){try{cb(s)}catch(e){console.warn(e);}}}
function readable(e){return e instanceof Error ? e.message : String(e);}

async function ensureLocalWorker(){
  if(!('serviceWorker' in navigator)){
    throw new Error('Este navegador não oferece Service Worker, necessário para carregar o motor local.');
  }
  if(!globalThis.WebAssembly || !globalThis.Worker){
    throw new Error('WebAssembly ou Web Worker indisponível neste navegador.');
  }
  status('Registrando tradutor isolado da versão 2…');
  const swUrl = new URL('./sw-local.js?v=2',import.meta.url);
  const reg = await deadline(navigator.serviceWorker.register(swUrl.href,{scope:'./'}),20000,'Registro do Service Worker');
  await deadline(navigator.serviceWorker.ready,20000,'Ativação do Service Worker');
  const expected = new URL(swUrl.href).pathname;
  if(!navigator.serviceWorker.controller?.scriptURL?.includes(expected)){
    status('Ativando o tradutor no Safari…');
    await deadline(new Promise((resolve,reject)=>{
      const onChange=()=>{if(navigator.serviceWorker.controller?.scriptURL?.includes(expected)){cleanup();resolve();}};
      const cleanup=()=>navigator.serviceWorker.removeEventListener('controllerchange',onChange);
      navigator.serviceWorker.addEventListener('controllerchange',onChange);
      onChange();
    }),20000,'Controle local do Service Worker');
  }
  if(!navigator.serviceWorker.controller?.scriptURL?.includes(expected)){
    throw new Error('O Safari ainda não ativou o tradutor local. Feche esta aba e abra novamente a versão 3.');
  }
  status('Conferindo acesso aos arquivos locais do tradutor…');
  const entry = new URL('translator.js',PACKAGE_BASE);
  const resp=await deadline(fetch(entry,{cache:'no-store'}),45000,'Download da biblioteca Bergamot');
  if(!resp.ok)throw new Error(`Não foi possível carregar o Bergamot: HTTP ${resp.status}. Confirme a conexão.`);
  const code=await resp.text();
  if(!code.includes('BatchTranslator'))throw new Error('O módulo retornado pelo CDN não contém a biblioteca Bergamot.');
}

export async function createLocalTranslator(onStage=()=>{}){
  listeners.add(onStage);
  if(!enginePromise){
    enginePromise=(async()=>{
      await ensureLocalWorker();
      status('Importando biblioteca local, sem worker externo…');
      const lib=await deadline(import('./vendor/translator.js'),20000,'Importação da biblioteca');
      if(typeof lib.BatchTranslator!=='function')throw new Error('Biblioteca Bergamot não disponibilizou BatchTranslator.');
      // As opções são transmitidas ao Worker por cópia estruturada (postMessage).
      // Nunca passar funções (ex.: onerror) aqui: Safari acusa DataCloneError.
      status('Criando processo de tradução local…');
      const translator = new lib.BatchTranslator({
        workers:1, batchSize:1, cacheSize:128, pivotLanguage:'en', downloadTimeout:45000,
        workerUrl: new URL('worker/translator-worker.js',PACKAGE_BASE).href
      });
      return {
        translate:async text=>{
          status('Carregando modelos e traduzindo (espanhol → português)…');
          let reply;
          try {
            reply=await deadline(
              translator.translate({from:'es',to:'pt',text,html:false}),
              120000,'Primeira tradução / modelos'
            );
          } catch(error) {
            // Testes posteriores precisam iniciar um Worker novo, não reutilizar o falho.
            try {translator.delete();} catch(_) {}
            enginePromise=null;
            throw error;
          }
          if(typeof reply?.target?.text!=='string')throw new Error('O tradutor retornou resposta inválida.');
          status('Bergamot concluiu a tradução.');
          return reply.target.text;
        },
        dispose:()=>translator.delete()
      };
    })().catch(err=>{enginePromise=null;status('Falha: '+readable(err));throw err;});
  }
  try{return await enginePromise;}finally{listeners.delete(onStage);}
}
