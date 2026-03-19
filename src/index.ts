// ============================================================================
// --- SHARED UTILITIES ---
// ============================================================================

// Native UUID Generator (No dependencies)
function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// W3C Trace & Span ID Generators (Hex strings)
function generateHex(length: number): string {
  let result = '';
  while (result.length < length) {
    result += Math.random().toString(16).slice(2);
  }
  return result.slice(0, length);
}

const getBrowserContext = () => {
  return {
    userAgent: navigator.userAgent,
    url: window.location.href, // This provides the URL dynamically
    deviceMemory: (navigator as any).deviceMemory || undefined,
    connectionType: (navigator as any).connection?.effectiveType || undefined
  };
};

// ============================================================================
// --- WEB ANALYTICS (MARKETING) MODULE ---
// ============================================================================

interface AnalyticsConfig {
  webId: string;
  endpoint?: string;
}

class SenzorAnalyticsAgent {
  private config: AnalyticsConfig = { webId: '' };
  private startTime: number = Date.now();
  private endpoint: string = 'https://api.senzor.dev/api/ingest/web';
  private initialized: boolean = false;

  public init(config: AnalyticsConfig) {
    if (this.initialized) return;
    this.initialized = true;
    this.config = { ...this.config, ...config };
    if (config.endpoint) this.endpoint = config.endpoint;

    if (!this.config.webId) {
      console.error('[Senzor] webId is required for Analytics.');
      return;
    }

    this.manageSession();
    this.trackPageView();
    this.setupListeners();
  }

  private normalizeUrl(url: string): string {
    return url ? url.replace(/^https?:\/\//, '') : '';
  }

  private manageSession() {
    const now = Date.now();
    const lastActivity = parseInt(localStorage.getItem('sz_wa_last') || '0', 10);
    if (!localStorage.getItem('sz_wa_vid')) localStorage.setItem('sz_wa_vid', generateUUID());

    let sessionId = sessionStorage.getItem('sz_wa_sid');
    if (!sessionId || (now - lastActivity > 30 * 60 * 1000)) {
      sessionId = generateUUID();
      sessionStorage.setItem('sz_wa_sid', sessionId);
      this.determineReferrer(true);
    } else {
      this.determineReferrer(false);
    }
    localStorage.setItem('sz_wa_last', now.toString());
  }

  private determineReferrer(isNewSession: boolean) {
    const rawReferrer = document.referrer;
    let isExternal = false;
    if (rawReferrer) {
      try { isExternal = new URL(rawReferrer).hostname !== window.location.hostname; } catch (e) { isExternal = true; }
    }

    if (isExternal) {
      const cleanRef = this.normalizeUrl(rawReferrer);
      if (cleanRef !== sessionStorage.getItem('sz_wa_ref')) sessionStorage.setItem('sz_wa_ref', cleanRef);
    } else if (isNewSession && !sessionStorage.getItem('sz_wa_ref')) {
      sessionStorage.setItem('sz_wa_ref', 'Direct');
    }
  }

  private getIds() {
    localStorage.setItem('sz_wa_last', Date.now().toString());
    return {
      visitorId: localStorage.getItem('sz_wa_vid') || 'unknown',
      sessionId: sessionStorage.getItem('sz_wa_sid') || 'unknown',
      referrer: sessionStorage.getItem('sz_wa_ref') || 'Direct'
    };
  }

  private trackPageView() {
    this.manageSession();
    this.startTime = Date.now();
    this.send({ type: 'pageview', webId: this.config.webId, ...this.getIds(), url: window.location.href, path: window.location.pathname, title: document.title, width: window.innerWidth, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, referrer: this.getIds().referrer });
  }

  private trackPing() {
    const duration = Math.floor((Date.now() - this.startTime) / 1000);
    if (duration >= 1) this.send({ type: 'ping', webId: this.config.webId, ...this.getIds(), url: window.location.href, path: window.location.pathname, title: document.title, width: window.innerWidth, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, referrer: this.getIds().referrer, duration });
  }

  private send(data: any) {
    if (navigator.sendBeacon) {
      if (!navigator.sendBeacon(this.endpoint, new Blob([JSON.stringify(data)], { type: 'application/json' }))) this.fallbackSend(data);
    } else {
      this.fallbackSend(data);
    }
  }

  private fallbackSend(data: any) {
    fetch(this.endpoint, { method: 'POST', body: JSON.stringify(data), keepalive: true, headers: { 'Content-Type': 'application/json' } }).catch(() => { });
  }

  private setupListeners() {
    const originalPushState = history.pushState;
    history.pushState = (...args) => { this.trackPing(); originalPushState.apply(history, args); this.trackPageView(); };
    window.addEventListener('popstate', () => { this.trackPing(); this.trackPageView(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.trackPing(); else { this.startTime = Date.now(); this.manageSession(); } });
    window.addEventListener('beforeunload', () => this.trackPing());
  }
}


// ============================================================================
// --- RUM / WEB APM (ENGINEERING) MODULE ---
// ============================================================================

interface RumConfig {
  apiKey: string;
  endpoint?: string;
  sampleRate?: number; // 0.0 to 1.0 (Defaults to 1.0)
  allowedOrigins?: (string | RegExp)[]; // Origins allowed to receive W3C traceparent headers
}

class SenzorRumAgent {
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
  private addBreadcrumb(type: string, message: string) {
    this.breadcrumbs.push({ type, message, time: Date.now() });
    if (this.breadcrumbs.length > 15) this.breadcrumbs.shift(); // Keep last 15 actions
  }

  // --- 1. UX Frustration Detection ---
  private setupUXListeners() {
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const tag = target.tagName ? target.tagName.toLowerCase() : '';

      // Breadcrumb
      this.addBreadcrumb('click', `Clicked ${tag}${target.id ? '#' + target.id : ''}${target.className ? '.' + target.className.split(' ')[0] : ''}`);

      // Dead Click Heuristic (Clicked non-interactive element)
      const interactiveElements = ['a', 'button', 'input', 'select', 'textarea', 'label'];
      const isInteractive = interactiveElements.includes(tag) || target.closest('button') || target.closest('a') || target.hasAttribute('role') || target.onclick;
      if (!isInteractive) {
        this.frustrations.deadClicks++;
      }

      // Rage Click Heuristic (>= 3 clicks within 50px radius in < 1 second)
      const now = Date.now();
      this.clickHistory.push({ x: e.clientX, y: e.clientY, time: now });

      // Clean old history
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
          this.clickHistory = []; // Reset after registering rage click
        }
      }
    }, { capture: true, passive: true });
  }

  // --- 2. Google Core Web Vitals (Non-blocking) ---
  private setupPerformanceObservers() {
    if (!this.isSampled || typeof PerformanceObserver === 'undefined') return;

    try {
      // First Contentful Paint (FCP)
      new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntriesByName('first-contentful-paint')) {
          this.vitals.fcp = entry.startTime;
        }
      }).observe({ type: 'paint', buffered: true });

      // Largest Contentful Paint (LCP)
      new PerformanceObserver((entryList) => {
        const entries = entryList.getEntries();
        const lastEntry = entries[entries.length - 1];
        if (lastEntry) this.vitals.lcp = lastEntry.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });

      // Cumulative Layout Shift (CLS)
      let clsScore = 0;
      new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) {
          if (!(entry as any).hadRecentInput) {
            clsScore += (entry as any).value;
            this.vitals.cls = clsScore;
          }
        }
      }).observe({ type: 'layout-shift', buffered: true });

      // Interaction to Next Paint (INP / FID fallback)
      new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) {
          const evt = entry as any; // Safely bypass TS base-class limits for PerformanceEventTiming
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

  // --- 3. Distributed Tracing (Patching) ---
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

    // Patch XHR
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method: string, url: string, ...rest: any[]) {
      (this as any).__szMethod = method;
      (this as any).__szUrl = url;
      return originalXhrOpen.apply(this, [method, url, ...rest] as any);
    };

    XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      const xhr = this as any;
      const spanId = generateHex(16);
      const startTime = Date.now() - self.traceStartTime;

      if (self.shouldAttachTraceHeader(xhr.__szUrl)) {
        xhr.setRequestHeader('traceparent', `00-${self.traceId}-${spanId}-01`);
      }

      xhr.addEventListener('loadend', () => {
        self.spans.push({
          spanId, name: new URL(xhr.__szUrl, window.location.origin).pathname,
          type: 'xhr', method: xhr.__szMethod, status: xhr.status,
          startTime, duration: (Date.now() - self.traceStartTime) - startTime
        });
      });

      return originalXhrSend.call(this, body);
    };

    // Patch Fetch
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request).url;
      const method = (args[1]?.method || (args[0] as Request).method || 'GET').toUpperCase();

      const spanId = generateHex(16);
      const startTime = Date.now() - self.traceStartTime;

      if (self.shouldAttachTraceHeader(url)) {
        const headers = new Headers(args[1]?.headers || (args[0] as Request).headers || {});
        headers.set('traceparent', `00-${self.traceId}-${spanId}-01`);
        if (args[1]) args[1].headers = headers;
        else if (args[0] instanceof Request) args[0] = new Request(args[0], { headers });
      }

      try {
        const response = await originalFetch.apply(this, args);
        self.spans.push({
          spanId, name: new URL(url, window.location.origin).pathname,
          type: 'fetch', method, status: response.status,
          startTime, duration: (Date.now() - self.traceStartTime) - startTime
        });
        return response;
      } catch (error) {
        self.spans.push({
          spanId, name: new URL(url, window.location.origin).pathname,
          type: 'fetch', method, status: 0,
          startTime, duration: (Date.now() - self.traceStartTime) - startTime
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

    // Only send performance trace if sampled
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
        ...getBrowserContext(), // Injects URL, userAgent, connectionType, etc.
        spans: [...this.spans],
        duration: Date.now() - this.traceStartTime,
        timestamp: new Date(this.traceStartTime).toISOString()
      });
    }

    // Reset Buffers
    this.spans = [];
    this.errors = [];
    this.frustrations = { rageClicks: 0, deadClicks: 0, errorCount: 0 };
    this.isInitialLoad = false; // Next flush on same page is an update, not initial load

    if (payload.traces.length > 0 || payload.errors.length > 0) {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      if (navigator.sendBeacon) navigator.sendBeacon(this.endpoint, blob);
      else fetch(this.endpoint, { method: 'POST', body: blob, keepalive: true }).catch(() => { });
    }
  }
}

// ============================================================================
// --- EXPORTS & INITIALIZATION ---
// ============================================================================

export const Analytics = new SenzorAnalyticsAgent();
export const RUM = new SenzorRumAgent();

// Maintain backwards compatibility for existing users
export const Senzor = {
  init: (config: AnalyticsConfig) => Analytics.init(config),
  initRum: (config: RumConfig) => RUM.init(config)
};

if (typeof window !== 'undefined') {
  (window as any).Senzor = Senzor;
}