import { getBrowserContext, safeStringify } from "./utils";

export interface ErrorEngineDeps {
  isSampled: boolean;
  traceId: () => string;
  sessionId: string;
  breadcrumbs: any[];
  frustrations: { rageClicks: number; deadClicks: number; errorCount: number };
  errorQueue: any[];
  queueLimit: number;
  flush: () => void;
}

export class ErrorEngine {
  private deps: ErrorEngineDeps;

  constructor(deps: ErrorEngineDeps) {
    this.deps = deps;
  }

  public setup() {
    try {
      this.setupGlobalErrors();
      this.setupPromiseErrors();
      this.setupReactConsolePatch();
    } catch (e) {
      // Non-blocking
    }
  }

  private setupGlobalErrors() {
    window.addEventListener(
      "error",
      (event: ErrorEvent | any) => {
        try {
          // JS runtime errors
          if (event.error) {
            this.capture(event.error, "Uncaught Exception");
            return;
          }
          // Resource errors (script, css, img, font etc)
          if (event.target && event.target !== window) {
            this.capture(new Error("Resource failed to load"), "Resource Error");
          }
        } catch (e) {}
      },
      true,
    );
  }

  private setupPromiseErrors() {
    window.addEventListener("unhandledrejection", (event) => {
      try {
        const error = this.normalizeError(event.reason);
        this.capture(error, "Unhandled Promise Rejection");
      } catch (e) {}
    });
  }

  private capture(errorObj: Error, type: string, extra?: any) {
    try {
      if (this.shouldIgnore(errorObj)) return;

      // Prevent Memory Leaks on catastrophic infinite loops
      if (this.deps.errorQueue.length >= this.deps.queueLimit) {
        this.deps.errorQueue.shift(); // Drop oldest error
      }

      const context = {
        type, // location
        path: location.pathname,
        referrer: document.referrer || undefined,
        ...getBrowserContext(), // userAgent, url, etc.
        breadcrumbs: [...this.deps.breadcrumbs],
      };

      this.deps.errorQueue.push({
        errorClass: errorObj.name || "Error",
        message: errorObj.message || String(errorObj),
        stackTrace: errorObj.stack || "",
        // CRITICAL FIX: traceId MUST be at the root for backend polymorphic lookup to work
        traceId: this.deps.isSampled ? this.deps.traceId() : undefined,
        context,
        timestamp: new Date().toISOString(),
      });

      // This triggers the debounced flush in rum.ts
      this.deps.flush();
    } catch (e) {}
  }

  private normalizeError(reason: any): Error {
    if (reason instanceof Error) return reason;
    if (typeof reason === "string") return new Error(reason);
    if (reason?.message) return new Error(reason.message);
    try {
      return new Error(safeStringify(reason));
    } catch {
      return new Error("Unknown rejection");
    }
  }

  private shouldIgnore(error: Error) {
    try {
      const stack = error.stack || "";
      // Ignore browser extensions noise to keep dashboard clean
      if (stack.includes("chrome-extension://")) return true;
      if (stack.includes("moz-extension://")) return true;
      if (stack.includes("safari-extension://")) return true;
    } catch (e) {}
    return false;
  }

  private setupReactConsolePatch() {
    try {
      const consoleAny: any = console;
      // Prevent multiple patches from hot-reloading
      if (consoleAny.__senzor_react_patch) return;
      consoleAny.__senzor_react_patch = true;

      const original = console.error;

      // Prevent duplicate React StrictMode errors
      let lastReactError = "";
      let lastReactErrorTime = 0;

      console.error = (...args: any[]) => {
        try {
          if (!args || !args.length) return original.apply(console, args);
          const first = args[0];

          // React component crash pattern string matching
          if (typeof first === "string") {
            if (
              first.includes("The above error occurred") ||
              first.includes("A cross-origin error was thrown")
            ) {
              const now = Date.now();

              // Prevent duplicates (React strict mode throws twice)
              if (first === lastReactError && now - lastReactErrorTime < 2000) {
                return original.apply(console, args);
              }

              lastReactError = first;
              lastReactErrorTime = now;

              const error = new Error("React Component Crash");
              // React usually passes the component stack in args[1] or args[2] depending on version
              const componentStack = args.find(
                (a) => typeof a === "string" && a.includes("\n    in "),
              );
              if (componentStack) {
                error.stack = componentStack;
              }

              this.capture(error, "React Error");
            }
          }
        } catch {
          // Never break the user's console logging
        }
        return original.apply(console, args);
      };
    } catch (e) {}
  }
}
