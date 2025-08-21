import playwright, { type BrowserWorker } from '@cloudflare/playwright'
import fs from "@cloudflare/playwright/fs"
import { expect } from "@cloudflare/playwright/test"
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { validator } from 'hono/validator'
import { Buffer } from "node:buffer"
import { Action, deviceConfigs, Job, JobConfig, jobConfigSchema, JobResult } from './interfaces'
const app = new Hono<{ Bindings: CloudflareBindings }>()
app.use('*', cors())

// Utility functions
async function storeJob(job: Job, kv: KVNamespace): Promise<void> {
    await kv.put(`job:${job.id}`, JSON.stringify(job), { expirationTtl: 86400 }) // 24 hours
}

async function getJob(jobId: string, kv: KVNamespace): Promise<Job | null> {
    const jobData = await kv.get(`job:${jobId}`)
    return jobData ? JSON.parse(jobData) : null
}

async function storeScreenshot(jobId: string, screenshotId: string, imageData: Buffer, kv: KVNamespace): Promise<string> {
    const key = `screenshot:${jobId}:${screenshotId}.png`
    await kv.put(key, imageData, { expirationTtl: 86400 })
    return key
}

async function storeTrace(jobId: string, traceData: Buffer, kv: KVNamespace): Promise<string> {
    const key = `trace:${jobId}`
    console.log("Storing trace" + key)
    await kv.put(key, traceData, { expirationTtl: 86400 })
    return key
}

// Helper function to get locator from action
function getLocator(page: any, action: Action) {
    if (action.getByLabel) {
        return page.getByLabel(action.getByLabel)
    }
    if (action.getByText) {
        if (typeof action.getByText === 'string') {
            return page.getByText(action.getByText)
        } else {
            return page.getByText(action.getByText.text, { exact: action.getByText.exact })
        }
    }
    if (action.getByName) {
        return page.getByRole('textbox', { name: action.getByName })
    }
    if (action.selector) {
        return page.locator(action.selector)
    }
    return null
}

function getActionDescription(action: Action): string {
    let locatorDesc = ''
    if (action.getByLabel) {
        locatorDesc = `getByLabel("${action.getByLabel}")`
    } else if (action.getByText) {
        const textValue = typeof action.getByText === 'string' ? action.getByText : action.getByText.text
        locatorDesc = `getByText("${textValue}")`
    } else if (action.getByName) {
        locatorDesc = `getByName("${action.getByName}")`
    } else if (action.selector) {
        locatorDesc = `locator("${action.selector}")`
    }

    let actionDesc = action.type
    if (action.text) {
        actionDesc += ` "${action.text}"`
    }
    if (action.url) {
        actionDesc += ` ${action.url}`
    }

    return locatorDesc ? `${actionDesc} on ${locatorDesc}` : actionDesc
}

// Real Playwright execution using Cloudflare Browser Rendering
async function executePlaywrightSequence(jobId: string, config: JobConfig, browserBinding: BrowserWorker, artifactsKV: KVNamespace): Promise<JobResult> {
    const startTime = Date.now()
    const trace: JobResult['trace'] = { steps: [] }
    const screenshots: string[] = []

    let browser
    let page

    try {
        // Launch browser with configuration
        const deviceConfig = deviceConfigs[config.deviceType]
        const launchOptions: any = {
            keep_alive: 600000 // 10 minutes
        }

        browser = await playwright.launch(browserBinding, launchOptions)
        page = await browser.newPage({
            viewport: config.options?.viewport || deviceConfig.viewport,
            userAgent: config.options?.userAgent || deviceConfig.userAgent
        })

        // Start tracing if requested
        if (config.options?.generateTrace) {
            await page.context().tracing.start({
                screenshots: true,
                snapshots: true
            })
        }

        // Set default timeout
        page.setDefaultTimeout(config.options?.timeout || 30000)

        // Performance tracking
        let loadTime = 0
        let domContentLoaded = 0
        let networkRequests = 0
        let totalBytes = 0

        // Track network requests
        page.on('request', (request) => {
            networkRequests++
        })

        page.on('response', (response) => {
            const headers = response.headers()
            const contentLength = headers['content-length']
            if (contentLength) {
                totalBytes += parseInt(contentLength)
            }
        })

        // Execute actions
        for (let i = 0; i < config.actions.length; i++) {
            const action = config.actions[i]
            const stepStart = Date.now()
            let stepScreenshot: string | undefined

            // Track navigation timing for goto actions
            let navigationStart: number | undefined
            if (action.type === 'goto') {
                navigationStart = Date.now()
            }

            try {
                switch (action.type) {
                    case 'goto':
                        if (action.url) {
                            await page.goto(action.url, { waitUntil: 'domcontentloaded' })
                            if (navigationStart) {
                                domContentLoaded = Date.now() - navigationStart
                                await page.waitForLoadState('load')
                                loadTime = Date.now() - navigationStart
                            }
                        }
                        break

                    case 'click':
                        // TODO: for simplicity, we opt out of strict mode and always select the first match;
                        // this should customizable in the request
                        const clickLocator = getLocator(page, action);
                        if (clickLocator) {
                            await clickLocator.first().click({ timeout: action.timeout })
                        } else if (action.x !== undefined && action.y !== undefined) {
                            await page.mouse.click(action.x, action.y)
                        }
                        break

                    case 'fill':
                        const fillLocator = getLocator(page, action)
                        if (fillLocator && action.text) {
                            await fillLocator.fill(action.text, { timeout: action.timeout })
                        }
                        break

                    case 'scroll':
                        // TODO: for simplicity, we opt out of strict mode and always select the first match;
                        // this should customizable in the request
                        const scrollLocator = getLocator(page, action);
                        if (scrollLocator) {
                            await scrollLocator.first().scrollIntoViewIfNeeded()
                        } else if (action.x !== undefined && action.y !== undefined) {
                            await page.mouse.wheel(action.x, action.y)
                        }
                        break

                    case 'wait':
                        await page.waitForTimeout(action.timeout || 1000);
                        break;

                    case 'expect':
                        if (action.toContainText) {
                            const assertionLocator = getLocator(page, action).first();
                            await expect(assertionLocator).toContainText(action.toContainText);
                        }
                        break;

                    case 'screenshot':
                        const screenshotBuffer = await page.screenshot({ type: 'png' })
                        const screenshotId = crypto.randomUUID();
                        await storeScreenshot(jobId, screenshotId, screenshotBuffer, artifactsKV)
                        screenshots.push(`/api/v1/jobs/${jobId}/screenshots/${screenshotId}.png`)
                        break
                }

                const stepDuration = Date.now() - stepStart
                trace.steps.push({
                    action: getActionDescription(action),
                    timestamp: new Date().toISOString(),
                    duration: stepDuration,
                    success: true,
                    screenshot: stepScreenshot
                })

            } catch (error) {
                const stepDuration = Date.now() - stepStart;
                const errorScreenshotBuffer = await page.screenshot({ type: 'png' }).catch(() => null);
                let errorScreenshot: string | undefined;

                if (errorScreenshotBuffer) {
                    const screenshotId = crypto.randomUUID();
                    await storeScreenshot(jobId, screenshotId, errorScreenshotBuffer, artifactsKV);
                    errorScreenshot = `/api/v1/jobs/${jobId}/screenshots/${screenshotId}.png`;
                }

                trace.steps.push({
                    action: getActionDescription(action),
                    timestamp: new Date().toISOString(),
                    duration: stepDuration,
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error',

                    screenshot: errorScreenshot || undefined
                })

                throw error
            }
        }

        // Stop tracing and save trace file
        if (config.options?.generateTrace) await page.context().tracing.stop({ path: 'trace.zip' });

        const finalUrl = page.url();
        const duration = Date.now() - startTime;

        await browser.close();

        if (config.options?.generateTrace) {
            const file = await fs.promises.readFile("trace.zip");
            await storeTrace(jobId, file, artifactsKV);
            trace.traceViewerUrl = `https://trace.playwright.dev/?trace=https://ghost-playwright.rakhimd.workers.dev/api/v1/jobs/${jobId}/trace`
        }

        return {
            status: 'success',
            duration,
            timestamp: new Date().toISOString(),
            statistics: {
                loadTime,
                domContentLoaded,
                networkRequests,
                totalBytes,
                screenshots,
                finalUrl
            },
            trace
        }

    } catch (error) {
        const duration = Date.now() - startTime;
        let errorScreenshot: string | undefined;

        try {
            if (page) {
                const screenshotBuffer = await page.screenshot({ type: 'png' });
                const screenshotId = crypto.randomUUID();
                await storeScreenshot(jobId, screenshotId, screenshotBuffer, artifactsKV);
                errorScreenshot = `/api/v1/jobs/${jobId}/screenshots/${screenshotId}.png`;
            }
        } catch (screenshotError) {
            // TODO: handle screenshot errors
        }

        if (browser) await browser.close().catch(() => { });

        return {
            status: 'fail',
            duration,
            timestamp: new Date().toISOString(),
            error: {
                message: error instanceof Error ? error.message : 'Unknown error',
                stack: error instanceof Error ? error.stack : undefined,
                screenshot: errorScreenshot
            },
            trace
        }
    }
}

// ROUTES
app.post('/api/v1/jobs',
    validator('json', (value, c) => {
        const result = jobConfigSchema.safeParse(value);
        if (!result.success) {
            return c.json({ error: 'Invalid request body', details: result.error.issues }, 400)
        }
        return result.data;
    }),
    async (c) => {
        const config = c.req.valid('json');
        const jobId = crypto.randomUUID();

        const job: Job = {
            id: jobId,
            status: 'pending',
            createdAt: new Date().toISOString(),
            config
        }

        await storeJob(job, c.env.GHOST_PLAYWRIGHT_JOBS_KV);

        // start execution asynchronously
        // TODO: consider using durable objects? or maybe cloudflare workflows instead
        c.executionCtx.waitUntil(
            (async () => {
                try {
                    const updatedJob = { ...job, status: 'running' as const };
                    await storeJob(updatedJob, c.env.GHOST_PLAYWRIGHT_JOBS_KV);

                    const result = await executePlaywrightSequence(job.id, config, c.env.MYBROWSER, c.env.GHOST_PLAYWRIGHT_ARTIFACTS_KV);

                    const completedJob: Job = {
                        ...job,
                        status: result.status === 'success' ? 'completed' : 'failed',
                        completedAt: new Date().toISOString(),
                        result
                    }

                    await storeJob(completedJob, c.env.GHOST_PLAYWRIGHT_JOBS_KV);
                } catch (error) {
                    console.error('Test execution failed:', error);
                    const failedJob: Job = {
                        ...job,
                        status: 'failed',
                        completedAt: new Date().toISOString(),
                        result: {
                            status: 'fail',
                            duration: 0, // TODO: actually duration should still be real
                            timestamp: new Date().toISOString(),
                            error: {
                                message: error instanceof Error ? error.message : 'Test execution failed',
                                stack: error instanceof Error ? error.stack : undefined
                            }
                        }
                    }
                    await storeJob(failedJob, c.env.GHOST_PLAYWRIGHT_JOBS_KV);
                }
            })()
        )

        return c.json({
            jobId,
            status: 'pending',
            message: 'Test job submitted successfully'
        }, 202);
    }
)

app.get('/api/v1/jobs/:jobId', async (c) => {
    const jobId = c.req.param('jobId');
    const job = await getJob(jobId, c.env.GHOST_PLAYWRIGHT_JOBS_KV);
    if (!job) return c.json({ error: 'Job not found' }, 404);
    return c.json(job);
})

// Get trace file
app.get('/api/v1/jobs/:jobId/trace', async (c) => {
    const jobId = c.req.param('jobId');

    const traceData = await c.env.GHOST_PLAYWRIGHT_ARTIFACTS_KV.get(`trace:${jobId}`, 'arrayBuffer')
    if (!traceData) return c.json({ error: 'Trace file not found' }, 404)

    return new Response(traceData, {
        headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="trace-${jobId}.zip"`,
            'Cache-Control': 'public, max-age=3600'
        }
    });
})

app.delete('/api/v1/jobs/:jobId', async (c) => {
    const jobId = c.req.param('jobId');
    if (!jobId || !jobId.startsWith('job_')) return c.json({ error: 'Invalid job ID' }, 400);

    const job = await getJob(jobId, c.env.GHOST_PLAYWRIGHT_JOBS_KV);
    if (!job) return c.json({ error: 'Job not found' }, 404);

    // Delete job and trace
    await Promise.all([
        c.env.GHOST_PLAYWRIGHT_JOBS_KV.delete(`job:${jobId}`),
        c.env.GHOST_PLAYWRIGHT_ARTIFACTS_KV.delete(`trace:${jobId}`)
    ]);

    // Delete job's screenshots
    const screenshotArtifactKeys = await c.env.GHOST_PLAYWRIGHT_ARTIFACTS_KV.list({ prefix: `screenshot:${jobId}` });
    if (screenshotArtifactKeys.keys.length > 0) {
        await Promise.all(
            screenshotArtifactKeys.keys.map(k => c.env.GHOST_PLAYWRIGHT_ARTIFACTS_KV.delete(k.name))
        );
    }

    return c.json({
        message: 'Job deleted successfully',
        jobId
    });
})

app.get('/api/v1/jobs/:jobId/screenshots/:screenshotId', async (c) => {
    const jobId = c.req.param('jobId');
    const screenshotId = c.req.param('screenshotId')

    // TODO: this is ugly, we expect screenshotId from the url to include `.png` which magically matches the real KV key
    const key = `screenshot:${jobId}:${screenshotId}`;

    const screenshotData = await c.env.GHOST_PLAYWRIGHT_ARTIFACTS_KV.get(key, 'arrayBuffer');
    if (!screenshotData) return c.json({ error: 'Screenshot not found' }, 404);

    return new Response(screenshotData, {
        headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=3600'
        }
    });
})

app.onError((err, c) => {
    console.error('Error:', err)
    return c.json({
        error: 'Internal server error',
        message: err.message
    }, 500)
});

app.notFound((c) => {
    return c.json({
        error: 'Not found',
        message: 'The requested endpoint does not exist'
    }, 404)
});

export default app