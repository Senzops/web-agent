import { v4 as uuidv4 } from 'uuid';

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
  referrer: string;
  width: number;
  timezone: string;
  duration?: number; // Only for pings/unload
}

class SenzorWebAgent {
  private config: Config;
  private startTime: number;
  private endpoint: string;

  constructor() {
    this.config = { webId: '', endpoint: 'https://api.senzor.dev/api/ingest/web' };
    this.startTime = Date.now();
    this.endpoint = '';
  }

  public init(config: Config) {
    this.config = { ...this.config, ...config };
    // Allow overriding endpoint for self-hosting or dev
    this.endpoint = this.config.endpoint || 'https://api.senzor.dev/api/ingest/web';
    
    if (!this.config.webId) {
      console.error('[Senzor] WebId is required to initialize analytics.');
      return;
    }

    // 1. Initialize Session
    this.initSession();

    // 2. Track Initial Page View
    this.trackPageView();

    // 3. Setup Listeners
    this.setupListeners();
  }

  private initSession() {
    // Persistent Visitor ID (1 year) - Rebranded storage key
    let vid = localStorage.getItem('senzor_vid');
    if (!vid) {
      vid = uuidv4();
      localStorage.setItem('senzor_vid', vid!);
    }

    // Session ID (Expires when browser closes)
    let sid = sessionStorage.getItem('senzor_sid');
    if (!sid) {
      sid = uuidv4();
      sessionStorage.setItem('senzor_sid', sid!);
    }
  }

  private getIds() {
    return {
      visitorId: localStorage.getItem('senzor_vid') || 'unknown',
      sessionId: sessionStorage.getItem('senzor_sid') || 'unknown'
    };
  }

  private trackPageView() {
    this.startTime = Date.now(); // Reset timer for new page
    const payload: Payload = {
      type: 'pageview',
      webId: this.config.webId,
      ...this.getIds(),
      url: window.location.href,
      path: window.location.pathname,
      referrer: document.referrer,
      width: window.innerWidth,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };

    this.send(payload);
  }

  // Captures time spent on page when user leaves or hides tab
  private trackPing() {
    const duration = Math.floor((Date.now() - this.startTime) / 1000);
    if (duration < 1) return; // Ignore accidental bounces

    const payload: Payload = {
      type: 'ping',
      webId: this.config.webId,
      ...this.getIds(),
      url: window.location.href,
      path: window.location.pathname,
      referrer: document.referrer,
      width: window.innerWidth,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      duration: duration
    };

    this.send(payload);
  }

  private send(data: Payload) {
    // Use sendBeacon for reliability during unload, fallback to fetch
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
    }).catch(err => console.error('[Senzor] Failed to send telemetry:', err));
  }

  private setupListeners() {
    // 1. History API Support (SPA - React/Next.js/Vue)
    const originalPushState = history.pushState;
    history.pushState = (...args) => {
      this.trackPing(); // Send duration for previous page
      originalPushState.apply(history, args);
      this.trackPageView(); // Track new page
    };

    window.addEventListener('popstate', () => {
      this.trackPing();
      this.trackPageView();
    });

    // 2. Visibility Change (Tab switch / Minimize)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.trackPing();
      } else {
        // User came back, reset timer so we don't count background time
        this.startTime = Date.now();
      }
    });

    // 3. Before Unload (Closing tab)
    window.addEventListener('beforeunload', () => {
      this.trackPing();
    });
  }
}

// Export Singleton
export const Senzor = new SenzorWebAgent();

// Allow window access for script tag usage
if (typeof window !== 'undefined') {
  (window as any).Senzor = Senzor;
}