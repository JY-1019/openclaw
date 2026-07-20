# LightRAG Knowledge plugin

Registers one or more [LightRAG](https://github.com/HKUDS/LightRAG) API servers
as ClawWorks enterprise knowledge foundations. When enterprise mode is active,
the agent's `knowledge_search` tool can retrieve context from these servers,
scoped by the active workflow step's `ontology.knowledgeFoundations` allow-list
and gated by enterprise governance policies.

## Configuration

```jsonc
{
  "plugins": {
    "entries": {
      "lightrag": {
        "enabled": true,
        "config": {
          "foundations": [
            {
              "id": "acme.support-kb", // referenced by ontology.knowledgeFoundations
              "serverUrl": "http://localhost:9621",
              "kind": "remote", // remote | local (default: remote) — see below
              "apiKey": "${LIGHTRAG_API_KEY}", // optional X-API-Key; string or secret reference
              "mode": "mix", // local | global | hybrid | naive | mix | bypass
            },
          ],
        },
      },
    },
  },
}
```

Each foundation calls `POST {serverUrl}/query` with `include_chunk_content: true`
and maps the returned reference chunks into knowledge snippets.

### `kind`

`kind` declares who administers the server's documents, and is independent of
the `mode` retrieval setting (which happens to share the word "local"):

- `remote` (default) — someone else operates the server; ClawWorks only reads
  from it.
- `local` — this deployment owns the server, so operators may manage its
  documents from the Knowledge tab.

It is an explicit declaration rather than something inferred from the URL: a
`localhost` address can front a shared corpus, and a public hostname can front a
server this deployment owns. Foundations configured before `kind` existed stay
`remote`, so upgrading never starts offering document management for a server
the operator has not claimed.

## What the Knowledge tab displays

The tab shows each foundation's server as an origin plus path only. Userinfo
(`http://user:pass@host`), query strings, and fragments are dropped, since
token-in-URL deployments put secrets in all three. A `serverUrl` that is not a
parseable `http`/`https` URL is shown as `(unrecognized server url)` rather than
echoed — its parts cannot be identified, so no portion of it is provably safe to
display. The `apiKey` is never included; it only ever travels as an `X-API-Key`
request header.

## Connection checks

The adapter probes `GET {serverUrl}/health` — LightRAG's liveness endpoint,
which answers `200` even to unauthenticated callers — for the Knowledge tab's
"test connection" action. `/query` would also prove reachability but costs an
LLM call on every click. The probe carries its own 5s timeout, since an operator
click has no agent-run signal to bound it.

> Live verification requires a running LightRAG API server. The adapter's route
> and payload shapes are unit-tested against LightRAG's `/query` and `/health`
> contracts as defined in its FastAPI routers.
