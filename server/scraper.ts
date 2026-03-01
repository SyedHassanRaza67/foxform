import axios from "axios";
import * as cheerio from "cheerio";
import type { FormField } from "@shared/schema";

interface ScrapeResult {
  fields: FormField[];
  formSelector: string | null;
  submitSelector: string | null;
}

export async function scrapeFormFields(url: string): Promise<ScrapeResult> {
  const response = await axios.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    timeout: 15000,
    maxRedirects: 5,
  });

  const $ = cheerio.load(response.data);

  // Remove invisible/hidden elements so they don't pollute field counts
  $("[style*='display:none'], [style*='display: none'], [hidden]").remove();

  const { scope, formSelector } = findBestFormScope($);

  const submitBtn = scope.find('button[type="submit"], input[type="submit"]').first()
    || $('button[type="submit"], input[type="submit"]').first();
  const submitSelector = submitBtn.length ? buildSelector($, submitBtn) : null;

  const fields = extractFields($, scope);

  return { fields, formSelector, submitSelector };
}

// ─── Scope detection ──────────────────────────────────────────────────────────

const VISIBLE_INPUTS = "input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='reset']):not([type='image']):not([type='file']), select, textarea";

function countVisibleInputs($: cheerio.CheerioAPI, el: cheerio.Cheerio<cheerio.Element>): number {
  return el.find(VISIBLE_INPUTS).length;
}

function findBestFormScope($: cheerio.CheerioAPI): {
  scope: cheerio.Cheerio<cheerio.Element>;
  formSelector: string | null;
} {
  const forms = $("form");

  if (forms.length > 0) {
    let bestForm = forms.first();
    let bestCount = countVisibleInputs($, bestForm);

    forms.each((_i, formEl) => {
      const $f = $(formEl);
      const count = countVisibleInputs($, $f);
      if (count > bestCount) {
        bestCount = count;
        bestForm = $f;
      }
    });

    // If best form has at least 1 visible field, use it
    if (bestCount >= 1) {
      return { scope: bestForm, formSelector: buildSelector($, bestForm) };
    }
  }

  // Fallback: scan for the div/section/article container with the most inputs
  const containers: Array<{ el: cheerio.Cheerio<cheerio.Element>; count: number }> = [];
  $("div, section, article, main, aside").each((_i, el) => {
    const $el = $(el);
    const count = countVisibleInputs($, $el);
    if (count >= 2) {
      containers.push({ el: $el, count });
    }
  });

  if (containers.length > 0) {
    // Pick smallest container with the highest count (most specific)
    containers.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      // Prefer the more nested element (likely more specific)
      return (b.el.find("*").length || 0) - (a.el.find("*").length || 0);
    });
    const best = containers[0].el;
    return { scope: best, formSelector: null };
  }

  // Last resort: whole body
  return { scope: $("body"), formSelector: null };
}

// ─── Field extraction ─────────────────────────────────────────────────────────

function extractFields($: cheerio.CheerioAPI, scope: cheerio.Cheerio<cheerio.Element>): FormField[] {
  const fields: FormField[] = [];
  let order = 1;
  const seenNames = new Map<string, number>();

  // Process inputs, selects, textareas in DOM order (excludes radio for grouped handling)
  scope.find("input, select, textarea").each((_i, el) => {
    const $el = $(el);
    const tag = ($el.prop("tagName")?.toLowerCase() || "input");
    const rawType = ($el.attr("type") || tag).toLowerCase();

    if (["hidden", "submit", "button", "reset", "image", "file"].includes(rawType)) return;

    // Radio buttons handled separately as groups below
    if (rawType === "radio") return;

    const rawName = $el.attr("name") || $el.attr("id") || "";
    if (!rawName) return;

    if (rawType === "checkbox") {
      const value = $el.attr("value") || "on";
      const label = getLabel($, $el) || value || rawName;
      let fieldName = rawName;

      // Deduplicate checkboxes sharing the same name (e.g. serviceType[])
      const baseName = rawName.replace(/\[\]$/, "");
      if (rawName.endsWith("[]") || seenNames.has(rawName)) {
        const suffix = value !== "on"
          ? value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
          : String(seenNames.get(rawName) ?? 0);
        fieldName = `${baseName}_${suffix}`;
      }

      seenNames.set(rawName, (seenNames.get(rawName) ?? 0) + 1);

      fields.push({
        label,
        name: fieldName,
        type: "checkbox",
        selector: getUniqueSelector($, $el),
        options: value ? [value] : undefined,
        required: $el.attr("required") !== undefined,
        order: order++,
      });
      return;
    }

    // Regular fields – skip duplicates
    if (seenNames.has(rawName)) {
      seenNames.set(rawName, (seenNames.get(rawName) ?? 0) + 1);
      return;
    }
    seenNames.set(rawName, 1);

    const label = getLabel($, $el) || rawName;
    const selector = buildSelector($, $el);
    const required = $el.attr("required") !== undefined || $el.attr("aria-required") === "true";

    const options: string[] = [];
    if (tag === "select") {
      $el.find("option").each((_j, opt) => {
        const val = $(opt).attr("value");
        if (val && val !== "") options.push(val);
      });
    }

    const fieldType = tag === "select" ? "select" : tag === "textarea" ? "textarea" : rawType;

    fields.push({
      label,
      name: rawName,
      type: fieldType,
      selector,
      options: options.length > 0 ? options : undefined,
      required,
      order: order++,
    });
  });

  // Process radio groups as single fields
  const radioGroups = new Map<string, {
    options: string[];
    optionLabels: string[];
    groupLabel: string;
    selector: string;
    required: boolean;
  }>();

  scope.find('input[type="radio"]').each((_i, el) => {
    const $el = $(el);
    const name = $el.attr("name") || "";
    if (!name) return;

    const value = $el.attr("value") || $el.attr("id") || `option_${_i}`;
    const optLabel = getLabel($, $el) || value;

    if (!radioGroups.has(name)) {
      // Try to get a group-level label from <legend>, or a heading/label preceding the fieldset
      const groupLabel = getRadioGroupLabel($, $el, name);
      radioGroups.set(name, {
        options: [],
        optionLabels: [],
        groupLabel,
        selector: `input[name="${name}"]`,
        required: $el.attr("required") !== undefined,
      });
    }

    const group = radioGroups.get(name)!;
    if (!group.options.includes(value)) {
      group.options.push(value);
      group.optionLabels.push(optLabel);
    }
  });

  for (const [name, group] of radioGroups) {
    fields.push({
      label: group.groupLabel,
      name,
      type: "radio",
      selector: group.selector,
      options: group.options.length > 0 ? group.options : undefined,
      required: group.required,
      order: order++,
    });
  }

  return fields;
}

// ─── Label detection ──────────────────────────────────────────────────────────

function getLabel($: cheerio.CheerioAPI, $el: cheerio.Cheerio<cheerio.Element>): string {
  // 1. Explicit <label for="id">
  const id = $el.attr("id");
  if (id) {
    const lbl = $(`label[for="${id}"]`).first().text().trim();
    if (lbl) return lbl;
  }

  // 2. Wrapping <label>
  const parentLabel = $el.closest("label");
  if (parentLabel.length) {
    // Clone, remove the input itself, take remaining text
    const clone = parentLabel.clone();
    clone.find("input, select, textarea").remove();
    const text = clone.text().trim();
    if (text && text.length < 120) return text;
  }

  // 3. aria-label / placeholder / title
  const ariaLabel = $el.attr("aria-label");
  if (ariaLabel) return ariaLabel;

  const placeholder = $el.attr("placeholder");
  if (placeholder) return placeholder;

  const title = $el.attr("title");
  if (title) return title;

  // 4. Previous sibling: label, span, p, div, li
  const prev = $el.prevAll("label, span, p, div, legend, h1, h2, h3, h4, h5, h6, li").first();
  if (prev.length) {
    const text = prev.text().trim();
    if (text && text.length < 100) return text;
  }

  // 5. Parent row/cell label (table-based forms)
  const cell = $el.closest("td, th");
  if (cell.length) {
    const prevCell = cell.prev("td, th");
    if (prevCell.length) {
      const text = prevCell.text().trim();
      if (text && text.length < 100) return text;
    }
  }

  // 6. Parent container text before the input (walk up 2 levels)
  const parent = $el.parent();
  if (parent.length) {
    const clone = parent.clone();
    clone.find("input, select, textarea, button").remove();
    const text = clone.text().trim();
    if (text && text.length > 0 && text.length < 80) return text;
  }

  return "";
}

function getRadioGroupLabel($: cheerio.CheerioAPI, $firstRadio: cheerio.Cheerio<cheerio.Element>, name: string): string {
  // Check fieldset > legend
  const fieldset = $firstRadio.closest("fieldset");
  if (fieldset.length) {
    const legend = fieldset.find("legend").first().text().trim();
    if (legend) return legend;
  }

  // Check aria-labelledby
  const labelledBy = $firstRadio.attr("aria-labelledby");
  if (labelledBy) {
    const labelEl = $(`#${labelledBy}`).first().text().trim();
    if (labelEl) return labelEl;
  }

  // Look for a heading or label immediately before the group's container
  const container = $firstRadio.closest("div, section, fieldset, li");
  if (container.length) {
    const prev = container.prevAll("label, span, p, h1, h2, h3, h4, h5, h6, legend, div").first();
    if (prev.length) {
      const text = prev.text().trim();
      if (text && text.length < 100) return text;
    }

    // Also check if the container itself starts with a label-like element
    const firstChild = container.children("label, span, p, strong, legend, h1, h2, h3, h4, h5, h6").first();
    if (firstChild.length) {
      const text = firstChild.text().trim();
      if (text && text.length < 100) return text;
    }
  }

  // Fall back to the name attribute
  return name.replace(/[_[\]]+/g, " ").trim();
}

// ─── Selector building ────────────────────────────────────────────────────────

function cssEscape(value: string): string {
  return value.replace(/([^\w-])/g, "\\$1");
}

function buildSelector($: cheerio.CheerioAPI, $el: cheerio.Cheerio<cheerio.Element>): string {
  const id = $el.attr("id");
  if (id) return `#${cssEscape(id)}`;

  const name = $el.attr("name");
  const tag = $el.prop("tagName")?.toLowerCase() || "input";
  if (name) return `${tag}[name="${name}"]`;

  const classes = ($el.attr("class") || "").split(/\s+/).filter((c) => c.length > 0).slice(0, 2).join(".");
  if (classes) return `${tag}.${classes}`;

  return tag;
}

function getUniqueSelector($: cheerio.CheerioAPI, $el: cheerio.Cheerio<cheerio.Element>): string {
  const id = $el.attr("id");
  if (id) return `#${id}`;

  const name = $el.attr("name");
  const value = $el.attr("value");
  const tag = $el.prop("tagName")?.toLowerCase() || "input";

  if (name && value) return `${tag}[name="${name}"][value="${value}"]`;

  if (name) {
    const sameNameEls = $(`${tag}[name="${name}"]`);
    if (sameNameEls.length <= 1) return `${tag}[name="${name}"]`;

    let elIndex = 0;
    sameNameEls.each((j, el) => {
      if (el === $el.get(0)) elIndex = j;
    });
    return `${tag}[name="${name}"]:nth-of-type(${elIndex + 1})`;
  }

  return tag;
}
