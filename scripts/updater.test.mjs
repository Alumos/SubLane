import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const script=fileURLToPath(new URL("./updater.sh",import.meta.url));
const job={id:"a".repeat(32),version:"1.3.0",status:"queued",updated_at:1900000000};
async function until(predicate,child){
  for(let i=0;i<150;i++){
    if(predicate())return;
    if(child.exitCode!==null)throw new Error(`Worker exited ${child.exitCode}`);
    await delay(30);
  }
  throw new Error("Synthetic worker did not publish its state");
}
function fixture(t,fail=false){
  const dir=realpathSync(mkdtempSync(join(tmpdir(),"sublane-updater-")));
  const privateDir=join(dir,".updater");mkdirSync(privateDir,{mode:0o700});
  const mailbox=join(privateDir,"mailbox");mkdirSync(mailbox,{mode:0o777});
  const calls=join(dir,"args");
  writeFileSync(join(dir,".env"),"SUBLANE_IMAGE=ghcr.io/murongg/sublane:1.2.0\n");
  writeFileSync(join(privateDir,"install.sh"),`#!/bin/bash\nprintf '%s\\n' "$@" > "$UPDATE_TEST_ARGS"\necho 'Synthetic private diagnostic'\nexit ${fail?1:0}\n`,{mode:0o700});
  const child=spawn("bash",[script,"--run",dir],{env:{...process.env,UPDATE_TEST_ARGS:calls},detached:true,stdio:"ignore"});
  t.after(async()=>{
    try{process.kill(-child.pid,"SIGTERM")}catch{}
    await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once("exit",resolve));
    rmSync(dir,{recursive:true,force:true});
  });
  return {dir,privateDir,mailbox,calls,child,
    request(value=job){writeFileSync(join(mailbox,"request.json"),JSON.stringify(value));},
    status(){try{return JSON.parse(readFileSync(join(mailbox,"status.json"),"utf8"))}catch{return null}}
  };
}
test("host updater runs only the pinned installer and retains completion outside the app process",async t=>{
  const f=fixture(t);
  await until(()=>existsSync(join(f.mailbox,"heartbeat")),f.child);
  f.request();
  await until(()=>f.status()?.status==="succeeded"&&!existsSync(join(f.mailbox,"request.json")),f.child);
  assert.deepEqual(readFileSync(f.calls,"utf8").trim().split("\n"),["--update","--dir",f.dir,"--version","1.3.0","--non-interactive"]);
  assert.equal(f.status().id,job.id);
  assert.match(readFileSync(join(f.privateDir,"last.log"),"utf8"),/Synthetic private diagnostic/);
  assert.equal(existsSync(join(f.mailbox,"last.log")),false);
});
test("failed readiness reports failure and never runs a downgrade",async t=>{
  const f=fixture(t,true);await until(()=>existsSync(join(f.mailbox,"heartbeat")),f.child);f.request();
  await until(()=>f.status()?.status==="failed",f.child);
  assert.equal(readFileSync(f.calls,"utf8").includes("rollback"),false);
  assert.equal(f.status().version,"1.3.0");
});
test("interrupted installations are reported without replaying the request",async t=>{
  const f=fixture(t);
  await until(()=>existsSync(join(f.mailbox,"heartbeat")),f.child);
  // Stop the first worker, then restart with a durable in-flight job.
  process.kill(-f.child.pid,"SIGTERM");await new Promise(resolve=>f.child.once("exit",resolve));
  f.request();writeFileSync(join(f.mailbox,"status.json"),JSON.stringify({...job,status:"running"}));
  const next=spawn("bash",[script,"--run",f.dir],{env:{...process.env,UPDATE_TEST_ARGS:f.calls},detached:true,stdio:"ignore"});
  t.after(()=>{try{process.kill(-next.pid,"SIGTERM")}catch{}});
  await until(()=>f.status()?.status==="interrupted",next);
  assert.equal(existsSync(f.calls),false);
});
test("malformed jobs and symbolic links never reach the installer",async t=>{
  const f=fixture(t);await until(()=>existsSync(join(f.mailbox,"heartbeat")),f.child);
  const outside=join(f.dir,"synthetic-private");writeFileSync(outside,"synthetic private bytes");
  symlinkSync(outside,join(f.mailbox,"request.json"));
  await until(()=>!existsSync(join(f.mailbox,"request.json")),f.child);
  assert.equal(readFileSync(outside,"utf8"),"synthetic private bytes");
  f.request({...job,version:"1.3.0; touch unwanted"});
  await until(()=>!existsSync(join(f.mailbox,"request.json")),f.child);
  assert.equal(existsSync(f.calls),false);
  assert.equal(existsSync(join(f.dir,"unwanted")),false);
});

test("the host worker independently refuses downgrades and repeated installations",async t=>{
  const f=fixture(t);await until(()=>existsSync(join(f.mailbox,"heartbeat")),f.child);
  f.request({...job,version:"1.1.0"});
  await until(()=>f.status()?.status==="failed"&&!existsSync(join(f.mailbox,"request.json")),f.child);
  assert.equal(existsSync(f.calls),false);
  f.request({...job,id:"b".repeat(32),version:"1.2.0"});
  await until(()=>f.status()?.id==="b".repeat(32)&&f.status()?.status==="failed",f.child);
  assert.equal(existsSync(f.calls),false);
  assert.match(readFileSync(join(f.privateDir,"last.log"),"utf8"),/newer stable version/);
});
