// Native UUID Generator (No external dependencies)
export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// W3C Trace & Span ID Generators (Hex strings)
export function generateHex(length: number): string {
  let result = '';
  while (result.length < length) {
    result += Math.random().toString(16).slice(2);
  }
  return result.slice(0, length);
}

// Retrieves safe browser metadata for tracing context
export const getBrowserContext = () => {
  return {
    userAgent: navigator.userAgent,
    url: window.location.href, // Provides the dynamic URL
    deviceMemory: (navigator as any).deviceMemory || undefined,
    connectionType: (navigator as any).connection?.effectiveType || undefined
  };
};

// Safely attempts to parse payload sizes for rich APM metadata
export const getPayloadSize = (body: any): number | undefined => {
  if (!body) return 0;
  if (typeof body === 'string') return body.length;
  if (body instanceof Blob || body instanceof File) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  return undefined; // FormData/ReadableStreams cannot be synchronously measured
};

export const extractHeaders = (headers: any): Record<string, string> => {
  const result: Record<string, string> = {};
  if (!headers) return result;
  if (headers instanceof Headers) {
    headers.forEach((val, key) => (result[key] = val));
  } else if (Array.isArray(headers)) {
    headers.forEach(([key, val]) => (result[key] = val));
  } else if (typeof headers === 'object') {
    Object.assign(result, headers);
  }
  return result;
};

// NEW: DOM-Aware, Memory-safe JSON stringifier
// Prevents the browser from crashing when devs accidentally `console.log(document.body)`
export const safeStringify = (obj: any): string => {
  const cache = new Set();
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      // Browser specific safe-guards to prevent traversing massive native objects
      if (typeof window !== 'undefined' && value instanceof Window) return '[Window]';
      if (typeof Document !== 'undefined' && value instanceof Document) return '[Document]';
      if (typeof Node !== 'undefined' && value instanceof Node) return `[Node: ${(value as any).nodeName}]`;

      if (cache.has(value)) return '[Circular]';
      cache.add(value);
    }
    return value;
  });
};