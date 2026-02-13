# WhatsApp Message Templates — Meta Registration Guide

These templates must be registered with Meta Business Manager before they can be used
via the WhatsApp Cloud API. Submit each template through the Meta Business Dashboard
under WhatsApp > Message Templates.

---

## Patient Templates

### 1. case_submitted_en
- **Category:** UTILITY
- **Language:** en
- **Body:** Your case {{1}} has been submitted to Tashkheesa. A specialist in {{2}} will be assigned shortly. Track your case at tashkheesa.com
- **Sample values:** `{{1}}` = ABC123, `{{2}}` = Radiology

### 2. case_submitted_ar
- **Category:** UTILITY
- **Language:** ar
- **Body:** تم تقديم حالتك {{1}} في تشخيصة. سيتم تعيين أخصائي {{2}} قريباً. تابع حالتك على tashkheesa.com
- **Sample values:** `{{1}}` = ABC123, `{{2}}` = الأشعة

### 3. report_ready_en
- **Category:** UTILITY
- **Language:** en
- **Body:** Your medical report for case {{1}} is ready! Reviewed by Dr. {{2}}. View your report at tashkheesa.com
- **Sample values:** `{{1}}` = ABC123, `{{2}}` = Ahmed Hassan

### 4. report_ready_ar
- **Category:** UTILITY
- **Language:** ar
- **Body:** تقريرك الطبي للحالة {{1}} جاهز! مراجعة د. {{2}}. عرض التقرير على tashkheesa.com
- **Sample values:** `{{1}}` = ABC123, `{{2}}` = أحمد حسن

### 5. payment_confirmed_en
- **Category:** UTILITY
- **Language:** en
- **Body:** Payment confirmed for case {{1}}. Amount: {{2}}. Your case is now active. Visit tashkheesa.com for details.
- **Sample values:** `{{1}}` = ABC123, `{{2}}` = 500 EGP

### 6. payment_confirmed_ar
- **Category:** UTILITY
- **Language:** ar
- **Body:** تم تأكيد الدفع للحالة {{1}}. المبلغ: {{2}}. حالتك الآن نشطة. زر tashkheesa.com للتفاصيل.
- **Sample values:** `{{1}}` = ABC123, `{{2}}` = 500 جنيه

### 7. payment_failed_en
- **Category:** UTILITY
- **Language:** en
- **Body:** Payment could not be processed for case {{1}}. Please try again at tashkheesa.com
- **Sample values:** `{{1}}` = ABC123

### 8. case_accepted_en
- **Category:** UTILITY
- **Language:** en
- **Body:** A specialist has accepted your case {{1}}. Dr. {{2}} is now reviewing your files. You'll be notified when the report is ready.
- **Sample values:** `{{1}}` = ABC123, `{{2}}` = Ahmed Hassan

### 9. case_reassigned_patient_en
- **Category:** UTILITY
- **Language:** en
- **Body:** Your case {{1}} has been reassigned to a new specialist. You will be notified when the review is complete.
- **Sample values:** `{{1}}` = ABC123

### 10. welcome_patient_en
- **Category:** MARKETING
- **Language:** en
- **Body:** Welcome to Tashkheesa, {{1}}! Get expert medical second opinions from verified specialists. Start your first case at tashkheesa.com
- **Sample values:** `{{1}}` = John

### 11. welcome_patient_ar
- **Category:** MARKETING
- **Language:** ar
- **Body:** مرحباً بك في تشخيصة، {{1}}! احصل على آراء طبية متخصصة من أخصائيين معتمدين. ابدأ حالتك الأولى على tashkheesa.com
- **Sample values:** `{{1}}` = أحمد

---

## Doctor Templates

### 12. case_assigned_doctor_en
- **Category:** UTILITY
- **Language:** en
- **Body:** New case {{1}} assigned to you ({{2}}). SLA: {{3}} hours. Review now at tashkheesa.com/portal/doctor
- **Sample values:** `{{1}}` = ABC123, `{{2}}` = Radiology, `{{3}}` = 72

### 13. case_assigned_doctor_ar
- **Category:** UTILITY
- **Language:** ar
- **Body:** حالة جديدة {{1}} معيّنة لك ({{2}}). المهلة: {{3}} ساعة. راجع الآن على tashkheesa.com/portal/doctor
- **Sample values:** `{{1}}` = ABC123, `{{2}}` = الأشعة, `{{3}}` = 72

### 14. case_reassigned_doctor_en
- **Category:** UTILITY
- **Language:** en
- **Body:** Case {{1}} has been reassigned to you. SLA: {{2}} hours. Please review at tashkheesa.com/portal/doctor
- **Sample values:** `{{1}}` = ABC123, `{{2}}` = 72

### 15. sla_warning_en
- **Category:** UTILITY
- **Language:** en
- **Body:** SLA warning for case {{1}}: {{2}} hours remaining. Please complete your review. tashkheesa.com/portal/doctor
- **Sample values:** `{{1}}` = ABC123, `{{2}}` = 6

### 16. sla_warning_urgent_en
- **Category:** UTILITY
- **Language:** en
- **Body:** URGENT: Case {{1}} SLA deadline approaching! Only {{2}} hours left. Complete review immediately. tashkheesa.com/portal/doctor
- **Sample values:** `{{1}}` = ABC123, `{{2}}` = 2

### 17. sla_breached_en
- **Category:** UTILITY
- **Language:** en
- **Body:** SLA breached for case {{1}}. The deadline has been missed. Please contact admin. tashkheesa.com
- **Sample values:** `{{1}}` = ABC123

### 18. doctor_welcome_en
- **Category:** MARKETING
- **Language:** en
- **Body:** Welcome to Tashkheesa, Dr. {{1}}! Your account has been approved. Access your portal at tashkheesa.com/portal/doctor
- **Sample values:** `{{1}}` = Ahmed Hassan

### 19. doctor_welcome_ar
- **Category:** MARKETING
- **Language:** ar
- **Body:** مرحباً بك في تشخيصة، د. {{1}}! تمت الموافقة على حسابك. ادخل بوابتك على tashkheesa.com/portal/doctor
- **Sample values:** `{{1}}` = أحمد حسن

---

## Appointment Templates

### 20. appointment_confirmed_en
- **Category:** UTILITY
- **Language:** en
- **Body:** Appointment confirmed for {{1}} with Dr. {{2}}. See details at tashkheesa.com
- **Sample values:** `{{1}}` = Feb 15, 2026 at 3:00 PM, `{{2}}` = Ahmed Hassan

### 21. appointment_confirmed_ar
- **Category:** UTILITY
- **Language:** ar
- **Body:** تم تأكيد موعدك في {{1}} مع د. {{2}}. التفاصيل على tashkheesa.com
- **Sample values:** `{{1}}` = 15 فبراير 2026 الساعة 3:00 م, `{{2}}` = أحمد حسن

### 22. appointment_reminder_en
- **Category:** UTILITY
- **Language:** en
- **Body:** Reminder: Your appointment is scheduled for {{1}} with Dr. {{2}}. Be ready! tashkheesa.com
- **Sample values:** `{{1}}` = Feb 15, 2026 at 3:00 PM, `{{2}}` = Ahmed Hassan

### 23. appointment_rescheduled_en
- **Category:** UTILITY
- **Language:** en
- **Body:** Your appointment has been rescheduled from {{1}} to {{2}}. See tashkheesa.com for details.
- **Sample values:** `{{1}}` = Feb 15 at 3:00 PM, `{{2}}` = Feb 16 at 4:00 PM

---

## Registration Notes

1. Submit templates at: https://business.facebook.com > WhatsApp > Message Templates
2. Allow 24-48 hours for Meta review and approval
3. UTILITY templates have higher delivery priority and lower costs
4. MARKETING templates require user opt-in (handled by `notify_whatsapp` user field)
5. All templates use the Tashkheesa WhatsApp Business Account
6. Test templates in sandbox before production use
