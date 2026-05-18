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
 * Types a string character-by-character at a human-like speed.
 * Speed rule:
 *   • value.length <  15 → 500 ms per digit  (±50 ms jitter)
 *   • value.length >= 15 → 400 ms per digit  (±50 ms jitter)
 * Occasional micro-pauses (~6% chance) mimic natural hesitation.
 */
async function typeHumanLike(page: any, value: string): Promise<void> {
  // Base delay per character depends on total field length
  const baseMs = value.length < 15 ? 500 : 400;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];

    // Occasional thinking micro-pause (~6% chance) — natural hesitation
    if (i > 0 && Math.random() < 0.06) {
      await sleep(randomDelay(80, 160));
    }

    // Per-keystroke delay: base ± 50 ms jitter for realism
    const keystrokeDelay = baseMs + randomDelay(-50, 50);

    await page.keyboard.type(ch, { delay: keystrokeDelay });
  }
  // Very brief post-type glance
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

  // Step 2: Brief reading pause — user notices the field label (trimmed for speed)
  await sleep(randomDelay(300, 500));

  const handle = await page.$(selector);

  // Step 3: Move mouse naturally to the field via a 3-point arc
  if (handle) {
    await humanMouseMove(page, handle);
    await sleep(randomDelay(80, 150));
  }

  // Step 4: Click to focus (triple-click selects any existing text)
  await page.click(selector, { clickCount: 3, delay: randomDelay(60, 100) });
  await sleep(randomDelay(100, 200));

  // Step 5: Clear any pre-filled value
  await page.keyboard.press('Backspace');
  await sleep(randomDelay(50, 100));

  // Step 6: Type character-by-character at natural human speed
  try {
    await typeHumanLike(page, value);
  } catch {
    // Fallback: native value setter for React/Vue-controlled inputs
    await fillInputNative(page, selector, value);
  }

  // Step 7: Very brief post-type pause
  await sleep(randomDelay(100, 200));

  // Step 8: Tab away (60%) or blur (40%) to commit the value
  if (Math.random() < 0.6) {
    await page.keyboard.press('Tab');
  } else {
    await page.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      el?.blur();
    }, selector);
  }
  await sleep(randomDelay(40, 80));
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
        // Additional flags for high concurrency / low RAM usage
        "--disable-extensions",
        "--disable-component-update",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-breakpad",
        "--disable-client-side-phishing-detection",
        "--disable-default-apps",
        "--disable-domain-reliability",
        "--disable-features=AudioServiceOutOfProcess",
        "--disable-hang-monitor",
        "--disable-ipc-flooding-protection",
        "--disable-notifications",
        "--disable-offer-store-unmasked-wallet-cards",
        "--disable-popup-blocking",
        "--disable-print-preview",
        "--disable-prompt-on-repost",
        "--disable-renderer-backgrounding",
        "--disable-speech-api",
        "--disable-sync",
        "--hide-scrollbars",
        "--metrics-recording-only",
        "--mute-audio",
        "--no-default-browser-check",
        "--no-first-run",
        "--no-pings",
        "--no-zygote",
        "--password-store=basic",
        "--use-gl=swiftshader",
        "--use-mock-keychain",
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
      
      // Optimization: Block images and media to save bandwidth/RAM for high concurrency
      await page.setRequestInterception(true);
      page.on('request', (req: any) => {
        const resourceType = req.resourceType();
        if (resourceType === 'image' || resourceType === 'media' || resourceType === 'font') {
          req.abort();
        } else {
          req.continue();
        }
      });

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

      // clickFieldHumanLocal: mouse movement + click budget = 1.5 s total
      //   ~800 ms smooth move (steps proportional) + ~100 ms hover + ~200 ms press + ~400 ms post-click
      const clickFieldHumanLocal = async (selectorLocal: string): Promise<boolean> => {
        await humanScrollTo(page, selectorLocal);
        const elHandle = await page.$(selectorLocal);
        if (elHandle) {
          try {
            const box = await elHandle.boundingBox();
            if (box && box.width > 0 && box.height > 0) {
              const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
              const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);
              // Smooth move — total travel time ~800 ms via step count
              await page.mouse.move(targetX, targetY, { steps: 20 });
              await sleep(100); // hover pause
              await page.mouse.down();
              await sleep(randomDelay(80, 120)); // realistic press hold
              await page.mouse.up();
              await sleep(randomDelay(350, 450)); // post-click settle  → total ≈1.5 s
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
              const targetX = lbox.x + lbox.width * (0.3 + Math.random() * 0.4);
              const targetY = lbox.y + lbox.height * (0.3 + Math.random() * 0.4);
              await page.mouse.move(targetX, targetY, { steps: 20 });
              await sleep(100);
              await page.mouse.down();
              await sleep(randomDelay(80, 120));
              await page.mouse.up();
              await sleep(randomDelay(350, 450));
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
                await sleep(randomDelay(800, 1200)); // Pause to notice the checkbox
                await clickFieldHumanLocal(field.selector);
                await sleep(randomDelay(600, 1000)); // Post-click pause
              }
            } catch {
              const altSel = `input[type="checkbox"][value="${field.options?.[0] || value}"]`;
              try {
                await page.waitForSelector(altSel, { timeout: 3000 });
                await sleep(randomDelay(800, 1200));
                await clickFieldHumanLocal(altSel);
                await sleep(randomDelay(600, 1000));
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
              await sleep(randomDelay(600, 1000));

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

              // Simulate the human searching for the option and clicking it
              await sleep(randomDelay(1000, 1800));

              // Step 6: Use native fallback to safely set value and trigger events
              if (exactValueToSelect !== null) {
                await fillSelectNative(page, field.selector, exactValueToSelect);
              } else {
                await fillSelectNative(page, field.selector, value);
              }
            } else {
              // No bounding box — go straight to native
              await sleep(randomDelay(1000, 1800));
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

      // Inter-field pause — kept short; the 1.5 s mouse-move budget dominates
      await sleep(randomDelay(150, 300));
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

    // --- All submit helpers defined OUTSIDE the retry loop ---
    // This prevents esbuild TDZ minification crashes ('Cannot access x before initialization')

    const isElVisible = async (node: any): Promise<boolean> => {
      return page.evaluate((el: Element) => {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0
          && s.display !== 'none'
          && s.visibility !== 'hidden'
          && parseFloat(s.opacity) > 0.1
          && !(el as HTMLButtonElement).disabled;
      }, node).catch(() => true);
    };

    const standardSelectors = [
      submitSelector,
      'button[type="submit"]',
      'input[type="submit"]',
    ].filter(Boolean) as string[];

    // clickFired declared outside; reset to false at the top of each attempt
    let clickFired = false;

    // attemptTrustedClick — defined OUTSIDE the loop to avoid esbuild TDZ crashes
    const attemptTrustedClick = async (elHandle: any, context: string): Promise<boolean> => {
      try {
        await elHandle.evaluate((node: Element) => node.scrollIntoView({ behavior: 'auto', block: 'center' }));
        await sleep(randomDelay(350, 650));
        let box = await elHandle.boundingBox();
        if (!box || box.width === 0 || box.height === 0) {
          throw new Error('Button has no visible bounding box');
        }
        let clickX = box.x + box.width  * (0.25 + Math.random() * 0.50);
        let clickY = box.y + box.height * (0.25 + Math.random() * 0.50);
        let isClickable = await page.evaluate((x: number, y: number, node: Element) => {
          const elAtPoint = document.elementFromPoint(x, y);
          return elAtPoint === node || node.contains(elAtPoint) ||
            (elAtPoint && elAtPoint.closest && elAtPoint.closest('button, input[type="submit"]') === node);
        }, clickX, clickY, elHandle).catch(() => true);
        if (!isClickable) {
          console.warn(`[browser] Submit button obscured — scrolling to clear.`);
          await page.evaluate(() => window.scrollBy(0, -180));
          await sleep(400);
          const nb = await elHandle.boundingBox();
          if (nb) { box = nb; clickX = box.x + box.width * (0.25 + Math.random() * 0.50); clickY = box.y + box.height * (0.25 + Math.random() * 0.50); }
        }
        const offX = randomDelay(-150, 150) * (Math.random() > 0.5 ? 1 : -1);
        const offY = randomDelay(-80, 80)   * (Math.random() > 0.5 ? 1 : -1);
        const startX = clickX + offX; const startY = clickY + offY;
        await page.mouse.move(startX, startY, { steps: randomDelay(3, 5) });
        await sleep(randomDelay(30, 70));
        const arc1X = startX + (clickX - startX) * 0.33 + randomDelay(-25, 25);
        const arc1Y = startY + (clickY - startY) * 0.33 + randomDelay(-15, 15);
        await page.mouse.move(arc1X, arc1Y, { steps: randomDelay(4, 6) });
        await sleep(randomDelay(15, 35));
        const arc2X = startX + (clickX - startX) * 0.70 + randomDelay(-15, 15);
        const arc2Y = startY + (clickY - startY) * 0.70 + randomDelay(-10, 10);
        await page.mouse.move(arc2X, arc2Y, { steps: randomDelay(4, 7) });
        await sleep(randomDelay(15, 30));
        await page.mouse.move(clickX, clickY, { steps: randomDelay(3, 5) });
        await sleep(randomDelay(180, 380));
        await page.mouse.down();
        await sleep(randomDelay(80, 160));
        await page.mouse.up();
        await sleep(randomDelay(60, 120));
        console.log(`[browser] ✓ Human click fired (${context}) → (${Math.round(clickX)}, ${Math.round(clickY)})`);
        return true;
      } catch (mouseErr: any) {
        console.warn(`[browser] Human mouse trajectory failed (${context}): ${mouseErr?.message} — falling back to elHandle.click()`);
      }
      try {
        await elHandle.evaluate((node: Element) => node.scrollIntoView({ behavior: 'auto', block: 'center' }));
        await sleep(randomDelay(300, 500));
        await elHandle.click({ delay: randomDelay(90, 160) });
        console.log(`[browser] ✓ Clicked via elHandle.click() (${context})`);
        return true;
      } catch (fallbackErr: any) {
        console.warn(`[browser] elHandle.click() also failed (${context}): ${fallbackErr?.message}`);
      }
      // Synthetic pointer-event chain — last resort before nuclear fallback
      const synOk = await page.evaluate((node: Element) => {
        const el = node as HTMLElement;
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2; const cy = rect.top + rect.height / 2;
        const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
        el.dispatchEvent(new PointerEvent('pointerover',  { ...base, pointerId: 1, pointerType: 'mouse' }));
        el.dispatchEvent(new MouseEvent ('mouseover',    base));
        el.dispatchEvent(new PointerEvent('pointerdown',  { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        el.dispatchEvent(new MouseEvent ('mousedown',    { ...base, button: 0, buttons: 1 }));
        el.dispatchEvent(new PointerEvent('pointerup',    { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        el.dispatchEvent(new MouseEvent ('mouseup',      { ...base, button: 0, buttons: 0 }));
        el.dispatchEvent(new MouseEvent ('click',        { ...base, button: 0, buttons: 0 }));
        return true;
      }, elHandle).catch(() => false);
      if (synOk) { console.log(`[browser] ✓ Clicked via synthetic pointer-event chain (${context})`); return true; }
      return false;
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (submissionConfirmed) break;
      if (Date.now() - submissionStartTime > SUBMISSION_PHASE_MAX_MS) {
        console.warn(`[browser] Submission phase timed out after ${SUBMISSION_PHASE_MAX_MS / 1000}s (Attempt ${attempt})`);
        break;
      }
      try {
        clickFired = false; // Reset for each attempt
        onProgress({ step: "submitting", detail: `Submit attempt ${attempt}`, percent: 85 + attempt, timestamp: Date.now() });
        await hideOverlays(page);

        // --- Step 0: Prioritize custom onclick submit buttons (CF7 + Google Sheets) ---
        if (!clickFired) {
          const customBtnHandle = await page.evaluateHandle(() => {
            const vis = (el: Element) => {
              const r = el.getBoundingClientRect();
              const s = window.getComputedStyle(el);
              return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0.1 && !(el as HTMLButtonElement).disabled;
            };
            const cands = Array.from(document.querySelectorAll(
              '#ph-submit-btn, [id*="ph-submit"], button[onclick*="SendSheet"], button[onclick*="sendSheet"], button[onclick*="phSend"]'
            )) as HTMLElement[];
            return cands.find(vis) || null;
          });
          const customEl = customBtnHandle.asElement();
          if (customEl) {
            console.log('[browser] Step 0: found #ph-submit-btn / phSendSheet button');
            clickFired = await attemptTrustedClick(customEl, 'Step 0: #ph-submit-btn');
          }
        }

        // Step 0 ends — Steps 1-4 follow

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

        // --- Step 2: JS text-based broad search — onclick handlers prioritized over type=submit ---
        // Root cause fix: sites use type="button" with onclick (e.g. phSendSheet) as the REAL
        // submit trigger. Preferring type="submit" would click a different, hidden CF7 button.
        if (!clickFired) {
          const submitTexts = [
            "submit", "send", "get quote", "get started", "continue",
            "next", "apply", "free", "start", "go", "request", "confirm", "done"
          ];
          const elHandle = await page.evaluateHandle((texts: string[]) => {
            const isVisible = (el: Element) => {
              const r = el.getBoundingClientRect();
              const s = window.getComputedStyle(el);
              return r.width > 0 && r.height > 0
                && s.display !== 'none'
                && s.visibility !== 'hidden'
                && parseFloat(s.opacity) > 0.1
                && !(el as HTMLButtonElement).disabled;
            };

            // Priority 1: type="button" WITH an onclick attribute (custom sheet/handler buttons)
            const onclickBtns = Array.from(document.querySelectorAll(
              'button[onclick]:not([type="submit"]), input[type="button"][onclick]'
            )) as HTMLElement[];
            const visibleOnclick = onclickBtns.filter(isVisible);
            const onclickMatch = visibleOnclick.find(el => {
              const text = (el.textContent || (el as HTMLInputElement).value || '').toLowerCase().trim();
              return texts.some(st => text.includes(st));
            });
            if (onclickMatch) return onclickMatch;

            // Priority 2: standard submit/button candidates (type=submit, button, role=button)
            const candidates = Array.from(document.querySelectorAll(
              'button[type="submit"], input[type="submit"], button:not([type]), input[type="button"], a[role="button"], [role="button"]'
            )) as HTMLElement[];
            const visible = candidates.filter(isVisible);
            return visible.find(el => {
              const text = (el.textContent || (el as HTMLInputElement).value || '').toLowerCase().trim();
              return texts.some(st => text.includes(st));
            }) || null;
          }, submitTexts);

          const el = elHandle.asElement();
          if (el) {
            clickFired = await attemptTrustedClick(el, 'JS text search (onclick priority)');
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
          console.warn(`[browser] Submit attempt ${attempt}: no button/form found. Waiting before retry.`);
          await sleep(2500);
          continue; // re-try the whole selector search on the next loop iteration
        }

        // Click fired — count it and stop the selector-search loop (no re-clicking)
        totalClicksFired++;

        // --- Post-click confirmation window ---
        // Give the page up to 20s to confirm. This is the most important window:
        // AJAX forms, SPA routers and slow network connections all need this time.
        // We do NOT re-click during this window — that would cause duplicate submissions.
        onProgress({ step: "submitting", detail: "Waiting for confirmation...", percent: 88 + attempt, timestamp: Date.now() });

        // Brief network-idle grace period (lets AJAX fire before we start polling)
        try { await page.waitForNetworkIdle({ timeout: 3000 }); } catch { /* fine */ }

        const confirmationWindow = 3000; // 3s max — reduced per user request to skip long confirmation wait
        const confirmDeadline = Date.now() + confirmationWindow;

        // Capture body snapshot immediately after click for change detection
        let networkActivityDetected = false;
        const networkListener = (_req: any) => { networkActivityDetected = true; };
        try { page.on('request', networkListener); } catch { }

        while (Date.now() < confirmDeadline) {
          await sleep(600);

          // 1. URL navigation — most reliable confirmation signal
          const currentUrl = page.url();
          if (currentUrl !== urlBefore) {
            console.log(`[browser] ✓ Confirmed via URL change: ${currentUrl}`);
            submissionConfirmed = true;
            break;
          }

          const bodyNow = await page.evaluate(() =>
            document.body?.innerText?.toLowerCase().slice(0, 2500) || ""
          ).catch(() => "");

          // 2. Success text in DOM
          if (SUCCESS_PATTERNS.some(p => bodyNow.includes(p))) {
            console.log(`[browser] ✓ Confirmed via success text in DOM`);
            submissionConfirmed = true;
            break;
          }

          // 3. Body content shrank significantly (form replaced by thank-you message)
          if (bodyBefore && bodyNow && bodyNow !== bodyBefore.toLowerCase() && bodyNow.length < bodyBefore.length * 0.6) {
            console.log(`[browser] ✓ Confirmed via body shrink (form replaced by message)`);
            submissionConfirmed = true;
            break;
          }

          // 4. JSON API response
          const isJSON = await page.evaluate(() =>
            document.contentType === 'application/json' ||
            (document.body?.innerText?.trim().startsWith('{') && document.body?.innerText?.trim().endsWith('}'))
          ).catch(() => false);
          if (isJSON) {
            console.log(`[browser] ✓ Confirmed via JSON API response`);
            submissionConfirmed = true;
            break;
          }

          // 5. SPA: form element removed from DOM (AJAX in-place submit)
          const formGone = await page.evaluate(() => document.querySelector('form') === null).catch(() => false);
          if (formGone) {
            console.log(`[browser] ✓ Confirmed via form removal (SPA AJAX)`);
            submissionConfirmed = true;
            break;
          }

          // 6. aria-live / role=status region updated with success message
          const ariaMsg = await page.evaluate(() => {
            const el = document.querySelector('[aria-live], [role="alert"], [role="status"]') as HTMLElement | null;
            return el ? el.innerText.toLowerCase().trim() : "";
          }).catch(() => "");
          if (ariaMsg && SUCCESS_PATTERNS.some(p => ariaMsg.includes(p))) {
            console.log(`[browser] ✓ Confirmed via aria-live: "${ariaMsg}"`);
            submissionConfirmed = true;
            break;
          }

          // 7. Network POST fired + any DOM change = strong signal
          if (networkActivityDetected) {
            const bodyNowFinal = await page.evaluate(() =>
              document.body?.innerText?.toLowerCase().slice(0, 2500) || ""
            ).catch(() => "");
            const domChanged = bodyNowFinal !== bodyBefore.toLowerCase();
            const urlChanged = page.url() !== urlBefore;
            if (domChanged || urlChanged) {
              console.log('[browser] ✓ Confirmed via network activity + DOM/URL change');
              submissionConfirmed = true;
              break;
            }
          }

          // 8. Visible validation error — stop waiting, a re-click won't help
          if (ERROR_PATTERNS.some(p => bodyNow.includes(p))) {
            const visibleError = await page.evaluate((patterns: string[]) => {
              const bodyText = document.body.innerText.toLowerCase();
              const found = patterns.find(p => bodyText.includes(p));
              if (!found) return null;
              const errorEls = Array.from(document.querySelectorAll(
                '.error, .alert, .invalid-feedback, [class*="error"], [id*="error"], [class*="invalid"]'
              )) as HTMLElement[];
              const visible = errorEls.find(el => el.innerText && el.offsetParent !== null);
              return visible ? visible.innerText.slice(0, 200) : `Validation error (pattern: "${found}")`;
            }, ERROR_PATTERNS).catch(() => null);

            if (visibleError) {
              lastErrorDetail = visibleError;
              console.warn(`[browser] Validation error: ${visibleError}`);
              break;
            }
          }
        }
        try { page.off('request', networkListener); } catch { }

        if (submissionConfirmed || lastErrorDetail) break;

        console.log(`[browser] Attempt ${attempt}: click fired but confirmation not reached within ${confirmationWindow / 1000}s. Not re-clicking (prevents double submission).`);
        // Don't re-click — the form was already submitted, just slow to respond.
        // The optimistic fallback below will handle it.
        break;

      } catch (err: any) {
        console.warn(`[browser] Submit attempt ${attempt} error: ${err.message}`);
        if (attempt < 3) await sleep(randomDelay(1500, 3000));
      }
    }

    // --- Optimistic success fallback ---
    // Fires only if: (a) we clicked at least once, AND (b) no visible validation error appeared.
    // This handles slow AJAX responses, SPA transitions, and forms with no visible feedback.
    if (!submissionConfirmed && totalClicksFired >= 1 && !lastErrorDetail) {
      onProgress({ step: "submitting", detail: "Waiting for final server response...", percent: 96, timestamp: Date.now() });
      await sleep(1000); // 1s extra — reduced per user request to skip long wait

      const finalUrl = page.url();
      const finalBody = await page.evaluate(() => document.body?.innerText?.toLowerCase().slice(0, 2500) || "").catch(() => "");

      if (finalUrl !== urlBefore) {
        console.log('[browser] Optimistic ✓: URL changed after extra wait.');
        submissionConfirmed = true;
      } else if (SUCCESS_PATTERNS.some(p => finalBody.includes(p))) {
        console.log('[browser] Optimistic ✓: success text appeared after extra wait.');
        submissionConfirmed = true;
      } else if (bodyBefore && finalBody && finalBody !== bodyBefore.toLowerCase() && finalBody.length < bodyBefore.length * 0.75) {
        // Body changed meaningfully (shrank) = form was replaced with a response
        console.log('[browser] Optimistic ✓: page body changed after extra wait (form replaced).');
        submissionConfirmed = true;
      } else {
        // Last resort: check for visible errors. If none found, treat as submitted.
        const hasVisibleError = await page.evaluate((patterns: string[]) => {
          const bodyText = document.body?.innerText?.toLowerCase() || "";
          if (!patterns.some(p => bodyText.includes(p))) return false;
          const errorEls = Array.from(document.querySelectorAll(
            '.error, .alert-danger, .invalid-feedback, [class*="error"], [id*="error"]'
          )) as HTMLElement[];
          return errorEls.some(el => el.offsetParent !== null && el.innerText.trim().length > 0);
        }, ERROR_PATTERNS).catch(() => false);

        if (!hasVisibleError) {
          console.log('[browser] Optimistic ✓: click fired, no visible error — treating as successful submission.');
          onProgress({ step: "complete", detail: "Submitted (awaiting server — treating as success)", percent: 100, timestamp: Date.now() });
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
  } finally {
    if (browser) {
      try { await browser.close(); } catch { }
      browser = null;
    }
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
  } finally {
    if (browser) {
      try { await browser.close(); } catch { }
      browser = null;
    }
  }
}
