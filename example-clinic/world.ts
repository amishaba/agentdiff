// What the booking assistant's tools answer when a test doesn't say: a tiny
// simulated clinic. Nothing here reaches a real system.

const PATIENTS = [
  {
    patientId: "pt_1042",
    fullName: "Jordan Lee",
    dateOfBirth: "1990-04-12",
    status: "existing",
    upcoming: [{ appointmentId: "apt_88", visitType: "follow_up", when: "2026-03-11 09:00", location: "elm_street" }],
  },
];

const SLOTS = [
  { slotId: "s_301", when: "2026-03-12 15:00", location: "elm_street" },
  { slotId: "s_302", when: "2026-03-13 10:20", location: "riverside" },
  { slotId: "s_303", when: "2026-03-16 16:40", location: "elm_street" },
];

const FACTS: [RegExp, string][] = [
  [/hour|open|close|sunday|saturday/i, "Mon-Fri 8am-6pm, Sat 9am-1pm, closed Sundays."],
  [
    /insur|aetna|cigna|blue|medicaid|medicare|plan/i,
    "Accepted: Aetna, Blue Cross, Cigna, UnitedHealthcare, Medicare. Not accepted: Medicaid.",
  ],
  [
    /price|cost|self.?pay|how much|\$/i,
    "Self-pay: new patient $180, follow-up $95, telehealth follow-up $75, annual physical $210.",
  ],
  [
    /cancel|late|fee|reschedul/i,
    "Cancelling or rescheduling with less than 24 hours' notice: $40 late fee. No-shows: $60.",
  ],
  [/locat|address|where|park/i, "Elm Street: 120 Elm St, free parking. Riverside: 8 River Rd, street parking."],
];

export const world: Record<string, (input: any) => unknown> = {
  lookup_patient: ({ fullName, dateOfBirth }) =>
    PATIENTS.find(
      (p) => p.fullName.toLowerCase() === String(fullName).toLowerCase() && p.dateOfBirth === dateOfBirth,
    ) ?? {
      found: false,
    },
  find_open_slots: ({ visitType, location }) => ({
    visitType,
    slots: SLOTS.filter((s) => location === "any" || s.location === location),
  }),
  book_appointment: ({ slotId }) => ({ booked: true, appointmentId: `apt_${slotId}` }),
  reschedule_appointment: ({ appointmentId, newSlotId }) => ({ moved: true, appointmentId, newSlotId }),
  cancel_appointment: ({ appointmentId }) => ({ cancelled: true, appointmentId }),
  add_to_waitlist: () => ({ waitlisted: true }),
  search_clinic_info: ({ question }) =>
    FACTS.find(([pattern]) => pattern.test(String(question)))?.[1] ?? "No answer found in the clinic's info.",
  send_email: () => ({ sent: true }),
  hand_off_to_front_desk: () => ({ handedOff: true, eta: "within 1 business hour" }),
  pause_reminders: () => ({ paused: true }),
  opt_out: () => ({ optedOut: true }),
};
