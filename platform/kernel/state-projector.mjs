function clone(value){return structuredClone(value);}

export function createStateProjector({initialState,reduce}={}){
  if(typeof initialState!=='function')throw new Error('initialState is required');
  if(typeof reduce!=='function')throw new Error('reduce is required');
  return Object.freeze({
    project(events=[]){
      let state=clone(initialState());
      for(const event of events){
        state=reduce(clone(state),clone(event));
        if(state===undefined)throw new Error('state reducer must return state');
      }
      return clone(state);
    }
  });
}
