# Web Performance Tester

A Node.js-based web performance analysis tool that uses Puppeteer to measure key metrics like First Contentful Paint (FCP) and Largest Contentful Paint (LCP). It allows for rule-based modifications of web pages on-the-fly to test the performance impact of potential optimizations.

## Features

- **Core Web Vitals Measurement**: Accurately measures FCP and LCP.
- **Rule-Based Modifications**: Block requests, defer scripts, or replace HTML content to simulate optimizations before implementing them.
- **Multiple Test Modes**:
  - `custom`: Your own defined settings.
  - `pagespeed-mobile`: Simulates Google PageSpeed's mobile test conditions (throttled network/CPU).
  - `pagespeed-desktop`: Simulates Google PageSpeed's desktop test conditions.
- **Robust Metrics**: Runs tests multiple times and calculates the median value to provide stable results, resistant to outliers.
- **Consistent Environment Setup**: Uses `@sparticuz/chromium` to provide a consistent browser environment for both local development (including container-based environments like Google Cloud Shell) and production deployments.
- **Visual Verification**: Returns a Base64-encoded screenshot of the final page load.

## Tech Stack

- **Backend**: Node.js, Express
- **Browser Automation**: Puppeteer (`puppeteer-core`)
- **Serverless Browser**: `@sparticuz/chromium` for Vercel compatibility

---

## Getting Started

### Prerequisites

- Node.js (v18.x or later recommended)

### Installation

1.  Clone the repository:
    ```bash
    git clone <your-repository-url>
    cd perf-tester
    ```

2.  Install the dependencies:
    ```bash
    npm install
    ```
    *Note: The first time you run this, `@sparticuz/chromium` will download a compatible browser binary, which may take a moment.*

## Usage

### 1. Running the Server

To start the server with automatic reloading on file changes (recommended for development), run:

```bash
npm run dev
```

The server will be running at `http://localhost:3001`.

### 2. Using the API

Send a `POST` request to the `/test` endpoint to run a performance analysis.

**Endpoint**: `POST /test`

#### Request Body (JSON)

- `url` (string, **required**): The full URL of the page to test.
- `runs` (number, optional, default: `3`): The number of times to run the test.
- `mode` (string, optional, default: `'custom'`): The test mode. Can be `'custom'`, `'pagespeed-mobile'`, or `'pagespeed-desktop'`.
- `disableCache` (boolean, optional, default: `false`): Set to `true` to disable the browser cache for all runs.
- `dryRun` (boolean, optional, default: `false`): Set to `true` to test server responsiveness without launching a browser.
- `rules` (object, optional): An object defining modifications to apply to the page.
  - `block` (array of strings): A list of URL fragments. Any request whose URL contains one of these fragments will be blocked.
  - `defer` (array of strings): A list of URL fragments. Any `<script>` tag whose `src` contains one of these fragments will have the `defer` attribute added.
  - `html_replace` (object): An object with `find` (string/regex) and `replace` (string) keys to perform a search-and-replace on the raw HTML document.

#### Example `curl` Request

```bash
curl -X POST http://localhost:3001/test \
-H "Content-Type: application/json" \
-d '{
  "url": "https://www.example.com",
  "runs": 3,
  "mode": "pagespeed-mobile",
  "disableCache": true,
  "rules": {
    "block": ["/unwanted-script.js", "google-analytics"],
    "defer": ["/heavy-library.js"],
    "html_replace": {
      "find": "<div id=\"annoying-popup\">.*?</div>",
      "replace": ""
    }
  }
}'
```

#### Success Response (200 OK)

```json
{
    "parameters": {
        "url": "https://www.example.com",
        "rules": { "..."},
        "mode": "pagespeed-mobile",
        "disableCache": true
    },
    "averageMetrics": {
        "FCP": 1234.56,
        "LCP": 2345.67
    },
    "individualRuns": [
        { "FCP": 1230.1, "LCP": 2340.9 },
        { "FCP": 1234.56, "LCP": 2345.67 },
        { "FCP": 1240.2, "LCP": 2350.1 }
    ],
    "screenshot": "iVBORw0KGgoAAAANSUhEUgAABQAAA..."
}
```

---

## Deployment to Vercel

This application is optimized for one-click deployment to Vercel.

### Environment Variables

**No manual environment variables are required** in the Vercel project settings.

The application is designed to work with Vercel's default environment:

- **`NODE_ENV`**: Vercel automatically sets this to `production`. The app detects this and switches to its serverless-compatible browser configuration.
- **`PORT`**: Vercel provides this at runtime, and the Express server is configured to use it automatically.

Simply connect your Git repository to a new Vercel project, and it will deploy.