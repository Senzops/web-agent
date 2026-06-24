import { generateUUID, safeStringify, safeLocalStorage, safeSessionStorage, onRouteChange } from './utils';

export interface AnalyticsConfig {
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

export class SenzorAnalyticsAgent {
  private config: AnalyticsConfig = {
    webId: '',
    trackAttributes: true,
    outboundLinks: false,
    fileDownloads: false,
  };
  private startTime: number = Date.now();
  private endpoint: string = 'https://api.senzor.dev/api/ingest/web';
  private initialized: boolean = false;
  private unsubRouting: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;
  private beforeUnloadHandler: (() => void) | null = null;
  private clickHandler: ((e: MouseEvent) => void) | null = null;

  // Reserved event names used by auto-capture.
  private static readonly OUTBOUND_EVENT = 'Outbound Link';
  private static readonly DOWNLOAD_EVENT = 'File Download';
  private static readonly MAX_PROPS = 50;
  private static readonly DEFAULT_DOWNLOAD_EXT = [
    'pdf', 'csv', 'xlsx', 'xls', 'doc', 'docx', 'ppt', 'pptx', 'zip', 'rar', '7z',
    'gz', 'tar', 'dmg', 'exe', 'pkg', 'msi', 'apk', 'deb', 'rpm',
    'mp3', 'mp4', 'mov', 'avi', 'wav', 'txt', 'json', 'xml',
  ];

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
      this.setupEventCapture();
    } catch (e) {
      // Non-blocking
    }
  }

  /**
   * Track a custom event.
   *
   *   Senzor.track('Signup', { plan: 'pro', trial: true });
   *
   * Properties must be scalars (string / number / boolean); other types are
   * dropped. Bounded to 50 properties and 512-char string values to match the
   * server contract. Safe to call any time after init — never throws.
   */
  public track(eventName: string, props?: Record<string, any>) {
    try {
      if (!this.initialized || !this.config.webId) return;
      if (typeof eventName !== 'string' || !eventName.trim()) return;

      this.manageSession();
      this.send({
        type: 'event',
        webId: this.config.webId,
        ...this.getIds(),
        eventName: eventName.trim().slice(0, 64),
        props: this.sanitizeProps(props),
        url: window.location.href,
        path: window.location.pathname,
        title: document.title,
        width: window.innerWidth,
        height: window.innerHeight,
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        referrer: this.getIds().referrer,
      });
    } catch (e) {}
  }

  private sanitizeProps(props?: Record<string, any>): Record<string, any> | undefined {
    if (!props || typeof props !== 'object') return undefined;
    const out: Record<string, any> = {};
    let count = 0;
    for (const rawKey of Object.keys(props)) {
      if (count >= SenzorAnalyticsAgent.MAX_PROPS) break;
      const key = String(rawKey).slice(0, 64);
      const val = props[rawKey];
      if (typeof val === 'string') out[key] = val.slice(0, 512);
      else if (typeof val === 'number' && isFinite(val)) out[key] = val;
      else if (typeof val === 'boolean') out[key] = val;
      else continue;
      count++;
    }
    return Object.keys(out).length ? out : undefined;
  }

  public destroy() {
    if (this.unsubRouting) { this.unsubRouting(); this.unsubRouting = null; }
    if (this.visibilityHandler) { document.removeEventListener('visibilitychange', this.visibilityHandler); this.visibilityHandler = null; }
    if (this.beforeUnloadHandler) { window.removeEventListener('beforeunload', this.beforeUnloadHandler); this.beforeUnloadHandler = null; }
    if (this.clickHandler) { document.removeEventListener('click', this.clickHandler, true); this.clickHandler = null; }
    this.initialized = false;
  }

  // --- Declarative + auto-capture click tracking ---
  private setupEventCapture() {
    if (!this.config.trackAttributes && !this.config.outboundLinks && !this.config.fileDownloads) return;

    this.clickHandler = (e: MouseEvent) => {
      try {
        const target = e.target as HTMLElement;
        if (!target || typeof target.closest !== 'function') return;

        // 1) Declarative tracking: data-senzor-event="Name" data-senzor-event-foo="bar"
        if (this.config.trackAttributes) {
          const el = target.closest('[data-senzor-event]') as HTMLElement | null;
          if (el) {
            const name = el.getAttribute('data-senzor-event');
            if (name) {
              const props: Record<string, any> = {};
              for (const attr of Array.from(el.attributes)) {
                if (attr.name.indexOf('data-senzor-event-') === 0) {
                  const propKey = attr.name.slice('data-senzor-event-'.length);
                  if (propKey) props[propKey] = attr.value;
                }
              }
              this.track(name, Object.keys(props).length ? props : undefined);
              return; // Declarative intent wins — don't double-fire auto-capture.
            }
          }
        }

        // 2) Auto-capture outbound links & file downloads
        if (this.config.outboundLinks || this.config.fileDownloads) {
          const anchor = target.closest('a') as HTMLAnchorElement | null;
          if (!anchor || !anchor.href) return;

          let urlObj: URL | null = null;
          try { urlObj = new URL(anchor.href, window.location.href); } catch { return; }
          if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') return;

          if (this.config.fileDownloads && this.isDownload(urlObj.pathname)) {
            const file = urlObj.pathname.split('/').pop() || urlObj.pathname;
            this.track(SenzorAnalyticsAgent.DOWNLOAD_EVENT, { url: anchor.href, file });
          } else if (this.config.outboundLinks && urlObj.hostname !== window.location.hostname) {
            this.track(SenzorAnalyticsAgent.OUTBOUND_EVENT, { url: anchor.href });
          }
        }
      } catch (e) {}
    };

    document.addEventListener('click', this.clickHandler, { capture: true, passive: true } as AddEventListenerOptions);
  }

  private isDownload(pathname: string): boolean {
    const ext = pathname.split('.').pop()?.toLowerCase();
    if (!ext || ext === pathname.toLowerCase()) return false;
    const list = this.config.downloadExtensions || SenzorAnalyticsAgent.DEFAULT_DOWNLOAD_EXT;
    return list.indexOf(ext) !== -1;
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
        height: window.innerHeight,
        language: navigator.language,
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