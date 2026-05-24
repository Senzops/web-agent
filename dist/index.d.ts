interface AnalyticsConfig {
    webId: string;
    endpoint?: string;
}
declare class SenzorAnalyticsAgent {
    private config;
    private startTime;
    private endpoint;
    private initialized;
    private unsubRouting;
    private visibilityHandler;
    private beforeUnloadHandler;
    init(config: AnalyticsConfig): void;
    destroy(): void;
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
    private manageSession;
    private startNewTrace;
    private addBreadcrumb;
    private setupUXListeners;
    private setupPerformanceObservers;
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
    initRum: (config: RumConfig) => void;
    startSpan: (name: string, meta?: Record<string, any>) => {
        end: (endMeta?: Record<string, any>) => void;
    };
    destroy: () => void;
};

export { Analytics, type AnalyticsConfig, RUM, type RumConfig, Senzor, SenzorAnalyticsAgent, SenzorRumAgent };
