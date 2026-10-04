import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const excluded=new Set(['node_modules','.git','.test-data','.runtime']);
const rules=[
  ['private key material',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['age private identity',/AGE-SECRET-KEY-[A-Z0-9]{30,}/],
  ['GitHub token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['AWS access key',/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['provider key',/\b(?:sk_live_|rk_live_|re_)[A-Za-z0-9]{24,}\b/],
  ['credential in URL',/https?:\/\/[^\s/:]+:[^\s/@]+@/],
];
let count=0;
let failed=false;
function walk(dir) {
 for(const item of fs.readdirSync(dir,{withFileTypes:true})) {
  if(excluded.has(item.name)) continue;
  const file=path.join(dir,item.name);
  if(item.isDirectory()) {walk(file);continue;}
  if(!item.isFile()) throw new Error('Unexpected non-regular file: '+path.relative(root,file));
  const relative=path.relative(root,file);
  if(/(?:^|[\\/])(?:_secrets|identity\.txt|recipients\.txt|\.env(?:\..*)?)$|\.(?:age|pem|key|ppk)$/i.test(relative)) {
    console.error('Private-data filename:',relative);failed=true;continue;
  }
  const content=fs.readFileSync(file,'utf8');
  for(const [label,pattern] of rules) if(pattern.test(content)) {console.error(label+': '+relative);failed=true;}
  count++;
 }
}
walk(root);
if(failed) process.exitCode=1;
else console.log(`Scanned ${count} source/build files: no prohibited filenames or recognized credential patterns. Review is still required.`);
