// The booking assistant after two prompt edits:
// - a fix: pause_reminders' description no longer counts "now isn't a good time" as a reason to pause;
// - a speed-up: book the first open slot as soon as the patient asks, instead of offering a choice.
import { createClinicAgent } from "../agent.ts";
import { TOOL_GUIDANCE } from "../prompt.ts";
import { TOOLS } from "../tools.ts";

export const clinicAssistant = createClinicAgent({
  tools: {
    ...TOOLS,
    pause_reminders: {
      ...TOOLS.pause_reminders,
      description:
        'Stop booking reminders and follow-up texts for this patient. Use when the patient says they don\'t want to book, has found care elsewhere, or isn\'t the person we meant to text. "Maybe later" or "not right now" is not a no: ask when would be better instead.',
    },
  },
  guidance: {
    ...TOOL_GUIDANCE,
    book_appointment:
      "book_appointment: to keep things quick, book the first open slot as soon as the patient asks for an appointment, then tell them the day, time and location. New patients book new_patient; telehealth is for follow-ups only.",
  },
});
