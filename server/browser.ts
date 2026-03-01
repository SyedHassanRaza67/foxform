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
  onProgress: ProgressCallback
): Promise<AutoFillResult> {
  const startTime = Date.now();
  let browser: any = null;

  try {
    onProgress({ step: "launching", detail: "Starting headless browser with stealth mode", percent: 5, timestamp: Date.now() });

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

    onProgress({ step: "navigating", detail: `Navigating to ${url}`, percent: 10, timestamp: Date.now() });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(randomDelay(2000, 3000));

    try {
      await page.waitForNetworkIdle({ timeout: 6000 });
    } catch {
      // Ignore – some pages never go fully idle
    }

    onProgress({ step: "page_loaded", detail: "Page loaded successfully", percent: 20, timestamp: Date.now() });

    const sortedFields = [...fields].sort((a, b) => a.order - b.order);
    const filledFields = sortedFields.filter(
      (f) => f.selector && f.name && formData[f.name] !== undefined && formData[f.name] !== ""
    );
    const totalFields = filledFields.length;

    // Wait for the first text field to appear — ensures the form is ready before filling
    const firstTextField = filledFields.find((f) => f.type !== "checkbox" && f.type !== "radio" && f.selector);
    if (firstTextField) {
      try {
        await page.waitForSelector(firstTextField.selector, { timeout: 15000 });
        onProgress({ step: "form_ready", detail: "Form detected and ready to fill", percent: 22, timestamp: Date.now() });
      } catch {
        onProgress({ step: "field_warning", detail: "Form took too long to appear — attempting to fill anyway", percent: 22, timestamp: Date.now() });
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
        detail: `Filling: ${field.label || field.name} (${i + 1}/${totalFields})`,
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
          detail: `Could not fill "${label}": ${fieldErr.message}`,
          percent: fieldPercent,
          timestamp: Date.now(),
        });
      }

      await sleep(randomDelay(300, 800));
    }

    onProgress({ step: "fields_complete", detail: `All ${totalFields} fields filled`, percent: 82, timestamp: Date.now() });
    await sleep(randomDelay(800, 1500));

    if (submitSelector) {
      onProgress({ step: "submitting", detail: "Clicking submit button", percent: 85, timestamp: Date.now() });

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
          detail: `Submit button issue: ${submitErr.message}`,
          percent: 87,
          timestamp: Date.now(),
        });
      }
    }

    onProgress({ step: "screenshot", detail: "Capturing screenshot", percent: 92, timestamp: Date.now() });

    const screenshotBuffer = await page.screenshot({ encoding: "base64", fullPage: false });
    const screenshot = `data:image/png;base64,${screenshotBuffer}`;

    const duration = Date.now() - startTime;

    onProgress({ step: "complete", detail: `Form filled & submitted in ${Math.round(duration / 1000)}s`, percent: 100, timestamp: Date.now() });

    await browser.close();
    browser = null;

    return { success: true, screenshot, duration, errorMessage: null };
  } catch (error: any) {
    const duration = Date.now() - startTime;

    onProgress({
      step: "error",
      detail: `Auto-fill failed: ${error.message}`,
      percent: 100,
      timestamp: Date.now(),
    });

    if (browser) {
      try { await browser.close(); } catch {}
    }

    return { success: false, screenshot: null, duration, errorMessage: error.message };
  }
}
