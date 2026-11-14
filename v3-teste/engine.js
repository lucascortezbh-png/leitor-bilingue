// Camada experimental isolada. Todo texto é traduzido localmente por Bergamot,
// quando o carregamento do engine, WASM e modelos for permitido pelo navegador.
// Não há fallback silencioso para APIs remotas.
const ENGINE_URL='https://esm.sh/@browsermt/bergamot-translator@0.4.9/translator.js';
let translatorPromise=null;
export async function createLocalTranslator(){
 if(!translatorPromise){
  translatorPromise=(async()=>{
   const lib=await import(/* @vite-ignore */ ENGINE_URL);
   const Translator=lib.BatchTranslator;
   if(typeof Translator!=='function')throw new Error('Módulo Bergamot não disponibilizou BatchTranslator.');
   const engine=new Translator({workers:1,batchSize:1,cacheSize:200,pivotLanguage:'en'});
   return {
    translate:async(text)=>{
     const out=await engine.translate({from:'es',to:'pt',text,html:false});
     if(typeof out?.target?.text!=='string')throw new Error('Resposta inesperada do Bergamot.');
     return out.target.text;
    },
    dispose:()=>engine.delete()
   };
  })().catch(err=>{translatorPromise=null;throw err});
 }
 return translatorPromise;
}
