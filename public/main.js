const urlSelect = document.getElementById('url-select');
const customUrlGroup = document.getElementById('custom-url-group');
const urlInput = document.getElementById('url-input');
const modeSelect = document.getElementById('mode-select');
const runsSelect = document.getElementById('runs-select');
const disableCacheCheckbox = document.getElementById('disable-cache-checkbox');
const blockRulesInput = document.getElementById('block-rules');
const deferRulesInput = document.getElementById('defer-rules');
const htmlFindInput = document.getElementById('html-find-rule');
const htmlReplaceInput = document.getElementById('html-replace-rule');
const testNameInput = document.getElementById('test-name-input');
const runTestBtn = document.getElementById('run-test');
const statusEl = document.getElementById('status');
const metricsContainer = document.getElementById('metrics-container');
const screenshotEl = document.getElementById('screenshot');
const blockRuleOptions = document.getElementById('block-rule-options');
const deferRuleOptions = document.getElementById('defer-rule-options');
const htmlReplacePresets = document.getElementById('html-replace-presets');
const historyBody = document.getElementById('history-body');
const compareBtn = document.getElementById('compare-btn');
const clearHistoryBtn = document.getElementById('clear-history-btn');
const exportCsvBtn = document.getElementById('export-csv-btn');
const comparisonContainer = document.getElementById('comparison-container');
const comparisonView = document.getElementById('comparison-view');


urlSelect.addEventListener('change', () => {
    if (urlSelect.value === 'custom') {
        customUrlGroup.style.display = 'block';
    } else {
        customUrlGroup.style.display = 'none';
    }
});

// --- History & Comparison Logic ---
let testHistory = JSON.parse(localStorage.getItem('perfTestHistory')) || [];

function renderHistory() {
    historyBody.innerHTML = '';
    testHistory.forEach(result => {
        // Defensive check for the new data structure.
        // This handles old history items that might be in localStorage.
        const params = result.parameters || { url: 'N/A', rules: { block: [], defer: [] }, mode: 'N/A' };
        const metrics = result.averageMetrics || { FCP: null, LCP: null };
        const displayName = result.name || params.url;

        const row = document.createElement('tr');
        let rulesSummary = 'None';
        if (params.rules) {
            rulesSummary = [
                ...(params.rules.block || []),
                ...(params.rules.defer || []),
                params.rules.html_replace ? 'HTML Replace' : ''
            ].filter(Boolean).join(', ');
        }

        row.innerHTML = `
            <td><input type="checkbox" class="compare-checkbox" data-id="${result.id}"></td>
            <td><div class="summary-cell" title="${displayName}">${displayName}</div></td>
            <td>${params.mode}</td>
            <td>${params.disableCache ? 'Disabled' : 'Enabled'}</td>
            <td><div class="summary-cell" title="${rulesSummary || 'None'}">${rulesSummary || 'None'}</div></td>
            <td>${metrics.FCP ? metrics.FCP.toFixed(2) : 'N/A'}</td>
            <td>${metrics.LCP ? metrics.LCP.toFixed(2) : 'N/A'}</td>
        `;
        historyBody.appendChild(row);
    });
}

function saveHistory() {
    localStorage.setItem('perfTestHistory', JSON.stringify(testHistory));
}

clearHistoryBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear all test history?')) {
        testHistory = [];
        saveHistory();
        renderHistory();
        comparisonContainer.style.display = 'none';
    }
});

compareBtn.addEventListener('click', () => {
    const selectedIds = Array.from(document.querySelectorAll('.compare-checkbox:checked')).map(cb => cb.dataset.id);
    if (selectedIds.length < 2) {
        alert('Please select at least two results to compare.');
        return;
    }

    const resultsToCompare = testHistory.filter(result => selectedIds.includes(result.id));
    comparisonView.innerHTML = '';

    resultsToCompare.forEach(result => {
        const item = document.createElement('div');
        item.className = 'comparison-item';
        const displayName = result.name || result.parameters.url;
        const rulesSummary = [
            ...(result.parameters.rules.block || []),
            ...(result.parameters.rules.defer || []),
            result.parameters.rules.html_replace ? `HTML Find: ${result.parameters.rules.html_replace.find}` : ''
        ].filter(Boolean).join(', ');

        item.innerHTML = `
            <h4>${displayName}</h4>
            <p><small>URL: ${result.parameters.url}</small></p>
            <p><strong>Mode:</strong> ${result.parameters.mode} ${result.parameters.disableCache ? '(No Cache)' : ''}</p>
            <p><strong>Avg FCP:</strong> ${result.averageMetrics.FCP ? result.averageMetrics.FCP.toFixed(2) + ' ms' : 'N/A'}</p>
            <p><strong>Avg LCP:</strong> ${result.averageMetrics.LCP ? result.averageMetrics.LCP.toFixed(2) + ' ms' : 'N/A'}</p>
            <p><small><strong>Rules:</strong> ${rulesSummary || 'None'}</small></p>
        `;
        comparisonView.appendChild(item);
    });
    comparisonContainer.style.display = 'block';
    comparisonContainer.scrollIntoView({ behavior: 'smooth' });
});

exportCsvBtn.addEventListener('click', () => {
    if (testHistory.length === 0) {
        alert('No history to export.');
        return;
    }

    // --- 1. Collect all unique rule and run columns ---
    const ruleColumns = new Set();
    let maxRuns = 0;
    testHistory.forEach(result => {
        const rules = result.parameters?.rules || {};
        (rules.block || []).forEach(rule => ruleColumns.add(`block_${rule}`));
        (rules.defer || []).forEach(rule => ruleColumns.add(`defer_${rule}`));
        if (rules.html_replace) {
            ruleColumns.add('html_replace_find');
            ruleColumns.add('html_replace_replace');
        }
        if (result.individualRuns?.length > maxRuns) {
            maxRuns = result.individualRuns.length;
        }
    });

    const sortedRuleColumns = Array.from(ruleColumns).sort();
    const runColumns = [];
    for (let i = 1; i <= maxRuns; i++) {
        runColumns.push(`Run ${i} FCP`);
        runColumns.push(`Run ${i} LCP`);
    }

    // --- 2. Build CSV Header ---
    const header = [
        'Test Name', 'URL', 'Mode', 'Cache Disabled',
        'Avg FCP', 'Avg LCP',
        ...sortedRuleColumns,
        ...runColumns
    ];

    // --- 3. Build CSV Rows ---
    const rows = testHistory.map(result => {
        const params = result.parameters || {};
        const metrics = result.averageMetrics || {};
        const rules = params.rules || {};

        const row = {
            'Test Name': result.name || '',
            'URL': params.url || 'N/A',
            'Mode': params.mode || 'N/A',
            'Cache Disabled': params.disableCache ? '1' : '0',
            'Avg FCP': metrics.FCP?.toFixed(2) || '',
            'Avg LCP': metrics.LCP?.toFixed(2) || '',
        };

        // Populate rule columns
        sortedRuleColumns.forEach(col => {
            if (col.startsWith('block_')) {
                row[col] = (rules.block || []).includes(col.replace('block_', '')) ? '1' : '0';
            } else if (col.startsWith('defer_')) {
                row[col] = (rules.defer || []).includes(col.replace('defer_', '')) ? '1' : '0';
            } else if (col === 'html_replace_find') {
                row[col] = rules.html_replace?.find || '';
            } else if (col === 'html_replace_replace') {
                row[col] = rules.html_replace?.replace || '';
            }
        });

        // Populate individual run columns
        for (let i = 0; i < maxRuns; i++) {
            const run = result.individualRuns?.[i];
            row[`Run ${i + 1} FCP`] = run?.FCP?.toFixed(2) || '';
            row[`Run ${i + 1} LCP`] = run?.LCP?.toFixed(2) || '';
        }

        return header.map(h => `"${(row[h] ?? '').toString().replace(/"/g, '""')}"`).join(',');
    });

    // --- 4. Create and Download CSV File ---
    const csvContent = [header.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `perf-test-history-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
});

document.addEventListener('DOMContentLoaded', renderHistory);

// --- Rule Preset Logic ---
function updateRulesFromCheckboxes(optionsContainer, inputElement) {
    const checkedOptions = Array.from(optionsContainer.querySelectorAll('input:checked'));
    const presetValues = new Set();

    // Get all values from checked boxes. A value can be a comma-separated list.
    checkedOptions.forEach(checkbox => {
        checkbox.value.split(',').forEach(val => {
            if (val.trim()) presetValues.add(val.trim());
        });
    });

    // Get all currently known preset values to help identify custom ones.
    const allPresetValues = new Set();
    optionsContainer.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
        checkbox.value.split(',').forEach(val => {
            if (val.trim()) allPresetValues.add(val.trim());
        });
    });

    // Preserve custom values that the user may have typed manually.
    const currentInputValues = inputElement.value.split(',').map(s => s.trim()).filter(Boolean);
    const customValues = currentInputValues.filter(val => !allPresetValues.has(val));

    const finalValues = new Set([...presetValues, ...customValues]);
    inputElement.value = Array.from(finalValues).join(', ');
}

blockRuleOptions.addEventListener('change', () => updateRulesFromCheckboxes(blockRuleOptions, blockRulesInput));
deferRuleOptions.addEventListener('change', () => updateRulesFromCheckboxes(deferRuleOptions, deferRulesInput));

htmlReplacePresets.addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON') {
        const findValue = e.target.dataset.find;
        const replaceValue = e.target.dataset.replace;

        htmlFindInput.value = findValue;
        htmlReplaceInput.value = replaceValue;
    }
});
// --- End Rule Preset Logic ---

runTestBtn.addEventListener('click', async () => {
    let url = urlSelect.value;
    if (url === 'custom') {
        url = urlInput.value;
    }

    if (!url || !url.startsWith('http')) {
        alert('Please enter a valid URL (e.g., https://example.com)');
        return;
    }

    const mode = modeSelect.value;
    const runs = parseInt(runsSelect.value, 10);
    const disableCache = disableCacheCheckbox.checked;
    const testName = testNameInput.value.trim();

    // Collect and parse rules
    const blockRules = blockRulesInput.value.split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);
    const deferRules = deferRulesInput.value.split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);

    const rules = {
        block: blockRules,
        defer: deferRules
    };

    const htmlFindRule = htmlFindInput.value;
    if (htmlFindRule) {
        rules.html_replace = { find: htmlFindRule, replace: htmlReplaceInput.value };
    }

    // Reset UI
    runTestBtn.disabled = true;
    runTestBtn.innerHTML = '<span class="spinner"></span>Testing...';
    statusEl.textContent = `Testing ${url} (${runs}x runs, Cache: ${disableCache ? 'Off' : 'On'})...`;
    metricsContainer.style.display = 'none';
    screenshotEl.style.display = 'none';
    metricsContainer.innerHTML = '';

    try {
        const response = await fetch('/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: url,
                mode: mode,
                rules: rules,
                runs: runs,
                disableCache: disableCache
            })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || `Server responded with status ${response.status}`);
        }

        const data = await response.json();

        // Add result to history
        const resultRecord = {
            id: `test-${Date.now()}`,
            name: testName,
            parameters: data.parameters,
            averageMetrics: data.averageMetrics,
            individualRuns: data.individualRuns
        };
        testHistory.unshift(resultRecord); // Add to the beginning
        saveHistory();
        renderHistory();

        statusEl.textContent = 'Test complete!';
        metricsContainer.style.display = 'block';
        const runsDetails = data.individualRuns.map((run, i) => `Run ${i+1}: FCP ${run.FCP.toFixed(0)} / LCP ${run.LCP.toFixed(0)}`).join(' | ');
        metricsContainer.innerHTML = `
            <div class="metrics">
                <p><strong>Mode:</strong> ${data.parameters.mode}</p>
                <p><strong>Avg FCP:</strong> ${data.averageMetrics.FCP ? data.averageMetrics.FCP.toFixed(2) + ' ms' : 'N/A'}</p>
                <p><strong>Avg LCP:</strong> ${data.averageMetrics.LCP ? data.averageMetrics.LCP.toFixed(2) + ' ms' : 'N/A'}</p>
                <p><small>${runsDetails}</small></p>
            </div>
        `;

        if (data.screenshot) {
            screenshotEl.src = `data:image/png;base64,${data.screenshot}`;
            screenshotEl.style.display = 'block';
        }

    } catch (error) {
        console.error('Test failed:', error);
        statusEl.innerHTML = `<span class="error">Test Failed: ${error.message}</span>`;
    } finally {
        runTestBtn.disabled = false;
        runTestBtn.textContent = 'Run Test';
    }
});
