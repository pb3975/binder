// A fake OpenID Connect provider for tests: discovery, JWKS, and a token endpoint, with real
// RS256, PS256, and ES256 keys. Tests mint the ID token themselves, so they can break any part of it.
import { createHash, createHmac } from "node:crypto";

type Key = { kid: string; alg: "RS256" | "PS256" | "ES256"; priv: CryptoKey; jwk: JsonWebKey };
const PARAMS = {
  RS256: { gen: { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, sign: { name: "RSASSA-PKCS1-v1_5" } },
  PS256: { gen: { name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, sign: { name: "RSA-PSS", saltLength: 32 } },
  ES256: { gen: { name: "ECDSA", namedCurve: "P-256" }, sign: { name: "ECDSA", hash: "SHA-256" } },
} as const;

async function makeKey(kid: string, alg: Key["alg"]): Promise<Key> {
  const pair = (await crypto.subtle.generateKey(PARAMS[alg].gen, true, ["sign", "verify"])) as CryptoKeyPair;
  const { kty, n, e, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, alg, priv: pair.privateKey, jwk: { kty, n, e, crv, x, y, kid, alg, use: "sig" } as JsonWebKey };
}

const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64url");

export type TokenRequest = { form: URLSearchParams; authorization: string | null };

export async function fakeProvider(opts: { clientId: string; clientSecret: string | null }) {
  const keys = {
    rs: await makeKey("rs-1", "RS256"),
    ps: await makeKey("ps-1", "PS256"),
    es: await makeKey("es-1", "ES256"),
    rotated: await makeKey("rs-2", "RS256"), // published only after rotate()
  };
  const published = new Set(["rs-1", "ps-1", "es-1"]);
  const codes = new Map<string, { challenge: string; idToken: string; redirectUri: string }>();
  const state = {
    jwksHits: 0,
    advertisedIssuer: null as string | null,
    /** Where discovery says the endpoints are, when not the issuer itself. */
    endpointBase: null as string | null,
    /** The token endpoint's JSON for an ID token; the default is a complete RFC 6749 5.1 response. */
    tokenResponse: (idToken: string): object => ({ access_token: "synthetic-access", token_type: "Bearer", id_token: idToken }),
    lastToken: null as TokenRequest | null,
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      const path = new URL(req.url).pathname;
      if (path === "/.well-known/openid-configuration")
        return Response.json({
          issuer: state.advertisedIssuer ?? issuer,
          authorization_endpoint: `${state.endpointBase ?? issuer}/authorize?prompt=login`,
          token_endpoint: `${state.endpointBase ?? issuer}/token`,
          jwks_uri: `${state.endpointBase ?? issuer}/jwks`,
        });
      if (path === "/jwks") {
        state.jwksHits++;
        return Response.json({ keys: Object.values(keys).filter((k) => published.has(k.kid)).map((k) => k.jwk) });
      }
      if (path === "/token" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        const authorization = req.headers.get("authorization");
        state.lastToken = { form, authorization };
        const want = opts.clientSecret ? `Basic ${btoa(`${opts.clientId}:${opts.clientSecret}`)}` : null;
        if (authorization !== want) return Response.json({ error: "invalid_client" }, { status: 401 });
        if (!opts.clientSecret && form.get("client_id") !== opts.clientId) return Response.json({ error: "invalid_client" }, { status: 401 });
        const c = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? ""); // single use, as at a real provider
        const verifier = form.get("code_verifier") ?? "";
        if (!c || form.get("grant_type") !== "authorization_code" || form.get("redirect_uri") !== c.redirectUri ||
            createHash("sha256").update(verifier).digest("base64url") !== c.challenge)
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json(state.tokenResponse(c.idToken));
      }
      return new Response("not found", { status: 404 });
    },
  });
  const issuer: string = `http://127.0.0.1:${server.port}`;

  /**
   * Signs claims as a JWS. `alg: "none"` and `"HS256"` make the tokens Binder must refuse.
   * Claims may be a raw JSON string, for values JSON.stringify cannot write (such as 1e400).
   */
  async function sign(claims: object | string, o: { key?: keyof typeof keys; alg?: string; kid?: string | null; header?: object } = {}) {
    const key = keys[o.key ?? "rs"];
    const alg = o.alg ?? key.alg;
    const header: Record<string, unknown> = { alg, typ: "JWT", ...o.header };
    if (o.kid !== null) header.kid = o.kid ?? key.kid;
    const input = `${b64(JSON.stringify(header))}.${b64(typeof claims === "string" ? claims : JSON.stringify(claims))}`;
    if (alg === "none") return `${input}.`;
    if (alg === "HS256") return `${input}.${createHmac("sha256", opts.clientSecret ?? "x").update(input).digest("base64url")}`;
    const sig = await crypto.subtle.sign(PARAMS[key.alg].sign, key.priv, new TextEncoder().encode(input));
    return `${input}.${b64(new Uint8Array(sig))}`;
  }

  return {
    issuer,
    state,
    sign,
    /** Records an authorization code, as the provider would after the person signs in. */
    issue(challenge: string, redirectUri: string, idToken: string) {
      const code = crypto.randomUUID();
      codes.set(code, { challenge, idToken, redirectUri });
      return code;
    },
    rotate: () => published.add("rs-2"),
    /** Replaces the key material behind kid rs-1, as a provider that rotates without a new kid. */
    async rekey() {
      keys.rs = await makeKey("rs-1", "RS256");
    },
    stop: () => server.stop(true),
  };
}
