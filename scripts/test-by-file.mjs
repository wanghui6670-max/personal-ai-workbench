import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root=path.resolve('.');
const testsDir=path.join(root,'tests');
const files=(await fsp.readdir(testsDir))
  .filter(name=>name.endsWith('.test.mjs'))
  .sort();

function run(file){
  return new Promise(resolve=>{
    const child=spawn(process.execPath,['--test',path.join('tests',file)],{
      cwd:root,
      env:process.env,
      stdio:['ignore','pipe','pipe']
    });
    let stdout='';
    let stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('close',code=>resolve({file,code,stdout,stderr}));
  });
}

const failures=[];
for(const file of files){
  const result=await run(file);
  if(result.code===0){
    console.log(`PASS ${file}`);
  }else{
    failures.push(result);
    console.error(`FAIL ${file}`);
    console.error(result.stdout.trim());
    if(result.stderr.trim())console.error(result.stderr.trim());
  }
}

console.log(`\nTest files: ${files.length}; passed: ${files.length-failures.length}; failed: ${failures.length}`);
if(failures.length)process.exitCode=1;
