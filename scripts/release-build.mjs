import {execFileSync} from 'node:child_process';
import {buildReleaseArtifact} from '../src/release-builder.mjs';

const FLAGS=new Map([
  ['--repository-root','repositoryRoot'],
  ['--candidate-commit','candidateCommit'],
  ['--releases-root','releasesRoot'],
  ['--built-at','builtAt']
]);

function fail(code){
  throw Object.assign(new Error('Release build arguments are invalid.'),{
    code,
    stage:'cli',
    retryable:false
  });
}

function parseArgs(argv){
  const values={};
  if(argv.length%2!==0)fail('RELEASE_BUILD_CLI_INVALID_ARGUMENTS');
  for(let index=0;index<argv.length;index+=2){
    const key=FLAGS.get(argv[index]);
    const value=argv[index+1];
    if(!key||typeof value!=='string'||!value||Object.hasOwn(values,key)){
      fail('RELEASE_BUILD_CLI_INVALID_ARGUMENTS');
    }
    values[key]=value;
  }
  if(!values.repositoryRoot||!values.candidateCommit||!values.releasesRoot){
    fail('RELEASE_BUILD_CLI_INVALID_ARGUMENTS');
  }
  values.builtAt??=new Date().toISOString();
  return values;
}

function npmExecutable(){
  try{
    return execFileSync('/usr/bin/which',['npm'],{
      encoding:'utf8',
      env:{
        PATH:process.env.PATH||'/usr/bin:/bin',
        HOME:process.env.HOME||'',
        LC_ALL:'C'
      }
    }).trim();
  }catch{
    fail('RELEASE_NPM_EXECUTABLE_UNAVAILABLE');
  }
}

function npmVersion(executable){
  try{
    return execFileSync(executable,['--version'],{
      encoding:'utf8',
      env:{
        PATH:process.env.PATH||'/usr/bin:/bin',
        HOME:process.env.HOME||'',
        LC_ALL:'C'
      }
    }).trim();
  }catch{
    fail('RELEASE_NPM_VERSION_UNAVAILABLE');
  }
}

try{
  const args=parseArgs(process.argv.slice(2));
  const npmPath=npmExecutable();
  const result=await buildReleaseArtifact({
    ...args,
    nodeExecutable:process.execPath,
    npmExecutable:npmPath,
    nodeVersion:process.versions.node,
    npmVersion:npmVersion(npmPath),
    platform:process.platform,
    arch:process.arch
  });
  process.stdout.write(`${JSON.stringify({
    ok:true,
    releaseId:result.releaseId,
    candidateCommit:result.releaseIdentity.candidateCommit,
    productVersion:result.releaseIdentity.productVersion,
    sourceFileCount:result.sourceManifest.sourceTree.fileCount,
    runtimeEntryCount:result.runtimeManifest.runtimeTree.entryCount,
    staticAssetCount:result.staticManifest.staticAssets.assetCount,
    reused:result.reused
  })}\n`);
}catch(error){
  const output={
    ok:false,
    code:typeof error?.code==='string'?error.code:'RELEASE_BUILD_FAILED',
    stage:typeof error?.stage==='string'?error.stage:'build',
    retryable:error?.retryable===true
  };
  if(typeof error?.causeCode==='string')output.causeCode=error.causeCode;
  if(typeof error?.commandId==='string')output.commandId=error.commandId;
  process.stderr.write(`${JSON.stringify(output)}\n`);
  process.exitCode=1;
}
