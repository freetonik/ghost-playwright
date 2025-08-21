import { z } from 'zod'

// Types and interfaces
export interface Job {
    id: string
    status: 'pending' | 'running' | 'completed' | 'failed'
    createdAt: string
    completedAt?: string
    config: JobConfig
    result?: JobResult
}

export interface JobConfig {
    deviceType: 'desktop' | 'mobile' | 'tablet'
    browserType: 'chromium' | 'firefox' | 'webkit'
    actions: Action[]
    options?: {
        timeout?: number
        viewport?: { width: number; height: number }
        userAgent?: string
        generateTrace?: boolean
    }
}

export interface Action {
    type: 'click' | 'fill' | 'wait' | 'screenshot' | 'goto' | 'scroll' | 'expect'
    // Locator options - use one of these
    selector?: string
    getByLabel?: string
    getByText?: string | { text: string; exact?: boolean }
    getByName?: string
    // Action-specific properties
    text?: string
    timeout?: number
    url?: string
    x?: number
    y?: number
    toContainText?: string
}

export interface JobResult {
    status: 'success' | 'fail'
    duration: number
    timestamp: string
    statistics?: {
        loadTime: number
        domContentLoaded: number
        networkRequests: number
        totalBytes: number
        screenshots: string[]
        finalUrl: string
    }
    error?: {
        message: string
        stack?: string
        screenshot?: string
    }
    trace?: {
        steps: Array<{
            action: string
            timestamp: string
            duration: number
            success: boolean
            error?: string
            screenshot?: string
        }>
        traceFile?: string
        traceViewerUrl?: string
    }
}

// Validation schemas
export const actionSchema = z.object({
    type: z.enum(['click', 'fill', 'wait', 'screenshot', 'goto', 'scroll', 'expect']),
    // Locator options - only one should be used
    selector: z.string().optional(),
    getByLabel: z.string().optional(),
    getByText: z.union([
        z.string(),
        z.object({
            text: z.string(),
            exact: z.boolean().optional()
        })
    ]).optional(),
    getByName: z.string().optional(),
    // Action-specific properties
    text: z.string().optional(),
    timeout: z.number().min(0).max(60000).optional(),
    url: z.string().url().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    toContainText: z.string().optional()
})

export const jobConfigSchema = z.object({
    deviceType: z.enum(['desktop', 'mobile', 'tablet']),
    browserType: z.enum(['chromium', 'firefox', 'webkit']),
    actions: z.array(actionSchema).min(1).max(50),
    options: z.object({
        timeout: z.number().min(1000).max(300000).optional(),
        viewport: z.object({
            width: z.number().min(320).max(1920),
            height: z.number().min(240).max(1080)
        }).optional(),
        userAgent: z.string().optional(),
        generateTrace: z.boolean().optional()
    }).optional()
})

// Device configurations
export const deviceConfigs = {
    desktop: {
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    mobile: {
        viewport: { width: 375, height: 667 },
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    },
    tablet: {
        viewport: { width: 768, height: 1024 },
        userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    }
}