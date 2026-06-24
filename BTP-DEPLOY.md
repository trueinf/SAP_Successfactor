# Deploy to SAP BTP — app calls SuccessFactors *through* a BTP Destination

This makes **BTP genuinely the connector**: the app runs on Cloud Foundry and
reaches SuccessFactors via the **Destination service** (no API key in the app).
Works today against the **sandbox** (no real tenant needed); for a real tenant
you only change the destination's auth later.

```
Browser → app on BTP Cloud Foundry → BTP Destination service → SuccessFactors
                                       (SF_TIMEOFF, APIKey → sandbox)
```

## Prerequisites
- `cf` CLI installed, logged in to your trial:
  ```
  cf login -a https://api.cf.us10-001.hana.ondemand.com
  ```
  (use your BTP trial email/password; pick org `1851fe3ftrial`, space `dev`)

## Step 1 — Create the Destination service instance
```
cf create-service destination lite sf-destination
```

## Step 2 — Create the `SF_TIMEOFF` destination (in the BTP cockpit)
Cockpit → your subaccount → **Connectivity → Destinations → New Destination**:

| Field | Value |
|---|---|
| Name | `SF_TIMEOFF` |
| Type | `HTTP` |
| URL | `https://sandbox.api.sap.com/successfactors` |
| Proxy Type | `Internet` |
| Authentication | `NoAuthentication` |

Then **Add Property** (Additional Properties):
| Key | Value |
|---|---|
| `URL.headers.APIKey` | *your Business Accelerator Hub API key* |

> `URL.headers.APIKey` tells the Cloud SDK to send an `APIKey` header on every
> call — that's the sandbox's auth. For a **real tenant** later, instead set
> Authentication = `OAuth2SAMLBearerAssertion` and remove this header.

## Step 3 — Deploy
From the project root:
```
cf push
```
This reads `manifest.yml`, pushes the app, and binds `sf-destination`.

## Step 4 — (optional) enable real NLP
The chat works with a keyword fallback by default. For OpenAI:
```
cf set-env leave-assistant LLM_PROVIDER openai
cf set-env leave-assistant OPENAI_API_KEY <your-key>
cf restage leave-assistant
```

## Step 5 — Verify
- `cf apps` → shows `leave-assistant` started, with a route like
  `leave-assistant-<rand>.cfapps.us10-001.hana.ondemand.com`.
- Open that URL → the launchpad loads, calling SuccessFactors **through BTP**.
- In the **BTP cockpit** you'll now see: the app under *Cloud Foundry →
  Applications*, the `sf-destination` instance under *Instances*, and the
  `SF_TIMEOFF` destination under *Connectivity → Destinations*.
- `cf logs leave-assistant --recent` → look for
  `Successfully retrieved destination 'SF_TIMEOFF'`.

## Notes
- Auth is set to `dummy` in production (`package.json` → `cds.requires.auth`)
  so the demo runs without login. For per-user login, switch to `xsuaa` + add
  an App Router (see DEPLOYMENT.md).
- Trial apps stop after a few hours idle — `cf start leave-assistant` to wake.
- This is the *sandbox-via-BTP* setup. For a real tenant: change the destination
  auth to OAuth2 SAML Bearer; no app code change needed.
