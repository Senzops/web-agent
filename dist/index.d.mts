interface AnalyticsConfig {
    webId: string;
    endpoint?: string;
}
declare class SenzorAnalyticsAgent {
    private config;
    private startTime;
    private endpoint;
    private initialized;
    init(config: AnalyticsConfig): void;
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
    private spans;
    private errors;
    private breadcrumbs;
    private vitals;
    private frustrations;
    private clickHistory;
    private flushInterval;
    init(config: RumConfig): void;
    private manageSession;
    private startNewTrace;
    private addBreadcrumb;
    private setupUXListeners;
    private setupPerformanceObservers;
    private getNavigationTimings;
    private shouldAttachTraceHeader;
    private patchNetwork;
    private setupErrorListeners;
    private setupRoutingListeners;
    private flush;
}

declare const Analytics: SenzorAnalyticsAgent;
declare const RUM: SenzorRumAgent;
declare const Senzor: {
    init: (config: AnalyticsConfig) => void;
    initRum: (config: RumConfig) => void;
};

export { Analytics, type AnalyticsConfig, RUM, type RumConfig, Senzor };
