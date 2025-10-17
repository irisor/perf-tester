// api/index.js
// This is the core engine of our performance testing tool, structured as a Vercel Serverless Function.

/**
 * @fileoverview This file contains the Express server logic for a web performance testing tool.


/**
 * @fileoverview This file contains the Express server logic for a web performance testing tool.
 * It exposes a '/test' endpoint that uses Puppeteer to run performance analysis on a given URL.
 *
 * --- ENVIRONMENT-SPECIFIC BEHAVIOR ---
 * The server's behavior changes based on the NODE_ENV environment variable.
 *
 * 1. Development (local, NODE_ENV is not 'production'):
 *    - Puppeteer launches a full, visible browser (`headless: false`).
 *    - It uses the locally installed Google Chrome browser.
 *    - REQUIREMENTS: Google Chrome must be installed on the local machine.
 *    - To run: `npm run dev`
 *
 * 2. Production (Vercel, NODE_ENV = 'production'):
 *    - Puppeteer uses the `@sparticuz/chromium` package, which is optimized for serverless environments.
 *    - The browser runs in headless mode (`headless: true`).
 *    - It uses specific launch arguments for stability in a containerized environment.
 *    - REQUIREMENTS: The `NODE_ENV` variable must be set to 'production'.
 *      (Note: Vercel sets this automatically for production deployments.)
 *
 * This dual-mode setup provides a rich debugging experience locally while ensuring
 * compatibility and performance in the deployed Vercel environment.
 */

const express = require('express');
const path = require('path');
const fetch = require('node-fetch'); // Use a standard require for node-fetch

const app = express(); // Initialize Express app
const PORT = process.env.PORT || 3001;

// PageSpeed Lighthouse throttling profiles
const LIGHTHOUSE_THROTTLING = {
    mobile: {
        network: {
            offline: false,
            downloadThroughput: 1.6 * 1024 * 1024 / 8, // 1.6 Mbps
            uploadThroughput: 750 * 1024 / 8,          // 750 Kbps
            latency: 150                                // 150ms RTT (4G)
        },
        cpu: 4, // 4x slowdown
        viewport: { width: 412, height: 823 }, // Mobile viewport
        userAgent: 'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Mobile Safari/537.36'
    },
    desktop: {
        network: {
            offline: false,
            downloadThroughput: 10 * 1024 * 1024 / 8,  // 10 Mbps
            uploadThroughput: 5 * 1024 * 1024 / 8,     // 5 Mbps
            latency: 40                                 // 40ms RTT
        },
        cpu: 1, // No CPU throttling for desktop
        viewport: { width: 1350, height: 940 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36'
    }
};

// --- Middleware Configuration ---

// 1. Middleware to parse JSON request bodies.
// Increase payload limit for base64 screenshot
app.use(express.json({ limit: '10mb' }));

/**
 * Executes a single performance test run for a given URL.
 * @param {object} browser - The Puppeteer browser instance.
 * @param {object} options - The test options.
 * @param {string} options.url - The URL to test.
 * @param {object} options.rules - The modification rules.
 * @param {string} options.mode - The test mode ('custom', 'pagespeed-mobile', etc.).
 * @param {boolean} options.disableCache - Whether to disable the browser cache.
 * @returns {Promise<{metrics: object, screenshot: string}>} - The collected metrics and a base64 screenshot.
 */
async function runSingleTest(browser, { url, rules, mode, disableCache }) {
    const page = await browser.newPage();
    try {
        page.on('console', msg => console.log(`[BROWSER]: ${msg.text()}`));

        // Apply PageSpeed settings if requested
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
            // Your custom settings
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

        // Handle cache settings
        await page.setCacheEnabled(!disableCache);
        if (disableCache) {
            await page.setExtraHTTPHeaders({
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
            });
        }

        // Apply network and CPU throttling
        const client = await page.target().createCDPSession();
        await client.send('Network.emulateNetworkConditions', throttlingConfig.network);
        await client.send('Emulation.setCPUThrottlingRate', { rate: throttlingConfig.cpu });

        console.log(`[DEBUG] Throttling applied - CPU: ${throttlingConfig.cpu}x, Network latency: ${throttlingConfig.network.latency}ms`);

        // FCP promise setup - this promise will be resolved by the observer script
        const fcpPromise = new Promise(resolve => {
            page.once('fcp-reported', resolve);
        });

        // Inject performance observers
        await injectPerformanceObservers(page); // This will now also expose the function

        // Enable request interception for rules
        await page.setRequestInterception(true);
        setupRequestInterceptor(page, { rules });

        // --- Metrics Collection ---
        let fcpTimeoutId;
        const fcpMetricPromise = Promise.race([
            fcpPromise.then(fcp => {
                clearTimeout(fcpTimeoutId); // Clear the timeout since FCP was found
                return fcp;
            }),
            new Promise(resolve => {
                fcpTimeoutId = setTimeout(() => resolve(null), 30000);
            })
        ]);

        await page.goto(url, { waitUntil: 'load', timeout: 60000 });
        console.log('[DEBUG] Page "load" event fired.');

        console.log('[DEBUG] Waiting 2 seconds for page to settle and LCP to finalize...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log('[DEBUG] Settling delay complete.');

        const fcp = await fcpMetricPromise;
        const lcp = await page.evaluate(() => window.__getFinalLcp());

        return { FCP: fcp, LCP: lcp };
    } finally {
        await page.close();
    }
}

// The main API endpoint for running a test
app.post('/test', async (req, res) => {
    // LAZY REQUIRE: Load heavy modules only when the endpoint is called.
    // Use puppeteer-core and a serverless-compatible chromium package
    const puppeteer = require('puppeteer-core');
    const chromium = require('@sparticuz/chromium');

    const { url, rules, mode = 'custom', runs = 3, disableCache = false, dryRun = false } = req.body; // Add 'dryRun' parameter

    // mode can be: 'custom', 'pagespeed-mobile', 'pagespeed-desktop'

    // A true dry run to test the server without launching Puppeteer at all.
    if (dryRun) {
        console.log('✅ Performing a true dry run (skipping Puppeteer).');
        return res.json({
            message: 'Dry run successful. Server is responsive and Puppeteer was skipped.',
            //metrics: { FCP: -1, LCP: -1, mode: 'dry-run' }
            parameters: { url: 'dry-run', rules: {}, mode: 'dry-run', disableCache: false },
            averageMetrics: { FCP: -1, LCP: -1 },
            individualRuns: [{ FCP: -1, LCP: -1 }],
            screenshot: ''
        });
    }

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    console.log(`Starting test for URL: ${url} in ${mode} mode`);
    console.log('With rules:', rules);

    let browser;
    try {
        const testRunner = async () => {
            // This block was defined but never called. The logic has been moved outside.
        };

        const result = await Promise.race([
            (async () => {
                // Use @sparticuz/chromium, which works seamlessly locally and in serverless environments.
                console.log('[DEBUG] Preparing to launch browser using @sparticuz/chromium...');
                const launchOptions = {
                    args: chromium.args,
                    defaultViewport: chromium.defaultViewport,
                    executablePath: await chromium.executablePath({headless: true}),
                    headless: chromium.headless, // Automatically handles headless mode for local vs. serverless
                    timeout: 60000, // Increased timeout for browser launch
                };

                console.log('[DEBUG] Launching Puppeteer browser...');
                browser = await puppeteer.launch(launchOptions);
                console.log('[DEBUG] Browser launched successfully.');

                const allMetrics = [];
                for (let i = 0; i < runs; i++) {
                    console.log(`\n--- Starting run ${i + 1} of ${runs} for ${url} ---`);
                    const metrics = await runSingleTest(browser, { url, rules, mode, disableCache });
                    allMetrics.push(metrics);
                    console.log(`--- Finished run ${i + 1}: FCP=${metrics.FCP?.toFixed(2)}ms, LCP=${metrics.LCP?.toFixed(2)}ms ---`);
                }

                // Calculate median values, which are more robust against outliers than averages.
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

                console.log('[SERVER]: Final median metrics:', medianMetrics);

                // Take a screenshot on a final, clean run to ensure it's representative.
                console.log('[DEBUG] Taking final screenshot...');
                const page = await browser.newPage();
                await page.setViewport({ width: 1280, height: 800 });
                await page.goto(url, { waitUntil: 'load' });
                const screenshot = await page.screenshot({ encoding: 'base64' });
                await page.close();

                console.log('✅ All test runs finished successfully.');
                // The frontend expects a specific structure. Let's build it.
                return {
                    parameters: { url, rules, mode, disableCache },
                    averageMetrics: { FCP: medianMetrics.FCP, LCP: medianMetrics.LCP },
                    individualRuns: allMetrics,
                    screenshot
                };
            })(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Global test timeout: The test took too long to complete (${runs * 90}s).`)), runs * 90000)
            )
        ]);
        res.json(result);
    } catch (error) {
        if (error.name === 'TimeoutError') {
             console.error(`An error occurred during the test: Puppeteer Timeout - ${error.message}`);
        } else if (error.message.includes('Global test timeout')) {
             console.error(`An error occurred during the test: ${error.message}`);
        } else {
             console.error('An error occurred during the test:', error);
             // Log the full error for better debugging, especially for launch issues
             console.error('An error occurred during the test:', error.stack || error);
        }
        res.status(500).json({ error: 'Test failed. Check server logs for details.' });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});

/**
 * Injects performance observer scripts into the page to measure FCP and LCP.
 * @param {object} page - The Puppeteer page object.
 */
async function injectPerformanceObservers(page) {
    // Expose a function to the page that the observer can call.
    // We re-expose it for every new page to ensure the binding is fresh.
    await page.exposeFunction('__reportFcp', fcp => {
        console.log(`[SERVER]: __reportFcp called from browser with value: ${fcp}`);
        page.emit('fcp-reported', fcp); // Emit an event on the page object
    });

    await page.evaluateOnNewDocument(() => {
        if (window.self !== window.top) {
            return; // Skip iframes
        }
        console.log('[PERF OBSERVER]: Script injected in main frame.');
        
        // FCP Observer
        new PerformanceObserver((entryList) => {
            const entries = entryList.getEntries();
            const fcpEntry = entries.find(entry => entry.name === 'first-contentful-paint');
            if (fcpEntry && !window.__fcpReported) {
                window.__fcpReported = true;
                console.log(`[PERF OBSERVER]: FCP detected: ${fcpEntry.startTime}ms. Reporting to server.`);
                window.__reportFcp(fcpEntry.startTime);
            }
        }).observe({ type: 'paint', buffered: true });

        // LCP Observer - store ALL updates in an array
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
                console.log(`[PERF OBSERVER]: LCP update #${window.__lcpUpdates.length}: ${lcpData.startTime}ms, element: ${lcpData.element}, size: ${lcpData.size}`);
            });
        }).observe({ type: 'largest-contentful-paint', buffered: true });

        window.__getFinalLcp = () => {
            const finalLcp = window.__lcpUpdates.length > 0
                ? window.__lcpUpdates[window.__lcpUpdates.length - 1].startTime
                : null;
            console.log(`[PERF OBSERVER]: Reporting final LCP: ${finalLcp}ms (total updates: ${window.__lcpUpdates.length})`);
            console.log(`[PERF OBSERVER]: All LCP updates:`, JSON.stringify(window.__lcpUpdates, null, 2));
            return finalLcp;
        };
    });
}

/**
 * Sets up the request interceptor on the page to apply modification rules.
 * @param {object} page - The Puppeteer page object.
 * @param {object} options - The test options.
 */
function setupRequestInterceptor(page, { rules }) {
    page.on('request', async (request) => {
        // Wrap the entire handler in a try-catch to prevent unhandled promise rejections
        // which can crash the Vercel function and prevent logs from appearing.
        try {
            const requestUrl = request.url();
            const resourceType = request.resourceType();

            // Rule: Block requests based on URL fragments
            if (rules.block && rules.block.some(fragment => requestUrl.includes(fragment))) {
                console.log('🚫 Blocking:', requestUrl);
                return request.abort();
            }

            // Rule: Modify the main HTML document
            if (resourceType === 'document' && request.isNavigationRequest()) {
                // To modify the HTML, we must intercept the request, fetch the content ourselves,
                // modify it, and then respond with the modified content.
                try {
                    const fetchResponse = await fetch(requestUrl, {
                        method: request.method(),
                        headers: request.headers(),
                    });
                    
                    if (fetchResponse.ok && fetchResponse.headers.get('content-type')?.includes('text/html')) {
                        let body = await fetchResponse.text();
                        let modified = false;

                        // Apply defer rules
                        (rules.defer || []).forEach(fragment => {
                            const regex = new RegExp(`(<script[^>]*src="[^"]*${fragment}[^"]*"[^>]*)>`, 'gi');
                            if (regex.test(body)) {
                                body = body.replace(regex, '$1 defer>');
                                modified = true;
                                console.log(`[HTML MOD]: Deferred script matching "${fragment}"`);
                            }
                        });

                        // Apply HTML replace rules
                        if (rules.html_replace?.find) {
                            body = body.replace(new RegExp(rules.html_replace.find, 'g'), rules.html_replace.replace);
                            modified = true;
                            console.log('[HTML MOD]: Applied HTML content replacement.');
                        }

                        // Respond with the (potentially modified) body
                        return request.respond({
                            status: fetchResponse.status,
                            headers: Object.fromEntries(fetchResponse.headers.entries()),
                            body: body
                        });
                    }

                    // If the response is not HTML or not OK, we must still handle the request.
                    // We'll respond with the original content we fetched.
                    return request.respond({
                        status: fetchResponse.status,
                        headers: Object.fromEntries(fetchResponse.headers.entries()),
                        body: await fetchResponse.buffer() // Use buffer for any content type
                    });
                } catch (error) {
                    console.error(`[INTERCEPTOR ERROR]: Failed to fetch and modify document for ${requestUrl}:`, error);
                    return request.abort('failed');
                }
            }

            // Continue all other requests without modification
            return request.continue();
        } catch (error) {
            console.error(`[FATAL INTERCEPTOR ERROR] Request handler for "${request.url()}" failed:`, error);
            // Abort the request if it's still pending, to avoid leaving it hanging.
            if (!request.isInterceptResolutionHandled()) {
                request.abort();
            }
        }
    });
}

// --- Server Initialization & Export ---

// Only run the server directly (e.g. `node server.js`) if this file is the main module.
// This prevents the server from starting during Vercel's build process.
// It also allows `npm run dev` to work locally.
if (require.main === module) {
    app.use(express.static(path.join(__dirname, '../public'))); // Serve static files from the root `public` folder
    app.listen(PORT, () => {
        console.log(`🚀 Performance Tester server is running at http://localhost:${PORT}`);
    });
}

module.exports = app;
