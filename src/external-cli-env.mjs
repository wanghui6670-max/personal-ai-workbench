const BASE_ENV_KEYS=Object.freeze([
  'HOME','PATH','USER','LOGNAME','TMPDIR','LANG','LC_ALL','LC_CTYPE','XDG_CONFIG_HOME',
  'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy',
  'SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS'
]);
const GETNOTE_ENV_KEYS=Object.freeze([...BASE_ENV_KEYS,'GETNOTE_API_KEY','GETNOTE_CLIENT_ID']);

function copyKeys(source,keys){
  const env={};
  for(const key of keys){
    const value=source?.[key];
    if(typeof value==='string'&&value.length)env[key]=value;
  }
  return env;
}

export function getnoteCliEnv(source={}){
  return copyKeys(source,GETNOTE_ENV_KEYS);
}

export function larkCliEnv(source={}){
  const env=copyKeys(source,BASE_ENV_KEYS);
  for(const [key,value] of Object.entries(source||{})){
    if(!/^(?:LARK|FEISHU)_/i.test(key))continue;
    if(typeof value==='string'&&value.length)env[key]=value;
  }
  return env;
}
