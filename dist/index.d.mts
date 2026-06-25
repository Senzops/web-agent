interface AnalyticsConfig {
    webId: string;
    endpoint?: string;
    /** Auto-bind clicks on elements carrying `data-senzor-event`. Default: true. */
    trackAttributes?: boolean;
    /** Auto-track clicks on links leaving the current host. Default: false. */
    outboundLinks?: boolean;
    /** Auto-track clicks on links to downloadable files. Default: false. */
    fileDownloads?: boolean;
    /** Override the default list of download file extensions (without dots). */
    downloadExtensions?: string[];
}
declare class SenzorAnalyticsAgent {
    private config;
    private startTime;
    private endpoint;
    private initialized;
    private unsubRouting;
    private visibilityHandler;
    private beforeUnloadHandler;
    private clickHandler;
    private static readonly OUTBOUND_EVENT;
    private static readonly DOWNLOAD_EVENT;
    private static readonly MAX_PROPS;
    private static readonly DEFAULT_DOWNLOAD_EXT;
    init(config: AnalyticsConfig): void;
    /**
     * Track a custom event.
     *
     *   Senzor.track('Signup', { plan: 'pro', trial: true });
     *
     * Properties must be scalars (string / number / boolean); other types are
     * dropped. Bounded to 50 properties and 512-char string values to match the
     * server contract. Safe to call any time after init — never throws.
     */
    track(eventName: string, props?: Record<string, any>): void;
    private sanitizeProps;
    destroy(): void;
    private setupEventCapture;
    private isDownload;
    private normalizeUrl;
    private manageSession;
    private determineReferrer;
    private getIds;
    private trackPageView;
    private trackPing;
    private send;
    private fallbackSend;
    private setupListeners;
}

interface RumConfig {
    apiKey: string;
    endpoint?: string;
    sampleRate?: number;
    allowedOrigins?: (string | RegExp)[];
    autoLogs?: boolean;
}
declare class SenzorRumAgent {
    private config;
    private endpoint;
    private initialized;
    private isSampled;
    private sessionId;
    private traceId;
    private traceStartTime;
    private isInitialLoad;
    private isFirstFlushOfTrace;
    private spanQueue;
    private errorQueue;
    private logQueue;
    private vitals;
    private breadcrumbs;
    private frustrations;
    private clickHistory;
    private clsSessionEntries;
    private clsSessionValue;
    private clsMaxSessionValue;
    private clsSessionStartTime;
    private inpEntries;
    private readonly MAX_INP_ENTRIES;
    private flushInterval;
    private flushTimeout;
    private readonly MAX_BATCH_SIZE;
    private readonly MAX_QUEUE_MEMORY;
    private errorEngine;
    private unsubRouting;
    private visibilityHandler;
    private pageHideHandler;
    private clickHandler;
    /**
     * Enterprise Custom Span API
     */
    startSpan(name: string, meta?: Record<string, any>): {
        end: (endMeta?: Record<string, any>) => void;
    };
    init(config: RumConfig): void;
    private setupLogInterception;
    private static readonly SESSION_TIMEOUT_MS;
    private manageSession;
    private startNewTrace;
    private addBreadcrumb;
    private setupUXListeners;
    private setupPerformanceObservers;
    private computeINP;
    private captureNavigationSpans;
    private getNavigationTimings;
    private shouldAttachTraceHeader;
    private pushSpan;
    private patchNetwork;
    destroy(): void;
    private setupRoutingListeners;
    private debouncedFlush;
    private flush;
}

declare const Analytics: SenzorAnalyticsAgent;
declare const RUM: SenzorRumAgent;
declare const Senzor: {
    init: (config: AnalyticsConfig) => void;
    track: (eventName: string, props?: Record<string, any>) => void;
    initRum: (config: RumConfig) => void;
    startSpan: (name: string, meta?: Record<string, any>) => {
        end: (endMeta?: Record<string, any>) => void;
    };
    destroy: () => void;
};

export { Analytics, type AnalyticsConfig, RUM, type RumConfig, Senzor, SenzorAnalyticsAgent, SenzorRumAgent };
