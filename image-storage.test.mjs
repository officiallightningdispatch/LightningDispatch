// Hermetic Stage 1 image-storage boundary tests. No DB or network: the DB contract
// is supplied by the already-authorized caller and B2 metadata is mocked.
process.env.B2_KEY_ID = "stage1-key";
process.env.B2_APPLICATION_KEY = "stage1-secret";
process.env.B2_BUCKET_NAME = "stage1-bucket";
const { run, verify, read } = await import("./src/data/image-storage-core.ts");
const bytes = new Uint8Array([1, 2, 3, 4]);
const contract = { key: "photos/org/user/image.jpg", byteLength: 4, contentType: "image/jpeg" };
const response = (status, headers = {}, body = new Uint8Array()) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers), async text() { return "{}"; }, async arrayBuffer() { return body.buffer; } });
function mock({ head = { status: 200, length: "4", type: "image/jpeg" }, get = true, put = 200 } = {}) {
  const objects = [];
  return { objects, fetchImpl: async (url, init = {}) => {
    if (String(url).startsWith("https://api.backblazeb2.com/")) return { ...response(200), async text() { return JSON.stringify({ apiInfo: { storageApi: { s3ApiUrl: "https://s3.us-west-004.backblazeb2.com" } }, allowed: { bucketName: "stage1-bucket" } }); } };
    if (init.method === "PUT") { objects.push(init.body); return response(put); }
    if (init.method === "HEAD") return response(head.status, { "content-length": head.length, "content-type": head.type });
    if (init.method === "GET") return get ? response(200, {}, bytes) : response(404);
    throw new Error(`unexpected ${init.method} ${url}`);
  }};
}
const check = (name, value) => { if (!value) throw new Error(`FAIL: ${name}`); console.log(`ok - ${name}`); };
{
  const m = mock();
  const result = await run(contract, bytes, { fetchImpl: m.fetchImpl, b2StableDir: "/tmp/stage1-no-real-creds" });
  check("successful run verifies object before returning", result.ok && m.objects.length === 1);
  check("verify accepts matching persisted metadata", await verify(contract, { fetchImpl: m.fetchImpl, b2StableDir: "/tmp/stage1-no-real-creds" }));
  const readResult = await read(contract, { fetchImpl: m.fetchImpl, b2StableDir: "/tmp/stage1-no-real-creds" });
  check("read returns data only after verification", readResult.ok && readResult.dataUrl === "data:image/jpeg;base64,AQIDBA==");
}
{
  const m = mock({ head: { status: 200, length: "3", type: "image/jpeg" } });
  check("mismatched blob metadata fails verification", !(await verify(contract, { fetchImpl: m.fetchImpl, b2StableDir: "/tmp/stage1-no-real-creds" })));
  const result = await read(contract, { fetchImpl: m.fetchImpl, b2StableDir: "/tmp/stage1-no-real-creds" });
  check("mismatched metadata suppresses URL/data", !result.ok);
}
{
  const m = mock({ head: { status: 404, length: null, type: null }, get: false });
  check("missing blob fails verification", !(await verify(contract, { fetchImpl: m.fetchImpl, b2StableDir: "/tmp/stage1-no-real-creds" })));
  check("missing blob suppresses URL/data", !(await read(contract, { fetchImpl: m.fetchImpl, b2StableDir: "/tmp/stage1-no-real-creds" })).ok);
}
