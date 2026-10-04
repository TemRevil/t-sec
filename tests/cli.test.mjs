import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve('.test-data');
let sandbox;
let common;
let deviceA;
let deviceB;
function cli(args, {input, env=deviceA, status=0}={}) {
  const result=spawnSync(process.execPath,['dist/t-sec.mjs',...args],{encoding:'utf8',input,env,timeout:30000});
  assert.ifError(result.error);
  assert.equal(result.status,status,result.stderr || result.stdout);
  return result.stdout;
}
before(()=> {
  fs.mkdirSync(root,{recursive:true});
  sandbox=fs.mkdtempSync(path.join(root,'roundtrip-'));
  const tmp=path.join(sandbox,'tmp');
  fs.mkdirSync(tmp);
  common={...process.env,TSEC_VAULT_DIR:path.join(sandbox,'vault'),TMP:tmp,TEMP:tmp,TMPDIR:tmp};
  deviceA={...common,TSEC_IDENTITY_DIR:path.join(sandbox,'identity-a')};
  deviceB={...common,TSEC_IDENTITY_DIR:path.join(sandbox,'identity-b')};
});
after(()=> {
  if(process.platform==='win32') {
    for(const dir of ['identity-a','identity-b']) {
      const file=path.join(sandbox,dir,'identity.txt');
      if(fs.existsSync(file)) spawnSync('icacls',[file,'/reset'],{stdio:'ignore'});
    }
  }
  assert.ok(sandbox.startsWith(root+path.sep));
  fs.rmSync(sandbox,{recursive:true,force:true});
});
test('help and empty listing do not create an identity',()=> {
  assert.match(cli(['--help']),/t-sec/);
  assert.equal(cli(['list']),'');
  assert.equal(fs.existsSync(deviceA.TSEC_IDENTITY_DIR),false);
});
test('trust, stdin storage, encryption and round-trip selftest',()=> {
  cli(['trust','--label','test-device-a']);
  cli(['selftest']);
  cli(['set','example-app','DEMO_VALUE'],{input:'test-only-value'});
  assert.equal(cli(['get','example-app','DEMO_VALUE']),'test-only-value');
  assert.match(cli(['list','example-app']),/DEMO_VALUE/);
  const cipher=fs.readFileSync(path.join(common.TSEC_VAULT_DIR,'_secrets','example-app.secrets.json.age'));
  assert.equal(cipher.includes(Buffer.from('test-only-value')),false);
  assert.match(cipher.toString('utf8'),/^age-encryption\.org\/v1/);
});
test('child sees secrets, args stay literal, and child exit status is preserved',()=> {
  const output=cli(['run','example-app','--',process.execPath,'-e','process.stdout.write(process.env.DEMO_VALUE)']);
  assert.equal(output,'test-only-value');
  const literal='literal; & not-a-shell-command';
  assert.equal(cli(['run','example-app','--',process.execPath,'-e','process.stdout.write(process.argv[1])',literal]),literal);
  cli(['run','example-app','--',process.execPath,'-e','process.exit(7)'],{status:7});
});
test('new device needs re-encryption; removing it prevents reading updated ciphertext',()=> {
  cli(['trust','--label','test-device-b'],{env:deviceB});
  cli(['get','example-app','DEMO_VALUE'],{env:deviceB,status:1});
  cli(['reencrypt']);
  assert.equal(cli(['get','example-app','DEMO_VALUE'],{env:deviceB}),'test-only-value');
  cli(['remove','test-device-b','--yes']);
  cli(['get','example-app','DEMO_VALUE'],{env:deviceB,status:1});
});
test('project traversal and missing keys fail without leaving files',()=> {
  cli(['set','../outside','DEMO_VALUE'],{input:'fake',status:1});
  cli(['get','example-app','NO_SUCH_KEY'],{status:1});
  assert.equal(fs.existsSync(path.join(common.TSEC_VAULT_DIR,'outside.secrets.json.age')),false);
});
test('key and project deletion leave no stored secrets',()=> {
  cli(['remove-key','example-app','DEMO_VALUE']);
  assert.equal(cli(['list','example-app']),'');
  cli(['remove-project','example-app','--yes']);
  assert.equal(cli(['list']),'');
});

