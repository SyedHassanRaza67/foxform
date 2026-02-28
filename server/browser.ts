import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
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

    onProgress({ step: "navigating", detail: `Navigating to ${url}`, percent: 15, timestamp: Date.now() });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    await sleep(randomDelay(1000, 2000));

    onProgress({ step: "page_loaded", detail: "Page loaded successfully", percent: 20, timestamp: Date.now() });

    const sortedFields = [...fields].sort((a, b) => a.order - b.order);
    const totalFields = sortedFields.length;
    const targetTotalTime = randomDelay(30000, 40000);
    const baseFieldDelay = Math.floor(targetTotalTime / Math.max(totalFields, 1));

    for (let i = 0; i < sortedFields.length; i++) {
      const field = sortedFields[i];
      const value = formData[field.name];
      if (!value) continue;

      const fieldPercent = 20 + Math.floor((i / totalFields) * 60);
      onProgress({
        step: "filling_field",
        detail: `Filling field: ${field.label || field.name} (${i + 1}/${totalFields})`,
        percent: fieldPercent,
        timestamp: Date.now(),
      });

      try {
        await page.waitForSelector(field.selector, { timeout: 5000 });

        if (field.type === "select") {
          await page.select(field.selector, value);
        } else if (field.type === "textarea" || field.type === "text" || field.type === "email" || field.type === "tel") {
          await page.click(field.selector);
          await sleep(randomDelay(200, 500));

          const existingVal = await page.$eval(field.selector, (el: any) => el.value);
          if (existingVal) {
            await page.click(field.selector, { clickCount: 3 });
            await sleep(100);
          }

          for (const char of value) {
            await page.keyboard.type(char, { delay: 0 });
            await sleep(randomDelay(40, 120));
          }
        } else {
          await page.click(field.selector);
          await sleep(randomDelay(200, 400));

          for (const char of value) {
            await page.keyboard.type(char, { delay: 0 });
            await sleep(randomDelay(40, 120));
          }
        }
      } catch (fieldErr: any) {
        onProgress({
          step: "field_warning",
          detail: `Could not fill "${field.label || field.name}": ${fieldErr.message}`,
          percent: fieldPercent,
          timestamp: Date.now(),
        });
      }

      const interFieldDelay = randomDelay(
        Math.floor(baseFieldDelay * 0.6),
        Math.floor(baseFieldDelay * 1.4)
      );
      await sleep(interFieldDelay);
    }

    onProgress({ step: "fields_complete", detail: "All fields filled", percent: 82, timestamp: Date.now() });
    await sleep(randomDelay(500, 1500));

    if (submitSelector) {
      onProgress({ step: "submitting", detail: "Clicking submit button", percent: 85, timestamp: Date.now() });

      try {
        await page.waitForSelector(submitSelector, { timeout: 5000 });
        await page.click(submitSelector);
        await sleep(randomDelay(2000, 4000));

        try {
          await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 });
        } catch {
          // no navigation expected for some forms
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

    onProgress({ step: "screenshot", detail: "Capturing screenshot", percent: 90, timestamp: Date.now() });

    const screenshotBuffer = await page.screenshot({ encoding: "base64", fullPage: false });
    const screenshot = `data:image/png;base64,${screenshotBuffer}`;

    const duration = Date.now() - startTime;

    onProgress({ step: "complete", detail: `Form filled successfully in ${Math.round(duration / 1000)}s`, percent: 100, timestamp: Date.now() });

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
