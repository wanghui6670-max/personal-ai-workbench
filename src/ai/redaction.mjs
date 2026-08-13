const REDACTED='[REDACTED]';

export function redactSensitiveText(value){
  let text=String(value??'');
  text=text.replace(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/gi,'[REDACTED PRIVATE KEY]');
  text=text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]*@/gi,`$1${REDACTED}@`);
  const credentialName='[A-Za-z0-9_.-]*(?:key|token|password|secret)';
  text=text.replace(new RegExp(`(["']?)(${credentialName})\\1(\\s*[:=]\\s*)"[^"\\r\\n]*"`,'gi'),`$1$2$1$3"${REDACTED}"`);
  text=text.replace(new RegExp(`(["']?)(${credentialName})\\1(\\s*[:=]\\s*)'[^'\\r\\n]*'`,'gi'),`$1$2$1$3'${REDACTED}'`);
  text=text.replace(new RegExp(`(["']?)(${credentialName})\\1(\\s*[:=]\\s*)(?!["'])([^\\s,;}\\]&)]+)`,'gi'),`$1$2$1$3${REDACTED}`);
  text=text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,`Bearer ${REDACTED}`);
  text=text.replace(/\b(?:sk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/gi,REDACTED);
  return text;
}
