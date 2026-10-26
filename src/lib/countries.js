'use strict';

// src/lib/countries.js — every country a patient can sign up from (26 Oct 2026).
//
// ONE list, read by:
//   - validators/phone_identity.js   dial codes + national lengths (normalizePhone)
//   - launch-market.js               isValidCountry / marketFromDialCode
//   - views/partials/country_options.ejs (via app.locals.COUNTRIES) — the
//     country / dialling-code select on /register and the profile page
//
// Signup used to be gated to the nine priced markets (EG + GCC + GB/US): every
// other patient filled in the form and was refused with "Please select a valid
// country". Now any country here may sign up; what it PAYS is decided
// separately by services/pricing_market.pricingMarketFor (Europe -> GB list,
// non-Gulf Arab countries -> the Egyptian price, everywhere else -> US list),
// and the card is still always charged in EGP.
//
// The English/Arabic names are the ones country_options.ejs already carried
// (Arabic generated from ICU, then committed). Dial codes are the ITU E.164
// country codes. Columns:
//
//   [iso, English name, Arabic name, dial code, nationalLen, placeholder]
//
// nationalLen is the LONGEST national significant number (no trunk 0), given
// only where it is certain; normalizePhone uses it to tell "201012345678"
// (already international) from a local number. null = unknown, and the
// normaliser falls back to a conservative rule. placeholder is how a person
// in that country writes a mobile number; null = the form shows a generic hint.

const ROWS = [
  ["AD","Andorra","أندورا","+376",null,null],
  ["AE","United Arab Emirates","الإمارات العربية المتحدة","+971",9,"05X XXX XXXX"],
  ["AF","Afghanistan","أفغانستان","+93",9,null],
  ["AG","Antigua and Barbuda","أنتيغوا وبربودا","+1",10,null],
  ["AL","Albania","ألبانيا","+355",9,null],
  ["AM","Armenia","أرمينيا","+374",8,null],
  ["AO","Angola","أنغولا","+244",null,null],
  ["AR","Argentina","الأرجنتين","+54",null,null],
  ["AT","Austria","النمسا","+43",null,"06XX XXXXXXX"],
  ["AU","Australia","أستراليا","+61",9,"04XX XXX XXX"],
  ["AZ","Azerbaijan","أذربيجان","+994",9,null],
  ["BA","Bosnia and Herzegovina","البوسنة والهرسك","+387",8,null],
  ["BB","Barbados","بربادوس","+1",10,null],
  ["BD","Bangladesh","بنغلاديش","+880",10,"01XXX XXXXXX"],
  ["BE","Belgium","بلجيكا","+32",9,"04XX XX XX XX"],
  ["BF","Burkina Faso","بوركينا فاسو","+226",null,null],
  ["BG","Bulgaria","بلغاريا","+359",9,null],
  ["BH","Bahrain","البحرين","+973",8,"XXXX XXXX"],
  ["BI","Burundi","بوروندي","+257",null,null],
  ["BJ","Benin","بنين","+229",null,null],
  ["BN","Brunei","بروناي","+673",null,null],
  ["BO","Bolivia","بوليفيا","+591",null,null],
  ["BR","Brazil","البرازيل","+55",11,null],
  ["BS","Bahamas","جزر البهاما","+1",10,null],
  ["BT","Bhutan","بوتان","+975",null,null],
  ["BW","Botswana","بوتسوانا","+267",null,null],
  ["BY","Belarus","بيلاروس","+375",9,null],
  ["BZ","Belize","بليز","+501",null,null],
  ["CA","Canada","كندا","+1",10,"(XXX) XXX-XXXX"],
  ["CD","Congo (DRC)","الكونغو - كينشاسا","+243",null,null],
  ["CF","Central African Republic","جمهورية أفريقيا الوسطى","+236",null,null],
  ["CG","Congo","الكونغو - برازافيل","+242",null,null],
  ["CH","Switzerland","سويسرا","+41",9,"07X XXX XX XX"],
  ["CI","Côte d'Ivoire","ساحل العاج","+225",null,null],
  ["CL","Chile","تشيلي","+56",9,null],
  ["CM","Cameroon","الكاميرون","+237",null,null],
  ["CN","China","الصين","+86",11,"1XX XXXX XXXX"],
  ["CO","Colombia","كولومبيا","+57",10,null],
  ["CR","Costa Rica","كوستاريكا","+506",null,null],
  ["CU","Cuba","كوبا","+53",null,null],
  ["CV","Cabo Verde","الرأس الأخضر","+238",null,null],
  ["CY","Cyprus","قبرص","+357",8,null],
  ["CZ","Czechia","التشيك","+420",9,null],
  ["DE","Germany","ألمانيا","+49",null,"015X XXXXXXXX"],
  ["DJ","Djibouti","جيبوتي","+253",null,null],
  ["DK","Denmark","الدانمرك","+45",8,null],
  ["DM","Dominica","دومينيكا","+1",10,null],
  ["DO","Dominican Republic","جمهورية الدومينيكان","+1",10,null],
  ["DZ","Algeria","الجزائر","+213",9,"05XX XX XX XX"],
  ["EC","Ecuador","الإكوادور","+593",null,null],
  ["EE","Estonia","إستونيا","+372",8,null],
  ["EG","Egypt","مصر","+20",10,"01X XXXX XXXX"],
  ["ER","Eritrea","إريتريا","+291",null,null],
  ["ES","Spain","إسبانيا","+34",9,"6XX XXX XXX"],
  ["ET","Ethiopia","إثيوبيا","+251",9,null],
  ["FI","Finland","فنلندا","+358",null,null],
  ["FJ","Fiji","فيجي","+679",null,null],
  ["FM","Micronesia","ميكرونيزيا","+691",null,null],
  ["FR","France","فرنسا","+33",9,"06 XX XX XX XX"],
  ["GA","Gabon","الغابون","+241",null,null],
  ["GB","United Kingdom","المملكة المتحدة","+44",10,"07XXX XXXXXX"],
  ["GD","Grenada","غرينادا","+1",10,null],
  ["GE","Georgia","جورجيا","+995",9,null],
  ["GH","Ghana","غانا","+233",9,null],
  ["GM","Gambia","غامبيا","+220",null,null],
  ["GN","Guinea","غينيا","+224",null,null],
  ["GQ","Equatorial Guinea","غينيا الاستوائية","+240",null,null],
  ["GR","Greece","اليونان","+30",10,"69X XXX XXXX"],
  ["GT","Guatemala","غواتيمالا","+502",null,null],
  ["GW","Guinea-Bissau","غينيا بيساو","+245",null,null],
  ["GY","Guyana","غيانا","+592",null,null],
  ["HK","Hong Kong","هونغ كونغ الصينية (منطقة إدارية خاصة)","+852",8,null],
  ["HN","Honduras","هندوراس","+504",null,null],
  ["HR","Croatia","كرواتيا","+385",9,null],
  ["HT","Haiti","هايتي","+509",null,null],
  ["HU","Hungary","هنغاريا","+36",9,null],
  ["ID","Indonesia","إندونيسيا","+62",null,null],
  ["IE","Ireland","أيرلندا","+353",9,"08X XXX XXXX"],
  ["IL","Israel","إسرائيل","+972",9,null],
  ["IN","India","الهند","+91",10,"XXXXX XXXXX"],
  ["IQ","Iraq","العراق","+964",10,"07XX XXX XXXX"],
  ["IR","Iran","إيران","+98",10,null],
  ["IS","Iceland","آيسلندا","+354",7,null],
  ["IT","Italy","إيطاليا","+39",null,"3XX XXX XXXX"],
  ["JM","Jamaica","جامايكا","+1",10,null],
  ["JO","Jordan","الأردن","+962",9,"07X XXX XXXX"],
  ["JP","Japan","اليابان","+81",10,"090 XXXX XXXX"],
  ["KE","Kenya","كينيا","+254",9,"07XX XXX XXX"],
  ["KG","Kyrgyzstan","قيرغيزستان","+996",null,null],
  ["KH","Cambodia","كمبوديا","+855",null,null],
  ["KI","Kiribati","كيريباتي","+686",null,null],
  ["KM","Comoros","جزر القمر","+269",null,null],
  ["KN","Saint Kitts and Nevis","سانت كيتس ونيفيس","+1",10,null],
  ["KP","Korea (North)","كوريا الشمالية","+850",null,null],
  ["KR","Korea (South)","كوريا الجنوبية","+82",10,null],
  ["KW","Kuwait","الكويت","+965",8,"XXXX XXXX"],
  ["KZ","Kazakhstan","كازاخستان","+7",10,null],
  ["LA","Laos","لاوس","+856",null,null],
  ["LB","Lebanon","لبنان","+961",null,"XX XXX XXX"],
  ["LC","Saint Lucia","سانت لوسيا","+1",10,null],
  ["LI","Liechtenstein","ليختنشتاين","+423",null,null],
  ["LK","Sri Lanka","سريلانكا","+94",9,null],
  ["LR","Liberia","ليبيريا","+231",null,null],
  ["LS","Lesotho","ليسوتو","+266",null,null],
  ["LT","Lithuania","ليتوانيا","+370",8,null],
  ["LU","Luxembourg","لوكسمبورغ","+352",null,null],
  ["LV","Latvia","لاتفيا","+371",8,null],
  ["LY","Libya","ليبيا","+218",9,"09X XXX XXXX"],
  ["MA","Morocco","المغرب","+212",9,"06XX XXXXXX"],
  ["MC","Monaco","موناكو","+377",null,null],
  ["MD","Moldova","مولدوفا","+373",8,null],
  ["ME","Montenegro","الجبل الأسود","+382",8,null],
  ["MG","Madagascar","مدغشقر","+261",null,null],
  ["MH","Marshall Islands","جزر مارشال","+692",null,null],
  ["MK","North Macedonia","مقدونيا الشمالية","+389",8,null],
  ["ML","Mali","مالي","+223",null,null],
  ["MM","Myanmar","ميانمار (بورما)","+95",null,null],
  ["MN","Mongolia","منغوليا","+976",null,null],
  ["MO","Macau","منطقة ماكاو الإدارية الخاصة","+853",null,null],
  ["MR","Mauritania","موريتانيا","+222",8,"XX XX XX XX"],
  ["MT","Malta","مالطا","+356",8,null],
  ["MU","Mauritius","موريشيوس","+230",null,null],
  ["MV","Maldives","جزر المالديف","+960",null,null],
  ["MW","Malawi","ملاوي","+265",null,null],
  ["MX","Mexico","المكسيك","+52",10,null],
  ["MY","Malaysia","ماليزيا","+60",10,"01X XXX XXXX"],
  ["MZ","Mozambique","موزمبيق","+258",null,null],
  ["NA","Namibia","ناميبيا","+264",null,null],
  ["NE","Niger","النيجر","+227",null,null],
  ["NG","Nigeria","نيجيريا","+234",10,"080X XXX XXXX"],
  ["NI","Nicaragua","نيكاراغوا","+505",null,null],
  ["NL","Netherlands","هولندا","+31",9,"06 XXXXXXXX"],
  ["NO","Norway","النرويج","+47",8,null],
  ["NP","Nepal","نيبال","+977",null,null],
  ["NR","Nauru","ناورو","+674",null,null],
  ["NZ","New Zealand","نيوزيلندا","+64",10,"02X XXX XXXX"],
  ["OM","Oman","عُمان","+968",8,"9XXX XXXX"],
  ["PA","Panama","بنما","+507",null,null],
  ["PE","Peru","بيرو","+51",9,null],
  ["PG","Papua New Guinea","بابوا غينيا الجديدة","+675",null,null],
  ["PH","Philippines","الفلبين","+63",10,"09XX XXX XXXX"],
  ["PK","Pakistan","باكستان","+92",10,"03XX XXXXXXX"],
  ["PL","Poland","بولندا","+48",9,"XXX XXX XXX"],
  ["PS","Palestine","الأراضي الفلسطينية","+970",9,"05X XXX XXXX"],
  ["PT","Portugal","البرتغال","+351",9,"9XX XXX XXX"],
  ["PW","Palau","بالاو","+680",null,null],
  ["PY","Paraguay","باراغواي","+595",null,null],
  ["QA","Qatar","قطر","+974",8,"XXXX XXXX"],
  ["RO","Romania","رومانيا","+40",9,null],
  ["RS","Serbia","صربيا","+381",null,null],
  ["RU","Russia","روسيا","+7",10,"8 9XX XXX XX XX"],
  ["RW","Rwanda","رواندا","+250",null,null],
  ["SA","Saudi Arabia","المملكة العربية السعودية","+966",9,"05X XXX XXXX"],
  ["SB","Solomon Islands","جزر سليمان","+677",null,null],
  ["SC","Seychelles","سيشل","+248",null,null],
  ["SD","Sudan","السودان","+249",9,"09X XXX XXXX"],
  ["SE","Sweden","السويد","+46",9,"07X XXX XX XX"],
  ["SG","Singapore","سنغافورة","+65",8,"XXXX XXXX"],
  ["SI","Slovenia","سلوفينيا","+386",8,null],
  ["SK","Slovakia","سلوفاكيا","+421",9,null],
  ["SL","Sierra Leone","سيراليون","+232",null,null],
  ["SM","San Marino","سان مارينو","+378",null,null],
  ["SN","Senegal","السنغال","+221",null,null],
  ["SO","Somalia","الصومال","+252",null,null],
  ["SR","Suriname","سورينام","+597",null,null],
  ["SS","South Sudan","جنوب السودان","+211",null,null],
  ["ST","São Tomé and Príncipe","ساو تومي وبرينسيبي","+239",null,null],
  ["SV","El Salvador","السلفادور","+503",null,null],
  ["SY","Syria","سوريا","+963",9,"09XX XXX XXX"],
  ["SZ","Eswatini","إسواتيني","+268",null,null],
  ["TD","Chad","تشاد","+235",null,null],
  ["TG","Togo","توغو","+228",null,null],
  ["TH","Thailand","تايلاند","+66",9,null],
  ["TJ","Tajikistan","طاجيكستان","+992",null,null],
  ["TL","Timor-Leste","تيمور - ليشتي","+670",null,null],
  ["TM","Turkmenistan","تركمانستان","+993",null,null],
  ["TN","Tunisia","تونس","+216",8,"XX XXX XXX"],
  ["TO","Tonga","تونغا","+676",null,null],
  ["TR","Turkey","تركيا","+90",10,"05XX XXX XX XX"],
  ["TT","Trinidad and Tobago","ترينيداد وتوباغو","+1",10,null],
  ["TV","Tuvalu","توفالو","+688",null,null],
  ["TW","Taiwan","تايوان","+886",9,null],
  ["TZ","Tanzania","تنزانيا","+255",9,null],
  ["UA","Ukraine","أوكرانيا","+380",9,null],
  ["UG","Uganda","أوغندا","+256",9,null],
  ["US","United States","الولايات المتحدة","+1",10,"(XXX) XXX-XXXX"],
  ["UY","Uruguay","أورغواي","+598",null,null],
  ["UZ","Uzbekistan","أوزبكستان","+998",9,null],
  ["VA","Vatican City","الفاتيكان","+39",null,null],
  ["VC","Saint Vincent and the Grenadines","سانت فنسنت وجزر غرينادين","+1",10,null],
  ["VE","Venezuela","فنزويلا","+58",null,null],
  ["VN","Vietnam","فيتنام","+84",10,null],
  ["VU","Vanuatu","فانواتو","+678",null,null],
  ["WS","Samoa","ساموا","+685",null,null],
  ["YE","Yemen","اليمن","+967",9,"7XX XXX XXX"],
  ["ZA","South Africa","جنوب أفريقيا","+27",9,"07X XXX XXXX"],
  ["ZM","Zambia","زامبيا","+260",null,null],
  ["ZW","Zimbabwe","زيمبابوي","+263",null,null],
];

// The "Popular" group at the top of the signup select: the nine priced
// markets, then the Arab countries Egypt treats as its medical-travel market.
const POPULAR = Object.freeze(['EG', 'SA', 'AE', 'KW', 'BH', 'QA', 'OM', 'GB', 'US', 'LY', 'SD', 'JO', 'IQ']);

// When several countries share a dial code (+1, +7, +39), the one a bare dial
// code resolves to.
const DIAL_PREFERRED = Object.freeze({ '+1': 'US', '+7': 'RU', '+39': 'IT' });

const COUNTRIES = Object.freeze(ROWS.map(function (r) {
  return Object.freeze({ iso: r[0], en: r[1], ar: r[2], dial: r[3], len: r[4], ex: r[5] });
}));

const BY_ISO = Object.freeze(COUNTRIES.reduce(function (acc, c) { acc[c.iso] = c; return acc; }, {}));

// dial -> ISO (preferred one for shared codes)
const DIAL_TO_ISO = Object.freeze(COUNTRIES.reduce(function (acc, c) {
  if (!acc[c.dial] || DIAL_PREFERRED[c.dial] === c.iso) acc[c.dial] = c.iso;
  return acc;
}, {}));

function countryByIso(code) {
  const u = String(code == null ? '' : code).trim().toUpperCase();
  return BY_ISO[u === 'UK' ? 'GB' : u] || null;
}

/** True for any ISO-3166 alpha-2 code on the list (case-insensitive). */
function isValidCountry(code) {
  return !!countryByIso(code);
}

/** '+49' for 'DE'; null when unknown. */
function dialForCountry(code) {
  const c = countryByIso(code);
  return c ? c.dial : null;
}

/** 'DE' for '+49' / '49' / '0049'; null when no country uses it. */
function countryForDial(dial) {
  const raw = String(dial == null ? '' : dial).trim();
  if (!raw) return null;
  const key = '+' + raw.replace(/^\+/, '').replace(/^0+/, '');
  return DIAL_TO_ISO[key] || null;
}

module.exports = {
  COUNTRIES, POPULAR, BY_ISO, DIAL_TO_ISO,
  countryByIso, isValidCountry, dialForCountry, countryForDial
};
