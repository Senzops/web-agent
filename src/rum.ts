import {
  generateHex,
  generateUUID,
  getBrowserContext,
  getPayloadSize,
  extractHeaders,
  safeStringify
} from "./utils";
import { ErrorEngine } from "./error";

export interface RumConfig {
  apiKey: string;
  endpoint?: string;
  sampleRate?: number; 
  allowedOrigins?: (string | RegExp)[]; 
  autoLogs?: boolean; // Toggle to disable auto console logs (default: true)
}

export class SenzorRumAgent {
  private config: RumConfig = {
    apiKey: "",
    sampleRate: 1.0,
    allowedOrigins: [],
    autoLogs: true
  };
  private endpoint: string = "https://api.senzor.dev/api/ingest/rum";
  private initialized: boolean = false;
  private isSampled: boolean = true;

  // State
  private sessionId: string = "";
  private traceId: string = "";
  private traceStartTime: number = 0;
  private isInitialLoad: boolean = true;

  // --- BATCHING QUEUES & LIMITS ---
  private spanQueue: any[] = [];
  private errorQueue: any[] = [];
  private logQueue: any[] = []; // Browser Logs Queue
  private vitals: any = {};
  private breadcrumbs: any[] = [];
  private frustrations = { rageClicks: 0, deadClicks: 0, errorCount: 0 };
  private clickHistory: { x: number; y: number; time: number }[] = [];

  private flushInterval: any;
  private flushTimeout: any = null;
  private readonly MAX_BATCH_SIZE = 50;
  private readonly MAX_QUEUE_MEMORY = 500; 

  private errorEngine!: ErrorEngine;

  public init(config: RumConfig) {
    if (this.initialized) return;
    this.initialized = true;
    this.config = { ...this.config, ...config };
    if (config.endpoint) this.endpoint = config.endpoint;

    if (!this.config.apiKey) {
      console.error("[Senzor RUM] apiKey is required.");
      return;
    }

    this.isSampled = Math.random() <= (this.config.sampleRate ?? 1.0);

    this.manageSession();
    this.startNewTrace(true);

    this.errorEngine = new ErrorEngine({
      isSampled: this.isSampled,
      traceId: () => this.traceId,
      sessionId: this.sessionId,
      breadcrumbs: this.breadcrumbs,
      frustrations: this.frustrations,
      errorQueue: this.errorQueue,
      queueLimit: this.MAX_QUEUE_MEMORY,
      flush: () => this.debouncedFlush(),
    });
    this.errorEngine.setup();

    this.setupLogInterception(); // Fire up Auto Log Instrumentation
    this.setupPerformanceObservers();
    this.setupUXListeners();
    if (this.isSampled) this.patchNetwork();

    this.flushInterval = setInterval(() => this.flush(), 5000);
    this.setupRoutingListeners();
  }

  // --- Enterprise Auto-Log Interception ---
  private setupLogInterception() {
    if (this.config.autoLogs === false) return; // Opt-out check

    const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug
    };

    let isIntercepting = false; // Lock prevents SDK internal logs from looping infinitely

    levels.forEach(level => {
      console[level] = (...args: any[]) => {
        // ALWAYS execute original console so the developer's DevTools aren't broken!
        originalConsole[level].apply(console, args);

        if (isIntercepting) return;
        isIntercepting = true;

        try {
          let message = '';
          let attributes: Record<string, any> = {};

          args.forEach(arg => {
            if (typeof arg === 'string') {
              message += (message ? ' ' : '') + arg;
            } else if (arg instanceof Error) {
              message += (message ? ' ' : '') + arg.message;
              attributes.errorStack = arg.stack;
              attributes.errorName = arg.name;
            } else if (typeof arg === 'object' && arg !== null) {
              try {
                // New Relic Style Destructuring: Merge all object keys into `attributes`
                const parsed = JSON.parse(safeStringify(arg));
                attributes = { ...attributes, ...parsed };
              } catch (e) {
                attributes.unparseableObject = true;
              }
            } else {
              message += (message ? ' ' : '') + String(arg);
            }
          });

          if (!message && Object.keys(attributes).length > 0) {
            message = 'Object Log';
          }

          // Push to in-memory queue
          this.logQueue.push({
            message: message || 'Empty log',
            level: level === 'log' ? 'info' : level, // Map generic log to info
            attributes,
            traceId: this.isSampled ? this.traceId : undefined,
            sessionId: this.sessionId,
            url: window.location.href, // Inject page context
            timestamp: new Date().toISOString()
          });

          // Memory limits
          if (this.logQueue.length > this.MAX_QUEUE_MEMORY) {
            this.logQueue.shift();
          }

          // Trigger flush if batch gets too big
          if (this.logQueue.length >= this.MAX_BATCH_SIZE) {
            this.debouncedFlush();
          }
        } catch (e) {
          // Never crash host app during logging
        } finally {
          isIntercepting = false; // Release lock
        }
      };
    });
  }

  private manageSession() {
    if (!sessionStorage.getItem("sz_rum_sid")) {
      sessionStorage.setItem("sz_rum_sid", generateUUID());
    }
    this.sessionId = sessionStorage.getItem("sz_rum_sid") as string;
  }

  private startNewTrace(isInitialLoad: boolean) {
    this.traceId = generateHex(32);
    this.traceStartTime = Date.now();
    this.isInitialLoad = isInitialLoad;
    this.vitals = {};
    this.frustrations = { rageClicks: 0, deadClicks: 0, errorCount: 0 };
  }

  private addBreadcrumb(type: string, message: string, data?: any) {
    this.breadcrumbs.push({ type, message, data, time: Date.now() });
    if (this.breadcrumbs.length > 20) this.breadcrumbs.shift();
  }

  private setupUXListeners() {
    document.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const tag = target.tagName ? target.tagName.toLowerCase() : "";

      this.addBreadcrumb(
        "click",
        `Clicked ${tag}${target.id ? "#" + target.id : ""}${target.className ? "." + target.className?.split(" ")?.[0] : ""}`
      );

      const interactiveElements = ["a", "button", "input", "select", "textarea", "label"];
      const isInteractive =
        interactiveElements.includes(tag) ||
        target.closest("button") ||
        target.closest("a") ||
        target.hasAttribute("role") ||
        target.onclick;
        
      if (!isInteractive) this.frustrations.deadClicks++;

      const now = Date.now();
      this.clickHistory.push({ x: e.clientX, y: e.clientY, time: now });
      this.clickHistory = this.clickHistory.filter((c) => now - c.time < 1000);

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
          this.addBreadcrumb("frustration", "Rage Click Detected");
          this.clickHistory = [];
        }
      }
    }, { capture: true, passive: true });
  }

  private setupPerformanceObservers() {
    if (!this.isSampled || typeof PerformanceObserver === "undefined") return;
    try {
      new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntriesByName("first-contentful-paint")) {
          this.vitals.fcp = entry.startTime;
        }
      }).observe({ type: "paint", buffered: true });

      new PerformanceObserver((entryList) => {
        const entries = entryList.getEntries();
        const lastEntry = entries[entries.length - 1];
        if (lastEntry) this.vitals.lcp = lastEntry.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });

      let clsScore = 0;
      new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) {
          if (!(entry as any).hadRecentInput) {
            clsScore += (entry as any).value;
            this.vitals.cls = clsScore;
          }
        }
      }).observe({ type: "layout-shift", buffered: true });

      new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) {
          const evt = entry as any;
          const delay = evt.duration || (evt.processingStart && evt.startTime ? evt.processingStart - evt.startTime : 0);
          if (!this.vitals.inp || delay > this.vitals.inp) {
            this.vitals.inp = delay;
          }
        }
      }).observe({ type: "event", buffered: true, durationThreshold: 40 } as any);
    } catch (e) {}
  }

  private getNavigationTimings() {
    if (typeof performance === "undefined") return {};
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
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

  private shouldAttachTraceHeader(url: string): boolean {
    if (!this.config.allowedOrigins || this.config.allowedOrigins.length === 0) return false;
    try {
      const targetUrl = new URL(url, window.location.origin);
      return this.config.allowedOrigins.some((allowed) => {
        if (typeof allowed === "string") return targetUrl.origin.includes(allowed);
        if (allowed instanceof RegExp) return allowed.test(targetUrl.origin);
        return false;
      });
    } catch { return false; }
  }

  private pushSpan(span: any) {
    if (this.spanQueue.length >= this.MAX_QUEUE_MEMORY) this.spanQueue.shift(); 
    this.spanQueue.push(span);
    if (this.spanQueue.length >= this.MAX_BATCH_SIZE) this.debouncedFlush();
  }

  private patchNetwork() {
    const self = this;

    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;
    const originalXhrSetReqHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (method: string, url: string, ...rest: any[]) {
      (this as any).__szMethod = method.toUpperCase();
      (this as any).__szUrl = url;
      (this as any).__szHeaders = {};
      return originalXhrOpen.apply(this, [method, url, ...rest] as any);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (header: string, value: string) {
      if (!(this as any).__szHeaders) (this as any).__szHeaders = {};
      (this as any).__szHeaders[header] = value;
      return originalXhrSetReqHeader.apply(this, [header, value]);
    };

    XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      const xhr = this as any;
      const spanId = generateHex(16);
      const startTime = Date.now() - self.traceStartTime;
      const method = xhr.__szMethod;
      let fullUrl = xhr.__szUrl;

      try { fullUrl = new URL(xhr.__szUrl, window.location.origin).toString(); } catch (e) {}

      if (self.shouldAttachTraceHeader(fullUrl)) {
        xhr.setRequestHeader("traceparent", `00-${self.traceId}-${spanId}-01`);
      }

      xhr.addEventListener("loadend", () => {
        const duration = Date.now() - self.traceStartTime - startTime;

        let responseHeaders = {};
        try {
          const rawHeaders = xhr.getAllResponseHeaders();
          responseHeaders = rawHeaders?.trim()?.split(/[\r\n]+/)?.reduce((acc: any, line: string) => {
            const parts = line?.split(": ");
            const header = parts?.shift();
            const value = parts?.join(": ");
            if (header) acc[header] = value;
            return acc;
          }, {});
        } catch (e) {}

        const meta: any = {
          url: fullUrl,
          method,
          library: "xhr",
          status: xhr.status,
          responseType: xhr.responseType,
          requestPayloadSize: getPayloadSize(body),
          requestHeaders: xhr.__szHeaders,
          responseHeaders,
        };

        try {
          if (xhr.responseType === "" || xhr.responseType === "text") {
            meta.responsePayloadSize = xhr.responseText?.length;
          }
        } catch (e) {}

        self.pushSpan({
          spanId,
          name: `${method} ${new URL(fullUrl, window.location.origin).pathname}`,
          type: "http",
          startTime,
          duration,
          status: xhr.status,
          meta,
        });
      });

      return originalXhrSend.call(this, body);
    };

    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      const requestInfo = args[0];
      const init = args[1];

      let url = "";
      let method = "GET";

      if (typeof requestInfo === "string" || requestInfo instanceof URL) {
        url = requestInfo.toString();
        method = (init?.method || "GET").toUpperCase();
      } else if (requestInfo instanceof Request) {
        url = requestInfo.url;
        method = requestInfo.method.toUpperCase();
      }

      let fullUrl = url;
      try { fullUrl = new URL(url, window.location.origin).toString(); } catch (e) {}

      const spanId = generateHex(16);
      const startTime = Date.now() - self.traceStartTime;

      let reqHeadersObj = extractHeaders(init?.headers || (requestInfo instanceof Request ? requestInfo.headers : {}));

      if (self.shouldAttachTraceHeader(fullUrl)) {
        const traceHeader = `00-${self.traceId}-${spanId}-01`;
        if (requestInfo instanceof Request) {
          const currentHeaders = new Headers(requestInfo.headers);
          currentHeaders.set("traceparent", traceHeader);
          args[1] = { ...(init || {}), headers: currentHeaders };
        } else {
          const currentHeaders = new Headers(init?.headers || {});
          currentHeaders.set("traceparent", traceHeader);
          args[1] = { ...(init || {}), headers: currentHeaders };
        }
        reqHeadersObj["traceparent"] = traceHeader;
      }

      const captureSpan = (status: number, response?: Response, errorMsg?: string) => {
        const duration = Date.now() - self.traceStartTime - startTime;

        const meta: any = {
          url: fullUrl,
          method,
          library: "fetch",
          status,
          requestPayloadSize: getPayloadSize(init?.body),
          requestHeaders: reqHeadersObj,
        };

        if (response) {
          meta.statusText = response.statusText;
          meta.type = response.type;
          meta.redirected = response.redirected;
          meta.responseHeaders = extractHeaders(response.headers);
        }

        if (errorMsg) meta.error = errorMsg;

        self.pushSpan({
          spanId,
          name: `${method} ${new URL(fullUrl, window.location.origin).pathname}`,
          type: "http",
          startTime,
          duration,
          status,
          meta,
        });
      };

      try {
        const response = await originalFetch.apply(this, args);
        captureSpan(response.status, response);
        return response;
      } catch (error) {
        captureSpan(0, undefined, error instanceof Error ? error.message : String(error));
        throw error;
      }
    };
  }

  private setupRoutingListeners() {
    const originalPushState = history.pushState;
    history.pushState = (...args) => {
      this.flush();
      originalPushState.apply(history, args);
      this.startNewTrace(false);
      this.addBreadcrumb("navigation", window.location.pathname);
    };

    window.addEventListener("popstate", () => {
      this.flush();
      this.startNewTrace(false);
      this.addBreadcrumb("navigation", window.location.pathname);
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.flush();
    });

    window.addEventListener("pagehide", () => this.flush());
  }

  private debouncedFlush() {
    if (this.flushTimeout) clearTimeout(this.flushTimeout);
    this.flushTimeout = setTimeout(() => this.flush(), 100); 
  }

  private flush() {
    if (this.spanQueue.length === 0 && this.errorQueue.length === 0 && this.logQueue.length === 0 && !this.isInitialLoad) return;

    const spansToSend = this.spanQueue.splice(0, this.MAX_BATCH_SIZE);
    const errorsToSend = this.errorQueue.splice(0, 20);
    const logsToSend = this.logQueue.splice(0, this.MAX_BATCH_SIZE); // Extract Logs for batching

    const payload: any = { traces: [], errors: errorsToSend, logs: logsToSend };

    if (this.isSampled) {
      payload.traces.push({
        traceId: this.traceId,
        sessionId: this.sessionId,
        traceType: this.isInitialLoad ? "initial_load" : "route_change",
        path: window.location.pathname,
        referrer: document.referrer || "",
        vitals: { ...this.vitals },
        timings: this.isInitialLoad ? this.getNavigationTimings() : {},
        frustration: { ...this.frustrations },
        ...getBrowserContext(),
        spans: spansToSend,
        duration: Date.now() - this.traceStartTime,
        timestamp: new Date(this.traceStartTime).toISOString(),
      });
    }

    this.isInitialLoad = false;

    if (payload.traces.length > 0 || payload.errors.length > 0 || payload.logs.length > 0) {
      const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });

      const separator = this.endpoint.includes("?") ? "&" : "?";
      const authUrl = `${this.endpoint}${separator}apiKey=${this.config.apiKey}`;

      if (navigator.sendBeacon && blob.size < 60000) { 
        navigator.sendBeacon(authUrl, blob);
      } else {
        fetch(authUrl, {
          method: "POST",
          body: blob,
          keepalive: true,
          headers: { "x-service-api-key": this.config.apiKey },
        }).catch(() => {});
      }
    }
  }
}