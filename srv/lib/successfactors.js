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
  // Indirect require so bundlers (e.g. Netlify/esbuild) don't pull the heavy
  // Cloud SDK into builds that only ever use mock/sandbox mode.
  const cloudSdkPkg = '@sap-cloud-sdk/http-client'
  const { executeHttpRequest } = require(cloudSdkPkg)
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
  'NLD-SICK': 'Sick Leave (NLD)',
  ANNUAL: 'Annual Leave',
  AnnualLeaveA: 'Annual Leave',
  SICK: 'Sick Leave',
  TRAINING: 'Training',
  TOIL_TAT: 'Time Off in Lieu',
}
function prettyType(code) {
  if (!code) return 'Leave'
  if (TYPE_LABELS[code]) return TYPE_LABELS[code]
  return String(code)
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// Parse SAP OData v2 "/Date(ms)/" strings into YYYY-MM-DD.
function parseSfDate(v) {
  if (!v) return null
  const m = /(-?\d+)/.exec(v)
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : null
}

// Describes the active data source — used by the trace.
function sfInfo() {
  const sources = {
    mock: 'Mock data (no network)',
    sandbox: 'Business Accelerator Hub sandbox',
    real: 'Real tenant via BTP Destination',
  }
  return { mode: MODE, entity: process.env.SF_ENTITY || 'TimeAccount', source: sources[MODE] || MODE }
}

// ---- Leave history (EmployeeTime entity) -----------------------------------

/**
 * Returns the user's recent leave/absence records (not WORK time recordings).
 * @returns {Promise<Array<{timeType,startDate,endDate,days,status,comment}>>}
 */
async function getLeaveHistory(userId) {
  if (MODE === 'mock') return mockHistory()

  const filter = `userId eq '${userId}' and timeType ne 'WORK'`
  const select = 'timeType,startDate,endDate,quantityInDays,quantityInHours,approvalStatus,comment'
  const query = `?$filter=${encodeURIComponent(filter)}&$select=${select}&$orderby=startDate desc&$top=25&$format=json`

  let rows = []
  if (MODE === 'sandbox') {
    const base = process.env.SF_SANDBOX_URL || 'https://sandbox.api.sap.com/successfactors/odata/v2'
    const res = await fetch(`${base}/EmployeeTime${query}`, {
      headers: { APIKey: process.env.SF_API_KEY, Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`History call failed: HTTP ${res.status}`)
    rows = ((await res.json()).d || {}).results || []
  } else {
    // real mode
    const cloudSdkPkg = '@sap-cloud-sdk/http-client'
    const { executeHttpRequest } = require(cloudSdkPkg)
    const destination = { destinationName: process.env.SF_DESTINATION || 'SF_TIMEOFF' }
    const response = await executeHttpRequest(destination, { method: 'get', url: `/odata/v2/EmployeeTime${query}` })
    rows = (response.data && response.data.d && response.data.d.results) || []
  }

  return rows.map((r) => ({
    timeType: prettyType(r.timeType),
    startDate: parseSfDate(r.startDate),
    endDate: parseSfDate(r.endDate),
    days: Number(r.quantityInDays != null ? r.quantityInDays : 0),
    status: r.approvalStatus || 'UNKNOWN',
    comment: r.comment || '',
  }))
}

function mockHistory() {
  return [
    { timeType: 'Annual Leave', startDate: '2026-05-12', endDate: '2026-05-16', days: 5, status: 'APPROVED', comment: 'Family trip' },
    { timeType: 'Sick Leave', startDate: '2026-03-03', endDate: '2026-03-03', days: 1, status: 'APPROVED', comment: '' },
    { timeType: 'Annual Leave', startDate: '2026-07-20', endDate: '2026-07-24', days: 5, status: 'PENDING', comment: 'Summer holiday' },
  ]
}

// ---- Request time off (create EmployeeTime) --------------------------------

/**
 * Submit a leave request. The sandbox is READ-ONLY, so there we validate and
 * return a clearly-labelled SIMULATED confirmation. In real mode this POSTs a
 * new EmployeeTime to the tenant via the BTP Destination.
 * @returns {Promise<{ok,simulated,message,request}>}
 */
async function submitLeave(userId, { timeType, startDate, endDate, days, comment }) {
  if (!timeType || !startDate || !endDate) {
    return { ok: false, simulated: false, message: 'Please provide a leave type, start date and end date.' }
  }
  const request = { userId, timeType, startDate, endDate, days, comment: comment || '' }

  if (MODE === 'real') {
    const cloudSdkPkg = '@sap-cloud-sdk/http-client'
    const { executeHttpRequest } = require(cloudSdkPkg)
    const destination = { destinationName: process.env.SF_DESTINATION || 'SF_TIMEOFF' }
    const body = {
      userId,
      timeType,
      startDate: `/Date(${Date.parse(startDate)})/`,
      endDate: `/Date(${Date.parse(endDate)})/`,
      quantityInDays: String(days || ''),
      approvalStatus: 'PENDING',
      comment: comment || '',
    }
    await executeHttpRequest(destination, { method: 'post', url: '/odata/v2/EmployeeTime', data: body })
    return { ok: true, simulated: false, message: 'Leave request submitted to SuccessFactors.', request }
  }

  // mock / sandbox: read-only -> simulate
  return {
    ok: true,
    simulated: true,
    message:
      MODE === 'sandbox'
        ? 'Simulated submission - the SAP sandbox is read-only, so nothing was written. In a real tenant (SF_MODE=real) this would create the request.'
        : 'Simulated submission (mock mode).',
    request,
  }
}

// ---- Generic OData GET (sandbox APIKey or real Destination) ----------------

async function sfGet(pathAndQuery) {
  if (MODE === 'sandbox') {
    const base = process.env.SF_SANDBOX_URL || 'https://sandbox.api.sap.com/successfactors/odata/v2'
    const res = await fetch(`${base}/${pathAndQuery}`, {
      headers: { APIKey: process.env.SF_API_KEY, Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return ((await res.json()).d || {}).results || []
  }
  if (MODE === 'real') {
    const cloudSdkPkg = '@sap-cloud-sdk/http-client'
    const { executeHttpRequest } = require(cloudSdkPkg)
    const destination = { destinationName: process.env.SF_DESTINATION || 'SF_TIMEOFF' }
    const r = await executeHttpRequest(destination, { method: 'get', url: `/odata/v2/${pathAndQuery}` })
    return (r.data && r.data.d && r.data.d.results) || []
  }
  return [] // mock mode handled by callers
}

const dash = (v) => (v == null || v === '' ? '—' : v)

// ---- Module: Employee Profile (Core HR) ------------------------------------

async function getProfile(userId) {
  if (MODE === 'mock') {
    return {
      userId, name: 'Jordan Doe', email: 'jordan.doe@example.com', jobTitle: 'HR Business Partner',
      department: 'People Operations', division: 'Corporate Services', location: 'Amsterdam',
      company: '2500', costCenter: '2500-2200', payGrade: 'GR-06', employmentType: 'Full-time',
      fte: 1, standardHours: 40, hireDate: '2017-01-01', managerId: '103187', managerName: 'Alex Manager',
      country: 'NLD', timezone: 'Europe/Amsterdam',
    }
  }
  const job = (await sfGet(`EmpJob?$filter=userId eq '${userId}'&$orderby=startDate desc&$top=1&$format=json`))[0] || {}

  let name = `Employee ${userId}`
  let email = ''
  try {
    const u = (await sfGet(`User?$filter=userId eq '${userId}'&$select=firstName,lastName,defaultFullName,email&$format=json`))[0]
    if (u) {
      name = u.defaultFullName || [u.firstName, u.lastName].filter(Boolean).join(' ') || name
      email = u.email || ''
    }
  } catch {}

  let managerName = job.managerId ? `(${job.managerId})` : '—'
  if (job.managerId) {
    try {
      const m = (await sfGet(`User?$filter=userId eq '${job.managerId}'&$select=defaultFullName,firstName,lastName&$format=json`))[0]
      if (m) managerName = m.defaultFullName || [m.firstName, m.lastName].filter(Boolean).join(' ') || managerName
    } catch {}
  }

  return {
    userId, name, email,
    jobTitle: dash(job.jobTitle), department: dash(job.department), division: dash(job.division),
    location: dash(job.location), company: dash(job.company), costCenter: dash(job.costCenter),
    payGrade: dash(job.payGrade), employmentType: dash(job.employmentType),
    fte: job.fte != null ? job.fte : '—', standardHours: job.standardHours != null ? job.standardHours : '—',
    hireDate: parseSfDate(job.startDate) || '—', managerId: job.managerId || '', managerName,
    country: dash(job.countryOfCompany), timezone: dash(job.timezone),
  }
}

// ---- Module: Compensation --------------------------------------------------

async function getPay(userId) {
  if (MODE === 'mock') {
    return { sample: false, userId, components: [
      { component: 'Base Salary', value: 72000, currency: 'EUR', frequency: 'Annual' },
      { component: 'Pension Contribution', value: 1, currency: 'EUR', frequency: 'Monthly' },
    ] }
  }
  let rows = await sfGet(`EmpPayCompRecurring?$filter=userId eq '${userId}'&$top=20&$format=json`)
  let sample = false
  if (!rows.length) { rows = await sfGet(`EmpPayCompRecurring?$top=8&$format=json`); sample = true }
  const components = rows.map((r) => ({
    component: prettyType(r.payComponent), value: r.paycompvalue != null ? Number(r.paycompvalue) : null,
    currency: r.currencyCode || '', frequency: r.frequency || '',
  }))
  return { components, sample, userId }
}

// ---- Module: Organization / Directory --------------------------------------

async function getOrg(userId) {
  if (MODE === 'mock') {
    return {
      self: { department: 'People Operations', division: 'Corporate Services', location: 'Amsterdam', position: '50074022', managerId: '103187' },
      directory: [
        { userId: '103187', name: 'Alex Manager', email: 'alex@example.com' },
        { userId: '103190', name: 'Sam Colleague', email: 'sam@example.com' },
      ],
    }
  }
  const job = (await sfGet(`EmpJob?$filter=userId eq '${userId}'&$orderby=startDate desc&$top=1&$format=json`))[0] || {}
  let directory = []
  try {
    const users = await sfGet(`User?$top=12&$select=userId,firstName,lastName,email&$format=json`)
    directory = users.map((u) => ({ userId: u.userId, name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.userId, email: u.email || '' }))
  } catch {}
  return {
    self: { department: dash(job.department), division: dash(job.division), location: dash(job.location), position: dash(job.position), managerId: dash(job.managerId) },
    directory,
  }
}

// ---- Module: Recruiting ----------------------------------------------------

async function getRecruiting() {
  if (MODE === 'mock') {
    return {
      requisitions: [{ id: '3', title: 'Marketing Manager', status: 'Open', openings: 1 }],
      candidates: [{ id: '1283', name: 'Jamie Lee', location: 'Tokyo, Japan', email: 'jamie@example.com' }],
    }
  }
  let requisitions = [], candidates = []
  try {
    const r = await sfGet(`JobRequisition?$top=10&$select=jobReqId,jobCode,internalStatus,numberOpenings,templateName&$format=json`)
    requisitions = r.map((x) => ({ id: x.jobReqId, title: x.templateName || `Job ${x.jobCode || x.jobReqId}`, status: x.internalStatus || '—', openings: x.numberOpenings != null ? x.numberOpenings : '—' }))
  } catch {}
  try {
    const c = await sfGet(`Candidate?$top=10&$select=candidateId,firstName,lastName,city,country,primaryEmail&$format=json`)
    candidates = c.map((x) => ({ id: x.candidateId, name: [x.firstName, x.lastName].filter(Boolean).join(' ') || `Candidate ${x.candidateId}`, location: [x.city, x.country].filter(Boolean).join(', '), email: x.primaryEmail || '' }))
  } catch {}
  return { requisitions, candidates }
}

// ---- Module: Performance & Goals (review forms) ----------------------------

async function getPerformance(userId) {
  if (MODE === 'mock') {
    return { sample: false, forms: [
      { id: '1', title: 'Annual Review 2026', type: 'Review', period: '2026-01-01 → 2026-12-31', due: '2026-12-15', rated: true, rating: 4.2 },
      { id: '2', title: 'Mid-Year Check-in', type: 'Review', period: '2026-01-01 → 2026-06-30', due: '2026-07-10', rated: false, rating: null },
    ] }
  }
  let rows = await sfGet(`FormHeader?$filter=formSubjectId eq '${userId}'&$top=20&$format=json`)
  let sample = false
  if (!rows.length) { rows = await sfGet(`FormHeader?$top=12&$format=json`); sample = true }
  const forms = rows.map((r) => ({
    id: r.formDataId,
    title: r.formTitle || `${r.formTemplateType || 'Form'}${r.formSubjectId ? ' · ' + r.formSubjectId : ''}`,
    type: r.formTemplateType || '—',
    period: [parseSfDate(r.formReviewStartDate), parseSfDate(r.formReviewEndDate)].filter(Boolean).join(' → ') || '—',
    due: parseSfDate(r.formReviewDueDate) || '—',
    rated: Boolean(r.isRated) && String(r.isRated) !== 'false',
    rating: r.rating != null ? Number(r.rating) : null,
  }))
  return { forms, sample }
}

// ---- Module: Payroll (pay statements / payroll runs) -----------------------

async function getPayroll(userId) {
  if (MODE === 'mock') {
    return { sample: false, runs: [
      { payDate: '2026-05-31', period: '2026-05-01 → 2026-05-31', type: 'Regular', currency: 'EUR', status: 'AVAILABLE' },
      { payDate: '2026-04-30', period: '2026-04-01 → 2026-04-30', type: 'Regular', currency: 'EUR', status: 'AVAILABLE' },
    ] }
  }
  let rows = await sfGet(`EmployeePayrollRunResults?$filter=userId eq '${userId}'&$top=20&$format=json`)
  let sample = false
  if (!rows.length) { rows = await sfGet(`EmployeePayrollRunResults?$top=12&$format=json`); sample = true }
  const runs = rows
    .map((r) => ({
      payDate: parseSfDate(r.payDate) || '—',
      period: [parseSfDate(r.startDateWhenPaid), parseSfDate(r.endDateWhenPaid)].filter(Boolean).join(' → ') || '—',
      type: r.payrollRunType || '—',
      currency: r.currency || '—',
      status: r.payStatementAvailability || '—',
    }))
    .sort((a, b) => (a.payDate < b.payDate ? 1 : -1))
  return { runs, sample }
}

// ---- Module: My Team / Org (manager + peers) -------------------------------

async function resolveName(uid) {
  try {
    const u = (await sfGet(`User?$filter=userId eq '${uid}'&$select=defaultFullName,firstName,lastName&$format=json`))[0]
    if (u) return u.defaultFullName || [u.firstName, u.lastName].filter(Boolean).join(' ') || `Employee ${uid}`
  } catch {}
  return `Employee ${uid}`
}

async function getTeam(userId) {
  if (MODE === 'mock') {
    return {
      manager: { userId: '103187', name: 'Alex Manager' },
      members: [
        { userId, name: 'Jordan Doe', jobTitle: 'HR Business Partner', isMe: true },
        { userId: '103198', name: 'Sam Payroll', jobTitle: 'Payroll Admin', isMe: false },
      ],
    }
  }
  const job = (await sfGet(`EmpJob?$filter=userId eq '${userId}'&$orderby=startDate desc&$top=1&$format=json`))[0] || {}
  const mgrId = job.managerId
  const manager = { userId: mgrId || '', name: mgrId ? await resolveName(mgrId) : '—' }

  let members = []
  if (mgrId) {
    const rows = await sfGet(`EmpJob?$filter=managerId eq '${mgrId}'&$select=userId,jobTitle&$top=25&$format=json`)
    // de-dup by userId (a user can have multiple EmpJob rows)
    const seen = new Set()
    const unique = rows.filter((r) => (seen.has(r.userId) ? false : seen.add(r.userId)))
    members = await Promise.all(
      unique.map(async (r) => ({
        userId: r.userId,
        name: await resolveName(r.userId),
        jobTitle: r.jobTitle || '—',
        isMe: r.userId === userId,
      }))
    )
  }
  return { manager, members }
}

module.exports = {
  getLeaveBalances, getLeaveHistory, submitLeave, sfInfo,
  getProfile, getPay, getOrg, getRecruiting, getPerformance, getPayroll, getTeam,
}
