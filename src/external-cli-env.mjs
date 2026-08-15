const GETNOTE_ENV_KEYS=Object.freeze([
  'HOME','PATH','USER','LOGNAME','TMPDIR','LANG','LC_ALL','LC_CTYPE','XDG_CONFIG_HOME',
  'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy',
  'SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS',
  'GETNOTE_API_KEY','GETNOTE_CLIENT_ID'
]);

function stringEntries(source){
  return Object.entries(source||{}).filter(([,value])=>typeof value==='string'&&value.length>0);
}

export function getnoteCliEnv(source={}){
  const env={};
  for(const key of GETNOTE_ENV_KEYS){
    const value=source?.[key];
    if(typeof value==='string'&&value.length)env[key]=value;
  }
  return env;
}

function unrelatedSecretKey(key){
  if(/^(?:LARK|FEISHU)_/i.test(key))return false;
  return /(?:^|_)(?:PASSWORD|SECRET|TOKEN|API_KEY)$/i.test(key);
}

export function larkCliEnv(source={}){
  const env={};
  for(const [key,value] of stringEntries(source)){
    if(unrelatedSecretKey(key))continue;
    env[key]=value;
  }
  return env;
}
