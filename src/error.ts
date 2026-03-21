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
    this.setupReactIntegration();
    this.setupReactConsolePatch();
  }

  private setupGlobalErrors() {
    window.addEventListener(
      "error",
      (event: ErrorEvent | any) => {
        // JS runtime errors
        if (event.error) {
          this.capture(event.error, "Uncaught Exception");
          return;
        } // Resource errors (script, css, img, font etc)
        if (event.target && event.target !== window) {
          const el: any = event.target;
          this.capture(new Error("Resource failed to load"), "Resource Error");
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
    const context = {
      type, // location
      path: location.pathname,
      referrer: document.referrer || undefined, // tracing
      traceId: this.deps.isSampled ? this.deps.traceId() : undefined,
      ...getBrowserContext(), // breadcrumbs
      breadcrumbs: [...this.deps.breadcrumbs],
    };
    this.deps.errorQueue.push({
      errorClass: errorObj.name || "Error",
      message: errorObj.message || String(errorObj),
      stackTrace: errorObj.stack || "",
      context,
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

  private setupReactIntegration() {
    const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) return;
    // Prevent multiple patches
    if (hook.__senzor_patched) return;
    hook.__senzor_patched = true;
    const orig = hook.onCommitFiberRoot;
    hook.onCommitFiberRoot = (id: any, root: any, ...rest: any[]) => {
      try {
        // We don't depend on React internals.
        // Only detecting React presence safely.
      } catch {}
      if (orig) {
        return orig.apply(hook, [id, root, ...rest]);
      }
    };
  }

  private setupReactConsolePatch() {
    const consoleAny: any = console;
    // Prevent multiple patches
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
        // React component crash pattern
        if (typeof first === "string") {
          if (first.includes("The above error occurred")) {
            const now = Date.now();
            // Prevent duplicates (React strict mode)
            if (first === lastReactError && now - lastReactErrorTime < 2000) {
              return original.apply(console, args);
            }
            lastReactError = first;
            lastReactErrorTime = now;
            const error = new Error("React component crash");
            this.capture(error, "React Error");
          }
        }
      } catch {
        // Never break console
      }
      return original.apply(console, args);
    };
  }
}
