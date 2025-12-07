# **How to Publish @senzops/web**

This guide details the steps to publish the web agent to the public NPM registry.

## **Prerequisites**

1. **NPM Account:** You must have an account on [npmjs.com](https://www.npmjs.com/).
2. **Organization:** You must create an organization named senzops on NPM (since the package is scoped @senzops/web).
   - Go to NPM -> Click Profile Picture -> **+ Add Organization**.
   - Name it senzops.

## **Step 1: Login to NPM**

In your terminal, inside the web-agent folder:

```sh
npm login
```

_Follow the browser prompts to authenticate._

## **Step 2: Prepare the Build**

Ensure the code is clean, dependencies are installed, and the build passes.

# 1. Install dependencies

```sh
npm install
```

# 2. Build the package (creates /dist folder)

```sh
npm run build
```

## **Step 3: Versioning**

Update the version number in package.json. You should follow **Semantic Versioning** (Major.Minor.Patch).

- **Patch (Bug fix):** 1.0.0 -> 1.0.1
- **Minor (New feature):** 1.0.0 -> 1.1.0
- **Major (Breaking change):** 1.0.0 -> 2.0.0

You can do this manually or use the npm command:

```sh
npm version patch
# or
npm version minor
```

## **Step 4: Publishing**

Because this is a **scoped package** (@senzops/...), NPM tries to publish it as private by default (which requires a paid account). To publish it as **public** (free), you must use the access flag.

**Run this command:**

```sh
npm publish --access public
```

## **Step 5: Verification**

1. Go to https://www.npmjs.com/package/@senzops/web.
2. Check if the version matches the one you just pushed.
3. Check the dist/ files are included in the "Code" tab.

## **Step 6: CDN Update (Optional)**

If you are hosting the script via a CDN (like jsDelivr or unpkg), they usually pick up the new NPM version automatically within a few minutes.

- **Unpkg:** https://unpkg.com/@senzops/web@latest/dist/index.global.js
- **jsDelivr:** https://cdn.jsdelivr.net/npm/@senzops/web@latest/dist/index.global.js

You can map your custom domain cdn.senzor.dev to one of these URLs via CNAME records.
