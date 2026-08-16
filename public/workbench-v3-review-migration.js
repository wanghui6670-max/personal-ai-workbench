try{
  const schema='2';
  if(sessionStorage.getItem('workbench-v3-review-schema')!==schema){
    sessionStorage.removeItem('workbench-v3-inbox-reviews-v1');
    sessionStorage.setItem('workbench-v3-review-schema',schema);
  }
}catch{}
