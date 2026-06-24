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

  app.post('/api/request', express.json(), async (req, res) => {
    try {
      res.json(await sf.submitLeave(currentUser(), req.body || {}))
    } catch (err) {
      res.status(502).json({ ok: false, message: err.message })
    }
  })
})

module.exports = require('@sap/cds/server')
