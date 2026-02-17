/**
 * Country-to-Currency Mapping
 * Maps every country code to one of our supported pricing currencies.
 * Supported: EGP, SAR, AED, KWD, BHD, QAR, OMR, GBP, USD
 */

const COUNTRY_TO_CURRENCY = {
  // Direct matches (9 pricing regions)
  EG: 'EGP',
  SA: 'SAR',
  AE: 'AED',
  KW: 'KWD',
  BH: 'BHD',
  QA: 'QAR',
  OM: 'OMR',
  GB: 'GBP',
  US: 'USD',

  // Other Arab countries -> closest regional currency
  JO: 'AED',  // Jordan
  LB: 'AED',  // Lebanon
  IQ: 'AED',  // Iraq
  LY: 'EGP',  // Libya
  SD: 'EGP',  // Sudan
  YE: 'SAR',  // Yemen
  PS: 'AED',  // Palestine
  SY: 'AED',  // Syria
  DZ: 'AED',  // Algeria
  MA: 'AED',  // Morocco
  TN: 'AED',  // Tunisia
  MR: 'AED',  // Mauritania
  SO: 'AED',  // Somalia
  DJ: 'AED',  // Djibouti
  KM: 'AED',  // Comoros

  // Europe -> GBP
  IE: 'GBP',  // Ireland
  FR: 'GBP',  // France
  DE: 'GBP',  // Germany
  IT: 'GBP',  // Italy
  ES: 'GBP',  // Spain
  PT: 'GBP',  // Portugal
  NL: 'GBP',  // Netherlands
  BE: 'GBP',  // Belgium
  AT: 'GBP',  // Austria
  CH: 'GBP',  // Switzerland
  SE: 'GBP',  // Sweden
  NO: 'GBP',  // Norway
  DK: 'GBP',  // Denmark
  FI: 'GBP',  // Finland
  PL: 'GBP',  // Poland
  CZ: 'GBP',  // Czechia
  GR: 'GBP',  // Greece
  RO: 'GBP',  // Romania
  HU: 'GBP',  // Hungary
  BG: 'GBP',  // Bulgaria
  HR: 'GBP',  // Croatia
  SK: 'GBP',  // Slovakia
  SI: 'GBP',  // Slovenia
  LT: 'GBP',  // Lithuania
  LV: 'GBP',  // Latvia
  EE: 'GBP',  // Estonia
  CY: 'GBP',  // Cyprus
  MT: 'GBP',  // Malta
  LU: 'GBP',  // Luxembourg
  IS: 'GBP',  // Iceland
  RS: 'GBP',  // Serbia
  BA: 'GBP',  // Bosnia
  ME: 'GBP',  // Montenegro
  MK: 'GBP',  // North Macedonia
  AL: 'GBP',  // Albania
  MD: 'GBP',  // Moldova
  UA: 'GBP',  // Ukraine
  BY: 'GBP',  // Belarus
  GE: 'GBP',  // Georgia
  AM: 'GBP',  // Armenia
  AZ: 'GBP',  // Azerbaijan
  TR: 'GBP',  // Turkey
  RU: 'GBP',  // Russia

  // Americas -> USD
  CA: 'USD',  // Canada
  MX: 'USD',  // Mexico
  BR: 'USD',  // Brazil
  AR: 'USD',  // Argentina
  CO: 'USD',  // Colombia
  CL: 'USD',  // Chile
  PE: 'USD',  // Peru
  VE: 'USD',  // Venezuela
  EC: 'USD',  // Ecuador
  UY: 'USD',  // Uruguay
  PY: 'USD',  // Paraguay
  BO: 'USD',  // Bolivia
  CR: 'USD',  // Costa Rica
  PA: 'USD',  // Panama
  GT: 'USD',  // Guatemala
  HN: 'USD',  // Honduras
  SV: 'USD',  // El Salvador
  NI: 'USD',  // Nicaragua
  CU: 'USD',  // Cuba
  DO: 'USD',  // Dominican Republic
  HT: 'USD',  // Haiti
  JM: 'USD',  // Jamaica
  TT: 'USD',  // Trinidad and Tobago
  PR: 'USD',  // Puerto Rico

  // Asia-Pacific -> USD
  AU: 'USD',  // Australia
  NZ: 'USD',  // New Zealand
  JP: 'USD',  // Japan
  KR: 'USD',  // South Korea
  CN: 'USD',  // China
  IN: 'USD',  // India
  PK: 'USD',  // Pakistan
  BD: 'USD',  // Bangladesh
  LK: 'USD',  // Sri Lanka
  NP: 'USD',  // Nepal
  PH: 'USD',  // Philippines
  ID: 'USD',  // Indonesia
  MY: 'USD',  // Malaysia
  SG: 'USD',  // Singapore
  TH: 'USD',  // Thailand
  VN: 'USD',  // Vietnam
  MM: 'USD',  // Myanmar
  KH: 'USD',  // Cambodia
  LA: 'USD',  // Laos
  TW: 'USD',  // Taiwan
  HK: 'USD',  // Hong Kong
  MO: 'USD',  // Macau
  MN: 'USD',  // Mongolia
  KZ: 'USD',  // Kazakhstan
  UZ: 'USD',  // Uzbekistan
  TM: 'USD',  // Turkmenistan
  KG: 'USD',  // Kyrgyzstan
  TJ: 'USD',  // Tajikistan
  AF: 'USD',  // Afghanistan
  IR: 'USD',  // Iran
  MV: 'USD',  // Maldives

  // Africa -> AED (default)
  NG: 'AED',  // Nigeria
  ZA: 'AED',  // South Africa
  KE: 'AED',  // Kenya
  ET: 'AED',  // Ethiopia
  TZ: 'AED',  // Tanzania
  GH: 'AED',  // Ghana
  CI: 'AED',  // Ivory Coast
  SN: 'AED',  // Senegal
  CM: 'AED',  // Cameroon
  UG: 'AED',  // Uganda
  RW: 'AED',  // Rwanda
  MA: 'AED',  // Morocco (already above)
};

const DEFAULT_CURRENCY = 'AED';

function getCurrencyForCountry(countryCode) {
  if (!countryCode) return DEFAULT_CURRENCY;
  return COUNTRY_TO_CURRENCY[countryCode.toUpperCase()] || DEFAULT_CURRENCY;
}

module.exports = { COUNTRY_TO_CURRENCY, DEFAULT_CURRENCY, getCurrencyForCountry };
