// api/test.js
// Standalone serverless function for Vercel - NO EXPRESS DEPENDENCY

/**
 * Vercel Serverless Function for performance testing
 * This is a direct handler without Express middleware
 */

const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

// PageSpeed Lighthouse throttling profiles
const LIGHTHOUSE_THROTTLING = {
    mobile: {
        network: {
            offline: false,
            downloadThroughput: 1.6 * 1024 * 1024 / 8,
            uploadThroughput: 750 * 1024 / 8,
            latency: 150
        },
        cpu: 4,
        viewport: { width: 412, height: 823 },
        userAgent: 'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Mobile Safari/537.36'
    },
    desktop: {
        network: {
            offline: false,
            downloadThroughput: 10 * 1024 * 1024 / 8,
            uploadThroughput: 5 * 1024 * 1024 / 8,
            latency: 40
        },
        cpu: 1,
        viewport: { width: 1350, height: 940 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36'
    }
};

async function runSingleTest(browser, { url, rules, mode, disableCache }) {
    const page = await browser.newPage();
    try {
        page.on('console', msg => console.log(`[BROWSER]: ${msg.text()}`));

        let throttlingConfig;
        if (mode === 'pagespeed-mobile') {
            throttlingConfig = LIGHTHOUSE_THROTTLING.mobile;
            await page.setViewport(throttlingConfig.viewport);
            await page.setUserAgent(throttlingConfig.userAgent);
        } else if (mode === 'pagespeed-desktop') {
            throttlingConfig = LIGHTHOUSE_THROTTLING.desktop;
            await page.setViewport(throttlingConfig.viewport);
            await page.setUserAgent(throttlingConfig.userAgent);
        } else {
            await page.setViewport({ width: 1280, height: 800 });
            throttlingConfig = {
                network: {
                    offline: false,
                    downloadThroughput: 1.5 * 1024 * 1024 / 8,
                    uploadThroughput: 750 * 1024 / 8,
                    latency: 40
                },
                cpu: 4
            };
        }

        await page.setCacheEnabled(!disableCache);
        if (disableCache) {
            await page.setExtraHTTPHeaders({
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
            });
        }

        const client = await page.target().createCDPSession();
        await client.send('Network.emulateNetworkConditions', throttlingConfig.network);
        await client.send('Emulation.setCPUThrottlingRate', { rate: throttlingConfig.cpu });

        console.log(`[DEBUG] Throttling applied - CPU: ${throttlingConfig.cpu}x, Network latency: ${throttlingConfig.network.latency}ms`);

        const fcpPromise = new Promise(resolve => {
            page.once('fcp-reported', resolve);
        });

        await injectPerformanceObservers(page);
        await page.setRequestInterception(true);
        setupRequestInterceptor(page, { rules });

        let fcpTimeoutId;
        const fcpMetricPromise = Promise.race([
            fcpPromise.then(fcp => {
                clearTimeout(fcpTimeoutId);
                return fcp;
            }),
            new Promise(resolve => {
                fcpTimeoutId = setTimeout(() => resolve(null), 30000);
            })
        ]);

        await page.goto(url, { waitUntil: 'load', timeout: 60000 });
        console.log('[DEBUG] Page "load" event fired.');

        await new Promise(resolve => setTimeout(resolve, 2000));

        const fcp = await fcpMetricPromise;
        const lcp = await page.evaluate(() => window.__getFinalLcp());

        return { FCP: fcp, LCP: lcp };
    } finally {
        await page.close();
    }
}

async function injectPerformanceObservers(page) {
    await page.exposeFunction('__reportFcp', fcp => {
        console.log(`[SERVER]: __reportFcp called from browser with value: ${fcp}`);
        page.emit('fcp-reported', fcp);
    });

    await page.evaluateOnNewDocument(() => {
        if (window.self !== window.top) return;
        
        new PerformanceObserver((entryList) => {
            const entries = entryList.getEntries();
            const fcpEntry = entries.find(entry => entry.name === 'first-contentful-paint');
            if (fcpEntry && !window.__fcpReported) {
                window.__fcpReported = true;
                console.log(`[PERF OBSERVER]: FCP detected: ${fcpEntry.startTime}ms`);
                window.__reportFcp(fcpEntry.startTime);
            }
        }).observe({ type: 'paint', buffered: true });

        window.__lcpUpdates = [];
        new PerformanceObserver((entryList) => {
            const entries = entryList.getEntries();
            entries.forEach(entry => {
                const lcpData = {
                    startTime: entry.startTime,
                    size: entry.size,
                    element: entry.element?.tagName || 'unknown',
                    url: entry.url || entry.element?.currentSrc || 'N/A'
                };
                window.__lcpUpdates.push(lcpData);
            });
        }).observe({ type: 'largest-contentful-paint', buffered: true });

        window.__getFinalLcp = () => {
            return window.__lcpUpdates.length > 0
                ? window.__lcpUpdates[window.__lcpUpdates.length - 1].startTime
                : null;
        };
    });
}

function setupRequestInterceptor(page, { rules }) {
    page.on('request', async (request) => {
        try {
            const requestUrl = request.url();
            const resourceType = request.resourceType();

            if (rules.block && rules.block.some(fragment => requestUrl.includes(fragment))) {
                console.log('🚫 Blocking:', requestUrl);
                return request.abort();
            }

            if (resourceType === 'document' && request.isNavigationRequest()) {
                try {
                    const { default: fetch } = await import('node-fetch');
                    const fetchResponse = await fetch(requestUrl, {
                        method: request.method(),
                        headers: request.headers(),
                    });
                    
                    if (fetchResponse.ok && fetchResponse.headers.get('content-type')?.includes('text/html')) {
                        let body = await fetchResponse.text();

                        (rules.defer || []).forEach(fragment => {
                            const regex = new RegExp(`(<script[^>]*src="[^"]*${fragment}[^"]*"[^>]*)>`, 'gi');
                            if (regex.test(body)) {
                                body = body.replace(regex, '$1 defer>');
                                console.log(`[HTML MOD]: Deferred script matching "${fragment}"`);
                            }
                        });

                        if (rules.html_replace?.find) {
                            body = body.replace(new RegExp(rules.html_replace.find, 'g'), rules.html_replace.replace);
                            console.log('[HTML MOD]: Applied HTML content replacement.');
                        }

                        return request.respond({
                            status: fetchResponse.status,
                            headers: Object.fromEntries(fetchResponse.headers.entries()),
                            body: body
                        });
                    }

                    return request.respond({
                        status: fetchResponse.status,
                        headers: Object.fromEntries(fetchResponse.headers.entries()),
                        body: await fetchResponse.buffer()
                    });
                } catch (error) {
                    console.error(`[INTERCEPTOR ERROR]:`, error);
                    return request.abort('failed');
                }
            }

            return request.continue();
        } catch (error) {
            console.error(`[FATAL INTERCEPTOR ERROR]`, error);
            if (!request.isInterceptResolutionHandled()) {
                request.abort();
            }
        }
    });
}

// Main handler function
async function testHandler(req, res) {
    // Set headers first
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    console.log(`[HANDLER] Request received: ${req.method} ${req.url}`);
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
        console.log('[HANDLER] Method not allowed:', req.method);
        return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    let browser;
    
    try {
        // Parse body manually if needed
        let body = req.body;
        if (!body && req.headers['content-type']?.includes('application/json')) {
            const chunks = [];
            for await (const chunk of req) {
                chunks.push(chunk);
            }
            body = JSON.parse(Buffer.concat(chunks).toString());
        }
        
        console.log('[HANDLER] Request body parsed:', JSON.stringify(body));
        
        const { url, rules = {}, mode = 'custom', runs = 3, disableCache = false, dryRun = false } = body;

        if (dryRun) {
            console.log('✅ Dry run requested');
            return res.status(200).json({
                message: 'Dry run successful',
                parameters: { url: 'dry-run', rules: {}, mode: 'dry-run', disableCache: false },
                averageMetrics: { FCP: -1, LCP: -1 },
                individualRuns: [{ FCP: -1, LCP: -1 }],
                screenshot: ''
            });
        }

        if (!url) {
            console.log('[HANDLER] URL missing');
            return res.status(400).json({ error: 'URL is required' });
        }

        console.log(`[HANDLER] Starting test for: ${url} in ${mode} mode with ${runs} runs`);

        const launchOptions = {
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            timeout: 60000,
        };

        console.log('[HANDLER] Launching browser...');
        browser = await puppeteer.launch(launchOptions);
        console.log('[HANDLER] Browser launched');

        const allMetrics = [];
        for (let i = 0; i < runs; i++) {
            console.log(`[HANDLER] Run ${i + 1}/${runs}`);
            const metrics = await runSingleTest(browser, { url, rules, mode, disableCache });
            allMetrics.push(metrics);
            console.log(`[HANDLER] Run ${i + 1} complete: FCP=${metrics.FCP?.toFixed(2)}ms, LCP=${metrics.LCP?.toFixed(2)}ms`);
        }

        const fcpValues = allMetrics.map(m => m.FCP).filter(v => v != null).sort((a, b) => a - b);
        const lcpValues = allMetrics.map(m => m.LCP).filter(v => v != null).sort((a, b) => a - b);

        const getMedian = (arr) => {
            if (arr.length === 0) return null;
            const mid = Math.floor(arr.length / 2);
            return arr.length % 2 !== 0 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
        };

        const medianMetrics = {
            FCP: getMedian(fcpValues),
            LCP: getMedian(lcpValues),
        };

        console.log('[HANDLER] Taking screenshot...');
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });
        await page.goto(url, { waitUntil: 'load' });
        const screenshot = await page.screenshot({ encoding: 'base64' });
        await page.close();

        console.log('[HANDLER] Test complete, sending response');
        
        return res.status(200).json({
            parameters: { url, rules, mode, disableCache },
            averageMetrics: { FCP: medianMetrics.FCP, LCP: medianMetrics.LCP },
            individualRuns: allMetrics,
            screenshot
        });

    } catch (error) {
        console.error('[HANDLER] Error occurred:', error.message);
        console.error('[HANDLER] Stack:', error.stack);
        
        return res.status(500).json({ 
            error: 'Test failed',
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    } finally {
        if (browser) {
            console.log('[HANDLER] Closing browser');
            await browser.close();
        }
    }
}

// For Vercel serverless (production)
if (process.env.VERCEL) {
    module.exports = testHandler;
} else {
    // For local development with Express
    const express = require('express');
    const path = require('path');
    const app = express();
    const PORT = process.env.PORT || 3001;

    app.use(express.json({ limit: '10mb' }));
    app.use(express.static(path.join(__dirname, '../public')));

    app.post('/test', testHandler);

    app.listen(PORT, () => {
        console.log(`🚀 Performance Tester running at http://localhost:${PORT}`);
    });
}
