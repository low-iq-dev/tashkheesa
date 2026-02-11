# SLA Architecture Documentation

## Overview

The SLA (Service Level Agreement) enforcement system has multiple components working together to:
1. **Track deadlines** - Orders have deadline_at timestamp
2. **Send reminders** - Notify doctors 60 minutes before deadline
3. **Mark breaches** - Flag orders that miss deadline
4. **Escalate** - Notify ops teams of breaches

## File Purposes

### Core SLA Sweep
File: `src/server.js` → `runSlaReminderJob()`
- Main SLA enforcement logic
- Runs every minute (only in primary mode)
- Sends reminders 60 min before deadline
- Marks orders as breached if deadline passed

### SLA Event Logging
File: `src/audit.js` → `logOrderEvent()`
- Audit trail for all order events
- Tracks who made changes
- Records timestamps and metadata

### Notification Queueing
File: `src/notify.js` → `queueNotification()`
- Queues notifications for delivery
- Handles WhatsApp, email, internal channels
- Email caching and deduplication

## Summary

The SLA system is well-structured with clear separation of concerns. No dead code found.
