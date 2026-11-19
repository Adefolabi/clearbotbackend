'use strict';

// diagnose-form.js — Run with: node diagnose-form.js
// PURPOSE: Reveal every form field (including hidden inputs) and the exact
//          POST data the SSHUB portal server receives during student login.
//
// What to look for in the output:
//   "=== HIDDEN FIELDS ===" — any name containing "role", "type", "user" is the role field
//   "=== POST REQUEST ===" — confirms what data actually reaches the server
//   "=== DASHBOARD TYPE ===" — confirms whether student or parent dashboard rendered

const { chromium } = require('playwright');

// ─── UPDATE THESE ─────────────────────────────────────────────────────────────
const CREDENTIALS = {
  matricNumber: 'BU22CSC1081',  // ← replace with real matric
  password:     'YOUR_PASSWORD', // ← replace with real password
  campus:       'Iwo Campus',    // as sent by the frontend
};
// ──────────────────────────────────────────────────────────────────────────────

const PORTAL_URL = 'https://bowenstudent.bowen.edu.ng/v2/dashboard2.php';

async function diagnose() {
  console.log('🔍 Starting SSHUB login form diagnostic...\n');
  console.log('Credentials:', CREDENTIALS.matricNumber, '/ campus:', CREDENTIALS.campus);

  const browser = await chromium.launch({ headless: false, slowMo: 800 });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
               '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // ── Intercept every POST — log data with password masked ──────────────────
  page.on('request', request => {
    if (request.method() === 'POST') {
      const raw = request.postData() || '';
      const masked = raw
        .replace(/password=[^&]*/gi, 'password=***MASKED***')
        .replace(/pass=[^&]*/gi,     'pass=***MASKED***')
        .replace(/pwd=[^&]*/gi,      'pwd=***MASKED***');
      console.log('\n╔══ POST REQUEST INTERCEPTED ═══════════════════════════════╗');
      console.log('║ URL:          ', request.url());
      console.log('║ POST data:    ', masked);
      console.log('║ Content-Type: ', request.headers()['content-type'] || 'not set');
      console.log('╚═══════════════════════════════════════════════════════════╝');
    }
  });

  // ── Track every navigation ────────────────────────────────────────────────
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) {
      console.log('🔀 Navigated to:', frame.url());
    }
  });

  try {
    // ── Step 1: navigate to portal ──────────────────────────────────────────
    console.log('\n─── Step 1: Navigate to portal ───────────────────────────────');
    await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('URL:', page.url());

    // ── Step 2: click Student Login ─────────────────────────────────────────
    console.log('\n─── Step 2: Click Student Login ──────────────────────────────');
    const studentLoginBtn = page.locator(
      'a:has-text("Student Login"), button:has-text("Student Login"), ' +
      'a:has-text("Student Portal"), button:has-text("Student Portal")'
    ).first();

    const btnVisible = await studentLoginBtn.isVisible({ timeout: 8000 }).catch(() => false);
    if (btnVisible) {
      await studentLoginBtn.click();
      console.log('✅ Student Login button clicked');
    } else {
      console.log('⚠️  No Student Login button visible — may already be on login form');
    }

    // Wait for password field to confirm form loaded, then wait extra for JS
    await page.waitForSelector('input[type="password"]', { timeout: 15000 });
    await page.waitForTimeout(2000); // let any JavaScript run to inject hidden fields
    console.log('✅ Login form ready');

    // ── Step 3: read ALL form fields BEFORE touching anything ───────────────
    console.log('\n─── Step 3: All form fields (before filling) ─────────────────');
    const allFieldsBefore = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('form').forEach((form, fi) => {
        form.querySelectorAll('input, select, textarea, button').forEach(el => {
          results.push({
            form:      fi,
            tag:       el.tagName,
            type:      el.getAttribute('type') || '(none)',
            name:      el.name || '(none)',
            id:        el.id   || '(none)',
            value:     el.type === 'password' ? '***' : (el.value || ''),
            hidden:    el.type === 'hidden',
            visible:   el.offsetParent !== null,
            className: (el.className || '').slice(0, 40),
          });
        });
      });
      return results;
    });

    console.log('\n=== ALL FORM FIELDS ===');
    console.table(allFieldsBefore);

    const hiddenBefore = allFieldsBefore.filter(f => f.hidden);
    console.log('\n=== HIDDEN FIELDS ===');
    if (hiddenBefore.length === 0) {
      console.log('⚠️  No hidden fields found before filling');
    } else {
      hiddenBefore.forEach(f => {
        const isRoleField = ['role','type','user','login','usertype','user_type']
          .some(kw => f.name.toLowerCase().includes(kw));
        console.log(`  ${isRoleField ? '🎯 ROLE?' : '   '}  name="${f.name}"  value="${f.value}"  id="${f.id}"`);
      });
    }

    // ── Step 4: fill form ───────────────────────────────────────────────────
    console.log('\n─── Step 4: Fill form ────────────────────────────────────────');

    // Fill matric (text input)
    const allInputs = await page.$$('input[type="text"], input:not([type])');
    for (const input of allInputs) {
      if (await input.isVisible().catch(() => false)) {
        await input.fill(CREDENTIALS.matricNumber);
        console.log('✅ Matric filled');
        break;
      }
    }

    await page.fill('input[type="password"]', CREDENTIALS.password);
    console.log('✅ Password filled (masked in logs)');

    // Campus — try native select matching "iwo" or "Iwo"
    const selectEl = await page.$('select[name="campus"], select').catch(() => null);
    if (selectEl && await selectEl.isVisible().catch(() => false)) {
      const options = await page.$$eval(
        'select[name="campus"] option, select option',
        opts => opts.map(o => ({ value: o.value, text: o.textContent.trim() }))
      );
      console.log('Campus select options:', JSON.stringify(options));
      const match = options.find(o =>
        o.text.toLowerCase().includes('iwo') || o.value.toLowerCase().includes('iwo')
      );
      if (match) {
        await page.selectOption('select[name="campus"], select', { value: match.value });
        console.log(`✅ Campus selected: value="${match.value}" text="${match.text}"`);
      } else {
        console.log('⚠️  Could not match Iwo campus — options:', options.map(o => o.text).join(', '));
      }
    }

    // ── Step 5: read hidden fields AFTER filling ────────────────────────────
    console.log('\n─── Step 5: Hidden fields AFTER filling (may differ) ─────────');
    const hiddenAfter = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input[type="hidden"]'))
        .map(el => ({ name: el.name, value: el.value, id: el.id }))
    );
    if (hiddenAfter.length === 0) {
      console.log('⚠️  No hidden fields after filling');
    } else {
      console.log(JSON.stringify(hiddenAfter, null, 2));
    }

    // ── Step 6: submit (POST will be intercepted above) ─────────────────────
    console.log('\n─── Step 6: Submit (watch for POST above) ────────────────────');
    await page.click('button:has-text("Login")');
    await page.waitForTimeout(6000); // wait for server response and redirect

    // ── Step 7: read result ─────────────────────────────────────────────────
    console.log('\n─── Step 7: After-login result ───────────────────────────────');
    console.log('Final URL:', page.url());
    console.log('Page title:', await page.title().catch(() => ''));

    const visibleLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a'))
        .map(a => a.textContent.trim())
        .filter(t => t.length > 0 && t.length < 60)
        .slice(0, 25)
    ).catch(() => []);
    console.log('\nVisible links on page:', visibleLinks);

    const allHiddenFinal = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input[type="hidden"]'))
        .map(el => ({ name: el.name, value: el.value }))
    ).catch(() => []);
    if (allHiddenFinal.length > 0) {
      console.log('\nHidden fields on result page:', JSON.stringify(allHiddenFinal));
    }

    // ── Step 8: dashboard type ──────────────────────────────────────────────
    console.log('\n╔══ DASHBOARD TYPE ══════════════════════════════════════════╗');
    const studentMarkers = ['My Courses','Course Reg','My Result','Payment','ID Card','Profile'];
    const parentMarkers  = ['Parent Login','Student Login','Ward','Children'];

    const foundStudent = studentMarkers.filter(m =>
      visibleLinks.some(l => l.includes(m))
    );
    const foundParent = parentMarkers.filter(m =>
      visibleLinks.some(l => l.includes(m))
    );

    if (foundStudent.length > 0) {
      console.log('║ ✅ STUDENT dashboard — found:', foundStudent.join(', '));
      console.log('║ Login is working correctly. No role field fix needed.');
    } else if (foundParent.length > 0) {
      console.log('║ ❌ PARENT dashboard — found:', foundParent.join(', '));
      console.log('║ This confirms the role assignment bug.');
      console.log('║ Look at "=== HIDDEN FIELDS ===" above for the role field.');
      console.log('║ Look at "=== POST REQUEST ===" for what reached the server.');
    } else {
      console.log('║ ⚠️  UNKNOWN — could not determine dashboard type');
      console.log('║ Links found:', visibleLinks.slice(0, 10).join(', '));
    }
    console.log('╚════════════════════════════════════════════════════════════╝');

    console.log('\n⏳ Browser stays open 45s — inspect manually in DevTools\n');
    await page.waitForTimeout(45000);

  } catch (err) {
    console.error('\n❌ Diagnostic error:', err.message);
    await page.waitForTimeout(20000);
  } finally {
    await browser.close();
  }
}

diagnose().catch(console.error);
