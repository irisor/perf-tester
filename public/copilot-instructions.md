# Copilot Instructions for the Website Performance Experiment Tool

## 1. Project Overview

This project is a simple web application designed to measure and visualize the performance impact of certain web optimizations. It acts as a local proxy and testing environment. A user provides a URL and a set of JSON-based rules (e.g., block a script, defer another, modify HTML). The backend then launches a headless browser (Puppeteer), applies these rules on the fly using request interception, and returns key performance metrics (FCP, LCP) and a visual screenshot of the resulting page.

The primary goal is to provide a quick, simple alternative to complex tools like WebPageTest for experimenting with performance hypotheses.

## 2. Technology Stack

* **Backend:** Node.js with the Express.js framework.
* **Browser Automation:** Puppeteer for controlling a headless instance of Chromium.
* **Frontend:** A single `index.html` file using vanilla JavaScript for logic.
* **Styling:** Tailwind CSS loaded via a CDN for the user interface.
* **Package Management:** npm.

## 3. Key Files & Architecture

The project is composed of two main files:

### `server.js` (The Backend Engine)

* This file creates an Express server running on `localhost:3000`.
* It serves the static `public/index.html` file.
* It exposes a single API endpoint: `POST /test`.
* **Core Logic:** When the `/test` endpoint is hit, it:
    1.  Launches a new Puppeteer browser instance.
    2.  Sets HTTP headers to bypass server-side caches for a clean test.
    3.  Enables **request interception**, which is the most critical part of the logic.
    4.  Listens for outgoing requests from the page. If a request URL matches a `block` rule, it's aborted.
    5.  For the main document request, it manually fetches the HTML, applies `defer` and `html_replace` rules to the raw HTML string, and then serves the modified content to the browser.
    6.  After the page loads (`networkidle0`), it uses `page.evaluate()` to access the browser's `performance` API and retrieve FCP and LCP timings.
    7.  It takes a base64-encoded screenshot.
    8.  It returns the metrics and screenshot as a JSON response.

### `public/index.html` (The Frontend Control Panel)

* This is the user interface.
* It contains a form for the user to input the target URL and the JSON rules.
* The `<textarea>` for rules is pre-populated with an example to guide the user.
* The JavaScript logic is contained within a `<script>` tag at the bottom.
* **Core Logic:**
    1.  On form submission, it prevents the default action.
    2.  It parses the JSON from the rules textarea. If parsing fails, it shows an error.
    3.  It makes a `fetch` `POST` request to the `/test` endpoint on the server, sending the URL and parsed rules.
    4.  It handles the UI state (showing a loader, disabling the button).
    5.  Upon receiving a successful response, it calls `displayResults()` to populate the metrics table and display the screenshot.
    6.  If the fetch request fails or the server returns an error, it calls `showError()` to display the error message.

## 4. How to Run the Project

1.  Ensure Node.js is installed.
2.  Navigate to the project's root directory in a terminal.
3.  Run `npm install` to install Express and Puppeteer.
4.  Run `npm start` to start the server.
5.  Open a web browser and go to `http://localhost:3000`.

## 5. Instructions for Assisting with This Project

* **Understand the Core:** Remember that request interception in `server.js` is the heart of this tool. Most feature requests will involve modifying the `page.on('request', ...)` callback.
* **Backend is Key:** The frontend is just a simple controller. The heavy lifting and complex logic reside entirely in `server.js`.
* **Stateless and Isolated:** Each test run is independent. It launches a new browser instance and closes it afterward. There is no persistent state.
* **Potential Improvements:** Good suggestions for future development would include:
    * Running a "control" test (no rules) alongside the "experiment" test and showing a side-by-side comparison.
    * Adding more metrics like Total Blocking Time (TBT) or Cumulative Layout Shift (CLS).
    * Implementing network throttling (e.g., 'Slow 3G') using Puppeteer's `emulateNetworkConditions` method.
    * Adding more rule types, like modifying request headers or simulating minification.
* **Keep it Simple:** The goal of this project is simplicity. Avoid suggestions that add significant complexity, like databases or user accounts, unless specifically asked.