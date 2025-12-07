# **@senzops/web**

The official, lightweight, and privacy-conscious web analytics SDK for **Senzor**.

**Senzor Web** is a tiny (< 2KB gzipped) TypeScript agent designed to track page views, visitor sessions, and engagement duration without impacting your website's performance. It works seamlessly with Single Page Applications (SPAs) like React, Next.js, and Vue.

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
<script src="https://cdn.jsdelivr.net/gh/senzops/web-agent/dist/index.global.js"></script>
<script>
  window.Senzor.init({
    webId: "YOUR_WEB_ID_HERE",
  });
</script>
```

## **🛠 Usage**

### **In React / Next.js**

Initialize the agent once in your root layout or main app component.

```jsx
import { useEffect } from "react";
import { Senzor } from "@senzops/web";

export default function App({ Component, pageProps }) {
  useEffect(() => {
    Senzor.init({
      webId: "req_123456789", // Get this from your Senzor Dashboard
      // endpoint: '[https://custom-api.com](https://custom-api.com)' // Optional: For self-hosting
    });
  }, []);

  return <Component {...pageProps} />;
}
```

## **🧠 Working Principle**

The Senzor Agent is designed to be **"Fire and Forget"**. It operates asynchronously to ensure it never blocks the main thread or slows down page loads.

### **1. Identity & Sessions**

- **Visitor ID:** When a user visits, we generate a random UUID and store it in localStorage. This allows us to track unique visitors over a 1-year period.
- **Session ID:** We generate a UUID in sessionStorage. This persists across tab reloads but clears when the browser/tab is closed, allowing us to calculate **Bounce Rates** and **Session Duration**.
- **Privacy:** We do **not** use cookies. All data is first-party.

### **2. Event Tracking**

The agent listens for specific browser events to capture accurate metrics:

- **Initialization:** Sends a pageview event immediately.
- **History API (pushState):** Automatically detects route changes in SPAs (e.g., clicking a Link in Next.js) and sends a new pageview.
- **Visibility Change:** If a user minimizes the tab or switches to another tab, we pause the "Duration" timer and send a ping.

### **3. Duration & The "Ping"**

Calculating how long a user spends on a page is difficult because users often close tabs abruptly. Senzor solves this with a **Heartbeat/Ping mechanism**:

1. When a page loads, we start a timer (startTime).
2. When the user navigates away (beforeunload) or hides the tab (visibilitychange), we calculate duration = Now - startTime.
3. We send a ping event with this duration.
4. **The Backend** receives this ping and updates the _previous_ pageview entry in the database, incrementing its duration.

### **4. Data Transmission**

We prioritize data reliability using **navigator.sendBeacon**:

- **Reliability:** sendBeacon queues data to be sent by the browser even _after_ the page has unloaded/closed. This ensures we don't lose data when users close the tab.
- **Fallback:** If sendBeacon is unavailable, we fall back to a standard fetch request with keepalive: true.

## **⚙️ Configuration Options**

| Option   | Type   | Default           | Description                                                             |
| :------- | :----- | :---------------- | :---------------------------------------------------------------------- |
| webId    | string | **Required**      | The unique ID of your website generated in the Senzor Dashboard.        |
| endpoint | string | api.senzor.dev... | URL of the ingestion API. Use this if you are self-hosting the backend. |

## **📦 Development**

To build the agent locally:

1. **Clone & Install**

```sh
   git clone https://github.com/Senzops/web-agent.git
   cd web-agent
   npm install
```

2. Build  
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
