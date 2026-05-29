'use strict';

const express    = require('express');
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');
const { Run, getCurrentSemester } = require('../services/db');
const logger     = require('../utils/logger');

const router = express.Router();

const PAYSTACK_API = 'https://api.paystack.co';
const AMOUNT_KOBO  = 100000; // ₦1,000

// ─── Helpers ──────────────────────────────────────────────────────────────────

function paystackHeaders() {
  return {
    Authorization:  `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Derive a receipt email from the matric number — Paystack requires one
// but students don't register with an email on CLEARBOT.
function matricToEmail(matricNumber) {
  return `${matricNumber.toLowerCase().replace(/[^a-z0-9]/g, '')}@clearbot.ng`;
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────
const initLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests — please wait 15 minutes and try again.' },
});

// Already-paid bypass — runs BEFORE the rate limiter so users who retried payment
// multiple times and hit the limit can still proceed without being blocked.
async function bypassIfAlreadyPaid(req, res, next) {
  const { matricNumber } = req.body;
  if (matricNumber && typeof matricNumber === 'string') {
    const matric   = matricNumber.trim().toUpperCase();
    const semester = getCurrentSemester();
    try {
      const paidRun = await Run.findOne({ matricNumber: matric, semester, paid: true });
      if (paidRun) {
        logger.info('Payment initiate: already paid, bypassing rate limiter', { matric, semester });
        return res.status(200).json({ alreadyPaid: true });
      }
    } catch (_) { /* DB error — fall through to normal flow */ }
  }
  next();
}

// ─── POST /api/payment/initiate ───────────────────────────────────────────────
// Creates a Run record and initialises a Paystack transaction.
// Returns { reference, email, amount } for the frontend inline popup.

router.post('/initiate', bypassIfAlreadyPaid, initLimiter, async (req, res) => {
  const { matricNumber, email: providedEmail } = req.body;

  if (!matricNumber || typeof matricNumber !== 'string') {
    return res.status(400).json({ error: 'matricNumber is required' });
  }

  const matric   = matricNumber.trim().toUpperCase();
  const semester = getCurrentSemester();
  const email    = providedEmail?.trim() || matricToEmail(matric);

  try {

    // Idempotency: if there's already an unpaid run for this semester, reuse it.
    // This handles the case where the student clicks "Continue to Payment" twice.
    let run = await Run.findOne({ matricNumber: matric, semester, paid: false, runCompleted: false });

    if (!run) {
      run = new Run({ matricNumber: matric, semester });
    }

    // Generate a unique Paystack reference tied to this run.
    const reference = `cb-${matric.toLowerCase()}-${Date.now()}`;
    run.paystackRef = reference;
    await run.save();

    // Initialise transaction with Paystack.
    const psRes = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
      method:  'POST',
      headers: paystackHeaders(),
      body: JSON.stringify({
        email,
        amount:    AMOUNT_KOBO,
        reference,
        metadata: {
          matricNumber: matric,
          semester,
          custom_fields: [
            {
              display_name:  'Matric Number',
              variable_name: 'matric_number',
              value:          matric,
            },
          ],
        },
      }),
    });

    const psData = await psRes.json();

    if (!psData.status) {
      logger.error('Paystack initialise failed', { matric, error: psData.message });
      return res.status(502).json({ error: 'Payment provider error — please try again.' });
    }

    logger.info('Paystack transaction initialised', { matric, semester, reference });

    return res.status(200).json({
      reference,
      email,
      amount: AMOUNT_KOBO,
    });

  } catch (err) {
    logger.error('Payment initiate error', { matric, error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/payment/status/:reference ──────────────────────────────────────
// Verifies a transaction with Paystack and marks the Run as paid.
// Called by the frontend after the Paystack popup fires onSuccess.

router.get('/status/:reference', async (req, res) => {
  const { reference } = req.params;

  if (!reference || typeof reference !== 'string' || reference.length > 120) {
    return res.status(400).json({ error: 'Invalid reference' });
  }

  try {
    // Verify with Paystack.
    const psRes = await fetch(`${PAYSTACK_API}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: paystackHeaders(),
    });

    const psData = await psRes.json();

    if (!psData.status || psData.data?.status !== 'success') {
      logger.info('Paystack verify: not yet successful', { reference, ps: psData.data?.status });
      return res.status(200).json({ paid: false, runCompleted: false });
    }

    // Reject if the amount doesn't match — prevents charging ₦1 and getting a full run.
    if (psData.data?.amount !== AMOUNT_KOBO) {
      logger.warn('Paystack amount mismatch', { reference, expected: AMOUNT_KOBO, got: psData.data?.amount });
      return res.status(200).json({ paid: false, runCompleted: false });
    }

    // Paystack confirmed — mark the Run as paid.
    let run = await Run.findOneAndUpdate(
      { paystackRef: reference },
      { paid: true, paidAt: new Date() },
      { new: true }
    );

    if (!run) {
      // paystackRef was overwritten by a re-initiation (user retried payment).
      // Fall back to the matric/semester stored in Paystack's transaction metadata.
      const metaMatric   = psData.data?.metadata?.matricNumber;
      const metaSemester = psData.data?.metadata?.semester;
      if (metaMatric && metaSemester) {
        run = await Run.findOneAndUpdate(
          { matricNumber: metaMatric, semester: metaSemester, paid: false },
          { paid: true, paidAt: new Date(), paystackRef: reference },
          { new: true }
        );
        if (run) {
          logger.info('Payment verified via metadata fallback', {
            matric: run.matricNumber, semester: run.semester, reference,
          });
        }
      }
      if (!run) {
        logger.warn('Paystack paid but no matching Run found', { reference });
        return res.status(200).json({ paid: true, runCompleted: false });
      }
    } else {
      logger.info('Payment verified and Run marked paid', {
        matric:   run.matricNumber,
        semester: run.semester,
        reference,
      });
    }

    return res.status(200).json({
      paid:         true,
      runCompleted: run.runCompleted,
    });

  } catch (err) {
    logger.error('Payment status error', { reference, error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/payment/webhook ────────────────────────────────────────────────
// Paystack calls this when a payment completes, even if the browser closes.
// Body is raw (express.raw applied in server.js before the global JSON parser).
// Signature is verified against PAYSTACK_SECRET_KEY.

router.post('/webhook', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const secret    = process.env.PAYSTACK_SECRET_KEY;

  if (!signature || !secret) {
    return res.status(401).send('Unauthorized');
  }

  // req.body is a Buffer here (set by express.raw in server.js for this path).
  const hash = crypto
    .createHmac('sha512', secret)
    .update(req.body)
    .digest('hex');

  // timingSafeEqual prevents timing attacks that could reveal the expected hash
  // by exploiting how long a string comparison takes character-by-character.
  const hashBuf = Buffer.from(hash, 'hex');
  const sigBuf  = Buffer.from(signature, 'hex');
  const signatureValid = hashBuf.length === sigBuf.length &&
    crypto.timingSafeEqual(hashBuf, sigBuf);

  if (!signatureValid) {
    logger.warn('Paystack webhook signature mismatch');
    return res.status(401).send('Unauthorized');
  }

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).send('Bad request');
  }

  if (event.event === 'charge.success') {
    const reference = event.data?.reference;
    if (reference) {
      let run = await Run.findOneAndUpdate(
        { paystackRef: reference },
        { paid: true, paidAt: new Date() },
        { new: true }
      ).catch(err => {
        logger.error('Webhook DB update failed', { reference, error: err.message });
        return null;
      });

      if (!run) {
        // paystackRef overwritten by re-initiation — fall back to metadata.
        const metaMatric   = event.data?.metadata?.matricNumber;
        const metaSemester = event.data?.metadata?.semester;
        if (metaMatric && metaSemester) {
          run = await Run.findOneAndUpdate(
            { matricNumber: metaMatric, semester: metaSemester, paid: false },
            { paid: true, paidAt: new Date(), paystackRef: reference },
            { new: true }
          ).catch(err => {
            logger.error('Webhook metadata fallback DB update failed', { reference, error: err.message });
            return null;
          });
          if (run) {
            logger.info('Webhook: payment confirmed via metadata fallback', {
              matric: run.matricNumber, semester: run.semester, reference,
            });
          } else {
            logger.warn('Webhook: paid but no matching Run found', { reference, metaMatric, metaSemester });
          }
        }
      } else {
        logger.info('Webhook: payment confirmed', {
          matric:   run.matricNumber,
          semester: run.semester,
          reference,
        });
      }
    }
  }

  // Always respond 200 — Paystack retries on non-2xx.
  return res.status(200).json({ received: true });
});

// ─── POST /api/payment/recover ────────────────────────────────────────────────
// Admin endpoint to recover a lost payment where Paystack received money but
// the DB record was never marked paid (e.g. paystackRef overwritten by re-initiation).
//
// Body: { secret, matricNumber, reference? }
//   secret      — must match ADMIN_SECRET env var
//   matricNumber — the student's matric number
//   reference    — optional Paystack reference to verify; if omitted uses the
//                  reference stored on the most recent Run for that matric

router.post('/recover', async (req, res) => {
  const { secret, matricNumber, reference: bodyRef } = req.body;

  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!matricNumber || typeof matricNumber !== 'string') {
    return res.status(400).json({ error: 'matricNumber is required' });
  }

  const matric   = matricNumber.trim().toUpperCase();
  const semester = getCurrentSemester();

  try {
    // Already paid — nothing to recover.
    const alreadyPaid = await Run.findOne({ matricNumber: matric, semester, paid: true });
    if (alreadyPaid) {
      logger.info('Admin recover: already paid', { matric, semester });
      return res.status(200).json({ alreadyPaid: true, message: 'Already marked as paid' });
    }

    // Find the Run to update.
    const run = await Run.findOne({ matricNumber: matric, semester }).sort({ createdAt: -1 });
    if (!run) {
      return res.status(404).json({ error: 'No Run record found for this matric and semester' });
    }

    const reference = bodyRef?.trim() || run.paystackRef;
    if (!reference) {
      return res.status(400).json({ error: 'No reference available — provide one in the request body' });
    }

    // Verify with Paystack before marking paid.
    if (process.env.PAYSTACK_SECRET_KEY) {
      const psRes  = await fetch(`${PAYSTACK_API}/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: paystackHeaders(),
      });
      const psData = await psRes.json();

      if (!psData.status || psData.data?.status !== 'success') {
        logger.warn('Admin recover: Paystack did not confirm', { matric, reference, ps: psData.data?.status });
        return res.status(402).json({
          error:           'Paystack did not confirm this payment',
          paystackStatus:  psData.data?.status ?? 'unknown',
          reference,
        });
      }
    }

    run.paid       = true;
    run.paidAt     = new Date();
    run.paystackRef = reference;
    await run.save();

    logger.info('Admin recover: payment recovered', { matric, semester, reference });
    return res.status(200).json({ recovered: true, matric, semester, reference });

  } catch (err) {
    logger.error('Admin recover error', { matric, error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
