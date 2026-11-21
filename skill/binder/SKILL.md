---
name: binder
description: Publish a canvas artifact (an interactive HTML explainer, diagram, dashboard, quiz, report, design gallery, or any other page an agent built) to a Binder library. Use only when the user explicitly asks to put something in the binder, for example "put it in the binder", "add this to the binder", or "binder it".
---

# Binder

Binder is a self-hosted library of agent-built pages. It files each page by project, kind, and date, keeps every version, and serves pages in a sandbox. This skill publishes to the Binder at `$BINDER_URL`.

## Setup (once per machine)

The person who runs the Binder gives you two values. Keep them in the environment, not in files you commit:

- `BINDER_URL`: the Binder address, such as `https://binder.example.com`.
- `BINDER_TOKEN`: a token made with `binder token create --name <agent-name>`. Leave it unset only when Binder sits behind a proxy that identifies you, such as Tailscale.

Never print the token, paste it into an artifact, or pass it on a command line that is logged.

## Rules

- Publish only when the user explicitly asks to put the artifact in the binder. Building an artifact is not a request to publish it.
- Never put credentials, tokens, private keys, or data you may not share in an artifact.
- The artifact must work as static files. Binder serves it in a sandbox with an opaque origin: `localStorage` may throw, so wrap it in `try`/`catch`, and there is no host runtime. Scripts, styles, and fonts from public CDNs work.

## Steps

1. Finish the artifact as one self-contained HTML file, or as a folder with an `index.html` and relative links.
2. Write `meta.json`:

   ```json
   {
     "id": "queue-retries-explainer",
     "title": "How the Job Queue Retries",
     "summary": "One plain sentence that says what the page is.",
     "project": "acme-api",
     "kind": "explainer",
     "tags": ["queues", "reliability"],
     "note": "What changed in this version.",
     "agent": "<your model or harness>",
     "source_url": "https://github.com/acme/api/pull/123"
   }
   ```

   - `id`: a stable kebab-case slug. Publishing the same `id` again makes a new version; old versions stay readable. Leave it out only for a one-off.
   - `project`: the repository or product name in kebab case. Reuse an existing one when it fits (see "Look up projects").
   - `kind`: for example `explainer`, `whitepaper`, `diagram`, `dashboard`, `quiz`, `report`, `design`, `plan`, `prototype`, `deck`.
   - `note`: one line on what changed. It shows in the version history.
   - Optional: `domain`, `tags` (two to five), `source_url` (http or https only), `published_at` (a date), `host`, `entry` (the entry file of a folder).
3. Publish. One HTML file becomes `index.html`:

   ```sh
   curl -fsS "$BINDER_URL/api/artifacts" -H 'X-Binder: 1' \
     ${BINDER_TOKEN:+-H "Authorization: Bearer $BINDER_TOKEN"} \
     -F 'meta=<meta.json' -F 'file=@explainer.html'
   ```

   For a folder, send each file with its relative path as the filename:

   ```sh
   cd site && args=() && while IFS= read -r f; do args+=(-F "file=@${f#./};filename=${f#./}"); done < <(find . -type f) \
     && curl -fsS "$BINDER_URL/api/artifacts" -H 'X-Binder: 1' ${BINDER_TOKEN:+-H "Authorization: Bearer $BINDER_TOKEN"} \
        -F 'meta=<../meta.json' "${args[@]}"
   ```

4. Read `url` and `version` from the JSON response. Give the user the `url`.

## Look up projects

```sh
curl -fsS "$BINDER_URL/api/artifacts" ${BINDER_TOKEN:+-H "Authorization: Bearer $BINDER_TOKEN"} \
  | python3 -c 'import json,sys; print(sorted({a["project"] for a in json.load(sys.stdin)["artifacts"]}))'
```

## If it fails

- `401`: no token, or the token is wrong or revoked. Ask the user for a new one.
- `403`: the token is read-only, the `X-Binder: 1` header is missing, or your proxy login is not on the Binder's allowlist.
- `400`: the response's `error` names the problem (bad `meta` JSON, no `file`, an unsafe path, or a `source_url` that is not http or https).
- `413`: the artifact is over 64 MB. Compress media or link to it.
