/**
 * Custom CAP bootstrap: load environment variables from a local .env file
 * before the CDS server starts, then delegate to the standard CAP server.
 *
 * (On BTP/Cloud Foundry you use bound service credentials and real env vars
 * instead, so the missing .env there is harmless.)
 */
require('dotenv').config()
module.exports = require('@sap/cds/server')
