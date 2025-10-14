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

        // FCP promise setup
        const fcpPromise = new Promise(resolve => {
            page.exposeFunction('__reportFcp', fcp => {
                console.log(`[SERVER]: __reportFcp called from browser with value: ${fcp}`);
                resolve(fcp);
            });
        });

        // Inject performance observers
        await injectPerformanceObservers(page);

        // Enable request interception for rules
        await page.setRequestInterception(true);
        setupRequestInterceptor(page, { url, rules, browser });

        // --- Metrics Collection ---
        const fcpMetricPromise = Promise.race([
            fcpPromise,
            new Promise(resolve => setTimeout(() => resolve(null), 30000)).then(v => {
                console.log('[DEBUG] FCP promise timed out.');
                return v;
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
    const puppeteer = require('puppeteer');
    const axios = require('axios');

    const { url, rules, mode = 'custom', runs = 3, disableCache = false, dryRun = false } = req.body; // Add 'dryRun' parameter

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

    let browser;
    try {
        const testRunner = async () => {
            console.log('[DEBUG] Launching Puppeteer browser...');
            browser = await puppeteer.launch({
                headless: true,
                timeout: 30000,
                protocol: 'cdp',
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            });
            console.log('[DEBUG] Browser launched successfully.');

            const allMetrics = [];
            for (let i = 0; i < runs; i++) {
                console.log(`\n--- Starting run ${i + 1} of ${runs} ---`);
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
                mode,
                runs,
                allRuns: allMetrics // Include all individual run data
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
                parameters: {
                    url,
                    rules,
                    mode,
                    disableCache
                },
                averageMetrics: { FCP: medianMetrics.FCP, LCP: medianMetrics.LCP },
                individualRuns: medianMetrics.allRuns,
                screenshot
            };
        };

        const result = await Promise.race([
            testRunner(),
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
function setupRequestInterceptor(page, { url, rules, browser }) {
    const axios = require('axios');
    page.on('request', async (request) => {
        const requestUrl = request.url();
        const resourceType = request.resourceType();

        if (rules.block && rules.block.some(fragment => requestUrl.includes(fragment))) {
            console.log('🚫 Blocking:', requestUrl);
            return request.abort();
        }

        if (resourceType === 'document' && request.isNavigationRequest()) {
            try {
                const response = await axios.get(url, { headers: { 'User-Agent': await browser.userAgent() } });
                let body = response.data;

                if (rules.defer && rules.defer.length > 0) {
                    console.log('[HTML MOD]: Deferring scripts...');
                    rules.defer.forEach(fragment => {
                        const regex = new RegExp(`(<script[^>]*src="[^"]*${fragment}[^"]*"[^>]*)>`, 'gi');
                        body = body.replace(regex, '$1 defer>');
                    });
                }

                if (rules.html_replace && rules.html_replace.find) {
                    console.log('[HTML MOD]: Replacing HTML content...');
                    body = body.replace(new RegExp(rules.html_replace.find, 'g'), rules.html_replace.replace);
                }
                return request.respond({ status: 200, contentType: 'text/html', body });
            } catch (e) {
                console.error('Error fetching/modifying document:', e.message);
                return request.abort('failed');
            }
        }
        request.continue();
    });
}

app.listen(PORT, 'localhost', () => {
    console.log(`🚀 Performance Tester server is running at http://localhost:${PORT}`);
});
