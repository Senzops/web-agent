import { generateHex, generateUUID, getBrowserContext, getPayloadSize } from './utils';

export interface RumConfig {
  apiKey: string;
  endpoint?: string;
  sampleRate?: number; // 0.0 to 1.0 (Defaults to 1.0)
  allowedOrigins?: (string | RegExp)[]; // Origins allowed to receive W3C traceparent headers
}

export class SenzorRumAgent {
  private config: RumConfig = { apiKey: '', sampleRate: 1.0, allowedOrigins: [] };
  private endpoint: string = 'https://api.senzor.dev/api/ingest/rum';
  private initialized: boolean = false;
  private isSampled: boolean = true;

  // State
  private sessionId: string = '';
  private traceId: string = '';
  private traceStartTime: number = 0;
  private isInitialLoad: boolean = true;

  // Buffers
  private spans: any[] = [];
  private errors: any[] = [];
  private breadcrumbs: any[] = [];
  private vitals: any = {};
  private frustrations = { rageClicks: 0, deadClicks: 0, errorCount: 0 };
  private clickHistory: { x: number; y: number; time: number }[] = [];

  // Intervals
  private flushInterval: any;

  public init(config: RumConfig) {
    if (this.initialized) return;
    this.initialized = true;
    this.config = { ...this.config, ...config };
    if (config.endpoint) this.endpoint = config.endpoint;

    if (!this.config.apiKey) {
      console.error('[Senzor RUM] apiKey is required.');
      return;
    }

    // Determine Sampling (Errors are ALWAYS 100% sampled, only Traces drop)
    this.isSampled = Math.random() <= (this.config.sampleRate ?? 1.0);

    this.manageSession();
    this.startNewTrace(true);

    this.setupErrorListeners();
    this.setupPerformanceObservers();
    this.setupUXListeners();
    if (this.isSampled) this.patchNetwork();

    // Micro-batch flush every 10s
    this.flushInterval = setInterval(() => this.flush(), 10000);

    // SPA and Unload Listeners
    this.setupRoutingListeners();
  }

  private manageSession() {
    if (!sessionStorage.getItem('sz_rum_sid')) {
      sessionStorage.setItem('sz_rum_sid', generateUUID());
    }
    this.sessionId = sessionStorage.getItem('sz_rum_sid') as string;
  }

  private startNewTrace(isInitialLoad: boolean) {
    this.traceId = generateHex(32); // W3C Standard Trace ID
    this.traceStartTime = Date.now();
    this.isInitialLoad = isInitialLoad;
    this.spans = [];
    this.vitals = {};
    this.frustrations = { rageClicks: 0, deadClicks: 0, errorCount: 0 };
  }

  // --- Breadcrumbs (For Error Context) ---
  private addBreadcrumb(type: string, message: string, data?: any) {
    this.breadcrumbs.push({ type, message, data, time: Date.now() });
    if (this.breadcrumbs.length > 15) this.breadcrumbs.shift(); // Keep last 15 actions
  }

  // --- 1. UX Frustration Detection ---
  private setupUXListeners() {
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const tag = target.tagName ? target.tagName.toLowerCase() : '';

      // Breadcrumb
      this.addBreadcrumb('click', `Clicked ${tag}${target.id ? '#' + target.id : ''}${target.className ? '.' + target.className.split(' ')[0] : ''}`);

      // Dead Click Heuristic
      const interactiveElements = ['a', 'button', 'input', 'select', 'textarea', 'label'];
      const isInteractive = interactiveElements.includes(tag) || target.closest('button') || target.closest('a') || target.hasAttribute('role') || target.onclick;
      if (!isInteractive) {
        this.frustrations.deadClicks++;
      }

      // Rage Click Heuristic
      const now = Date.now();
      this.clickHistory.push({ x: e.clientX, y: e.clientY, time: now });
      this.clickHistory = this.clickHistory.filter(c => now - c.time < 1000);

      if (this.clickHistory.length >= 3) {
        const first = this.clickHistory[0];
        let isRage = true;
        for (let i = 1; i < this.clickHistory.length; i++) {
          const dx = Math.abs(this.clickHistory[i].x - first.x);
          const dy = Math.abs(this.clickHistory[i].y - first.y);
          if (dx > 50 || dy > 50) isRage = false;
        }
        if (isRage) {
          this.frustrations.rageClicks++;
          this.addBreadcrumb('frustration', 'Rage Click Detected');
          this.clickHistory = []; // Reset
        }
      }
    }, { capture: true, passive: true });
  }

  // --- 2. Google Core Web Vitals ---
  private setupPerformanceObservers() {
    if (!this.isSampled || typeof PerformanceObserver === 'undefined') return;

    try {
      new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntriesByName('first-contentful-paint')) {
          this.vitals.fcp = entry.startTime;
        }
      }).observe({ type: 'paint', buffered: true });

      new PerformanceObserver((entryList) => {
        const entries = entryList.getEntries();
        const lastEntry = entries[entries.length - 1];
        if (lastEntry) this.vitals.lcp = lastEntry.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });

      let clsScore = 0;
      new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) {
          if (!(entry as any).hadRecentInput) {
            clsScore += (entry as any).value;
            this.vitals.cls = clsScore;
          }
        }
      }).observe({ type: 'layout-shift', buffered: true });

      new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) {
          const evt = entry as any;
          const delay = evt.duration || (evt.processingStart && evt.startTime ? evt.processingStart - evt.startTime : 0);
          if (!this.vitals.inp || delay > this.vitals.inp) {
            this.vitals.inp = delay;
          }
        }
      }).observe({ type: 'event', buffered: true, durationThreshold: 40 } as any);

    } catch (e) {
      // Browser doesn't support specific observer type, degrade gracefully
    }
  }

  private getNavigationTimings() {
    if (typeof performance === 'undefined') return {};
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    if (!nav) return {};

    return {
      dns: Math.max(0, nav.domainLookupEnd - nav.domainLookupStart),
      tcp: Math.max(0, nav.connectEnd - nav.connectStart),
      ssl: nav.secureConnectionStart ? Math.max(0, nav.requestStart - nav.secureConnectionStart) : 0,
      ttfb: Math.max(0, nav.responseStart - nav.requestStart),
      domInteractive: Math.max(0, nav.domInteractive - nav.startTime),
      domComplete: Math.max(0, nav.domComplete - nav.startTime),
    };
  }

  // --- 3. Distributed Tracing & Verbose Network Meta ---
  private shouldAttachTraceHeader(url: string): boolean {
    if (!this.config.allowedOrigins || this.config.allowedOrigins.length === 0) return false;
    try {
      const targetUrl = new URL(url, window.location.origin);
      return this.config.allowedOrigins.some(allowed => {
        if (typeof allowed === 'string') return targetUrl.origin.includes(allowed);
        if (allowed instanceof RegExp) return allowed.test(targetUrl.origin);
        return false;
      });
    } catch { return false; }
  }

  private patchNetwork() {
    const self = this;

    // --- Patch XHR ---
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;
    const originalXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (method: string, url: string, ...rest: any[]) {
      (this as any).__szMethod = method.toUpperCase();
      (this as any).__szUrl = url;
      (this as any).__szHeaders = {};
      return originalXhrOpen.apply(this, [method, url, ...rest] as any);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (header: string, value: string) {
      (this as any).__szHeaders[header] = value;
      return originalXhrSetRequestHeader.call(this, header, value);
    };

    XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      const xhr = this as any;
      const spanId = generateHex(16);
      const startTime = Date.now() - self.traceStartTime;
      const method = xhr.__szMethod;
      let fullUrl = xhr.__szUrl;

      try {
        fullUrl = new URL(xhr.__szUrl, window.location.origin).toString();
      } catch (e) { /* ignore */ }

      if (self.shouldAttachTraceHeader(fullUrl)) {
        xhr.setRequestHeader('traceparent', `00-${self.traceId}-${spanId}-01`);
      }

      xhr.addEventListener('loadend', () => {
        const duration = (Date.now() - self.traceStartTime) - startTime;

        // Capture Verbose Metadata for XHR
        const meta: any = {
          url: fullUrl,
          method: method,
          library: 'xhr',
          status: xhr.status,
          responseType: xhr.responseType,
          requestPayloadSize: getPayloadSize(body)
        };

        try {
          const responseLength = xhr.responseText ? xhr.responseText.length : undefined;
          if (responseLength) meta.responsePayloadSize = responseLength;
        } catch (e) { /* Ignore responseText access errors on binary/blob */ }

        self.spans.push({
          spanId,
          name: `${method} ${new URL(fullUrl, window.location.origin).pathname}`,
          type: 'http',
          startTime,
          duration,
          status: xhr.status,
          meta
        });
      });

      return originalXhrSend.call(this, body);
    };

    // --- Patch Fetch ---
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const requestInfo = args[0];
      const init = args[1];

      let url = '';
      let method = 'GET';

      if (typeof requestInfo === 'string' || requestInfo instanceof URL) {
        url = requestInfo.toString();
        method = (init?.method || 'GET').toUpperCase();
      } else if (requestInfo instanceof Request) {
        url = requestInfo.url;
        method = requestInfo.method.toUpperCase();
      }

      let fullUrl = url;
      try { fullUrl = new URL(url, window.location.origin).toString(); } catch (e) { }

      const spanId = generateHex(16);
      const startTime = Date.now() - self.traceStartTime;

      // Safely inject traceparent without breaking Streams
      if (self.shouldAttachTraceHeader(fullUrl)) {
        const traceHeader = `00-${self.traceId}-${spanId}-01`;
        if (requestInfo instanceof Request) {
          const currentHeaders = new Headers(requestInfo.headers);
          currentHeaders.set('traceparent', traceHeader);
          args[1] = { ...(init || {}), headers: currentHeaders };
        } else {
          const currentHeaders = new Headers(init?.headers || {});
          currentHeaders.set('traceparent', traceHeader);
          args[1] = { ...(init || {}), headers: currentHeaders };
        }
      }

      try {
        const response = await originalFetch.apply(this, args);
        const duration = (Date.now() - self.traceStartTime) - startTime;

        self.spans.push({
          spanId,
          name: `${method} ${new URL(fullUrl, window.location.origin).pathname}`,
          type: 'http',
          startTime,
          duration,
          status: response.status,
          meta: {
            url: fullUrl,
            method,
            library: 'fetch',
            status: response.status,
            statusText: response.statusText,
            type: response.type,
            redirected: response.redirected,
            requestPayloadSize: getPayloadSize(init?.body)
          }
        });
        return response;
      } catch (error) {
        const duration = (Date.now() - self.traceStartTime) - startTime;

        self.spans.push({
          spanId,
          name: `${method} ${new URL(fullUrl, window.location.origin).pathname}`,
          type: 'http',
          startTime,
          duration,
          status: 0,
          meta: {
            url: fullUrl,
            method,
            library: 'fetch',
            status: 0,
            error: error instanceof Error ? error.message : String(error),
            requestPayloadSize: getPayloadSize(init?.body)
          }
        });
        throw error;
      }
    };
  }

  // --- 4. Universal Error Engine Hooks ---
  private setupErrorListeners() {
    const handleGlobalError = (errorObj: Error, type: string) => {
      this.frustrations.errorCount++;
      const message = errorObj.message || String(errorObj);

      this.errors.push({
        errorClass: errorObj.name || 'Error',
        message: message,
        stackTrace: errorObj.stack || '',
        traceId: this.isSampled ? this.traceId : undefined,
        context: {
          type,
          ...getBrowserContext(),
          breadcrumbs: [...this.breadcrumbs] // Snapshot of actions leading up to crash
        },
        timestamp: new Date().toISOString()
      });
      this.flush(); // Flush immediately on error
    };

    window.addEventListener('error', (event) => {
      if (event.error) handleGlobalError(event.error, 'Uncaught Exception');
    });

    window.addEventListener('unhandledrejection', (event) => {
      handleGlobalError(event.reason instanceof Error ? event.reason : new Error(String(event.reason)), 'Unhandled Promise Rejection');
    });
  }

  // --- 5. Lifecycle & Beaconing ---
  private setupRoutingListeners() {
    const originalPushState = history.pushState;
    history.pushState = (...args) => {
      this.flush(); // Flush previous page view
      originalPushState.apply(history, args);
      this.startNewTrace(false);
      this.addBreadcrumb('navigation', window.location.pathname);
    };

    window.addEventListener('popstate', () => {
      this.flush();
      this.startNewTrace(false);
      this.addBreadcrumb('navigation', window.location.pathname);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush();
    });

    window.addEventListener('pagehide', () => this.flush());
  }

  private flush() {
    if (this.spans.length === 0 && this.errors.length === 0 && !this.isInitialLoad) return;

    const payload: any = { traces: [], errors: this.errors };

    if (this.isSampled) {
      payload.traces.push({
        traceId: this.traceId,
        sessionId: this.sessionId,
        traceType: this.isInitialLoad ? 'initial_load' : 'route_change',
        path: window.location.pathname,
        referrer: document.referrer || '',
        vitals: { ...this.vitals },
        timings: this.isInitialLoad ? this.getNavigationTimings() : {},
        frustration: { ...this.frustrations },
        ...getBrowserContext(), // URL, UserAgent
        spans: [...this.spans],
        duration: Date.now() - this.traceStartTime,
        timestamp: new Date(this.traceStartTime).toISOString()
      });
    }

    // Reset Buffers
    this.spans = [];
    this.errors = [];
    this.frustrations = { rageClicks: 0, deadClicks: 0, errorCount: 0 };
    this.isInitialLoad = false;

    if (payload.traces.length > 0 || payload.errors.length > 0) {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });

      // Safely append API Key to URL for Beacon support
      const separator = this.endpoint.includes('?') ? '&' : '?';
      const authUrl = `${this.endpoint}${separator}apiKey=${this.config.apiKey}`;

      if (navigator.sendBeacon) {
        navigator.sendBeacon(authUrl, blob);
      } else {
        fetch(authUrl, {
          method: 'POST',
          body: blob,
          keepalive: true,
          headers: { 'x-service-api-key': this.config.apiKey }
        }).catch(() => { });
      }
    }
  }
}