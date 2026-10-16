-- 130_intl_prices_missing_services.sql
--
-- 13 bookable services had NO international price list: the seven
-- "Report read — one question" services (base_price 750) and six Internal
-- Medicine reviews. case_intake_pricing.js falls back to services.base_price
-- (the Egyptian price, in EGP) when a priced market has no row, so a patient
-- in the UK booking a report read was charged EGP 750 — about £11 — against
-- £150 for the cheapest full review. Every one of the eight markets had the
-- same hole.
--
-- The rows are generated from the price ladder every other bookable service
-- already sits on (checked in production 16 Oct 2026: within each market a
-- base_price band maps to exactly one local price, no exceptions). The 750
-- band is new; it is priced a little under the 1,200 band in each market.
--
--   base   GB    US    AE/SA/QA  KW   BH/OM
--    750   95    79      299     25    29     <- new band
--   1200  150   120      449     35    45
--   1600  250   200      749     59    75
--   2400  400   350     1199     95   119
--   3500  600   550     1899    149   189
--
-- doctor_commission is 20% of the local price, as on every existing row.
-- id is text NOT NULL with no default (see 094) — gen_random_uuid() is required.
-- ON CONFLICT DO NOTHING: an existing row for a service/market is never touched.

INSERT INTO service_regional_prices
  (id, service_id, country_code, currency, hospital_cost, tashkheesa_price, doctor_commission, status, notes, created_at, updated_at)
SELECT gen_random_uuid()::text, sv.id, m.country_code, m.currency, NULL,
       m.price, ROUND((m.price * 0.20)::numeric, 2), 'active',
       'Added by migration 130 (2026-10-16): service had no international price list.',
       NOW(), NOW()
  FROM services sv
  JOIN (VALUES
      ( 750,'GB','GBP', 95.0), ( 750,'US','USD', 79.0), ( 750,'AE','AED', 299.0), ( 750,'SA','SAR', 299.0),
      ( 750,'QA','QAR',299.0), ( 750,'KW','KWD', 25.0), ( 750,'BH','BHD',  29.0), ( 750,'OM','OMR',  29.0),
      (1200,'GB','GBP',150.0), (1200,'US','USD',120.0), (1200,'AE','AED', 449.0), (1200,'SA','SAR', 449.0),
      (1200,'QA','QAR',449.0), (1200,'KW','KWD', 35.0), (1200,'BH','BHD',  45.0), (1200,'OM','OMR',  45.0),
      (1600,'GB','GBP',250.0), (1600,'US','USD',200.0), (1600,'AE','AED', 749.0), (1600,'SA','SAR', 749.0),
      (1600,'QA','QAR',749.0), (1600,'KW','KWD', 59.0), (1600,'BH','BHD',  75.0), (1600,'OM','OMR',  75.0),
      (2400,'GB','GBP',400.0), (2400,'US','USD',350.0), (2400,'AE','AED',1199.0), (2400,'SA','SAR',1199.0),
      (2400,'QA','QAR',1199.0),(2400,'KW','KWD', 95.0), (2400,'BH','BHD', 119.0), (2400,'OM','OMR', 119.0),
      (3500,'GB','GBP',600.0), (3500,'US','USD',550.0), (3500,'AE','AED',1899.0), (3500,'SA','SAR',1899.0),
      (3500,'QA','QAR',1899.0),(3500,'KW','KWD',149.0), (3500,'BH','BHD', 189.0), (3500,'OM','OMR', 189.0)
    ) AS m(band, country_code, currency, price)
    ON m.band = sv.base_price
 WHERE NOT EXISTS (
         SELECT 1 FROM service_regional_prices rp
          WHERE rp.service_id = sv.id AND rp.country_code = m.country_code
       )
ON CONFLICT DO NOTHING;
