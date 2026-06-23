/**
 * SuccessFactors data access — step 3 of the pipeline.
 *
 * Three modes, controlled by the SF_MODE env var:
 *
 *   "mock"     (default) : canned data. No SAP at all. For pure app/UI dev.
 *
 *   "sandbox"            : calls the PUBLIC SuccessFactors sandbox on the
 *                          SAP Business Accelerator Hub
 *                          (https://sandbox.api.sap.com/successfactors/odata/v2)
 *                          using a simple APIKey header. No BTP and no real
 *                          tenant needed. Returns REAL demo data.
 *
 *   "real"               : calls a REAL SuccessFactors tenant's OData API via a
 *                          BTP Destination (OAuth2 SAML Bearer). For production.
 *
 * How a leave balance is computed (this is the key SuccessFactors concept):
 *   A balance is NOT stored on TimeAccount. It is the SUM of bookingAmount
 *   across that account's TimeAccountDetail records (ACCRUAL bookings are
 *   positive, usage/payout bookings are negative). We fetch the account with
 *   $expand=timeAccountDetails and sum them. Verified against the live sandbox.
 *
 * The chat pipeline doesn't care which mode is active — it always gets back the
 * same { accountType, balance, unit, asOf } shape.
 */
const MODE = (process.env.SF_MODE || 'mock').toLowerCase()

/**
 * @param {string} userId      requester's SF user id
 * @param {string} [leaveType] optional filter, e.g. 'annual' | 'sick'
 */
async function getLeaveBalances(userId, leaveType) {
  let accounts
  if (MODE === 'real') accounts = await realAccounts(userId)
  else if (MODE === 'sandbox') accounts = await sandboxAccounts(userId)
  else accounts = mockAccounts(userId)

  if (leaveType) {
    const needle = leaveType.toLowerCase()
    const filtered = accounts.filter((a) => a.accountType.toLowerCase().includes(needle))
    if (filtered.length) return filtered // else fall through to all accounts
  }
  return accounts
}

const today = () => new Date().toISOString().slice(0, 10)

// ---- "mock" mode -----------------------------------------------------------

function mockAccounts(userId) {
  return [
    { accountType: 'Annual Leave', balance: 12.5, unit: 'days', asOf: today() },
    { accountType: 'Sick Leave', balance: 8, unit: 'days', asOf: today() },
    { accountType: 'Casual Leave', balance: 3, unit: 'days', asOf: today() },
  ]
}

// ---- "sandbox" mode (Business Accelerator Hub, APIKey auth) -----------------

async function sandboxAccounts(userId) {
  const base = process.env.SF_SANDBOX_URL || 'https://sandbox.api.sap.com/successfactors/odata/v2'
  const apiKey = process.env.SF_API_KEY
  if (!apiKey) {
    throw new Error('SF_MODE=sandbox but SF_API_KEY is not set. Add your Business Accelerator Hub API key to .env.')
  }
  // Sandbox users differ from your HCM-trial persona. Default to a sandbox user
  // that has open Time Off accounts (103189) unless SF_USER_ID overrides it.
  const uid = process.env.SF_USER_ID || userId || '103189'

  const filter = `userId eq '${uid}' and accountClosed eq false`
  const url =
    `${base}/TimeAccount` +
    `?$filter=${encodeURIComponent(filter)}` +
    `&$expand=timeAccountDetails` +
    `&$format=json`

  const res = await fetch(url, { headers: { APIKey: apiKey, Accept: 'application/json' } })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Sandbox call failed: HTTP ${res.status} ${res.statusText} — ${body.slice(0, 200)}`)
  }
  const json = await res.json()
  const rows = (json && json.d && json.d.results) || []
  return summariseAccounts(rows)
}

// ---- "real" mode (real tenant via BTP Destination) -------------------------

async function realAccounts(userId) {
  const { executeHttpRequest } = require('@sap-cloud-sdk/http-client')
  const destination = { destinationName: process.env.SF_DESTINATION || 'SF_TIMEOFF' }

  // Same model as the sandbox — real tenants expose the identical entities.
  const filter = `userId eq '${userId}' and accountClosed eq false`
  const url =
    `/odata/v2/TimeAccount` +
    `?$filter=${encodeURIComponent(filter)}` +
    `&$expand=timeAccountDetails` +
    `&$format=json`

  const response = await executeHttpRequest(destination, { method: 'get', url })
  const rows = (response.data && response.data.d && response.data.d.results) || []
  return summariseAccounts(rows)
}

// ---- Shared: turn TimeAccount + expanded details into balances -------------

/**
 * For each TimeAccount, balance = sum of its TimeAccountDetail.bookingAmount.
 * Accounts of the same accountType are then merged into a single total.
 */
function summariseAccounts(timeAccounts) {
  const byType = new Map()

  for (const acct of timeAccounts) {
    const details = (acct.timeAccountDetails && acct.timeAccountDetails.results) || []
    let balance = 0
    let unit = 'days'
    for (const d of details) {
      const amt = Number(d.bookingAmount)
      if (!Number.isNaN(amt)) balance += amt
      if (d.bookingUnit) unit = String(d.bookingUnit).toLowerCase()
    }

    const type = prettyType(acct.accountType)
    const existing = byType.get(type)
    if (existing) {
      existing.balance += balance
    } else {
      byType.set(type, { accountType: type, balance, unit, asOf: today() })
    }
  }

  // Round to avoid floating-point noise (e.g. 12.499999).
  return [...byType.values()].map((a) => ({ ...a, balance: Math.round(a.balance * 100) / 100 }))
}

// SuccessFactors stores accountType as a code (e.g. "NLD_ADDL"). A human label
// really lives in the TimeAccountType entity; for now we just tidy the code.
// Extend this map as you learn your tenant's real type codes.
const TYPE_LABELS = {
  NLD_ADDL: 'Additional Leave (NLD)',
  ANNUAL: 'Annual Leave',
  SICK: 'Sick Leave',
}
function prettyType(code) {
  if (!code) return 'Leave'
  if (TYPE_LABELS[code]) return TYPE_LABELS[code]
  return String(code)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

module.exports = { getLeaveBalances }
