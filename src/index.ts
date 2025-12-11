interface Config {
  webId: string;
  endpoint?: string;
}

interface Payload {
  type: 'pageview' | 'ping';
  webId: string;
  visitorId: string;
  sessionId: string;
  url: string;
  path: string;
  title: string;
  referrer: string;
  width: number;
  timezone: string;
  duration?: number;
}

// Browser-Native UUID (No Node.js dependencies)
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

class SenzorWebAgent {
  private config: Config;
  private startTime: number;
  private endpoint: string;
  private initialized: boolean;

  constructor() {
    this.config = { webId: '', endpoint: 'https://api.senzor.dev/api/ingest/web' };
    this.startTime = Date.now();
    this.endpoint = '';
    this.initialized = false;
  }

  public init(config: Config) {
    if (this.initialized) {
      console.warn('[Senzor] Agent already initialized.');
      return;
    }
    this.initialized = true;

    this.config = { ...this.config, ...config };
    this.endpoint = this.config.endpoint || 'https://api.senzor.dev/api/ingest/web';

    if (!this.config.webId) {
      console.error('[Senzor] WebId is required.');
      return;
    }

    this.manageSession();
    this.trackPageView();
    this.setupListeners();
  }

  // Helper to normalize referrer (strip protocol)
  private normalizeUrl(url: string): string {
    if (!url) return '';
    return url.replace(/^https?:\/\//, '');
  }

  private manageSession() {
    const now = Date.now();
    const lastActivity = parseInt(localStorage.getItem('senzor_last_activity') || '0', 10);
    const sessionTimeout = 30 * 60 * 1000; // 30 mins

    // Visitor ID (Persistent 1 Year)
    if (!localStorage.getItem('senzor_vid')) {
      localStorage.setItem('senzor_vid', generateUUID());
    }

    // Session ID
    let sessionId = sessionStorage.getItem('senzor_sid');
    const isExpired = (now - lastActivity > sessionTimeout);

    // Session logic
    if (!sessionId || isExpired) {
      sessionId = generateUUID();
      sessionStorage.setItem('senzor_sid', sessionId);
      this.determineReferrer(true);
    } else {
      // Ongoing session: Check if external source changed
      this.determineReferrer(false);
    }

    localStorage.setItem('senzor_last_activity', now.toString());
  }

  private determineReferrer(isNewSession: boolean) {
    const rawReferrer = document.referrer;
    const currentHost = window.location.hostname;
    let storedReferrer = sessionStorage.getItem('senzor_ref');

    let isExternal = false;
    if (rawReferrer) {
      try {
        const refUrl = new URL(rawReferrer);
        // Compare hosts
        if (refUrl.hostname !== currentHost) {
          isExternal = true;
        }
      } catch (e) {
        isExternal = true;
      }
    }

    if (isExternal) {
      // Always overwrite if it's a new external source
      const cleanRef = this.normalizeUrl(rawReferrer);
      // Only update if different to avoid redundant writes
      if (cleanRef !== storedReferrer) {
        sessionStorage.setItem('senzor_ref', cleanRef);
      }
    } else if (isNewSession && !storedReferrer) {
      // New session with internal/no referrer = Direct
      sessionStorage.setItem('senzor_ref', 'Direct');
    }
  }

  private getIds() {
    localStorage.setItem('senzor_last_activity', Date.now().toString());
    return {
      visitorId: localStorage.getItem('senzor_vid') || 'unknown',
      sessionId: sessionStorage.getItem('senzor_sid') || 'unknown',
      referrer: sessionStorage.getItem('senzor_ref') || 'Direct'
    };
  }

  private trackPageView() {
    this.manageSession();
    this.startTime = Date.now();

    const payload: Payload = {
      type: 'pageview',
      webId: this.config.webId,
      ...this.getIds(),
      url: window.location.href,
      path: window.location.pathname,
      title: document.title,
      width: window.innerWidth,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      referrer: this.getIds().referrer
    };

    this.send(payload);
  }

  private trackPing() {
    const duration = Math.floor((Date.now() - this.startTime) / 1000);
    if (duration < 1) return;

    const payload: Payload = {
      type: 'ping',
      webId: this.config.webId,
      ...this.getIds(),
      url: window.location.href,
      path: window.location.pathname,
      title: document.title,
      width: window.innerWidth,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      referrer: this.getIds().referrer,
      duration: duration
    };

    this.send(payload);
  }

  private send(data: Payload) {
    if (navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const success = navigator.sendBeacon(this.endpoint, blob);
      if (!success) this.fallbackSend(data);
    } else {
      this.fallbackSend(data);
    }
  }

  private fallbackSend(data: Payload) {
    fetch(this.endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
      keepalive: true,
      headers: { 'Content-Type': 'application/json' }
    }).catch(err => console.error('[Senzor] Telemetry Error:', err));
  }

  private setupListeners() {
    // SPA Support
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

    // Visibility & Unload
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.trackPing();
      } else {
        // User returned, restart timer (don't count background time)
        this.startTime = Date.now();
        this.manageSession();
      }
    });

    window.addEventListener('beforeunload', () => {
      this.trackPing();
    });
  }
}

export const Senzor = new SenzorWebAgent();

if (typeof window !== 'undefined') {
  (window as any).Senzor = Senzor;
}