# **@senzops/web**

The official, lightweight, and privacy-conscious Web Analytics & Real User Monitoring (RUM) SDK for **Senzor**.

**Senzor Web** is a tiny (< 4KB gzipped) TypeScript agent designed to track page views, visitor sessions, Core Web Vitals, frontend exceptions, and distributed traces without impacting your website's performance. It works seamlessly with Single Page Applications (SPAs) like React, Next.js, and Vue.

## **🚀 Installation**

### **Option 1: NPM (Recommended for React/Vue/Next.js)**

```sh
npm install @senzops/web
# or
yarn add @senzops/web
```

### **Option 2: CDN (HTML Script Tag)**

Add this to the <head> of your website:

```html
<script src="[https://cdn.jsdelivr.net/gh/senzops/web-agent/dist/index.global.js](https://cdn.jsdelivr.net/gh/senzops/web-agent/dist/index.global.js)"></script>
<script>
 // Opt-in to Web Analytics (Marketing/Product)
 window.Senzor.init({
  webId: "YOUR_WEB_ID_HERE",
 });

// Opt-in to Web APM / RUM (Engineering)
 window.Senzor.initRum({
  apiKey: "YOUR_RUM_API_KEY_HERE",
  sampleRate: 0.1, // 10% of sessions
  allowedOrigins: ["https://api.yourdomain.com"] // For distributed tracing
 });
</script>
```

## **🛠 Usage**

### **In React / Next.js**

Initialize the agent once in your root layout or main app component. Senzor cleanly separates **Web Analytics** (100% sampling, privacy-focused) from **Web APM / RUM** (performance tracing, configurable sampling). You can use either, or both\!

```jsx
import { useEffect } from "react";
import { Senzor } from "@senzops/web";

export default function App({ Component, pageProps }) {
 useEffect(() => {
 // 1. Web Analytics (Page views, Bounce rates, Sessions)
 Senzor.init({
  webId: "req_123456789", // Get this from your Senzor Dashboard
 });

    // 2. Web APM / RUM (Core Web Vitals, Network Spans, JS Errors)
    Senzor.initRum({
      apiKey: "rum\_987654321", // Get this from your Senzor Dashboard
      sampleRate: 1.0, // Trace 100% of sessions (Adjust for high-traffic sites)
      allowedOrigins: ["https://api.mycompany.com"] // Inject W3C trace headers here
    });

}, []);

return <Component {...pageProps} />;
}
```

## **🧠 Working Principle**

The Senzor Agent is designed to be **"Fire and Forget"**. It operates asynchronously to ensure it never blocks the main thread or slows down page loads.

### **Part 1: Web Analytics (Marketing & Product)**

- **Identity & Sessions:** We generate random UUIDs in localStorage and sessionStorage. This allows us to track unique visitors and calculate Bounce Rates without using cookies.
- **Event Tracking:** Detects SPA route changes via history.pushState and popstate.
- **Duration Pings:** Calculates precise time-on-page by listening to visibilitychange and beforeunload, sending a final duration "ping" when the user leaves.

### **Part 2: Web APM & RUM (Engineering & Performance)**

- **Core Web Vitals (CWV):** Passively listens via PerformanceObserver to capture Google Web Vitals (LCP, INP, CLS, FCP) without stalling the main thread.
- **Distributed Tracing:** Safely intercepts window.fetch and XMLHttpRequest. If a request targets an allowedOrigins domain, it injects a W3C traceparent header, connecting frontend clicks directly to your Node.js backend database queries.
- **UX Frustrations:** Detects "Rage Clicks" (rapid clicking on one element) and "Dead Clicks" (clicking non-interactive elements) to highlight poor UX.
- **Universal Error Engine:** Captures uncaughtException and unhandledRejection, attaching a "Breadcrumb" trail of the user's last 15 actions (clicks, navigations) leading up to the crash.

### **Data Transmission**

We prioritize data reliability using navigator.sendBeacon. It queues data to be sent by the browser even _after_ the tab is closed. If unavailable, it falls back to a standard fetch request with keepalive: true.

## **⚙️ Configuration Options**

### **Analytics Options (Senzor.init)**

| Option   | Type   | Default           | Description                                  |
| :------- | :----- | :---------------- | :------------------------------------------- |
| webId    | string | **Required**      | The unique Analytics ID of your website.     |
| endpoint | string | api.senzor.dev... | Ingestion API URL. Use this if self-hosting. |

### **RUM Options (Senzor.initRum)**

| Option         | Type   | Default           | Description                                                                                                                                                     |
| :------------- | :----- | :---------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| apiKey         | string | **Required**      | The unique RUM API Key of your website.                                                                                                                         |
| sampleRate     | number | 1.0               | Percentage of performance traces to capture (0.0 to 1.0). _Errors are ALWAYS 100% captured regardless of this setting._                                         |
| allowedOrigins | array  | []                | Array of strings or RegEx. The agent will only inject W3C traceparent headers into requests targeting these origins (prevents CORS failures on 3rd-party APIs). |
| endpoint       | string | api.senzor.dev... | Ingestion API URL. Use this if self-hosting.                                                                                                                    |

## **📦 Development**

To build the agent locally:

1. **Clone & Install**

```sh
   git clone https://github.com/Senzops/web-agent.git
   cd web-agent
   npm install
```

2. **Build**  
   Uses tsup to bundle for ESM, CJS, and IIFE (Global variable).

```sh
npm run build
```

3. **Output**
   - dist/index.js (CommonJS)
   - dist/index.mjs (ES Modules)
   - dist/index.global.js (Browser Script)

## **📄 License**

MIT © [Senzor](https://senzor.dev)
