// TJ Record page logger. Runs in the page's own JavaScript world so it can see console calls,
// fetch/XHR traffic and user actions. It only queues events: relay.js (extension world) tells it
// whether this tab is being recorded, then receives batches through a DOM event.
(() => {
  if (window.__tjrLogger) return;
  try {
    Object.defineProperty(window, '__tjrLogger', { value: true });
  } catch (e) {
    return;
  }

  const now = () => performance.timeOrigin + performance.now();
  const MAX_BODY = 64 * 1024;
  const MAX_TEXT = 4000;
  const MAX_QUEUE = 3000;

  /* ---------- queue + channel to relay.js ---------- */
  let state = 'pending'; // pending → live | off
  const queue = [];
  let timer = 0;

  const flush = () => {
    clearTimeout(timer);
    timer = 0;
    if (state !== 'live' || !queue.length) return;
    let detail;
    try {
      detail = JSON.stringify(queue.splice(0, queue.length));
    } catch (e) {
      return;
    }
    document.dispatchEvent(new CustomEvent('tjr:events', { detail }));
  };

  const emit = (ev) => {
    if (state === 'off') return;
    if (!ev.at) ev.at = now();
    queue.push(ev);
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
    if (state === 'live' && !timer) timer = setTimeout(flush, 250);
  };

  document.addEventListener('tjr:control', (e) => {
    const cmd = typeof e.detail === 'string' ? e.detail : '';
    if (cmd === 'live') {
      state = 'live';
      flush();
    } else if (cmd === 'flush') {
      flushInputs();
      flush();
    } else if (cmd === 'off') {
      state = 'off';
      queue.length = 0;
    }
  });

  /* ---------- formatting ---------- */
  const isError = (v) => !!v && typeof v === 'object' && typeof v.message === 'string' && typeof v.stack === 'string';
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  const describeNode = (n) => {
    if (!n || !n.nodeName) return String(n);
    if (n.nodeType !== 1) return n.nodeName.toLowerCase();
    return '<' + n.nodeName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.classList && n.classList[0] ? '.' + n.classList[0] : '') + '>';
  };
  const safeJson = (v, max) => {
    const seen = new WeakSet();
    let out;
    try {
      out = JSON.stringify(v, (k, val) => {
        if (typeof val === 'bigint') return val.toString() + 'n';
        if (typeof val === 'function') return '[Function ' + (val.name || 'anonymous') + ']';
        if (typeof Node !== 'undefined' && val instanceof Node) return describeNode(val);
        if (isError(val)) return val.name + ': ' + val.message;
        if (val && typeof val === 'object') {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        return val;
      });
    } catch (e) {
      out = undefined;
    }
    if (out === undefined) out = String(v);
    return clip(out, max);
  };
  const fmt = (v) => {
    if (typeof v === 'string') return v;
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (isError(v)) return v.name + ': ' + v.message;
    if (typeof v === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
    if (typeof Node !== 'undefined' && v instanceof Node) return describeNode(v);
    if (typeof v === 'object') {
      try {
        return safeJson(redactValue(v), MAX_TEXT);
      } catch (e) {
        return safeJson(v, MAX_TEXT);
      }
    }
    return String(v);
  };
  const formatArgs = (input) => {
    const args = Array.from(input);
    const parts = [];
    if (typeof args[0] === 'string' && /%[sdifoOc%]/.test(args[0])) {
      const head = args.shift().replace(/%([sdifoOc%])/g, (m, k) => {
        if (k === '%') return '%';
        if (!args.length) return m;
        const a = args.shift();
        if (k === 'c') return '';
        if (k === 'd' || k === 'i') return String(parseInt(a, 10));
        if (k === 'f') return String(parseFloat(a));
        return fmt(a);
      });
      if (head.trim()) parts.push(head);
    }
    return clip(parts.concat(args.map(fmt)).join(' '), MAX_TEXT);
  };
  const stackOf = (v) => (isError(v) ? clip(String(v.stack), 8000) : undefined);

  /* ---------- console ---------- */
  ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
    const original = console[level];
    if (typeof original !== 'function') return;
    console[level] = function tjrConsole(...args) {
      try {
        const ev = { k: 'console', level, message: formatArgs(args) };
        const err = args.find(isError);
        if (err) ev.stack = stackOf(err);
        else if (level === 'error') {
          const frames = String(new Error().stack || '').split('\n').slice(2).join('\n');
          if (frames) ev.stack = ev.message.split('\n')[0] + '\n' + frames;
        }
        emit(ev);
      } catch (e) {
        /* never break the page */
      }
      return original.apply(this, args);
    };
  });

  /* ---------- redaction ---------- */
  const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
  const SECRET_KEY = /^(pass|passwd|pwd|token|access_token|refresh_token|id_token|api_key|apikey|authorization|card_number|cardnumber|cvc|cvv|ssn|sig|signature|key|auth)$/i;
  const SECRET_KEY_PART = /password|secret|x-amz-(signature|credential|security-token)/i;
  const secretKey = (k) => SECRET_KEY.test(k) || SECRET_KEY_PART.test(k);

  const redactHeaders = (h) => {
    const out = {};
    Object.keys(h || {}).forEach((k) => {
      out[k.toLowerCase()] = SECRET_HEADER.test(k) ? '[redacted]' : String(h[k]);
    });
    return out;
  };
  const redactUrl = (u) => {
    try {
      const url = new URL(u, location.href);
      const keys = [];
      url.searchParams.forEach((v, k) => {
        if (secretKey(k)) keys.push(k);
      });
      keys.forEach((k) => url.searchParams.set(k, 'redacted'));
      return url.href;
    } catch (e) {
      return String(u);
    }
  };
  // Copies v with secret-looking keys replaced. Cycle-safe and capped so huge objects stay cheap.
  const redactValue = (root) => {
    const seen = new WeakSet();
    let budget = 3000;
    const walk = (v, depth) => {
      if (!v || typeof v !== 'object') return v;
      if (typeof Node !== 'undefined' && v instanceof Node) return describeNode(v);
      if (isError(v)) return v.name + ': ' + v.message;
      if (seen.has(v)) return '[Circular]';
      if (depth > 12 || (budget -= 1) < 0) return '…';
      seen.add(v);
      if (Array.isArray(v)) return v.slice(0, 500).map((x) => walk(x, depth + 1));
      const out = {};
      Object.keys(v).forEach((k) => {
        let x;
        try {
          x = v[k];
        } catch (e) {
          x = '[unreadable]';
        }
        out[k] = secretKey(k) ? '[redacted]' : walk(x, depth + 1);
      });
      return out;
    };
    return walk(root, 0);
  };
  const parseBody = (text, contentType) => {
    if (text == null || text === '') return undefined;
    if (text.length > MAX_BODY) return text.slice(0, MAX_BODY) + '\n… (truncated)';
    const ct = contentType || '';
    if (/json/i.test(ct) || /^\s*[[{]/.test(text)) {
      try {
        return redactValue(JSON.parse(text));
      } catch (e) {
        /* not JSON after all */
      }
    }
    if (/x-www-form-urlencoded/i.test(ct)) {
      try {
        const out = {};
        new URLSearchParams(text).forEach((v, k) => {
          out[k] = secretKey(k) ? '[redacted]' : v;
        });
        return out;
      } catch (e) {
        /* keep text */
      }
    }
    return text;
  };
  const requestBody = (body) => {
    if (body == null) return undefined;
    if (typeof body === 'string') return body;
    try {
      if (body instanceof URLSearchParams) return body.toString();
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const out = {};
        body.forEach((v, k) => {
          out[k] = typeof v === 'string' ? v : '[file ' + (v.name || 'blob') + ']';
        });
        return JSON.stringify(out);
      }
      if (body instanceof Blob) return '[binary ' + body.size + ' bytes]';
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return '[binary ' + body.byteLength + ' bytes]';
    } catch (e) {
      return undefined;
    }
    return '[stream]';
  };
  const headersToObject = (h) => {
    const out = {};
    if (!h) return out;
    try {
      if (typeof Headers !== 'undefined' && h instanceof Headers) h.forEach((v, k) => { out[k.toLowerCase()] = v; });
      else if (Array.isArray(h)) h.forEach((pair) => { out[String(pair[0]).toLowerCase()] = String(pair[1]); });
      else Object.keys(h).forEach((k) => { out[k.toLowerCase()] = String(h[k]); });
    } catch (e) {
      /* ignore */
    }
    return out;
  };
  const textual = (ct) => !/event-stream/i.test(ct || '') && (!ct || /json|text\/|xml|javascript|graphql|x-www-form-urlencoded/i.test(ct));
  const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
  const readLimited = async (res) => {
    if (!res.body || !res.body.getReader || !decoder) return res.text();
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
        if (total > MAX_BODY) {
          reader.cancel().catch(() => {});
          break;
        }
      }
    } catch (e) {
      /* partial body is fine */
    }
    const all = new Uint8Array(total);
    let o = 0;
    chunks.forEach((c) => {
      all.set(c, o);
      o += c.byteLength;
    });
    return decoder.decode(all);
  };

  /* ---------- fetch ---------- */
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function tjrFetch(input, init) {
      const at = now();
      let url = '';
      let method = 'GET';
      let reqHeaders = {};
      let reqBody;
      try {
        const isReq = typeof Request !== 'undefined' && input instanceof Request;
        url = isReq ? input.url : String(input && input.href ? input.href : input);
        method = String((init && init.method) || (isReq && input.method) || 'GET').toUpperCase();
        reqHeaders = headersToObject((init && init.headers) || (isReq && input.headers));
        reqBody = requestBody(init && init.body);
      } catch (e) {
        /* best effort */
      }
      const p = nativeFetch.apply(this, arguments);
      p.then(
        (res) => {
          try {
            const ev = {
              k: 'network',
              at,
              method,
              url: redactUrl(url),
              type: 'fetch',
              status: res.status,
              duration: Math.round(now() - at),
              size: Number(res.headers.get('content-length')) || 0,
              requestHeaders: redactHeaders(reqHeaders),
              responseHeaders: redactHeaders(headersToObject(res.headers)),
              requestBody: parseBody(reqBody, reqHeaders['content-type']),
            };
            if (res.type === 'opaque') {
              ev.status = 0;
              ev.opaque = true;
            }
            const ct = res.headers.get('content-type') || '';
            if (res.type !== 'opaque' && res.status !== 204 && method !== 'HEAD' && textual(ct)) {
              const clone = res.clone();
              const timeout = new Promise((r) => setTimeout(() => r(null), 5000));
              Promise.race([readLimited(clone), timeout]).then(
                (text) => {
                  if (text != null) {
                    ev.responseBody = parseBody(text, ct);
                    if (!ev.size) ev.size = text.length;
                  }
                  emit(ev);
                },
                () => emit(ev)
              );
              return;
            }
            emit(ev);
          } catch (e) {
            /* ignore */
          }
        },
        (err) => {
          emit({
            k: 'network',
            at,
            method,
            url: redactUrl(url),
            type: 'fetch',
            status: 0,
            error: err && err.name === 'AbortError' ? 'Aborted' : (err && err.message) || 'Failed to fetch',
            duration: Math.round(now() - at),
            size: 0,
            requestHeaders: redactHeaders(reqHeaders),
            requestBody: parseBody(reqBody, reqHeaders['content-type']),
          });
        }
      );
      return p;
    };
  }

  /* ---------- XMLHttpRequest ---------- */
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const { open, send, setRequestHeader } = XHR.prototype;
    XHR.prototype.open = function tjrOpen(method, url) {
      try {
        this.__tjr = { method: String(method || 'GET').toUpperCase(), url: String(url), headers: {} };
      } catch (e) {
        /* ignore */
      }
      return open.apply(this, arguments);
    };
    XHR.prototype.setRequestHeader = function tjrSetRequestHeader(k, v) {
      try {
        if (this.__tjr) this.__tjr.headers[String(k).toLowerCase()] = String(v);
      } catch (e) {
        /* ignore */
      }
      return setRequestHeader.apply(this, arguments);
    };
    XHR.prototype.send = function tjrSend(body) {
      const info = this.__tjr;
      if (info) {
        info.at = now();
        info.body = requestBody(body);
        let failed = '';
        this.addEventListener('error', () => { failed = 'Network error'; });
        this.addEventListener('abort', () => { failed = 'Aborted'; });
        this.addEventListener('timeout', () => { failed = 'Timed out'; });
        this.addEventListener('loadend', () => {
          try {
            const resHeaders = {};
            String(this.getAllResponseHeaders() || '')
              .trim()
              .split(/[\r\n]+/)
              .forEach((line) => {
                const i = line.indexOf(':');
                if (i > 0) resHeaders[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
              });
            const ct = resHeaders['content-type'] || '';
            let text;
            if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
            else if (this.responseType === 'json' && this.response != null) text = safeJson(this.response, MAX_BODY + 1);
            const ev = {
              k: 'network',
              at: info.at,
              method: info.method,
              url: redactUrl(this.responseURL || info.url),
              type: 'xhr',
              status: this.status,
              duration: Math.round(now() - info.at),
              size: Number(resHeaders['content-length']) || (text ? text.length : 0),
              requestHeaders: redactHeaders(info.headers),
              responseHeaders: redactHeaders(resHeaders),
              requestBody: parseBody(info.body, info.headers['content-type']),
            };
            if (text != null && textual(ct)) ev.responseBody = parseBody(text, ct);
            if (failed || !this.status) {
              ev.status = 0;
              ev.error = failed || 'Network error';
            }
            emit(ev);
          } catch (e) {
            /* ignore */
          }
        });
      }
      return send.apply(this, arguments);
    };
  }

  /* ---------- other resources (scripts, styles, images, fonts, the document) ---------- */
  const failedLoads = new Map();
  const resourceType = (e) => {
    const it = e.initiatorType;
    if (it === 'fetch' || it === 'xmlhttprequest') return null; // recorded by the wrappers above
    if (it === 'navigation' || it === 'iframe' || it === 'frame') return 'document';
    if (it === 'beacon') return 'ping';
    const path = e.name.split(/[?#]/)[0].toLowerCase();
    if (/\.css$/.test(path)) return 'stylesheet';
    if (/\.(woff2?|ttf|otf|eot)$/.test(path)) return 'font';
    if (/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/.test(path)) return 'img';
    if (/\.m?js$/.test(path) || it === 'script') return 'script';
    if (it === 'img' || it === 'image') return 'img';
    if (it === 'link' || it === 'css') return 'stylesheet';
    return it || 'other';
  };
  const seenEntries = new Set();
  const handleEntry = (e) => {
    const type = resourceType(e);
    if (!type || /^(data|blob|chrome-extension):/.test(e.name)) return;
    const key = e.entryType + ' ' + e.name + ' ' + e.startTime;
    if (seenEntries.has(key)) return;
    seenEntries.add(key);
    const ev = {
      k: 'network',
      at: performance.timeOrigin + e.startTime,
      method: type === 'ping' ? 'POST' : 'GET',
      url: redactUrl(e.name),
      type,
      duration: Math.round(e.duration),
      size: e.transferSize || e.encodedBodySize || 0,
    };
    if (e.transferSize === 0 && e.encodedBodySize > 0) ev.cached = true;
    const failedAt = failedLoads.get(e.name);
    if (failedAt) failedLoads.delete(e.name);
    if (e.responseStatus) ev.status = e.responseStatus;
    else if (failedAt) {
      ev.status = 0;
      ev.error = 'Failed to load';
    } else {
      // Cross-origin without CORS: the browser hides the status.
      ev.status = 0;
      ev.opaque = true;
    }
    emit(ev);
  };
  try {
    const po = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      setTimeout(() => entries.forEach(handleEntry), 400);
    });
    po.observe({ type: 'resource', buffered: true });
    po.observe({ type: 'navigation', buffered: true });
  } catch (e) {
    /* PerformanceObserver unavailable */
  }

  /* ---------- errors ---------- */
  addEventListener(
    'error',
    (e) => {
      try {
        if (typeof ErrorEvent !== 'undefined' && e instanceof ErrorEvent) {
          const stack = stackOf(e.error) || (e.filename ? (e.message || 'Error') + '\n    at ' + e.filename + ':' + e.lineno + ':' + e.colno : undefined);
          emit({ k: 'console', level: 'error', message: e.message || 'Script error.', stack });
          return;
        }
        const t = e.target;
        if (!t || t === window || !t.tagName) return;
        const url = t.currentSrc || t.src || t.href || '';
        if (!url || /^(data|blob):/.test(url)) return;
        const at = now();
        failedLoads.set(url, at);
        setTimeout(() => {
          if (!failedLoads.has(url)) return;
          failedLoads.delete(url);
          const tag = t.tagName.toLowerCase();
          emit({ k: 'network', at, method: 'GET', url: redactUrl(url), type: tag === 'link' ? 'stylesheet' : tag, status: 0, error: 'Failed to load', duration: 0, size: 0 });
        }, 1500);
      } catch (err) {
        /* ignore */
      }
    },
    true
  );
  addEventListener('unhandledrejection', (e) => {
    try {
      emit({ k: 'console', level: 'error', message: 'Unhandled promise rejection: ' + fmt(e.reason), stack: stackOf(e.reason) });
    } catch (err) {
      /* ignore */
    }
  });

  /* ---------- user actions ---------- */
  const OURS = 'TJR-RECORD-PILL';
  const SENSITIVE = /pass|card|cc-|cvc|cvv|ssn|secret|token|otp|\bpin\b|iban/i;
  const clean = (s, n) => clip(String(s || '').replace(/\s+/g, ' ').trim(), n || 40);
  const attr = (el, name) => (el.getAttribute && el.getAttribute(name)) || '';
  const isSensitive = (el) => {
    try {
      if (el.closest && el.closest('[data-tjr-mask]')) return true;
      if (String(el.type || '').toLowerCase() === 'password') return true;
      if (/^cc-|password|one-time-code/i.test(attr(el, 'autocomplete'))) return true;
      return SENSITIVE.test([el.name, el.id, attr(el, 'placeholder'), attr(el, 'aria-label')].filter(Boolean).join(' '));
    } catch (e) {
      return true;
    }
  };
  const GENERATED_ID = /^\d|[0-9a-f]{8,}|^:r|^radix-|^headlessui-|^mui-|^react-select|^ember\d/i;
  const describe = (el) => {
    if (!el || !el.tagName) return '';
    const tag = el.tagName.toLowerCase();
    if (el.id && !GENERATED_ID.test(el.id)) return tag + '#' + el.id;
    for (const a of ['data-testid', 'data-test', 'data-test-id', 'data-cy']) {
      const v = attr(el, a);
      if (v) return tag + '[' + a + '="' + clean(v, 60) + '"]';
    }
    let label = attr(el, 'aria-label') || attr(el, 'title');
    if (!label && /^(input|textarea|select)$/.test(tag)) {
      label = attr(el, 'placeholder') || (el.labels && el.labels[0] ? el.labels[0].innerText : '') || attr(el, 'name');
    }
    if (!label) label = el.closest && el.closest(INTERACTIVE) === el ? el.innerText : String(el.textContent || '').slice(0, 200);
    label = clean(label);
    if (label) return tag + " '" + label + "'";
    const cls = el.classList && el.classList[0];
    return cls ? tag + '.' + cls : tag;
  };
  const INTERACTIVE = 'a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="option"],[role="switch"],[onclick]';
  const targetOf = (e) => {
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    return t && t.nodeType === 1 ? t : t && t.parentElement;
  };

  addEventListener(
    'click',
    (e) => {
      try {
        if (e.target && e.target.tagName === OURS) return;
        const t = targetOf(e);
        if (!t) return;
        emit({ k: 'action', type: 'click', target: describe((t.closest && t.closest(INTERACTIVE)) || t) });
      } catch (err) {
        /* ignore */
      }
    },
    true
  );

  const pendingInputs = new Map();
  const lastValues = new WeakMap();
  const emitInput = (el, at) => {
    const ev = inputEvent(el);
    if (lastValues.get(el) === ev.value) return;
    lastValues.set(el, ev.value);
    ev.at = at;
    emit(ev);
  };
  const inputEvent = (el) => {
    const type = String(el.type || '').toLowerCase();
    let value;
    if (type === 'checkbox' || type === 'radio') value = el.checked ? 'checked' : 'unchecked';
    else if (type === 'file') value = Array.from(el.files || []).map((f) => f.name).join(', ');
    else if (el.tagName === 'SELECT') value = clean(el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : el.value, 80);
    else if (el.isContentEditable) value = clean(el.innerText, 80);
    else value = clean(el.value, 80);
    if (value && type !== 'checkbox' && type !== 'radio' && isSensitive(el)) value = '•••';
    return { k: 'action', type: 'input', target: describe(el), value };
  };
  const flushInputs = () => {
    pendingInputs.forEach((p, el) => {
      clearTimeout(p.timer);
      emitInput(el, p.at);
    });
    pendingInputs.clear();
  };
  const onInput = (e) => {
    try {
      let el = targetOf(e);
      if (!el) return;
      if (el.isContentEditable && el.closest) el = el.closest('[contenteditable]') || el;
      if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.isContentEditable) return;
      const prev = pendingInputs.get(el);
      if (prev) clearTimeout(prev.timer);
      const at = now(); // last keystroke, so the video already shows the full value at this time
      const timer = setTimeout(() => {
        pendingInputs.delete(el);
        emitInput(el, at);
      }, 800);
      pendingInputs.set(el, { timer, at });
    } catch (err) {
      /* ignore */
    }
  };
  addEventListener('input', onInput, true);

  addEventListener(
    'keydown',
    (e) => {
      try {
        const combo = (e.metaKey || e.ctrlKey) && e.key && e.key.length === 1;
        if (e.key !== 'Enter' && e.key !== 'Escape' && !combo) return;
        if (e.target && e.target.tagName === OURS) return;
        const t = targetOf(e);
        const key = combo ? (e.metaKey ? 'Cmd+' : 'Ctrl+') + e.key.toUpperCase() : e.key;
        emit({ k: 'action', type: 'keydown', key, target: t && t !== document.body && t !== document.documentElement ? describe(t) : '' });
      } catch (err) {
        /* ignore */
      }
    },
    true
  );

  let lastUrl = location.href;
  const navigated = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    emit({ k: 'action', type: 'navigate', url: redactUrl(location.href) });
  };
  emit({ k: 'action', type: 'navigate', url: redactUrl(location.href) });
  ['pushState', 'replaceState'].forEach((m) => {
    const original = history[m];
    if (typeof original !== 'function') return;
    history[m] = function tjrHistory() {
      const r = original.apply(this, arguments);
      try {
        navigated();
      } catch (e) {
        /* ignore */
      }
      return r;
    };
  });
  addEventListener('popstate', navigated);
  addEventListener('hashchange', navigated);
  addEventListener('pagehide', () => {
    flushInputs();
    flush();
  });

  /* ---------- custom logs: window.TJRecord.log('cart.total', 118.4) ---------- */
  try {
    if (!('TJRecord' in window)) {
      const log = (key, value) => {
        let v = value;
        if (v && typeof v === 'object') {
          try {
            v = JSON.parse(safeJson(v, 8000));
          } catch (e) {
            v = safeJson(v, 8000);
          }
        }
        emit({ k: 'custom', key: String(key), value: v });
      };
      Object.defineProperty(window, 'TJRecord', { value: Object.freeze({ log }), configurable: true });
    }
  } catch (e) {
    /* ignore */
  }

  document.dispatchEvent(new CustomEvent('tjr:logger-ready'));
})();
