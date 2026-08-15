import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveStatic } from '../src/http.mjs';

function responseCapture(){
  return{
    status:null,
    headers:null,
    body:null,
    writeHead(status,headers){this.status=status;this.headers=headers;},
    end(body){this.body=body;}
  };
}

test('mutable frontend assets are never reused across local deploys',async t=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'workbench-static-cache-'));
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  await fsp.writeFile(path.join(root,'index.html'),'<html></html>');
  await fsp.writeFile(path.join(root,'app.js'),'console.log("new")');
  await fsp.writeFile(path.join(root,'app.css'),'body{}');
  await fsp.writeFile(path.join(root,'manifest.webmanifest'),'{}');
  await fsp.writeFile(path.join(root,'icon.png'),'png');

  for(const pathname of ['/', '/app.js', '/app.css', '/manifest.webmanifest']){
    const res=responseCapture();
    assert.equal(await serveStatic(root,pathname,res),true);
    assert.equal(res.status,200);
    assert.equal(res.headers['Cache-Control'],'no-store, max-age=0');
  }

  const image=responseCapture();
  assert.equal(await serveStatic(root,'/icon.png',image),true);
  assert.equal(image.headers['Cache-Control'],'public, max-age=3600');
});
