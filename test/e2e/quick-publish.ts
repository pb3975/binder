export {};
// Publishes one page as fast as possible, for the "write, then stop at once" case in scripts/e2e-s3.sh.
const f = new FormData();
f.set("meta", JSON.stringify({ id: "quick", title: "Quick" }));
f.append("file", new File(["<p>quick</p>"], "index.html"));
const r = await fetch("http://127.0.0.1:8480/api/artifacts", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.T}`, "x-binder": "1" },
  body: f,
});
if (r.status !== 201) {
  console.error("FAIL quick publish", r.status, await r.text());
  process.exit(1);
}
