// V3 diagnóstico: tradução local, sem envio a serviços externos.
// Identifica a etapa que não responde no Safari. Os limites são de espera,
// não cotas de tradução: um timeout não comprova falta de compatibilidade.
const ENGINE_URL='https://esm.sh/@browsermt/bergamot-translator@0.4.9/translator.js';
let translatorPromise=null;
let observers=new Set();
function update(message){for(const obs of observers){try{obs(message)}catch{}}}
export async function waitForStage(promise, timeoutMs, stage){
 let timer;
 try{
  return await Promise.race([
   promise,
   new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(stage+' não respondeu em '+Math.round(timeoutMs/1000)+' segundos. Verifique rede, memória ou compatibilidade do Safari.')),timeoutMs)})
  ]);
 }finally{clearTimeout(timer)}
}
export async function createLocalTranslator(onStage=()=>{}){
 observers.add(onStage);
 if(!translatorPromise){
  translatorPromise=(async()=>{
   update('Etapa 1/3: carregando biblioteca Bergamot…');
   const lib=await waitForStage(import(/* @vite-ignore */ ENGINE_URL),30000,'Importação do Bergamot');
   const Translator=lib.BatchTranslator;
   if(typeof Translator!=='function')throw new Error('O módulo não disponibilizou BatchTranslator.');
   update('Etapa 2/3: criando mecanismo de tradução…');
   const engine=new Translator({workers:1,batchSize:1,cacheSize:200,pivotLanguage:'en',downloadTimeout:60000});
   update('Etapa 3/3: mecanismo criado; aguardando modelos e primeira tradução…');
   return {
    translate:async(text)=>{
     update('Etapa 3/3: carregando modelos e traduzindo texto…');
     const response=await waitForStage(engine.translate({from:'es',to:'pt',text,html:false}),90000,'Tradução Bergamot');
     if(typeof response?.target?.text!=='string')throw new Error('O Bergamot retornou um formato inesperado.');
     update('Tradução local concluída.');
     return response.target.text;
    },
    dispose:()=>engine.delete()
   };
  })().catch(err=>{translatorPromise=null;throw err});
 }
 try{return await translatorPromise;}finally{observers.delete(onStage)}
}
