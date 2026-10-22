import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { verifyNodeRuntimeFile } from "../src/node-runtime.ts";

const productionManifest = JSON.parse(
  fs.readFileSync(new URL("../node-runtime.json", import.meta.url), "utf8"),
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const license = Buffer.from("Offline fixture license\n");
const binary = Buffer.from("Offline binary fixture; never executed\n");

// A deterministic one-member ustar fixture; extraction uses the same native tar
// as production, not a mocked extractor or an upstream network download.
function archive(member, { type = "0", contents = binary, link = "" } = {}) {
  const header = Buffer.alloc(512);
  const field = (value, offset, length) =>
    header.write(value, offset, length, "ascii");
  field(member, 0, 100);
  field("0000755\0", 100, 8);
  field("0000000\0", 108, 8);
  field("0000000\0", 116, 8);
  const size = type === "0" ? contents.length : 0;
  field(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  field("00000000000\0", 136, 12);
  header.fill(32, 148, 156);
  field(type, 156, 1);
  field(link, 157, 100);
  field("ustar\0", 257, 6);
  field("00", 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  field(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return gzipSync(
    Buffer.concat([
      header,
      type === "0" ? contents : Buffer.alloc(0),
      Buffer.alloc((512 - (size % 512)) % 512),
      Buffer.alloc(1024),
    ]),
  );
}

async function fixture(
  t,
  { platform = "linux", arch = "x64", makeArchive, cached = true } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-node-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const desktop = path.join(root, "apps", "desktop");
  const scripts = path.join(desktop, "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(path.join(desktop, "resources"));
  fs.mkdirSync(path.join(desktop, "src"));
  fs.writeFileSync(path.join(desktop, "package.json"), '{"type":"module"}\n');
  fs.copyFileSync(
    new URL("../src/node-runtime.ts", import.meta.url),
    path.join(desktop, "src", "node-runtime.ts"),
  );
  fs.copyFileSync(
    new URL("./node-runtime.mjs", import.meta.url),
    path.join(scripts, "node-runtime.mjs"),
  );
  fs.writeFileSync(
    path.join(root, "mise.toml"),
    `[tools]\nnode = "${productionManifest.version}"\n`,
  );
  fs.writeFileSync(
    path.join(desktop, "resources", "node-LICENSE.txt"),
    license,
  );
  const key = `${platform}-${arch}`;
  const target = {
    ...productionManifest.targets[key],
    binarySha256: digest(binary),
  };
  const bytes = target.member
    ? (makeArchive ?? archive)(target.member)
    : binary;
  target.sha256 = digest(bytes);
  fs.writeFileSync(
    path.join(desktop, "node-runtime.json"),
    JSON.stringify({
      version: productionManifest.version,
      license: { sha256: digest(license) },
      targets: { [key]: target },
    }),
  );
  const cache = path.join(
    desktop,
    "node_modules",
    ".cache",
    "covel-node-runtime",
    `v${productionManifest.version}`,
    key,
  );
  fs.mkdirSync(cache, { recursive: true });
  const artifact = path.join(cache, path.basename(target.file));
  if (cached) fs.writeFileSync(artifact, bytes);
  const runtime = await import(
    pathToFileURL(path.join(scripts, "node-runtime.mjs")).href
  );
  const destination = path.join(root, "staging", "with spaces", key);
  const options = { platform, arch };
  return {
    root,
    desktop,
    cache,
    artifact,
    bytes,
    runtime,
    destination,
    options,
  };
}

test("hash verification yields between reads, rejects corruption and reopens every time", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-async-hash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "binary");
  const contents = Buffer.alloc(8 * 1024 * 1024, 0x5a);
  const expected = digest(contents);
  fs.writeFileSync(file, contents);
  let completed = false;
  const checking = verifyNodeRuntimeFile(file, expected).then(() => {
    completed = true;
  });
  await nextImmediate();
  assert.equal(completed, false, "the event loop runs during binary hashing");
  await checking;
  assert.equal(completed, true);
  fs.writeFileSync(file, "corrupt replacement");
  await assert.rejects(
    verifyNodeRuntimeFile(file, expected),
    /SHA256 mismatch/,
  );
  // A failed scan must release its file handle and never cache its result.
  fs.unlinkSync(file);
  fs.writeFileSync(file, contents);
  await verifyNodeRuntimeFile(file, expected);
  fs.unlinkSync(file);
  await assert.rejects(verifyNodeRuntimeFile(file, expected), /ENOENT/);
});

function offline(t) {
  t.mock.method(https, "get", () => {
    throw new Error("Unexpected network request");
  });
}

function respond(t, bytes, { headers = {}, status = 200 } = {}) {
  return t.mock.method(https, "get", (_requested, _options, callback) => {
    const request = new EventEmitter();
    const response = Readable.fromWeb(new Response(bytes).body);
    response.statusCode = status;
    response.headers = headers;
    queueMicrotask(() => callback(response));
    return request;
  });
}

for (const [platform, arch] of [
  ["darwin", "arm64"],
  ["linux", "x64"],
  ["linux", "arm64"],
  ["win32", "x64"],
]) {
  test(`stages and reuses verified ${platform}-${arch} bytes without executing them`, async (t) => {
    offline(t);
    const f = await fixture(t, { platform, arch });
    const executable = await f.runtime.stageNodeRuntime(
      f.destination,
      f.options,
    );
    assert.equal(
      path.basename(executable),
      platform === "win32" ? "node.exe" : "node",
    );
    assert.deepEqual(fs.readFileSync(executable), binary);
    assert.deepEqual(
      fs.readFileSync(path.join(f.destination, "LICENSE")),
      license,
    );
    assert.equal(
      await f.runtime.verifyNodeRuntime(f.destination, f.options),
      executable,
    );
    assert.equal(
      await f.runtime.stageNodeRuntime(f.destination, f.options),
      executable,
    );
    const metadata = JSON.parse(
      fs.readFileSync(path.join(f.destination, "runtime.json"), "utf8"),
    );
    assert.equal(metadata.platform, platform);
    assert.equal(metadata.arch, arch);
    assert.equal(metadata.binarySha256, digest(binary));
    if (platform !== "win32" && process.platform !== "win32") {
      assert.equal(fs.statSync(executable).mode & 0o777, 0o755);
    }
    assert.deepEqual(fs.readdirSync(path.dirname(f.destination)), [
      `${platform}-${arch}`,
    ]);
  });
}

test("downloads bounded HTTPS bytes, verifies them, and reuses the checked cache", async (t) => {
  const f = await fixture(t, { cached: false });
  const request = respond(t, f.bytes);
  await f.runtime.stageNodeRuntime(f.destination, f.options);
  assert.equal(request.mock.callCount(), 1);
  fs.rmSync(f.destination, { recursive: true });
  await f.runtime.stageNodeRuntime(f.destination, f.options);
  assert.equal(request.mock.callCount(), 1);
  assert.deepEqual(fs.readdirSync(f.cache), [path.basename(f.artifact)]);
});

test("rejects a corrupt cached archive before extraction or network access", async (t) => {
  offline(t);
  const f = await fixture(t);
  fs.writeFileSync(f.artifact, "not a tar archive");
  await assert.rejects(
    f.runtime.stageNodeRuntime(f.destination, f.options),
    /SHA256 mismatch/,
  );
  assert.equal(fs.existsSync(path.dirname(f.destination)), false);
});

test("rejects bad download integrity and removes partial cache files", async (t) => {
  const f = await fixture(t, { cached: false });
  respond(t, Buffer.from("corrupt download"));
  await assert.rejects(
    f.runtime.stageNodeRuntime(f.destination, f.options),
    /SHA256 mismatch/,
  );
  assert.deepEqual(fs.readdirSync(f.cache), []);
  assert.equal(fs.existsSync(f.destination), false);
});

test("rejects redirected or over-limit responses without caching them", async (t) => {
  for (const response of [
    { status: 301, headers: { location: "http://nodejs.org/dist/file" } },
    { status: 302, headers: { location: "https://other.example/node" } },
    { headers: { "content-length": String(161 * 1024 * 1024) } },
    { status: 404 },
  ]) {
    const f = await fixture(t, { cached: false });
    const request = respond(t, f.bytes, response);
    await assert.rejects(
      f.runtime.stageNodeRuntime(f.destination, f.options),
      /Unexpected.*response|size limit/,
    );
    assert.deepEqual(fs.readdirSync(f.cache), []);
    request.mock.restore();
  }
});

test("cleans up an interrupted response body rather than trusting a partial artifact", async (t) => {
  const f = await fixture(t, { cached: false });
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.error(new Error("connection interrupted"));
    },
  });
  respond(t, body);
  await assert.rejects(
    f.runtime.stageNodeRuntime(f.destination, f.options),
    /connection interrupted/,
  );
  assert.deepEqual(fs.readdirSync(f.cache), []);
  assert.equal(fs.existsSync(f.destination), false);
});

test("rejects unsupported and incorrectly cased targets without touching destination", async (t) => {
  offline(t);
  const f = await fixture(t);
  for (const options of [
    { platform: "darwin", arch: "x64" },
    { platform: "linux", arch: "ia32" },
    { platform: "Linux", arch: "x64" },
    { platform: "win32", arch: "arm64" },
  ]) {
    await assert.rejects(
      f.runtime.stageNodeRuntime(f.destination, options),
      /Unsupported.*target/,
    );
  }
  assert.equal(fs.existsSync(f.destination), false);
});

for (const [name, makeArchive, expected] of [
  [
    "missing exact member",
    () => archive("unrelated/bin/node"),
    /Command failed/,
  ],
  [
    "symlink member",
    (member) => archive(member, { type: "2", link: "missing" }),
    /regular|Command failed/,
  ],
  [
    "wrong extracted bytes",
    (member) => archive(member, { contents: Buffer.from("different binary") }),
    /SHA256 mismatch/,
  ],
]) {
  test(`rejects ${name} and cleans up unpublished extraction`, async (t) => {
    offline(t);
    const f = await fixture(t, { makeArchive });
    await assert.rejects(
      f.runtime.stageNodeRuntime(f.destination, f.options),
      expected,
    );
    assert.equal(fs.existsSync(f.destination), false);
    assert.deepEqual(fs.readdirSync(path.dirname(f.destination)), []);
  });
}

test("metadata cannot bless replaced binary bytes or a different target", async (t) => {
  offline(t);
  const f = await fixture(t);
  const executable = await f.runtime.stageNodeRuntime(f.destination, f.options);
  const metadataFile = path.join(f.destination, "runtime.json");
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  fs.writeFileSync(executable, "modified");
  metadata.binarySha256 = digest("modified");
  fs.writeFileSync(metadataFile, JSON.stringify(metadata));
  await assert.rejects(
    () => f.runtime.verifyNodeRuntime(f.destination, f.options),
    /metadata mismatch/,
  );
  metadata.binarySha256 = digest(binary);
  fs.writeFileSync(metadataFile, JSON.stringify(metadata));
  await assert.rejects(
    () => f.runtime.verifyNodeRuntime(f.destination, f.options),
    /SHA256 mismatch/,
  );
  await assert.rejects(
    f.runtime.stageNodeRuntime(f.destination, f.options),
    /SHA256 mismatch/,
  );
});

test("rejects changed metadata target and missing or modified license", async (t) => {
  offline(t);
  const f = await fixture(t);
  await f.runtime.stageNodeRuntime(f.destination, f.options);
  const metadataFile = path.join(f.destination, "runtime.json");
  const original = fs.readFileSync(metadataFile);
  const metadata = JSON.parse(original);
  metadata.arch = "arm64";
  fs.writeFileSync(metadataFile, JSON.stringify(metadata));
  await assert.rejects(
    () => f.runtime.verifyNodeRuntime(f.destination, f.options),
    /metadata mismatch/,
  );
  fs.writeFileSync(metadataFile, original);
  fs.writeFileSync(path.join(f.destination, "LICENSE"), "truncated");
  await assert.rejects(
    () => f.runtime.verifyNodeRuntime(f.destination, f.options),
    /SHA256 mismatch/,
  );
  fs.unlinkSync(path.join(f.destination, "LICENSE"));
  await assert.rejects(
    () => f.runtime.verifyNodeRuntime(f.destination, f.options),
    /ENOENT/,
  );
});

test("never treats an incomplete destination as a usable stage", async (t) => {
  offline(t);
  const f = await fixture(t);
  fs.mkdirSync(f.destination, { recursive: true });
  fs.writeFileSync(path.join(f.destination, "node"), binary);
  await assert.rejects(
    f.runtime.stageNodeRuntime(f.destination, f.options),
    /ENOENT/,
  );
  assert.deepEqual(fs.readdirSync(f.destination), ["node"]);
});

test(
  "rejects non-executable POSIX staging",
  { skip: process.platform === "win32" },
  async (t) => {
    offline(t);
    const f = await fixture(t);
    const executable = await f.runtime.stageNodeRuntime(
      f.destination,
      f.options,
    );
    fs.chmodSync(executable, 0o644);
    await assert.rejects(
      () => f.runtime.verifyNodeRuntime(f.destination, f.options),
      /EACCES/,
    );
  },
);

test(
  "does not follow symlinked binaries, metadata, licenses, caches or destinations",
  { skip: process.platform === "win32" },
  async (t) => {
    offline(t);
    for (const entry of ["node", "runtime.json", "LICENSE"]) {
      const f = await fixture(t);
      await f.runtime.stageNodeRuntime(f.destination, f.options);
      const file = path.join(f.destination, entry);
      const backing = path.join(f.root, "backing");
      fs.renameSync(file, backing);
      fs.symlinkSync(backing, file);
      await assert.rejects(
        () => f.runtime.verifyNodeRuntime(f.destination, f.options),
        /regular/,
      );
    }
    const f = await fixture(t);
    fs.unlinkSync(f.artifact);
    fs.symlinkSync(path.join(f.root, "missing"), f.artifact);
    await assert.rejects(
      f.runtime.stageNodeRuntime(f.destination, f.options),
      /regular/,
    );
    fs.mkdirSync(path.dirname(f.destination), { recursive: true });
    fs.symlinkSync(path.join(f.root, "missing-directory"), f.destination);
    await assert.rejects(
      f.runtime.stageNodeRuntime(f.destination, f.options),
      /real directory/,
    );
  },
);

test("offline runtime verification needs no build tree, mise pin or source license", async (t) => {
  offline(t);
  const f = await fixture(t);
  const executable = await f.runtime.stageNodeRuntime(f.destination, f.options);
  fs.unlinkSync(path.join(f.root, "mise.toml"));
  fs.rmSync(path.join(f.desktop, "resources"), { recursive: true });
  fs.unlinkSync(path.join(f.desktop, "node-runtime.json"));
  fs.rmSync(path.join(f.desktop, "node_modules"), { recursive: true });
  assert.equal(
    await f.runtime.verifyNodeRuntime(f.destination, f.options),
    executable,
  );
});

test("rejects malformed metadata objects explicitly", async (t) => {
  offline(t);
  const f = await fixture(t);
  await f.runtime.stageNodeRuntime(f.destination, f.options);
  for (const value of [null, [], "metadata"]) {
    fs.writeFileSync(
      path.join(f.destination, "runtime.json"),
      JSON.stringify(value),
    );
    await assert.rejects(
      () => f.runtime.verifyNodeRuntime(f.destination, f.options),
      /Invalid.*metadata/,
    );
  }
});

test("cleans up a failed HTTPS connection before response headers arrive", async (t) => {
  const f = await fixture(t, { cached: false });
  t.mock.method(https, "get", () => {
    const request = new EventEmitter();
    queueMicrotask(() => request.emit("error", new Error("connection failed")));
    return request;
  });
  await assert.rejects(
    f.runtime.stageNodeRuntime(f.destination, f.options),
    /connection failed/,
  );
  assert.deepEqual(fs.readdirSync(f.cache), []);
  assert.equal(fs.existsSync(f.destination), false);
});
