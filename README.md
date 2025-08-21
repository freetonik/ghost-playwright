# Ghost Playwright: Playwright via REST HTTP powered by Cloudflare Workers

```
— Mom, can we have web app end to end testing?
— We have web app end to end testing at home!
```

Playwright testing framework as a service. Submit a sequence of Playwright actions as JSON, get the log, trace, and screenshots. This is just a Wednesday night proof of concept hacky prototype. Do not use in production.

Submit job:

```
POST /api/v1/jobs
content-type: application/json

{
  "deviceType": "desktop",
  "browserType": "chromium",
  "actions": [
    {
        "type": "goto",
        "url": "https://welcome.checklyhq.com/"
    },
    {
        "type": "click",
        "getByText": "/docs"
    },
    {
        "type": "expect",
        "getByAltText": "checkly logo",
        "toBeVisible": true
    },
    {
        "type": "screenshot"
    }
  ],
  "options": {
    "generateTrace": true
  }
}
```

Response:

```
{
  "jobId": "87ed99b7-f372-4392-a046-e56f47256783",
  "status": "pending",
  "message": "Test job submitted successfully"
}
```

Get job:

```
GET /api/v1/jobs/<JOB_ID>
```

Response while job is running:

```
{
  "id": "87ed99b7-f372-4392-a046-e56f47256783",
  "status": "running",
  "createdAt": "2025-08-21T06:45:48.724Z",
  "config": {
    "deviceType": "desktop",
    "browserType": "chromium",
    "actions": [...],
    "options": { ... }
  }
}
```

Response when job has completed successfully:

```
{
  "id": "9d229d4b-9bcf-4867-9866-a317a7c693fb",
  "status": "completed",
  "createdAt": "2025-08-21T06:38:12.715Z",
  "config": {
    "deviceType": "desktop",
    "browserType": "chromium",
    "actions": [...],
    "options": {...}
  },
  "completedAt": "2025-08-21T06:38:40.954Z",
  "result": {
    "status": "success",
    "duration": 25534,
    "timestamp": "2025-08-21T06:38:40.954Z",
    "statistics": {
      "loadTime": 24000,
      "domContentLoaded": 6082,
      "networkRequests": 121,
      "totalBytes": 1217928,
      "screenshots": [
        "/api/v1/jobs/9d229d4b-9bcf-4867-9866-a317a7c693fb/screenshots/edf23531-b0db-4f75-9db4-c2b8a425f5d7.png"
      ],
      "finalUrl": "https://www.checklyhq.com/docs/"
    },
    "trace": {
      "steps": [...],
      "traceViewerUrl": "https://trace.playwright.dev/?trace=https://ghost-playwright.rakhimd.workers.dev/api/v1/jobs/9d229d4b-9bcf-4867-9866-a317a7c693fb/trace"
    }
  }
}
```

Supported parameters for jobs:

- `deviceType`: `'desktop'`, `'mobile'`, or `'tablet'`
- `browserType`: `'chromium'`, `'firefox'`, or `'webkit'`
- `options`:
    - `timeout`: number of milliseconds (this is timeout for the entire job; see `timeout` per action below)
    - `viewport`: `{ width: number; height: number }` (overrides the defaults)
    - `userAgent`: overrides the default
    - `generateTrace`: boolean; when `true` the job result contains text trace, and trace file is generated
- `actions`: array of actions
    - `'click'`
    - `'fill'`
    - `'wait'`
    - `'screenshot'`
    - `'goto'`
    - `'scroll'`
    - `'expect'`

An action is executor on a locator. Supported locators (no support for regular expressions yet):
- `selector`
- `getByLabel`
- `getByText`
- `getByName`
- `getByAltText`

Action-specific properties:
- `timeout`: number of milliseconds (this is timeout per action, not the whole job)
- `text`: used for `fill`
- `url`: used for `goto`
- `x`: used for `scroll`
- `y`: used for `scroll`
- `toContainText`: used for `expect`
- `toBeVisible`: used for `expect`

## Notes and todos

- This is a very limited prototype, I was just learning how Cloudflare's Playwright works
- There are heavy limitations for concurrent browser instances in Cloudflare. It's gonna get better when the feature is out of beta.
- The interfaces are a bit messy; actions should be properly typed separately, instead of single `Action` with a bunch of optional properties. E.g. `GoToAction` should have `url` but not `toContainText`, etc.
- Jobs should run in Durable objects or even better - in [Workflows](https://developers.cloudflare.com/workflows/)
- There is probably a nicer way to generate interfaces from actual Playwright types

### Development and deployment

```txt
npm install
npm run dev
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```txt
npm run cf-typegen
```

To deploy:

```txt
npm run deploy
```

