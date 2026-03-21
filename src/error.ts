import { getBrowserContext } from "./utils";

export interface ErrorEngineDeps {
  isSampled: boolean;
  traceId: () => string;
  sessionId: string;
  breadcrumbs: any[];
  frustrations: { rageClicks: number; deadClicks: number; errorCount: number };
  errorQueue: any[];
  flush: () => void;
}

export class ErrorEngine {
  private deps: ErrorEngineDeps;

  constructor(deps: ErrorEngineDeps) {
    this.deps = deps;
  }

  public setup() {
    this.setupGlobalErrors();
    this.setupPromiseErrors();
  }

  private setupGlobalErrors() {
    window.addEventListener(
      "error",
      (event: ErrorEvent | any) => {
        // JS runtime errors
        if (event.error) {
          this.capture(event.error, "Uncaught Exception", {
            file: event.filename,
            line: event.lineno,
            column: event.colno,
          });
          return;
        } // Resource errors (script, css, img, font etc)
        if (event.target && event.target !== window) {
          const el: any = event.target;
          this.capture(new Error("Resource failed to load"), "Resource Error", {
            file: el?.src || el?.href || "unknown",
            tag: el?.tagName,
          });
        }
      },
      true,
    );
  }

  private setupPromiseErrors() {
    window.addEventListener("unhandledrejection", (event) => {
      const error = this.normalizeError(event.reason);
      this.capture(error, "Unhandled Promise Rejection");
    });
  }

  private capture(errorObj: Error, type: string, extra?: any) {
    if (this.shouldIgnore(errorObj)) return;
    this.deps.frustrations.errorCount++;
    this.deps.errorQueue.push({
      errorClass: errorObj.name || "Error",
      message: errorObj.message || String(errorObj),
      stackTrace: errorObj.stack || "",
      file: extra?.file,
      line: extra?.line,
      column: extra?.column,
      traceId: this.deps.isSampled ? this.deps.traceId() : undefined,
      context: {
        type,
        path: location.pathname,
        sessionId: this.deps.sessionId,
        ...getBrowserContext(),
        breadcrumbs: [...this.deps.breadcrumbs],
      },
      timestamp: new Date().toISOString(),
    });
    this.deps.flush();
  }

  private normalizeError(reason: any): Error {
    if (reason instanceof Error) return reason;
    if (typeof reason === "string") return new Error(reason);
    if (reason?.message) return new Error(reason.message);
    try {
      return new Error(JSON.stringify(reason));
    } catch {
      return new Error("Unknown rejection");
    }
  }

  private shouldIgnore(error: Error) {
    const stack = error.stack || ""; // Ignore browser extensions noise
    if (stack.includes("chrome-extension://")) return true;
    if (stack.includes("moz-extension://")) return true;
    if (stack.includes("safari-extension://")) return true;
    return false;
  }
}
