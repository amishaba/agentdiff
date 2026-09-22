// The booking assistant's tools, as the model sees them. They never reach a
// real system: a test answers them, or world.ts does when a test doesn't.

type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
};
const object = (properties: Record<string, unknown>): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const text = (description: string) => ({ type: "string", description });

export type ToolDefinition = { description: string; parameters: JsonSchema };

export const TOOLS: Record<string, ToolDefinition> = {
  lookup_patient: {
    description:
      "Find the patient's record by full name and date of birth. Returns their patient id, whether they are new or existing, and their upcoming appointments.",
    parameters: object({ fullName: text("First and last name."), dateOfBirth: text("YYYY-MM-DD") }),
  },
  find_open_slots: {
    description:
      "Open appointment times for a visit type, location and date range. The only times that can be offered or booked.",
    parameters: object({
      visitType: { type: "string", enum: ["new_patient", "follow_up", "telehealth_follow_up", "annual_physical"] },
      location: { type: "string", enum: ["elm_street", "riverside", "any"] },
      fromDate: text("YYYY-MM-DD"),
      toDate: text("YYYY-MM-DD"),
    }),
  },
  book_appointment: {
    description: "Book one open slot for the patient. Only a slotId returned by find_open_slots.",
    parameters: object({ patientId: text("From lookup_patient."), slotId: text("From find_open_slots.") }),
  },
  reschedule_appointment: {
    description: "Move an existing appointment to another open slot.",
    parameters: object({
      appointmentId: text("From lookup_patient."),
      newSlotId: text("From find_open_slots."),
    }),
  },
  cancel_appointment: {
    description: "Cancel an existing appointment.",
    parameters: object({ appointmentId: text("From lookup_patient."), reason: text("Why it's being cancelled.") }),
  },
  add_to_waitlist: {
    description: "Put the patient on the waitlist for earlier openings of a visit type.",
    parameters: object({
      patientId: text("From lookup_patient."),
      visitType: { type: "string", enum: ["new_patient", "follow_up", "telehealth_follow_up", "annual_physical"] },
    }),
  },
  search_clinic_info: {
    description:
      "Look up the clinic's hours, locations, accepted insurance, prices and policies. Ask in a full question.",
    parameters: object({ question: text("The question, written out in full.") }),
  },
  send_email: {
    description: "Email the patient, for example the intake forms link or an appointment confirmation.",
    parameters: object({ subject: text("A short subject line."), body: text("The email body, plain text.") }),
  },
  hand_off_to_front_desk: {
    description:
      "Pass the conversation to a person at the front desk. For billing disputes, medical questions, a patient who is upset or stuck, or anything you can't do.",
    parameters: object({ reason: text("What the front desk needs to know.") }),
  },
  pause_reminders: {
    description:
      "Stop booking reminders and follow-up texts for this patient. Use when the patient isn't interested in booking, has found care elsewhere, says now isn't a good time, or isn't the person we meant to text.",
    parameters: object({ reason: text("Why reminders are paused.") }),
  },
  opt_out: {
    description:
      'Stop all texts to this number. Use when the patient asks to stop getting messages ("STOP", "unsubscribe", "don\'t text me") or mentions legal action. Not for someone who just isn\'t ready to book.',
    parameters: object({ reason: text("Why the number is opted out.") }),
  },
};
