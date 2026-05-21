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
const DELAYS = {
  betweenCourses: { min: 400, max: 700 },
  afterClose:     { min: 200, max: 400 },
  phaseOneCheck:  { min: 50,  max: 150 },
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
    'Run diagnose-form.js and inspect the form output for a precise fix.'
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
  // All subsequent navigation must happen through clicking links on the page.
  // Direct URL navigation after login breaks the PHP session by racing against
  // server-side session propagation.
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

  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => null);

  // ── Fix 1: read and log all hidden fields immediately after form loads ────────
  // Hidden fields control server-side behaviour including role assignment.
  // This creates a permanent record in every production log run.
  // Look for this line in logs to diagnose role assignment problems.
  const hiddenFields = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input[type="hidden"]'))
      .map(el => ({ name: el.name || '(none)', value: el.value || '', id: el.id || '' }))
  );
  logger.info('Login form hidden fields', { jobId, count: hiddenFields.length, fields: hiddenFields });

  const ROLE_KEYWORDS = ['role', 'user_type', 'login_type', 'type', 'usertype'];
  const roleFields = hiddenFields.filter(f =>
    ROLE_KEYWORDS.some(kw => f.name.toLowerCase().includes(kw))
  );
  if (roleFields.length > 0) {
    logger.info('Role-related hidden fields found', { jobId, roleFields });
  } else {
    logger.info('No role-related hidden fields detected in login form', { jobId });
  }
  // ── End Fix 1 ─────────────────────────────────────────────────────────────────

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

  // ── Fix 2: intercept the login POST to log what the server actually receives ──
  // Password is always masked — raw credentials are never written to logs.
  // Look for "Login POST data sent to portal" in server logs to see role field presence.
  // Interceptor is removed immediately after the outcome race resolves.
  const loginPostHandler = request => {
    if (
      request.method() === 'POST' &&
      request.url().includes('bowenstudent.bowen.edu.ng')
    ) {
      const raw    = request.postData() || '';
      const masked = raw
        .replace(/password=[^&]*/gi, 'password=***')
        .replace(/pass=[^&]*/gi,     'pass=***')
        .replace(/pwd=[^&]*/gi,      'pwd=***');
      logger.info('Login POST data sent to portal', { jobId, data: masked });
    }
  };
  page.on('request', loginPostHandler);
  // ── End Fix 2 setup ───────────────────────────────────────────────────────────

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

  // ── Fix 2: remove POST interceptor — login request already captured ───────────
  page.off('request', loginPostHandler);
  // ── End Fix 2 teardown ────────────────────────────────────────────────────────

  if (outcome === 'error-element') {
    const errorText = await page.textContent(ERROR_SELECTOR).catch(() => '');
    if (ERROR_KEYWORDS.test(errorText)) {
      return { result: 'bad-credentials' };
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

  // Credentials accepted — determine which page the portal landed us on.
  // Do NOT navigate via page.goto() — that breaks the PHP session.
  const currentUrl = page.url();
  if (currentUrl.includes('index.php')) {
    // The portal uses a 3-step login flow:
    //   1. Navigate → click "Student Login" → fill credentials → submit
    //   2. Server validates credentials → redirects to index.php (role-selection page)
    //   3. Click "Student Login" again on index.php → student dashboard loads
    //
    // Diagnose-form.js confirmed: no hidden role fields exist. The portal role is
    // determined by which button the user clicks on the index.php role-selection page.
    // The bot must click "Student Login" here to complete the login flow.

    // Fast check: are we already on the student dashboard? (My Courses in DOM)
    const alreadyOnStudentDash = await page.$('a:has-text("My Courses")')
      .then(el => !!el).catch(() => false);

    if (alreadyOnStudentDash) {
      logger.info('Login succeeded — student dashboard at index.php', { jobId, url: currentUrl });
      return { result: 'success' };
    }

    // Not on student dashboard — look for role-selection "Student Login" link.
    // page.$() checks DOM presence without visibility restrictions.
    const studentEntryEl = await page.$(
      'a:has-text("Student Login"), button:has-text("Student Login"), ' +
      'a:has-text("Student Portal"), button:has-text("Student Portal")'
    ).catch(() => null);

    if (studentEntryEl) {
      logger.info('Role-selection page at index.php — clicking Student Login to complete login', { jobId });
      log(jobId, '🖱️  Entering student portal…', { status: 'info' });
      await studentEntryEl.click({ force: true });
      await page.waitForSelector('a:has-text("My Courses")', { timeout: 30000 }).catch(() => null);
      logger.info('Student portal entered after role-selection click', { jobId, url: page.url() });
      return { result: 'success' };
    }

    // No student dashboard and no role-selection link — session assigned parent role.
    logger.info('index.php has no My Courses and no Student Login link — parent session', { jobId });
    return { result: 'parent-session' };
  }

  return { result: 'success' };
}

// ─── Dashboard modal dismissal ────────────────────────────────────────────────

async function dismissDashboardModal(page, jobId) {
  const MODAL_SEL    = '.modal.show, .modal.fade.show, .modal.in, [role="dialog"]';
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

  // My Courses is in the sidebar on index.php — confirmed working by login detection.
  // Using locator.click() with a timeout: Playwright waits internally for the element
  // to become actionable (visible, enabled, scrolled into view) before clicking.
  // page.goto() is NEVER called here — all navigation is through link clicks only.
  try {
    await page.locator('a:has-text("My Courses")').first().click({ timeout: 15000 });
    logger.info('My Courses link clicked', { jobId });
  } catch (err) {
    const currentUrl   = page.url();
    const visibleLinks = await page.$$eval('a', els =>
      els.filter(a => a.offsetParent !== null && a.innerText.trim().length > 0)
         .map(a => a.innerText.trim())
    ).catch(() => []);

    if (currentUrl.includes('parent') || currentUrl.includes('guardian')) {
      throw new Error(
        `Session broken during course discovery — bot is on: ${currentUrl}. ` +
        `This indicates a page.goto() call occurred after login. ` +
        `Check discoverCourses for any goto() calls.`
      );
    }

    throw new Error(
      `My Courses sidebar link not actionable after 15s. URL: ${currentUrl}. ` +
      `Visible links: ${visibleLinks.slice(0, 20).join(' | ')}`
    );
  }

  await page.waitForFunction(
    () => {
      const all = document.querySelectorAll('a');
      return Array.from(all).some(a => /^[A-Z]{2,4}\s\d{3,4}$/.test(a.innerText.trim()));
    },
    { timeout: 10000 }
  );

  // ── Opt 1: Walk sidebar DOM to tag each course with its semester ──────────────
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

  const seen      = new Set();
  const allCourses = tagged.filter(c => {
    if (seen.has(c.code)) return false;
    seen.add(c.code);
    return true;
  });

  const semLabel    = getCurrentSemester().split('_').pop();
  const taggedCount = allCourses.filter(c => c.semester !== null).length;

  if (taggedCount === 0 && allCourses.length > 0) {
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

async function tryBatchStatusCheck() {
  return null;
}

// ─── Course navigation ────────────────────────────────────────────────────────

async function navigateToCourse(page, context, courseCode, jobId) {
  const MY_COURSES_LINK = 'a:has-text("My Courses"), a:has-text("Courses")';

  const sidebarPresent = await page.locator(MY_COURSES_LINK).first()
    .isVisible({ timeout: 3000 }).catch(() => false);

  if (!sidebarPresent) {
    logger.info('Sidebar not visible — returning to dashboard', { jobId, courseCode });
    await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
  }

  await dismissDashboardModal(page, jobId);

  await page.locator(MY_COURSES_LINK).first().click({ timeout: 8000 });

  const courseLink = page.locator('a').filter({ hasText: new RegExp(`^${courseCode}$`) }).first();
  await courseLink.waitFor({ state: 'visible', timeout: 8000 });
  await courseLink.click({ force: true });

  await page.waitForLoadState('domcontentloaded', { timeout: 15000 });

  const pageBodySnippet = await page.evaluate(
    () => document.body?.innerText?.slice(0, 300) ?? ''
  ).catch(() => '');
  if (/cloudflare/i.test(pageBodySnippet)) {
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
  // NAVIGATION RULE: page.goto() is called ONCE — for the initial login page only.
  // All subsequent navigation uses page.click() on links present in the current DOM.
  // Reason: SSHUB uses PHP sessions. Direct URL navigation (page.goto) after login
  // bypasses session validation and triggers redirect to parent-login.php.
  // If you need to navigate somewhere, find the link on the current page and click it.

  const matricForLock = credentials.matricNumber;

  let browser     = null;
  let jobTimedOut = false;

  let completed        = 0;
  let skipped          = 0;
  let failed           = 0;
  let consecutiveFails = 0;

  jobManager.setJobCredentials(jobId, credentials);
  jobManager.setJobStatus(jobId, 'running');

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

    if (loginOutcome.result === 'bad-credentials') {
      fatalError(jobId,
        '❌ Wrong matric number or password — please check your details and try again.'
      );
      return;
    }

    if (loginOutcome.result === 'failure' || loginOutcome.result === 'parent-session') {
      fatalError(jobId, `❌ Login failed: ${loginOutcome.errorText ?? 'Portal kept redirecting to parent session after retry.'}`);
      return;
    }

    log(jobId, '✅ Login successful', { status: 'success' });

    // ── Fix 3: verify the portal rendered the student dashboard ────────────────
    // Both student and parent dashboards use index.php — the URL alone cannot
    // distinguish them. The server assigns a role based on the hidden form field
    // sent during login. If the wrong role was assigned, the student sidebar never
    // appears and "My Courses" is not in the DOM at all.
    //
    // page.$() checks DOM presence instantly (no visibility wait) so this takes
    // under 1 second regardless of sidebar accordion state.
    log(jobId, '🔍 Verifying student dashboard…', { status: 'info' });

    const isStudentDashboard = await page.$(
      'a:has-text("My Courses"), a:has-text("Course Reg"), a:has-text("My Result")'
    ).then(el => !!el).catch(() => false);

    if (!isStudentDashboard) {
      const visibleLinks = await page.$$eval('a', els =>
        els.filter(a => a.offsetParent !== null && a.innerText.trim().length > 0)
           .map(a => a.innerText.trim())
      ).catch(() => []);
      fatalError(jobId,
        `❌ Portal served parent dashboard after login. ` +
        `URL: ${page.url()}. ` +
        `Visible links: ${visibleLinks.slice(0, 15).join(' | ')}. ` +
        `Check server logs for "Login POST data sent to portal" and "Role-selection page at index.php" ` +
        `to trace the login flow. The portal uses a 3-step login — see handleLogin comments.`
      );
      return;
    }

    log(jobId, '✅ Student dashboard confirmed', { status: 'success' });
    // ── End Fix 3 ──────────────────────────────────────────────────────────────

    // ── Course discovery (Opt 1 semester filter runs inside) ────────────────
    const courses = await discoverCourses(page, jobId);

    if (courses.length === 0) {
      fatalError(jobId, '❌ No courses found — sidebar structure may have changed, or account has no registered courses.');
      return;
    }

    log(jobId, `📋 Found ${courses.length} course(s) to process`, { status: 'info', count: courses.length });

    const batchStatus = await tryBatchStatusCheck();

    if (batchStatus !== null) {
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

    const ASSESS_SELECTOR = 'td button:has-text("Assess"), td a:has-text("Assess")';
    const retryQueue      = [];
    let   inRetryPass     = false;

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

        while (true) {
          const assessBtn    = assessmentPage.locator(ASSESS_SELECTOR).first();
          const stillVisible = await assessBtn.isVisible({ timeout: 5000 }).catch(() => false);
          if (!stillVisible) break;

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
            const formContainer = assessPage.locator('form, [class*="assess"], main, #content').first();
            const nextBtn = formContainer
              .locator('button:has-text("Next"), input[value="Next"], a:has-text("Next")')
              .first();
            const hasNextBtn = await nextBtn.waitFor({ state: 'attached', timeout: 3000 })
              .then(() => true).catch(() => false);
            if (hasNextBtn) await nextBtn.click();

            const assessForm = assessPage.locator('form').first();
            await assessForm.locator('input[type="radio"]').first()
              .waitFor({ state: 'attached', timeout: 10000 });

            await assertIsAssessmentPage(assessPage);

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
        const isFormError = /form validation error|submit button not found/i.test(courseErr.message);

        if (!inRetryPass && !isFormError) {
          retryQueue.push(course);
          consecutiveFails = 0;
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
