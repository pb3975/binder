// Publishes a few synthetic artifacts, some with several versions, so the UI has something to show.
// Used for screenshots and local development. All content is made up.
// Usage: BINDER_TOKEN=bnd_... bun scripts/demo.ts [binder-url]
const base = (process.argv[2] ?? process.env.BINDER_URL ?? "http://127.0.0.1:8480").replace(/\/$/, "");
export {};
const headers: Record<string, string> = { "x-binder": "1" };
if (process.env.BINDER_TOKEN) headers.authorization = `Bearer ${process.env.BINDER_TOKEN}`;

const page = (title: string, hue: number, body: string) => `<!doctype html><meta charset=utf-8>
<style>body{margin:0;font:16px/1.5 system-ui;background:hsl(${hue} 40% 97%);color:#1c1a17}
header{padding:48px 56px;background:hsl(${hue} 55% 42%);color:#fff}h1{margin:0;font:600 44px/1.1 Georgia,serif}
main{padding:32px 56px;display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.c{background:#fff;border-radius:14px;padding:20px;box-shadow:0 2px 10px #0001}.c b{display:block;font-size:30px;color:hsl(${hue} 55% 38%)}</style>
<header><h1>${title}</h1><p>Synthetic demo artifact</p></header><main>${body}</main>`;
const cards = (...xs: [string, string][]) => xs.map(([k, v]) => `<div class=c><b>${v}</b>${k}</div>`).join("");

type Demo = { meta: Record<string, unknown>; html: string };
const demos: Demo[][] = [
  [
    { meta: { id: "queue-explainer", title: "How the Job Queue Retries", project: "acme-api", domain: "infrastructure", kind: "explainer", summary: "Backoff, dead letters, and idempotency keys in one page.", tags: ["queues", "reliability"], agent: "claude-code", note: "First draft" },
      html: page("How the Job Queue Retries", 220, cards(["max attempts", "5"], ["base backoff", "2s"], ["dead letter after", "1h"])) },
    { meta: { id: "queue-explainer", title: "How the Job Queue Retries", note: "Add jitter and the dead-letter diagram", agent: "codex" },
      html: page("How the Job Queue Retries", 220, cards(["max attempts", "5"], ["backoff with jitter", "2s ± 30%"], ["dead letter after", "1h"], ["replays", "manual"])) },
    { meta: { id: "queue-explainer", title: "How the Job Queue Retries", note: "Fix the backoff numbers after review", agent: "claude-code" },
      html: page("How the Job Queue Retries", 220, cards(["max attempts", "6"], ["backoff with jitter", "1s ± 30%"], ["dead letter after", "2h"], ["replays", "manual"])) },
  ],
  [{ meta: { id: "latency-dashboard", title: "Checkout Latency, Week 46", project: "acme-api", domain: "infrastructure", kind: "dashboard", summary: "p50 and p99 latency by region.", tags: ["latency"], agent: "t3-code", note: "Weekly snapshot" },
     html: page("Checkout Latency, Week 46", 160, cards(["p50", "84 ms"], ["p99", "410 ms"], ["error rate", "0.12%"])) }],
  [
    { meta: { id: "onboarding-quiz", title: "New Teammate Onboarding Quiz", project: "handbook", domain: "education", kind: "quiz", summary: "Ten questions about how the team ships.", tags: ["onboarding"], agent: "claude-code", note: "Ten questions" },
      html: page("Onboarding Quiz", 30, cards(["questions", "10"], ["minutes", "8"], ["pass mark", "7"])) },
    { meta: { id: "onboarding-quiz", title: "New Teammate Onboarding Quiz", note: "Add questions on incident review", agent: "claude-code" },
      html: page("Onboarding Quiz", 30, cards(["questions", "12"], ["minutes", "10"], ["pass mark", "8"])) },
  ],
  [{ meta: { id: "pricing-options", title: "Pricing Page Options", project: "website", domain: "design", kind: "design", summary: "Three layouts for the pricing page.", tags: ["pricing", "layout"], agent: "codex", note: "Three options" },
     html: page("Pricing Page Options", 280, cards(["option A", "Tiers"], ["option B", "Slider"], ["option C", "Calculator"])) }],
  [{ meta: { id: "auth-threat-model", title: "Auth Threat Model", project: "acme-api", domain: "security", kind: "whitepaper", summary: "Who can reach what, and what stops them.", tags: ["auth", "threat-model"], agent: "claude-code", note: "Initial model" },
     html: page("Auth Threat Model", 0, cards(["entry points", "4"], ["trust boundaries", "3"], ["open risks", "2"])) }],
];

for (const chain of demos)
  for (const d of chain) {
    const f = new FormData();
    f.set("meta", JSON.stringify(d.meta));
    f.append("file", new File([d.html], "index.html", { type: "text/html" }));
    const r = await fetch(`${base}/api/artifacts`, { method: "POST", headers, body: f });
    const a = await r.json();
    console.log(r.ok ? `${a.id} v${a.version}` : `FAIL ${d.meta.id}: ${a.error}`);
  }
