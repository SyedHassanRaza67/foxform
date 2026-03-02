import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import puppeteer from "puppeteer";
import type { FormField } from "@shared/schema";

puppeteerExtra.use(StealthPlugin());

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
}

function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fillInputNative(page: any, selector: string, value: string): Promise<void> {
  await page.evaluate((sel: string, val: string) => {
    const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) throw new Error(`Element not found: ${sel}`);

    el.focus();

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value"
    )?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, val);
    } else {
      el.value = val;
    }

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }, selector, value);
}

export async function autoFillForm(
  url: string,
  fields: FormField[],
  formData: Record<string, string>,
  submitSelector: string | null,
  proxy: ProxyConfig | null,
  onProgress: ProgressCallback,
  fallbackProxy: ProxyConfig | null = null
): Promise<AutoFillResult> {
  const startTime = Date.now();
  let browser: any = null;

  try {
    onProgress({ step: "launching", detail: "Launching", percent: 5, timestamp: Date.now() });

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

    const page = await browser.newPage();
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
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
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
          throw err; // non-tunnel error — fail immediately
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
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
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
    await sleep(randomDelay(2000, 3000));

    try {
      await page.waitForNetworkIdle({ timeout: 6000 });
    } catch {
      // Ignore – some pages never go fully idle
    }

    // Verify we actually landed on the target site (proxy auth failure sends browser elsewhere)
    const landedUrl = page.url();
    const targetHost = new URL(url).hostname;
    const landedHost = (() => { try { return new URL(landedUrl).hostname; } catch { return ""; } })();
    if (landedHost && landedHost !== targetHost) {
      throw new Error(
        `Proxy authentication failed — browser landed on "${landedHost}" instead of "${targetHost}". ` +
        `Check your proxy URL template: the username format may be incorrect for your proxy provider.`
      );
    }

    onProgress({ step: "page_loaded", detail: "Page loaded", percent: 20, timestamp: Date.now() });

    const sortedFields = [...fields].sort((a, b) => a.order - b.order);
    const filledFields = sortedFields.filter(
      (f) => f.selector && f.name && formData[f.name] !== undefined && formData[f.name] !== ""
    );
    const totalFields = filledFields.length;

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
                await page.click(field.selector);
              }
            } catch {
              // Try by value attribute fallback
              const altSel = `input[type="checkbox"][value="${field.options?.[0] || value}"]`;
              try {
                await page.waitForSelector(altSel, { timeout: 3000 });
                await page.click(altSel);
              } catch {}
            }
          }
        } else if (field.type === "radio") {
          const radioSelector = `input[name="${field.name}"][value="${value}"]`;
          try {
            await page.waitForSelector(radioSelector, { timeout: 8000 });
            await page.click(radioSelector);
          } catch {
            const altSel = `input[type="radio"][value="${value}"]`;
            try { await page.click(altSel); } catch {}
          }
        } else if (field.type === "select") {
          await page.waitForSelector(field.selector, { timeout: 8000 });
          try {
            await page.select(field.selector, value);
          } catch {
            await page.evaluate((sel: string, val: string) => {
              const el = document.querySelector(sel) as HTMLSelectElement | null;
              if (el) {
                el.value = val;
                el.dispatchEvent(new Event("change", { bubbles: true }));
              }
            }, field.selector, value);
          }
        } else {
          await page.waitForSelector(field.selector, { timeout: 8000 });

          // First attempt: use native value setter (works for React forms)
          try {
            await fillInputNative(page, field.selector, value);
          } catch {
            // Fallback: click and type character by character
            await page.click(field.selector, { clickCount: 3 });
            await sleep(100);
            await page.keyboard.type(value, { delay: randomDelay(40, 90) });
          }

          await sleep(randomDelay(200, 500));
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

      await sleep(randomDelay(300, 800));
    }

    onProgress({ step: "fields_complete", detail: "All fields saved", percent: 82, timestamp: Date.now() });
    await sleep(randomDelay(800, 1500));

    if (submitSelector) {
      onProgress({ step: "submitting", detail: "Submitting", percent: 85, timestamp: Date.now() });

      try {
        await page.waitForSelector(submitSelector, { timeout: 5000 });
        await page.click(submitSelector);
        await sleep(randomDelay(3000, 5000));

        try {
          await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 });
        } catch {
          // No navigation – AJAX submission or same-page response
        }
      } catch (submitErr: any) {
        onProgress({
          step: "submit_warning",
          detail: "Submit issue",
          percent: 87,
          timestamp: Date.now(),
        });
      }
    }

    onProgress({ step: "screenshot", detail: "Capturing result", percent: 92, timestamp: Date.now() });

    const screenshotBuffer = await page.screenshot({ encoding: "base64", fullPage: false });
    const screenshot = `data:image/png;base64,${screenshotBuffer}`;

    const duration = Date.now() - startTime;

    onProgress({ step: "complete", detail: `Completed in ${Math.round(duration / 1000)}s`, percent: 100, timestamp: Date.now() });

    await browser.close();
    browser = null;

    return { success: true, screenshot, duration, errorMessage: null };
  } catch (error: any) {
    const duration = Date.now() - startTime;

    onProgress({
      step: "error",
      detail: "Submission failed",
      percent: 100,
      timestamp: Date.now(),
    });

    if (browser) {
      try { await browser.close(); } catch {}
    }

    return { success: false, screenshot: null, duration, errorMessage: error.message };
  }
}
