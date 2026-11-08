'use strict';

const AuditorCore = (() => {
  const MAX_FILE_BYTES = 10 * 1024 * 1024;

  function buildUrl(input) {
    const value = input.trim();
    if (!value || /[\s\u0000-\u001f]/.test(value)) return null;
    try {
      const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function parseDomain(input) {
    const value = input.trim();
    const url = buildUrl(value);
    if (!url) return null;
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./i, '').toLowerCase();
  }

  function safeCell(value) {
    const text = String(value ?? '');
    return /^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r]/.test(text) ? `'${text}` : text;
  }

  function csvCell(value) {
    return `"${safeCell(value).replace(/"/g, '""')}"`;
  }

  function parseLine(line) {
    const parts = line.split('#')[0].replace(/[\u200B-\u200D\uFEFF\r]/g, '').split(',').map(part => part.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return { domain: parts[0].toLowerCase(), id: parts[1].toLowerCase(), type: parts[2] ? parts[2].toUpperCase() : null };
  }

  function audit(content, target, references) {
    const records = new Map();
    let owner = '';
    let manager = '';
    for (const raw of content.split('\n')) {
      const line = raw.split('#')[0].trim();
      const variable = line.match(/^(OWNERDOMAIN|MANAGERDOMAIN)\s*=\s*([^\s]+)/i);
      if (variable) {
        if (variable[1].toUpperCase() === 'OWNERDOMAIN') owner = variable[2].toLowerCase();
        else manager = variable[2].toLowerCase();
        continue;
      }
      const record = parseLine(line);
      if (!record) continue;
      const key = JSON.stringify([record.domain, record.id]);
      if (!records.has(key)) records.set(key, []);
      records.get(key).push(record);
    }
    const ownerDisplay = [owner && `Owner: ${owner}`, manager && `Manager: ${manager}`].filter(Boolean).join(', ');
    return references.map(ref => {
      const matches = records.get(JSON.stringify([ref.domain, ref.id])) || [];
      const match = matches.find(record => !ref.type || record.type === ref.type);
      const result = { target, reference: ref.original, status: 'Not Found', details: 'Missing', owner: ownerDisplay, isError: true };
      if (match) {
        const duplicate = matches.filter(record => record.type === match.type).length > 1;
        result.status = 'Valid';
        result.details = `Matched${duplicate ? ' (duplicate in file)' : ''}`;
        result.isError = false;
      } else if (matches.length) {
        result.status = 'Partial';
        result.details = `Type Mismatch: found ${matches[0].type || 'NONE'}, expected ${ref.type}`;
      }
      return result;
    });
  }

  async function fetchWithRetry(url, signal, retries = 3) {
    let lastError;
    for (let attempt = 0; attempt < retries; attempt++) {
      if (signal.aborted) throw new Error('Aborted');
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, 12000);
      try {
        const response = await fetch(url, { signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'follow', referrerPolicy: 'no-referrer' });
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}`);
          error.retryable = response.status === 429 || response.status >= 500;
          throw error;
        }
        const length = Number(response.headers.get('content-length'));
        if (length > MAX_FILE_BYTES) throw new Error('File exceeds 10 MB limit');
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Empty response body');
        const decoder = new TextDecoder();
        let bytes = 0;
        let text = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_FILE_BYTES) throw new Error('File exceeds 10 MB limit');
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } catch (error) {
          await reader.cancel().catch(() => {});
          throw error;
        }
        return { text, contentType: response.headers.get('content-type') || '' };
      } catch (error) {
        if (signal.aborted) throw new Error('Aborted');
        lastError = controller.signal.aborted ? new Error('Request timed out') : error;
        if (error.message.startsWith('File exceeds') || error.retryable === false) throw lastError;
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
      }
      if (attempt < retries - 1) {
        await new Promise((resolve, reject) => {
          const onAbort = () => { clearTimeout(timer); reject(new Error('Aborted')); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, 1000 * (attempt + 1));
          signal.addEventListener('abort', onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
      }
    }
    throw lastError || new Error('Fetch failed');
  }

  return { buildUrl, parseDomain, safeCell, csvCell, parseLine, audit, fetchWithRetry };
})();

if (typeof module !== 'undefined') module.exports = AuditorCore;
