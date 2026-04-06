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
 * Types a string character-by-character with human-like variable delays.
 * Includes occasional "thinking pauses" to mimic real user behaviour.
 */
async function typeHumanLike(page: any, value: string): Promise<void> {
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];

    // Occasional thinking pause (≈3% chance) — rare hesitation to stay fast
    if (i > 0 && Math.random() < 0.03) {
      await sleep(randomDelay(200, 500));
    }

    // Slight burst speed for common letter pairs (bigrams) — feels natural
    const prevCh = i > 0 ? value[i - 1] : '';
    const isBigram = prevCh && prevCh !== ' ' && ch !== ' ';
    const keystrokeDelay = isBigram
      ? randomDelay(40, 100)   // fast inside a word
      : randomDelay(80, 180);  // slightly slower at spaces / word boundaries

    await page.keyboard.type(ch, { delay: keystrokeDelay });
  }
  // Brief pause after finishing the value
  await sleep(randomDelay(80, 200));
}

/**
 * Moves the mouse to a random point near the element centre before interacting.
 * Simulates natural cursor movement so bot-detection heuristics see pointer activity.
 */
async function humanMouseMove(page: any, elementHandle: any): Promise<void> {
  try {
    const box = await elementHandle.boundingBox();
    if (!box) return;

    // Land somewhere within the middle 60% of the element
    const targetX = box.x + box.width  * (0.2 + Math.random() * 0.6);
    const targetY = box.y + box.height * (0.2 + Math.random() * 0.6);

    // Approach from a random nearby starting offset
    const startX = targetX + randomDelay(-60, 60);
    const startY = targetY + randomDelay(-30, 30);

    await page.mouse.move(startX, startY);
    await sleep(randomDelay(20, 60));
    await page.mouse.move(targetX, targetY, { steps: randomDelay(4, 8) });
    await sleep(randomDelay(30, 90));
  } catch {
    // Non-fatal — continue without mouse simulation
  }
}

/**
 * Scrolls the element into view with a small random offset and waits briefly,
 * mimicking a human pausing to read the field before typing.
 */
async function humanScrollTo(page: any, selector: string): Promise<void> {
  try {
    await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, selector);
    await sleep(randomDelay(100, 250));
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
  await humanScrollTo(page, selector);

  // Pause as if the user is reading the label before typing
  await sleep(randomDelay(200, 500));

  const handle = await page.$(selector);
  if (handle) {
    await humanMouseMove(page, handle);
  }

  // Click to focus (triple-click selects existing text)
  await page.click(selector, { clickCount: 3, delay: randomDelay(25, 60) });
  await sleep(randomDelay(80, 200));

  // Delete any pre-filled value
  await page.keyboard.press('Backspace');
  await sleep(randomDelay(40, 100));

  // Type human-like
  try {
    await typeHumanLike(page, value);
  } catch {
    // Fallback: native setter for React-controlled inputs
    await fillInputNative(page, selector, value);
  }

  // Tab away or blur — like pressing Tab to move to the next field
  if (Math.random() < 0.6) {
    await page.keyboard.press('Tab');
  } else {
    await page.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      el?.blur();
    }, selector);
  }
  await sleep(randomDelay(80, 180));
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
    // Fallback: native setter + full event chain (for React-controlled selects)
    await page.evaluate((sel: string, val: string) => {
      const el = document.querySelector(sel) as HTMLSelectElement | null;
      if (!el) throw new Error(`Select not found: ${sel}`);

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

    // Dynamic imports to save cold-start time and memory on Vercel
    const { default: puppeteerExtra } = await import("puppeteer-extra");
    const { default: StealthPlugin } = await import("puppeteer-extra-plugin-stealth");
    const { default: puppeteer } = await import("puppeteer"); // Assuming puppeteer is also needed

    puppeteerExtra.use(StealthPlugin());

    const launchArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1920,1080",
    ];

    if (proxy) {
      launchArgs.push(`--proxy-server=${proxy.protocol}://${proxy.host}:${proxy.port}`);
    }

    browser = await puppeteerExtra.launch({
      headless: true,
      executablePath: puppeteer.executablePath(),
      args: launchArgs,
    });
    checkAbort();

    page = await browser.newPage();
    console.log(`[browser] New page created, navigating to ${url}`);
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    if (proxy && proxy.username && proxy.password) {
      await page.authenticate({ username: proxy.username, password: proxy.password });
    }

    // Navigate with automatic retry. Two phases:
    //   Phase 1: zip-based proxy — up to 3 attempts with exponential backoff
    //   Phase 2: state-based fallback proxy (if provided) — up to 2 attempts
    const isTunnelError = (err: any) =>
      err?.message?.includes("ERR_TUNNEL_CONNECTION_FAILED") ||
      err?.message?.includes("ERR_PROXY_CONNECTION_FAILED") ||
      err?.message?.includes("ERR_CONNECTION_TIMED_OUT") ||
      err?.message?.includes("net::ERR_");

    const MAX_ZIP_ATTEMPTS = 3;
    let lastTunnelErr: any = null;

    // Phase 1 — ZIP proxy
    for (let attempt = 1; attempt <= MAX_ZIP_ATTEMPTS; attempt++) {
      const label = attempt > 1 ? ` (retry ${attempt}/${MAX_ZIP_ATTEMPTS})` : "";
      onProgress({ step: "navigating", detail: `Navigating${label}`, percent: 10, timestamp: Date.now() });
      checkAbort();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        lastTunnelErr = null;
        break; // success
      } catch (err: any) {
        if (isTunnelError(err)) {
          if (attempt < MAX_ZIP_ATTEMPTS) {
            const waitMs = 3000 * attempt;
            onProgress({
              step: "field_warning",
              detail: `Connection failed, retrying in ${waitMs / 1000}s... (${attempt}/${MAX_ZIP_ATTEMPTS})`,
              percent: 12,
              timestamp: Date.now(),
            });
            await sleep(waitMs);
            if (proxy?.username && proxy?.password) {
              await page.authenticate({ username: proxy.username, password: proxy.password });
            }
          } else {
            lastTunnelErr = err; // exhausted zip attempts
          }
        } else {
          // Non-tunnel error (e.g. DNS failure, invalid URL, HTTPS error)
          console.error(`[browser] Navigation failed (non-tunnel): ${err.message}`);
          throw new Error(`Navigation failed: ${err.message}`);
        }
      }
    }

    // Phase 2 — State fallback (only if zip failed with tunnel errors)
    if (lastTunnelErr) {
      if (fallbackProxy) {
        onProgress({
          step: "field_warning",
          detail: "Switching to alternate connection...",
          percent: 13,
          timestamp: Date.now(),
        });
        await page.authenticate({ username: fallbackProxy.username, password: fallbackProxy.password });

        for (let attempt = 1; attempt <= 2; attempt++) {
          onProgress({
            step: "navigating",
            detail: `Navigating via alternate proxy (${attempt}/2)`,
            percent: 14,
            timestamp: Date.now(),
          });
          try {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
            break; // success
          } catch (err: any) {
            if (attempt < 2) {
              await sleep(3000);
              await page.authenticate({ username: fallbackProxy.username, password: fallbackProxy.password });
            } else {
              throw new Error(
                `Both ZIP (${proxy?.label ?? "zip"}) and state (${fallbackProxy.label ?? "state"}) proxies failed. ` +
                `Last error: ${err.message}`
              );
            }
          }
        }
      } else {
        throw lastTunnelErr; // no fallback available
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

      try {
        if (field.type === "checkbox") {
          const shouldCheck = value === "true" || value === "1" || value === "on" || (field.options && field.options.includes(value));
          if (shouldCheck) {
            try {
              await page.waitForSelector(field.selector, { timeout: 8000 });
              const isChecked = await page.$eval(field.selector, (el: any) => el.checked);
              if (!isChecked) {
                // Scroll into view + mouse move so TrustedForm records a real pointer interaction
                await humanScrollTo(page, field.selector);
                await sleep(randomDelay(150, 350));
                const cbHandle = await page.$(field.selector);
                if (cbHandle) await humanMouseMove(page, cbHandle);
                await page.click(field.selector);
                await sleep(randomDelay(100, 250));
              }
            } catch {
              // Fallback: try by value attribute
              const altSel = `input[type="checkbox"][value="${field.options?.[0] || value}"]`;
              try {
                await page.waitForSelector(altSel, { timeout: 3000 });
                await humanScrollTo(page, altSel);
                const cbAltHandle = await page.$(altSel);
                if (cbAltHandle) await humanMouseMove(page, cbAltHandle);
                await page.click(altSel);
                await sleep(randomDelay(100, 250));
              } catch { }
            }
          }
        } else if (field.type === "radio") {
          const radioSelector = `input[name="${field.name}"][value="${value}"]`;
          try {
            await page.waitForSelector(radioSelector, { timeout: 8000 });
            // Scroll + mouse move before clicking so TrustedForm records the interaction
            await humanScrollTo(page, radioSelector);
            await sleep(randomDelay(150, 350));
            const radioHandle = await page.$(radioSelector);
            if (radioHandle) await humanMouseMove(page, radioHandle);
            await page.click(radioSelector);
            await sleep(randomDelay(100, 250));
          } catch {
            // Fallback: try generic radio selector with same value
            const altSel = `input[type="radio"][value="${value}"]`;
            try {
              await humanScrollTo(page, altSel);
              const altHandle = await page.$(altSel);
              if (altHandle) await humanMouseMove(page, altHandle);
              await page.click(altSel);
              await sleep(randomDelay(100, 250));
            } catch { }
          }
        } else if (field.type === "select") {
          await humanScrollTo(page, field.selector);
          await sleep(randomDelay(200, 500));
          const selHandle = await page.$(field.selector);
          if (selHandle) await humanMouseMove(page, selHandle);
          await page.waitForSelector(field.selector, { timeout: 8000 });
          await fillSelectNative(page, field.selector, value);
          await sleep(randomDelay(300, 700));
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

      // Inter-field pause — calibrated to hit ~30s total for an 8–12 field form
      // First 3 fields: settling into rhythm; later fields: slightly more deliberate
      const baseDelay = i < 3 ? randomDelay(800, 1500) : randomDelay(1000, 2000);
      await sleep(baseDelay);
    }

    onProgress({ step: "fields_complete", detail: "All fields saved", percent: 82, timestamp: Date.now() });
    checkAbort();

    // Review pause before submit — user glances over the filled form
    await sleep(randomDelay(1000, 2000));

    // Occasionally do a quick scroll-up review (35% chance)
    if (Math.random() < 0.35) {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      await sleep(randomDelay(400, 800));
      await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
      await sleep(randomDelay(300, 600));
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
    // User requested the entire submission confirmation phase to complete within 45 seconds.
    const SUBMISSION_PHASE_MAX_MS = 45000;
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

        // --- Step 1: Try standard CSS selectors (instant page.$, no timeout waste) ---
        for (const sel of standardSelectors) {
          try {
            let el = await page.$(sel);

            // If the configured submitSelector isn't found instantly, wait briefly once
            if (!el && sel === submitSelector) {
              el = await page.waitForSelector(sel, { timeout: 4000 }).catch(() => null);
            }

            if (el) {
              await el.evaluate((node: Element) => node.scrollIntoView({ behavior: 'smooth', block: 'center' }));
              await sleep(400);
              const ok = await el.click().then(() => true).catch(async () =>
                page.evaluate((node: Element) => { (node as HTMLElement).click(); return true; }, el).catch(() => false)
              );
              if (ok) {
                clickFired = true;
                console.log(`[browser] Clicked submit via selector: ${sel}`);
                break;
              }
            }
          } catch { }
        }

        // --- Step 2: JS text-based broad search (if CSS selectors didn't work) ---
        if (!clickFired) {
          const submitTexts = [
            "submit", "send", "get quote", "get started", "continue",
            "next", "apply", "free", "start", "go", "request", "confirm", "done"
          ];
          const jsClickOk = await page.evaluate((texts: string[]) => {
            const candidates = Array.from(document.querySelectorAll(
              'button, input[type="button"], input[type="submit"], a[role="button"], [role="button"]'
            )) as HTMLElement[];
            // Prefer visible, non-disabled candidates
            const visible = candidates.filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && !(el as HTMLButtonElement).disabled;
            });
            const found = visible.find(el => {
              const text = (el.textContent || (el as HTMLInputElement).value || "").toLowerCase().trim();
              return texts.some(st => text.includes(st));
            });
            if (found) {
              found.scrollIntoView({ behavior: 'smooth', block: 'center' });
              found.click();
              return true;
            }
            return false;
          }, submitTexts).catch(() => false);

          if (jsClickOk) {
            clickFired = true;
            console.log(`[browser] Clicked submit via JS text search`);
          }
        }

        // --- Step 3: Last resort A — click the last visible button or submit the form ---
        if (!clickFired) {
          const lastResortOk = await page.evaluate(() => {
            const allBtns = Array.from(document.querySelectorAll(
              'button:not([disabled]), input[type="submit"]:not([disabled])'
            )) as HTMLElement[];
            const visible = allBtns.filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            });
            if (visible.length > 0) {
              const target = visible[visible.length - 1];
              target.scrollIntoView({ block: 'center' });
              target.click();
              return true;
            }
            return false;
          }).catch(() => false);

          if (lastResortOk) {
            clickFired = true;
            console.log(`[browser] Clicked submit via last-resort button click`);
          }
        }

        // --- Step 3B: Last resort B — form.requestSubmit() (triggers native HTML5 validation + submit) ---
        if (!clickFired) {
          const requestSubmitOk = await page.evaluate(() => {
            const form = document.querySelector('form') as HTMLFormElement | null;
            if (form && typeof form.requestSubmit === 'function') {
              form.requestSubmit();
              return true;
            }
            if (form) {
              form.submit();
              return true;
            }
            return false;
          }).catch(() => false);

          if (requestSubmitOk) {
            clickFired = true;
            console.log(`[browser] Submitted via form.requestSubmit()`);
          } else {
            console.warn(`[browser] Submit attempt ${attempt}: no clickable button or form found`);
            await sleep(2000);
            continue;
          }
        }

        if (clickFired) totalClicksFired++;

        // --- Step 4: Click was fired — wait for confirmation ---
        // Wait up to 15s to confirm, but cap it at the remaining SUBMISSION_PHASE_MAX_MS
        const timeElapsed = Date.now() - submissionStartTime;
        const timeRemaining = Math.max(1000, SUBMISSION_PHASE_MAX_MS - timeElapsed);
        const confirmationTimeout = Math.min(15000, timeRemaining);
        const deadline = Date.now() + confirmationTimeout;
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
        }

        if (submissionConfirmed) break;
        console.log(`[browser] Submit attempt ${attempt} completed (click fired, confirmation not yet reached)`);

      } catch (err: any) {
        console.warn(`[browser] Submit attempt ${attempt} failed: ${err.message}`);
        await sleep(2000);
      }
    }

    // --- Optimistic success fallback ---
    // If we fired clicks on all 3 attempts but never got explicit confirmation,
    // and there's no visible error text on the page now, treat as success.
    // Many sites silently accept submissions without a redirect or "thank you" message.
    if (!submissionConfirmed && totalClicksFired >= 1 && !lastErrorDetail) {
      const hasVisibleError = await page.evaluate((patterns: string[]) => {
        const bodyText = document.body?.innerText?.toLowerCase() || "";
        if (!patterns.some(p => bodyText.includes(p))) return false;
        // A pattern match in body text alone isn't enough — require a visible error element
        const errorEls = Array.from(document.querySelectorAll(
          '.error, .alert-danger, .invalid-feedback, [class*="error"], [id*="error"]'
        )) as HTMLElement[];
        return errorEls.some(el => el.offsetParent !== null && el.innerText.trim().length > 0);
      }, ERROR_PATTERNS).catch(() => false);

      if (!hasVisibleError) {
        console.log(`[browser] Optimistic success — ${totalClicksFired} click(s) fired, no visible error text. Treating as success.`);
        onProgress({ step: "complete", detail: "Submitted (no redirect detected — treating as success)", percent: 100, timestamp: Date.now() });
        submissionConfirmed = true;
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

    const launchArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1280,800",
    ];

    if (proxy) {
      launchArgs.push(`--proxy-server=${proxy.protocol}://${proxy.host}:${proxy.port}`);
    }

    browser = await puppeteerExtra.launch({
      headless: true,
      executablePath: puppeteer.executablePath(),
      args: launchArgs,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    if (proxy?.username && proxy?.password) {
      await page.authenticate({ username: proxy.username, password: proxy.password });
    }

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch {
      // Non-fatal — try to scrape anyway
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
