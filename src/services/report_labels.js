/**
 * report_labels.js — what the three report boxes are CALLED, per department.
 *
 * The columns never change: diagnosis_text / impression_text /
 * recommendation_text. Only the words around them do. This exists because the
 * form spoke one dialect — radiology's — to every specialty:
 *
 *   "Findings — Describe what you see. Measurements, locations, comparisons
 *    with priors."
 *
 * In the 22 Sep practice round the radiologist wrote a textbook report. The
 * internist, the cardiologist and both orthopods put a workup PLAN in that box,
 * because "what you see / measurements / priors" describes nothing an internist
 * does with a lab panel. Four of seven filled the wrong box, and the box was at
 * fault.
 *
 * Three dialects is the whole design. One per specialty would be 28 variants to
 * keep true, and the differences past this point are style, not substance.
 *
 * IMPORTANT: src/report-generator.js reads the SAME map for the PDF's section
 * headings. If a cardiologist fills a box labelled "Assessment" and the
 * patient's report prints "Findings", that is worse than not doing this at all.
 * Keep the two ends on this one module.
 */

const GROUPS = {
  // Imaging and specimen work: read the study, describe it, conclude. The
  // existing wording was already right for these — it is kept verbatim.
  imaging: {
    findings: {
      en: 'Findings',
      ar: 'النتائج',
      hintEn: 'Describe what you see. Measurements, locations, comparisons with priors.',
      hintAr: 'صف ما تراه. القياسات، المواقع، والمقارنة بالفحوص السابقة.',
      pdfEn: 'Findings / Observations',
      pdfAr: 'النتائج والملاحظات',
    },
    impression: {
      en: 'Impression',
      ar: 'الانطباع',
      hintEn: 'Your clinical interpretation. One or two sentences.',
      hintAr: 'تفسيرك السريري. جملة أو جملتان.',
      pdfEn: 'Impression / Conclusion',
      pdfAr: 'الانطباع والخلاصة',
    },
    recommendation: {
      en: 'Recommendation to patient',
      ar: 'التوصية للمريض',
      hintEn: 'Calm, specific, actionable. Avoid jargon — the patient reads this directly.',
      hintAr: 'هادئة، محددة، قابلة للتنفيذ. تجنّب المصطلحات — المريض يقرأها مباشرة.',
      pdfEn: 'Recommendations',
      pdfAr: 'التوصيات',
    },
  },

  // Medicine: the working language is assessment and plan, not findings and
  // impression. Cardiology, internal medicine, paediatrics, nephrology and the
  // rest of the physician specialties.
  medical: {
    findings: {
      en: 'What the records show',
      ar: 'ما تُظهره التقارير',
      hintEn: 'The objective facts you are working from: results, measurements, relevant history. Not your plan — that comes below.',
      hintAr: 'الحقائق الموضوعية التي تعتمد عليها: النتائج، القياسات، والتاريخ المرضي المهم. ليست الخطة — الخطة بالأسفل.',
      pdfEn: 'What the Records Show',
      pdfAr: 'ما تُظهره التقارير',
    },
    impression: {
      en: 'Assessment',
      ar: 'التقييم',
      hintEn: 'What you think is going on, and why. One or two sentences.',
      hintAr: 'ما تعتقد أنه يحدث، ولماذا. جملة أو جملتان.',
      pdfEn: 'Assessment',
      pdfAr: 'التقييم',
    },
    recommendation: {
      en: 'Plan for the patient',
      ar: 'الخطة للمريض',
      hintEn: 'Calm, specific, actionable. Avoid jargon — the patient reads this directly.',
      hintAr: 'هادئة، محددة، قابلة للتنفيذ. تجنّب المصطلحات — المريض يقرأها مباشرة.',
      pdfEn: 'Plan',
      pdfAr: 'الخطة',
    },
  },

  // Surgery: examination plus imaging, then a diagnosis, then what to do about
  // it — including whether an operation is actually needed, which is the most
  // common reason a patient asks us at all.
  surgical: {
    findings: {
      en: 'Examination & imaging review',
      ar: 'مراجعة الفحص والأشعة',
      hintEn: 'What the records, imaging and examination actually show. Not your plan — that comes below.',
      hintAr: 'ما تُظهره التقارير والأشعة والفحص فعلياً. ليست الخطة — الخطة بالأسفل.',
      pdfEn: 'Examination & Imaging Review',
      pdfAr: 'مراجعة الفحص والأشعة',
    },
    impression: {
      en: 'Diagnosis',
      ar: 'التشخيص',
      hintEn: 'Your diagnosis, and how certain you are of it. One or two sentences.',
      hintAr: 'تشخيصك، ومدى تأكدك منه. جملة أو جملتان.',
      pdfEn: 'Diagnosis',
      pdfAr: 'التشخيص',
    },
    recommendation: {
      en: 'Management plan',
      ar: 'خطة العلاج',
      hintEn: 'Calm, specific, actionable — and say plainly whether surgery is needed. Avoid jargon; the patient reads this directly.',
      hintAr: 'هادئة، محددة، قابلة للتنفيذ — ووضّح بصراحة هل الجراحة ضرورية. تجنّب المصطلحات؛ المريض يقرأها مباشرة.',
      pdfEn: 'Management Plan',
      pdfAr: 'خطة العلاج',
    },
  },
};

const BY_SPECIALTY = {
  'spec-radiology': 'imaging',
  'spec-pathology': 'imaging',
  'lab_pathology': 'imaging',

  'spec-orthopedics': 'surgical',
  'spec-urology': 'surgical',
  'spec-obgyn': 'surgical',
  'spec-general-surgery': 'surgical',
  'spec-cardiothoracic': 'surgical',
  'spec-vascular-surgery': 'surgical',
  'spec-ent': 'surgical',
  'spec-ophthalmology': 'surgical',
};

// Everything else is a physician specialty. Defaulting to `medical` rather than
// `imaging` is deliberate: it is the larger group, and an unmapped new
// specialty should land on the general-medicine wording, not radiology's.
const DEFAULT_GROUP = 'medical';

function groupForSpecialty(specialtyId) {
  const id = String(specialtyId || '').trim();
  return BY_SPECIALTY[id] || DEFAULT_GROUP;
}

function reportLabelsFor(specialtyId) {
  const group = groupForSpecialty(specialtyId);
  return Object.assign({ group }, GROUPS[group]);
}

module.exports = { reportLabelsFor, groupForSpecialty, GROUPS, DEFAULT_GROUP };
