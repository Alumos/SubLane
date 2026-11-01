import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./install.sh", import.meta.url));
const compose = "services:\n  sublane:\n    image: ${SUBLANE_IMAGE}\n    environment:\n      SUBLANE_DEMO: ${SUBLANE_DEMO:-false}\n";
const helpers={"install.sh":"#!/bin/bash\necho 'Synthetic installer'\n","updater.sh":"#!/bin/bash\necho 'Synthetic updater'\n"};
const helperChecksums=Object.entries(helpers).map(([name,body])=>createHash("sha256").update(body).digest("hex")+"  "+name+"\n").join("");

function fixture(t, mode = "", api = {}, portTool = "ss") {
  const deployment = mode === "legacy-demo"
    ? "services:\n  sublane:\n    image: ${SUBLANE_IMAGE}\n"
    : compose;
  const checksum = createHash("sha256").update(deployment).digest("hex");
  const root = mkdtempSync(join(tmpdir(), "sublane-installer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const archiveRoot = join(root, "archive");
  mkdirSync(archiveRoot);
  writeFileSync(join(archiveRoot, "sublane"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(archiveRoot, "LICENSE"), "Synthetic license\n");
  writeFileSync(join(archiveRoot, ".env.example"), mode === "legacy-demo" ? "SUBLANE_ADDR=127.0.0.1:8080\n" : "SUBLANE_DEMO=false\n");
  const archiveName = "sublane_1.2.3_linux_amd64.tar.gz";
  const archivePath = join(root, archiveName);
  const packed = spawnSync("tar", ["-czf", archivePath, "-C", archiveRoot, "sublane", "LICENSE", ".env.example"]);
  assert.equal(packed.status, 0, packed.stderr?.toString());
  const archiveChecksum = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  const mock = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const mode = process.env.INSTALL_TEST_MODE;
const envPath = args.includes('--env-file') ? args[args.indexOf('--env-file') + 1] : null;
const settings = envPath ? fs.readFileSync(envPath, 'utf8') : '';
const values = Object.fromEntries(settings.split('\\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => {
  const index = line.indexOf('=');
  return [line.slice(0, index), line.slice(index + 1)];
}));
fs.appendFileSync(process.env.INSTALL_TEST_LOG, JSON.stringify({command, args, settings,
  image: process.env.SUBLANE_IMAGE ?? values.SUBLANE_IMAGE,
  port: process.env.SUBLANE_PORT ?? values.SUBLANE_PORT,
  demo: process.env.SUBLANE_DEMO ?? values.SUBLANE_DEMO,
  logLevel: process.env.SUBLANE_LOG_LEVEL ?? values.SUBLANE_LOG_LEVEL,
  maxBody: process.env.SUBLANE_MAX_REQUEST_BODY_MB ?? values.SUBLANE_MAX_REQUEST_BODY_MB}) + '\\n');
if (command === 'curl') {
  if (mode === 'download-failure') process.exit(22);
  if (args.some(value => value.endsWith('/readyz'))) {
    if (mode === 'unhealthy-binary') process.exit(22);
    process.stdout.write('{"status":"ready"}');
    process.exit(0);
  }
  const url = args.find(value => value.startsWith('https://'));
  const output = args[args.indexOf('--output') + 1];
  if (url.startsWith('https://api.github.com/')) {
    const api = JSON.parse(process.env.INSTALL_TEST_API);
    const latest = url.endsWith('/releases/latest');
    const status = latest ? (api.latestStatus ?? 404) : (api.listStatus ?? 200);
    const page = new URL(url).searchParams.get('page') ?? '1';
    const body = latest ? (api.latest ?? {message: 'Not Found'}) : (api.pages?.[page] ?? [
      {tag_name:'v0.1.0-rc.1',draft:false,prerelease:true,published_at:'2030-01-01T00:00:00Z'}
    ]);
    fs.writeFileSync(output, JSON.stringify(body));
    process.stdout.write(String(status));
    process.exit(0);
  }
  if (url.endsWith('.tar.gz')) fs.copyFileSync(process.env.INSTALL_TEST_ARCHIVE, output);
  else {
    const body = url.endsWith('/SHA256SUMS')
      ? (mode === 'bad-checksum' ? '0'.repeat(64) : ${JSON.stringify(checksum)}) + '  docker.compose.yaml\\n'
        + (mode === 'bad-checksum' || mode === 'bad-binary-checksum' ? '0'.repeat(64) : process.env.INSTALL_TEST_ARCHIVE_CHECKSUM)
        + '  ' + process.env.INSTALL_TEST_ARCHIVE_NAME + '\\n' + (mode === 'bad-helper-checksum' ? ${JSON.stringify(helperChecksums)}.replace(/^[a-f0-9]{64}/,'0'.repeat(64)) : ${JSON.stringify(helperChecksums)})
      : ${JSON.stringify(helpers)}[url.split('/').at(-1)] ?? ${JSON.stringify(deployment)};
    fs.writeFileSync(output, body);
  }
} else if (command === 'docker') {
  if (args[0] === 'info' && mode === 'no-engine') process.exit(1);
  if (args.includes('config') && mode === 'compose-failure') process.exit(1);
  if (args.includes('config') && args.includes('--images'))
    process.stdout.write((mode === 'ignored-image' ? 'example.test/unrelated:old' : (process.env.SUBLANE_IMAGE ?? values.SUBLANE_IMAGE)) + '\\n');
  if (args.includes('pull') && mode === 'pull-failure') process.exit(1);
  if (args.includes('up') && mode === 'unhealthy') process.exit(1);
} else if (command === 'uname') {
  process.stdout.write(args[0] === '-s' ? 'Linux\\n' : 'x86_64\\n');
} else if (command === 'systemctl') {
  if (args.includes('restart') && mode === 'restart-failure') process.exit(1);
  if (mode === 'systemd-failure' && args.includes('enable')) process.exit(1);
  if (mode === 'inactive-binary' && args.includes('is-active')) process.exit(1);
} else if (command === 'ss' || command === 'lsof') {
  if (mode === 'port-check-failure') {
    process.stderr.write('Synthetic socket inspection failure\\n');
    process.exit(1);
  }
  process.stdout.write(process.env.INSTALL_TEST_LISTENERS);
  if (command === 'lsof' && !process.env.INSTALL_TEST_LISTENERS) process.exit(1);
}
`;
  for (const name of ["curl", "docker", "uname", "systemctl", "ss", "lsof"])
    writeFileSync(join(bin, name), mock, { mode: 0o755 });
  const shellEnv = join(root, "shell.env");
  writeFileSync(shellEnv, `command() {
  if [[ $1 == -v && ( $2 == ss || $2 == lsof ) && $2 != ${portTool} ]]; then return 1; fi
  builtin command "$@"
}
`);
  const log = join(root, "commands.jsonl");
  return {
    root,
    target: join(root, "sublane"),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      BASH_ENV: shellEnv,
      INSTALL_TEST_LOG: log,
      INSTALL_TEST_MODE: mode,
      INSTALL_TEST_LISTENERS: "",
      INSTALL_TEST_API: JSON.stringify(api),
      INSTALL_TEST_ARCHIVE: archivePath,
      INSTALL_TEST_ARCHIVE_CHECKSUM: archiveChecksum,
      INSTALL_TEST_ARCHIVE_NAME: archiveName,
    },
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse)
        : [],
  };
}

function install(f, args = [], piped = false) {
  return spawnSync("bash", piped ? ["-s", "--", ...args] : [script, ...args], {
    cwd: f.root,
    env: f.env,
    input: piped ? readFileSync(script) : undefined,
    encoding: "utf8",
    timeout: 15000,
  });
}

function existing(t, runtime = "docker", mode = "", directory = "sublane") {
  const f = fixture(t, mode, {
    latestStatus: 200,
    latest: { tag_name: "v1.2.3", draft: false, prerelease: false },
  });
  f.target = join(f.root, directory);
  mkdirSync(f.target);
  mkdirSync(join(f.target, "data"));
  writeFileSync(join(f.target, "data", "sublane.db"), "Synthetic database bytes\n");
  writeFileSync(join(f.target, "data", "credentials.key"), "Synthetic encryption key\n");
  writeFileSync(join(f.target, "Caddyfile"), "gateway.example.test {\n    reverse_proxy 127.0.0.1:18080\n}\n");
  f.unit = "sublane-synthetic.service";
  f.settings = runtime === "docker" ? ".env" : "sublane.env";
  if (runtime === "docker") {
    writeFileSync(join(f.target, ".env"), [
      "# Operator settings",
      "COMPOSE_PROJECT_NAME=sublane-synthetic",
      "SUBLANE_IMAGE=ghcr.io/murongg/sublane:1.2.2",
      "SUBLANE_BIND_ADDRESS=127.0.0.1",
      "SUBLANE_PORT=18080",
      "SUBLANE_PUBLIC_URL=https://gateway.example.test",
      "SUBLANE_TRUSTED_PROXIES=192.0.2.0/24",
      "SUBLANE_LOG_LEVEL=warn",
      "SUBLANE_DEMO=true",
      "SUBLANE_MAX_REQUEST_BODY_MB=256",
      "CUSTOM_SETTING=keep",
      "",
    ].join("\n"));
    writeFileSync(join(f.target, "docker.compose.yaml"), compose + "# Operator customization\n");
  } else {
    writeFileSync(join(f.target, "sublane"), "#!/bin/sh\nprintf 'Synthetic old binary'\n", { mode: 0o755 });
    writeFileSync(join(f.target, "LICENSE"), "Synthetic old license\n");
    writeFileSync(join(f.target, "sublane.env"), [
      "SUBLANE_ADDR=127.0.0.1:18080",
      "SUBLANE_DATA_DIR=" + join(f.target, "data").replaceAll(" ", "\\ "),
      "SUBLANE_PUBLIC_URL=https://gateway.example.test",
      "SUBLANE_TRUSTED_PROXIES=127.0.0.1/32",
      "SUBLANE_LOG_LEVEL=warn",
      "SUBLANE_DEMO=true",
      "SUBLANE_MAX_REQUEST_BODY_MB=256",
      "",
    ].join("\n"));
    writeFileSync(join(f.target, "start.sh"), "#!/usr/bin/env bash\nset -a\n. \"$(dirname \"$0\")/sublane.env\"\nexec \"$(dirname \"$0\")/sublane\"\n", { mode: 0o700 });
    writeFileSync(join(f.target, f.unit), '[Service]\nExecStart=/bin/bash "' + join(f.target, "start.sh") + '"\n');
  }
  f.snapshot = Object.fromEntries(readdirSync(f.target).filter(name => name !== "data")
    .map(name => [name, readFileSync(join(f.target, name), "utf8")]));
  return f;
}

function backups(f) {
  return readdirSync(f.target).filter(name => name.startsWith(".update-backup."))
    .map(name => join(f.target, name));
}

function assertDataPreserved(f) {
  assert.equal(readFileSync(join(f.target, "data", "sublane.db"), "utf8"), "Synthetic database bytes\n");
  assert.equal(readFileSync(join(f.target, "data", "credentials.key"), "utf8"), "Synthetic encryption key\n");
  assert.equal(readFileSync(join(f.target, "Caddyfile"), "utf8"), f.snapshot.Caddyfile);
  assert.equal(existsSync(join(f.target, ".update-lock")), false);
}

for(const runtime of ["docker","binary"]){
  test(runtime+" web updates install a verified host worker and a mailbox without exposing the Docker socket",t=>{
    const f=existing(t,runtime,"","synthetic gateway");
    writeFileSync(join(f.target,f.settings),f.snapshot[f.settings].replace("SUBLANE_DEMO=true","SUBLANE_DEMO=false"));
    const result=install(f,["--update","--enable-updates","--dir",f.target,"--non-interactive"]);
    assert.equal(result.status,0,result.stderr);
    const privateDir=join(f.target,".updater");
    assert.equal(readFileSync(join(privateDir,"install.sh"),"utf8"),helpers["install.sh"]);
    assert.equal(readFileSync(join(privateDir,"updater.sh"),"utf8"),helpers["updater.sh"]);
    assert.equal(statSync(privateDir).mode&0o777,0o700);
    assert.equal(statSync(join(privateDir,"mailbox")).mode&0o777,0o777);
    const unit=readFileSync(join(privateDir,"updater-sublane-synthetic.service"),"utf8");
    assert.match(unit,/Restart=on-failure/);
    assert.ok(unit.includes(`"${realpathSync(privateDir)}/updater.sh" --run "${realpathSync(f.target)}"`));
    assert.ok(f.calls().some(call=>call.command==="systemctl"&&call.args.includes("enable")&&call.args.includes("updater-sublane-synthetic.service")));
    if(runtime==="docker"){
      const overlay=readFileSync(join(privateDir,"compose.yaml"),"utf8");
      assert.match(overlay,/SUBLANE_UPDATE_DIR: \/run\/sublane-updates/);
      assert.ok(overlay.includes(JSON.stringify(join(realpathSync(f.target),".updater","mailbox"))));
      assert.equal(overlay.includes("docker.sock"),false);
      assert.ok(f.calls().some(call=>call.command==="docker"&&call.args.includes(join(realpathSync(privateDir),"compose.yaml"))&&call.args.includes("up")));
    }else assert.match(readFileSync(join(f.target,"sublane.env"),"utf8"),/SUBLANE_UPDATE_DIR=.*\.updater\/mailbox/);
    assertDataPreserved(f);
  });
}

test("web update setup rejects unsafe worker paths and corrupt helpers before replacing files",t=>{
  for(const mode of ["symlink","bad-helper-checksum"]){
    const f=existing(t,"docker",mode==="symlink"?"":mode);
    writeFileSync(join(f.target,f.settings),f.snapshot[f.settings].replace("SUBLANE_DEMO=true","SUBLANE_DEMO=false"));
    const saved=readFileSync(join(f.target,f.settings),"utf8");
    if(mode==="symlink")symlinkSync(f.root,join(f.target,".updater"));
    const result=install(f,["--update","--enable-updates","--non-interactive"]);
    assert.notEqual(result.status,0);
    assert.equal(readFileSync(join(f.target,f.settings),"utf8"),saved);
    assert.equal(f.calls().some(call=>call.command==="docker"&&call.args.includes("up")),false);
  }
});

test("Docker updates reject customized or symlinked host-worker overlays",t=>{
  for(const link of [false,true]){
    const f=existing(t);const privateDir=join(f.target,".updater");mkdirSync(privateDir);
    if(link)symlinkSync(join(f.target,"docker.compose.yaml"),join(privateDir,"compose.yaml"));
    else writeFileSync(join(privateDir,"compose.yaml"),"services:\n  sublane:\n    volumes: [./another-data:/data]\n");
    const result=install(f,["--update","--version","1.2.3","--non-interactive"]);
    assert.notEqual(result.status,0);
    assert.equal(readFileSync(join(f.target,".env"),"utf8"),f.snapshot[".env"]);
    assert.equal(f.calls().some(call=>call.command==="docker"&&call.args.includes("up")),false);
  }
});

test("a new web-update installation canonicalizes parent symlinks and retains its generated overlay on later updates",t=>{
  const f=fixture(t);const actual=join(f.root,"actual");mkdirSync(actual);
  const alias=join(f.root,"alias");symlinkSync(actual,alias);
  const target=join(alias,"gateway");
  const result=install(f,["--version","1.2.3","--dir",target,"--runtime","docker","--enable-updates","--non-interactive"]);
  assert.equal(result.status,0,result.stderr);
  const overlay=readFileSync(join(target,".updater","compose.yaml"),"utf8");
  assert.ok(overlay.includes(JSON.stringify(realpathSync(join(target,".updater","mailbox")))));
  const update=install(f,["--update","--version","1.2.3","--dir",target,"--non-interactive"]);
  assert.equal(update.status,0,update.stderr);
});

test("enabling binary web updates replaces an empty or obsolete mailbox setting",t=>{
  const f=existing(t,"binary");
  writeFileSync(join(f.target,f.settings),f.snapshot[f.settings].replace("SUBLANE_DEMO=true","SUBLANE_DEMO=false")+"SUBLANE_UPDATE_DIR=\n");
  const result=install(f,["--update","--version","1.2.3","--enable-updates","--non-interactive"]);
  assert.equal(result.status,0,result.stderr);
  const settings=readFileSync(join(f.target,f.settings),"utf8");
  assert.equal(settings.split("\n").filter(line=>line.startsWith("SUBLANE_UPDATE_DIR=")).length,1);
  assert.ok(settings.includes("SUBLANE_UPDATE_DIR="+join(realpathSync(f.target),".updater","mailbox")));
});

test("updates an existing Docker deployment to the latest release while preserving its identity and settings", (t) => {
  const f = existing(t);
  Object.assign(f.env, {
    SUBLANE_IMAGE: "example.test/unrelated:image", SUBLANE_PORT: "9099",
    SUBLANE_LOG_LEVEL: "debug", SUBLANE_DEMO: "false", SUBLANE_MAX_REQUEST_BODY_MB: "1",
    COMPOSE_PROJECT_NAME: "unrelated-project", COMPOSE_FILE: "/unrelated.yaml",
  });
  f.env.INSTALL_TEST_LISTENERS = "LISTEN 0 128 127.0.0.1:18080 *:*\n";
  const result = install(f, ["--update", "--non-interactive"], true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Update complete/);
  assert.equal(readFileSync(join(f.target, ".env"), "utf8"),
    f.snapshot[".env"].replace("sublane:1.2.2", "sublane:1.2.3"));
  assert.equal(readFileSync(join(f.target, "docker.compose.yaml"), "utf8"), f.snapshot["docker.compose.yaml"]);
  assertDataPreserved(f);
  const calls = f.calls().filter(call => call.command === "docker" && call.args.includes("--project-name"));
  assert.ok(calls.some(call => call.args.includes("pull")));
  const up = calls.find(call => call.args.includes("up"));
  assert.ok(up.args.includes("--wait") && up.args.includes("--no-build"));
  for (const call of calls) {
    assert.equal(call.args[call.args.indexOf("--project-name") + 1], "sublane-synthetic");
    assert.equal(realpathSync(call.args[call.args.indexOf("--project-directory") + 1]), realpathSync(f.target));
    assert.equal(call.image, "ghcr.io/murongg/sublane:1.2.3");
    assert.equal(call.port, "18080");
    assert.equal(call.demo, "true");
    assert.equal(call.logLevel, "warn");
    assert.equal(call.maxBody, "256");
  }
  assert.equal(f.calls().some(call => ["ss", "lsof"].includes(call.command)), false);
  assert.equal(f.calls().some(call => call.args.includes("down") || call.args.includes("rm")), false);
  assert.equal(backups(f).length, 1);
  assert.equal(readFileSync(join(backups(f)[0], ".env"), "utf8"), f.snapshot[".env"]);
});

test("updates a binary deployment in a path with spaces and restarts its existing user service", (t) => {
  const f = existing(t, "binary", "", "team gateway");
  const result = install(f, ["--update", "--dir", f.target, "--version", "v1.2.3", "--wait-timeout", "1"], true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Update complete/);
  assert.equal(readFileSync(join(f.target, "sublane"), "utf8"), "#!/bin/sh\nexit 0\n");
  assert.equal(statSync(join(f.target, "sublane")).mode & 0o100, 0o100);
  assert.equal(readFileSync(join(f.target, "LICENSE"), "utf8"), "Synthetic license\n");
  for (const name of [f.settings, "start.sh", f.unit])
    assert.equal(readFileSync(join(f.target, name), "utf8"), f.snapshot[name]);
  assertDataPreserved(f);
  assert.ok(f.calls().some(call => call.command === "systemctl" && call.args.includes("restart") && call.args.includes(f.unit)));
  assert.ok(f.calls().some(call => call.command === "curl" && call.args.includes("http://127.0.0.1:18080/readyz")));
  assert.equal(f.calls().some(call => call.command === "docker" || call.args.includes("enable") || call.args.includes("disable")), false);
  assert.equal(backups(f).length, 1);
  assert.equal(readFileSync(join(backups(f)[0], "sublane"), "utf8"), f.snapshot.sublane);
});

for (const runtime of ["docker", "binary"]) {
  test(runtime + " update rejects failed downloads and corrupt artifacts without changing the deployment", (t) => {
    for (const mode of ["download-failure", "bad-checksum", "legacy-demo"]) {
      const f = existing(t, runtime, mode);
      const result = install(f, ["--update", "--version", "1.2.3"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Could not download|checksum mismatch|does not support demo mode/i);
      for (const [name, body] of Object.entries(f.snapshot))
        assert.equal(readFileSync(join(f.target, name), "utf8"), body, mode + ": " + name);
      assertDataPreserved(f);
      assert.equal(f.calls().some(call => call.args.includes("up") || call.args.includes("restart")), false);
      assert.equal(backups(f).length, 0);
    }
  });

  test(runtime + " update retains recovery files and data when the new service fails readiness", (t) => {
    const f = existing(t, runtime, runtime === "docker" ? "unhealthy" : "unhealthy-binary");
    const result = install(f, ["--update", "--version", "1.2.3", "--wait-timeout", "1"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ready|healthy/i);
    assert.match(result.stderr, /backup|previous/i);
    assert.doesNotMatch(result.stdout, /Update complete/);
    assertDataPreserved(f);
    assert.equal(backups(f).length, 1);
    const name = runtime === "docker" ? ".env" : "sublane";
    assert.equal(readFileSync(join(backups(f)[0], name), "utf8"), f.snapshot[name]);
    assert.equal(f.calls().some(call => call.args.includes("down") || call.args.includes("disable") || call.args.includes("rm")), false);
  });
}

test("Docker update config and pull failures leave the old image setting intact", (t) => {
  for (const mode of ["compose-failure", "pull-failure"]) {
    const f = existing(t, "docker", mode);
    const result = install(f, ["--update", "--version", "1.2.3"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /configuration is invalid|Image pull failed/i);
    assert.equal(readFileSync(join(f.target, ".env"), "utf8"), f.snapshot[".env"]);
    assertDataPreserved(f);
    assert.equal(f.calls().some(call => call.args.includes("up")), false);
  }
});

test("Docker update refuses a customized Compose file that ignores the selected image", (t) => {
  const f = existing(t, "docker", "ignored-image");
  const result = install(f, ["--update", "--version", "1.2.3"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /selected image/i);
  assert.equal(readFileSync(join(f.target, ".env"), "utf8"), f.snapshot[".env"]);
  assert.equal(f.calls().some(call => call.args.includes("pull") || call.args.includes("up")), false);
  assertDataPreserved(f);
});

test("update rejects malformed or duplicate saved settings and symlinked configuration", (t) => {
  for (const [name, setting] of [
    [".env", "COMPOSE_PROJECT_NAME=another-project\n"],
    [".env", "SUBLANE_PORT=9090\n"],
    [".env", "COMPOSE_FILE=first.yaml\nCOMPOSE_FILE=second.yaml\n"],
    [".env", "COMPOSE_FILE=docker.compose.restore.yaml\n"],
    [".env", "SUBLANE_IMAGE=example.test/image:old\n"],
  ]) {
    const f = existing(t);
    writeFileSync(join(f.target, name), f.snapshot[name] + setting);
    const settings = readFileSync(join(f.target, name), "utf8");
    const result = install(f, ["--update", "--version", "1.2.3"]);
    assert.notEqual(result.status, 0, setting);
    assert.match(result.stderr, /Duplicate|override/i);
    assert.equal(readFileSync(join(f.target, name), "utf8"), settings);
    assert.equal(f.calls().length, 0);
  }
  for (const runtime of ["docker", "binary"]) {
    const f = existing(t, runtime);
    const original = join(f.root, "original.env");
    writeFileSync(original, f.snapshot[f.settings]);
    rmSync(join(f.target, f.settings));
    symlinkSync(original, join(f.target, f.settings));
    const result = install(f, ["--update", "--version", "1.2.3"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlink/i);
    assert.equal(readFileSync(original, "utf8"), f.snapshot[f.settings]);
    assert.equal(f.calls().length, 0);
  }
});

test("binary update reports a restart failure and retains the previous executable", (t) => {
  const f = existing(t, "binary", "restart-failure");
  const result = install(f, ["--update", "--version", "1.2.3", "--wait-timeout", "1"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restart/i);
  assert.doesNotMatch(result.stdout, /Update complete/);
  assert.equal(backups(f).length, 1);
  assert.equal(readFileSync(join(backups(f)[0], "sublane"), "utf8"), f.snapshot.sublane);
  assertDataPreserved(f);
});

test("update refuses missing, unrecognized and symlinked installations before downloading", (t) => {
  for (const kind of ["missing", "unknown", "symlink"]) {
    const f = fixture(t);
    if (kind === "unknown") mkdirSync(f.target);
    if (kind === "symlink") {
      const original = join(f.root, "original");
      mkdirSync(original);
      symlinkSync(original, f.target);
    }
    const result = install(f, ["--update", "--version", "1.2.3"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /existing|installation|symlink/i);
    assert.equal(f.calls().length, 0);
  }
});

test("update rejects installation options and an existing update lock without changing files", (t) => {
  for (const args of [
    ["--port", "9090"], ["--runtime", "binary"], ["--demo"],
    ["--proxy", "caddy"], ["--domain", "other.example.test"], ["--trusted-proxies", "127.0.0.1/32"],
  ]) {
    const f = existing(t);
    const result = install(f, ["--update", "--version", "1.2.3", ...args]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /update.*(option|setting)|installation.*option/i);
    assert.equal(f.calls().length, 0);
    assertDataPreserved(f);
  }
  const f = existing(t);
  mkdirSync(join(f.target, ".update-lock"));
  const result = install(f, ["--update", "--version", "1.2.3"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /update.*(progress|lock)/i);
  assert.equal(existsSync(join(f.target, ".update-lock")), true);
  assert.equal(f.calls().length, 0);
});

test("update refuses a symlinked installation even when its path has a trailing slash", (t) => {
  const f = existing(t, "docker", "", "original");
  const original = f.target;
  f.target = join(f.root, "linked");
  symlinkSync(original, f.target);
  const result = install(f, ["--update", "--dir", f.target + "/", "--version", "1.2.3"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink/i);
  assert.equal(readFileSync(join(original, ".env"), "utf8"), f.snapshot[".env"]);
  assert.equal(f.calls().length, 0);
});

test("Docker update refuses a saved recovery override instead of starting the original data path", (t) => {
  const f = existing(t);
  writeFileSync(join(f.target, "docker.compose.restore.yaml"), "services:\n  sublane:\n    environment:\n      SUBLANE_DATA_DIR: /data/restore-ready\n");
  const result = install(f, ["--update", "--version", "1.2.3"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /override|manual upgrade/i);
  assert.equal(readFileSync(join(f.target, ".env"), "utf8"), f.snapshot[".env"]);
  assert.equal(f.calls().length, 0);
  assertDataPreserved(f);
});

test("piped interactive script offers to update an existing installation and confirms before replacing files", (t) => {
  const f = existing(t);
  const interaction = terminal(f, readFileSync(script, "utf8"), [
    { wait: "Update existing instance", send: "\n", raw: true },
    { wait: "Proceed with this update?", send: "y\n" },
  ], ["--version", "1.2.3"]);
  assert.equal(interaction.status, 0, interaction.output);
  assert.equal(interaction.restored, true);
  assert.doesNotMatch(interaction.output, /Linux binary|Read-only demo|Reverse proxy/);
  assert.match(interaction.output, /Update complete/);
  assertDataPreserved(f);
});

test("canceling an interactive update leaves the existing installation untouched", (t) => {
  const f = existing(t);
  const interaction = terminal(f, readFileSync(script, "utf8"), [
    { wait: "Proceed with this update?", send: "n\n" },
  ], ["--update", "--version", "1.2.3"]);
  assert.notEqual(interaction.status, 0);
  assert.equal(interaction.restored, true);
  assert.match(interaction.output, /Update canceled before deployment/);
  assert.equal(readFileSync(join(f.target, ".env"), "utf8"), f.snapshot[".env"]);
  assert.equal(f.calls().some(call => call.args.includes("pull") || call.args.includes("up")), false);
  assert.equal(backups(f).length, 0);
  assertDataPreserved(f);
});

function terminal(f, source, steps, args = [], term = "xterm") {
  const harness = fileURLToPath(new URL("./install-pty.py", import.meta.url));
  const env = { ...f.env, TERM: term };
  delete env.NO_COLOR;
  const result = spawnSync("python3", [harness], {
    cwd: f.root,
    env,
    input: JSON.stringify({ source, steps, args }),
    encoding: "utf8",
    timeout: 12000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const interaction = JSON.parse(result.stdout);
  assert.equal(interaction.error, null, interaction.output || interaction.error);
  return interaction;
}

function selectionSource() {
  return readFileSync(script, "utf8").replace(/\nmain "\$@"\s*$/, `
selection=$(prompt_select 'Instance mode' 'Normal instance' 'Read-only demo')
printf '\\nSelected: %s\\n' "$selection"
`);
}

for (const [name, keys, expected] of [
  ["default", "\n", "1"],
  ["down arrow", "\x1b[B\n", "2"],
  ["up arrow wraparound", "\x1b[A\n", "2"],
  ["down then up", "\x1b[B\x1b[A\n", "1"],
  ["application arrow keys", "\x1bOB\n", "2"],
  ["number shortcut", "2\n", "2"],
  ["invalid shortcut", "9\n", "1"],
]) {
  test(`terminal selector accepts ${name} and restores the terminal`, (t) => {
    const f = fixture(t);
    const interaction = terminal(f, selectionSource(), [{ wait: "Read-only demo", send: keys, raw: true }]);
    assert.equal(interaction.status, 0, interaction.output);
    assert.match(interaction.output, new RegExp(`Selected: ${expected}`));
    assert.match(interaction.output, /\x1b\[7m/);
    assert.match(interaction.output, /\x1b\[\?25h/);
    assert.equal(interaction.restored, true, `${interaction.output}\n${JSON.stringify(interaction.changes)}`);
  });
}

for (const [name, keys] of [["Ctrl+C", "\x03"], ["Escape", "\x1b"], ["Ctrl+D", "\x04"]]) {
  test(`terminal selector cancels on ${name} and restores the terminal`, (t) => {
    const f = fixture(t);
    const interaction = terminal(f, selectionSource(), [{ wait: "Read-only demo", send: keys, raw: true }]);
    assert.notEqual(interaction.status, 0);
    assert.doesNotMatch(interaction.output, /Selected:/);
    assert.match(interaction.output, /\x1b\[\?25h/);
    assert.equal(interaction.restored, true, `${interaction.output}\n${JSON.stringify(interaction.changes)}`);
  });
}

test("terminal selector falls back to a validated numbered prompt for TERM=dumb", (t) => {
  const f = fixture(t);
  const interaction = terminal(f, selectionSource(), [
    { wait: "(default 1):", send: "9\n" },
    { wait: "Choose a number from 1 to 2", send: "2\n" },
  ], [], "dumb");
  assert.equal(interaction.status, 0, interaction.output);
  assert.match(interaction.output, /Selected: 2/);
  assert.doesNotMatch(interaction.output, /\x1b/);
  assert.equal(interaction.restored, true);
});

test("piped installer uses terminal selectors for runtime, mode and proxy", (t) => {
  const f = fixture(t);
  const interaction = terminal(f, readFileSync(script, "utf8"), [
    { wait: "Linux binary", send: "\n", raw: true },
    { wait: "Read-only demo", send: "\x1b[B\n", raw: true },
    { wait: "Nginx", send: "\x1b[B\n", raw: true },
    { wait: "Public HTTPS domain", send: "gateway.example.test\n" },
    { wait: "Proceed with this installation?", send: "y\n" },
  ], ["--version", "1.2.3"]);
  assert.equal(interaction.status, 0, interaction.output);
  assert.equal(interaction.restored, true);
  const settings = readFileSync(join(f.target, ".env"), "utf8");
  assert.match(settings, /^SUBLANE_DEMO=true$/m);
  assert.match(settings, /^SUBLANE_PUBLIC_URL=https:\/\/gateway\.example\.test$/m);
  assert.ok(existsSync(join(f.target, "Caddyfile")));
});

test("piped installer skips terminal selectors for explicitly supplied choices", (t) => {
  const f = fixture(t);
  const interaction = terminal(f, readFileSync(script, "utf8"), [], [
    "--version", "1.2.3", "--runtime", "docker", "--demo", "--proxy", "none",
  ]);
  assert.equal(interaction.status, 0, interaction.output);
  assert.doesNotMatch(interaction.output, /Use.*Enter/);
  assert.equal(interaction.restored, true);
  assert.ok(existsSync(join(f.target, ".env")));
});

test("non-interactive installer skips selectors even with a controlling terminal", (t) => {
  const f = fixture(t);
  const interaction = terminal(f, readFileSync(script, "utf8"), [], [
    "--version", "1.2.3", "--non-interactive",
  ]);
  assert.equal(interaction.status, 0, interaction.output);
  assert.doesNotMatch(interaction.output, /Use.*Enter/);
  assert.equal(interaction.restored, true);
  assert.match(readFileSync(join(f.target, ".env"), "utf8"), /^SUBLANE_DEMO=false$/m);
});

test("canceling a terminal selector stops installation before downloads or deployment", (t) => {
  const f = fixture(t);
  const interaction = terminal(f, readFileSync(script, "utf8"), [
    { wait: "Linux binary", send: "\x03", raw: true },
  ], ["--version", "1.2.3"]);
  assert.notEqual(interaction.status, 0);
  assert.equal(interaction.restored, true, `${interaction.output}\n${JSON.stringify(interaction.changes)}`);
  assert.equal(existsSync(f.target), false);
  assert.equal(f.calls().length, 0);
});

for (const runtime of ["docker", "binary"]) {
  test(`rejects an occupied ${runtime} port before downloading or starting services`, (t) => {
    const f = fixture(t);
    f.env.INSTALL_TEST_LISTENERS = "LISTEN 0 128 127.0.0.1:18080 0.0.0.0:*\n";
    const result = install(f, ["--version", "1.2.3", "--runtime", runtime, "--port", "18080"], true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /127\.0\.0\.1:18080.*already in use/i);
    assert.match(result.stderr, /--port/);
    assert.equal(existsSync(f.target), false);
    assert.ok(f.calls().every(call => call.command === "ss"));
  });
}

for (const [tool, addresses] of [
  ["ss", ["0.0.0.0:8080", "*:8080", "[::]:8080", "[::ffff:127.0.0.1]:8080"]],
  ["lsof", ["127.0.0.1:8080", "*:8080", "[::ffff:127.0.0.1]:8080"]],
]) {
  test(`detects loopback and wildcard port conflicts with ${tool}`, (t) => {
    for (const address of addresses) {
      const f = fixture(t, "", {}, tool);
      f.env.INSTALL_TEST_LISTENERS = tool === "ss"
        ? `LISTEN 0 128 ${address} *:*\n`
        : `p123\nf3\nn${address}\n`;
      const result = install(f, ["--version", "1.2.3"]);
      assert.notEqual(result.status, 0, address);
      assert.match(result.stderr, /127\.0\.0\.1:8080.*already in use/i);
      assert.equal(existsSync(f.target), false);
      assert.ok(f.calls().every(call => call.command === tool));
    }
  });

  test(`allows unrelated interfaces and proxy ports with ${tool}`, (t) => {
    const f = fixture(t, "", {}, tool);
    f.env.INSTALL_TEST_LISTENERS = tool === "ss"
      ? "LISTEN 0 128 127.0.0.2:8080 *:*\nLISTEN 0 128 [::1]:8080 *:*\nLISTEN 0 128 *:80 *:*\nLISTEN 0 128 *:443 *:*\nLISTEN 0 128 *:18080 *:*\n"
      : "p123\nf3\nn127.0.0.2:8080\nf4\nn[::1]:8080\nf5\nn*:80\nf6\nn*:443\nf7\nn*:18080\n";
    const result = install(f, ["--version", "1.2.3", "--proxy", "nginx"]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(f.calls().some(call => call.command === tool));
  });

  test(`stops when ${tool} cannot inspect the port`, (t) => {
    const f = fixture(t, "port-check-failure", {}, tool);
    const result = install(f, ["--version", "1.2.3"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Could not check.*127\.0\.0\.1:8080/i);
    assert.equal(existsSync(f.target), false);
    assert.ok(f.calls().every(call => call.command === tool));
  });

  test(`accepts an unused port with ${tool}`, (t) => {
    const f = fixture(t, "", {}, tool);
    const result = install(f, ["--version", "1.2.3", "--port", "18851"]);
    assert.equal(result.status, 0, result.stderr);
    const check = f.calls().find(call => call.command === tool);
    assert.ok(check);
    assert.ok(check.args.some(arg => arg.includes("18851")));
  });
}

test("explains how to enable port inspection when neither utility is installed", (t) => {
  const f = fixture(t, "", {}, "none");
  const result = install(f, ["--version", "1.2.3"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Install.*ss.*lsof/i);
  assert.equal(existsSync(f.target), false);
  assert.equal(f.calls().length, 0);
});

for (const runtime of ["docker", "binary"]) {
  test(`persists demo mode in a ${runtime} installation`, (t) => {
    const f = fixture(t);
    f.env.SUBLANE_DEMO = "false";
    const result = install(f, ["--version", "1.2.3", "--runtime", runtime, "--demo", "--non-interactive"], true);
    assert.equal(result.status, 0, result.stderr);
    const settings = readFileSync(join(f.target, runtime === "docker" ? ".env" : "sublane.env"), "utf8");
    assert.match(settings, /^SUBLANE_DEMO=true$/m);
    assert.match(result.stdout, /demo.*sublane-demo/i);
    assert.doesNotMatch(result.stdout, /to create the administrator/);
    if (runtime === "docker") {
      const calls = f.calls().filter(call => call.args.includes("--project-name"));
      assert.ok(calls.length >= 3);
      assert.ok(calls.every(call => call.demo === "true"));
    } else {
      writeFileSync(join(f.target, "sublane"), '#!/bin/sh\nprintf "%s" "$SUBLANE_DEMO"\n', { mode: 0o755 });
      const launch = spawnSync("bash", [join(f.target, "start.sh")], { env: f.env, encoding: "utf8" });
      assert.equal(launch.status, 0, launch.stderr);
      assert.equal(launch.stdout, "true");
    }
  });

  test(`normal ${runtime} installation ignores inherited demo interpolation`, (t) => {
    const f = fixture(t);
    f.env.SUBLANE_DEMO = "true";
    const result = install(f, ["--version", "1.2.3", "--runtime", runtime, "--non-interactive"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(f.target, runtime === "docker" ? ".env" : "sublane.env"), "utf8"), /^SUBLANE_DEMO=false$/m);
    if (runtime === "docker")
      assert.ok(f.calls().filter(call => call.args.includes("--project-name")).every(call => call.demo === "false"));
  });

  test(`rejects ${runtime} releases without demo support before deployment`, (t) => {
    const f = fixture(t, "legacy-demo");
    const result = install(f, ["--version", "1.2.3", "--runtime", runtime, "--demo", "--non-interactive"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not support demo mode/i);
    assert.equal(existsSync(f.target), false);
    assert.equal(f.calls().some(call => call.args.includes("up") || call.args.includes("pull") || call.args.includes("enable") || call.args.includes("link")), false);
    const normal = install(f, ["--version", "1.2.3", "--runtime", runtime, "--non-interactive"]);
    assert.equal(normal.status, 0, normal.stderr);
  });
}

for (const [choice, demo] of [["", "false"], ["1", "false"], ["2", "true"]]) {
  test(`interactive installation selects ${demo === "true" ? "demo" : "normal"} mode from choice '${choice}'`, (t) => {
    const f = fixture(t);
    const source = readFileSync(script, "utf8").replace(/\nmain "\$@"\s*$/, `
prompt_available() { return 0; }
prompt_select() {
  case "$1" in
    'Instance mode'*) printf '${choice}' ;;
    *) printf 'Unexpected selector: %s' "$1" >&2; return 1 ;;
  esac
}
prompt_choice() {
  case "$1" in
    'Proceed with this installation'*) printf 'y' ;;
    *) printf 'Unexpected prompt: %s' "$1" >&2; return 1 ;;
  esac
}
main "$@"
`);
    const result = spawnSync("bash", ["-s", "--", "--version", "1.2.3", "--runtime", "docker", "--proxy", "none"], {
      cwd: f.root, env: f.env, input: source, encoding: "utf8", timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(readFileSync(join(f.target, ".env"), "utf8").split("\n").includes(`SUBLANE_DEMO=${demo}`));
  });
}

test("installs a pinned release with checksums and waits for healthy Compose startup", (t) => {
  const f = fixture(t);
  const result = install(f);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    readFileSync(join(f.target, ".env"), "utf8"),
    /SUBLANE_IMAGE=ghcr.io\/murongg\/sublane:0\.1\.0-rc\.1/,
  );
  assert.equal(
    readFileSync(join(f.target, "docker.compose.yaml"), "utf8"),
    compose,
  );
  assert.equal(statSync(join(f.target, ".env")).mode & 0o777, 0o600);
  const calls = f.calls();
  assert.equal(calls.filter((call) => call.command === "curl").length, 4);
  const up = calls.find((call) => call.args.includes("up"));
  assert.ok(up.args.includes("--wait"));
  assert.ok(up.args.includes("--no-build"));
  assert.ok(up.args.includes("--project-name"));
  assert.ok(
    calls.findIndex((call) => call.args.includes("pull")) < calls.indexOf(up),
  );
  assert.match(result.stdout, /http:\/\/127\.0\.0\.1:8080/);
});

test("supports piped execution, explicit versions, paths with spaces and custom ports", (t) => {
  const f = fixture(t);
  const target = join(f.root, "team gateway");
  const result = install(
    f,
    ["--version", "v1.2.3-beta.2", "--dir", target, "--port", "18851"],
    true,
  );
  assert.equal(result.status, 0, result.stderr);
  const env = readFileSync(join(target, ".env"), "utf8");
  assert.match(env, /SUBLANE_IMAGE=ghcr.io\/murongg\/sublane:1\.2\.3-beta\.2/);
  assert.match(env, /SUBLANE_PORT=18851/);
  assert.match(env, /COMPOSE_PROJECT_NAME=sublane-[a-z0-9-]+/);
  assert.match(result.stdout, /127\.0\.0\.1:18851/);
  assert.equal(
    f
      .calls()
      .some((call) =>
        call.args.some((arg) => arg.startsWith("https://api.github.com/")),
      ),
    false,
  );
});

test("generates a Caddy configuration and external origin for a Docker install", (t) => {
  const f = fixture(t);
  const result = install(f, [
    "--version", "1.2.3", "--runtime", "docker", "--proxy", "caddy",
    "--domain", "gateway.example.test", "--port", "18080",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const env = readFileSync(join(f.target, ".env"), "utf8");
  assert.match(env, /^SUBLANE_PUBLIC_URL=https:\/\/gateway\.example\.test$/m);
  assert.match(readFileSync(join(f.target, "Caddyfile"), "utf8"), /reverse_proxy 127\.0\.0\.1:18080/);
  assert.equal(existsSync(join(f.target, "nginx.conf")), false);
});

test("generates an Nginx configuration with forwarding and streaming headers", (t) => {
  const f = fixture(t);
  const result = install(f, [
    "--version", "1.2.3", "--runtime", "docker", "--proxy", "nginx",
    "--domain", "gateway.example.test",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const config = readFileSync(join(f.target, "nginx.conf"), "utf8");
  assert.match(config, /server_name gateway\.example\.test;/);
  assert.match(config, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
  assert.match(config, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(config, /proxy_buffering off;/);
  assert.match(config, /proxy_pass http:\/\/127\.0\.0\.1:8080;/);
});

test("allows Caddy and Nginx without a domain using local HTTP only", (t) => {
  for (const proxy of ["caddy", "nginx"]) {
    const f = fixture(t);
    const result = install(f, ["--version", "1.2.3", "--proxy", proxy]);
    assert.equal(result.status, 0, result.stderr);
    const env = readFileSync(join(f.target, ".env"), "utf8");
    assert.match(env, /^SUBLANE_PUBLIC_URL=$/m);
    const config = readFileSync(join(f.target, proxy === "caddy" ? "Caddyfile" : "nginx.conf"), "utf8");
    assert.match(config, /127\.0\.0\.1:80/);
    assert.doesNotMatch(config, /listen 443|https:\/\/gateway/);
  }
});

test("installs a verified binary and enables its systemd user service without Docker", (t) => {
  const f = fixture(t);
  const result = install(f, [
    "--version", "1.2.3", "--runtime", "binary", "--proxy", "caddy",
    "--domain", "gateway.example.test",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(f.target, "sublane")), true);
  assert.equal(existsSync(join(f.target, "start.sh")), true);
  assert.match(readFileSync(join(f.target, "sublane.env"), "utf8"), /SUBLANE_TRUSTED_PROXIES=127\.0\.0\.1\/32/);
  assert.match(readFileSync(join(f.target, "Caddyfile"), "utf8"), /reverse_proxy 127\.0\.0\.1:8080/);
  assert.ok(f.calls().some(call => call.command === "systemctl" && call.args.includes("enable") && call.args.includes("--now")));
  assert.equal(f.calls().some(call => call.command === "docker"), false);
});

test("binary service unit quotes an installation path with spaces", (t) => {
  const f = fixture(t);
  const target = join(f.root, "team gateway");
  const result = install(f, ["--version", "1.2.3", "--runtime", "binary", "--dir", target]);
  assert.equal(result.status, 0, result.stderr);
  const unitName = f.calls().find(call => call.command === "systemctl" && call.args.includes("link"))?.args.at(-1);
  assert.ok(unitName);
  const unit = readFileSync(unitName, "utf8");
  assert.match(unit, /ExecStart=\/bin\/bash "[^"]*team gateway\/start\.sh"/);
});

test("a systemd activation failure retains verified binary files for inspection", (t) => {
  const f = fixture(t, "systemd-failure");
  const result = install(f, ["--version", "1.2.3", "--runtime", "binary"]);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(f.target, "sublane")), true);
  assert.match(result.stderr, /retained|preserved/i);
});

test("a corrupt binary archive is rejected before systemd is changed", (t) => {
  const f = fixture(t, "bad-binary-checksum");
  const result = install(f, ["--version", "1.2.3", "--runtime", "binary"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum mismatch/);
  assert.equal(existsSync(f.target), false);
  assert.equal(f.calls().some(call => call.command === "systemctl" && call.args.includes("link")), false);
});

test("a binary service that never becomes ready retains its files and reports failure", (t) => {
  const f = fixture(t, "unhealthy-binary");
  const result = install(f, [
    "--version", "1.2.3", "--runtime", "binary", "--wait-timeout", "1",
  ]);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(f.target, "sublane")), true);
  assert.match(result.stderr, /ready|healthy/i);
  assert.ok(f.calls().some(call => call.command === "systemctl" && call.args.includes("disable") && call.args.includes("--now")));
});

test("binary readiness cannot be satisfied by another process on the port", (t) => {
  const f = fixture(t, "inactive-binary");
  const result = install(f, ["--version", "1.2.3", "--runtime", "binary", "--wait-timeout", "1"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /service|ready/i);
});

test("rejects invalid arguments before downloading or starting containers", (t) => {
  for (const args of [
    ["--version", "1.2.3;touch unexpected"],
    ["--version", "1.2"],
    ["--version", "v"],
    ["--version", "01.2.3"],
    ["--version", "1.2.3-rc.01"],
    ["--port", "0"],
    ["--port", "65536"],
    ["--port", "8080\nOTHER=value"],
    ["--dir", "line\nbreak"],
    ["--proxy", "caddy", "--domain", "gateway..example.test"],
    ["--proxy", "nginx", "--domain", "gateway.example.test."],
    ["--proxy", "caddy", "--trusted-proxies", "127.0.0.1"],
    ["--version"],
    ["--force"],
  ]) {
    const f = fixture(t);
    const result = install(f, args);
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(result.stderr, /Error:/);
    assert.equal(f.calls().length, 0);
    assert.equal(existsSync(f.target), false);
  }
});

test("preserves existing installations and refuses symlinks", (t) => {
  for (const symlink of [false, true]) {
    const f = fixture(t);
    const original = symlink ? join(f.root, "original") : f.target;
    mkdirSync(original);
    writeFileSync(join(original, ".env"), "SYNTHETIC_SETTING=keep\n");
    if (symlink) symlinkSync(original, f.target);
    const result = install(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exists/i);
    assert.equal(
      readFileSync(join(original, ".env"), "utf8"),
      "SYNTHETIC_SETTING=keep\n",
    );
    assert.equal(f.calls().length, 0);
  }
});

test("download, checksum, engine and pull failures leave no installation", (t) => {
  for (const [mode, message] of [
    ["download-failure", /Could not (download|fetch)/],
    ["bad-checksum", /checksum mismatch/],
    ["no-engine", /Docker is not running/],
    ["pull-failure", /Image pull failed/],
  ]) {
    const f = fixture(t, mode);
    const result = install(f);
    assert.notEqual(result.status, 0, mode);
    assert.match(result.stderr, message);
    assert.equal(existsSync(f.target), false, mode);
    assert.equal(
      f.calls().some((call) => call.args.includes("up")),
      false,
    );
  }
});

test("a startup failure retains configuration and never removes container data", (t) => {
  const f = fixture(t, "unhealthy");
  const result = install(f);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(f.target, ".env")), true);
  assert.match(result.stderr, /retained|preserved/i);
  assert.equal(
    f
      .calls()
      .some((call) => call.args.includes("down") || call.args.includes("rm")),
    false,
  );
  assert.doesNotMatch(result.stdout, /Installation complete/);
});

test("explicit installer settings take precedence over inherited Compose interpolation", (t) => {
  const f = fixture(t);
  Object.assign(f.env, {
    SUBLANE_IMAGE: "example.test/unrelated:image",
    SUBLANE_PORT: "9099",
    COMPOSE_PROJECT_NAME: "existing-synthetic-project",
    COMPOSE_FILE: "/synthetic/unrelated.yaml",
  });
  const result = install(f);
  assert.equal(result.status, 0, result.stderr);
  const calls = f
    .calls()
    .filter((call) => call.args.includes("--project-name"));
  assert.ok(calls.length >= 3);
  for (const call of calls) {
    assert.equal(call.image, "ghcr.io/murongg/sublane:0.1.0-rc.1");
    assert.equal(call.port, "8080");
    assert.notEqual(
      call.args[call.args.indexOf("--project-name") + 1],
      "existing-synthetic-project",
    );
    assert.ok(call.args.includes("--env-file"));
    assert.ok(call.args.includes("-f"));
  }
});

test("help performs no deployment actions", (t) => {
  const f = fixture(t);
  const result = install(f, ["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--version/);
  assert.equal(f.calls().length, 0);
  assert.equal(existsSync(f.target), false);
});

test("a truncated piped download does not begin installation", (t) => {
  const f = fixture(t);
  const source = readFileSync(script, "utf8");
  const result = spawnSync("bash", ["-s"], {
    cwd: f.root,
    env: f.env,
    input: source.slice(0, source.indexOf('  compose "$install_stage" pull')),
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.equal(f.calls().length, 0);
  assert.equal(existsSync(f.target), false);
});

test("prefers the latest stable release without consulting prereleases", (t) => {
  const f = fixture(t, "", {
    latestStatus: 200,
    latest: { tag_name: "v1.2.3", draft: false, prerelease: false },
  });
  const result = install(f);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    readFileSync(join(f.target, ".env"), "utf8"),
    /SUBLANE_IMAGE=ghcr.io\/murongg\/sublane:1\.2\.3\n/,
  );
  assert.equal(
    f
      .calls()
      .filter((call) =>
        call.args.some((arg) => arg.startsWith("https://api.github.com/")),
      ).length,
    1,
  );
});

test("without stable releases, selects the most recently published prerelease across pages", (t) => {
  const older = {
    tag_name: "v2.0.0-rc.1",
    draft: false,
    prerelease: true,
    published_at: "2030-01-01T00:00:00Z",
  };
  const f = fixture(t, "", {
    pages: {
      1: Array.from({ length: 100 }, () => older),
      2: [
        {
          ...older,
          tag_name: "v2.0.0-rc.3",
          draft: true,
          published_at: "2030-04-01T00:00:00Z",
        },
        {
          ...older,
          tag_name: "v2.0.0",
          prerelease: false,
          published_at: "2030-03-01T00:00:00Z",
        },
        {
          ...older,
          tag_name: "v2.0.0-rc.2",
          published_at: "2030-02-01T00:00:00Z",
        },
      ],
    },
  });
  const result = install(f);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    readFileSync(join(f.target, ".env"), "utf8"),
    /SUBLANE_IMAGE=ghcr.io\/murongg\/sublane:2\.0\.0-rc\.2\n/,
  );
});

test("API errors and missing releases stop without silently choosing another channel", (t) => {
  for (const api of [
    { latestStatus: 403 },
    { latestStatus: 500 },
    { latestStatus: 200, latest: {} },
    { listStatus: 503 },
    { pages: { 1: [] } },
  ]) {
    const f = fixture(t, "", api);
    const result = install(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Error:/);
    assert.equal(existsSync(f.target), false);
    assert.equal(
      f
        .calls()
        .some((call) =>
          call.args.some((arg) => arg.includes("/releases/download/")),
        ),
      false,
    );
  }
});
