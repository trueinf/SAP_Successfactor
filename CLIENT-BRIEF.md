# AI Assistant for SAP SuccessFactors — Solution Brief

**Prepared by:** TrueInfo Labs · **Audience:** SuccessFactors customers exploring AI

---

## The opportunity
You already run **SAP SuccessFactors** as your HR system of record. We add a thin, secure **AI layer** on top — a conversational assistant and an employee/manager portal grounded in *your own* SuccessFactors data and policies. It **deflects HR tickets**, speeds up talent decisions, and surfaces insight your team can't get manually. It **complements SAP Joule**; it does not duplicate it.

## What it does (delivered & demonstrable today)
A working employee portal + AI assistant over SuccessFactors, with **7 live modules** on real SuccessFactors APIs:
Time Off · My Profile (Core HR) · Compensation · Organization/Directory · Recruiting · Performance & Goals · Payroll.
The assistant answers natural-language questions ("how many leaves do I have?") and shows a **trace** of every answer (intent → data fetch → phrasing), so results are explainable and **never hallucinated** — numbers always come from SuccessFactors.

## Architecture
```
Employee ─▶ Web app / assistant ─▶ SAP BTP (Destination service, OAuth) ─▶ SuccessFactors OData APIs
                                   └─▶ SAP Generative AI Hub (governed LLM)   (system of record)
                                   └─▶ Document Grounding (RAG over your HR policy PDFs)
```
- **System of record:** SuccessFactors (unchanged).
- **Integration:** SAP BTP **Destination service** (OAuth 2.0 SAML Bearer) — no credentials in the app.
- **AI:** **SAP Generative AI Hub** on BTP — modern LLMs *with* enterprise data-privacy guarantees.
- **Grounding:** retrieve verified data, LLM only phrases it (no invented numbers); optional RAG over your policy docs.
- **Access:** XSUAA login + role scoping (employee vs manager vs HR).

## Three proven ways to connect to SuccessFactors
| Option | Best for | Live UI | HR-data governance |
|---|---|---|---|
| **App via BTP Destination** *(recommended)* | The product UI + AI assistant, production | ✅ | ✅ SAP-native, compliant |
| **App via direct OData** (any cloud host) | Rapid prototyping / demos | ✅ | ⚠️ You own the controls |
| **Zapier / Make** (no-code) | Lightweight automations (digests, Slack, alerts) | ❌ async | ⚠️ Data leaves to a 3rd party |

All three were built and demonstrated. Recommendation: **BTP Destination** for the product; **Zapier/Make** only for side automations.

## Governance (why this is safe for HR data)
- **SAP Generative AI Hub** — no training on your data, content filtering, EU data residency.
- **Grounded answers** — facts come from SuccessFactors, with a visible source trace.
- **RBAC** via XSUAA — the AI sees only what the signed-in user may see.
- **Human-in-the-loop** for any recruiting/performance/comp decision; full audit logging.

## Roadmap
- **Phase 1 (4–6 wks):** Grounded ESS assistant + HR **Policy Q&A (RAG)** on your tenant. *(POC already built.)*
- **Phase 2:** Recruiting generation, manager copilot, leave write-back + approvals.
- **Phase 3:** Predictive analytics (attrition, pay equity), skills/internal mobility.

## What we need from you
A SuccessFactors tenant with **OData API access** (register an OAuth client), a **BTP subaccount**, and access to **AI Core / Generative AI Hub**. We handle the rest.

---
*Note on the demo environment:* The reference build runs on an SAP BTP **trial**, which blocks outbound network egress — so the BTP-hosted demo uses sample data, while the live-data demo runs on a host with open egress. On a **standard/paid BTP subaccount (your environment)**, the app calls your SuccessFactors tenant directly through the Destination — no code changes.
