import { generateUUID } from './utils';

export interface AnalyticsConfig {
  webId: string;
  endpoint?: string;
}

export class SenzorAnalyticsAgent {
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
  }

  private trackPing() {
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
  }

  private send(data: any) {
    if (navigator.sendBeacon) {
      if (!navigator.sendBeacon(this.endpoint, new Blob([JSON.stringify(data)], { type: 'application/json' }))) {
        this.fallbackSend(data);
      }
    } else {
      this.fallbackSend(data);
    }
  }

  private fallbackSend(data: any) {
    fetch(this.endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
      keepalive: true,
      headers: { 'Content-Type': 'application/json' }
    }).catch(() => { });
  }

  private setupListeners() {
    const originalPushState = history.pushState;
    history.pushState = (...args) => {
      this.trackPing();
      originalPushState.apply(history, args);
      this.trackPageView();
    };
    window.addEventListener('popstate', () => {
      this.trackPing();
      this.trackPageView();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.trackPing();
      } else {
        this.startTime = Date.now();
        this.manageSession();
      }
    });
    window.addEventListener('beforeunload', () => this.trackPing());
  }
}