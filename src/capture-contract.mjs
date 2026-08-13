import { inboxContentHash } from './inbox-ack.mjs';

export const CAPTURE_MARKER_PREFIX='[WORKBENCH_CAPTURE:';
const SAFE_CAPTURE_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

function captureError(message,code='INVALID_CAPTURE_ID'){
  return Object.assign(new Error(message),{statusCode:400,code});
}

export function normalizeCaptureId(value){
  const captureId=String(value??'').trim();
  if(!SAFE_CAPTURE_ID.test(captureId))throw captureError('captureId 必须是 8-128 位安全 ID；推荐使用 UUID。');
  return captureId;
}

export function captureMarker(captureId){
  return `${CAPTURE_MARKER_PREFIX}${normalizeCaptureId(captureId)}]`;
}

export function parseCaptureMarker(value){
  const text=String(value??'').trim();
  const match=text.match(/^\[WORKBENCH_CAPTURE:([A-Za-z0-9][A-Za-z0-9_-]{7,127})\]\s*/);
  if(!match)return{captureId:null,text};
  return{captureId:match[1],text:text.slice(match[0].length).trim()};
}

export function captureContentHash(value){return inboxContentHash(value);}
