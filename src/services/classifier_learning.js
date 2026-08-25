'use strict';

// services/classifier_learning.js — the classifier learning loop.
//
// CASE-FLOW REBUILD 2026-08-25.
//
// specialty_classification_overrides has been recording, for every case, what
// the AI picked against what a human actually picked. Nothing has ever read it
// back. This module closes that loop.
//
// ── The honest part: a patient override is a NOISY label ────────────────────
//
// It is tempting to treat every override as ground truth. It is not. The
// patients most likely to override a specialty suggestion are precisely the
// ones least sure which specialty they need — that is why they were offered a
// suggestion in the first place. Training on raw patient disagreement would
// teach the model the confusion rather than the correction, and it would do it
// confidently, because the volume is there.
//
// So signals are weighted by who produced them and whether the routing HELD:
//
//   * An operator or doctor reassignment counts fully. That is a clinician
//     looking at the case.
//   * A patient override counts only if the case then completed with that same
//     specialty and was never reassigned. The patient's choice is treated as a
//     hypothesis that the rest of the pipeline either confirms or does not.
//   * A patient override on a case that was later reassigned, cancelled or
//     refunded counts for nothing. It was probably the confusion, not a fix.
//
// That single rule is most of the difference between a learner that improves
// and one that amplifies its own errors.
//
// ── Not fine-tuning, deliberately ───────────────────────────────────────────
//
// Accepted corrections are rendered into the classifier's USER message as a
// short "known corrections" block. Cheap, inspectable, revertible in one click,
// and a reviewer can read exactly why a case routes the way it does. A
// fine-tune would be none of those things.
//
// They go in the USER message and not the system prompt on purpose: the system
// prompt carries the routing-not-diagnosing guardrails and has a snapshot test
// pinning them (tests/unit/specialty-classifier.test.js). Appending
// operator-supplied text to it would let a correction quietly weaken a clinical
// safety rail.
//
// ── Nothing auto-applies ────────────────────────────────────────────────────
//
// The job only ever produces CANDIDATES. A human accepts or rejects each one.
// Same reason the suggestion itself never auto-selects: an automated pipeline
// silently rewriting how cases route is not something anyone should have to
// discover from a support ticket.

const { randomUUID } = require('crypto');
const { queryOne, queryAll, execute } = require('../pg');
const { logErrorToDb } = require('../logger');

// Defaults, tunable per deployment via env. Chosen for a platform that does not
// have much history yet: low enough that real patterns surface within weeks,
// high enough that two coincidences do not become a rule.
const DEFAULTS = Object.freeze({
  // Rolling window. Older corrections describe a catalogue that may no longer
  // exist — services get renamed, split and withdrawn.
  windowDays: 90,
  // Weighted score a pair must reach to be offered for review. An operator
  // reassignment scores 1.0, a confirmed patient override 0.5, so 3.0 is
  // roughly "three clinicians, or six patients whose routing stuck".
  minScore: 3.0,
  // Share of a specialty's corrections that must point the same way. Below
  // this the specialty is being corrected in several directions at once, which
  // is a catalogue problem, not a routing rule.
  minConsistency: 0.6,
  // How many accepted corrections to put in the prompt. A long list dilutes
  // every entry and costs tokens on every classification.
  maxPromptCorrections: 15,
  // Prompt cache TTL. Accepting a correction should show up quickly without
  // making every classification pay for a database round trip.
  cacheTtlMs: 5 * 60 * 1000
});

// Env names are written out in full rather than built as
// process.env['CLASSIFIER_LEARNER_' + key]. A computed key is invisible to
// grep, which means it is invisible to the .env.example mirror lint and to the
// next person wondering where a value comes from — the lint caught this on the
// first run and it was right to.
function num(raw, fallback) {
  const v = raw == null ? NaN : Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function config() {
  return {
    windowDays:           num(process.env.CLASSIFIER_LEARNER_WINDOW_DAYS, DEFAULTS.windowDays),
    minScore:             num(process.env.CLASSIFIER_LEARNER_MIN_SCORE, DEFAULTS.minScore),
    minConsistency:       num(process.env.CLASSIFIER_LEARNER_MIN_CONSISTENCY, DEFAULTS.minConsistency),
    maxPromptCorrections: num(process.env.CLASSIFIER_LEARNER_MAX_PROMPT, DEFAULTS.maxPromptCorrections),
    cacheTtlMs:           DEFAULTS.cacheTtlMs
  };
}

// Weight per signal. See the module header for why these differ.
const WEIGHT_CLINICIAN = 1.0;
const WEIGHT_PATIENT_CONFIRMED = 0.5;
const WEIGHT_PATIENT_UNCONFIRMED = 0.0;

/**
 * Score one override row.
 *
 * `confirmed` means: the case reached a completed state carrying the specialty
 * the human chose, and no LATER override exists for it. In other words the
 * routing survived contact with the rest of the pipeline.
 */
function weightFor(actorRole, confirmed) {
  const role = String(actorRole || 'patient').toLowerCase();
  if (role === 'admin' || role === 'superadmin' || role === 'operator' || role === 'doctor') {
    return WEIGHT_CLINICIAN;
  }
  return confirmed ? WEIGHT_PATIENT_CONFIRMED : WEIGHT_PATIENT_UNCONFIRMED;
}

/**
 * Read the override corpus for the window, annotated with whether each patient
 * override was CONFIRMED by the case completing on that specialty without a
 * later reassignment.
 *
 * One query rather than N+1: the confirmation test is a correlated EXISTS plus
 * a join to the order, and doing it per row would mean thousands of round trips
 * on a nightly job.
 */
async function loadWeightedOverrides(windowDays) {
  return await queryAll(
    `SELECT o.id,
            o.case_id,
            o.ai_specialty_id,
            o.ai_service_id,
            o.patient_specialty_id,
            o.patient_service_id,
            o.actor_role,
            o.override_at,
            -- Did the routing hold? The case finished, it finished carrying the
            -- specialty the human chose, and nobody overrode it again after.
            (
              ord.id IS NOT NULL
              AND LOWER(COALESCE(ord.status, '')) IN ('completed', 'delivered', 'closed')
              AND ord.specialty_id IS NOT DISTINCT FROM o.patient_specialty_id
              AND NOT EXISTS (
                SELECT 1 FROM specialty_classification_overrides later
                 WHERE later.case_id = o.case_id
                   AND later.override_at > o.override_at
              )
            ) AS confirmed
       FROM specialty_classification_overrides o
       -- include-deleted-ok: a soft-deleted order still carries a real
       -- correction. Hiding it would silently shrink the training corpus, and
       -- the confirmation test already refuses anything not completed.
       LEFT JOIN orders ord ON ord.id = o.case_id
      WHERE o.override_at >= NOW() - ($1 || ' days')::interval
        AND o.ai_specialty_id IS NOT NULL
        AND o.patient_specialty_id IS NOT NULL
        AND o.ai_specialty_id <> o.patient_specialty_id`,
    [String(windowDays)]
  );
}

/**
 * Aggregate the corpus into candidate corrections and upsert them.
 *
 * Idempotent: re-running produces the same rows with refreshed evidence, and a
 * reviewer's accept or reject is preserved. A rejected pair must never quietly
 * return as a fresh candidate, or "no" comes to mean "not yet" and the queue
 * never converges.
 */
async function aggregateCorrections(deps) {
  const cfg = config();
  // Seams for tests. The weighting rule is the load-bearing decision in this
  // module and it is arithmetic, so it has to be assertable by CALLING it with
  // known rows — not by grepping the SQL that fetches them.
  const load = (deps && deps.load) || loadWeightedOverrides;
  const write = (deps && deps.write) || execute;
  try {
    const rows = await load(cfg.windowDays);
    if (rows.length === 0) return { scanned: 0, pairs: 0, candidates: 0 };

    // Bucket by (from, to) pair, and separately total each from-specialty's
    // weight so consistency has a denominator.
    const pairs = new Map();
    const fromTotals = new Map();

    for (const r of rows) {
      const w = weightFor(r.actor_role, r.confirmed === true);
      const from = String(r.ai_specialty_id);
      fromTotals.set(from, (fromTotals.get(from) || 0) + w);
      if (w === 0) continue;   // counts in the denominator, earns no pair credit

      // Service-level only when BOTH sides name a service; otherwise this is a
      // specialty-level rule and pinning it to a service would over-fit.
      const fromSvc = r.ai_service_id && r.patient_service_id ? String(r.ai_service_id) : null;
      const toSvc = fromSvc ? String(r.patient_service_id) : null;
      const key = [from, String(r.patient_specialty_id), fromSvc || '', toSvc || ''].join(' ');

      const entry = pairs.get(key) || {
        from_specialty_id: from,
        to_specialty_id: String(r.patient_specialty_id),
        from_service_id: fromSvc,
        to_service_id: toSvc,
        occurrences: 0,
        weighted_score: 0,
        samples: [],
        first_seen_at: r.override_at,
        last_seen_at: r.override_at
      };
      entry.occurrences += 1;
      entry.weighted_score += w;
      if (entry.samples.length < 5) entry.samples.push(r.case_id);
      if (r.override_at < entry.first_seen_at) entry.first_seen_at = r.override_at;
      if (r.override_at > entry.last_seen_at) entry.last_seen_at = r.override_at;
      pairs.set(key, entry);
    }

    let candidates = 0;
    for (const entry of pairs.values()) {
      const denom = fromTotals.get(entry.from_specialty_id) || 0;
      // A specialty whose entire corrected weight is zero (every override an
      // unconfirmed patient one) yields no consistency signal at all.
      const consistency = denom > 0 ? entry.weighted_score / denom : 0;
      const qualifies = entry.weighted_score >= cfg.minScore && consistency >= cfg.minConsistency;

      // Below-threshold pairs are still written, as evidence rather than as a
      // candidate. Watching a pair climb toward the line across runs is far
      // more useful than having it appear from nowhere one morning, and it is
      // what makes the thresholds tunable against real data.
      const status = qualifies ? 'candidate' : 'below_threshold';
      if (qualifies) candidates += 1;

      await write(
        `INSERT INTO classifier_corrections
           (id, from_specialty_id, to_specialty_id, from_service_id, to_service_id,
            occurrences, weighted_score, consistency, sample_case_ids,
            status, first_seen_at, last_seen_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())
         ON CONFLICT (from_specialty_id, to_specialty_id,
                      COALESCE(from_service_id, ''), COALESCE(to_service_id, ''))
         DO UPDATE SET
           occurrences     = EXCLUDED.occurrences,
           weighted_score  = EXCLUDED.weighted_score,
           consistency     = EXCLUDED.consistency,
           sample_case_ids = EXCLUDED.sample_case_ids,
           first_seen_at   = LEAST(classifier_corrections.first_seen_at, EXCLUDED.first_seen_at),
           last_seen_at    = GREATEST(classifier_corrections.last_seen_at, EXCLUDED.last_seen_at),
           updated_at      = NOW(),
           status = CASE
             WHEN classifier_corrections.status IN ('accepted', 'rejected')
               THEN classifier_corrections.status
             ELSE EXCLUDED.status
           END`,
        [randomUUID(), entry.from_specialty_id, entry.to_specialty_id,
         entry.from_service_id, entry.to_service_id,
         entry.occurrences, Number(entry.weighted_score.toFixed(3)),
         Number(consistency.toFixed(3)), JSON.stringify(entry.samples),
         status, entry.first_seen_at, entry.last_seen_at]
      );
    }

    invalidateCache();
    return { scanned: rows.length, pairs: pairs.size, candidates };
  } catch (err) {
    logErrorToDb(err, { context: 'classifier_learning.aggregate', category: 'classifier' });
    return { scanned: 0, pairs: 0, candidates: 0, skipped: 'error' };
  }
}

// ─── Read path ──────────────────────────────────────────────────────────────
//
// Hit on every classification, so it is cached. The TTL is short enough that
// accepting a correction shows up while the reviewer is still looking at the
// screen, and long enough that a busy hour does not mean a query per case.

let _cache = null;
let _cacheAt = 0;

function invalidateCache() { _cache = null; _cacheAt = 0; }

/**
 * Accepted corrections, best evidence first.
 *
 * Names are joined in because the model reasons about specialty NAMES, not
 * opaque ids — "we route chest imaging to Pulmonology, not Radiology" is a
 * usable instruction; "spec-a1b2 -> spec-c3d4" is not.
 */
async function getAcceptedCorrections() {
  const cfg = config();
  const now = Date.now();
  if (_cache && (now - _cacheAt) < cfg.cacheTtlMs) return _cache;

  try {
    const rows = await queryAll(
      `SELECT c.from_specialty_id, c.to_specialty_id,
              c.from_service_id, c.to_service_id,
              c.occurrences, c.weighted_score,
              fs.name AS from_specialty_name,
              ts.name AS to_specialty_name,
              fsv.name AS from_service_name,
              tsv.name AS to_service_name
         FROM classifier_corrections c
         LEFT JOIN specialties fs  ON fs.id  = c.from_specialty_id
         LEFT JOIN specialties ts  ON ts.id  = c.to_specialty_id
         LEFT JOIN services    fsv ON fsv.id = c.from_service_id
         LEFT JOIN services    tsv ON tsv.id = c.to_service_id
        WHERE c.status = 'accepted'
        ORDER BY c.weighted_score DESC
        LIMIT $1`,
      [cfg.maxPromptCorrections]
    );
    // A correction naming a specialty that has since been deleted or renamed
    // away would put a dangling instruction in front of the model. Drop it.
    _cache = rows.filter(r => r.from_specialty_name && r.to_specialty_name);
    _cacheAt = now;
    return _cache;
  } catch (err) {
    logErrorToDb(err, { context: 'classifier_learning.read', category: 'classifier' });
    // An empty list means the classifier behaves exactly as it did before any
    // of this existed. That is the correct failure direction.
    return [];
  }
}

/**
 * Render accepted corrections as a prompt block.
 *
 * Goes in the USER message, never the system prompt. The system prompt carries
 * the routing-not-diagnosing guardrails and has a snapshot test pinning them;
 * appending operator-supplied text to it would let a correction quietly weaken
 * a clinical safety rail.
 *
 * Framed as observed history rather than as a rule, because it IS history — the
 * model should weigh it against the case in front of it, not obey it. A patient
 * whose case genuinely belongs in the "from" specialty must still be routed
 * there.
 */
function renderCorrectionsBlock(corrections) {
  if (!corrections || corrections.length === 0) return '';
  const lines = corrections.map(function (c) {
    const from = c.from_service_name
      ? c.from_specialty_name + ' / ' + c.from_service_name
      : c.from_specialty_name;
    const to = c.to_service_name
      ? c.to_specialty_name + ' / ' + c.to_service_name
      : c.to_specialty_name;
    return '  - Cases routed to ' + from + ' were reassigned by a human to ' + to +
           ' (' + c.occurrences + ' times).';
  });
  return [
    '',
    'Known corrections from this platform\'s own history. These are observations,',
    'not rules: weigh them against the case in front of you. If this case genuinely',
    'belongs in the first specialty, route it there anyway.',
    lines.join('\n'),
    ''
  ].join('\n');
}

/**
 * Classifier accuracy over the window — for the superadmin dashboard.
 *
 * "Agreement" is the share of classifications no human subsequently changed.
 * It is a proxy, not truth: a case nobody corrected might have been routed
 * wrongly and never noticed. Presented as a trend to watch rather than a score
 * to hit.
 */
async function getAccuracyStats(windowDays) {
  const days = Number(windowDays) || config().windowDays;
  try {
    const totals = await queryOne(
      `SELECT COUNT(*)::int AS classified,
              COUNT(DISTINCT o.case_id)::int AS overridden
         FROM specialty_classifications c
         LEFT JOIN specialty_classification_overrides o ON o.case_id = c.case_id
        WHERE c.created_at >= NOW() - ($1 || ' days')::interval`,
      [String(days)]
    );
    const worst = await queryAll(
      `SELECT from_specialty_id, to_specialty_id, occurrences, weighted_score,
              consistency, status,
              fs.name AS from_specialty_name, ts.name AS to_specialty_name
         FROM classifier_corrections c
         LEFT JOIN specialties fs ON fs.id = c.from_specialty_id
         LEFT JOIN specialties ts ON ts.id = c.to_specialty_id
        WHERE c.status <> 'rejected'
        ORDER BY c.weighted_score DESC
        LIMIT 10`
    );
    const classified = (totals && Number(totals.classified)) || 0;
    const overridden = (totals && Number(totals.overridden)) || 0;
    return {
      windowDays: days,
      classified,
      overridden,
      agreementRate: classified > 0 ? Number(((classified - overridden) / classified).toFixed(3)) : null,
      worstPairs: worst
    };
  } catch (err) {
    logErrorToDb(err, { context: 'classifier_learning.stats', category: 'classifier' });
    return { windowDays: days, classified: 0, overridden: 0, agreementRate: null, worstPairs: [] };
  }
}

/** Accept or reject a candidate. Nothing steers the model without this. */
async function reviewCorrection(id, decision, reviewerId, note) {
  const status = decision === 'accept' ? 'accepted' : 'rejected';
  const result = await execute(
    `UPDATE classifier_corrections
        SET status = $1, reviewed_by = $2, reviewed_at = NOW(),
            review_note = $3, updated_at = NOW()
      WHERE id = $4`,
    [status, reviewerId || null, note || null, id]
  );
  invalidateCache();
  return { updated: !!(result && result.rowCount) , status };
}

module.exports = {
  aggregateCorrections,
  getAcceptedCorrections,
  renderCorrectionsBlock,
  getAccuracyStats,
  reviewCorrection,
  invalidateCache,
  // Exported for tests — the weighting rule is the load-bearing decision in
  // this module and deserves to be asserted directly.
  _weightFor: weightFor,
  _DEFAULTS: DEFAULTS
};
