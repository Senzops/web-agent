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
  if (body instanceof FormData) return undefined; // FormData size cannot be synchronously calculated
  if (body instanceof ArrayBuffer) return body.byteLength;
  return undefined;
};