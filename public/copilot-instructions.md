# Copilot Instructions for the Website Performance Experiment Tool

## 1. Project Overview

This project is a Node.js application that provides an API endpoint to measure and visualize the performance impact of web optimizations. A user provides a URL and a set of JSON-based rules (e.g., block a script, defer another, modify HTML). The backend then launches a headless browser (Puppeteer), applies these rules on the fly, and returns key performance metrics (FCP, LCP), median results over multiple runs, and a final screenshot.

The primary goal is to provide a quick, simple alternative to complex tools like WebPageTest for experimenting with performance hypotheses.

## 2. Technology Stack

* **Backend:** Node.js with the Express.js framework.
* **Browser Automation:** `puppeteer-core` for controlling a headless instance of Chromium.
* **Serverless Browser:** `@sparticuz/chromium` to provide a consistent browser binary across all environments (local, Cloud Shell, Vercel).
* **Frontend:** A single `index.html` file using vanilla JavaScript for logic.
* **Styling:** Tailwind CSS loaded via a CDN for the user interface.
* **Package Management:** npm.

## 3. Key Files & Architecture

The project is primarily composed of two files:

### `public/index.html` (The Frontend Control Panel)

* This is the user interface.
* It contains a form for the user to input the target URL and the JSON rules.
* On form submission, it makes a `fetch` `POST` request to the `/test` endpoint and displays the results.

### `api/index.js` (The Backend Engine)

* This file creates an Express server and is structured as a Vercel Serverless Function.
* For local development, it runs on `localhost:3001` and serves the static `public` directory.
* It exposes a single API endpoint: `POST /test`.
* **Core Logic:** When the `/test` endpoint is hit, it:
    1.  Launches a Puppeteer browser instance using the browser provided by `@sparticuz/chromium`.
    2.  Loops for the specified number of `runs`. In each run (`runSingleTest` function):
        a. Creates a new browser page.
        b. Applies throttling and device emulation based on the selected `mode` (`pagespeed-mobile`, etc.).
        c. Injects `PerformanceObserver` scripts into the page to capture FCP and LCP.
        d. Enables **request interception** (`setupRequestInterceptor` function), which is the most critical part of the logic. It blocks requests matching `block` rules and modifies the initial HTML document for `defer` and `html_replace` rules.
        e. Navigates to the URL and waits for the `load` event.
        f. Waits for a short period for the page to settle and LCP to finalize.
        g. Collects the FCP and LCP metrics and closes the page.
    3.  Calculates the **median** FCP and LCP from all runs for a more stable result.
    4.  Performs one final, clean page load to take a representative screenshot.
    5.  Returns the parameters, median metrics, individual run data, and the screenshot as a JSON response.

## 4. How to Run the Project

1.  Ensure Node.js is installed.
2.  Navigate to the project's root directory in a terminal.
3.  Run `npm install` to install dependencies. This will also download a Chromium binary via `@sparticuz/chromium`.
4.  Run `npm run dev` to start the development server with `nodemon` for automatic restarts.
5.  Open a web browser and go to `http://localhost:3001`.

## 5. Instructions for Assisting with This Project

* **Understand the Core:** Remember that request interception in `api/index.js` (the `setupRequestInterceptor` function) is the heart of this tool. Most feature requests will involve modifying this logic.
* **Backend is Key:** The frontend is a simple controller. The heavy lifting and complex logic reside entirely in `api/index.js`.
* **Stateless and Isolated:** Each test run is independent. It launches a new browser instance and closes it afterward. There is no persistent state.
* **Potential Improvements:** Good suggestions for future development would include:
    * Running a "control" test (no rules) alongside the "experiment" test and showing a side-by-side comparison in the response.
    * Adding more metrics like Total Blocking Time (TBT) or Cumulative Layout Shift (CLS).
    * Adding more rule types, like modifying request headers or simulating minification.
* **Keep it Simple:** The goal of this project is simplicity. Avoid suggestions that add significant complexity, like databases or user accounts, unless specifically asked.