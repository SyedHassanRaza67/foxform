import type { FormField } from "@shared/schema";

export interface ProxyConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  protocol: string;
  label?: string;
}

export interface AutoFillProgress {
  step: string;
  detail: string;
  percent: number;
  timestamp: number;
}

export type ProgressCallback = (progress: AutoFillProgress) => void;

export interface AutoFillResult {
  success: boolean;
  screenshot: string | null;
  duration: number;
  errorMessage: string | null;
  extractedData: Record<string, string>;
}

function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * US timezone pool — pick one randomly on each run so TrustedForm
 * sees a realistic, varying US local time instead of the server's GMT+5.
 */
const US_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Detroit',
  'America/Indiana/Indianapolis',
];

/**
 * Apply a convincing US timezone to a Puppeteer page using every available
 * spoofing layer so TrustedForm (and any other fingerprinting library) sees
 * a real US local time:
 *   1. Puppeteer's built-in emulateTimezone() — spoofs Date & toLocaleString
 *   2. CDP Emulation.setTimezoneOverride — overrides the Blink-level TZ
 *   3. evaluateOnNewDocument injection — overrides Intl.DateTimeFormat so
 *      resolvedOptions().timeZone returns the chosen US zone in every frame
 */
async function applyUSTimezone(page: any): Promise<string> {
  const tz = US_TIMEZONES[Math.floor(Math.random() * US_TIMEZONES.length)];

  // Layer 1: Puppeteer emulateTimezone (Date API)
  try {
    await page.emulateTimezone(tz);
  } catch (e: any) {
    console.warn('[tz] emulateTimezone failed:', e?.message);
  }

  // Layer 2: CDP-level Blink timezone override (affects Intl internals too)
  try {
    const client = await page.target().createCDPSession();
    await client.send('Emulation.setTimezoneOverride', { timezoneId: tz });
  } catch (e: any) {
    console.warn('[tz] CDP setTimezoneOverride failed:', e?.message);
  }

  // Layer 3: Inject Intl spoof before ANY page script runs
  try {
    await page.evaluateOnNewDocument((timezone: string) => {
      // Override Intl.DateTimeFormat so resolvedOptions().timeZone is our US zone
      const OriginalIntl = Intl.DateTimeFormat;
      // @ts-ignore
      Intl.DateTimeFormat = function (locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
        const mergedOptions = { timeZone: timezone, ...(options || {}) };
        // @ts-ignore
        return new OriginalIntl(locales, mergedOptions);
      } as any;
      // Copy static methods
      Object.assign(Intl.DateTimeFormat, OriginalIntl);
      (Intl.DateTimeFormat as any).prototype = OriginalIntl.prototype;

      // Also spoof the raw getter used by some fingerprinters
      try {
        Object.defineProperty(Intl.DateTimeFormat.prototype, 'resolvedOptions', {
          value: function () {
            const orig = OriginalIntl.prototype.resolvedOptions.call(this);
            return { ...orig, timeZone: timezone };
          },
          writable: true, configurable: true,
        });
      } catch { }
    }, tz);
  } catch (e: any) {
    console.warn('[tz] evaluateOnNewDocument Intl spoof failed:', e?.message);
  }

  console.log(`[tz] Applied US timezone: ${tz}`);
  return tz;
}

/**
 * Types a string character-by-character at a natural human speed (~70–100 WPM).
 * Includes occasional micro-pauses to mimic natural rhythm variation.
 */
async function typeHumanLike(page: any, value: string): Promise<void> {
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];

    // Occasional thinking micro-pause (~6% chance) — natural hesitation
    if (i > 0 && Math.random() < 0.06) {
      await sleep(randomDelay(120, 280));
    }

    // Natural typing speed ~70–100 WPM
    // Mid-word chars: 70–130ms; boundaries/spaces/punctuation: 100–180ms
    const prevCh = i > 0 ? value[i - 1] : '';
    const isWordChar = prevCh && prevCh !== ' ' && ch !== ' ' && ch !== '.' && ch !== ',';
    const keystrokeDelay = isWordChar
      ? randomDelay(70, 130)    // mid-word characters
      : randomDelay(100, 180);  // word boundaries / spaces / punctuation

    await page.keyboard.type(ch, { delay: keystrokeDelay });
  }
  // Brief post-field glance pause
  await sleep(randomDelay(100, 200));
}

/**
 * Moves the mouse in a natural 3-point arc toward the element centre.
 * Approach offset → midpoint curve → target landing zone.
 * Simulates genuine pointer movement so bot-detection sees a real cursor path.
 */
async function humanMouseMove(page: any, elementHandle: any): Promise<void> {
  try {
    const box = await elementHandle.boundingBox();
    if (!box) return;

    // Land somewhere within the middle 60% of the element (humans don't click dead-center)
    const targetX = box.x + box.width  * (0.2 + Math.random() * 0.6);
    const targetY = box.y + box.height * (0.2 + Math.random() * 0.6);

    // Start from a random offset — simulates cursor arriving from elsewhere on the page
    const approachX = targetX + randomDelay(-80, 80) * (Math.random() > 0.5 ? 1 : -1);
    const approachY = targetY + randomDelay(-40, 40) * (Math.random() > 0.5 ? 1 : -1);

    // Midpoint slightly off the straight line — creates a natural arc
    const midX = approachX + (targetX - approachX) * 0.5 + randomDelay(-15, 15);
    const midY = approachY + (targetY - approachY) * 0.5 + randomDelay(-10, 10);

    // Move: start → arc midpoint → target (3-point natural curve)
    await page.mouse.move(approachX, approachY);
    await sleep(randomDelay(15, 35));
    await page.mouse.move(midX, midY, { steps: randomDelay(4, 7) });
    await sleep(randomDelay(10, 25));
    await page.mouse.move(targetX, targetY, { steps: randomDelay(4, 8) });
    await sleep(randomDelay(20, 50)); // hover before clicking
  } catch {
    // Non-fatal — continue without mouse simulation
  }
}

/**
 * Scrolls the element into view and waits briefly —
 * mimicking a human pausing to notice the field before typing.
 */
async function humanScrollTo(page: any, selector: string): Promise<void> {
  try {
    await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ behavior: 'auto', block: 'center' });
    }, selector);
    await sleep(randomDelay(60, 130)); // brief pause after scroll settles
  } catch {
    // Ignore
  }
}

async function fillInputNative(page: any, selector: string, value: string): Promise<void> {
  await page.evaluate((sel: string, val: string) => {
    const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) throw new Error(`Element not found: ${sel}`);

    // Focus the element first
    el.focus();
    el.dispatchEvent(new Event("focus", { bubbles: true }));

    // Use the native value setter so React/Vue/Angular synthetic events fire
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (nativeSetter) {
      nativeSetter.call(el, val);
    } else {
      el.value = val;
    }

    // Fire full keyboard + input + change event chain so all frameworks see it
    const keyEvents = ["keydown", "keypress", "keyup"];
    keyEvents.forEach(type => {
      el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key: val.slice(-1) || "a", keyCode: 65 }));
    });
    el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
  }, selector, value);
}

/**
 * Human-like text field fill strategy:
 *  1. Scroll the field into view and pause (reading)
 *  2. Move the mouse to the field naturally
 *  3. Click to focus
 *  4. Select-all + delete any existing value
 *  5. Type character-by-character with variable delays
 *  6. Blur the field
 * Falls back to fillInputNative if keyboard typing fails.
 */
async function fillFieldHuman(
  page: any,
  selector: string,
  value: string
): Promise<void> {
  // Step 1: Scroll field into view
  await humanScrollTo(page, selector);

  // Step 2: Reading pause — user notices and reads the field label
  await sleep(randomDelay(150, 320));

  const handle = await page.$(selector);

  // Step 3: Move mouse naturally to the field via a 3-point arc
  if (handle) {
    await humanMouseMove(page, handle);
    // humanMouseMove already ends with a hover pause; small extra settle time
    await sleep(randomDelay(20, 50));
  }

  // Step 4: Click to focus (triple-click selects any existing text)
  await page.click(selector, { clickCount: 3, delay: randomDelay(30, 60) });
  await sleep(randomDelay(80, 160));

  // Step 5: Clear any pre-filled value
  await page.keyboard.press('Backspace');
  await sleep(randomDelay(30, 60));

  // Step 6: Type character-by-character at natural human speed
  try {
    await typeHumanLike(page, value);
  } catch {
    // Fallback: native value setter for React/Vue-controlled inputs
    await fillInputNative(page, selector, value);
  }

  // Step 7: Brief post-type pause — user reviews what they typed
  await sleep(randomDelay(80, 160));

  // Step 8: Tab away (60%) or blur (40%) to commit the value
  if (Math.random() < 0.6) {
    await page.keyboard.press('Tab');
  } else {
    await page.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      el?.blur();
    }, selector);
  }
  await sleep(randomDelay(60, 120));
}

/**
 * Fill a <select> element in a React/Vue/Angular-safe way.
 * Dispatches mousedown → focus → native value set → change → blur.
 */
async function fillSelectNative(page: any, selector: string, value: string): Promise<void> {
  try {
    // First try puppeteer's built-in page.select() — works for plain HTML selects
    await page.select(selector, value);
  } catch {
    // Ignore error here because we'll force the native setter next
  }

  // ALWAYS do the native setter + full event chain (for React/Vue-controlled selects)
  // because page.select() might not trigger the framework's synthetic event wrappers
  await page.evaluate((sel: string, val: string) => {
    const el = document.querySelector(sel) as HTMLSelectElement | null;
    if (!el) return; // fail silently if not found

    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.focus();
    el.dispatchEvent(new Event("focus", { bubbles: true }));

    // Try setting value directly, then via native setter
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    if (nativeSetter) {
      nativeSetter.call(el, val);
    } else {
      el.value = val;
    }

    // Also try selecting the matching <option> directly
    const matchingOpt = Array.from(el.options).find(
      o => o.value === val || o.text.toLowerCase() === val.toLowerCase()
    );
    if (matchingOpt) {
      matchingOpt.selected = true;
    }

    el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
  }, selector, value);
}

async function hideOverlays(page: any): Promise<void> {
  await page.evaluate(() => {
    const overlays = Array.from(document.querySelectorAll('div, section, aside')) as HTMLElement[];
    overlays.forEach(el => {
      const style = window.getComputedStyle(el);
      const isFixed = style.position === 'fixed' || style.position === 'absolute';
      const isVisible = style.visibility !== 'hidden' && style.opacity !== '0' && style.display !== 'none';
      const hasHighZ = parseInt(style.zIndex, 10) > 100;
      const isTransparentish = !style.backgroundColor || style.backgroundColor === 'rgba(0, 0, 0, 0)' || parseFloat(style.opacity) < 0.5;

      // If it looks like a preloader or a blocking overlay
      if (isFixed && isVisible && (hasHighZ || (isTransparentish && el.innerText.length < 50))) {
        el.style.display = 'none';
        el.style.pointerEvents = 'none';
      }
    });
  }).catch(() => { });
}

async function extractPageData(page: any): Promise<Record<string, string>> {
  // Poll for up to 3s because certs/tokens are often injected by dynamic scripts
  const result: Record<string, string> = {};
  const deadline = Date.now() + 3000;

  while (Date.now() < deadline) {
    const scraped: Record<string, string> = await page.evaluate(() => {
      const data: Record<string, string> = {};

      // TrustedForm selectors
      const tfSelectors = [
        'input[name*="TrustedFormCertUrl"]',
        'input[name*="trustedform"]',
        'input[name*="trusted_form"]',
        'input[name="cert_url"]',
      ];
      for (const sel of tfSelectors) {
        const el = document.querySelector(sel) as HTMLInputElement | null;
        if (el?.value && el.value.startsWith('https://')) {
          data['trusted_form_url'] = el.value;
          break;
        }
      }

      // Journaya selectors
      const journSelectors = ['input[name*="journ"]', 'input[id*="journ"]'];
      for (const sel of journSelectors) {
        const el = document.querySelector(sel) as HTMLInputElement | null;
        if (el?.value) {
          data[el.name || 'journaya_token'] = el.value;
          data['journaya_token'] = el.value;
          break;
        }
      }

      // Generic hidden cert URL detection
      document.querySelectorAll('input[type="hidden"]').forEach((el) => {
        const inp = el as HTMLInputElement;
        if (inp.value && inp.value.startsWith('https://cert.trustedform.com')) {
          data['trusted_form_url'] = inp.value;
        }
        if (inp.value && (inp.value.startsWith('https://journaya.com') || inp.value.startsWith('https://leads.activeprospect.com'))) {
          data['journaya_url'] = inp.value;
        }
      });

      // Success tokens in URL
      const url = window.location.href;
      const successMatch = url.match(/[?&](token|id|sub_id|lead_id)=([^&]+)/i);
      if (successMatch) {
        data[successMatch[1].toLowerCase()] = successMatch[2];
        data['success_url'] = url;
      }

      return data;
    }).catch(() => ({}));

    Object.assign(result, scraped);
    if (result['trusted_form_url'] || result['journaya_token']) break;
    await sleep(500);
  }

  return result;
}

export async function autoFillForm(
  url: string,
  fields: FormField[],
  formData: Record<string, string>,
  submitSelector: string | null,
  proxy: ProxyConfig | null,
  onProgress: ProgressCallback,
  fallbackProxy: ProxyConfig | null = null,
  signal?: AbortSignal
): Promise<AutoFillResult> {
  const startTime = Date.now();
  let browser: any = null;
  let page: any = null;
  let currentExtractedData: Record<string, string> = {};

  const checkAbort = () => {
    if (signal?.aborted) throw new Error("Submission cancelled by user");
  };

  try {
    checkAbort();
    onProgress({ step: "launching", detail: "Launching", percent: 5, timestamp: Date.now() });

    // Dynamic imports to save cold-start time and memory
    const { default: puppeteerExtra } = await import("puppeteer-extra");
    const { default: StealthPlugin } = await import("puppeteer-extra-plugin-stealth");
    const { default: puppeteer } = await import("puppeteer");

    puppeteerExtra.use(StealthPlugin());

    /**
     * Launch a fresh browser with the given proxy (or no proxy if proxyConf is null).
     * A new launch is mandatory on every tunnel-error retry because HTTPS CONNECT
     * tunnels cannot be re-established on the same Chromium process/socket.
     */
    const launchBrowser = async (proxyConf: ProxyConfig | null) => {
      if (browser) {
        try { await browser.close(); } catch { }
        browser = null;
        page = null;
      }
      const args = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--window-size=1920,1080",
      ];
      if (proxyConf) {
        args.push(`--proxy-server=${proxyConf.protocol}://${proxyConf.host}:${proxyConf.port}`);
      }
      browser = await puppeteerExtra.launch({
        headless: true,
        executablePath: puppeteer.executablePath(),
        args,
      });
      page = await browser.newPage();
      await applyUSTimezone(page);
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      );
      if (proxyConf?.username && proxyConf?.password) {
        await page.authenticate({ username: proxyConf.username, password: proxyConf.password });
      }
    };

    // Initial launch with the primary (ZIP) proxy
    await launchBrowser(proxy);
    checkAbort();
    console.log(`[browser] Browser launched, navigating to ${url}`);

    const isTunnelError = (err: any) =>
      err?.message?.includes("ERR_TUNNEL_CONNECTION_FAILED") ||
      err?.message?.includes("ERR_PROXY_CONNECTION_FAILED") ||
      err?.message?.includes("ERR_CONNECTION_TIMED_OUT") ||
      err?.message?.includes("net::ERR_");

    const MAX_ZIP_ATTEMPTS = 3;
    let lastTunnelErr: any = null;

    // Phase 1 — Primary (ZIP) proxy: up to 3 attempts, restarting browser each retry
    for (let attempt = 1; attempt <= MAX_ZIP_ATTEMPTS; attempt++) {
      const label = attempt > 1 ? ` (retry ${attempt}/${MAX_ZIP_ATTEMPTS})` : "";
      onProgress({ step: "navigating", detail: `Navigating${label}`, percent: 10, timestamp: Date.now() });
      checkAbort();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
        lastTunnelErr = null;
        break; // success
      } catch (err: any) {
        if (isTunnelError(err)) {
          lastTunnelErr = err;
          if (attempt < MAX_ZIP_ATTEMPTS) {
            const waitMs = 3000 * attempt;
            onProgress({
              step: "field_warning",
              detail: `Tunnel failed, retrying (${attempt}/${MAX_ZIP_ATTEMPTS})...`,
              percent: 12,
              timestamp: Date.now(),
            });
            await sleep(1500 * attempt);
            // MUST relaunch — tunnel connections can't recover on same process
            await launchBrowser(proxy);
            checkAbort();
          }
        } else {
          // Non-tunnel error (e.g. DNS failure, invalid URL, HTTPS error)
          console.error(`[browser] Navigation failed (non-tunnel): ${err.message}`);
          throw new Error(`Navigation failed: ${err.message}`);
        }
      }
    }

    // Phase 2 — Fallback proxy (if provided): up to 3 attempts, restarting browser each retry
    if (lastTunnelErr && fallbackProxy) {
      onProgress({
        step: "field_warning",
        detail: "Switching to alternate proxy...",
        percent: 13,
        timestamp: Date.now(),
      });

      const MAX_FALLBACK_ATTEMPTS = 3;
      let fallbackErr: any = null;
      for (let attempt = 1; attempt <= MAX_FALLBACK_ATTEMPTS; attempt++) {
        onProgress({
          step: "navigating",
          detail: `Navigating via alternate proxy (${attempt}/${MAX_FALLBACK_ATTEMPTS})`,
          percent: 14,
          timestamp: Date.now(),
        });
        checkAbort();
        // Relaunch with fallback proxy credentials
        await launchBrowser(fallbackProxy);
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
          lastTunnelErr = null;
          fallbackErr = null;
          break; // success
        } catch (err: any) {
          fallbackErr = err;
          if (attempt < MAX_FALLBACK_ATTEMPTS) {
            await sleep(1000 * attempt);
          }
        }
      }
      if (lastTunnelErr && fallbackErr) {
        // Phase 3 — Direct connection (no proxy) as last resort
        onProgress({
          step: "field_warning",
          detail: "Both proxies failed — trying direct connection...",
          percent: 15,
          timestamp: Date.now(),
        });
        console.warn(`[browser] All proxy attempts failed. Falling back to direct connection.`);
        await launchBrowser(null);
        checkAbort();
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
          lastTunnelErr = null;
        } catch (directErr: any) {
          throw new Error(
            `All connection attempts failed. ` +
            `ZIP proxy error: ${lastTunnelErr?.message}. ` +
            `Fallback proxy error: ${fallbackErr?.message}. ` +
            `Direct connection error: ${directErr?.message}.`
          );
        }
      }
    } else if (lastTunnelErr && !fallbackProxy) {
      // No fallback proxy — try direct connection before giving up
      onProgress({
        step: "field_warning",
        detail: "Proxy tunnel failed — trying direct connection...",
        percent: 14,
        timestamp: Date.now(),
      });
      console.warn(`[browser] Primary proxy failed, no fallback configured. Trying direct connection.`);
      await launchBrowser(null);
      checkAbort();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
        lastTunnelErr = null;
      } catch (directErr: any) {
        throw new Error(
          `Proxy tunnel failed and direct connection also failed. ` +
          `Proxy error: ${lastTunnelErr?.message}. ` +
          `Direct error: ${directErr?.message}.`
        );
      }
    }
    await sleep(randomDelay(200, 500));

    // Extraction logic (pre-fill) — skipped as requested
    currentExtractedData = {};

    try {
      await page.waitForNetworkIdle({ timeout: 6000 });
    } catch {
      // Ignore – some pages never go fully idle
    }

    // Verify we actually landed on the target site (proxy auth failure sends browser elsewhere)
    const landedUrl = page.url();
    const targetHost = new URL(url).hostname.replace(/^www\./, '');
    const landedHost = (() => { try { return new URL(landedUrl).hostname.replace(/^www\./, ''); } catch { return ""; } })();
    // Allow: exact match, subdomain of target (e.g. secure.site.com → site.com), or about:blank (not yet loaded)
    const isSameHost = !landedHost || landedHost === "" || landedHost === targetHost || landedHost.endsWith(`.${targetHost}`) || targetHost.endsWith(`.${landedHost}`);
    if (!isSameHost) {
      console.warn(`[browser] Landed on unexpected host "${landedHost}", expected "${targetHost}". Checking if it's a redirect...`);
      // Give it one more chance — the site may have done a temporary redirect
      await sleep(2000);
      const recheck = page.url();
      const recheckHost = (() => { try { return new URL(recheck).hostname.replace(/^www\./, ''); } catch { return ""; } })();
      const isNowOk = recheckHost === targetHost || recheckHost.endsWith(`.${targetHost}`) || targetHost.endsWith(`.${recheckHost}`);
      if (!isNowOk) {
        throw new Error(
          `Proxy authentication may have failed — browser landed on "${recheckHost}" instead of "${targetHost}". ` +
          `Check your proxy URL template for formatting errors.`
        );
      }
    }

    // Anti-block: Wait for common preloaders or blocked overlays to disappear
    await page.evaluate(async () => {
      const selectors = [
        ".preloader", "#preloader", ".loader", "#loader",
        ".loading-overlay", "#loading-overlay",
        "[class*='preloader']", "[id*='preloader']"
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && window.getComputedStyle(el).display !== "none") {
          // Wait up to 5s for it to disappear
          let attempts = 0;
          while (attempts < 25) {
            if (!document.querySelector(sel) || window.getComputedStyle(document.querySelector(sel)!).display === "none") break;
            await new Promise(r => setTimeout(r, 200));
            attempts++;
          }
        }
      }
    }).catch(() => { });

    onProgress({ step: "page_loaded", detail: "Page loaded", percent: 20, timestamp: Date.now() });

    const sortedFields = [...fields].sort((a, b) => a.order - b.order);
    const filledFields = sortedFields.filter(
      (f) => f.selector && f.name && formData[f.name] !== undefined && formData[f.name] !== ""
    );
    const totalFields = filledFields.length;
    checkAbort();

    // Wait for the first text field to appear — ensures the form is fully loaded before filling
    const firstTextField = filledFields.find((f) => f.type !== "checkbox" && f.type !== "radio" && f.selector);
    if (firstTextField) {
      try {
        await page.waitForSelector(firstTextField.selector, { timeout: 15000 });
        onProgress({ step: "form_ready", detail: "Form ready", percent: 22, timestamp: Date.now() });
      } catch {
        // Form didn't appear — likely the page is blocked, CAPTCHA, or proxy issue
        const pageTitle = await page.title().catch(() => "");
        const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || "").catch(() => "");
        throw new Error(
          `Form not found on page after 15 seconds. Page title: "${pageTitle}". ` +
          (pageText ? `Page content: "${pageText.replace(/\n/g, " ")}"` : "") +
          ` This may be a Cloudflare block or the form selector is wrong.`
        );
      }
    }

    for (let i = 0; i < filledFields.length; i++) {
      const field = filledFields[i];
      const value = formData[field.name];

      // Skip fields with missing selector (safety guard)
      if (!field.selector) {
        console.warn(`[browser] Skipping field "${field.name}" — no selector`);
        continue;
      }

      const fieldPercent = 22 + Math.floor(((i + 1) / Math.max(totalFields, 1)) * 58);
      onProgress({
        step: "filling_field",
        detail: `Saving (${i + 1}/${totalFields})`,
        percent: fieldPercent,
        timestamp: Date.now(),
      });

      const clickFieldHumanLocal = async (selectorLocal: string): Promise<boolean> => {
        await humanScrollTo(page, selectorLocal);
        const elHandle = await page.$(selectorLocal);
        if (elHandle) {
          try {
            const box = await elHandle.boundingBox();
            if (box && box.width > 0 && box.height > 0) {
              const targetX = box.x + box.width / 2;
              const targetY = box.y + box.height / 2;
              await page.mouse.move(targetX, targetY, { steps: randomDelay(5, 10) });
              await sleep(randomDelay(40, 80));
              await page.mouse.down();
              await sleep(randomDelay(50, 100));
              await page.mouse.up();
              return true;
            }
          } catch { }
        }

        const labelHandle = await page.evaluateHandle((sel: string) => {
          const el = document.querySelector(sel) as HTMLInputElement;
          if (!el) return null;
          if (el.labels && el.labels.length > 0) return el.labels[0];
          if (el.id) {
            const lbl = document.querySelector(`label[for="${el.id}"]`);
            if (lbl) return lbl;
          }
          return el.closest('label') || el.parentElement;
        }, selectorLocal);

        const labelEl = labelHandle.asElement();
        if (labelEl) {
          try {
            const lbox = await labelEl.boundingBox();
            if (lbox && lbox.width > 0 && lbox.height > 0) {
              const targetX = lbox.x + lbox.width / 2;
              const targetY = lbox.y + lbox.height / 2;
              await page.mouse.move(targetX, targetY, { steps: randomDelay(5, 10) });
              await sleep(randomDelay(40, 80));
              await page.mouse.down();
              await sleep(randomDelay(50, 100));
              await page.mouse.up();
              return true;
            }
          } catch { }
        }

        return await page.evaluate((sel: string) => {
          const el = document.querySelector(sel) as HTMLElement;
          if (el) { el.click(); return true; }
          return false;
        }, selectorLocal).catch(() => false);
      };

      try {
        if (field.type === "checkbox") {
          const shouldCheck = value === "true" || value === "1" || value === "on" || (field.options && field.options.includes(value));

          if (shouldCheck) {
            try {
              await page.waitForSelector(field.selector, { timeout: 8000 });
              const isChecked = await page.$eval(field.selector, (el: any) => el.checked);
              if (!isChecked) {
                await clickFieldHumanLocal(field.selector);
                await sleep(randomDelay(100, 250));
              }
            } catch {
              const altSel = `input[type="checkbox"][value="${field.options?.[0] || value}"]`;
              try {
                await page.waitForSelector(altSel, { timeout: 3000 });
                await clickFieldHumanLocal(altSel);
                await sleep(randomDelay(100, 250));
              } catch { }
            }
          }
        } else if (field.type === "radio") {
          const radioSelector = `input[name="${field.name}"][value="${value}"]`;
          try {
            await page.waitForSelector(radioSelector, { timeout: 8000 });
            await clickFieldHumanLocal(radioSelector);
            await sleep(randomDelay(100, 250));
          } catch {
            const altSel = `input[type="radio"][value="${value}"]`;
            try {
              await clickFieldHumanLocal(altSel);
              await sleep(randomDelay(100, 250));
            } catch { }
          }
        } else if (field.type === "select") {
          await page.waitForSelector(field.selector, { timeout: 8000 });

          // Step 1: Scroll into view, pause as if noticing the dropdown
          await humanScrollTo(page, field.selector);
          await sleep(randomDelay(200, 450));

          const selHandle = await page.$(field.selector);
          if (selHandle) {
            // Step 2: Move mouse naturally to the dropdown
            await humanMouseMove(page, selHandle);
            await sleep(randomDelay(100, 200)); // hover before clicking

            const box = await selHandle.boundingBox();
            if (box && box.width > 0 && box.height > 0) {
              const cx = box.x + box.width / 2;
              const cy = box.y + box.height / 2;

              // Step 3: Click the dropdown to open it
              await page.mouse.move(cx, cy, { steps: randomDelay(5, 10) });
              await sleep(randomDelay(80, 150));
              await page.mouse.down();
              await sleep(randomDelay(80, 140));
              await page.mouse.up();

              // Step 4: Wait for the dropdown options to appear visually
              await sleep(randomDelay(400, 700));

              // Step 5: Find the exact value attribute of the matching option
              const exactValueToSelect = await page.evaluate(
                (sel: string, val: string) => {
                  const selectEl = document.querySelector(sel) as HTMLSelectElement | null;
                  if (!selectEl) return null;
                  const opt = Array.from(selectEl.options).find(
                    (o) => o.value === val || o.text.trim().toLowerCase() === val.toLowerCase()
                  );
                  return opt ? opt.value : null;
                },
                field.selector,
                value
              ).catch(() => null);

              // Step 6: Use native fallback to safely set value and trigger events
              if (exactValueToSelect !== null) {
                await fillSelectNative(page, field.selector, exactValueToSelect);
              } else {
                await fillSelectNative(page, field.selector, value);
              }
            } else {
              // No bounding box — go straight to native
              await fillSelectNative(page, field.selector, value);
            }
          } else {
            await fillSelectNative(page, field.selector, value);
          }

          // Step 6: Close the dropdown cleanly
          await page.keyboard.press('Escape');
          await sleep(randomDelay(100, 200));
        } else {
          await page.waitForSelector(field.selector, { timeout: 8000 });

          // Human-like fill: scroll → mouse move → click → type char-by-char
          try {
            await fillFieldHuman(page, field.selector, value);
          } catch {
            // Last-ditch fallback: native value setter
            await fillInputNative(page, field.selector, value);
            await sleep(randomDelay(200, 450));
          }
        }
      } catch (fieldErr: any) {
        const label = field.label || field.name || "(unknown field)";
        console.warn(`[browser] Could not fill "${label}" (selector: ${field.selector}): ${fieldErr.message}`);
        onProgress({
          step: "field_warning",
          detail: `Could not save field ${i + 1} of ${totalFields}`,
          percent: fieldPercent,
          timestamp: Date.now(),
        });
      }

      // Inter-field pause — natural gap as user moves to next field
      const baseDelay = i === 0
        ? randomDelay(300, 600)    // just getting started
        : i < 3
          ? randomDelay(500, 900)  // picking up rhythm
          : randomDelay(600, 1100); // settled pace
      await sleep(baseDelay);
    }

    onProgress({ step: "fields_complete", detail: "All fields saved", percent: 80, timestamp: Date.now() });
    checkAbort();

    // --- Pre-submit field verification ---
    // Re-fill any field whose value somehow ended up blank (React state flush timing issue).
    // This is the #1 cause of form validation errors on first submission attempt.
    onProgress({ step: "filling_field", detail: "Verifying fields...", percent: 81, timestamp: Date.now() });
    for (const field of filledFields) {
      if (!field.selector || field.type === 'checkbox' || field.type === 'radio' || field.type === 'select') continue;
      try {
        const currentVal = await page.$eval(
          field.selector,
          (el: any) => (el.value || el.innerText || '').trim()
        ).catch(() => '');
        if (!currentVal) {
          console.warn(`[browser] Field "${field.name}" is empty before submit — re-filling...`);
          await fillInputNative(page, field.selector, formData[field.name]);
          await sleep(randomDelay(100, 200));
        }
      } catch { /* non-fatal */ }
    }

    // Let AJAX/debounce handlers settle before submitting
    try {
      await page.waitForNetworkIdle({ timeout: 3000 });
    } catch { /* fine if never idle */ }

    // Natural review pause before submit — user scans the completed form
    await sleep(randomDelay(600, 1200));

    // --- "I Agree" / consent checkbox detection ---
    // Many lead-gen forms have a final consent checkbox before the submit button.
    // We move the mouse to it and click it like a real user.
    try {
      const agreeSelectors = [
        'input[type="checkbox"][name*="agree"]',
        'input[type="checkbox"][name*="consent"]',
        'input[type="checkbox"][name*="terms"]',
        'input[type="checkbox"][id*="agree"]',
        'input[type="checkbox"][id*="consent"]',
        'input[type="checkbox"][id*="terms"]',
        'label:has(input[type="checkbox"])',
      ];
      for (const agSel of agreeSelectors) {
        const agHandle = await page.$(agSel).catch(() => null);
        if (!agHandle) continue;
        const agBox = await agHandle.boundingBox().catch(() => null);
        if (!agBox || agBox.width === 0) continue;

        // Only click if not already checked
        const isChecked = await page.$eval(agSel, (el: any) =>
          el.tagName === 'INPUT' ? el.checked : el.querySelector('input')?.checked ?? false
        ).catch(() => false);

        if (!isChecked) {
          onProgress({ step: "filling_field", detail: "Clicking 'I Agree'", percent: 83, timestamp: Date.now() });
          await humanScrollTo(page, agSel);
          await sleep(randomDelay(300, 600));
          await humanMouseMove(page, agHandle);
          await sleep(randomDelay(150, 300));
          const cx = agBox.x + agBox.width / 2;
          const cy = agBox.y + agBox.height / 2;
          await page.mouse.move(cx, cy, { steps: randomDelay(5, 10) });
          await sleep(randomDelay(80, 160));
          await page.mouse.down();
          await sleep(randomDelay(80, 150));
          await page.mouse.up();
          await sleep(randomDelay(300, 600));
          console.log(`[browser] Clicked "I Agree" checkbox: ${agSel}`);
        }
        break; // only handle the first matching consent checkbox
      }
    } catch (agreeErr: any) {
      console.warn('[browser] "I Agree" detection skipped:', agreeErr?.message);
    }

    onProgress({ step: "submitting", detail: "Submitting", percent: 85, timestamp: Date.now() });

    const SUCCESS_PATTERNS = [
      "thank you", "thanks!", "success", "submitted", "confirmation",
      "received", "complete", "congrats", "your request", "we'll be in touch",
      "we will contact", "application received", "form submitted"
    ];

    const ERROR_PATTERNS = [
      "required", "invalid", "error", "please correct", "fix the following",
      "cannot be blank", "is already", "try again"
    ];

    // --- Submission Phase (Attempts 1-3) ---
    // Budget: 40s total. Each attempt gets up to 12s to detect confirmation.
    // This leaves room for 3 full attempts without any being starved.
    const SUBMISSION_PHASE_MAX_MS = 40000;
    const submissionStartTime = Date.now();
    let submissionConfirmed = false;
    let lastErrorDetail = "";
    const urlBefore = page.url();

    // Capture the body text before clicking so we can detect DOM changes
    const bodyBefore = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || "").catch(() => "");

    // Track how many click attempts actually fired a click
    let totalClicksFired = 0;

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (submissionConfirmed) break;

      // Check if we've already exceeded the 45s total submission window
      if (Date.now() - submissionStartTime > SUBMISSION_PHASE_MAX_MS) {
        console.warn(`[browser] Submission phase timed out after ${SUBMISSION_PHASE_MAX_MS / 1000}s (Attempt ${attempt})`);
        break;
      }

      try {
        onProgress({ step: "submitting", detail: `Submit attempt ${attempt}`, percent: 85 + attempt, timestamp: Date.now() });

        await hideOverlays(page); // Clear blockers

        const standardSelectors = [
          submitSelector,
          'button[type="submit"]',
          'input[type="submit"]',
        ].filter(Boolean) as string[];

        let clickFired = false;

        const attemptTrustedClick = async (elHandle: any, context: string): Promise<boolean> => {
          try {
            // Step 1: Scroll submit button into view INSTANTLY (smooth scroll causes moving targets)
            await elHandle.evaluate((node: Element) => node.scrollIntoView({ behavior: 'auto', block: 'center' }));
            await sleep(randomDelay(300, 600)); // Let the page fully settle after scroll

            // Step 2: Get the exact bounding box of the button
            let box = await elHandle.boundingBox();
            if (!box || box.width === 0 || box.height === 0) {
              throw new Error('Button has no visible bounding box');
            }

            // Step 3: Pick a randomised landing point within the inner 50% of the button
            // (not always the dead center — humans click slightly off-center)
            let clickX = box.x + box.width  * (0.25 + Math.random() * 0.50);
            let clickY = box.y + box.height * (0.25 + Math.random() * 0.50);

            // Verify if the element is actually clickable at this point or if it's covered by a sticky header/overlay
            let isClickable = await page.evaluate((x: number, y: number, node: Element) => {
              const elAtPoint = document.elementFromPoint(x, y);
              return elAtPoint === node || node.contains(elAtPoint) || (elAtPoint && elAtPoint.closest && elAtPoint.closest('button, input[type="submit"]') === node);
            }, clickX, clickY, elHandle).catch(() => true);

            if (!isClickable) {
              console.warn(`[browser] Submit button is obscured at (${Math.round(clickX)}, ${Math.round(clickY)}). Adjusting scroll to avoid sticky header/footer.`);
              await page.evaluate(() => window.scrollBy(0, -150)); // Scroll up slightly to avoid sticky footers
              await sleep(300);
              const newBox = await elHandle.boundingBox();
              if (newBox) {
                box = newBox;
                clickX = box.x + box.width * (0.25 + Math.random() * 0.50);
                clickY = box.y + box.height * (0.25 + Math.random() * 0.50);
              }
            }

            // Step 4: Approach from a natural random offset (simulate cursor arriving from elsewhere)
            const approachOffsetX = randomDelay(-120, 120);
            const approachOffsetY = randomDelay(-60, 60);
            const startX = clickX + approachOffsetX;
            const startY = clickY + approachOffsetY;

            await page.mouse.move(startX, startY);
            await sleep(randomDelay(40, 90));

            // Step 5: Move toward the button in steps (natural arc, not a straight line)
            const midX = startX + (clickX - startX) * 0.5 + randomDelay(-20, 20);
            const midY = startY + (clickY - startY) * 0.5 + randomDelay(-15, 15);
            await page.mouse.move(midX, midY, { steps: randomDelay(4, 7) });
            await sleep(randomDelay(20, 50));
            await page.mouse.move(clickX, clickY, { steps: randomDelay(4, 7) });

            // Step 6: Hover pause — human notices the button before pressing
            await sleep(randomDelay(150, 300));

            // Step 7: Fire physical mousedown → hold → mouseup (isTrusted=true sequence)
            await page.mouse.down();
            await sleep(randomDelay(70, 150));  // realistic press hold time
            await page.mouse.up();

            console.log(`[browser] Clicked submit with full human mouse trajectory (${context}) at (${Math.round(clickX)}, ${Math.round(clickY)})`);
            return true;
          } catch (mouseErr: any) {
            console.warn(`[browser] Human mouse click failed (${context}): ${mouseErr?.message} — trying elHandle.click()`);
          }

          // Fallback 1: Puppeteer's built-in click (teleports cursor, but still isTrusted)
          try {
            await elHandle.evaluate((node: Element) => node.scrollIntoView({ behavior: 'auto', block: 'center' }));
            await sleep(randomDelay(300, 600));
            await elHandle.click({ delay: randomDelay(80, 150) });
            console.log(`[browser] Clicked submit via elHandle.click() fallback (${context})`);
            return true;
          } catch (fallbackErr: any) {
            console.warn(`[browser] elHandle.click() fallback also failed (${context}): ${fallbackErr?.message}`);
          }

          // Fallback 2: Full JS pointer-event chain + el.click() (for off-screen / hidden buttons)
          const ok = await page.evaluate((node: Element) => {
            const el = node as HTMLElement;
            const rect = el.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const evtOpts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
            el.dispatchEvent(new MouseEvent('mouseover',   evtOpts));
            el.dispatchEvent(new MouseEvent('mouseenter',  { ...evtOpts, bubbles: false }));
            el.dispatchEvent(new MouseEvent('mousemove',   evtOpts));
            el.dispatchEvent(new MouseEvent('pointerdown', evtOpts));
            el.dispatchEvent(new MouseEvent('mousedown',   evtOpts));
            el.dispatchEvent(new MouseEvent('pointerup',   evtOpts));
            el.dispatchEvent(new MouseEvent('mouseup',     evtOpts));
            el.dispatchEvent(new MouseEvent('click',       evtOpts));
            el.click();
            return true;
          }, elHandle).catch(() => false);

          if (ok) {
            console.log(`[browser] Clicked submit via JS pointer-event chain (${context})`);
            return true;
          }
          return false;
        };

        // --- Step 1: Try standard CSS selectors (instant page.$, no timeout waste) ---
        for (const sel of standardSelectors) {
          try {
            let el = await page.$(sel);

            // If the configured submitSelector isn't found instantly, wait briefly once
            if (!el && sel === submitSelector) {
              el = await page.waitForSelector(sel, { timeout: 4000 }).catch(() => null);
            }

            if (el) {
              clickFired = await attemptTrustedClick(el, `CSS: ${sel}`);
              if (clickFired) break;
            }
          } catch { }
        }

        // --- Step 2: JS text-based broad search (if CSS selectors didn't work) ---
        if (!clickFired) {
          const submitTexts = [
            "submit", "send", "get quote", "get started", "continue",
            "next", "apply", "free", "start", "go", "request", "confirm", "done"
          ];
          const elHandle = await page.evaluateHandle((texts: string[]) => {
            const candidates = Array.from(document.querySelectorAll(
              'button, input[type="button"], input[type="submit"], a[role="button"], [role="button"]'
            )) as HTMLElement[];
            // Prefer visible, non-disabled candidates
            const visible = candidates.filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && !(el as HTMLButtonElement).disabled;
            });
            return visible.find(el => {
              const text = (el.textContent || (el as HTMLInputElement).value || "").toLowerCase().trim();
              return texts.some(st => text.includes(st));
            }) || null;
          }, submitTexts);

          const el = elHandle.asElement();
          if (el) {
            clickFired = await attemptTrustedClick(el, "JS text search");
          }
        }

        // --- Step 3: Last resort A — click the last visible button ---
        if (!clickFired) {
          const elHandle = await page.evaluateHandle(() => {
            const allBtns = Array.from(document.querySelectorAll(
              'button:not([disabled]), input[type="submit"]:not([disabled])'
            )) as HTMLElement[];
            const visible = allBtns.filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            });
            return visible.length > 0 ? visible[visible.length - 1] : null;
          });

          const el = elHandle.asElement();
          if (el) {
            clickFired = await attemptTrustedClick(el, "Last resort visible button");
          }
        }

        // --- Step 4: Nuclear fallback — directly submit the <form> element ---
        // Used when every button-click strategy fails (e.g. heavily React-controlled forms
        // that prevent default and re-dispatch events only from form.submit()).
        if (!clickFired) {
          console.warn('[browser] All button clicks failed — trying form.submit() nuclear fallback');
          const submitted = await page.evaluate((submitSel: string | null) => {
            // 1. Try configured submit selector first
            if (submitSel) {
              const btn = document.querySelector(submitSel) as HTMLElement | null;
              if (btn) { btn.click(); return true; }
            }
            // 2. Find any visible submit button and click it
            const btns = Array.from(document.querySelectorAll(
              'button[type="submit"], input[type="submit"], button:not([type])'
            )) as HTMLElement[];
            const visible = btns.find(b => {
              const r = b.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && !(b as HTMLButtonElement).disabled;
            });
            if (visible) { visible.click(); return true; }
            // 3. Submit the form element directly
            const form = document.querySelector('form') as HTMLFormElement | null;
            if (form) {
              // Dispatch submit event first so listeners fire, then call native submit
              const evt = new Event('submit', { bubbles: true, cancelable: true });
              const notCancelled = form.dispatchEvent(evt);
              if (notCancelled) form.submit();
              return true;
            }
            return false;
          }, submitSelector).catch(() => false);

          if (submitted) {
            console.log('[browser] Nuclear form.submit() fallback fired');
            clickFired = true;
          }
        }

        if (!clickFired) {
          console.warn(`[browser] Submit attempt ${attempt}: no clickable button or form found, skipping fallback submit to ensure plugins trigger`);
          await sleep(2000);
          continue;
        }

        if (clickFired) totalClicksFired++;

        // --- Step 4: Click was fired — wait for confirmation ---
        // Wait up to 15s to confirm, but cap it at the remaining SUBMISSION_PHASE_MAX_MS
        const timeElapsed = Date.now() - submissionStartTime;
        const timeRemaining = Math.max(3000, SUBMISSION_PHASE_MAX_MS - timeElapsed);
        // Each attempt gets at most 12s to detect confirmation, but never more than what's left
        const confirmationTimeout = Math.min(12000, timeRemaining);
        const deadline = Date.now() + confirmationTimeout;

        // Watch for any XHR/fetch fired after clicking — strong sign form was processed
        let networkActivityDetected = false;
        const networkListener = (req: any) => { networkActivityDetected = true; };
        try { page.on('request', networkListener); } catch { }
        while (Date.now() < deadline) {
          await sleep(500);

          const currentUrl = page.url();
          if (currentUrl !== urlBefore) {
            console.log(`[browser] Submit confirmed via URL change: ${currentUrl}`);
            submissionConfirmed = true;
            break;
          }

          const bodyNow = await page.evaluate(() =>
            document.body?.innerText?.toLowerCase().slice(0, 2000) || ""
          ).catch(() => "");

          if (SUCCESS_PATTERNS.some(p => bodyNow.includes(p))) {
            console.log(`[browser] Submit confirmed via success DOM indicator`);
            submissionConfirmed = true;
            break;
          }

          // Significant body shrink = form replaced by success message
          if (bodyBefore && bodyNow && bodyNow !== bodyBefore.toLowerCase() && bodyNow.length < bodyBefore.length * 0.5) {
            console.log(`[browser] Submit confirmed via body content change`);
            submissionConfirmed = true;
            break;
          }

          // JSON response = API-style form action
          const isJSON = await page.evaluate(() =>
            document.contentType === 'application/json' ||
            (document.body?.innerText?.trim().startsWith('{') && document.body?.innerText?.trim().endsWith('}'))
          ).catch(() => false);

          if (isJSON) {
            console.log(`[browser] Submit confirmed via JSON response`);
            submissionConfirmed = true;
            break;
          }

          // SPA detection: form element disappeared from DOM (AJAX submitted in-place)
          const formGone = await page.evaluate(() => {
            return document.querySelector('form') === null;
          }).catch(() => false);
          if (formGone) {
            console.log(`[browser] Submit confirmed via form element removal (SPA AJAX submit)`);
            submissionConfirmed = true;
            break;
          }

          // aria-live region updated = screen-reader-friendly success message
          const ariaMsg = await page.evaluate(() => {
            const live = document.querySelector('[aria-live="polite"], [aria-live="assertive"], [role="alert"], [role="status"]') as HTMLElement | null;
            return live ? live.innerText.toLowerCase().trim() : "";
          }).catch(() => "");
          if (ariaMsg && SUCCESS_PATTERNS.some(p => ariaMsg.includes(p))) {
            console.log(`[browser] Submit confirmed via aria-live region: "${ariaMsg}"`);
            submissionConfirmed = true;
            break;
          }

          // Check for validation error patterns
          if (ERROR_PATTERNS.some(p => bodyNow.includes(p))) {
            const visibleError = await page.evaluate((patterns: string[]) => {
              const bodyText = document.body.innerText.toLowerCase();
              const found = patterns.find(p => bodyText.includes(p));
              if (!found) return null;
              const errorElements = Array.from(document.querySelectorAll(
                '.error, .alert, .invalid-feedback, [class*="error"], [id*="error"], [class*="invalid"]'
              )) as HTMLElement[];
              const visible = errorElements.find(el => el.innerText && el.offsetParent !== null);
              return visible ? visible.innerText.slice(0, 200) : `Validation error detected (pattern: "${found}")`;
            }, ERROR_PATTERNS).catch(() => null);

            if (visibleError) {
              lastErrorDetail = visibleError;
              console.warn(`[browser] Validation error detected: ${visibleError}`);
              break;
            }
          }
          // Network activity after click = form likely sent data to server
          if (networkActivityDetected) {
            // Only treat as confirmed if we also see the body changed or URL changed
            const bodyNowFinal = await page.evaluate(() =>
              document.body?.innerText?.toLowerCase().slice(0, 2000) || ""
            ).catch(() => "");
            if (bodyNowFinal !== bodyBefore.toLowerCase() || page.url() !== urlBefore) {
              console.log('[browser] Submit confirmed via network activity + DOM/URL change');
              submissionConfirmed = true;
              break;
            }
          }
        }
        try { page.off('request', networkListener); } catch { }

        if (submissionConfirmed) break;
        console.log(`[browser] Submit attempt ${attempt} completed (click fired, confirmation not yet reached)`);

        // Short back-off between retry attempts
        if (attempt < 3) {
          const retryBackoff = randomDelay(1000, 2000);
          console.log(`[browser] Waiting ${retryBackoff}ms before retry attempt ${attempt + 1}`);
          await sleep(retryBackoff);
        }

      } catch (err: any) {
        console.warn(`[browser] Submit attempt ${attempt} failed: ${err.message}`);
        await sleep(randomDelay(3000, 5000));
      }
    }

    // --- Optimistic success fallback ---
    // ONLY activate if ALL 3 attempts fired clicks AND we have no visible errors.
    // Requiring all 3 clicks avoids false-positive "success" when the button
    // wasn't actually found or the form's JS prevented processing.
    if (!submissionConfirmed && totalClicksFired >= 3 && !lastErrorDetail) {
      // Extra 5s wait to catch delayed AJAX success messages / SPA transitions
      onProgress({ step: "submitting", detail: "Waiting for final confirmation...", percent: 96, timestamp: Date.now() });
      await sleep(5000);

      // Re-check URL and body one last time
      const finalUrl = page.url();
      const finalBody = await page.evaluate(() => document.body?.innerText?.toLowerCase().slice(0, 2000) || "").catch(() => "");
      if (finalUrl !== urlBefore) {
        console.log('[browser] Optimistic: URL changed after wait — confirmed.');
        submissionConfirmed = true;
      } else if (SUCCESS_PATTERNS.some(p => finalBody.includes(p))) {
        console.log('[browser] Optimistic: success text appeared after wait — confirmed.');
        submissionConfirmed = true;
      } else {
        const hasVisibleError = await page.evaluate((patterns: string[]) => {
          const bodyText = document.body?.innerText?.toLowerCase() || "";
          if (!patterns.some(p => bodyText.includes(p))) return false;
          const errorEls = Array.from(document.querySelectorAll(
            '.error, .alert-danger, .invalid-feedback, [class*="error"], [id*="error"]'
          )) as HTMLElement[];
          return errorEls.some(el => el.offsetParent !== null && el.innerText.trim().length > 0);
        }, ERROR_PATTERNS).catch(() => false);

        if (!hasVisibleError) {
          console.log(`[browser] Optimistic success — all 3 clicks fired, no visible error. Treating as success.`);
          onProgress({ step: "complete", detail: "Submitted (no redirect detected — treating as success)", percent: 100, timestamp: Date.now() });
          submissionConfirmed = true;
        }
      }
    }

    if (!submissionConfirmed) {
      const finalScreenshot = await page.screenshot({ encoding: "base64", fullPage: true }).catch(() => null);
      console.warn("[browser] Form submission failed — no confirmation reached after 3 attempts.");
      const errorMsg = lastErrorDetail
        ? `Form submission failed: ${lastErrorDetail}`
        : "Form submission failed — submit button did not trigger a success state or a new page. Please verify fields and site stability.";

      return {
        success: false,
        screenshot: finalScreenshot,
        duration: Date.now() - startTime,
        errorMessage: errorMsg,
        extractedData: currentExtractedData || {}
      };
    }

    // Final data extraction (Success tokens, etc)
    const postSubmitData = await extractPageData(page);
    const extractedData = { ...currentExtractedData, ...postSubmitData };

    const duration = Date.now() - startTime;
    onProgress({ step: "complete", detail: `Completed in ${Math.round(duration / 1000)}s`, percent: 100, timestamp: Date.now() });

    await browser.close();
    browser = null;

    return { success: true, screenshot: null, duration, errorMessage: null, extractedData };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    const errorDetail = (error?.message || "Submission failed").slice(0, 300);

    onProgress({
      step: "error",
      detail: errorDetail,
      percent: 100,
      timestamp: Date.now(),
    });

    if (browser) {
      try { await browser.close(); } catch { }
    }

    return { success: false, screenshot: null, duration, errorMessage: error.message, extractedData: currentExtractedData || {} };
  }
}

/**
 * Independently harvest TrustedForm / Journaya cert URLs from the target page.
 * Opens a fresh browser session (no form filling, no submission) so it never
 * interferes with the main submit workflow.  Always resolves — never throws.
 */
export async function extractTrustedFormData(
  url: string,
  proxy: ProxyConfig | null
): Promise<Record<string, string>> {
  let browser: any = null;
  try {
    const { default: puppeteerExtra } = await import("puppeteer-extra");
    const { default: StealthPlugin } = await import("puppeteer-extra-plugin-stealth");
    const { default: puppeteer } = await import("puppeteer");
    puppeteerExtra.use(StealthPlugin());

    /**
     * (Re)launch the browser and return a fully configured page.
     * A new launch is needed on every tunnel-error retry — HTTPS CONNECT
     * tunnels cannot be recovered on the same Chromium process.
     */
    const launchPage = async (): Promise<any> => {
      if (browser) {
        try { await browser.close(); } catch { }
        browser = null;
      }
      const args = [
        "--no-sandbox", "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", "--disable-gpu", "--window-size=1280,800",
      ];
      if (proxy) args.push(`--proxy-server=${proxy.protocol}://${proxy.host}:${proxy.port}`);
      browser = await puppeteerExtra.launch({
        headless: true,
        executablePath: puppeteer.executablePath(),
        args,
      });
      const pg = await browser.newPage();
      // Apply full US timezone emulation BEFORE navigation so TrustedForm
      // records a US local time in the cert (not the server's GMT+5).
      await applyUSTimezone(pg);
      await pg.setViewport({ width: 1280, height: 800 });
      await pg.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      );
      if (proxy?.username && proxy?.password) {
        await pg.authenticate({ username: proxy.username, password: proxy.password });
      }
      return pg;
    };

    const isTunnelErr = (e: any) =>
      e?.message?.includes("ERR_TUNNEL_CONNECTION_FAILED") ||
      e?.message?.includes("ERR_PROXY_CONNECTION_FAILED") ||
      e?.message?.includes("net::ERR_");

    // Use mutable `let` so we can replace the page on each browser restart
    let page = await launchPage();

    // Navigate with up to 3 retries; each retry fully relaunches the browser
    // because a broken HTTPS tunnel can never recover on the same process.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        break; // success — exit retry loop
      } catch (navErr: any) {
        if (isTunnelErr(navErr) && attempt < 3) {
          console.warn(`[trusted-form] Tunnel error (attempt ${attempt}), restarting browser...`);
          await sleep(2000 * attempt);
          page = await launchPage(); // fresh browser + page; old one is closed inside launchPage
        } else {
          // Non-tunnel error or final attempt — proceed to scrape whatever loaded
          console.warn(`[trusted-form] Navigation failed (attempt ${attempt}): ${navErr?.message}`);
          break;
        }
      }
    }

    // Poll for up to 15 s for TrustedForm / Journaya inputs to populate
    const result: Record<string, string> = {};
    const deadline = Date.now() + 15000;

    while (Date.now() < deadline) {
      const scraped: Record<string, string> = await page.evaluate(() => {
        const data: Record<string, string> = {};

        // TrustedForm cert URL (multiple possible attribute patterns)
        const tfSelectors = [
          'input[name*="TrustedFormCertUrl"]',
          'input[name*="trustedform"]',
          'input[name*="trusted_form"]',
          'input[name="cert_url"]',
        ];
        for (const sel of tfSelectors) {
          const el = document.querySelector(sel) as HTMLInputElement | null;
          if (el?.value && el.value.startsWith("https://")) {
            data["trusted_form_url"] = el.value;
            break;
          }
        }

        // Journaya token
        const journayaEl = document.querySelector('input[name*="journ"]') as HTMLInputElement | null;
        if (journayaEl?.value) {
          data[journayaEl.name] = journayaEl.value;
          data["journaya_token"] = journayaEl.value;
        }

        // Any hidden input that looks like a cert / token URL
        document.querySelectorAll('input[type="hidden"]').forEach((el) => {
          const inp = el as HTMLInputElement;
          if (inp.value && inp.value.startsWith("https://cert.trustedform.com")) {
            data["trusted_form_url"] = inp.value;
          }
          if (inp.value && inp.value.startsWith("https://journaya.com")) {
            data["journaya_url"] = inp.value;
          }
        });

        return data;
      }).catch(() => ({}));

      // Merge new values in
      Object.assign(result, scraped);

      // If we already got the TrustedForm URL we're done
      if (result["trusted_form_url"]) break;

      await new Promise((r) => setTimeout(r, 800));
    }

    await browser.close();
    browser = null;

    console.log("[trusted-form] Extracted:", result);
    return result;
  } catch (err: any) {
    console.warn("[trusted-form] Extraction failed:", err.message);
    if (browser) {
      try { await browser.close(); } catch { }
    }
    return {};
  }
}
