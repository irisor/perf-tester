// server.js
// This is the core engine of our performance testing tool.

const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer');

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

// The main API endpoint for running a test
app.post('/test', async (req, res) => {
    const { url, rules, mode = 'custom' } = req.body; // Add 'mode' parameter

    // mode can be: 'custom', 'pagespeed-mobile', 'pagespeed-desktop'

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    console.log(`Starting test for URL: ${url} in ${mode} mode`);
    console.log('With rules:', rules);

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
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

        // Navigation and metrics collection
        const navigationPromise = page.goto(url, { waitUntil: 'load', timeout: 60000 });

        const fcpMetricPromise = Promise.race([
            fcpPromise,
            new Promise(resolve => setTimeout(() => resolve(null), 30000))
        ]);

        const lcpMetricPromise = Promise.race([
            lcpPromise,
            new Promise(resolve => setTimeout(() => resolve(null), 30000))
        ]);

        const interactionsPromise = (async () => {
            await navigationPromise;

            // Wait a few seconds for content to render and LCP to update
            await new Promise(resolve => setTimeout(resolve, 3000));

            // THEN wait for network idle
            await page.waitForNetworkIdle({ idleTime: 500, timeout: 20000 });

            // Add this to your interactionsPromise, right before getting final LCP:
            const lcpCandidates = await page.evaluate(() => {
                const entries = performance.getEntriesByType('largest-contentful-paint');
                return entries.map(e => ({
                    startTime: e.startTime,
                    size: e.size,
                    element: e.element?.tagName,
                    url: e.url || e.element?.currentSrc || 'N/A'
                }));
            });
            console.log('[DEBUG] All LCP candidates:', JSON.stringify(lcpCandidates, null, 2));

            // Get final LCP before any scrolling (PageSpeed doesn't scroll)
            const finalLcp = await page.evaluate(() => window.__getFinalLcp());
            resolveLcp(finalLcp);

            // Optional: Only scroll in custom mode for your optimization tests
            // if (mode === 'custom') {
            //     await page.evaluate(() => {
            //         return new Promise(resolve => {
            //             let totalHeight = 0;
            //             const distance = 100;
            //             const timer = setInterval(() => {
            //                 const scrollHeight = document.body.scrollHeight;
            //                 window.scrollBy(0, distance);
            //                 totalHeight += distance;
            //                 if (totalHeight >= scrollHeight) { clearInterval(timer); resolve(); }
            //             }, 100);
            //         });
            //     });
            // }
        })();

        const [fcp, lcp] = await Promise.all([fcpMetricPromise, lcpMetricPromise, interactionsPromise]);

        const metrics = { FCP: fcp, LCP: lcp, mode };
        console.log('[SERVER]: Final metrics collected:', metrics);

        const screenshot = await page.screenshot({ encoding: 'base64' });

        console.log('✅ Test finished successfully.');
        res.json({ metrics, screenshot });

    } catch (error) {
        console.error('An error occurred during the test:', error);
        res.status(500).json({ error: 'Test failed. Check server logs for details.' });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Performance Tester server is running at http://localhost:${PORT}`);
});
