import { isIP } from 'node:net';
import { timingSafeEqualText } from './utils.mjs';

function normalizeAddress(value){
  let address=String(value||'').trim().toLowerCase();
  if(address.startsWith('[')&&address.endsWith(']'))address=address.slice(1,-1);
  if(address.startsWith('::ffff:'))address=address.slice(7);
  const zone=address.indexOf('%');
  if(zone!==-1)address=address.slice(0,zone);
  return address;
}

export function isLoopbackAddress(value){
  const address=normalizeAddress(value);
  if(address==='localhost'||address==='::1')return true;
  if(isIP(address)===4)return address.startsWith('127.');
  return false;
}

/**
 * The sidecar normally reaches the parent over loopback. A server bound to one
 * concrete LAN address may self-connect through that same address; token
 * authentication remains mandatory in either case.
 */
export function isLocalHarnessTransport(req){
  const remote=normalizeAddress(req?.socket?.remoteAddress);
  const local=normalizeAddress(req?.socket?.localAddress);
  return isLoopbackAddress(remote)||Boolean(remote&&local&&remote===local);
}

export function harnessBridgeAuthorized(req,expectedToken){
  if(!isLocalHarnessTransport(req))return false;
  const expected=String(expectedToken||'');
  if(expected.length<32)return false;
  const authorization=String(req?.headers?.authorization||'');
  const supplied=authorization.startsWith('Bearer ')?authorization.slice(7):'';
  return timingSafeEqualText(supplied,expected);
}

export function harnessBridgeBaseUrl(host,port){
  const raw=String(host||'127.0.0.1').trim().replace(/^\[|\]$/g,'');
  let target=raw;
  if(!target||target==='0.0.0.0'||target==='localhost')target='127.0.0.1';
  else if(target==='::')target='::1';
  const authority=isIP(target)===6?`[${target}]`:target;
  return `http://${authority}:${Number(port)}`;
}
