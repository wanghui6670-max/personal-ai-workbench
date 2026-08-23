import {execFileSync} from 'node:child_process';
import {prepareReleaseSourceArtifact} from '../src/release-preparation.mjs';

const FLAGS=new Map([
  ['--repository-root','repositoryRoot'],
  ['--candidate-commit','candidateCommit'],
  ['--destination-root','destinationRoot'],
  ['--built-at','builtAt']
]);

function fail(code){
  throw Object.assign(new Error('Release preparation arguments are invalid.'),{
    code,
    stage:'cli',
    retryable:false
  });
}

function parseArgs(argv){
  const values={};
  for(let index=0;index<argv.length;index+=2){
    const flag=argv[index];
    const key=FLAGS.get(flag);
    const value=argv[index+1];
    if(!key||typeof value!=='string'||value===''||Object.hasOwn(values,key)){
      fail('RELEASE_CLI_INVALID_ARGUMENTS');
    }
    values[key]=value;
  }
  if(!values.repositoryRoot||!values.candidateCommit||!values.destinationRoot){
    fail('RELEASE_CLI_INVALID_ARGUMENTS');
  }
  values.builtAt??=new Date().toISOString();
  return values;
}

function actualNpmVersion(){
  try{
    return execFileSync('npm',['--version'],{
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
  const options=parseArgs(process.argv.slice(2));
  const result=await prepareReleaseSourceArtifact({
    ...options,
    nodeVersion:process.versions.node,
    npmVersion:actualNpmVersion()
  });
  process.stdout.write(`${JSON.stringify({
    ok:true,
    candidateCommit:result.sourceManifest.candidateCommit,
    productVersion:result.releaseContract.productVersion,
    sourceFileCount:result.sourceManifest.sourceTree.fileCount,
    staticAssetCount:result.staticManifest.staticAssets.assetCount,
    sourceManifestSha256:result.sourceManifest.sourceTree.manifestSha256,
    staticManifestSha256:result.staticManifest.staticAssets.manifestSha256
  })}\n`);
}catch(error){
  process.stderr.write(`${JSON.stringify({
    ok:false,
    code:typeof error?.code==='string'?error.code:'RELEASE_PREPARATION_FAILED',
    stage:typeof error?.stage==='string'?error.stage:'prepare',
    retryable:error?.retryable===true
  })}\n`);
  process.exitCode=1;
}
