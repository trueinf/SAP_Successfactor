/**
 * Custom CAP bootstrap:
 *   1. Load environment variables from a local .env file.
 *   2. Register a plain REST route GET /api/balances so the dashboard can load
 *      leave data directly (the same path the Netlify function serves), in
 *      addition to the OData POST /api/chat action.
 *   3. Delegate to the standard CAP server.
 */
require('dotenv').config()
const express = require('express')
const cds = require('@sap/cds')
const sf = require('./lib/successfactors')

const currentUser = () => process.env.SF_USER_ID || process.env.MOCK_USER_ID || '103189'

// In-memory store for data PUSHED in by a Zapier automation (Zapier → app).
// This is how Zapier integrates with the app even on the BTP trial: the trial
// blocks *outbound* calls, but *inbound* POSTs to the app are allowed. Zapier
// (which can reach SuccessFactors) fetches the data and pushes it here.
// Note: single-instance in-memory — fine for the CF trial; use a DB for scale.
let lastIngest = null

// Wrap an async producer into an Express JSON handler.
const handle = (producer) => async (req, res) => {
  try {
    res.json(await producer(req))
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
}

cds.on('bootstrap', (app) => {
  app.get('/api/balances', handle(async () => ({ accounts: await sf.getLeaveBalances(currentUser()), source: sf.sfInfo(), userId: currentUser() })))
  app.get('/api/history', handle(async () => ({ history: await sf.getLeaveHistory(currentUser()), userId: currentUser() })))
  app.get('/api/profile', handle(async () => ({ profile: await sf.getProfile(currentUser()), source: sf.sfInfo() })))
  app.get('/api/pay', handle(async () => await sf.getPay(currentUser())))
  app.get('/api/org', handle(async () => await sf.getOrg(currentUser())))
  app.get('/api/recruiting', handle(async () => await sf.getRecruiting()))
  app.get('/api/performance', handle(async () => await sf.getPerformance(currentUser())))
  app.get('/api/payroll', handle(async () => await sf.getPayroll(currentUser())))
  app.get('/api/team', handle(async () => await sf.getTeam(currentUser())))

  app.post('/api/request', express.json(), async (req, res) => {
    try {
      res.json(await sf.submitLeave(currentUser(), req.body || {}))
    } catch (err) {
      res.status(502).json({ ok: false, message: err.message })
    }
  })

  // ---- Zapier integration (inbound push) ----
  // Zapier POSTs SuccessFactors data here; the UI's "Live from Zapier" panel reads it.
  app.post('/api/ingest', express.json({ type: () => true }), (req, res) => {
    const token = req.get('X-Ingest-Token')
    if (process.env.INGEST_TOKEN && token !== process.env.INGEST_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Invalid or missing X-Ingest-Token' })
    }
    lastIngest = { payload: req.body, receivedAt: new Date().toISOString() }
    res.json({ ok: true, receivedAt: lastIngest.receivedAt })
  })
  app.get('/api/ingest', (_req, res) => res.json(lastIngest || { payload: null, receivedAt: null }))
})

module.exports = require('@sap/cds/server')
