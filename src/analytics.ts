import { generateUUID, safeStringify, safeLocalStorage, safeSessionStorage, onRouteChange } from './utils';

export interface AnalyticsConfig {
  webId: string;
  endpoint?: string;
}

export class SenzorAnalyticsAgent {
  private config: AnalyticsConfig = { webId: '' };
  private startTime: number = Date.now();
  private endpoint: string = 'https://api.senzor.dev/api/ingest/web';
  private initialized: boolean = false;
  private unsubRouting: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;
  private beforeUnloadHandler: (() => void) | null = null;

  public init(config: AnalyticsConfig) {
    if (this.initialized) return;
    this.initialized = true;
    this.config = { ...this.config, ...config };
    if (config.endpoint) this.endpoint = config.endpoint;

    if (!this.config.webId || typeof this.config.webId !== 'string') {
      console.error('[Senzor] webId is required for Analytics.');
      return;
    }

    try {
      this.manageSession();
      this.trackPageView();
      this.setupListeners();
    } catch (e) {
      // Non-blocking
    }
  }

  public destroy() {
    if (this.unsubRouting) { this.unsubRouting(); this.unsubRouting = null; }
    if (this.visibilityHandler) { document.removeEventListener('visibilitychange', this.visibilityHandler); this.visibilityHandler = null; }
    if (this.beforeUnloadHandler) { window.removeEventListener('beforeunload', this.beforeUnloadHandler); this.beforeUnloadHandler = null; }
    this.initialized = false;
  }

  private normalizeUrl(url: string): string {
    return url ? url.replace(/^https?:\/\//, '').replace(/^www\./, '') : '';
  }

  private manageSession() {
    const now = Date.now();
    const lastActivity = parseInt(safeLocalStorage.getItem('senzor_last_activity') || '0', 10);
    const sessionTimeout = 30 * 60 * 1000; // 30 minutes

    if (!safeLocalStorage.getItem('senzor_vid')) safeLocalStorage.setItem('senzor_vid', generateUUID());

    let sessionId = safeSessionStorage.getItem('senzor_sid');
    const isExpired = (now - lastActivity > sessionTimeout);

    if (!sessionId || isExpired) {
      sessionId = generateUUID();
      safeSessionStorage.setItem('senzor_sid', sessionId);
      this.determineReferrer(true);
    } else {
      this.determineReferrer(false);
    }
    safeLocalStorage.setItem('senzor_last_activity', now.toString());
  }

  private determineReferrer(isNewSession: boolean) {
    const rawReferrer = document.referrer;
    const currentHost = window.location.hostname;
    let storedReferrer = safeSessionStorage.getItem('senzor_ref');

    let isExternal = false;
    if (rawReferrer) {
      try {
        const refUrl = new URL(rawReferrer);
        if (refUrl.hostname !== currentHost) isExternal = true;
      } catch (e) { isExternal = true; }
    }

    if (isExternal) {
      const cleanRef = this.normalizeUrl(rawReferrer);
      if (cleanRef !== storedReferrer) safeSessionStorage.setItem('senzor_ref', cleanRef);
    } else if (isNewSession && !storedReferrer) {
      safeSessionStorage.setItem('senzor_ref', 'Direct');
    }
  }

  private getIds() {
    safeLocalStorage.setItem('senzor_last_activity', Date.now().toString());
    return {
      visitorId: safeLocalStorage.getItem('senzor_vid') || 'unknown',
      sessionId: safeSessionStorage.getItem('senzor_sid') || 'unknown',
      referrer: safeSessionStorage.getItem('senzor_ref') || 'Direct'
    };
  }

  private trackPageView() {
    try {
      this.manageSession();
      this.startTime = Date.now();
      this.send({
        type: 'pageview',
        webId: this.config.webId,
        ...this.getIds(),
        url: window.location.href,
        path: window.location.pathname,
        title: document.title,
        width: window.innerWidth,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        referrer: this.getIds().referrer
      });
    } catch (e) {}
  }

  private trackPing() {
    try {
      const duration = Math.floor((Date.now() - this.startTime) / 1000);
      if (duration >= 1) {
        this.send({
          type: 'ping',
          webId: this.config.webId,
          ...this.getIds(),
          url: window.location.href,
          path: window.location.pathname,
          title: document.title,
          width: window.innerWidth,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          referrer: this.getIds().referrer,
          duration
        });
      }
    } catch (e) {}
  }

  private send(data: any) {
    try {
      const payload = safeStringify(data);
      const blob = new Blob([payload], { type: 'application/json' });
      if (navigator.sendBeacon && blob.size < 60000) {
        if (!navigator.sendBeacon(this.endpoint, blob)) {
          this.fallbackSend(payload);
        }
      } else {
        this.fallbackSend(payload);
      }
    } catch (e) {}
  }

  private fallbackSend(payload: string) {
    fetch(this.endpoint, {
      method: 'POST',
      body: payload,
      keepalive: true,
      headers: { 'Content-Type': 'application/json' }
    }).catch(() => { });
  }

  private setupListeners() {
    this.unsubRouting = onRouteChange((type) => {
      try { this.trackPing(); } catch (e) {}
      try { this.trackPageView(); } catch (e) {}
    });

    this.visibilityHandler = () => {
      try {
        if (document.visibilityState === 'hidden') {
          this.trackPing();
        } else {
          this.startTime = Date.now();
          this.manageSession();
        }
      } catch (e) {}
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);

    this.beforeUnloadHandler = () => {
      try { this.trackPing(); } catch (e) {}
    };
    window.addEventListener('beforeunload', this.beforeUnloadHandler);
  }
}