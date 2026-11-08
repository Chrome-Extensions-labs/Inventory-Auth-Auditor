document.addEventListener('DOMContentLoaded', () => {
  const runBtn = document.getElementById('runBtn');
  const stopBtn = document.getElementById('stopBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const copyBtn = document.getElementById('copyBtn');
  const targetList = document.getElementById('targetList');
  const refList = document.getElementById('refList');
  const fileTypeSel = document.getElementById('fileType');
  const viewModeSel = document.getElementById('viewMode');
  const tableLayoutSel = document.getElementById('tableLayout');
  const batchSizeSel = document.getElementById('batchSize');
  const statusText = document.getElementById('statusText');
  const statsBar = document.getElementById('statsBar');
  const resultsHead = document.getElementById('resultsHead');
  const tableBody = document.querySelector('#resultsTable tbody');
  const progressBar = document.getElementById('progressBar');
  const progressContainer = document.getElementById('progressContainer');
  const targetLabel = document.getElementById('targetLabel');

  let globalResults = [];
  let aborted = false;
  let runController = null;

  loadState();
  updatePlaceholder();

  function saveState() {
    chrome.storage.local.set({
      targets: targetList.value,
      refs: refList.value,
      fileType: fileTypeSel.value,
      viewMode: viewModeSel.value,
      tableLayout: tableLayoutSel.value,
      batchSize: batchSizeSel.value
    });
  }

  function loadState() {
    chrome.storage.local.get(['targets', 'refs', 'fileType', 'viewMode', 'tableLayout', 'batchSize'], (data) => {
      if (data.targets) targetList.value = data.targets;
      if (data.refs) refList.value = data.refs;
      if (data.fileType) fileTypeSel.value = data.fileType;
      if (data.viewMode) viewModeSel.value = data.viewMode;
      if (data.tableLayout) tableLayoutSel.value = data.tableLayout;
      if (data.batchSize) batchSizeSel.value = data.batchSize;
      updatePlaceholder();
    });
  }

  function updatePlaceholder() {
    const mode = fileTypeSel.value;
    if (mode === 'url') {
      targetLabel.textContent = 'Target URLs (direct links)';
      targetList.placeholder = 'https://rakuten.com/app-ads.txt\nhttps://www.voodoo.io/app-ads.txt\npicsart.com/app-ads.txt';
    } else {
      targetLabel.textContent = 'Target Websites';
      targetList.placeholder = 'example.com\nanother-site.com';
    }
  }

  targetList.addEventListener('input', saveState);
  refList.addEventListener('input', saveState);
  fileTypeSel.addEventListener('change', () => { saveState(); updatePlaceholder(); });
  viewModeSel.addEventListener('change', () => { saveState(); renderTable(); });
  tableLayoutSel.addEventListener('change', () => { saveState(); renderTable(); });
  batchSizeSel.addEventListener('change', saveState);

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  const escapeCSV = AuditorCore.csvCell;

  function isLikelyNotPlainText(content, contentType) {
    if (contentType && !contentType.includes('text/plain') && !contentType.includes('text/csv')) {
      if (contentType.includes('text/html') || contentType.includes('application/json') || contentType.includes('application/xml')) {
        return true;
      }
    }
    const trimmed = content.trim().toLowerCase();
    if (trimmed.startsWith('<html') || trimmed.startsWith('<!doctype') || trimmed.startsWith('<?xml')) {
      return true;
    }
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { JSON.parse(trimmed); return true; } catch (e) {}
    }
    const firstLines = trimmed.split('\n').slice(0, 5).join(' ');
    if (firstLines.includes('<head') || firstLines.includes('<body') || firstLines.includes('<meta') || firstLines.includes('<title')) {
      return true;
    }
    return false;
  }

  const parseDomain = AuditorCore.parseDomain;
  const buildUrlFromInput = AuditorCore.buildUrl;

  function fetchWithRetry(url) {
    return AuditorCore.fetchWithRetry(url, runController.signal);
  }

  function getDisplayName(input, mode) {
    if (mode === 'url') {
      return input.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
    }
    return parseDomain(input) || input.trim();
  }

  async function processDirectUrl(rawUrl, references) {
    const url = buildUrlFromInput(rawUrl);
    const display = getDisplayName(rawUrl, 'url');

    if (!url) {
      references.forEach(ref => {
        globalResults.push({ target: display || rawUrl.trim(), reference: ref.original, status: "Error", details: "Invalid URL", owner: "", isError: true });
      });
      return;
    }

    let result = null;
    let error = "Unreachable";

    try {
      result = await fetchWithRetry(url);
    } catch (e) {
      error = e.message || 'Connection Error';
    }

    if (aborted) return;

    if (result && isLikelyNotPlainText(result.text, result.contentType)) {
      result = null;
      error = "Soft 404 / Not a text file";
    }

    if (!result) {
      references.forEach(ref => {
        globalResults.push({ target: display, reference: ref.original, status: "Error", details: error, owner: "", isError: true });
      });
      return;
    }

    processFileContent(result.text, display, references);
  }

  async function processDomain(domain, filename, references) {
    const cleanDomain = parseDomain(domain);
    if (!cleanDomain) {
      references.forEach(ref => {
        globalResults.push({ target: domain, reference: ref.original, status: "Error", details: "Invalid domain", owner: "", isError: true });
      });
      return;
    }

    let result = null;
    let error = "Unreachable";

    try {
      result = await fetchWithRetry(`https://${cleanDomain}/${filename}`);
    } catch (e) {
      error = e.message || 'Connection Error';
      if (!aborted && !/^HTTP |^File exceeds/.test(error)) {
        try {
          result = await fetchWithRetry(`http://${cleanDomain}/${filename}`);
        } catch (fallbackError) {
          error = fallbackError.message || 'Connection Error';
        }
      }
    }

    if (aborted) return;

    if (result && isLikelyNotPlainText(result.text, result.contentType)) {
      result = null;
      error = "Soft 404 / Not a text file";
    }

    if (!result) {
      references.forEach(ref => {
        globalResults.push({ target: cleanDomain, reference: ref.original, status: "Error", details: error, owner: "", isError: true });
      });
      return;
    }

    processFileContent(result.text, cleanDomain, references);
  }

  function processFileContent(content, targetDisplay, references) {
    for (const result of AuditorCore.audit(content, targetDisplay, references)) {
      globalResults.push(result);
    }
  }

  function updateStats() {
    const total = globalResults.length;
    const valid = globalResults.filter(r => r.status === 'Valid').length;
    const partial = globalResults.filter(r => r.status === 'Partial').length;
    const notFound = globalResults.filter(r => r.status === 'Not Found').length;
    const errors = globalResults.filter(r => r.status === 'Error').length;
    statsBar.innerHTML = `<span class="stat-total">Total: ${total}</span> | ` +
      `<span class="stat-valid">Valid: ${valid}</span> | ` +
      `<span class="stat-partial">Partial: ${partial}</span> | ` +
      `<span class="stat-missing">Missing: ${notFound}</span> | ` +
      `<span class="stat-error">Errors: ${errors}</span>`;
  }

  function getGroupedData() {
    const map = new Map();
    globalResults.forEach(row => {
      if (!map.has(row.target)) {
        map.set(row.target, { owner: row.owner, refs: [] });
      }
      const group = map.get(row.target);
      group.refs.push({ reference: row.reference, status: row.status, details: row.details, isError: row.isError });
      if (!group.owner && row.owner) group.owner = row.owner;
    });
    return map;
  }

  function getMaxRefCount() {
    const map = getGroupedData();
    let max = 0;
    map.forEach(g => { if (g.refs.length > max) max = g.refs.length; });
    return max;
  }

  function renderTable() {
    const layout = tableLayoutSel.value;
    const onlyErrors = viewModeSel.value === 'errors';

    tableBody.innerHTML = '';

    if (layout === 'grouped') {
      renderGroupedTable(onlyErrors);
    } else {
      renderStandardTable(onlyErrors);
    }

    updateStats();
  }

  function renderStandardTable(onlyErrors) {
    resultsHead.innerHTML = '<tr><th>Target URL</th><th>Reference</th><th>Result</th><th>Details</th><th>Owner</th></tr>';

    let visibleCount = 0;
    globalResults.forEach(row => {
      if (onlyErrors && !row.isError) return;
      visibleCount++;
      const tr = document.createElement('tr');
      const cls = row.status === 'Valid' ? 'status-valid' : row.status === 'Partial' ? 'status-partial' : 'status-error';
      tr.innerHTML = `<td>${escapeHtml(row.target)}</td><td>${escapeHtml(row.reference)}</td><td class="${cls}">${escapeHtml(row.status)}</td><td>${escapeHtml(row.details)}</td><td>${escapeHtml(row.owner)}</td>`;
      tableBody.appendChild(tr);
    });

    if (globalResults.length > 0) {
      statusText.innerText = onlyErrors ? `Showing ${visibleCount} errors/warnings of ${globalResults.length} total` : `Showing all ${globalResults.length} results`;
    }
  }

  function renderGroupedTable(onlyErrors) {
    const grouped = getGroupedData();
    const maxRefs = getMaxRefCount();

    let headerHtml = '<tr><th>Target URL</th>';
    for (let i = 1; i <= maxRefs; i++) {
      headerHtml += `<th>Reference ${i}</th><th>Result ${i}</th><th>Details ${i}</th>`;
    }
    headerHtml += '<th>Owner</th></tr>';
    resultsHead.innerHTML = headerHtml;

    let visibleCount = 0;
    grouped.forEach((group, target) => {
      const hasError = group.refs.some(r => r.isError);
      if (onlyErrors && !hasError) return;
      visibleCount++;

      let html = `<td>${escapeHtml(target)}</td>`;
      for (let i = 0; i < maxRefs; i++) {
        if (i < group.refs.length) {
          const r = group.refs[i];
          const cls = r.status === 'Valid' ? 'status-valid' : r.status === 'Partial' ? 'status-partial' : 'status-error';
          html += `<td>${escapeHtml(r.reference)}</td><td class="${cls}">${escapeHtml(r.status)}</td><td>${escapeHtml(r.details)}</td>`;
        } else {
          html += '<td></td><td></td><td></td>';
        }
      }
      html += `<td>${escapeHtml(group.owner)}</td>`;

      const tr = document.createElement('tr');
      tr.innerHTML = html;
      tableBody.appendChild(tr);
    });

    if (globalResults.length > 0) {
      const totalTargets = grouped.size;
      statusText.innerText = onlyErrors ? `Showing ${visibleCount} of ${totalTargets} targets (errors/warnings only)` : `Showing all ${totalTargets} targets (${globalResults.length} checks)`;
    }
  }

  runBtn.addEventListener('click', async () => {
    const targets = targetList.value.split('\n').map(l => l.trim()).filter(l => l);
    const rawRefs = refList.value.split('\n').map(l => l.trim()).filter(l => l);
    const mode = fileTypeSel.value;

    if (targets.length === 0 || rawRefs.length === 0) {
      statusText.innerText = 'Please fill in both fields.';
      return;
    }

    const references = rawRefs.map(r => {
      const parsed = AuditorCore.parseLine(r);
      return parsed ? { ...parsed, original: r } : null;
    });

    const invalidLine = references.findIndex(ref => !ref);
    if (invalidLine !== -1) {
      statusText.innerText = `Invalid reference line ${invalidLine + 1}. Format: domain, publisher ID, type`;
      return;
    }

    aborted = false;
    runController = new AbortController();
    progressBar.style.width = '0%';
    runBtn.disabled = true;
    stopBtn.disabled = false;
    progressContainer.style.display = 'block';
    downloadBtn.style.display = 'none';
    copyBtn.style.display = 'none';
    tableBody.innerHTML = '';
    statsBar.innerHTML = '';
    globalResults = [];

    const BATCH_SIZE = Math.max(1, Math.min(5, Number.parseInt(batchSizeSel.value, 10) || 2));
    const startTime = Date.now();

    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      if (aborted) break;
      const batch = targets.slice(i, i + BATCH_SIZE);

      if (mode === 'url') {
        await Promise.all(batch.map(t => processDirectUrl(t, references)));
      } else {
        await Promise.all(batch.map(t => processDomain(t, mode, references)));
      }

      if (aborted) break;
      const done = Math.min(i + batch.length, targets.length);
      const percent = Math.round((done / targets.length) * 100);
      progressBar.style.width = `${percent}%`;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      statusText.innerText = `Processed: ${done} / ${targets.length} (${elapsed}s)`;
    }

    renderTable();
    runBtn.disabled = false;
    stopBtn.disabled = true;
    downloadBtn.style.display = 'inline-block';
    copyBtn.style.display = 'inline-block';

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    if (aborted) {
      statusText.innerText = `Stopped after ${globalResults.length} results (${totalTime}s)`;
    } else {
      statusText.innerText = `Done: ${globalResults.length} results in ${totalTime}s`;
    }
  });

  stopBtn.addEventListener('click', () => {
    aborted = true;
    runController?.abort();
    stopBtn.disabled = true;
    statusText.innerText = 'Stopping...';
  });

  downloadBtn.addEventListener('click', () => {
    const layout = tableLayoutSel.value;

    if (layout === 'grouped') {
      downloadGroupedCSV();
    } else {
      downloadStandardCSV();
    }
  });

  function downloadStandardCSV() {
    let csv = '\uFEFFTarget,Reference,Status,Details,Owner\n';
    globalResults.forEach(r => {
      csv += `${escapeCSV(r.target)},${escapeCSV(r.reference)},${escapeCSV(r.status)},${escapeCSV(r.details)},${escapeCSV(r.owner)}\n`;
    });
    downloadBlob(csv);
  }

  function downloadGroupedCSV() {
    const grouped = getGroupedData();
    const maxRefs = getMaxRefCount();

    let header = '\uFEFFTarget';
    for (let i = 1; i <= maxRefs; i++) {
      header += `,Reference ${i},Status ${i},Details ${i}`;
    }
    header += ',Owner\n';

    let csv = header;
    grouped.forEach((group, target) => {
      let line = escapeCSV(target);
      for (let i = 0; i < maxRefs; i++) {
        if (i < group.refs.length) {
          const r = group.refs[i];
          line += `,${escapeCSV(r.reference)},${escapeCSV(r.status)},${escapeCSV(r.details)}`;
        } else {
          line += ',,,';
        }
      }
      line += `,${escapeCSV(group.owner)}`;
      csv += line + '\n';
    });
    downloadBlob(csv);
  }

  function downloadBlob(csv) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `adstxt_report_${new Date().toISOString().slice(0, 10)}_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  copyBtn.addEventListener('click', () => {
    const layout = tableLayoutSel.value;
    let text = '';

    if (layout === 'grouped') {
      text = copyGroupedText();
    } else {
      text = copyStandardText();
    }

    navigator.clipboard.writeText(text).then(() => {
      const orig = copyBtn.textContent;
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = orig; }, 1500);
    }).catch(() => { statusText.innerText = 'Could not copy results to the clipboard.'; });
  });

  function clipboardCell(value) {
    return AuditorCore.safeCell(value).replace(/[\t\r\n]/g, ' ');
  }

  function copyStandardText() {
    const lines = ['Target\tReference\tStatus\tDetails\tOwner'];
    globalResults.forEach(r => {
      lines.push(`${clipboardCell(r.target)}\t${clipboardCell(r.reference)}\t${clipboardCell(r.status)}\t${clipboardCell(r.details)}\t${clipboardCell(r.owner)}`);
    });
    return lines.join('\n');
  }

  function copyGroupedText() {
    const grouped = getGroupedData();
    const maxRefs = getMaxRefCount();

    let header = 'Target';
    for (let i = 1; i <= maxRefs; i++) {
      header += `\tReference ${i}\tStatus ${i}\tDetails ${i}`;
    }
    header += '\tOwner';

    const lines = [header];
    grouped.forEach((group, target) => {
      let line = clipboardCell(target);
      for (let i = 0; i < maxRefs; i++) {
        if (i < group.refs.length) {
          const r = group.refs[i];
          line += `\t${clipboardCell(r.reference)}\t${clipboardCell(r.status)}\t${clipboardCell(r.details)}`;
        } else {
          line += '\t\t\t';
        }
      }
      line += `\t${clipboardCell(group.owner)}`;
      lines.push(line);
    });
    return lines.join('\n');
  }

});
