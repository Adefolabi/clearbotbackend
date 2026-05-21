'use strict';

const { chromium } = require('playwright');
const jobManager   = require('./jobManager');
const { Run, getCurrentSemester } = require('./db');
const logger       = require('../utils/logger');

const PORTAL_URL = 'https://bowenstudent.bowen.edu.ng/v2/dashboard2.php';

const ALLOWED_DOMAINS = ['bowenstudent.bowen.edu.ng', 'bowen.edu.ng'];

function isAllowedUrl(url) {
  if (url.startsWith('about:')) return true;
  try {
    const { hostname } = new URL(url);
    return ALLOWED_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

// ─── Emit helpers ─────────────────────────────────────────────────────────────

function log(jobId, message, extra = {}) {
  const event = { type: 'log', message, timestamp: new Date().toISOString(), ...extra };
  jobManager.emit(jobId, event);
  logger.info(message, { jobId, ...extra });
}

function progress(jobId, completed, total, skipped) {
  jobManager.emit(jobId, { type: 'progress', completed, total, skipped });
}

function fatalError(jobId, message, err) {
  jobManager.emit(jobId, { type: 'error', message, fatal: true, timestamp: new Date().toISOString() });
  logger.error(message, { jobId, error: err?.message });
}

// ── Opt 4: Tiered delay configuration ─────────────────────────────────────────
//
// Delay ranges calibrated to appear human-like while maximising speed.
// Do not set betweenCourses below 300ms — below this threshold the submission
// rate may trigger rate limiting on the SSHUB portal.
// Increase these values if the portal starts rejecting submissions.
const DELAYS = {
  betweenCourses: { min: 400, max: 700 }, // between finishing one course and starting next
  afterClose:     { min: 200, max: 400 }, // after closing success popup, before next row
  phaseOneCheck:  { min: 50,  max: 150 }, // between Phase 1 status checks (no form fill)
  // betweenQuestions intentionally removed — radio fills use evaluate() so portal
  // never observes inter-question timing; delaying only adds ~2s per form for no gain.
};

function randomDelay(type) {
  const { min, max } = DELAYS[type] ?? DELAYS.betweenCourses;
  return new Promise(resolve =>
    setTimeout(resolve, Math.floor(min + Math.random() * (max - min)))
  );
}

// ─── Page assertions ──────────────────────────────────────────────────────────

async function assertIsAssessmentPage(page) {
  const url = page.url();
  if (!isAllowedUrl(url)) {
    throw new Error(
      `assertIsAssessmentPage: bot is on an unauthorized domain. ` +
      `URL: "${url}". Refusing to fill any form on this page.`
    );
  }
  const hasRadios = await page.$('input[type="radio"]').then(el => !!el).catch(() => false);
  if (!hasRadios) {
    const title = await page.title().catch(() => '');
    throw new Error(
      `assertIsAssessmentPage: no radio inputs found on this page. ` +
      `Title: "${title}", URL: "${url}". Refusing to proceed.`
    );
  }
}

async function assertIsCourseAssessmentPage(page) {
  const url = page.url();
  if (!isAllowedUrl(url)) {
    throw new Error(
      `assertIsCourseAssessmentPage: bot is on an unauthorized domain. URL: "${url}".`
    );
  }
  const hasRows = await page.$(
    'td button:has-text("Assess"), td a:has-text("Assess"), td:has-text("Assessed")'
  ).then(el => !!el).catch(() => false);
  if (!hasRows) {
    throw new Error(
      `assertIsCourseAssessmentPage: no Assess/Assessed rows found on "${url}". ` +
      'Page may not have loaded correctly.'
    );
  }
}

// ─── Campus selector — 4 strategies ──────────────────────────────────────────

async function selectCampus(page, campus, jobId) {
  const nativeSelect = await page.$('select[name="campus"], select').catch(() => null);
  if (nativeSelect) {
    const visible = await nativeSelect.isVisible().catch(() => false);
    if (visible) {
      const options = await page.$$eval(
        'select[name="campus"] option, select option',
        opts => opts
          .filter(o => o.value !== '' && o.value !== '0')
          .map(o => ({ value: o.value, text: o.textContent.trim() }))
      );
      logger.info('Campus: native <select> options found', { jobId, options });
      const campusLower = campus.toLowerCase();
      const match = options.find(o =>
        o.text.toLowerCase().includes(campusLower) ||
        campusLower.includes(o.text.toLowerCase())
      );
      if (!match) {
        throw new Error(
          `Campus "${campus}" did not match any option in the <select>. ` +
          `Available options: ${options.map(o => `"${o.text}"`).join(', ')}`
        );
      }
      logger.info('Campus: strategy 1 — native <select>', { jobId, matched: match.text });
      await page.selectOption('select[name="campus"], select', { value: match.value });
      return 'native-select';
    }
    logger.debug('Campus: native <select> exists but is hidden — trying library strategies', { jobId });
  }

  const select2Container = await page.$('.select2-container, .select2-selection').catch(() => null);
  if (select2Container && await select2Container.isVisible().catch(() => false)) {
    logger.info('Campus: strategy 2 — Select2', { jobId });
    await select2Container.click();
    await page.waitForSelector('.select2-results__option, .select2-dropdown', { timeout: 5000 });
    await page.click(`.select2-results__option:has-text("${campus}")`);
    return 'select2';
  }

  const chosenContainer = await page.$('.chosen-container').catch(() => null);
  if (chosenContainer && await chosenContainer.isVisible().catch(() => false)) {
    logger.info('Campus: strategy 3 — Chosen.js', { jobId });
    await chosenContainer.click();
    await page.waitForSelector('.chosen-results', { timeout: 5000 });
    await page.click(`.chosen-results li:has-text("${campus}")`);
    return 'chosen';
  }

  const genericTrigger = await page.$(
    '[id*="campus" i], [name*="campus" i], [class*="campus" i], [placeholder*="campus" i]'
  ).catch(() => null);
  if (genericTrigger && await genericTrigger.isVisible().catch(() => false)) {
    logger.info('Campus: strategy 4 — generic attribute match', { jobId });
    await genericTrigger.click();
    await page.waitForSelector(
      `[role="option"]:has-text("${campus}"), li:has-text("${campus}"), option:has-text("${campus}")`,
      { timeout: 5000 }
    );
    await page.click(`[role="option"]:has-text("${campus}"), li:has-text("${campus}")`);
    return 'generic-attr';
  }

  throw new Error(
    `Could not locate campus dropdown for "${campus}" with any of the 4 selector strategies. ` +
    'Run inspect-login.js and share inspect-output.json for a precise fix.'
  );
}

// ─── Matric input finder ──────────────────────────────────────────────────────

async function findMatricInput(page) {
  const specific = await page.$(
    'input[name*="matric" i], input[id*="matric" i], ' +
    'input[name*="regno" i], input[id*="regno" i], ' +
    'input[name*="reg_no" i], input[name*="username" i], input[id*="username" i]'
  ).catch(() => null);
  if (specific && await specific.isVisible().catch(() => false)) return specific;

  const inputs = await page.$$('input[type="text"], input:not([type])');
  for (const input of inputs) {
    if (await input.isVisible().catch(() => false)) return input;
  }
  throw new Error('Could not find the matric number input field on the login page.');
}

// ─── Login button clicker ─────────────────────────────────────────────────────

async function clickLoginButton(page) {
  const btnText = page.locator('button:has-text("Login"), button:has-text("Sign In"), button:has-text("Log In")').first();
  if (await btnText.isVisible({ timeout: 3000 }).catch(() => false)) {
    await btnText.click();
    return 'button:has-text(Login)';
  }
  const inputSubmit = page.locator('input[type="submit"]').first();
  if (await inputSubmit.isVisible({ timeout: 3000 }).catch(() => false)) {
    await inputSubmit.click();
    return 'input[type="submit"]';
  }
  throw new Error('Could not find a Login button on the page.');
}

// ─── Login handler ────────────────────────────────────────────────────────────

async function handleLogin(page, credentials, jobId) {
  log(jobId, '🔐 Navigating to login page…', { status: 'info' });

  // This is the only page.goto() allowed in the entire login flow.
  // All subsequent navigation must happen through clicking links on the page,
  // never through direct URL calls — direct URL navigation after login breaks
  // the PHP session by racing against server-side session propagation.
  await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const studentLoginBtn = page.locator(
    'a:has-text("Student Login"), button:has-text("Student Login"), ' +
    'a:has-text("Student Portal"), button:has-text("Student Portal")'
  ).first();

  const landingPageVisible = await studentLoginBtn.isVisible({ timeout: 5000 }).catch(() => false);
  if (landingPageVisible) {
    log(jobId, '🖱️  Clicking Student Login…', { status: 'info' });
    await studentLoginBtn.click();
    await page.waitForSelector('input[type="password"]', { timeout: 15000 });
    log(jobId, '📋 Full login form loaded', { status: 'info' });
  } else {
    await page.waitForSelector('input[type="password"]', { timeout: 15000 });
  }

  // Opt 3: domcontentloaded is sufficient — Login button's JS handler attaches
  // during DOMContentLoaded. waitForLoadState('load') added 1-2s waiting for
  // images/fonts that the bot never needs.
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => null);

  const matricInput = await findMatricInput(page);
  await matricInput.fill(credentials.matricNumber);
  await page.fill('input[type="password"]', credentials.password);

  const campusFieldExists = await page.$(
    'select, [class*="select2"], [class*="chosen"], [id*="campus" i], [name*="campus" i]'
  ).then(el => !!el).catch(() => false);

  if (campusFieldExists) {
    const strategyUsed = await selectCampus(page, credentials.campus, jobId);
    logger.info('Campus selected', { jobId, strategy: strategyUsed, campus: credentials.campus });
  } else {
    logger.info('Campus field not present — skipping (portal auto-detects from matric)', { jobId });
  }

  const btnUsed = await clickLoginButton(page);
  logger.info('Login button clicked', { jobId, selector: btnUsed });

  const DASHBOARD_SELECTOR = 'a:has-text("My Courses")';
  const ERROR_SELECTOR     = '.alert-danger, .alert-warning, .login-error, #login-error';
  const ERROR_KEYWORDS     = /invalid|incorrect|wrong|failed|denied|unauthori[sz]ed|bad credential/i;

  const outcome = await Promise.race([
    page.waitForSelector(DASHBOARD_SELECTOR, { timeout: 60000 })
      .then(() => 'success').catch(() => null),
    page.waitForSelector(ERROR_SELECTOR, { timeout: 60000 })
      .then(() => 'error-element').catch(() => null),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 65000)),
  ]);

  if (outcome === 'error-element') {
    const errorText = await page.textContent(ERROR_SELECTOR).catch(() => '');
    if (ERROR_KEYWORDS.test(errorText)) {
      return { result: 'failure', errorText: errorText.trim() };
    }
    logger.info('Alert element matched but text is non-error — treating as success', {
      jobId, text: errorText.trim().slice(0, 80),
    });
  }

  if (outcome === 'timeout' || outcome === null) {
    const stillOnLoginPage = await page.$('input[type="password"]').then(el => !!el).catch(() => false);
    if (stillOnLoginPage) {
      const pageUrl  = page.url();
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '');
      logger.warn('Login form visible after 60s', { jobId, url: pageUrl, body: bodyText });
      return {
        result: 'failure',
        errorText: `Login form still visible after 60s — portal did not process the submission. ` +
                   `Possible causes: wrong credentials, account rate-limited, or portal issue. ` +
                   `Page text: "${bodyText.slice(0, 120)}" (URL: ${pageUrl})`,
      };
    }

    const studentBtn2 = page.locator(
      'a:has-text("Student Login"), button:has-text("Student Login"), ' +
      'a:has-text("Student Portal"), button:has-text("Student Portal")'
    ).first();
    if (await studentBtn2.isVisible({ timeout: 3000 }).catch(() => false)) {
      logger.info('Role-selection page after 60s — clicking Student Login', { jobId });
      await studentBtn2.click();
      await page.waitForSelector('a:has-text("My Courses")', { timeout: 30000 });
      return { result: 'success' };
    }

    const pageUrl = page.url();
    logger.warn('Login timed out after 60s', { jobId, url: pageUrl });

    if (pageUrl.includes('index.php')) {
      // 60s elapsed without My Courses appearing in the race. Check the DOM directly —
      // no page.goto() here: a direct URL jump at this point breaks the PHP session
      // the same way it does in the success path below.
      const hasMyCoursesNow = await page.$('a:has-text("My Courses")')
        .then(el => !!el).catch(() => false);
      if (hasMyCoursesNow) {
        logger.info('My Courses found at index.php after 60s timeout — proceeding', { jobId });
        return { result: 'success' };
      }
      const isRolePage = await page.$(
        'a:has-text("Student Login"), button:has-text("Student Login")'
      ).then(el => !!el).catch(() => false);
      if (isRolePage) {
        logger.info('Role-selection page after 60s timeout — parent session', { jobId, url: pageUrl });
        return { result: 'parent-session' };
      }
      return {
        result: 'failure',
        errorText: `Login timed out — stuck at index.php without My Courses after 60s. URL: ${pageUrl}`,
      };
    }

    return { result: 'failure', errorText: `Could not reach student dashboard (url: ${pageUrl})` };
  }

  // Login succeeded — the portal session is valid on whatever page we're on now.
  // Do NOT navigate to dashboard2.php. A direct URL call here races against PHP
  // session propagation and causes a redirect to parent-login.php.
  // discoverCourses will click My Courses naturally from the current page.
  const currentUrl = page.url();
  if (currentUrl.includes('index.php')) {
    logger.info('Login succeeded — staying at index.php, session intact', { jobId, url: currentUrl });
  }

  return { result: 'success' };
}

async function handleRoleSelectionPage(page, jobId) {
  logger.info('Role-selection page in discoverCourses — navigating to student portal', { jobId });
  await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

  const studentBtn = page.locator(
    'a:has-text("Student Login"), button:has-text("Student Login"), ' +
    'a:has-text("Student Portal"), button:has-text("Student Portal")'
  ).first();

  if (await studentBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
    await studentBtn.click();
    const myCourses = await page.waitForSelector('a:has-text("My Courses")', { timeout: 20000 }).catch(() => null);
    if (myCourses) return { result: 'success' };
  }

  const visibleLinks = await page.$$eval('a',
    els => els.filter(a => a.offsetParent !== null).map(a => a.innerText.trim()).filter(Boolean)
  ).catch(() => []);

  return {
    result: 'failure',
    errorText: `Could not reach student dashboard from discoverCourses. URL: ${page.url()} Links: ${visibleLinks.slice(0, 8).join(', ')}`,
  };
}

// ─── Dashboard modal dismissal ────────────────────────────────────────────────

async function dismissDashboardModal(page, jobId) {
  // Opt 3: page.$() queries the DOM once instantly — if the element is absent it
  // returns null in < 1ms. The previous waitForSelector polled for up to 4 seconds
  // on every single course navigation, costing 4s × course_count per run.
  const MODAL_SEL = '.modal.show, .modal.fade.show, .modal.in, [role="dialog"]';
  const modalEl      = await page.$(MODAL_SEL).catch(() => null);
  const modalVisible = modalEl ? await modalEl.isVisible().catch(() => false) : false;

  if (!modalVisible) return;

  const modalText = await page.textContent(MODAL_SEL).catch(() => '');
  logger.info('Dashboard modal detected', { jobId, text: modalText.trim().slice(0, 80) });
  log(jobId, '🪟 Dashboard modal detected — closing…', { status: 'info' });

  const CLOSE_CANDIDATES = [
    'button:has-text("Close")',
    'button:has-text("Dismiss")',
    'button:has-text("Skip")',
    'button:has-text("Cancel")',
    '[data-dismiss="modal"]',
    '[data-bs-dismiss="modal"]',
    'button[aria-label="Close"]',
    '.modal .close',
    '.btn-close',
  ];

  let closed = false;
  for (const sel of CLOSE_CANDIDATES) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await btn.click();
      closed = true;
      logger.info('Modal closed', { jobId, selector: sel });
      break;
    }
  }

  if (!closed) {
    // hallModal uses data-keyboard="false" — Escape is disabled. Force-click any button.
    const anyModalBtn = page.locator(
      '#hallModal button, .modal.show button, [role="dialog"] button'
    ).first();
    if (await anyModalBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await anyModalBtn.click({ force: true });
      closed = true;
      logger.warn('Fallback: force-clicked first button inside modal', { jobId });
    } else {
      await page.keyboard.press('Escape');
      logger.warn('Modal close button not found — pressed Escape', { jobId });
    }
  }

  await page.waitForSelector(MODAL_SEL, { state: 'hidden', timeout: 5000 }).catch(() => null);
}

// ─── Course discovery ─────────────────────────────────────────────────────────

async function discoverCourses(page, jobId) {
  log(jobId, '📋 Discovering registered courses…', { status: 'info' });

  await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
  await dismissDashboardModal(page, jobId);

  const MY_COURSES_CANDIDATES = [
    'a:has-text("My Courses")',
    'a:has-text("My Course")',
    'a:has-text("Courses")',
    'a:has-text("Course")',
    'a:has-text("Registered Courses")',
    'a:has-text("My Registered Courses")',
    ':has-text("My Courses")',
    ':has-text("Courses")',
  ];

  let clicked = false;
  for (const sel of MY_COURSES_CANDIDATES) {
    const el = page.locator(sel).first();
    const visible = await el.isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) {
      await el.click();
      logger.info('My Courses link clicked', { jobId, selector: sel });
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    const visibleLinks = await page.$$eval('a', els =>
      els.filter(a => a.offsetParent !== null && a.innerText.trim().length > 0)
         .map(a => a.innerText.trim())
    );

    const onRoleSelectionPage =
      visibleLinks.includes('Parent Login') || visibleLinks.includes('Student Login');

    if (onRoleSelectionPage) {
      logger.info('Role/parent-selection page detected in discoverCourses — recovering via root domain', { jobId });
      const rootUrl = new URL(PORTAL_URL).origin;
      await page.goto(rootUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

      const studentBtn = page.locator(
        'a:has-text("Student Login"), button:has-text("Student Login"), ' +
        'a:has-text("Student Portal"), button:has-text("Student Portal")'
      ).first();
      if (await studentBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
        await studentBtn.click();
        await page.waitForSelector('a:has-text("My Courses")', { timeout: 25000 });
        await page.locator('a:has-text("My Courses")').first().click({ timeout: 8000 });
      } else {
        throw new Error(
          'Could not find Student Login on root domain after session redirect. ' +
          `URL: ${page.url()} — Visible links: ${visibleLinks.slice(0, 10).join(' | ')}`
        );
      }
    } else {
      throw new Error(
        'Could not find the My Courses sidebar link. ' +
        `Visible links on dashboard: ${visibleLinks.slice(0, 30).join(' | ')}`
      );
    }
  }

  await page.waitForFunction(
    () => {
      const all = document.querySelectorAll('a');
      return Array.from(all).some(a => /^[A-Z]{2,4}\s\d{3,4}$/.test(a.innerText.trim()));
    },
    { timeout: 10000 }
  );

  // ── Opt 1: Walk the sidebar DOM to tag each course with its semester ──────────
  // The portal groups courses under "1ST SEMESTER" / "2ND SEMESTER" headings inside
  // the expanded collapse container. We detect these headings as we walk down the
  // element list so each course link gets a semester tag. If no headings are found
  // (portal structure changed) every course gets semester: null and the fallback
  // below processes all of them rather than zero.
  const tagged = await page.evaluate(() => {
    const results  = [];
    let currentSem = null;
    const COURSE_RE = /^[A-Z]{2,4}\s\d{3,4}$/;

    const container =
      document.querySelector('.collapse.show')                       ||
      document.querySelector('[class*="collapse"][class*="show"]')   ||
      document.querySelector('#collapseTwo')                         ||
      document;

    for (const el of container.querySelectorAll('h6, [class*="header"], a')) {
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (/1.?st\s*semester/i.test(text)) {
        currentSem = '1st';
      } else if (/2.?nd\s*semester/i.test(text)) {
        currentSem = '2nd';
      } else if (el.tagName === 'A' && COURSE_RE.test(text)) {
        results.push({ code: text, semester: currentSem });
      }
    }
    return results;
  });

  // Deduplicate by code — sidebar may list the same course twice.
  const seen      = new Set();
  const allCourses = tagged.filter(c => {
    if (seen.has(c.code)) return false;
    seen.add(c.code);
    return true;
  });

  // ── Opt 1: Filter to the active semester ─────────────────────────────────────
  // getCurrentSemester() returns e.g. "2025_2026_2nd" — take the last segment.
  const semLabel    = getCurrentSemester().split('_').pop(); // '1st' or '2nd'
  const taggedCount = allCourses.filter(c => c.semester !== null).length;

  if (taggedCount === 0 && allCourses.length > 0) {
    // No semester headings found — process everything rather than nothing.
    logger.warn('Semester DOM tagging found no headings — processing all courses as fallback', { jobId });
    return allCourses;
  }

  const filtered    = allCourses.filter(c => c.semester === null || c.semester === semLabel);
  const filteredOut = allCourses.length - filtered.length;

  if (filteredOut > 0) {
    log(jobId,
      `📋 Found ${filtered.length} course(s) for ${semLabel} semester — ` +
      `${filteredOut} from the other semester skipped`,
      { status: 'info' }
    );
  }

  return filtered;
}

// ─── Batch status pre-check (Opt 2) ──────────────────────────────────────────

/**
 * Attempts to read assessment status for all courses from the current page
 * without navigating to each course individually.
 *
 * Returns Map<courseCode, 'pending'|'done'> if the dashboard exposes status,
 * or null if per-course navigation is required (falls back to inline two-phase).
 *
 * SSHUB only shows course codes in the sidebar — status requires visiting
 * assessment.php per course. Always returns null for SSHUB. The function exists
 * so a future status endpoint or summary page only requires changing this one function.
 */
async function tryBatchStatusCheck(page) {
  return null;
}

// ─── Course navigation ────────────────────────────────────────────────────────

async function navigateToCourse(page, context, courseCode, jobId) {
  const MY_COURSES_LINK = 'a:has-text("My Courses"), a:has-text("Courses")';

  const sidebarPresent = await page.locator(MY_COURSES_LINK).first()
    .isVisible({ timeout: 3000 }).catch(() => false);

  if (!sidebarPresent) {
    // Mid-run recovery: sidebar disappeared (e.g. a new tab was closed and focus
    // returned to an intermediate page). The PHP session is fully established at
    // this point so navigating back to dashboard2.php is safe.
    logger.info('Sidebar not visible — returning to dashboard', { jobId, courseCode });
    await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
  }

  // Opt 3: instant modal check — page.$() returns null immediately if absent.
  await dismissDashboardModal(page, jobId);

  await page.locator(MY_COURSES_LINK).first().click({ timeout: 8000 });

  const courseLink = page.locator('a').filter({ hasText: new RegExp(`^${courseCode}$`) }).first();
  await courseLink.waitFor({ state: 'visible', timeout: 8000 });
  // force:true dispatches the click event directly to the element, bypassing Playwright's
  // pointer-event interception check. Without this, overlapping sidebar nav links (e.g.
  // payment.php) or the My Courses collapse toggle can intercept the click, causing the
  // sidebar to collapse and the course link to become invisible — a 30s timeout.
  await courseLink.click({ force: true });

  await page.waitForLoadState('domcontentloaded', { timeout: 15000 });

  const pageBodySnippet = await page.evaluate(
    () => document.body?.innerText?.slice(0, 300) ?? ''
  ).catch(() => '');
  if (/cloudflare/i.test(pageBodySnippet)) {
    // Mid-run Cloudflare block: reset to dashboard before the caller throws.
    // Session is established; this goto is safe.
    await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
    throw new Error(
      `Cloudflare blocked the course page for ${courseCode}. ` +
      'The portal may require a CAPTCHA or the IP is rate-limited. ' +
      'Try again in a few minutes.'
    );
  }

  const ASSESSMENT_TAB_CANDIDATES = [
    '.nav-tabs a:has-text("Assessment")',
    '[role="tab"]:has-text("Assessment")',
    '.nav a:has-text("Assessment")',
    'li.nav-item a:has-text("Assessment")',
    'ul.nav a:has-text("Assessment")',
    'a:has-text("Assessment")',
    'button:has-text("Assessment")',
  ];

  let assessmentSel = null;
  for (const sel of ASSESSMENT_TAB_CANDIDATES) {
    if (await page.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false)) {
      assessmentSel = sel;
      break;
    }
  }

  if (!assessmentSel) {
    const visibleLinks = await page.$$eval('a', els =>
      els.filter(a => a.offsetParent !== null).map(a => a.innerText.trim()).filter(Boolean)
    );
    throw new Error(
      `Assessment tab not found for ${courseCode}. ` +
      `Visible links: ${visibleLinks.slice(0, 20).join(' | ')}`
    );
  }

  // Opt 5: Promise.all starts the page-event listener and the click simultaneously.
  // If no new tab opens within 12s, .catch(() => null) resolves with null and we
  // fall back to using the current page — no unhandled rejection.
  const [newTabPage] = await Promise.all([
    context.waitForEvent('page', { timeout: 12000 }).catch(() => null),
    page.click(assessmentSel),
  ]);

  logger.info('Assessment link clicked', { jobId, courseCode, selector: assessmentSel });

  let assessmentPage;
  let isNewTab = false;

  if (newTabPage) {
    assessmentPage = newTabPage;
    isNewTab = true;
    logger.info('Assessment list opened in new tab', { jobId, courseCode, url: assessmentPage.url() });
    // Opt 3 + 5: wait for the rows we need — skip waitForLoadState entirely.
    await assessmentPage.waitForSelector(
      'td button:has-text("Assess"), td a:has-text("Assess"), td:has-text("Assessed")',
      { timeout: 35000 }
    );
  } else {
    logger.info('No new tab from Assessment link — using current page', { jobId, courseCode });
    assessmentPage = page;
    await assessmentPage.waitForSelector(
      'td button:has-text("Assess"), td a:has-text("Assess"), td:has-text("Assessed")',
      { timeout: 20000 }
    ).catch(() => null);
  }

  return { assessmentPage, isNewTab };
}

// ─── Core Bot ─────────────────────────────────────────────────────────────────

async function runAssessmentBot(jobId, credentials, ratings, dryRun = false) {
  const matricForLock = credentials.matricNumber;

  let browser     = null;
  let jobTimedOut = false;

  let completed        = 0;
  let skipped          = 0;
  let failed           = 0;
  let consecutiveFails = 0;

  jobManager.setJobCredentials(jobId, credentials);
  jobManager.setJobStatus(jobId, 'running');

  // Each assessment row takes ~25-30s of portal processing time (not reducible).
  // A student with 10 pending courses × 3 lecturers × 30s = 15 minutes of form time
  // plus ~2 minutes of navigation = 17 minutes worst case. 20 minutes covers this.
  const JOB_TIMEOUT_MS = 20 * 60 * 1000;
  const jobTimeout = setTimeout(async () => {
    jobTimedOut = true;
    logger.error('Job timeout — killing browser after 20 minutes', { jobId });
    fatalError(jobId,
      '❌ Job timed out after 20 minutes. The portal may be unresponsive — please try again later.'
    );
    jobManager.unlockMatric(matricForLock);
    if (browser) await browser.close().catch(() => null);
    jobManager.setJobStatus(jobId, 'error');
  }, JOB_TIMEOUT_MS);

  try {
    log(jobId, '🚀 Launching browser…', { status: 'info' });
    if (dryRun) log(jobId, '🔍 DRY RUN mode — no forms will be submitted', { status: 'info' });

    browser = await chromium.launch({ headless: true });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport:  { width: 1280, height: 800 },
    });

    const BLOCKED_PATTERNS =
      /analytics|ads\.|tracker|facebook\.com|google-analytics\.com|hotjar|gtm\.js|clarity\.ms/i;

    await context.route('**/*', (route) => {
      if (BLOCKED_PATTERNS.test(route.request().url())) {
        route.abort();
        return;
      }
      route.continue();
    });

    const setupUrlWhitelist = (pg) => {
      pg.on('framenavigated', async (frame) => {
        if (frame.parentFrame() !== null) return;
        const url = frame.url();
        if (isAllowedUrl(url)) return;
        logger.error('URL whitelist violation — killing job immediately', { jobId, url });
        fatalError(jobId,
          `❌ Security: bot navigated to an unauthorized domain and was stopped. URL: ${url}`
        );
        jobManager.setJobStatus(jobId, 'error');
        if (browser) await browser.close().catch(() => null);
      });
    };

    context.on('page', setupUrlWhitelist);
    const page = await context.newPage();
    setupUrlWhitelist(page);

    // ── Login ───────────────────────────────────────────────────────────────
    let loginOutcome = await handleLogin(page, credentials, jobId);

    if (loginOutcome.result === 'parent-session') {
      log(jobId, '🔄 Parent session detected — clearing cookies and retrying login…', { status: 'info' });
      await context.clearCookies();
      loginOutcome = await handleLogin(page, credentials, jobId);
    }

    if (loginOutcome.result === 'failure' || loginOutcome.result === 'parent-session') {
      fatalError(jobId, `❌ Login failed: ${loginOutcome.errorText ?? 'Portal kept redirecting to parent session after retry.'}`);
      return;
    }

    log(jobId, '✅ Login successful', { status: 'success' });

    // ── Course discovery (Opt 1 semester filter runs inside) ────────────────
    const courses = await discoverCourses(page, jobId);

    if (courses.length === 0) {
      fatalError(jobId, '❌ No courses found — sidebar structure may have changed, or account has no registered courses.');
      return;
    }

    log(jobId, `📋 Found ${courses.length} course(s) to process`, { status: 'info', count: courses.length });

    // ── Opt 2: Attempt batch status pre-check ───────────────────────────────
    // tryBatchStatusCheck returns null for SSHUB (status not in sidebar DOM).
    // When null, the main loop uses the inline two-phase pattern: navigate to the
    // course, read status immediately, skip or fill forms on the already-open page.
    const batchStatus = await tryBatchStatusCheck(page);

    if (batchStatus !== null) {
      // Future: batch check returned a map — pre-populate skipped count.
      for (const [code, status] of batchStatus) {
        if (status === 'done') {
          const course = courses.find(c => c.code === code);
          if (course) {
            log(jobId, `⏭️  ${code} — already assessed, skipping`, { status: 'skipped', courseCode: code });
            skipped++;
          }
        }
      }
    }

    progress(jobId, 0, courses.length, skipped);

    const ASSESS_SELECTOR      = 'td button:has-text("Assess"), td a:has-text("Assess")';
    // Courses that fail during the navigation phase (before forms are reached) are
    // queued here and retried once after all other courses finish. This covers both
    // Cloudflare transient blocks and click-interception timeouts like MAS 499.
    // Courses that fail during form submission (validation errors) are NOT queued —
    // they are marked failed immediately since a retry won't change the outcome.
    const retryQueue = [];
    let   inRetryPass = false;

    // ── processCourse — inner closure ──────────────────────────────────────────
    // Defined inside runAssessmentBot so it directly reads/writes the outer variables
    // (completed, skipped, failed, consecutiveFails, page, context, jobId, etc.)
    // without needing to pass them as parameters.
    //
    // Retry behaviour:
    //   Main pass  (inRetryPass=false): navigation/structural error → push to retryQueue.
    //   Retry pass (inRetryPass=true):  same error → mark as failed (no re-queuing).
    async function processCourse(course) {
      let assessmentPage     = null;
      let assessmentIsNewTab = false;

      try {
        let navResult;
        try {
          navResult = await navigateToCourse(page, context, course.code, jobId);
        } catch (navErr) {
          if (/cloudflare/i.test(navErr.message) && !inRetryPass) {
            log(jobId,
              `☁️  ${course.code} — Cloudflare blocked, queued for end-of-run retry`,
              { status: 'info', courseCode: course.code }
            );
            retryQueue.push(course);
            consecutiveFails = 0;
            return;
          }
          throw navErr;
        }
        assessmentPage     = navResult.assessmentPage;
        assessmentIsNewTab = navResult.isNewTab;

        await assertIsCourseAssessmentPage(assessmentPage);

        const firstAssessBtn = assessmentPage.locator(ASSESS_SELECTOR).first();
        const hasPending     = await firstAssessBtn.isVisible({ timeout: 5000 }).catch(() => false);

        if (!hasPending) {
          log(jobId, `⏭️  ${course.code} — already assessed, skipping`, {
            status: 'skipped', courseCode: course.code,
          });
          skipped++;
          consecutiveFails = 0;
          progress(jobId, completed, courses.length, skipped);
          await randomDelay('phaseOneCheck');
          return;
        }

        // ── Process each pending lecturer row ─────────────────────────────────
        while (true) {
          const assessBtn    = assessmentPage.locator(ASSESS_SELECTOR).first();
          const stillVisible = await assessBtn.isVisible({ timeout: 5000 }).catch(() => false);
          if (!stillVisible) break;

          // Opt 5: parallel capture — listener and click start simultaneously.
          const [newFormPage] = await Promise.all([
            context.waitForEvent('page', { timeout: 12000 }).catch(() => null),
            assessBtn.click({ force: true }),
          ]);

          let assessPage;
          let isFormNewTab = false;

          if (newFormPage) {
            assessPage   = newFormPage;
            isFormNewTab = true;
            logger.info('Assessment form opened in new tab', { jobId, courseCode: course.code });
            await assessPage.waitForSelector(
              'button:has-text("Next"), input[value="Next"], a:has-text("Next"), input[type="radio"]',
              { timeout: 20000 }
            ).catch(() => null);
          } else {
            assessPage = assessmentPage;
            logger.info('No new tab — form on same page', { jobId, courseCode: course.code });
            await assessPage.waitForSelector(
              'button:has-text("Next"), input[value="Next"], a:has-text("Next"), input[type="radio"]',
              { timeout: 20000 }
            ).catch(() => null);
          }

          try {
            // ── Probe for instructions screen ─────────────────────────────
            const formContainer = assessPage.locator('form, [class*="assess"], main, #content').first();
            const nextBtn = formContainer
              .locator('button:has-text("Next"), input[value="Next"], a:has-text("Next")')
              .first();
            const hasNextBtn = await nextBtn.waitFor({ state: 'attached', timeout: 3000 })
              .then(() => true).catch(() => false);
            if (hasNextBtn) await nextBtn.click();

            // ── Wait for radio buttons ────────────────────────────────────
            const assessForm = assessPage.locator('form').first();
            await assessForm.locator('input[type="radio"]').first()
              .waitFor({ state: 'attached', timeout: 10000 });

            await assertIsAssessmentPage(assessPage);

            // ── Answer all questions ──────────────────────────────────────
            const targetRating = (
              ratings.perCourseRatings?.[course.code] ?? ratings.defaultRating
            ).toString();

            const groupNames = await assessPage.evaluate(() => {
              const form   = document.querySelector('form') || document;
              const inputs = Array.from(form.querySelectorAll('input[type="radio"]'));
              return [...new Set(inputs.map(i => i.name))].filter(Boolean);
            });

            for (const groupName of groupNames) {
              const selected = await assessPage.evaluate(([name, value]) => {
                const form  = document.querySelector('form') || document;
                const radio = form.querySelector(
                  `input[type="radio"][name="${name}"][value="${value}"]`
                );
                if (!radio) return false;
                radio.checked = true;
                radio.click();
                radio.dispatchEvent(new Event('change', { bubbles: true }));
                radio.dispatchEvent(new Event('input',  { bubbles: true }));
                return true;
              }, [groupName, targetRating]);

              if (!selected) {
                logger.warn('Radio option not found for group', { jobId, group: groupName, targetRating });
              }
            }

            // ── Fill required final comment ───────────────────────────────
            await assessPage.evaluate(() => {
              const form = document.querySelector('form') || document;
              form.querySelectorAll('textarea').forEach(ta => {
                if (!ta.value.trim()) {
                  ta.value = 'Satisfactory';
                  ta.dispatchEvent(new Event('input',  { bubbles: true }));
                  ta.dispatchEvent(new Event('change', { bubbles: true }));
                }
              });
            });

            // ── Submit (gated by dryRun) ──────────────────────────────────
            if (!dryRun) {
              let dialogMessage = '';
              const dialogHandler = async (dialog) => {
                dialogMessage = dialog.message();
                logger.info('Assessment form dialog', { jobId, message: dialogMessage });
                await dialog.accept();
              };
              assessPage.on('dialog', dialogHandler);

              const submitClicked = await assessPage.evaluate(() => {
                const form = document.querySelector('form') || document;
                const btn  =
                  form.querySelector('button[name="submitassessment"]') ||
                  Array.from(form.querySelectorAll('button, input[type="submit"]'))
                    .find(el => (el.textContent || el.value || '').trim().toLowerCase() === 'submit');
                if (btn) { btn.click(); return true; }
                return false;
              });

              if (!submitClicked) {
                throw new Error('Submit button not found in DOM after answering all questions.');
              }

              const successSignal = await Promise.race([
                assessPage.waitForSelector(':text("Successful")',    { timeout: 8000 }).then(() => 'dom').catch(() => null),
                assessPage.waitForSelector('[role="dialog"]',         { timeout: 8000 }).then(() => 'modal').catch(() => null),
                assessPage.waitForSelector('.modal.show, .modal.in', { timeout: 8000 }).then(() => 'modal').catch(() => null),
                assessPage.waitForSelector('.alert-success',          { timeout: 8000 }).then(() => 'dom').catch(() => null),
                new Promise(resolve => setTimeout(() => resolve('timeout'), 8500)),
              ]);

              assessPage.off('dialog', dialogHandler);

              if (successSignal === 'dom' || successSignal === 'modal') {
                const successDialog = assessPage.locator(
                  '[role="dialog"].show, .modal.show, .modal.in, [role="dialog"]'
                ).first();
                if (await successDialog.isVisible({ timeout: 1000 }).catch(() => false)) {
                  await successDialog
                    .locator('button:has-text("Close"), button:has-text("OK"), [data-dismiss="modal"], [data-bs-dismiss="modal"]')
                    .first().click({ force: true }).catch(() => null);
                } else {
                  await assessPage.click(
                    'button:has-text("Close"), button:has-text("OK"), [data-dismiss="modal"], [data-bs-dismiss="modal"]'
                  ).catch(() => null);
                }
                await assessPage.waitForSelector(
                  ':is([role="dialog"], .modal.show, .modal.in)',
                  { state: 'hidden', timeout: 5000 }
                ).catch(() => null);
                await randomDelay('afterClose');
              } else if (dialogMessage) {
                if (/error|incomplete|invalid/i.test(dialogMessage)) {
                  throw new Error(`Form validation error: ${dialogMessage}`);
                }
                logger.info('Success confirmed via dialog', { jobId, dialog: dialogMessage });
              } else {
                logger.warn('No success signal detected after submit — proceeding', { jobId, courseCode: course.code });
              }

            } else {
              log(jobId,
                `🔍 DRY RUN — Would submit ${course.code} with rating ${targetRating} — skipped`,
                { status: 'info', courseCode: course.code, dryRun: true }
              );
            }

          } finally {
            if (isFormNewTab && assessPage) {
              await assessPage.close().catch(() => null);
            }
          }

          log(jobId, `✅ ${course.code} — one assessment row complete`, {
            status: 'complete', courseCode: course.code,
          });

          if (dryRun) break;

          await randomDelay('betweenCourses');
        }

        completed++;
        consecutiveFails = 0;
        progress(jobId, completed, courses.length, skipped);
        log(jobId, `✅ ${course.code} — all assessments done`, {
          status: 'complete', courseCode: course.code,
        });

      } catch (courseErr) {
        // Form validation errors (the portal said the form was incomplete/invalid) are
        // definitive — retrying with the same inputs won't help, so mark as failed now.
        // Everything else (click timeouts, nav timeouts, assertion failures, etc.) is a
        // transient navigation issue: queue for retry and don't count as a failure yet.
        const isFormError = /form validation error|submit button not found/i.test(courseErr.message);

        if (!inRetryPass && !isFormError) {
          retryQueue.push(course);
          consecutiveFails = 0; // navigation failures don't count toward the 5-fail abort
          log(jobId,
            `⏳ ${course.code} — navigation error, queued for end-of-run retry`,
            { status: 'info', courseCode: course.code }
          );
          logger.warn('Course queued for retry', { jobId, course: course.code, error: courseErr.message });
        } else {
          failed++;
          consecutiveFails++;
          log(jobId, `⚠️  ${course.code} — error: ${courseErr.message}`, {
            status: 'failed', courseCode: course.code,
          });
          logger.error('Course assessment failed', {
            jobId, course: course.code, error: courseErr.message,
          });
          progress(jobId, completed, courses.length, skipped);
        }
      } finally {
        if (assessmentIsNewTab && assessmentPage) {
          await assessmentPage.close().catch(() => null);
        }
      }
    }

    // ── Main pass ──────────────────────────────────────────────────────────────
    for (const course of courses) {
      if (batchStatus !== null && batchStatus.get(course.code) === 'done') continue;
      if (consecutiveFails >= 5) {
        fatalError(jobId, '❌ 5 consecutive failures — aborting. Check the portal manually.');
        break;
      }
      await processCourse(course);
      await randomDelay('betweenCourses');
    }

    // ── Retry pass ─────────────────────────────────────────────────────────────
    // Courses that failed due to transient navigation errors (Cloudflare blocks,
    // click interceptions, page timeouts) are retried once here after all other
    // courses are done. A 10-second pause lets any rate limits clear before retrying.
    // inRetryPass=true prevents re-queuing: a second failure marks the course as failed.
    if (retryQueue.length > 0) {
      log(jobId,
        `🔄 All other courses done — retrying ${retryQueue.length} course(s) that had navigation errors (10s pause)…`,
        { status: 'info' }
      );
      await new Promise(resolve => setTimeout(resolve, 10000));
      inRetryPass      = true;
      consecutiveFails = 0;

      for (const course of retryQueue) {
        if (consecutiveFails >= 5) {
          fatalError(jobId, '❌ 5 consecutive failures in retry pass — aborting.');
          break;
        }
        await processCourse(course);
        await randomDelay('betweenCourses');
      }
    }

    // ── Completion ──────────────────────────────────────────────────────────
    const summary = { completed, skipped, failed, dryRun };

    jobManager.emit(jobId, { type: 'complete', summary, timestamp: new Date().toISOString() });

    if (dryRun) {
      log(jobId,
        '🔍 DRY RUN complete — no forms were submitted. Run again without dryRun: true to submit for real.',
        { status: 'info', dryRun: true }
      );
    } else {
      log(jobId, `🎉 All done — ${completed} completed, ${skipped} skipped, ${failed} failed`,
        { status: 'info' }
      );
    }

    if (!dryRun) {
      try {
        await Run.findOneAndUpdate({ jobId }, { runCompleted: true, completedAt: new Date(), summary });
      } catch (dbErr) {
        logger.warn('Failed to update Run record on completion', { jobId, error: dbErr.message });
      }
    }

  } catch (outerErr) {
    if (!jobTimedOut) {
      fatalError(jobId, `❌ Unexpected error: ${outerErr.message}`, outerErr);
      jobManager.setJobStatus(jobId, 'error');
    }

  } finally {
    clearTimeout(jobTimeout);

    if (credentials) {
      if (typeof credentials.password === 'string') {
        credentials.password = '0'.repeat(credentials.password.length);
      }
      if (typeof credentials.matricNumber === 'string') {
        credentials.matricNumber = '0'.repeat(credentials.matricNumber.length);
      }
      credentials.password     = null;
      credentials.matricNumber = null;
    }
    jobManager.clearJobCredentials(jobId);
    jobManager.unlockMatric(matricForLock);

    if (browser) {
      await browser.close().catch(err =>
        logger.warn('Error closing browser during cleanup', { jobId, error: err.message })
      );
    }
    jobManager.setJobStatus(jobId, 'done');
    logger.info('Bot run finished — browser closed, credentials cleared', { jobId });
  }
}

module.exports = { runAssessmentBot };
