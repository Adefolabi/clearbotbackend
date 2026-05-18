/**
 * inspect-login.js — Run this standalone script against the live SSHUB login page
 * to dump the exact DOM structure of every form element.
 *
 * Usage:
 *   node inspect-login.js
 *
 * Output: inspect-output.json in the project root.
 * Paste the contents of that file into the selector-debug prompt.
 */

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  // Run headed so you can visually confirm what's on screen.
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  console.log('Navigating to login page…');
  await page.goto('https://bowenstudent.bowen.edu.ng/v2/dashboard2.php', {
    waitUntil: 'networkidle',
    timeout:   40000,
  });

  // Give JS-rendered components a moment to initialise.
  await page.waitForTimeout(2000);

  // Click "Student Login" if the portal shows a landing chooser first.
  // The full form (with campus dropdown) only appears after this click.
  const studentLoginBtn = page.locator(
    'a:has-text("Student Login"), button:has-text("Student Login"), ' +
    'a:has-text("Student Portal"), button:has-text("Student Portal")'
  ).first();
  if (await studentLoginBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
    console.log('Landing page detected — clicking Student Login…');
    await studentLoginBtn.click();
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    console.log('Full login form loaded.');
    await page.waitForTimeout(1000); // let any JS-rendered dropdowns finish
  }

  console.log('Dumping DOM evidence…');

  const evidence = await page.evaluate(() => {
    function attrs(el) {
      const out = {};
      for (const a of el.attributes) out[a.name] = a.value;
      return out;
    }
    function rect(el) {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
    }

    // ── 1. All input elements ──────────────────────────────────────────────
    const inputs = Array.from(document.querySelectorAll('input')).map(el => ({
      tag:         'input',
      type:        el.type,
      name:        el.name,
      id:          el.id,
      placeholder: el.placeholder,
      class:       el.className,
      visible:     el.offsetParent !== null,
      rect:        rect(el),
      attrs:       attrs(el),
    }));

    // ── 2. All select elements (including hidden ones, e.g. Select2 base) ─
    const selects = Array.from(document.querySelectorAll('select')).map(el => ({
      tag:     'select',
      name:    el.name,
      id:      el.id,
      class:   el.className,
      visible: el.offsetParent !== null,
      style:   el.getAttribute('style') || '',
      rect:    rect(el),
      options: Array.from(el.options).map(o => ({ value: o.value, text: o.text.trim(), selected: o.selected })),
      attrs:   attrs(el),
    }));

    // ── 3. All buttons ─────────────────────────────────────────────────────
    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]')).map(el => ({
      tag:     el.tagName.toLowerCase(),
      type:    el.type,
      text:    el.innerText?.trim() || el.value,
      id:      el.id,
      class:   el.className,
      visible: el.offsetParent !== null,
      attrs:   attrs(el),
    }));

    // ── 4. ARIA roles that might indicate custom dropdowns ─────────────────
    const ariaRoles = Array.from(document.querySelectorAll('[role="combobox"],[role="listbox"],[role="option"],[role="select"],[aria-haspopup]')).map(el => ({
      tag:     el.tagName.toLowerCase(),
      role:    el.getAttribute('role'),
      text:    el.innerText?.trim().slice(0, 80),
      id:      el.id,
      class:   el.className,
      visible: el.offsetParent !== null,
      attrs:   attrs(el),
    }));

    // ── 5. Elements whose class/id suggests a dropdown library ────────────
    // Select2 uses .select2-*, Chosen uses .chosen-*, Bootstrap uses .dropdown
    const dropdownSuspects = Array.from(
      document.querySelectorAll('[class*="select2"],[class*="chosen"],[class*="dropdown"],[class*="campus"],[id*="campus"],[name*="campus"]')
    ).map(el => ({
      tag:     el.tagName.toLowerCase(),
      id:      el.id,
      class:   el.className,
      text:    el.innerText?.trim().slice(0, 80),
      visible: el.offsetParent !== null,
      rect:    rect(el),
    }));

    // ── 6. Full outer HTML of the <form> (truncated at 4000 chars) ─────────
    const form = document.querySelector('form');
    const formHTML = form ? form.outerHTML.slice(0, 4000) : 'NO FORM ELEMENT FOUND';

    // ── 7. Page title + URL after load ────────────────────────────────────
    const meta = {
      title: document.title,
      url:   location.href,
    };

    return { meta, inputs, selects, buttons, ariaRoles, dropdownSuspects, formHTML };
  });

  const outPath = 'inspect-output.json';
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2));

  console.log('\n✅ Done. Paste the contents of inspect-output.json into the selector-debug prompt.\n');
  console.log('Quick summary:');
  console.log(`  inputs:           ${evidence.inputs.length}`);
  console.log(`  selects:          ${evidence.selects.length} (visible: ${evidence.selects.filter(s => s.visible).length})`);
  console.log(`  buttons:          ${evidence.buttons.length}`);
  console.log(`  ARIA roles found: ${evidence.ariaRoles.length}`);
  console.log(`  dropdown suspects:${evidence.dropdownSuspects.length}`);
  console.log(`\nFile written: ${outPath}`);

  await browser.close();
})();
