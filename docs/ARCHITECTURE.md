# Architecture

```
Browser (React + TS)  ──REST/JSON──▶  Express API
                                        │ auth middleware (JWT cookie), Zod validation
                                        ▼
                              SchedulingService ──▶ RequestParser (LLM → Zod, else rules)
                                        │            └─ participant resolution (saved contacts, ambiguity, unknown)
                                        ▼
                              CalendarProvider.freeBusy ─ Google (OAuth, FreeBusy) | Mock
                                        ▼
                              scheduling/engine.ts  (pure, deterministic)
                                 intervals → common free time → 15-min candidates → hard filters → score → top 3
                                        ▼
                              InvitationService: draft → edit → confirm
                                 confirm = ack check → duplicate check → re-check FreeBusy → create event (idempotent)
```

Key decisions

* **AI boundary:** the model returns a `ParsedRequest` (validated by Zod). It never sees calendars and cannot create events.
* **Time:** all instants are UTC epoch ms; wall-clock conversions use IANA zones via `date-fns-tz`, so DST is handled per date.
* **Hard vs soft:** working days/hours, excluded days, "after/before" times and required-participant availability are hard filters.
  Preferred period, participant-local working hours and date proximity only affect ranking.
* **Unknown ≠ free:** inaccessible calendars yield `availability: unknown`, a warning, a score penalty and a required acknowledgement.
* **Idempotency:** the draft id is the event idempotency key (mock store and Google event `id`), so retries cannot duplicate events.
* **Provider abstraction:** `CalendarProvider` lets the same flow run against real Google or deterministic mock data.
