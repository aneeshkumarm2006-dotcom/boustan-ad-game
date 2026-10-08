# Signup webhook

Set the server environment variable `HUBSPOT_SIGNUP_WEBHOOK_URL` to the supplied HubSpot workflow webhook URL in Vercel production, then redeploy. It is configured in the local `.env.local`; do not commit that file. Blank disables delivery. Leave it blank in previews and tests. The legacy CRM_PROVIDER settings do not control this integration.

Successful first registration (or first score save) queues a POST with JSON fields `email`, `name` (the form's nickname), `marketingOptIn`, and `eventId`. Both opted-in and non-opted-in users are sent; receiving the event must not be treated as marketing consent. Existing players and historical queue entries are not imported.

Delivery runs after the response. `/api/cron/hubspot` retries pending events every five minutes on Vercel; configure `CRON_SECRET` as for the existing cron jobs. Other hosting needs an equivalent scheduler. Network/non-2xx failures use exponential backoff up to one hour. Inspect `crm_outbox.lastError`, `attempts`, and `nextAttemptAt` for failures. No contact data or webhook URL is logged.

Delivery is at least once: a crash after HubSpot accepts a request can cause a retry. The stable `eventId` and `Idempotency-Key` are available for receiver deduplication; HubSpot is not assumed to honor that header automatically. A successful HTTP response confirms receipt, not workflow completion.

HubSpot's [incoming webhook trigger documentation](https://knowledge.hubspot.com/workflows/set-when-a-webhook-is-received-workflow-triggers) requires an existing contact matching the workflow's unique property. Configure the workflow to match `email` and map `name` as desired. This endpoint does not create CRM contacts. Creating contacts would additionally require a private app credential and a Contacts API integration.

Tests use mocked HTTP and a disposable database; they never submit synthetic contacts to the real webhook.
