export {};
// S3 storage checks against a running Binder container. Run by scripts/e2e-s3.sh, inside the container:
//   bun /e2e/s3.ts seed     publish a multi-file artifact and a second version, then read them back
//   bun /e2e/s3.ts verify   in a brand-new container: everything from `seed` is still there
// Synthetic data only.
const BINDER = "http://127.0.0.1:8480";
const HAS_CHROMIUM = await Bun.file(process.env.CHROMIUM ?? "/usr/bin/chromium-browser").exists();
const phase = process.argv[2];
const auth = { authorization: `Bearer ${process.env.BINDER_TOKEN}` };
const write = { ...auth, "x-binder": "1" };
const ID = "e2e-s3-doc";
const V1: Record<string, string> = {
  "index.html": "<h1>one</h1><img src='img/dot.svg'><link rel=stylesheet href='css/site.css'>",
  "img/dot.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
  "css/site.css": "h1 { color: teal }",
};
const V2: Record<string, string> = { "index.html": "<h1>two</h1>", "css/site.css": "h1 { color: navy }" };

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} [s3 ${phase}] ${name}${detail && !ok ? `: ${detail}` : ""}`);
  if (!ok) failures++;
}

async function publish(meta: object, files: Record<string, string>) {
  const f = new FormData();
  f.set("meta", JSON.stringify(meta));
  for (const [p, body] of Object.entries(files)) f.append("file", new File([body], p));
  const r = await fetch(`${BINDER}/api/artifacts`, { method: "POST", headers: write, body: f });
  if (!r.ok) throw new Error(`publish ${JSON.stringify(meta)}: ${r.status} ${await r.text()}`);
  return r.json();
}
const getJson = async (path: string) => (await fetch(BINDER + path, { headers: auth })).json();
const manual = (url: string | URL, headers: Record<string, string> = {}) => fetch(url, { headers, redirect: "manual" });

async function checkThumb() {
  const r = await manual(`${BINDER}/thumb/e2e-s3-solo.png`, auth);
  const png = new Uint8Array(await r.arrayBuffer());
  check("/thumb/ serves the preview from S3 (200, no redirect)", r.status === 200 && !r.headers.get("location") && r.headers.get("content-type") === "image/png", `${r.status} ${r.headers.get("location")}`);
  check("the preview is a PNG", png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47);
}

/** Every file of a version comes through Binder itself, with the sandbox headers, never as a redirect to S3. */
async function checkVersion(label: string, contentUrl: string, files: Record<string, string>) {
  for (const [path, body] of Object.entries(files)) {
    const r = await manual(new URL(path, contentUrl));
    const got = await r.text();
    check(`${label} ${path} is served by Binder (200, no redirect)`, r.status === 200 && !r.headers.get("location"), `${r.status} ${r.headers.get("location")}`);
    check(`${label} ${path} has the right bytes`, got === body, got.slice(0, 60));
    if (path === "index.html") {
      check(`${label} carries the CSP sandbox`, (r.headers.get("content-security-policy") ?? "").startsWith("sandbox allow-scripts"), String(r.headers.get("content-security-policy")));
      check(`${label} carries nosniff and the cache policy`, r.headers.get("x-content-type-options") === "nosniff" && r.headers.get("cache-control") === "private, max-age=3600");
    }
  }
}

async function checkZip(path: string, names: string[]) {
  const r = await manual(BINDER + path, auth);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const text = new TextDecoder("latin1").decode(bytes);
  check(`download ${path} is a zip`, r.status === 200 && r.headers.get("content-type") === "application/zip" && text.startsWith("PK\x03\x04"), String(r.status));
  check(`download ${path} lists every file`, names.every((n) => text.includes(n)), names.filter((n) => !text.includes(n)).join());
}

const who = await (await fetch(`${BINDER}/api/session`, { headers: auth })).json();
check("the CLI-made token works", who.name === "e2e" && who.scope === "write", JSON.stringify(who));

if (phase === "seed") {
  const v1 = await publish({ id: ID, title: "S3 doc", project: "e2e", note: "first" }, V1);
  const v2 = await publish({ id: ID, title: "S3 doc", note: "second" }, V2);
  const solo = await publish({ id: "e2e-s3-solo", title: "Solo" }, { "index.html": "<p>solo</p>" });
  check("versions 1 and 2", v1.version === 1 && v2.version === 2 && solo.version === 1);
  await checkVersion("v1", v1.content_url, V1);
  await checkVersion("v2", v2.content_url, V2);
  await checkZip(`/api/artifacts/${ID}/versions/1/download`, Object.keys(V1).map((p) => `${ID}-v1/${p}`));

  // The files are in the bucket under the documented keys, and Litestream has written the replica.
  const s3 = new Bun.S3Client({ bucket: "binder-e2e", endpoint: process.env.AWS_ENDPOINT_URL, region: process.env.AWS_REGION });
  check("version files are at <prefix>/versions/<id>/<n>/<path>", await s3.file(`team-a/versions/${ID}/1/img/dot.svg`).exists());
  let replica = 0;
  for (let i = 0; i < 20 && !replica; i++, await Bun.sleep(250)) replica = (await s3.list({ prefix: "team-a/db/" })).keyCount ?? 0;
  check("the database replica is at <prefix>/db/", replica > 0);

  // Previews (full image only): rendered by Chromium, stored in S3, served by Binder.
  if (HAS_CHROMIUM) {
    let thumb = false;
    for (let i = 0; i < 120 && !thumb; i++, await Bun.sleep(500)) thumb = (await getJson("/api/artifacts/e2e-s3-solo")).thumb;
    check("the preview rendered", thumb);
    check("the preview is at <prefix>/thumbs/<id>.png", await s3.file("team-a/thumbs/e2e-s3-solo.png").exists());
    await checkThumb();
  }
} else if (phase === "verify") {
  const a = await getJson(`/api/artifacts/${ID}`);
  check("the artifact survived a new container", a.version === 2 && a.title === "S3 doc" && a.project === "e2e", JSON.stringify(a).slice(0, 200));
  const hist = (await getJson(`/api/artifacts/${ID}/versions`)).versions;
  check("its history survived", hist?.map((v: { version: number; note: string }) => `${v.version}:${v.note}`).join() === "2:second,1:first", JSON.stringify(hist?.map((v: { version: number }) => v.version)));
  check("history records who published", hist?.every((v: { published_by: string }) => v.published_by === "e2e"));
  check("the file diff survived", hist?.[0]?.changes?.removed?.includes("img/dot.svg") && hist?.[0]?.changes?.changed?.includes("index.html"));
  await checkVersion("v1", hist[1].content_url, V1);
  await checkVersion("v2", hist[0].content_url, V2);
  await checkZip(`/api/artifacts/${ID}/versions/1/download`, Object.keys(V1).map((p) => `${ID}-v1/${p}`));
  const one = await manual(`${BINDER}/api/artifacts/e2e-s3-solo/download`, auth);
  if (HAS_CHROMIUM) {
    check("the preview survived a new container", (await getJson("/api/artifacts/e2e-s3-solo")).thumb === true);
    await checkThumb();
  }
  check("a one-file download is the file itself", one.status === 200 && (await one.text()) === "<p>solo</p>" && one.headers.get("content-disposition") === 'attachment; filename="e2e-s3-solo-v1.html"');

  // New writes continue the history, never reuse a number.
  const v3 = await publish({ id: ID, title: "S3 doc", note: "third" }, { "index.html": "<h1>three</h1>" });
  check("the next publish is version 3", v3.version === 3, String(v3.version));
  const r = await fetch(`${BINDER}/api/artifacts/${ID}/versions/1/restore`, { method: "POST", headers: write });
  const v4 = await r.json();
  check("restore copies version 1 forward as version 4", r.ok && v4.version === 4, JSON.stringify(v4).slice(0, 200));
  await checkVersion("restored v4", v4.content_url, V1);
} else {
  console.error("usage: bun /e2e/s3.ts seed|verify");
  process.exit(2);
}

console.log(failures ? `${failures} check(s) failed` : `all s3 ${phase} checks passed`);
process.exit(failures ? 1 : 0);
