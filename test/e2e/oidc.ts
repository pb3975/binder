// OIDC sign-in through a real Keycloak login page, driven in Chromium. Run by scripts/e2e-oidc.sh
// inside the Binder container, after scripts/demo.ts. Saves screenshots when SHOTS is a folder path.
// Usage: BINDER_TOKEN=<agent token> bun /e2e/oidc.ts
import { browser as open, shutdown } from "./cdp";

const B = process.env.BINDER_URL ?? "http://127.0.0.1:8480";
const SHOTS = process.env.SHOTS;
let failures = 0;
setTimeout(() => { console.log("FAIL oidc: watchdog: checks took over 4 minutes"); process.exit(1); }, 240_000).unref();
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} oidc: ${name}${!ok && detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};
type Page = Awaited<ReturnType<typeof open>>;
const shot = async (b: Page, name: string) => SHOTS && b.screenshot(`${SHOTS}/${name}.png`);
const session = (b: Page) => b.evaluate<string>(`fetch("/api/session").then(async r => r.status + " " + JSON.stringify(await r.json()))`);
const csp = (b: Page) => b.evaluate<string[]>(`window.__csp`);

/** Clicks the SSO button and signs in on Keycloak's own login page. */
async function viaKeycloak(b: Page, user: string, password: string) {
  await b.waitFor(`!document.querySelector("#signin-sso").hidden`);
  await b.evaluate(`document.querySelector("#signin-sso-link").click()`);
  await b.waitFor(`location.host === "keycloak:8080" && document.querySelector("#username")`, 15_000);
  await b.evaluate(`document.querySelector("#username").value = ${JSON.stringify(user)};
    document.querySelector("#password").value = ${JSON.stringify(password)};
    document.querySelector("#kc-form-login").requestSubmit()`);
  await b.waitFor(`location.origin === ${JSON.stringify(B)} && document.readyState === "complete"`, 15_000);
}

// The sign-in screen offers SSO first and keeps a token one click away. Light and dark.
for (const dark of [false, true]) {
  const b = await open({ dark });
  const sfx = dark ? "-dark" : "";
  try {
    await b.goto(`${B}/`);
    await b.waitFor(`!document.querySelector("#signin").hidden && !document.querySelector("#signin-sso").hidden`);
    check(`SSO button shows the configured label${sfx}`, (await b.evaluate<string>(`document.querySelector("#signin-sso-link").textContent`)) === "Sign in with Example SSO");
    check(`token form is tucked away${sfx}`, await b.evaluate<boolean>(`document.querySelector("#signin-form").hidden`));
    await Bun.sleep(300);
    await shot(b, `signin-sso${sfx}`);
    await b.evaluate(`document.querySelector("#signin-use-token").click()`);
    check(`"Use a Binder token instead" opens the token form${sfx}`, !(await b.evaluate<boolean>(`document.querySelector("#signin-form").hidden`)));
    await shot(b, `signin-sso-token${sfx}`);
    check(`sign-in screen trips no CSP rule${sfx}`, (await csp(b)).length === 0, JSON.stringify(await csp(b)));
  } finally {
    b.close();
  }
}

// alice is in binder-users: she signs in on Keycloak and lands where she started, in the library.
{
  const b = await open();
  try {
    await b.goto(`${B}/a/queue-explainer`);
    await viaKeycloak(b, "alice", "alice-e2e-password");
    await b.waitFor(`!document.querySelector("#viewer").hidden`, 10_000);
    check("alice lands back on the page she opened", (await b.evaluate<string>(`location.pathname`)) === "/a/queue-explainer");
    const me = await session(b);
    check("alice's session names her email and comes from OIDC", me === `200 {"name":"alice@example.com","scope":"write","via":"oidc"}`, me);
    await b.evaluate(`document.querySelector("#v-back").click()`);
    await b.waitFor(`document.querySelectorAll(".card").length >= 5`);
    check("alice sees the library", true);
    check("the session cookie is HttpOnly (the page cannot read it)", !(await b.evaluate<string>(`document.cookie`)).includes("binder_session"));
    check("library trips no CSP rule after SSO", (await csp(b)).length === 0, JSON.stringify(await csp(b)));

    await b.evaluate(`window.confirm = () => true; document.querySelector("#me-btn").click()`);
    await b.waitFor(`!document.querySelector("#signin").hidden && !document.querySelector("#signin-sso").hidden`, 10_000);
    const after = await session(b);
    check("sign-out ends alice's Binder session", after.startsWith("401 ") && after.includes(`"auth":"oidc"`), after);
  } finally {
    b.close();
  }
}

// bob is not in binder-users: Keycloak signs him in, and Binder refuses him with a fixed message.
{
  const b = await open(); // a fresh browser context, so Keycloak's own session from alice is not reused
  try {
    await b.goto(`${B}/`);
    await viaKeycloak(b, "bob", "bob-e2e-password");
    await b.waitFor(`document.querySelector("#signin-sso-error").textContent.length > 0`);
    check("bob is refused with the not-allowed message", (await b.evaluate<string>(`document.querySelector("#signin-sso-error").textContent`)).includes("not allowed"));
    check("the reason code is removed from the address bar", (await b.evaluate<string>(`location.search`)) === "");
    const me = await session(b);
    check("bob has no session", me.startsWith("401 "), me);
    await shot(b, "signin-sso-denied");
    await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await Bun.sleep(200);
    await shot(b, "signin-sso-denied-dark");
  } finally {
    b.close();
  }
}

// Agents keep using tokens in oidc mode.
{
  const f = new FormData();
  f.set("meta", JSON.stringify({ id: "from-agent", title: "Published by an agent", project: "e2e", note: "token in oidc mode" }));
  f.append("file", new File(["<!doctype html><title>agent</title><p>agent"], "index.html", { type: "text/html" }));
  const r = await fetch(`${B}/api/artifacts`, { method: "POST", headers: { authorization: `Bearer ${process.env.BINDER_TOKEN}`, "x-binder": "1" }, body: f });
  const body = await r.json();
  check("an agent token still publishes", r.status === 201 && body.published_by === "agent", `${r.status} ${JSON.stringify(body)}`);
  check("no credential still gets 401", (await fetch(`${B}/api/artifacts`)).status === 401);
}

await shutdown();
console.log(failures ? `${failures} oidc check(s) failed` : "all oidc checks passed");
process.exit(failures ? 1 : 0);
