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

    // 1. Manage Session State
    this.checkSession();

    // 2. Track initial load
    this.trackPageView();

    // 3. Setup Listeners
    this.setupListeners();
  }

  // --- Standard Analytics Session Logic ---
  // A session ends after 30 minutes of inactivity.
  private checkSession() {
    const now = Date.now();
    const lastActivity = parseInt(localStorage.getItem('senzor_last_activity') || '0', 10);
    const sessionTimeout = 30 * 60 * 1000; // 30 mins

    // 1. Visitor ID (Persistent 1 Year)
    if (!localStorage.getItem('senzor_vid')) {
      localStorage.setItem('senzor_vid', generateUUID());
    }

    // 2. Session ID
    // Create new if missing OR expired
    if (!localStorage.getItem('senzor_sid') || (now - lastActivity > sessionTimeout)) {
      localStorage.setItem('senzor_sid', generateUUID());
    }

    // Update Activity
    localStorage.setItem('senzor_last_activity', now.toString());
  }

  private getIds() {
    // Refresh activity timestamp on every hit
    localStorage.setItem('senzor_last_activity', Date.now().toString());
    return {
      visitorId: localStorage.getItem('senzor_vid') || 'unknown',
      sessionId: localStorage.getItem('senzor_sid') || 'unknown'
    };
  }

  private trackPageView() {
    // Ensure session is valid before tracking
    this.checkSession();
    this.startTime = Date.now();

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

  private trackPing() {
    const duration = Math.floor((Date.now() - this.startTime) / 1000);
    if (duration < 1) return;

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
      this.trackPing(); // End previous page
      originalPushState.apply(history, args);
      this.trackPageView(); // Start new page
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
        this.checkSession(); // Verify session hasn't expired while tab was hidden
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