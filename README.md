# Leave Assistant — SAP SuccessFactors + BTP + Claude

A standalone natural-language assistant that answers questions like
**"How many vacation days do I have left?"** by querying **SAP SuccessFactors**
(Employee Central Time Off) through **SAP BTP**, with the conversational layer
powered by the **Claude API**.

> Built to run **locally with mock data on day one**, then flip to real
> SuccessFactors data and deploy to BTP Cloud Foundry by changing config only.

---

## How a question flows

```
Browser chat  ──POST /api/chat──▶  CAP service (srv/leave-service.js)
                                       │
   1. WHO is asking  (mock user locally / XSUAA user in prod)
   2. WHAT they want  → Claude intent extraction   (srv/lib/claude.js)
   3. Verified numbers → SuccessFactors query       (srv/lib/successfactors.js)
   4. PHRASE the answer → Claude                     (srv/lib/claude.js)
                                       │
                                       ▼
                               { reply, intent }  → shown in the chat UI
```

The LLM only **classifies** the question and **phrases** verified data. It never
invents numbers — the balance always comes from step 3.

---

## Run it locally (mock mode — no SAP or API key needed)

```bash
npm install
cp .env.example .env      # optional; defaults already work in mock mode
npm run watch             # starts CAP on http://localhost:4004
```

Open **http://localhost:4004/** (CAP serves the `app/` folder at web root).
Ask: *"How many vacation days do I have left?"*

- **No `ANTHROPIC_API_KEY`** → uses a keyword classifier + template (still works).
- **With a key** (`.env`) → real Claude intent detection + natural phrasing.

---

## Project layout

| Path | What it is |
|---|---|
| `srv/leave-service.cds` | The public API: one `chat` action |
| `srv/leave-service.js`  | Orchestrates the 4-step pipeline |
| `srv/lib/claude.js`     | Claude intent extraction + answer phrasing (with fallback) |
| `srv/lib/successfactors.js` | Mock data + real SF OData call via Cloud SDK |
| `srv/server.js`         | Loads `.env`, then starts CAP |
| `app/index.html`        | Minimal chat frontend |

---

## Going live — the remaining phases

### Phase 0 — Prove SF API access (do this first, with Postman)
1. Get your SF **API server URL**, a **test user**, and credentials from your SF admin.
2. `GET https://<api-server>/odata/v2/$metadata` to explore entities.
3. `GET https://<api-server>/odata/v2/TimeAccount?$filter=userId eq '<user>'&$format=json`
4. Find the exact entity/fields that hold the balance, and update the query in
   `srv/lib/successfactors.js` (`realAccounts`).

### Phase 1 — Auth + Destination on BTP
1. In SuccessFactors Admin Center → **Manage OAuth2 Client Applications** → register
   a client (upload an X.509 cert). Note the **API Key**.
2. In BTP cockpit → **Connectivity → Destinations** → create one named `SF_TIMEOFF`,
   type `HTTP`, auth = `OAuth2SAMLBearerAssertion`, pointing at the SF API server.

### Phase 2 — Switch to real data
Set in `.env` (local) or as env vars (BTP):
```
SF_MODE=real
SF_DESTINATION=SF_TIMEOFF
```

### Phase 3 — Deploy to BTP Cloud Foundry
```bash
npm i -g @sap/cds-dk         # if not already
cds add hana,xsuaa,destination,mta
mbt build
cf login                     # your BTP trial endpoint
cf deploy mta_archives/*.mtar
```
Then enable `@requires: 'authenticated-user'` in `srv/leave-service.cds` so the
logged-in user (XSUAA) becomes the `userId`.

---

## Notes / cautions
- SuccessFactors has **no public self-service trial** — you need a real tenant
  (employer, SAP partner, or SAP demo system) with API access.
- Time Off entity/field names vary per tenant — always confirm against `$metadata`.
- Keep this app **read-only** for now; submitting leave is a later, bigger step.
