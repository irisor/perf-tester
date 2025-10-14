// server.js
// This is the core engine of our performance testing tool.

const express = require('express');

const app = express();
const PORT = 3001;

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

// Middleware to serve our static frontend file and parse JSON bodies
app.use(express.static('public'));
app.use(express.json());

// Health-check endpoint for the root path.
// This now acts as a fallback for the root if `public/index.html` is not found.
app.get('/', (req, res) => {
    res.status(200).send('Performance Tester server is running! (No index.html found)');
});

// The main API endpoint for running a test
app.post('/test', async (req, res) => {
    // LAZY REQUIRE: Load heavy modules only when the endpoint is called.
    const puppeteer = require('puppeteer');
    const axios = require('axios');

    const { url, rules, mode = 'custom', dryRun = false } = req.body; // Add 'dryRun' parameter

    // mode can be: 'custom', 'pagespeed-mobile', 'pagespeed-desktop'

    // A true dry run to test the server without launching Puppeteer at all.
    if (dryRun) {
        console.log('✅ Performing a true dry run (skipping Puppeteer).');
        return res.json({
            message: 'Dry run successful. Server is responsive and Puppeteer was skipped.',
            metrics: { FCP: -1, LCP: -1, mode: 'dry-run' }
        });
    }

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    console.log(`Starting test for URL: ${url} in ${mode} mode`);
    console.log('With rules:', rules);

    let browser; // Define browser in the outer scope for the finally block
    try {
        console.log('[DEBUG] Launching Puppeteer browser...');
        browser = await puppeteer.launch({
            headless: true,
            // Add a timeout for the entire browser launch and connection process
            timeout: 30000,
            // Force the use of the stable Chrome DevTools Protocol
            protocol: 'cdp',
            // Added '--disable-dev-shm-usage' for stability in resource-constrained environments like Cloud Shell
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        console.log('[DEBUG] Browser launched successfully.');

        const testPromise = (async () => {

        const page = await browser.newPage();
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

        // Set cache bypass headers
        await page.setExtraHTTPHeaders({
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
        });

        // Apply network and CPU throttling
        const client = await page.target().createCDPSession();
        await client.send('Network.emulateNetworkConditions', throttlingConfig.network);
        await client.send('Emulation.setCPUThrottlingRate', { rate: throttlingConfig.cpu });

        console.log(`[DEBUG] Throttling applied - CPU: ${throttlingConfig.cpu}x, Network latency: ${throttlingConfig.network.latency}ms`);

        // LCP promise setup
        let resolveLcp;
        const lcpPromise = new Promise(resolve => {
            resolveLcp = resolve;
        });

        // FCP promise setup
        const fcpPromise = new Promise(resolve => {
            page.exposeFunction('__reportFcp', fcp => {
                console.log(`[SERVER]: __reportFcp called from browser with value: ${fcp}`);
                resolve(fcp);
            });
        });

        // Inject performance observers
        // Replace your evaluateOnNewDocument LCP observer section with this:
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

        // Enable request interception for rules
        await page.setRequestInterception(true);

        page.on('request', async (request) => {
            const requestUrl = request.url();
            const resourceType = request.resourceType();

            // Apply blocking rules
            if (rules.block && rules.block.some(fragment => requestUrl.includes(fragment))) {
                console.log('🚫 Blocking:', requestUrl);
                return request.abort();
            }

            // Apply HTML modifications
            if (resourceType === 'document' && request.isNavigationRequest()) {
                try {
                    const response = await axios.get(url, {
                        headers: { 'User-Agent': await browser.userAgent() }
                    });
                    let body = response.data;

                    // Apply defer rule
                    if (rules.defer && rules.defer.length > 0) {
                        console.log('[HTML MOD]: Deferring scripts...');
                        rules.defer.forEach(fragment => {
                            const regex = new RegExp(`(<script[^>]*src="[^"]*${fragment}[^"]*"[^>]*)>`, 'gi');
                            body = body.replace(regex, '$1 defer>');
                        });
                    }

                    // Apply HTML replacement rule
                    if (rules.html_replace && rules.html_replace.find) {
                        console.log('[HTML MOD]: Replacing HTML content...');
                        body = body.replace(new RegExp(rules.html_replace.find, 'g'), rules.html_replace.replace);
                    }

                    return request.respond({ status: 200, contentType: 'text/html', body });
                } catch (e) {
                    console.error('Error fetching/modifying document:', e.message);
                    request.abort('failed');
                    return;
                }
            }

            request.continue();
        });

        // --- Metrics Collection Refactored ---

        // 1. Set up a race for FCP against a timeout.
        const fcpMetricPromise = Promise.race([
            fcpPromise,
            new Promise(resolve => setTimeout(() => resolve(null), 30000)).then(v => {
                console.log('[DEBUG] FCP promise timed out.');
                return v;
            })
        ]);

        // 2. Start navigation. FCP will be captured while the page is loading.
        await page.goto(url, { waitUntil: 'load', timeout: 60000 });
        console.log('[DEBUG] Page "load" event fired.');

        // 3. Wait for the page to settle down after the 'load' event.
        // Using a fixed delay is more reliable than waitForNetworkIdle, which is deprecated in practice.
        console.log('[DEBUG] Waiting 2 seconds for page to settle and LCP to finalize...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log('[DEBUG] Settling delay complete.');

        // 4. Now that the page is idle, collect FCP and LCP.
        // FCP might have already resolved, but we await it here.
        const fcp = await fcpMetricPromise;

        // Retrieve the final LCP value from the browser.
        const lcp = await page.evaluate(() => window.__getFinalLcp());

        // We don't need the complex Promise.all structure anymore.
        // const [fcp, lcp] = await Promise.all([fcpMetricPromise, lcpMetricPromise, interactionsPromise]);

        const metrics = { FCP: fcp, LCP: lcp, mode };
        console.log('[SERVER]: Final metrics collected:', metrics);

        const screenshot = await page.screenshot({ encoding: 'base64' });

        console.log('✅ Test finished successfully.');
        return { metrics, screenshot };
        })();

        // This race condition is now inside the main try block
        const result = await Promise.race([
            testPromise,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Global test timeout: The test took too long to complete (90s).')), 90000)
            )
        ]);
        res.json(result);
    } catch (error) {
        // Log the specific error message
        if (error.name === 'TimeoutError') {
             console.error(`An error occurred during the test: Puppeteer Timeout - ${error.message}`);
        } else if (error.message.includes('Global test timeout')) {
             console.error(`An error occurred during the test: ${error.message}`);
        } else {
             console.error('An error occurred during the test:', error);
        }
        res.status(500).json({ error: 'Test failed. Check server logs for details.' });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});

app.listen(PORT, 'localhost', () => {
    console.log(`🚀 Performance Tester server is running at http://localhost:${PORT}`);
});
