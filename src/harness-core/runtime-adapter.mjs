export function defineRuntimeAdapter({name,run,status}={}){
  if(!name||typeof run!=='function'||typeof status!=='function'){
    throw new Error('runtime adapter requires name, run, status');
  }
  return Object.freeze({name,run,status});
}
