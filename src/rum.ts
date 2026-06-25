import {
  generateHex,
  generateUUID,
  getBrowserContext,
  getPayloadSize,
  extractHeaders,
  safeStringify,
  safeSessionStorage,
  safeLocalStorage,
  onRouteChange
} from "./utils";
import { ErrorEngine } from "./error";

export interface RumConfig {
  apiKey: string;
  endpoint?: string;
  sampleRate?: number;
  allowedOrigins?: (string | RegExp)[];
  autoLogs?: boolean;
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
  private isFirstFlushOfTrace: boolean = true;

  // --- BATCHING QUEUES & LIMITS ---
  private spanQueue: any[] = [];
  private errorQueue: any[] = [];
  private logQueue: any[] = [];
  private vitals: any = {};
  private breadcrumbs: any[] = [];
  private frustrations = { rageClicks: 0, deadClicks: 0, errorCount: 0 };
  private clickHistory: { x: number; y: number; time: number }[] = [];

  // CLS session window tracking (Google spec)
  private clsSessionEntries: { value: number; time: number }[] = [];
  private clsSessionValue: number = 0;
  private clsMaxSessionValue: number = 0;
  private clsSessionStartTime: number = 0;

  // INP P98 tracking (Google spec)
  private inpEntries: number[] = [];
  private readonly MAX_INP_ENTRIES = 200;

  private flushInterval: any;
  private flushTimeout: any = null;
  private readonly MAX_BATCH_SIZE = 50;
  private readonly MAX_QUEUE_MEMORY = 500;

  private errorEngine!: ErrorEngine;
  private unsubRouting: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;
  private pageHideHandler: (() => void) | null = null;
  private clickHandler: ((e: MouseEvent) => void) | null = null;

  /**
   * Enterprise Custom Span API
   */
  public startSpan(name: string, meta?: Record<string, any>) {
    const spanId = generateHex(16);
    const startTime = Date.now() - this.traceStartTime;
    const capturedTraceStartTime = this.traceStartTime;

    return {
      end: (endMeta?: Record<string, any>) => {
        const duration = Date.now() - capturedTraceStartTime - startTime;
        this.pushSpan({
          spanId,
          name,
          type: "custom",
          startTime,
          duration: Math.max(0, duration),
          status: 200,
          meta: { ...meta, ...endMeta },
        });
      },
    };
  }

  public init(config: RumConfig) {
    if (this.initialized) return;
    this.initialized = true;
    this.config = { ...this.config, ...config };
    if (config.endpoint) this.endpoint = config.endpoint;

    if (!this.config.apiKey) {
      console.error("[Senzor RUM] apiKey is required.");
      return;
    }

    this.isSampled = Math.random() < (this.config.sampleRate ?? 1.0);

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

    this.setupLogInterception();
    this.setupPerformanceObservers();
    this.setupUXListeners();
    if (this.isSampled) this.patchNetwork();

    this.flushInterval = setInterval(() => this.flush(), 5000);
    this.setupRoutingListeners();
  }

  // --- Enterprise Auto-Log Interception ---
  private setupLogInterception() {
    if (this.config.autoLogs === false) return;

    const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const originalConsole = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug
    };

    let isIntercepting = false;

    levels.forEach(level => {
      console[level] = (...args: any[]) => {
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

          this.logQueue.push({
            message: message || 'Empty log',
            level: level === 'log' ? 'info' : level,
            attributes,
            traceId: this.isSampled ? this.traceId : undefined,
            sessionId: this.sessionId,
            url: window.location.href,
            timestamp: new Date().toISOString()
          });

          if (this.logQueue.length > this.MAX_QUEUE_MEMORY) {
            this.logQueue.shift();
          }

          if (this.logQueue.length >= this.MAX_BATCH_SIZE) {
            this.debouncedFlush();
          }
        } catch (e) {
          // Never crash host app during logging
        } finally {
          isIntercepting = false;
        }
      };
    });
  }

  // Sessionize with a 30-minute inactivity timeout (standard analytics rule, and
  // consistent with the Web Analytics agent). Without this a long-lived tab keeps
  // one sessionId for days, producing absurd session durations. Re-evaluated on
  // every activity (init, route change, flush) so the timeout actually applies.
  private static readonly SESSION_TIMEOUT_MS = 30 * 60 * 1000;
  private manageSession() {
    const now = Date.now();
    const lastActivity = parseInt(safeLocalStorage.getItem("sz_rum_last_activity") || "0", 10);
    const expired = lastActivity > 0 && now - lastActivity > SenzorRumAgent.SESSION_TIMEOUT_MS;

    let sid = safeSessionStorage.getItem("sz_rum_sid");
    if (!sid || expired) {
      sid = generateUUID();
      safeSessionStorage.setItem("sz_rum_sid", sid);
    }
    safeLocalStorage.setItem("sz_rum_last_activity", String(now));
    this.sessionId = sid;
  }

  private startNewTrace(isInitialLoad: boolean) {
    this.traceId = generateHex(32);
    this.traceStartTime = Date.now();
    this.isInitialLoad = isInitialLoad;
    this.isFirstFlushOfTrace = true;
    this.vitals = {};

    // Reset frustrations IN-PLACE to preserve ErrorEngine's reference
    this.frustrations.rageClicks = 0;
    this.frustrations.deadClicks = 0;
    this.frustrations.errorCount = 0;

    // Reset CLS session window tracking for new page
    this.clsSessionEntries = [];
    this.clsSessionValue = 0;
    this.clsMaxSessionValue = 0;
    this.clsSessionStartTime = 0;

    // Reset INP entries for new page
    this.inpEntries = [];
  }

  private addBreadcrumb(type: string, message: string, data?: any) {
    this.breadcrumbs.push({ type, message, data, time: Date.now() });
    if (this.breadcrumbs.length > 20) this.breadcrumbs.shift();
  }

  private setupUXListeners() {
    this.clickHandler = (e: MouseEvent) => {
      try {
        const target = e.target as HTMLElement;
        if (!target) return;
        const tag = target.tagName ? target.tagName.toLowerCase() : "";

        const clickSpanId = generateHex(16);
        const clickStartTime = Date.now() - this.traceStartTime;

        this.addBreadcrumb(
          "click",
          `Clicked ${tag}${target.id ? "#" + target.id : ""}${target.className && typeof target.className === 'string' ? "." + target.className?.split(" ")?.[0] : ""}`
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

        this.pushSpan({
          spanId: clickSpanId,
          name: `Click: ${tag}${target.id ? "#" + target.id : ""}`,
          type: "interaction",
          startTime: clickStartTime,
          duration: Date.now() - this.traceStartTime - clickStartTime,
          status: 200,
          meta: {
            tag,
            id: target.id,
            classes: typeof target.className === 'string' ? target.className : '',
            isInteractive,
          },
        });
      } catch (e) {
        // Never block user clicks
      }
    };
    document.addEventListener("click", this.clickHandler, { capture: true, passive: true } as AddEventListenerOptions);
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

      // CLS with session window grouping (Google spec)
      new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) {
          if ((entry as any).hadRecentInput) continue;

          const shiftValue = (entry as any).value;
          const shiftTime = entry.startTime;

          const lastEntry = this.clsSessionEntries[this.clsSessionEntries.length - 1];
          const gap = lastEntry ? shiftTime - lastEntry.time : 0;
          const sessionDuration = this.clsSessionStartTime ? shiftTime - this.clsSessionStartTime : 0;

          if (lastEntry && gap < 1000 && sessionDuration < 5000) {
            this.clsSessionValue += shiftValue;
          } else {
            this.clsSessionValue = shiftValue;
            this.clsSessionStartTime = shiftTime;
            this.clsSessionEntries = [];
          }

          this.clsSessionEntries.push({ value: shiftValue, time: shiftTime });

          if (this.clsSessionValue > this.clsMaxSessionValue) {
            this.clsMaxSessionValue = this.clsSessionValue;
          }
          this.vitals.cls = this.clsMaxSessionValue;
        }
      }).observe({ type: "layout-shift", buffered: true });

      // INP — track all interaction durations for P98 calculation
      new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) {
          const evt = entry as any;
          const delay = evt.duration || (evt.processingStart && evt.startTime ? evt.processingStart - evt.startTime : 0);
          if (delay > 0) {
            this.inpEntries.push(delay);
            if (this.inpEntries.length > this.MAX_INP_ENTRIES) {
              this.inpEntries.sort((a, b) => a - b);
              this.inpEntries = this.inpEntries.slice(-100);
            }
            this.vitals.inp = this.computeINP();
          }
        }
      }).observe({ type: "event", buffered: true, durationThreshold: 40 } as any);

      // Resource Timing
      new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries() as PerformanceResourceTiming[]) {
          if (entry.name.includes(this.endpoint)) continue;

          this.pushSpan({
            spanId: generateHex(16),
            name: `Resource: ${entry.name.split("/").pop() || entry.name}`,
            type: "resource",
            startTime: entry.startTime,
            duration: entry.duration,
            status: 200,
            meta: {
              url: entry.name,
              initiatorType: entry.initiatorType,
              nextHopProtocol: entry.nextHopProtocol,
              decodedBodySize: entry.decodedBodySize,
              encodedBodySize: entry.encodedBodySize,
              transferSize: entry.transferSize,
              cacheHit: entry.transferSize === 0 || (entry.transferSize > 0 && entry.transferSize < entry.encodedBodySize),
            },
          });
        }
      }).observe({ type: "resource", buffered: true });

      // Long Task Monitoring
      new PerformanceObserver((entryList) => {
        for (const entry of entryList.getEntries()) {
          this.pushSpan({
            spanId: generateHex(16),
            name: "Long Task (Main Thread Blocked)",
            type: "longtask",
            startTime: entry.startTime,
            duration: entry.duration,
            status: 500,
            meta: {
              attribution: (entry as any).attribution?.[0]?.name || "unknown",
              containerType: (entry as any).attribution?.[0]?.containerType || "unknown",
            },
          });
        }
      }).observe({ type: "longtask" });
    } catch (e) {}
  }

  private computeINP(): number {
    if (this.inpEntries.length === 0) return 0;
    const sorted = [...this.inpEntries].sort((a, b) => a - b);
    if (sorted.length < 50) return sorted[sorted.length - 1];
    const p98Index = Math.ceil(sorted.length * 0.98) - 1;
    return sorted[Math.min(p98Index, sorted.length - 1)];
  }

  private captureNavigationSpans() {
    if (typeof performance === "undefined") return;
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    if (!nav) return;

    const stages = [
      { name: "DNS Lookup", start: nav.domainLookupStart, end: nav.domainLookupEnd, type: "dns" },
      { name: "TCP Connection", start: nav.connectStart, end: nav.connectEnd, type: "tcp" },
      { name: "SSL Negotiation", start: nav.secureConnectionStart, end: nav.connectEnd, type: "ssl" },
      { name: "TTFB (Wait)", start: nav.requestStart, end: nav.responseStart, type: "ttfb" },
      { name: "DOM Interactive", start: nav.responseEnd, end: nav.domInteractive, type: "dom" },
      { name: "DOM Complete", start: nav.domInteractive, end: nav.domComplete, type: "dom" },
    ];

    stages.forEach((s) => {
      if (s.end > s.start && s.start > 0) {
        this.pushSpan({
          spanId: generateHex(16),
          name: s.name,
          type: "navigation_stage",
          startTime: s.start,
          duration: s.end - s.start,
          status: 200,
          meta: { stage: s.type },
        });
      }
    });
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
      try {
        (this as any).__szMethod = method.toUpperCase();
        (this as any).__szUrl = url;
        (this as any).__szHeaders = {};
      } catch (e) {}
      return originalXhrOpen.apply(this, [method, url, ...rest] as any);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (header: string, value: string) {
      try {
        if (!(this as any).__szHeaders) (this as any).__szHeaders = {};
        (this as any).__szHeaders[header] = value;
      } catch (e) {}
      return originalXhrSetReqHeader.apply(this, [header, value]);
    };

    XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      const xhr = this as any;
      let spanId: string | undefined;
      let startTime: number | undefined;
      let method: string | undefined;
      let fullUrl: string | undefined;
      // Snapshot trace context at send time to prevent cross-trace leakage
      const capturedTraceStartTime = self.traceStartTime;

      try {
        spanId = generateHex(16);
        startTime = Date.now() - capturedTraceStartTime;
        method = xhr.__szMethod;
        fullUrl = xhr.__szUrl;

        try { fullUrl = new URL(xhr.__szUrl, window.location.origin).toString(); } catch (e) {}

        if (fullUrl && fullUrl.includes(self.endpoint)) {
          return originalXhrSend.call(this, body);
        }

        if (fullUrl && self.shouldAttachTraceHeader(fullUrl)) {
          xhr.setRequestHeader("traceparent", `00-${self.traceId}-${spanId}-01`);
        }

        xhr.addEventListener("loadend", () => {
          try {
            const duration = Date.now() - capturedTraceStartTime - (startTime || 0);

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
              name: `${method} ${fullUrl ? new URL(fullUrl, window.location.origin).pathname : 'unknown'}`,
              type: "http",
              startTime,
              duration: Math.max(0, duration),
              status: xhr.status,
              meta,
            });
          } catch (e) {}
        });
      } catch (e) {}

      return originalXhrSend.call(this, body);
    };

    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      let fullUrl = "";
      let method = "GET";
      let spanId: string | undefined;
      let startTime: number | undefined;
      let reqHeadersObj: any = {};
      // Snapshot trace context at fetch time to prevent cross-trace leakage
      const capturedTraceStartTime = self.traceStartTime;

      try {
        const requestInfo = args[0];
        const init = args[1];

        if (typeof requestInfo === "string" || requestInfo instanceof URL) {
          fullUrl = requestInfo.toString();
          method = (init?.method || "GET").toUpperCase();
        } else if (requestInfo instanceof Request) {
          fullUrl = requestInfo.url;
          method = requestInfo.method.toUpperCase();
        }

        try { fullUrl = new URL(fullUrl, window.location.origin).toString(); } catch (e) {}

        if (fullUrl.includes(self.endpoint)) {
          return originalFetch.apply(this, args);
        }

        spanId = generateHex(16);
        startTime = Date.now() - capturedTraceStartTime;

        reqHeadersObj = extractHeaders(init?.headers || (requestInfo instanceof Request ? requestInfo.headers : {}));

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
      } catch (e) {}

      const captureSpan = (status: number, response?: Response, errorMsg?: string) => {
        try {
          const duration = Date.now() - capturedTraceStartTime - (startTime || 0);

          const meta: any = {
            url: fullUrl,
            method,
            library: "fetch",
            status,
            requestPayloadSize: getPayloadSize(args[1]?.body),
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
            name: `${method} ${fullUrl ? new URL(fullUrl, window.location.origin).pathname : 'unknown'}`,
            type: "http",
            startTime,
            duration: Math.max(0, duration),
            status,
            meta,
          });
        } catch (e) {}
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

  public destroy() {
    if (this.flushInterval) { clearInterval(this.flushInterval); this.flushInterval = null; }
    if (this.flushTimeout) { clearTimeout(this.flushTimeout); this.flushTimeout = null; }
    if (this.unsubRouting) { this.unsubRouting(); this.unsubRouting = null; }
    if (this.visibilityHandler) { document.removeEventListener('visibilitychange', this.visibilityHandler); this.visibilityHandler = null; }
    if (this.pageHideHandler) { window.removeEventListener('pagehide', this.pageHideHandler); this.pageHideHandler = null; }
    if (this.clickHandler) { document.removeEventListener('click', this.clickHandler, true); this.clickHandler = null; }
    this.flush();
    this.initialized = false;
  }

  private setupRoutingListeners() {
    this.unsubRouting = onRouteChange(() => {
      try { this.flush(); } catch (e) {}
      try {
        this.manageSession(); // re-evaluate the inactivity window on navigation
        this.startNewTrace(false);
        this.addBreadcrumb("navigation", window.location.pathname);
      } catch (e) {}
    });

    this.visibilityHandler = () => {
      try {
        if (document.visibilityState === "hidden") {
          this.pushSpan({
            spanId: generateHex(16),
            name: "App Backgrounded",
            type: "visibility",
            startTime: Date.now() - this.traceStartTime,
            duration: 0,
            status: 200,
            meta: { state: "hidden" },
          });
          this.flush();
        } else {
          this.pushSpan({
            spanId: generateHex(16),
            name: "App Foregrounded",
            type: "visibility",
            startTime: Date.now() - this.traceStartTime,
            duration: 0,
            status: 200,
            meta: { state: "visible" },
          });
        }
      } catch (e) {}
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);

    this.pageHideHandler = () => {
      try { this.flush(); } catch (e) {}
    };
    window.addEventListener("pagehide", this.pageHideHandler);
  }

  private debouncedFlush() {
    if (this.flushTimeout) clearTimeout(this.flushTimeout);
    this.flushTimeout = setTimeout(() => this.flush(), 100);
  }

  private flush() {
    try {
      if (this.flushTimeout) {
        clearTimeout(this.flushTimeout);
        this.flushTimeout = null;
      }

      // Capture navigation spans BEFORE splice so they're included in the initial_load trace
      if (this.isSampled && this.isInitialLoad) {
        this.captureNavigationSpans();
      }

      if (this.spanQueue.length === 0 && this.errorQueue.length === 0 && this.logQueue.length === 0 && !this.isInitialLoad) return;

      // Only real telemetry activity refreshes the session window — idle 5s ticks
      // return above, so a session correctly expires after 30 min of inactivity.
      this.manageSession();

      const spansToSend = this.spanQueue.splice(0, this.MAX_BATCH_SIZE);
      const errorsToSend = this.errorQueue.splice(0, 20);
      const logsToSend = this.logQueue.splice(0, this.MAX_BATCH_SIZE);

      const payload: any = { traces: [], errors: errorsToSend, logs: logsToSend };

      if (this.isSampled) {
        const isFirstFlush = this.isFirstFlushOfTrace;
        const traceType = this.isInitialLoad ? "initial_load" : (isFirstFlush ? "route_change" : "span_update");

        payload.traces.push({
          traceId: this.traceId,
          sessionId: this.sessionId,
          traceType,
          path: window.location.pathname,
          referrer: document.referrer || "",
          // Only send vitals and frustration on the first flush per trace
          // span_updates carry empty vitals to avoid double-counting on backend
          vitals: isFirstFlush || this.isInitialLoad ? { ...this.vitals } : {},
          timings: this.isInitialLoad ? this.getNavigationTimings() : {},
          frustration: isFirstFlush || this.isInitialLoad
            ? { ...this.frustrations }
            : { rageClicks: 0, deadClicks: 0, errorCount: 0 },
          ...getBrowserContext(),
          spans: spansToSend,
          duration: Date.now() - this.traceStartTime,
          timestamp: new Date(this.traceStartTime).toISOString(),
        });
        this.isFirstFlushOfTrace = false;
      }

      this.isInitialLoad = false;

      if (payload.traces.length > 0 || payload.errors.length > 0 || payload.logs.length > 0) {
        payload.apiKey = this.config.apiKey;
        const jsonPayload = safeStringify(payload);
        const blob = new Blob([jsonPayload], { type: "application/json" });

        if (navigator.sendBeacon && blob.size < 60000) {
          navigator.sendBeacon(this.endpoint, blob);
        } else {
          fetch(this.endpoint, {
            method: "POST",
            body: blob,
            keepalive: true,
            headers: {
              "Content-Type": "application/json",
              "x-service-api-key": this.config.apiKey,
            },
          }).catch(() => {});
        }
      }
    } catch (e) {
      // Critical: Never allow ingestion failures to crash the host application
    }
  }
}
