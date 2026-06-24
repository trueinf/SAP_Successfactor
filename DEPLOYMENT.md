# Deployment & "going real" guide

This app runs in three data modes (`SF_MODE`): `mock`, `sandbox`, `real`. Local
dev and Netlify use `sandbox`. This guide covers the **production** path:
deploying to **SAP BTP Cloud Foundry** and switching to a **real SuccessFactors
tenant** with **per-user login (XSUAA)**.

> You need: a BTP (Cloud Foundry) subaccount, the `cf` CLI + `@sap/cds-dk` +
> `mbt`, and — for real data — a SuccessFactors tenant with API access.

---

## 1. Deploy to BTP Cloud Foundry

The repo is already structured as a CAP app. Generate the deployment artifacts
and deploy:

```bash
npm i -g @sap/cds-dk mbt    # if not installed
cds add xsuaa,destination,mta   # generates mta.yaml + wires services
mbt build                        # produces mta_archives/*.mtar
cf login                         # your BTP CF endpoint (e.g. api.cf.us10-001.hana.ondemand.com)
cf deploy mta_archives/*.mtar
```

`xs-security.json` (already in the repo) defines the `Employee` role/scope used
by XSUAA. `cds add xsuaa` will reference it.

---

## 2. Enable the real SuccessFactors tenant

1. **Create the OAuth client in SuccessFactors**
   Admin Center → *Manage OAuth2 Client Applications* → register a client and
   upload an X.509 certificate. Note the **API Key** and your **API server URL**.

2. **Create the BTP Destination** named `SF_TIMEOFF`
   BTP cockpit → *Connectivity → Destinations* → New:
   - URL = your SF API server (e.g. `https://api<dc>.successfactors.com`)
   - Authentication = `OAuth2SAMLBearerAssertion`
   - Fill the token service URL, client key (API Key), the certificate, and the
     SAML assertion settings (nameId = the SF user attribute to map).

3. **Switch the app to real mode** — set these as app env vars (CF) or in `.env` locally:
   ```
   SF_MODE=real
   SF_DESTINATION=SF_TIMEOFF
   ```
   No code change: `srv/lib/successfactors.js` already calls the destination via
   the SAP Cloud SDK for balances, history, and request (write-back) in real mode.

---

## 3. Per-user login (XSUAA)

Today the app uses a fixed `SF_USER_ID` (the sandbox demo user). To make it act
as the **logged-in employee**:

1. In `srv/leave-service.cds`, enable auth on the action:
   ```cds
   action chat(message : String) returns ChatResult @(requires: 'authenticated-user');
   ```
   (and protect the `/api/*` routes in `srv/server.js` similarly).
2. The CAP `auth` config already switches to `xsuaa` in production
   (see `package.json` → `cds.requires.auth`).
3. Map the XSUAA user to the SuccessFactors `userId` (e.g. via the SAML
   assertion `nameId` / a user attribute), and use `req.user.id` instead of the
   `SF_USER_ID` fallback — `srv/leave-service.js` already prefers `req.user.id`
   when present.
4. For a browser SSO flow, add an **App Router** (`@sap/approuter`) in front,
   bound to the same XSUAA instance.

---

## Endpoints (same in CAP and Netlify)

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/balances` | Leave balances (dashboard cards/donut/table) |
| GET  | `/api/history`  | Recent leave/absence records |
| POST | `/api/request`  | Submit a leave request (real write-back in `SF_MODE=real`) |
| POST | `/api/chat`     | Natural-language assistant (intent → fetch → phrase, with trace) |

> Note: the public SAP **sandbox is read-only**, so `POST /api/request` returns a
> clearly-labelled *simulated* confirmation there. It performs a real
> `EmployeeTime` create only in `SF_MODE=real`.
