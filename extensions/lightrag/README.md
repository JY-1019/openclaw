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

> Live verification requires a running LightRAG API server; the adapter is
> covered by unit tests against LightRAG's documented `/query` contract.
