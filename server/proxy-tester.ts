import axios from "axios";
import crypto from "crypto";
import { type ProxyConfig } from "./browser";

interface CacheEntry {
    working: boolean;
    expiresAt: number;
}

const proxyCache = new Map<string, CacheEntry>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Build the final proxy username by substituting the geo value into the template.
 */
export function buildGeoUsername(template: string, type: "zip" | "state" | "county" | "country", value: string, session: string): string {
    let username = template;

    // Replace specific geo placeholders
    if (type === "zip") {
        username = username.replace(/\{zip\}/g, value);
    } else if (type === "state") {
        username = username.replace(/\{state\}/g, value);
    } else if (type === "county") {
        username = username.replace(/\{county\}/g, value);
    } else if (type === "country") {
        username = username.replace(/\{country\}/g, value);
    }

    // Replace session placeholder
    username = username.replace(/\{session\}/g, session);

    // Legacy fallback for geo if no specific placeholder was found
    const hasAnyGeoPlaceholder = template.includes("{zip}") || template.includes("{state}") || template.includes("{county}") || template.includes("{country}");
    if (!hasAnyGeoPlaceholder) {
        username = `${username}-${type}-${value}`;
    }

    // Legacy fallback for session if no specific placeholder was found
    if (!template.includes("{session}") && session) {
        username = `${username}-session-${session}`;
    }

    return username;
}

/**
 * Strict sequential proxy waterfall: ZIP → State → County → Country → Error
 *
 * Tests each level in order and returns immediately on the FIRST working proxy.
 * Levels with no template or no geo value are skipped (not counted as failures).
 * If all configured levels fail, throws an error with a clear diagnostic message.
 */
export async function getWorkingProxy(
    zip: string | null,
    state: string | null,
    county: string | null,
    country: string | null,
    baseConfig: {
        host: string;
        port: number;
        password: string;
        type: string;
    },
    zipUsernameTemplate: string | null,
    stateUsernameTemplate: string | null = null,
    countyUsernameTemplate: string | null = null,
    countryUsernameTemplate: string | null = null
): Promise<{
    primary: ProxyConfig;
    fallback: ProxyConfig | null;
    method: "zip" | "state" | "county" | "country" | "none";
}> {
    const { host, port, password, type } = baseConfig;
    const sessionId = crypto.randomBytes(4).toString("hex");

    const testedLevels: string[] = [];

    // ─── Level 1: ZIP ──────────────────────────────────────────────────────────
    if (zip && zipUsernameTemplate) {
        const cacheKey = `zip:${zip}:${zipUsernameTemplate}`;
        const zipWorks = await getCachedOrTest(cacheKey, host, port, zipUsernameTemplate, "zip", zip, sessionId, password, type);

        if (zipWorks) {
            const username = buildGeoUsername(zipUsernameTemplate, "zip", zip, sessionId);
            console.log(`[proxy-waterfall] ✓ ZIP proxy working for "${zip}" — stopping waterfall.`);
            return {
                primary: { host, port, username, password, protocol: type, label: `zip-${zip}` },
                fallback: null,
                method: "zip",
            };
        }

        testedLevels.push(`ZIP "${zip}" (failed)`);
        console.warn(`[proxy-waterfall] ✗ ZIP proxy failed for "${zip}" — trying State...`);
    }

    // ─── Level 2: State ────────────────────────────────────────────────────────
    if (state && stateUsernameTemplate) {
        const cacheKey = `state:${state}:${stateUsernameTemplate}`;
        const stateWorks = await getCachedOrTest(cacheKey, host, port, stateUsernameTemplate, "state", state, sessionId, password, type);

        if (stateWorks) {
            const username = buildGeoUsername(stateUsernameTemplate, "state", state, sessionId);
            console.log(`[proxy-waterfall] ✓ State proxy working for "${state}" — stopping waterfall.`);
            return {
                primary: { host, port, username, password, protocol: type, label: `state-${state}` },
                fallback: null,
                method: "state",
            };
        }

        testedLevels.push(`State "${state}" (failed)`);
        console.warn(`[proxy-waterfall] ✗ State proxy failed for "${state}" — trying County...`);
    }

    // ─── Level 3: County ───────────────────────────────────────────────────────
    if (county && countyUsernameTemplate) {
        const cacheKey = `county:${county}:${countyUsernameTemplate}`;
        const countyWorks = await getCachedOrTest(cacheKey, host, port, countyUsernameTemplate, "county", county, sessionId, password, type);

        if (countyWorks) {
            const username = buildGeoUsername(countyUsernameTemplate, "county", county, sessionId);
            console.log(`[proxy-waterfall] ✓ County proxy working for "${county}" — stopping waterfall.`);
            return {
                primary: { host, port, username, password, protocol: type, label: `county-${county}` },
                fallback: null,
                method: "county",
            };
        }

        testedLevels.push(`County "${county}" (failed)`);
        console.warn(`[proxy-waterfall] ✗ County proxy failed for "${county}" — trying Country...`);
    }

    // ─── Level 4: Country ──────────────────────────────────────────────────────
    if (country && countryUsernameTemplate) {
        const cacheKey = `country:${country}:${countryUsernameTemplate}`;
        const countryWorks = await getCachedOrTest(cacheKey, host, port, countryUsernameTemplate, "country", country, sessionId, password, type);

        if (countryWorks) {
            const username = buildGeoUsername(countryUsernameTemplate, "country", country, sessionId);
            console.log(`[proxy-waterfall] ✓ Country proxy working for "${country}" — stopping waterfall.`);
            return {
                primary: { host, port, username, password, protocol: type, label: `country-${country}` },
                fallback: null,
                method: "country",
            };
        }

        testedLevels.push(`Country "${country}" (failed)`);
        console.warn(`[proxy-waterfall] ✗ Country proxy failed for "${country}" — all levels exhausted.`);
    }

    // ─── All levels failed ─────────────────────────────────────────────────────
    const tested = testedLevels.length > 0 ? testedLevels.join(", ") : "No geo targets were configured";
    throw new Error(
        `Proxy waterfall exhausted — no working proxy found. Tested: ${tested}. ` +
        `Ensure your proxy provider supports the requested geo location and that username templates are correct.`
    );
}

/**
 * Check the cache first; if not cached (or expired), run a live proxy test and cache the result.
 */
async function getCachedOrTest(
    cacheKey: string,
    host: string,
    port: number,
    template: string,
    type: "zip" | "state" | "county" | "country",
    value: string,
    sessionId: string,
    password: string,
    protocol: string
): Promise<boolean> {
    const cached = proxyCache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
        console.log(`[proxy-waterfall] Cache hit for "${cacheKey}": ${cached.working}`);
        return cached.working;
    }

    const testUsername = buildGeoUsername(template, type, value, `test-${sessionId}`);
    console.log(`[proxy-waterfall] Testing ${type} proxy "${value}": ${testUsername}`);
    const works = await testProxy(host, port, testUsername, password, protocol);
    proxyCache.set(cacheKey, { working: works, expiresAt: now + CACHE_TTL });
    return works;
}

async function testProxy(host: string, port: number, user: string, pass: string, protocol: string): Promise<boolean> {
    const urls = [
        "https://api.ipify.org?format=json",
        "http://api.ipify.org?format=json"
    ];

    for (const url of urls) {
        try {
            await axios.get(url, {
                proxy: {
                    host,
                    port,
                    auth: { username: user, password: pass },
                    protocol: protocol || "http",
                },
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                },
                timeout: 15000,
            });
            console.log(`[proxy-tester] Proxy test SUCCEEDED for ${user} via ${url}`);
            return true;
        } catch (err: any) {
            console.warn(`[proxy-tester] Proxy test failed for ${user} via ${url}: ${err.message}${err.response ? ` (${err.response.status})` : ""}`);
        }
    }
    return false;
}

/** Clear the proxy cache (useful for testing) */
export function clearProxyCache() {
    proxyCache.clear();
}
