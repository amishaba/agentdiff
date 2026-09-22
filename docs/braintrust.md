# Braintrust incidents become tests

Run `npx agentdiff view` and connect Braintrust once. Recent runs that errored or scored low appear under **Incidents**. Open one and say what the agent should have done. agentdiff saves it as `tests/incident-<id>.json`, an ordinary test made of:

- the recorded message and the earlier turns;
- the recorded state, as `context`;
- your expectation, as `grading_criteria`;
- the recorded tool responses, which act as its fake tools.

Every comparison from then on runs the incident on both agents. A tool call that isn't in the recording (a new tool, or new arguments) stops that run and is listed as missing. Open the incident again to supply the missing responses.

The Braintrust key is kept in `.agentdiff/braintrust/`, readable only by you. You can also set `BRAINTRUST_API_KEY`. Incidents need individual tool spans in the trace; [summary-only exports](https://www.braintrust.dev/docs/kb/export-missing-child-spans) won't work.

[← README](../README.md)
