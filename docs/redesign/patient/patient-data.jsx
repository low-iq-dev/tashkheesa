// ============================================================
// Tashkheesa Patient Portal — shared data
// ============================================================

const PDATA = {
  patient: {
    name: "Amira Hassan",
    initials: "AH",
    email: "amira.hassan@example.com",
    phone: "+20 100 482 1974",
    age: 42,
    location: "Cairo, Egypt",
  },

  doctor: {
    name: "Dr. Rania El Radi",
    role: "Consultant Radiologist",
    credentials: "MD, FRCR · 18 yrs experience",
    hospital: "Shifa Hospital, El Tagamoa",
    initials: "RE",
    languages: "Arabic · English",
    responseTime: "Responds within 2 hours",
    rating: "4.9",
    reviews: 127,
  },

  activeCase: {
    id: "TSH-2025-001284",
    title: "Staging CT — suspected metastatic disease",
    category: "Radiology · Oncology",
    specialty: "Radiology",
    submitted: "Mon, 18 Apr · 14:22",
    submittedAgo: "2 days ago",
    status: "in_review",
    statusLabel: "Under review",
    eta: "Expected by Thu, 21 Apr",
    etaCountdown: "18h 24m",
    fee: "EGP 2,000",
    docsCount: 7,
    preferredLang: "Arabic",
  },

  // Timeline steps (shared across variants)
  timeline: [
    { k: "Submitted", title: "Case submitted", sub: "Mon, 18 Apr · 14:22 · You uploaded 7 files", state: "done" },
    { k: "Reviewed", title: "Documents organized", sub: "2m later · All files grouped by type and date", state: "done" },
    { k: "Assigned", title: "Specialist assigned", sub: "Tue, 19 Apr · 09:14 · Dr. Rania El Radi accepted your case", state: "done" },
    { k: "In review", title: "Under specialist review", sub: "Started Tue, 19 Apr · 11:30 · Expected by Thu, 21 Apr", state: "active" },
    { k: "Report", title: "Report delivered", sub: "You'll receive an email and SMS the moment it's ready", state: "pending" },
  ],

  files: [
    { name: "CT chest — contrast, axial.dcm", size: "184 MB", type: "Imaging", icon: "scan" },
    { name: "CT chest — coronal reconstruction.dcm", size: "88 MB", type: "Imaging", icon: "scan" },
    { name: "Radiology report — Dar Al Fouad.pdf", size: "412 KB", type: "Report", icon: "report" },
    { name: "CBC + liver panel — Feb 2026.pdf", size: "186 KB", type: "Labs", icon: "labs" },
    { name: "Prior imaging — Oct 2025.pdf", size: "3.2 MB", type: "Imaging", icon: "scan" },
    { name: "Tumor markers — CEA, CA 19-9.pdf", size: "94 KB", type: "Labs", icon: "labs" },
    { name: "Referral letter — Dr. Samir Fahmy.pdf", size: "138 KB", type: "Letter", icon: "letter" },
  ],

  messages: [
    { who: "them", text: "I've received your files and begun review. The imaging quality is excellent — thank you for including the prior scan from October, it helps establish a timeline.", time: "Tue 11:34" },
    { who: "them", text: "One question before I finalize: do you recall approximately when the weight loss began? Even a rough month is helpful.", time: "Tue 11:36" },
    { who: "me", text: "Around late December I think — maybe 6 kg over 10 weeks. I didn't weigh myself before that.", time: "Tue 14:02" },
    { who: "them", text: "Perfect, that's enough to work with. I'll have the report ready by tomorrow evening.", time: "Tue 14:48" },
  ],

  paymentCurrencies: [
    { code: "EGP", label: "Egyptian pound", amount: "2,000", note: "Detected from your location", primary: true },
    { code: "USD", label: "US dollar", amount: "41", note: "" },
    { code: "AED", label: "UAE dirham", amount: "150", note: "" },
    { code: "SAR", label: "Saudi riyal", amount: "154", note: "" },
    { code: "EUR", label: "Euro", amount: "38", note: "" },
    { code: "GBP", label: "British pound", amount: "33", note: "" },
  ],

  caseHistory: [
    { id: "TSH-2025-001284", title: "Staging CT — suspected metastatic disease", doctor: "Dr. Rania El Radi", date: "18 Apr 2026", status: "In review", fee: "EGP 2,000" },
    { id: "TSH-2025-001142", title: "Thyroid nodule — second opinion", doctor: "Dr. Yassin Kamal", date: "12 Feb 2026", status: "Completed", fee: "EGP 1,500" },
    { id: "TSH-2025-000987", title: "Persistent back pain — MRI review", doctor: "Dr. Nour El-Din Sabry", date: "04 Nov 2025", status: "Completed", fee: "EGP 2,000" },
  ],

  specialties: [
    { key: "radiology", name: "Radiology", sub: "CT, MRI, X-ray, ultrasound review", files: "Scans, imaging reports" },
    { key: "oncology", name: "Oncology", sub: "Cancer diagnosis & treatment opinions", files: "Biopsy, scans, labs" },
    { key: "cardiology", name: "Cardiology", sub: "Heart conditions, echo, ECG", files: "Echo, ECG, angiography" },
    { key: "neurology", name: "Neurology", sub: "Brain, spine, nerve conditions", files: "MRI brain, EEG, EMG" },
    { key: "endocrinology", name: "Endocrinology", sub: "Hormones, thyroid, diabetes", files: "Labs, imaging" },
    { key: "gastroenterology", name: "Gastroenterology", sub: "Digestive system, liver", files: "Endoscopy, labs, imaging" },
    { key: "other", name: "Not sure", sub: "We'll route to the right specialist", files: "Whatever you have" },
  ],
};
window.PDATA = PDATA;
